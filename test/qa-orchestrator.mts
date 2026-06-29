/**
 * P1 QA ORCHESTRATOR (independent QA stage).
 *
 * Drives the shipped sync()/search()/store API across MULTIPLE PROCESSES against
 * ONE real, fresh temp store, asserting the QA tasks:
 *   2) REAL-STORE PERSISTENCE (cross-process): sync in proc#1 -> edges form;
 *      reopen in a FRESH proc#2 -> edges + via:"graph" recall DURABLE on disk.
 *   3) IDEMPOTENT RE-LINK: re-sync unchanged files in a fresh proc -> 0 new
 *      content nodes + edge count before == after (no duplicate edges).
 *   4) ASSOCIATIVE METRIC: associative-only recall delta (graph-only targets) +
 *      precision guardrail re-confirmation.
 *   5) SANITY: force neighbors()/execIr to throw -> search() still returns the
 *      direct hits (best-effort expansion never throws out of the read path).
 *
 * One shared dbPath under .tmp/ is created here and reused across all child
 * phases so durability is genuinely cross-process (not in-memory). Real shipped
 * path only (C-TEST-002) — children never fabricate an edge or a graph hit.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "qa-assoc-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const TMP_ROOT = "C:/Projects/plureslm-openclaw/.tmp";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(
    `  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`,
  );
}

function runChild(dir: string, phase: string) {
  const res = spawnSync(process.execPath, [TSX_CLI, CHILD, dir, phase], {
    encoding: "utf8",
    timeout: 120_000,
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

(async () => {
  console.log("P1 QA ORCHESTRATOR (cross-process, real store, shipped API)\n");
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "p1-qa-"));
  console.log("  shared dbPath:", dir, "\n");
  let edgeCountAfterSync = -1;
  let alphaNeighborsAfterSync: string[] = [];

  try {
    // === TASK 2a: PROC #1 — sync + assert edges formed =====================
    console.log("=== TASK 2a: PROC#1 sync() -> real edges form (link-on-write) ===");
    const sync = runChild(dir, "sync");
    if (sync.stderr) console.log("  [proc#1 stderr]", sync.stderr.split(/\r?\n/).slice(-5).join(" | "));
    check("proc#1 exit 0", sync.status === 0);
    check("proc#1 ok", sync.parsed?.ok === true, sync.parsed?.error ?? null);
    const syncNodeDelta = Number(sync.parsed?.nodeDelta);
    check("proc#1 wrote >= 4 content nodes (4 fresh files)", syncNodeDelta >= 4, { nodeDelta: syncNodeDelta });
    edgeCountAfterSync = Number(sync.parsed?.graphLinkCount);
    check("proc#1: graph_links count > 0 (edges really formed)", edgeCountAfterSync > 0, { edgeCount: edgeCountAfterSync });
    check("proc#1: disjoint beta IS a graph neighbor of alpha seed", sync.parsed?.betaIsAlphaNeighbor === true, { neighbors: (sync.parsed?.neighborsBySeed as Record<string, string[]>)?.["mem:session:session-alpha:0"] ?? null });
    check("proc#1: disjoint delta IS a graph neighbor of alpha seed", sync.parsed?.deltaIsAlphaNeighbor === true);
    alphaNeighborsAfterSync = ((sync.parsed?.neighborsBySeed as Record<string, string[]>)?.["mem:session:session-alpha:0"]) ?? [];

    // === TASK 2b: PROC #2 (FRESH) — durability cross-process ===============
    console.log("\n=== TASK 2b: PROC#2 (FRESH) reopen -> edges + via:graph recall DURABLE on disk ===");
    const inspect = runChild(dir, "inspect");
    if (inspect.stderr) console.log("  [proc#2 stderr]", inspect.stderr.split(/\r?\n/).slice(-5).join(" | "));
    check("proc#2 exit 0", inspect.status === 0);
    check("proc#2 ok", inspect.parsed?.ok === true, inspect.parsed?.error ?? null);
    const edgeCountProc2 = Number(inspect.parsed?.graphLinkCount);
    check("proc#2: edges DURABLE (graph_links count > 0 in fresh process)", edgeCountProc2 > 0, { edgeCount: edgeCountProc2 });
    check("proc#2: edge count matches proc#1 (durable, not in-memory)", edgeCountProc2 === edgeCountAfterSync, { proc1: edgeCountAfterSync, proc2: edgeCountProc2 });
    const alphaNeighborsProc2 = ((inspect.parsed?.neighborsBySeed as Record<string, string[]>)?.["mem:session:session-alpha:0"]) ?? [];
    check("proc#2: alpha neighbors DURABLE (same set as proc#1)", JSON.stringify(alphaNeighborsProc2) === JSON.stringify(alphaNeighborsAfterSync), { proc1: alphaNeighborsAfterSync, proc2: alphaNeighborsProc2 });
    check("proc#2: via:graph recall DURABLE — disjoint beta surfaced via graph", inspect.parsed?.betaViaGraph === true, { ranked: inspect.parsed?.ranked ?? null });
    check("proc#2: via:graph recall DURABLE — disjoint delta surfaced via graph", inspect.parsed?.deltaViaGraph === true);

    // === TASK 3: IDEMPOTENT RE-LINK (fresh proc) ===========================
    console.log("\n=== TASK 3: re-sync unchanged files (FRESH proc) -> 0 new nodes + edge count before==after ===");
    const resync = runChild(dir, "resync");
    if (resync.stderr) console.log("  [resync stderr]", resync.stderr.split(/\r?\n/).slice(-5).join(" | "));
    check("resync exit 0", resync.status === 0);
    check("resync ok", resync.parsed?.ok === true, resync.parsed?.error ?? null);
    check("re-sync wrote 0 NEW content nodes (dirty tracker #isDirty)", Number(resync.parsed?.nodeDelta) === 0, { nodeDelta: resync.parsed?.nodeDelta });
    const eBefore = Number(resync.parsed?.edgeCountBefore);
    const eAfter = Number(resync.parsed?.edgeCountAfter);
    check("re-link did NOT duplicate edges (count before == after)", resync.parsed?.edgeCountStable === true && eBefore === eAfter, { before: eBefore, after: eAfter });
    check("re-link: neighbor sets identical (deterministic edge ids, last-writer-wins)", resync.parsed?.neighborsStable === true);
    // Cross-confirm the stable count equals the original proc#1 edge count.
    check("re-sync edge count == original sync edge count (no growth across re-link)", eAfter === edgeCountAfterSync, { original: edgeCountAfterSync, afterResync: eAfter });

    // === TASK 4: ASSOCIATIVE METRIC + guardrail ============================
    console.log("\n=== TASK 4: associative-only recall delta + precision guardrail ===");
    const metric = runChild(dir, "metric");
    if (metric.stderr) console.log("  [metric stderr]", metric.stderr.split(/\r?\n/).slice(-5).join(" | "));
    check("metric exit 0", metric.status === 0);
    check("metric ok", metric.parsed?.ok === true, metric.parsed?.error ?? null);
    const assocDelta = Number(metric.parsed?.associativeOnlyRecallDelta);
    console.log("  >>> ASSOCIATIVE-ONLY RECALL DELTA =", assocDelta, "| ids:", JSON.stringify(metric.parsed?.associativeOnlyIds ?? []));
    console.log("  >>> direct ids (strict):", JSON.stringify(metric.parsed?.directIds ?? []), "| graph ids:", JSON.stringify(metric.parsed?.graphIds ?? []));
    check("associative-only recall delta >= 1 (graph surfaces targets vector misses)", assocDelta >= 1, { delta: assocDelta, ids: metric.parsed?.associativeOnlyIds });
    // Guardrail re-confirmation
    check("GUARDRAIL: precision top-1 is the on-topic direct node (gamma), unchanged", metric.parsed?.precisionTop1ExpectedGamma === true, { top1: metric.parsed?.precisionTop1, via: metric.parsed?.precisionTop1Via });
    check("GUARDRAIL: top-1 is a DIRECT hit (no graph hit outranks at top-1)", metric.parsed?.noGraphAtTop1 === true);
    check("GUARDRAIL: every graph hit ranks strictly below its seed", metric.parsed?.guardrailHeld === true, { pRanked: metric.parsed?.pRanked });

    // === TASK 5: SANITY — best-effort expansion never throws ===============
    console.log("\n=== TASK 5: force neighbors()/execIr to throw -> search() still returns direct hits ===");
    const sanity = runChild(dir, "sanity");
    if (sanity.stderr) console.log("  [sanity stderr]", sanity.stderr.split(/\r?\n/).slice(-5).join(" | "));
    check("sanity exit 0", sanity.status === 0);
    check("sanity ok", sanity.parsed?.ok === true, sanity.parsed?.error ?? null);
    check("sanity: injected neighbors() failure was triggered", sanity.parsed?.neighborsThrew === true);
    check("SANITY: search() did NOT throw out (best-effort expansion)", sanity.parsed?.searchThrew === false);
    check("SANITY: direct hits still returned despite graph failure", Number(sanity.parsed?.directHitCount) > 0, { directHitCount: sanity.parsed?.directHitCount, paths: sanity.parsed?.hitPaths });
    check("SANITY: on-topic gamma still present as a direct hit", sanity.parsed?.gammaPresent === true);

    // Surface the headline numbers for the report.
    console.log("\n--- QA HEADLINE ---");
    console.log(JSON.stringify({
      edgesPersistCrossProcess: edgeCountProc2 > 0 && edgeCountProc2 === edgeCountAfterSync,
      edgeCountAfterSync,
      edgeCountProc2,
      resyncNewNodes: Number(resync.parsed?.nodeDelta),
      edgeCountBeforeResync: eBefore,
      edgeCountAfterResync: eAfter,
      duplicateEdgesOnResync: eBefore !== eAfter,
      associativeOnlyRecallDelta: assocDelta,
      associativeOnlyIds: metric.parsed?.associativeOnlyIds ?? [],
      guardrailHeld: metric.parsed?.precisionTop1ExpectedGamma === true && metric.parsed?.noGraphAtTop1 === true && metric.parsed?.guardrailHeld === true,
      bestEffortExpansionNeverThrows: sanity.parsed?.searchThrew === false && Number(sanity.parsed?.directHitCount) > 0,
    }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n=== QA RESULT: ${failures === 0 ? "ALL QA CHECKS PASSED" : failures + " QA CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("QA ORCHESTRATOR ERROR:", err?.stack ?? err);
  process.exit(1);
});
