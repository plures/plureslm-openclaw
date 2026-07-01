/**
 * P3+P4 VERIFY driver (EPIC-MEMORY-SUPERIORITY — the FINAL gate, loop-closer).
 *
 * Proves BOTH P3 (reactive/PULL-TICK consolidation) + P4 (.px-governed write
 * redaction) deliver real end-to-end value the way a CONSUMER actually uses
 * them, CHANNEL-AGNOSTIC (C-TEST-002): every store-touching phase runs in its
 * OWN process (p3p4-verify-child.mts) driving the SHIPPED MemorySearchManager
 * (buildMemoryCapability().runtime.getMemorySearchManager().manager ->
 * sync()/search()), against the real SDK contract. NO chat adapter, NO mock,
 * NO reaching into private store state for the safety assertions (the recall
 * proof is made purely from manager.search() snippets/paths).
 *
 * FOUR PROOFS, each reproduced across a FRESH process where durability is
 * claimed:
 *  1. C-MEM-REDACT END-TO-END: sync a realistic batch (clean + secrets in
 *     content / a SECONDARY field / multiline PEM / AWS 40-char secret); in a
 *     FRESH process prove via manager.search() the credential chunks are NEVER
 *     recalled and the raw secret NEVER appears in any snippet, while the clean
 *     memory IS recalled. Write-accounting ({written,skipped,refused}) reported.
 *  2. CONSOLIDATION REAL VALUE: seed enough session memories that consolidation
 *     forms graph structure; sweep it; prove (a) bounded graph, (b) idempotent
 *     across repeated sweeps, (c) durable checkpoint across a FRESH process,
 *     tied to observable value (associative recall / edges present).
 *  3. NO REGRESSION: the full gate suite is run by the orchestrator separately
 *     (build + recall + p3p4 + hardened + p3p4-qa); this driver focuses on the
 *     consumer-boundary proofs.
 *  4. DURABILITY + DETERMINISM: secret-block (re-checked in the fresh recall
 *     process) and the consolidation checkpoint (re-checked in the fresh reopen
 *     process) both survive a process restart.
 *
 * HONESTY: P3's reactive sweep is PULL/TICK — the JS binding has NO push path
 * (a write does NOT auto-run a procedure; subscribe() is an id-only stub). The
 * sweep is invoked opportunistically from sync(); this is NOT event-driven
 * reactivity and is stated as such.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "p3p4-verify-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(
    `  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`,
  );
}

function runChild(dir: string, phase: string, ...extra: string[]) {
  const res = spawnSync(process.execPath, [TSX_CLI, CHILD, dir, phase, ...extra], {
    encoding: "utf8",
    timeout: 240_000,
  });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    parsed = null;
  }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

// ===========================================================================
function proofRedact(dir: string): void {
  console.log(
    "\n=== PROOF 1: C-MEM-REDACT END-TO-END (sync write -> FRESH-process recall; never recalled, never leaked) ===",
  );

  // --- WRITE leg (process A): sync the realistic batch + record accounting. ---
  const w = runChild(dir, "redact-write");
  if (w.stderr) console.log("  write stderr:", w.stderr);
  check("write child exit 0", w.status === 0, w.parsed?.error ?? null);
  check("write ok (manager.sync ran)", w.parsed?.ok === true, w.parsed?.error ?? null);
  const accounting = (w.parsed?.accounting ?? []) as Array<Record<string, unknown>>;
  console.log("  write-accounting:", JSON.stringify(accounting));

  // Per-field write-accounting assertions (store.store surfaces refusal).
  for (const a of accounting) {
    if (a.label === "clean") {
      check("PROOF1 clean: WRITTEN (written=1, not refused)", a.written === 1 && a.refused === 0, a);
      check("PROOF1 clean: persisted (get()!==null)", a.persisted === true, a);
    } else {
      check(`PROOF1 ${a.label}: REFUSED (refused>=1)`, Number(a.refused) >= 1, a);
      check(`PROOF1 ${a.label}: NOT persisted (get()===null)`, a.persisted === false, a);
      check(`PROOF1 ${a.label}: detector flags the field value`, a.detectorFlagsField === true, a);
      const detail = (a.refusedDetail ?? []) as Array<Record<string, unknown>>;
      check(`PROOF1 ${a.label}: refusal reported with a kind`, detail.length >= 1 && Boolean(detail[0]?.kind), detail);
    }
  }
  // The secondary-field case (the QA-fixed bug) must be explicitly present.
  const secondary = accounting.find((a) => String(a.label).startsWith("secret-in-secondary-field"));
  check("PROOF1 SECONDARY-FIELD case present + refused (the QA-fixed bug)", Boolean(secondary) && secondary!.persisted === false && Number(secondary!.refused) >= 1, secondary);

  // --- RECALL leg (process B, FRESH): never recalled / never leaked. ---
  const r = runChild(dir, "redact-recall");
  if (r.stderr) console.log("  recall stderr:", r.stderr);
  check("recall child exit 0 (FRESH process)", r.status === 0, r.parsed?.error ?? null);
  check("recall ok", r.parsed?.ok === true, r.parsed?.error ?? null);
  const results = (r.parsed?.results ?? []) as Array<Record<string, unknown>>;
  console.log("  recall results:", JSON.stringify(results));

  for (const res of results) {
    if (res.label === "clean") {
      // clean handled by the dedicated assertion below
      continue;
    }
    check(`PROOF1 ${res.label}: secret NEVER in any snippet`, res.secretInSnippet === false, res);
    check(`PROOF1 ${res.label}: credential node NEVER recalled (by id)`, res.idRecalled === false, res);
    check(`PROOF1 ${res.label}: node never persisted (independent get()===null)`, res.persisted === false, res);
  }
  check("PROOF1 clean memory IS recalled (round-trip works)", r.parsed?.cleanRecalled === true, r.parsed?.cleanRecalled);
  check("PROOF1 NO raw secret in ANY snippet of a broad query", r.parsed?.anySecretAnywhere === false, r.parsed?.anySecretAnywhere);
}

// ===========================================================================
function proofConsolidate(dir: string): void {
  console.log(
    "\n=== PROOF 2: CONSOLIDATION REAL VALUE (bounded + idempotent + durable across FRESH process; observable recall) ===",
  );

  // --- SEED + sweeps (process A). ---
  const s = runChild(dir, "consolidate-seed");
  if (s.stderr) console.log("  seed stderr:", s.stderr);
  check("seed child exit 0", s.status === 0, s.parsed?.error ?? null);
  check("seed ok", s.parsed?.ok === true, s.parsed?.error ?? null);
  const sweeps = (s.parsed?.sweeps ?? []) as Array<Record<string, unknown>>;
  console.log("  sweeps:", JSON.stringify(sweeps));

  const edgeSeries = sweeps.map((x) => Number(x.edges));
  const runSeries = sweeps.map((x) => Number(x.runs));
  const e0 = edgeSeries[0];
  const N = Number(s.parsed?.N);
  check("PROOF2 consolidation formed graph structure (edges > 0)", e0 > 0, edgeSeries);
  check("PROOF2 edge count STABLE across 6 sweeps (idempotent, no runaway)", edgeSeries.every((e) => e === e0), edgeSeries);
  check("PROOF2 edges BOUNDED (<= complete same-session graph)", e0 <= (N * (N - 1)) / 2, { e0, completeGraph: (N * (N - 1)) / 2 });
  check("PROOF2 run counter monotonic (+1 each sweep)", runSeries.every((rn, i) => i === 0 || rn === runSeries[i - 1] + 1), runSeries);
  check("PROOF2 sweeps actually ran (ran=true)", sweeps.every((x) => x.ran === true), sweeps.map((x) => x.ran));
  check("PROOF2 OBSERVABLE VALUE: associative recall returns graph neighbors", Number(s.parsed?.neighborCount) >= 1, { neighborCount: s.parsed?.neighborCount, recallHits: s.parsed?.recallHits });

  // --- REOPEN (process B, FRESH): checkpoint durable + idempotent across restart. ---
  const priorRuns = Number(s.parsed?.lastRuns);
  const priorEdges = Number(s.parsed?.lastEdges);
  const o = runChild(dir, "consolidate-reopen", String(priorRuns), String(priorEdges));
  if (o.stderr) console.log("  reopen stderr:", o.stderr);
  check("reopen child exit 0 (FRESH process)", o.status === 0, o.parsed?.error ?? null);
  check("reopen ok", o.parsed?.ok === true, o.parsed?.error ?? null);
  console.log("  reopen:", JSON.stringify(o.parsed));
  check("PROOF2 checkpoint DURABLE across reopen (run counter = prior + 1)", o.parsed?.runCounterAdvanced === true, { priorRuns, after: o.parsed?.runsAfterReopen });
  check("PROOF2 edges STABLE across reopen (idempotent across process boundary)", o.parsed?.edgesStable === true, { priorEdges, after: o.parsed?.edgesAfterReopen });
  check("PROOF2 associative recall STILL works after restart", Number(o.parsed?.neighborCount) >= 1, { neighborCount: o.parsed?.neighborCount, recallHits: o.parsed?.recallHits });
}

// ===========================================================================
(async () => {
  console.log("plureslm-openclaw P3+P4 VERIFY (channel-agnostic consumer boundary, against dist/ build)");
  console.log("HONESTY: P3 sweep is PULL/TICK (opportunistic from sync()); the JS binding has NO push/reactive path.");

  const redactDir = mkdtempSync(join(tmpdir(), "p3p4-verify-redact-"));
  const consolidateDir = mkdtempSync(join(tmpdir(), "p3p4-verify-consolidate-"));
  try {
    proofRedact(redactDir);
    proofConsolidate(consolidateDir);
  } finally {
    rmSync(redactDir, { recursive: true, force: true });
    rmSync(consolidateDir, { recursive: true, force: true });
  }

  console.log(
    `\n=== P3+P4 VERIFY RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("VERIFY DRIVER ERROR:", (err as Error)?.stack ?? err);
  process.exit(1);
});
