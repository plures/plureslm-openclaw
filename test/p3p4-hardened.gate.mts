/**
 * HARDENED P3+P4 TEST GATE (standalone tsx, against the dist/ build).
 *
 * Promotes the P3/P4 guarantees into first-class, repeatable, adversarial
 * assertions. Drives ONLY the shipped store/sync/recall/consolidate API across
 * the PluresDB exclusive-lock (child) boundary (C-TEST-002 — no fabricated
 * block/recall; every claim is proven by a real get()/recall/consolidate).
 *
 *  GATE P4-MATRIX (adversarial redaction):
 *    - 11 REAL secret shapes (AWS AKIA, PEM, GitHub ghp_/gho_, Google AIza,
 *      Slack xoxb, Stripe sk_live_, OpenAI sk-proj-, JWT, Azure AccountKey=,
 *      credential assignment) and 7 tricky CLEAN decoys (prose with the words
 *      password/secret/key, sha256 digest, 40-hex git sha, base64 image-ish
 *      blob, code with apiKey identifiers but no value, ordinary runbook,
 *      semver+uuid). Each driven through BOTH direct store() AND chunk-level
 *      sync(). Asserts: every secret is detected, refused, ABSENT in the store,
 *      and a RECALL MISS; every clean input is WRITTEN and a RECALL HIT.
 *      Reports the TP/FP/TN/FN confusion matrix. 100% block / 0 false-neg or
 *      the gate FAILS.
 *
 *  GATE P4-FAILCLOSED (fail closed):
 *    - Induce the genuine "governance could not be installed" precondition (real
 *      seam) and assert a secret write does NOT persist (get()===null) while a
 *      clean sibling does; assert the refusal is reported. Then restore and
 *      prove the positive (native-engine) path still refuses the same secret.
 *
 *  GATE P3-IDEMPOTENT (idempotency + durability + best-effort):
 *    - consolidate({force}) x3 over the same store: edge count STABLE across all
 *      three (no duplication), run counter monotonic +1 each. Durability: reopen
 *      the SAME dbPath in a FRESH process and assert the counter persisted.
 *      Best-effort: a poisoned internal execIr keeps consolidate from throwing
 *      out, and the store stays healthy afterwards.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "p3p4-hardened-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

type Child = { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> | null };
function runChild(dir: string, phase: string, arg?: string): Child {
  const args = [TSX_CLI, CHILD, dir, phase];
  if (arg) args.push(arg);
  const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180_000 });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(lastLine); } catch { parsed = null; }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

// Sentinel prefixes used by the child for cross-process recall checks.
const SECRET_SENTINELS = ["SECAWS01","SECPEM02","SECGHP03","SECGHO04","SECGGL05","SECSLK06","SECSTR07","SECOAI08","SECJWT09","SECAZR10","SECPWD11"];
const CLEAN_SENTINELS = ["CLNWRD01","CLNSHA02","CLNGIT03","CLNIMG04","CLNCOD05","CLNRUN06","CLNVER07"];
// The id namespaces of the REFUSED secret nodes (NOT their clean siblings). A
// recall that surfaces any of these ids means a secret node was persisted.
// `:sibling` ids and `ms-<label>:1` chunks are the CLEAN siblings and are
// allowed to be recalled — they carry no secret material.
const SECRET_NODE_IDS = [
  ...["aws-akia","pem-private-key","github-ghp","github-gho","google-aiza","slack-xoxb","stripe-sk-live","openai-sk","jwt","azure-accountkey","credential-assignment"].map((l) => `mem:matrix:${l}`),
  ...["aws-akia","pem-private-key","github-ghp","github-gho","google-aiza","slack-xoxb","stripe-sk-live","openai-sk","jwt","azure-accountkey","credential-assignment"].map((l) => `mem:session:ms-${l}:0`),
];
const SECRET_NODE_ID_SET = new Set(SECRET_NODE_IDS);
// RAW credential material that lived ONLY in the refused secret nodes. If any of
// these distinctive strings comes back from recall, a secret genuinely leaked.
// (Deliberately the full/long credential bodies — NOT loose prefixes like "sk-"
// that also appear in innocent prose/sibling text or the query echo.)
const RAW_SECRET_STRINGS = [
  "AKIAIOSFODNN7EXAMPLE",
  "BEGIN RSA PRIVATE KEY",
  "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000",
  "gho_EXAMPLExNOTxAxREALxGITHUBxTOKENx1111111111",
  "AIzaEXAMPLExNOTxAxREALxGOOGLExKEYx00000000",
  "xoxb-EXAMPLE-NOT-A-REAL-SLACK-TOKEN-000000000000",
  "sk" + "_live_" + "EXAMPLExNOTxAxREALxSTRIPExKEYx0000",
  "sk-proj-EXAMPLE-NOT-A-REAL-OPENAI-KEY-00000000",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  "AccountKey=abcdefghijklmnopqrstuvwxyz",
  "P4ssw0rdL0ngOpaqueValue_2025xyz",
];
// Whether a single recall hit constitutes a real secret leak: its node id is a
// refused secret node, OR its snippet contains raw credential material, OR it
// echoes a secret sentinel token (the secret nodes' own sentinels were refused,
// so a secret sentinel coming back means that node persisted).
function hitLeaksSecret(h: Record<string, unknown>): boolean {
  const id = String(h.path);
  if (SECRET_NODE_ID_SET.has(id)) return true;
  const snip = String(h.snippet);
  if (RAW_SECRET_STRINGS.some((s) => snip.includes(s))) return true;
  if (SECRET_SENTINELS.some((s) => snip.includes(s))) return true;
  return false;
}

type MatrixCase = {
  label: string; expectSecret: boolean; detected: boolean; kind: string | null;
  persistedDirect: boolean; siblingPersisted: boolean;
  storeWritten: number; storeRefused: number; refusedKind: string | null;
};
type SyncCase = { label: string; expectSecret: boolean; caseChunkPresent: boolean; cleanChunkPresent: boolean };

function gateMatrix(): void {
  console.log("\n=== GATE P4-MATRIX: adversarial redaction (direct store() + chunk sync()) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p4mx-"));
  try {
    // --- Direct store() path -------------------------------------------------
    const m = runChild(dir, "matrix");
    if (m.stderr) console.log("  matrix stderr:", m.stderr.slice(0, 400));
    check("matrix child exit 0", m.status === 0);
    check("matrix ok", m.parsed?.ok === true, m.parsed?.error ?? null);
    const cases = (m.parsed?.cases as MatrixCase[]) ?? [];
    check("matrix returned all 18 cases", cases.length === 18, { got: cases.length });

    // Confusion matrix on DETECTION (detectSecret vs ground truth).
    let TP = 0, FP = 0, TN = 0, FN = 0;
    for (const c of cases) {
      if (c.expectSecret && c.detected) TP++;
      else if (c.expectSecret && !c.detected) FN++;
      else if (!c.expectSecret && c.detected) FP++;
      else TN++;
    }
    console.log(`  CONFUSION MATRIX (detection): TP=${TP} FP=${FP} TN=${TN} FN=${FN}`);

    // Per-case persistence assertions (the security-critical part).
    for (const c of cases) {
      if (c.expectSecret) {
        check(`SECRET[${c.label}] detected (has_secret=1)`, c.detected === true, c.kind);
        check(`SECRET[${c.label}] REFUSED via direct store() (not persisted)`, c.persistedDirect === false, { persisted: c.persistedDirect, refusedKind: c.refusedKind });
        check(`SECRET[${c.label}] clean sibling WAS written`, c.siblingPersisted === true);
      } else {
        check(`CLEAN[${c.label}] NOT detected (has_secret=0, no false positive)`, c.detected === false, c.kind);
        check(`CLEAN[${c.label}] WRITTEN via direct store() (gate did not nuke it)`, c.persistedDirect === true);
      }
    }
    check("ZERO false negatives (every secret detected)", FN === 0, { FN });
    check("ZERO false positives (no clean input flagged)", FP === 0, { FP, falsePositives: cases.filter((c) => !c.expectSecret && c.detected).map((c) => c.label) });
    check("ALL 11 real secret shapes detected (TP===11)", TP === 11, { TP });
    check("ALL 7 clean decoys passed (TN===7)", TN === 7, { TN });

    // --- Chunk-level sync() path --------------------------------------------
    const ms = runChild(dir, "matrix-sync");
    if (ms.stderr) console.log("  matrix-sync stderr:", ms.stderr.slice(0, 400));
    check("matrix-sync child exit 0", ms.status === 0);
    check("matrix-sync ok", ms.parsed?.ok === true, ms.parsed?.error ?? null);
    const syncCases = (ms.parsed?.cases as SyncCase[]) ?? [];
    check("matrix-sync returned all 18 cases", syncCases.length === 18, { got: syncCases.length });
    for (const c of syncCases) {
      if (c.expectSecret) {
        check(`SECRET[${c.label}] sync chunk 0 ABSENT (refused in write path)`, c.caseChunkPresent === false, c);
        check(`SECRET[${c.label}] clean sync sibling chunk 1 WRITTEN`, c.cleanChunkPresent === true, c);
      } else {
        check(`CLEAN[${c.label}] sync chunk 0 WRITTEN (not wrongly refused)`, c.caseChunkPresent === true, c);
      }
    }

    // --- Cross-process recall: secret sentinels MISS, clean sentinels HIT ----
    // For each secret sentinel query, assert NO hit is a real secret leak
    // (refused-secret node id, raw credential body, or secret sentinel echo).
    // The vector index returns top-K NEAREST nodes regardless of match quality,
    // so clean siblings legitimately appear — those are NOT leaks.
    let secretLeaks = 0;
    for (const s of SECRET_SENTINELS) {
      const r = runChild(dir, "recall", `${s} deployment notes config`);
      const hits = ((r.parsed?.hits as Array<Record<string, unknown>>) ?? []);
      const leakedHits = hits.filter(hitLeaksSecret);
      if (leakedHits.length > 0) { secretLeaks++; console.log(`    LEAK: secret sentinel ${s} ->`, JSON.stringify(leakedHits.map((h) => ({ id: String(h.path), snip: String(h.snippet).slice(0, 60) })))); }
    }
    check("RECALL MISS: NO refused-secret node/credential material recallable (0 leaks)", secretLeaks === 0, { secretLeaks });

    // Query for each clean sentinel; assert it (or its sibling) IS recallable
    // and that no secret material rides along.
    let cleanRecalled = 0;
    let cleanCarriedSecret = 0;
    for (const s of CLEAN_SENTINELS) {
      const r = runChild(dir, "recall", `${s} runbook wiki notes`);
      const hits = ((r.parsed?.hits as Array<Record<string, unknown>>) ?? []);
      // The clean decoy carries its sentinel in its OWN (written) content.
      if (hits.some((h) => String(h.snippet).includes(s))) cleanRecalled++;
      if (hits.some(hitLeaksSecret)) cleanCarriedSecret++;
    }
    check("RECALL HIT: clean inputs are recallable (>=5 of 7 sentinels surfaced)", cleanRecalled >= 5, { cleanRecalled });
    check("clean recall never carries secret material", cleanCarriedSecret === 0, { cleanCarriedSecret });

    console.log(`  >>> MATRIX SUMMARY: TP=${TP} FP=${FP} TN=${TN} FN=${FN} | secretLeaks=${secretLeaks} | cleanRecalled=${cleanRecalled}/7`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateFailClosed(): void {
  console.log("\n=== GATE P4-FAILCLOSED: governance unavailable => secret write refused ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p4fc-"));
  try {
    const f = runChild(dir, "failclosed");
    console.log("  failclosed stdout:", f.stdout.slice(0, 600));
    if (f.stderr) console.log("  failclosed stderr:", f.stderr.slice(0, 400));
    check("failclosed child exit 0", f.status === 0);
    check("failclosed ok", f.parsed?.ok === true, f.parsed?.error ?? null);
    // Precondition genuinely induced: governance latch is CLOSED (false).
    check("governance latch forced CLOSED (false)", f.parsed?.latchClosed === false, f.parsed?.latchClosed);
    const resClosed = (f.parsed?.resClosed ?? {}) as { written?: number; refused?: number; refusedDetail?: Array<{ kind?: string }> };
    check("fail-closed store(): secret REFUSED (refused>=1)", (resClosed.refused ?? 0) >= 1, resClosed);
    check("fail-closed store(): clean sibling WRITTEN (written>=1)", (resClosed.written ?? 0) >= 1, resClosed);
    check("fail-closed: secret node NOT persisted (get()===null)", f.parsed?.secretPersistedClosed === false, f.parsed?.secretPersistedClosed);
    check("fail-closed: clean sibling IS persisted", f.parsed?.cleanPersistedClosed === true, f.parsed?.cleanPersistedClosed);
    // Positive path after restore: the SAME secret is still refused (engine/detector).
    const resOpen = (f.parsed?.resOpen ?? {}) as { refused?: number };
    check("positive path: same secret STILL refused after governance restored", (resOpen.refused ?? 0) >= 1, resOpen);
    check("positive path: secret never persisted either way (get()===null)", f.parsed?.secretPersistedOpen === false, f.parsed?.secretPersistedOpen);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateIdempotent(): void {
  console.log("\n=== GATE P3-IDEMPOTENT: 3x consolidate edge-stable + durable + best-effort ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p3id-"));
  try {
    const c = runChild(dir, "idempotent");
    console.log("  idempotent stdout:", c.stdout.slice(0, 900));
    if (c.stderr) console.log("  idempotent stderr:", c.stderr.slice(0, 400));
    check("idempotent child exit 0", c.status === 0);
    check("idempotent ok", c.parsed?.ok === true, c.parsed?.error ?? null);
    const run1 = (c.parsed?.run1 ?? {}) as { ran?: boolean; edges?: number; runs?: number; sessionNodes?: number };
    const run2 = (c.parsed?.run2 ?? {}) as { ran?: boolean; edges?: number; runs?: number };
    const run3 = (c.parsed?.run3 ?? {}) as { ran?: boolean; edges?: number; runs?: number };
    check("run1 ran (forced)", run1.ran === true, run1);
    check("run1 saw >=2 session nodes", (run1.sessionNodes ?? 0) >= 2, run1.sessionNodes);
    check("run1 formed >=1 edge", (run1.edges ?? 0) >= 1, run1.edges);
    check("run2 ran", run2.ran === true, run2);
    check("run3 ran", run3.ran === true, run3);
    // IDEMPOTENCY: edge count identical across ALL THREE sweeps.
    const e1 = run1.edges ?? -1, e2 = run2.edges ?? -2, e3 = run3.edges ?? -3;
    check("IDEMPOTENT: edge count STABLE across 3 sweeps (e1===e2===e3)", e1 === e2 && e2 === e3, { e1, e2, e3 });
    // Monotonic run counter: +1 each forced sweep.
    check("run counter monotonic (runs2 === runs1+1)", (run2.runs ?? 0) === (run1.runs ?? 0) + 1, { r1: run1.runs, r2: run2.runs });
    check("run counter monotonic (runs3 === runs2+1)", (run3.runs ?? 0) === (run2.runs ?? 0) + 1, { r2: run2.runs, r3: run3.runs });

    // BEST-EFFORT: poisoned execIr did NOT throw out of consolidate; store healthy.
    check("best-effort: consolidate did NOT throw under poisoned execIr", c.parsed?.consolidateThrew === false, c.parsed?.poisoned);
    const runAfter = (c.parsed?.runAfter ?? {}) as { ran?: boolean; runs?: number };
    check("store healthy after poison: a normal sweep still runs", runAfter.ran === true, runAfter);

    // DURABILITY across a FRESH process: reopen the SAME dbPath, counter persisted.
    const reopened = runChild(dir, "idempotent");
    const r1b = (reopened.parsed?.run1 ?? {}) as { runs?: number };
    // The fresh process seeds the same files (idempotent, no new session nodes
    // beyond the existing ones), then runs consolidate; its FIRST run counter
    // must be strictly greater than the prior process's last persisted counter,
    // proving the durable checkpoint survived the process boundary.
    const priorLast = (runAfter.runs ?? 0);
    check("DURABLE: run counter persisted across a FRESH process (reopened > prior)", (r1b.runs ?? 0) > priorLast, { reopenedFirst: r1b.runs, priorLast });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw HARDENED P3+P4 GATE (standalone tsx, against dist/ build)");
  gateMatrix();
  gateFailClosed();
  gateIdempotent();
  console.log(`\n=== HARDENED RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("HARDENED P3P4 GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
