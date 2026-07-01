/**
 * P3+P4 TEST GATE (standalone tsx, against the dist/ build).
 *
 * Proves the two EPIC-MEMORY-SUPERIORITY deliverables end-to-end through the
 * SHIPPED path, across the PluresDB exclusive-lock (child) boundary:
 *
 *  GATE P4 (governed write / C-MEM-REDACT REALLY BLOCKS):
 *    - secret-write child: via sync() ingest a file whose first chunk holds a
 *      real secret (AWS AKIA + PEM) and whose second chunk is clean; ALSO a
 *      direct store.store([secretNode, cleanNode]).
 *    - Assert the governed-write gate REFUSED the secret node (refused>=1,
 *      refusedDetail names the secret kind) and WROTE the clean node.
 *    - Assert the refused secret node is NOT in the store (get() === null).
 *    - Reopen in a FRESH process and assert: the secret SENTINEL does NOT come
 *      back from recall() (recall miss), while the CLEAN sentinel DOES.
 *      => the secret was never persisted; the clean sibling was. Real block.
 *
 *  GATE P3 (consolidation sweep runs via shipped path + idempotent):
 *    - consolidate child: sync() two same-session files, then call
 *      store.consolidate({force:true}) TWICE.
 *    - Assert both runs succeeded (ran===true), the edge count is STABLE across
 *      the two runs (idempotent: deterministic edges converge, no explosion),
 *      the durable run counter INCREMENTED (runs2 === runs1 + 1), and a fresh
 *      reopen still answers recall (no corruption / GATE A/B/C-style health).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "p3p4-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: string, query?: string) {
  const args = [TSX_CLI, CHILD, dir, phase];
  if (query) args.push(query);
  const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180_000 });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(lastLine); } catch { parsed = null; }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

// Sentinels must match p3p4-child.mts.
const SECRET_SENTINEL = "QZX9001SECRET";
const CLEAN_SENTINEL = "PLM8800CLEAN";

function gateP4(): void {
  console.log("\n=== GATE P4: C-MEM-REDACT governed write REALLY BLOCKS a secret ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p4-"));
  try {
    const w = runChild(dir, "secret-write");
    console.log("  secret-write stdout:", w.stdout);
    if (w.stderr) console.log("  secret-write stderr:", w.stderr);
    check("secret-write child exit 0", w.status === 0);
    check("secret-write ok", w.parsed?.ok === true, w.parsed?.error ?? null);

    const direct = (w.parsed?.direct ?? {}) as {
      written?: number; skipped?: number; refused?: number;
      refusedDetail?: Array<{ id: string; reason: string; kind?: string }>;
    };
    // The governed-write gate refused the secret node and wrote the clean one.
    check("direct store: refused >= 1 (secret blocked)", (direct.refused ?? 0) >= 1, direct);
    check("direct store: written >= 1 (clean sibling written)", (direct.written ?? 0) >= 1, direct);
    const refusedSecret = (direct.refusedDetail ?? []).some(
      (r) => r.id === "mem:direct:secret" && r.reason === "secret",
    );
    check("refusedDetail names the secret node with reason 'secret'", refusedSecret, direct.refusedDetail);
    const refusedKind = (direct.refusedDetail ?? [])[0]?.kind;
    check("refusedDetail carries a detected secret kind", typeof refusedKind === "string" && refusedKind.length > 0, refusedKind);

    // The refused node truly never landed; the clean one did (DIRECT path).
    check("refused secret node is ABSENT in store (get()===null)", w.parsed?.secretNodePresent === false, w.parsed?.secretNodePresent);
    check("clean sibling node IS PRESENT in store", w.parsed?.cleanNodePresent === true, w.parsed?.cleanNodePresent);
    // SYNC path (same file, two separate chunks): secret chunk refused, clean kept.
    check("SYNC: secret chunk (chunk 0) is ABSENT after sync (refused in write path)", w.parsed?.syncSecretChunkPresent === false, w.parsed?.syncSecretChunkPresent);
    check("SYNC: clean sibling chunk (chunk 1, same file) IS WRITTEN", w.parsed?.syncCleanChunkPresent === true, w.parsed?.syncCleanChunkPresent);

    // Cross-process recall: secret sentinel MISS, clean sentinel HIT.
    const rSecret = runChild(dir, "read", "QZX9001SECRET deployment notes");
    console.log("  read(secret) stdout:", rSecret.stdout);
    check("read(secret) child exit 0", rSecret.status === 0);
    const secretHits = (rSecret.parsed?.hits as Array<Record<string, unknown>>) ?? [];
    const secretLeaked = secretHits.some(
      (h) => String(h.snippet).includes(SECRET_SENTINEL) || String(h.snippet).includes("AKIA") || String(h.snippet).includes("PRIVATE KEY"),
    );
    check("RECALL MISS: secret sentinel/content NOT recallable (never persisted)", !secretLeaked, { count: secretHits.length });

    const rClean = runChild(dir, "read", "PLM8800CLEAN kraken runbook lives in the wiki");
    console.log("  read(clean) stdout:", rClean.stdout);
    check("read(clean) child exit 0", rClean.status === 0);
    const cleanHits = (rClean.parsed?.hits as Array<Record<string, unknown>>) ?? [];
    // The clean sync chunk OR the clean direct node proves clean content is
    // recallable; the secret must NOT appear in either hit set.
    const cleanRecalled = cleanHits.some(
      (h) => String(h.snippet).includes(CLEAN_SENTINEL) || String(h.path) === "mem:direct:clean" || String(h.path) === "mem:session:session-secret:1",
    );
    const cleanLeakedSecret = cleanHits.some(
      (h) => String(h.snippet).includes(SECRET_SENTINEL) || String(h.snippet).includes("AKIA") || String(h.snippet).includes("PRIVATE KEY"),
    );
    check("RECALL HIT: clean sibling chunk IS recallable", cleanRecalled, { count: cleanHits.length, top: cleanHits[0]?.snippet });
    check("clean recall does NOT leak any secret material", !cleanLeakedSecret, { count: cleanHits.length });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateP3(): void {
  console.log("\n=== GATE P3: consolidation sweep runs via shipped path + idempotent ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p3-"));
  try {
    const c = runChild(dir, "consolidate");
    console.log("  consolidate stdout:", c.stdout);
    if (c.stderr) console.log("  consolidate stderr:", c.stderr);
    check("consolidate child exit 0", c.status === 0);
    check("consolidate ok", c.parsed?.ok === true, c.parsed?.error ?? null);

    const run1 = (c.parsed?.run1 ?? {}) as { ran?: boolean; edges?: number; runs?: number; clusters?: number; topRanked?: string[]; sessionNodes?: number };
    const run2 = (c.parsed?.run2 ?? {}) as { ran?: boolean; edges?: number; runs?: number };
    check("run1 ran (forced sweep executed via shipped store.consolidate)", run1.ran === true, run1);
    check("run1 saw session nodes (>=2)", (run1.sessionNodes ?? 0) >= 2, run1.sessionNodes);
    check("run1 formed associative edges (>=1)", (run1.edges ?? 0) >= 1, run1.edges);
    check("run2 ran (second forced sweep)", run2.ran === true, run2);
    // Idempotency: deterministic edges converge -> same count, no explosion.
    check("IDEMPOTENT: edge count STABLE across two sweeps", (run1.edges ?? -1) === (run2.edges ?? -2), { run1Edges: run1.edges, run2Edges: run2.edges });
    // Durable monotonic run counter advanced by exactly one.
    check("durable run counter incremented (runs2 === runs1 + 1)", (run2.runs ?? 0) === (run1.runs ?? 0) + 1, { runs1: run1.runs, runs2: run2.runs });

    // Health after consolidation: a fresh reopen still recalls (no corruption).
    const r = runChild(dir, "read", "kraken deploy runbook");
    console.log("  read(after-consolidate) stdout:", r.stdout);
    check("read after consolidate exit 0", r.status === 0);
    check("store still healthy: recall NON-EMPTY after consolidation", ((r.parsed?.hits as unknown[]) ?? []).length > 0, { count: ((r.parsed?.hits as unknown[]) ?? []).length });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw P3+P4 GATE (standalone tsx, against dist/ build)");
  gateP4();
  gateP3();
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("P3P4 GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
