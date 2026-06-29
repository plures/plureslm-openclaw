/**
 * P1 VERIFY orchestrator (the FINAL P1 gate). Channel-agnostic, capability-
 * contract proof that associative recall works END-TO-END through the REAL
 * OpenClaw memory-capability surface the gateway calls — NOT a bespoke harness,
 * NOT any chat adapter (C-TEST-001/002).
 *
 * Every memory interaction below goes through exactly:
 *     buildMemoryCapability(cfg).runtime.getMemorySearchManager({cfg,agentId})
 *     -> manager.sync(...) / manager.search(...)
 * driven from `test/p1-verify-child.mts`. No internal store method is used for
 * any assertion. Phases run in separate processes (exclusive-lock contract);
 * the fresh-process read phases double as the DURABILITY proof.
 *
 * Proves four properties at the manager boundary:
 *   1. DIRECT-MISS, GRAPH-HIT — a query that vector-matches the on-topic memory
 *      ALSO returns the disjoint associated memory via:"graph" (citation
 *      contains graph), surfacing what cosine alone missed.
 *   2. PRECISION PRESERVED — an on-topic query returns the correct memory as
 *      top-1 (direct); graph hits never displace it.
 *   3. DURABILITY — a fresh process rebuilds the capability/manager against the
 *      SAME dbPath and associative recall STILL works (edges persisted on disk).
 *   4. GRACEFUL FALLBACK — when graph expansion has nothing to contribute (a
 *      lone memory with no associated sibling), search() STILL returns the
 *      direct hit, so enabling P1 can never make recall WORSE than baseline
 *      vector recall (augment-not-replace).
 *
 * Run: tsx test/p1-verify-gate.mts   (exit 0 = all VERIFY checks passed)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "p1-verify-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(
    `  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`,
  );
}

type Ranked = {
  rank: number;
  path: string;
  score: number;
  citation: string | null;
  via: "vector" | "text" | "graph";
  seedId: string | null;
  source: string | null;
};

function runChild(dir: string, phase: string) {
  // Spawn `node <tsx-cli> <child> <dir> <phase>` — robust cross-platform stdio
  // capture (the gate runner uses the same pattern). 120s per child covers a
  // cold embedder load on first invocation.
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
  console.log(
    "plureslm-openclaw P1 VERIFY GATE — associative recall through the REAL\n" +
      "MemorySearchManager boundary (getMemorySearchManager -> sync/search only)\n",
  );

  // === Main fixture store (oncall/rota/backup/plants, same session) ==========
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p1verify-"));
  // Separate store for the graceful-fallback lone node (no siblings).
  const loneDir = mkdtempSync(join(tmpdir(), "plureslm-p1verify-lone-"));
  try {
    // --- Phase 1: ingest via manager.sync() (host boundary) ------------------
    console.log("=== INGEST via getMemorySearchManager -> manager.sync() ===");
    const ingest = runChild(dir, "ingest");
    console.log("  ingest child stdout:", ingest.stdout);
    if (ingest.stderr) console.log("  ingest child stderr:", ingest.stderr);
    check("ingest child exit 0", ingest.status === 0);
    check("ingest ok", ingest.parsed?.ok === true, ingest.parsed?.error ?? null);
    check(
      "manager.sync() wrote the session set (delta >= 4 chunks)",
      Number(ingest.parsed?.delta) >= 4,
      { delta: ingest.parsed?.delta, before: ingest.parsed?.beforeChunks, after: ingest.parsed?.afterChunks },
    );
    check("manager.sync() invoked progress callback", Number(ingest.parsed?.progressCalls) >= 1, ingest.parsed?.progressCalls);
    check("manager reports backend builtin / provider plureslm", ingest.parsed?.backend === "builtin" && ingest.parsed?.provider === "plureslm", { backend: ingest.parsed?.backend, provider: ingest.parsed?.provider });

    // Node ids the child writes (kept in sync with p1-verify-child.mts).
    const ID_ONCALL = "mem:session:sess-oncall:0";
    const ID_ROTA = "mem:session:sess-rota:0";
    const ID_BACKUP = "mem:session:sess-backup:0";

    // --- Phase 2: DIRECT-MISS / GRAPH-HIT (fresh proc, strict threshold) -----
    // This is ALSO the DURABILITY proof for the win: a brand-new process reopens
    // the same dbPath; if ROTA surfaces via graph, the edge was on disk.
    console.log("\n=== DIRECT-MISS / GRAPH-HIT (fresh process, strict 0.80) ===");
    const strict = runChild(dir, "read-strict");
    console.log("  read-strict child stdout:", strict.stdout);
    if (strict.stderr) console.log("  read-strict child stderr:", strict.stderr);
    check("read-strict child exit 0", strict.status === 0);
    check("read-strict ok", strict.parsed?.ok === true, strict.parsed?.error ?? null);
    const sRanked = (strict.parsed?.ranked as Ranked[]) ?? [];
    check("strict recall NON-EMPTY", sRanked.length > 0, { count: sRanked.length });
    const sOncall = sRanked.find((h) => h.path === ID_ONCALL);
    const sRota = sRanked.find((h) => h.path === ID_ROTA);
    // The on-topic ONCALL must be a DIRECT vector hit (the query vector-matches it).
    check("DIRECT: on-topic oncall present as a DIRECT hit (vector match)", Boolean(sOncall) && sOncall!.via !== "graph", sOncall ?? null);
    // ROTA is disjoint + below the strict bar => it can ONLY arrive via graph.
    check("GRAPH-HIT: disjoint rota surfaced (cosine alone would miss it)", Boolean(sRota), { wantId: ID_ROTA, got: sRanked.map((h) => `${h.path}#${h.via}`) });
    check('GRAPH-HIT: rota arrived via:"graph"', sRota?.via === "graph", sRota ?? null);
    check('GRAPH-HIT: rota citation contains "graph"', Boolean(sRota?.citation?.includes("graph")), sRota?.citation ?? null);
    check("GRAPH-HIT: rota seeded from the oncall direct hit", sRota?.seedId === ID_ONCALL, { seed: sRota?.seedId ?? null, expected: ID_ONCALL });
    if (sOncall && sRota) {
      check("GRAPH-HIT: rota ranks strictly BELOW its oncall seed (no displacement)", sRota.rank > sOncall.rank, { oncallRank: sOncall.rank, rotaRank: sRota.rank });
    }
    // DURABILITY is established by construction here: this ran in a FRESH process
    // (separate spawn from ingest) reopening the same dbPath — the edge ROTA
    // arrived over was read from disk, not from in-memory state.
    check("DURABILITY: graph edge survived a fresh process (cross-lock-boundary)", sRota?.via === "graph", { note: "read-strict is a separate process from ingest" });

    // --- Phase 3: PRECISION PRESERVED (fresh proc, default threshold) --------
    console.log("\n=== PRECISION PRESERVED (fresh process, default threshold) ===");
    const def = runChild(dir, "read-default");
    console.log("  read-default child stdout:", def.stdout);
    if (def.stderr) console.log("  read-default child stderr:", def.stderr);
    check("read-default child exit 0", def.status === 0);
    check("read-default ok", def.parsed?.ok === true, def.parsed?.error ?? null);
    const dRanked = (def.parsed?.ranked as Ranked[]) ?? [];
    check("default recall NON-EMPTY", dRanked.length > 0, { count: dRanked.length });
    const dTop = dRanked[0];
    check("PRECISION: top-1 is the expected on-topic node (backup)", dTop?.path === ID_BACKUP, { top: dTop?.path, expected: ID_BACKUP });
    check("PRECISION: top-1 is a DIRECT hit (not graph)", dTop?.via !== "graph", dTop ?? null);
    const graphAtTop = dRanked.some((h) => h.via === "graph" && h.rank === 0);
    check("PRECISION: no graph hit occupies top-1", !graphAtTop, { graphAtTop });
    // Every graph hit (if any cleared into the list) ranks strictly below its seed.
    const rankOf = new Map(dRanked.map((h) => [h.path, h.rank] as const));
    let guardrailHeld = true;
    for (const h of dRanked) {
      if (h.via !== "graph") continue;
      const seedRank = h.seedId !== null ? rankOf.get(h.seedId) : undefined;
      if (!(seedRank !== undefined && seedRank < h.rank)) guardrailHeld = false;
    }
    check("PRECISION: every graph hit ranks strictly below its direct seed", guardrailHeld, { ranked: dRanked.map((h) => `${h.path}#${h.via}@${h.rank}`) });

    // --- Phase 4: GRACEFUL FALLBACK (fresh procs, lone-node store) -----------
    // Augment-not-replace: when graph expansion has nothing to contribute (a
    // memory with no associated sibling => no usable edge), search() STILL
    // returns the direct hit. Enabling P1 never makes recall worse than baseline
    // vector recall. Proven through the manager boundary on a separate store.
    console.log("\n=== GRACEFUL FALLBACK (lone memory, no graph edges to expand) ===");
    const ingestLone = runChild(loneDir, "ingest-lone");
    console.log("  ingest-lone child stdout:", ingestLone.stdout);
    if (ingestLone.stderr) console.log("  ingest-lone child stderr:", ingestLone.stderr);
    check("ingest-lone child exit 0", ingestLone.status === 0);
    check("ingest-lone ok", ingestLone.parsed?.ok === true, ingestLone.parsed?.error ?? null);
    check("manager.sync() wrote the lone node (delta >= 1)", Number(ingestLone.parsed?.delta) >= 1, { delta: ingestLone.parsed?.delta });

    const lone = runChild(loneDir, "read-lone");
    console.log("  read-lone child stdout:", lone.stdout);
    if (lone.stderr) console.log("  read-lone child stderr:", lone.stderr);
    check("read-lone child exit 0", lone.status === 0);
    check("read-lone ok", lone.parsed?.ok === true, lone.parsed?.error ?? null);
    const lRanked = (lone.parsed?.ranked as Ranked[]) ?? [];
    const ID_LONE = "mem:session:sess-lone:0";
    check("FALLBACK: direct recall NON-EMPTY despite nothing to graph-expand", lRanked.length > 0, { count: lRanked.length });
    const lTop = lRanked[0];
    check("FALLBACK: the lone memory is returned as the direct top-1 hit", lTop?.path === ID_LONE && lTop?.via !== "graph", lTop ?? null);
    check("FALLBACK: search() degraded to pure direct recall (no spurious graph hits)", Number(lone.parsed?.graphHitCount) === 0, { graphHitCount: lone.parsed?.graphHitCount });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(loneDir, { recursive: true, force: true });
  }

  console.log(
    `\n=== P1 VERIFY RESULT: ${failures === 0 ? "ALL VERIFY CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("P1 VERIFY RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
