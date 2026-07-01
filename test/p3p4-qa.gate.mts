/**
 * P3+P4 QA regression gate (EPIC-MEMORY-SUPERIORITY) — pins the defects QA
 * found so they cannot regress. Drives ONLY the shipped store/sync/recall/
 * consolidate API against the BUILT dist (C-TEST-002): every "refused" claim is
 * proven by store.get()===null, every "written"/"clean" claim by get()!==null
 * AND a real recall, every "no leak" claim by asserting the secret string never
 * appears in any recall snippet. No fabricated blocks, no weakened assertions,
 * no new stubs (C-NOSTUB-001). Self-fails with a non-zero exit on any breach.
 *
 * Findings pinned here:
 *  QA-1  SECONDARY-FIELD LEAK (real defect, FIXED): a live secret hidden in a
 *        content-bearing field OTHER than `content` (`value`/`body`/`note`/an
 *        arbitrary content field) used to be WRITTEN then RECALLED, because the
 *        gate only scanned the single primary snippet. The gate now scans every
 *        content value (#gateScanText). Assert each such node is REFUSED and the
 *        secret never recalls.
 *  QA-2  NO FALSE-POSITIVE FROM STRUCTURAL FIELDS (non-weakening proof): the
 *        broadened scan must NOT over-block. A wholly clean node carrying a
 *        synthetic id-shaped `hash` (e.g. `h-foo-bar-1`, 24+ mixed-class chars)
 *        MUST still be written and recallable — structural/bookkeeping keys are
 *        excluded from the scan. Also assert the real secret shapes still flag.
 *  QA-3  CHUNK BOUNDARY: a full secret inside ONE chunk is ALWAYS refused and
 *        never recalled; a secret SPLIT across two chunks (a documented, pinned
 *        limitation) is not detected per-chunk, BUT recall NEVER reassembles it
 *        into one contiguous usable token (no exfiltration). Both pinned.
 *  QA-4  CONSOLIDATE AT SCALE: ~40 nodes, 6 forced sweeps — edge count STABLE
 *        (idempotent), run counter monotonic + durable across reopen, edges
 *        bounded (no runaway explosion beyond the complete same-session graph).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
  PluresLmStore,
  detectSecret,
} from "../dist/api.js";

const MODEL = "BAAI/bge-small-en-v1.5";
let failures = 0;
const dirs: string[] = [];
function mkdir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${name} :: ${JSON.stringify(detail)}`);
  }
}

const GHP = "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000";
const GHP2 = "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx8888888888";
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7examplekeymaterialnotreal0000\n-----END RSA PRIVATE KEY-----";

// --- QA-1 + QA-2: secondary-field leak closed, no structural FP --------------
async function qaFieldCoverage(): Promise<void> {
  console.log("\n=== QA-1/QA-2: secondary-field secret leak closed + no structural FP ===");
  const dir = mkdir("qa-field-");
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });

  // (a) secrets in secondary content fields — MUST be refused, never recalled.
  const leakCases: Array<{ label: string; secret: string; data: Record<string, unknown> }> = [
    { label: "value", secret: GHP, data: { content: "benign deploy notes QA1VAL", value: `token ${GHP}`, category: "session", type: "memory-chunk", hash: "h-qa1-value-1" } },
    { label: "body", secret: AKIA, data: { content: "benign runbook QA1BODY", body: `aws_access_key_id = ${AKIA}`, category: "session", type: "memory-chunk", hash: "h-qa1-body-1" } },
    { label: "note", secret: "BEGIN RSA PRIVATE KEY", data: { content: "benign provisioning QA1NOTE", note: PEM, category: "session", type: "memory-chunk", hash: "h-qa1-note-1" } },
    { label: "arbitrary(credential)", secret: GHP2, data: { content: "benign config QA1ARB", credential: `secret ${GHP2}`, category: "session", type: "memory-chunk", hash: "h-qa1-arb-1" } },
  ];
  for (const c of leakCases) {
    const id = `mem:qa1:${c.label}`;
    const res = store.store([{ id, data: c.data }]);
    const persisted = Boolean(store.get(id));
    check(`QA-1 secret-in-${c.label}: REFUSED (not persisted)`, persisted === false, { persisted, refused: res.refused });
    check(`QA-1 secret-in-${c.label}: store() reported refusal`, res.refused >= 1, res);
  }
  // Recall must never surface any of those secret strings.
  const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "qa1" });
  if (!manager) throw new Error("no manager (qa1)");
  for (const c of leakCases) {
    const hits = await manager.search(c.label, { maxResults: 10 });
    const leaked = hits.some((h) => String(h.snippet).includes(c.secret));
    check(`QA-1 secret-in-${c.label}: NEVER recalled (no snippet leak)`, leaked === false, { leaked });
  }

  // (b) NON-WEAKENING: a wholly clean node WITH a synthetic id-shaped hash MUST
  // still write + recall (structural fields excluded from the scan).
  const cleanId = "mem:qa2:clean-with-hash";
  const cleanRes = store.store([{ id: cleanId, data: { content: "QA2CLEAN ordinary deployment notes about the wiki, nothing secret here", value: "see the runbook for details", category: "session", type: "memory-chunk", hash: "h-qa2-clean-with-a-long-id-1", source: "session", path: "/tmp/qa2-clean.md" } }]);
  check("QA-2 clean node WITH id-shaped hash: WRITTEN (not over-blocked)", Boolean(store.get(cleanId)) && cleanRes.written === 1, cleanRes);
  const cleanHits = await manager.search("QA2CLEAN", { maxResults: 10 });
  check("QA-2 clean node: recallable", cleanHits.some((h) => h.path === cleanId), cleanHits.map((h) => h.path));

  // (c) NON-WEAKENING: every canonical secret shape still flags via the detector.
  const shapes: Array<[string, string]> = [
    ["aws", `aws_access_key_id = ${AKIA}`],
    ["pem", PEM],
    ["ghp", `token ${GHP}`],
    ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ["bare-base64-secret", "Zm9vYmFyc2VjcmV0a2V5dmFsdWVoaWdoZW50cm9weTAxMjM0NTY3ODk="],
  ];
  for (const [k, t] of shapes) {
    check(`QA-2 non-weakening: detector still flags ${k}`, detectSecret(t).has_secret === true, detectSecret(t));
  }
}

// --- QA-3: chunk boundary ----------------------------------------------------
async function qaChunkBoundary(): Promise<void> {
  console.log("\n=== QA-3: chunk-boundary (full-in-one refused; split never reassembled) ===");
  const dir = mkdir("qa-chunk-");
  const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "qa3" });
  if (!manager) throw new Error("no manager (qa3)");
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(45);

  // (A) full secret in its own oversized chunk -> refused; clean tail -> written.
  const fileA = join(dir, "qa3a.md");
  writeFileSync(fileA, `QA3A deploy token ${GHP} for the runner ${FILLER}\n\ntrailing clean QA3ATAIL ${FILLER}\n`, "utf8");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileA] });
  check("QA-3 full secret in one chunk: REFUSED", store.get("mem:session:qa3a:0") === null, { c0: store.get("mem:session:qa3a:0") !== null });
  check("QA-3 clean tail chunk: WRITTEN", store.get("mem:session:qa3a:1") !== null);
  const aHits = await manager.search("QA3A", { maxResults: 10 });
  check("QA-3 full-in-one: secret NEVER in any snippet", aHits.every((h) => !String(h.snippet).includes(GHP)), aHits.map((h) => h.path));

  // (B) secret SPLIT across two chunks (pinned limitation). Each half is not a
  // valid credential shape -> per-chunk clean -> halves written. BUT recall must
  // NEVER return the contiguous secret in a single snippet (no exfiltration).
  const half1 = "ghp_ABCDEFGHIJKLMNOPQR"; // 22 chars; < 36 required -> not a token
  const half2 = "STUVWXYZ0123456789ab";
  const fileB = join(dir, "qa3b.md");
  writeFileSync(fileB, `QA3B token begins ${half1} ${FILLER}\n\n${half2} is the rest QA3BTAIL ${FILLER}\n`, "utf8");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileB] });
  const bHits = await manager.search("QA3B", { maxResults: 10 });
  const reassembled = bHits.some((h) => String(h.snippet).includes(half1 + half2));
  // The PINNED contract: split-secret is NOT reassembled by recall (the key
  // safety property). We do NOT assert the halves are refused (they are clean
  // shapes per-chunk) — we assert the contiguous secret never surfaces.
  check("QA-3 PINNED: split secret NEVER reassembled in any snippet", reassembled === false, { reassembled });
}

// --- QA-4: consolidate at scale ----------------------------------------------
async function qaConsolidateScale(): Promise<void> {
  console.log("\n=== QA-4: consolidate at scale (idempotent + bounded + durable) ===");
  const dir = mkdir("qa-scale-");
  const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
  const N = 40;
  const files: string[] = [];
  for (let i = 0; i < N; i++) {
    const f = join(dir, `qa4-${i}.md`);
    writeFileSync(f, `# node ${i}\n\nQA4N${i} note about the kraken deploy runbook step ${i % 5} cluster ${i % 4}.\n`, "utf8");
    files.push(f);
  }
  await manager.sync({ reason: "test", force: false, sessionFiles: files });
  const runs: Array<{ edges: number; runs: number; sessionNodes: number }> = [];
  for (let i = 0; i < 6; i++) {
    const r = store.consolidate({ force: true });
    runs.push({ edges: r.edges, runs: r.runs, sessionNodes: r.sessionNodes });
  }
  const e0 = runs[0].edges;
  check("QA-4 edge count STABLE across 6 sweeps (idempotent)", runs.every((r) => r.edges === e0), runs.map((r) => r.edges));
  check("QA-4 run counter monotonic (+1 each sweep)", runs.every((r, i) => i === 0 || r.runs === runs[i - 1].runs + 1), runs.map((r) => r.runs));
  check("QA-4 edges bounded (<= complete same-session graph, no runaway)", e0 >= 1 && e0 <= (N * (N - 1)) / 2, { edges: e0, completeGraph: (N * (N - 1)) / 2 });
  check("QA-4 session nodes seeded", runs[0].sessionNodes === N, runs[0].sessionNodes);
  // Durable checkpoint across a fresh handle (reopen same dbPath).
  const before = runs[runs.length - 1].runs;
  const store2 = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const after = store2.consolidate({ force: true });
  check("QA-4 run counter DURABLE across reopen", after.runs === before + 1, { before, after: after.runs });
}

(async () => {
  console.log("plureslm-openclaw P3+P4 QA REGRESSION GATE (standalone tsx, against dist/ build)");
  try {
    await qaFieldCoverage();
    await qaChunkBoundary();
    await qaConsolidateScale();
  } catch (err) {
    failures += 1;
    console.log(`  [FAIL] uncaught: ${String((err as Error)?.stack ?? err)}`);
  } finally {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  if (failures === 0) {
    console.log("\n=== QA REGRESSION RESULT: ALL CHECKS PASSED ===");
    process.exit(0);
  } else {
    console.log(`\n=== QA REGRESSION RESULT: ${failures} CHECK(S) FAILED ===`);
    process.exit(1);
  }
})();
