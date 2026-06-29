/**
 * Standalone TEST GATE runner (C-TEST-001), executed via tsx.
 *
 * Why standalone tsx and not vitest: on this Windows host, pnpm sandboxes
 * esbuild's postinstall (ERR_PNPM_IGNORED_BUILDS), so vitest's TS transform
 * binary is not provisioned. tsx bundles its own working esbuild, so the gate
 * runs deterministically without approving third-party build scripts. The
 * brief explicitly permits "vitest OR standalone tsx". The vitest spec
 * (test/recall.gate.test.ts) is kept for environments where esbuild is built.
 *
 * The gate runs the REAL plugin read path against the BUILT artifact
 * (../dist/api.js -> buildMemoryCapability), via two child processes to respect
 * the PluresDB exclusive file lock.
 *
 *  GATE A (compatibility): open the stale COPY fixture through the plugin read
 *    path; assert it opens and status() works.
 *  GATE B (recall): seed a known store, reopen in a fresh process through the
 *    built plugin path, assert NON-EMPTY correct recall + count stability.
 *  GATE C (write->recall): ingest a sentinel session file through the SHIPPED
 *    write path (buildMemoryCapability -> getMemorySearchManager ->
 *    manager.sync()) in one process, then reopen in a fresh process and assert
 *    the sentinel comes back from recall() with a sane score and totalNodes > 0.
 *    This proves the real write path (sync -> store -> put -> buildVectorIndex),
 *    not just the test seeder, makes content recallable across the lock boundary.
 *  GATE D (associative graph recall): through the SHIPPED capability (sync()
 *    link-on-write + search() graph expansion), assert BOTH (a) the ASSOCIATIVE
 *    WIN — a node whose content is disjoint from the query (below a strict
 *    threshold, so it is NOT a direct vector/text hit) is still surfaced via
 *    graph expansion (citation contains "graph", via:"graph"), durable across a
 *    fresh process — and (b) the PRECISION GUARDRAIL — with the DEFAULT
 *    threshold the on-topic direct hit ranks FIRST and every graph hit ranks
 *    strictly BELOW the direct hit that seeded it (graph hits are appended after
 *    direct hits and never displace top-1). Uses the cross-process child
 *    (test/assoc-child.mts) so the write/link phase and the fresh-process read
 *    phases honor the exclusive-lock contract. Real shipped path only — no
 *    fixtures faking recall (C-TEST-002).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildMemoryCapability } from "../dist/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "store-child.mts");
const ASSOC_CHILD = join(here, "assoc-child.mts");
// Spawn the child as `node <tsx-cli> <child>`. On Windows, spawnSync on the
// `tsx.cmd` shim does not reliably capture stdio / launch; invoking the tsx
// CLI .mjs through the current node binary is robust and cross-platform.
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const COPY_FIXTURE =
  "C:/Users/kbristol/.openclaw/workspace/.tmp/plureslm-store-copy-20260626";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: "seed" | "write" | "read", query?: string) {
  const args = [TSX_CLI, CHILD, dir, phase];
  if (phase === "read" && query) args.push(query);
  const res = spawnSync(process.execPath, args, {
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

function runAssocChild(dir: string, phase: "link" | "read-strict" | "read-default") {
  const res = spawnSync(process.execPath, [TSX_CLI, ASSOC_CHILD, dir, phase], {
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

type RankedHit = {
  rank: number;
  path: string;
  score: number;
  citation: string | null;
  via: "vector" | "text" | "graph";
  seedId: string | null;
};

async function gateA(): Promise<void> {
  console.log("\n=== GATE A: open real COPY fixture via built plugin read path ===");
  check("fixture exists on disk", existsSync(COPY_FIXTURE), COPY_FIXTURE);
  const capability = buildMemoryCapability({ dbPath: COPY_FIXTURE });
  check("capability.runtime present", Boolean(capability.runtime));
  const got = await capability.runtime!.getMemorySearchManager({
    cfg: {} as never,
    agentId: "gate",
  });
  check("getMemorySearchManager returned a manager (no error)", Boolean(got.manager) && !got.error, got.error ?? null);
  if (!got.manager) return;
  const status = got.manager.status();
  console.log("  COPY status:", JSON.stringify(status));
  check("status.backend === builtin", status.backend === "builtin");
  check("status.provider === plureslm", status.provider === "plureslm");
  check("status.chunks is a number >= 0", typeof status.chunks === "number" && (status.chunks ?? -1) >= 0, status.chunks);
  const hits = await got.manager.search("anything", { maxResults: 3 });
  check("search() returns an array (empty ok for stale copy)", Array.isArray(hits), { count: hits.length });
}

function gateB(): void {
  console.log("\n=== GATE B: seed -> reopen cross-process -> non-empty recall (built path) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-gate-"));
  try {
    const seed = runChild(dir, "seed");
    console.log("  seed child stdout:", seed.stdout);
    if (seed.stderr) console.log("  seed child stderr:", seed.stderr);
    check("seed child exit 0", seed.status === 0);
    // NOTE: this native bootstraps a baseline of `praxis_constraint` nodes into
    // EVERY freshly-created store, so total node counts are `baseline + seeded`,
    // not exactly the seeded count. We therefore assert the seeded nodes are
    // PRESENT (total >= 3) and prove correctness via recall below, rather than
    // pinning an exact total that depends on the native's bootstrap set.
    const seedStats = seed.parsed?.stats as { totalNodes?: number } | undefined;
    const seedTotal = seedStats?.totalNodes ?? -1;
    check("seed total >= 3 (3 seeded nodes present atop native baseline)", seedTotal >= 3, seedStats);

    const read = runChild(dir, "read");
    console.log("  read child stdout:", read.stdout);
    if (read.stderr) console.log("  read child stderr:", read.stderr);
    check("read child exit 0", read.status === 0);
    check("read ok", read.parsed?.ok === true, read.parsed?.error ?? null);
    const readTotal = (read.parsed?.statusTotalNodes as number) ?? -1;
    check("status total >= 3 and stable across processes (matches seed)", readTotal >= 3 && readTotal === seedTotal, { readTotal, seedTotal });
    check("backend == builtin", read.parsed?.backend === "builtin");
    check("provider == plureslm", read.parsed?.statusProvider === "plureslm");

    const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
    check("recall NON-EMPTY", hits.length > 0, { count: hits.length });
    const top = hits[0];
    check("top hit is the correct node (mem-dec-1)", String(top?.path) === "mem-dec-1", top?.path);
    check("top snippet contains expected content", String(top?.snippet).includes("long-term memory"), top?.snippet);
    check("top source == memory", String(top?.source) === "memory");
    check("citation namespaced to plureslm", String(top?.citation).startsWith("plureslm:"), top?.citation);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The sentinel the write child ingests and the read child must recall. The
// query is a CONTIGUOUS sub-phrase of the sentinel so the native
// substring/phrase text search finds it deterministically even when the vector
// index is unavailable in the env. Kept in sync with WRITE_SENTINEL/WRITE_QUERY
// in store-child.mts (the child owns the canonical write).
const GATE_C_QUERY = "migration runbook lives in the encrypted ops vault";

function gateC(): void {
  console.log("\n=== GATE C: write (real sync()) -> reopen cross-process -> recall sentinel ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-gateC-"));
  try {
    // Phase 1: ingest the sentinel via the SHIPPED write path (manager.sync()).
    const write = runChild(dir, "write");
    console.log("  write child stdout:", write.stdout);
    if (write.stderr) console.log("  write child stderr:", write.stderr);
    check("write child exit 0", write.status === 0);
    check("write ok", write.parsed?.ok === true, write.parsed?.error ?? null);
    const before = (write.parsed?.beforeTotalNodes as number) ?? -1;
    const after = (write.parsed?.afterTotalNodes as number) ?? -1;
    const delta = (write.parsed?.delta as number) ?? -999;
    // The real write path must have added at least one node for the sentinel
    // chunk (delta >= 1) and reported progress at least once.
    check("sync() wrote >= 1 node (delta)", delta >= 1, { before, after, delta });
    check("sync() invoked progress callback", (write.parsed?.progressCalls as number) >= 1, write.parsed?.progressCalls);
    check("after total > 0", after > 0, after);

    // Phase 2: reopen in a FRESH process (lock released) and recall the sentinel.
    const read = runChild(dir, "read", GATE_C_QUERY);
    console.log("  read child stdout:", read.stdout);
    if (read.stderr) console.log("  read child stderr:", read.stderr);
    check("read child exit 0", read.status === 0);
    check("read ok", read.parsed?.ok === true, read.parsed?.error ?? null);
    const readTotal = (read.parsed?.statusTotalNodes as number) ?? -1;
    check("stats().totalNodes > 0 after write", readTotal > 0, readTotal);
    // Durability: the reopened store sees the node the write child committed.
    check("reopened total == post-write total (durable across processes)", readTotal === after, { readTotal, after });

    const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
    // The round-trip proof: the sentinel content comes back from recall(). We
    // tolerate vector OR text retrieval (the brief: if embeddings are
    // unavailable in the env, text recall must still surface it).
    check("recall NON-EMPTY for sentinel query", hits.length > 0, { count: hits.length, query: GATE_C_QUERY });
    const sentinelHit = hits.find((h) => String(h.snippet).includes("ZQX7731SENTINEL"));
    check("sentinel content recalled (by vector or text)", Boolean(sentinelHit), sentinelHit?.snippet ?? hits[0]?.snippet);
    check("sentinel hit has a sane score (> 0)", Number(sentinelHit?.score) > 0, sentinelHit?.score);
    check("sentinel hit id is a session node (mem:session:...)", String(sentinelHit?.path).startsWith("mem:session:"), sentinelHit?.path);
    check("sentinel hit source == sessions", String(sentinelHit?.source) === "sessions", sentinelHit?.source);
    check("sentinel hit retrieved via vector or text", sentinelHit?.via === "vector" || sentinelHit?.via === "text", sentinelHit?.via);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateD(): void {
  console.log("\n=== GATE D: associative graph recall (sync() link-on-write + search() graph expansion) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-gateD-"));
  try {
    // Phase 1 (own process): write 3 same-session files + ingest via the
    // SHIPPED sync() path (forms category+temporal edges via link-on-write),
    // then confirm the disjoint sibling is a real graph neighbor of the seed.
    const link = runAssocChild(dir, "link");
    console.log("  link child stdout:", link.stdout);
    if (link.stderr) console.log("  link child stderr:", link.stderr);
    check("link child exit 0", link.status === 0);
    check("link ok", link.parsed?.ok === true, link.parsed?.error ?? null);
    const seedId = String(link.parsed?.seedId ?? "");
    const betaId = String(link.parsed?.siblingId ?? "");
    // Edges really formed via the shipped path: the disjoint BETA is a neighbor
    // of the on-topic ALPHA seed (this is the structural fact the win relies on).
    check("link-on-write formed >= 1 edge (advisory count)", Number(link.parsed?.edgeCount) >= 1, link.parsed?.edgeCount);
    check("disjoint sibling (beta) IS a graph neighbor of the seed (alpha)", link.parsed?.betaIsNeighbor === true, link.parsed?.alphaNeighborIds ?? null);

    // Phase 2 (FRESH process, strict threshold): ASSOCIATIVE WIN. The disjoint
    // BETA can only arrive via graph expansion of the ALPHA direct hit.
    const strict = runAssocChild(dir, "read-strict");
    console.log("  read-strict child stdout:", strict.stdout);
    if (strict.stderr) console.log("  read-strict child stderr:", strict.stderr);
    check("read-strict child exit 0", strict.status === 0);
    check("read-strict ok", strict.parsed?.ok === true, strict.parsed?.error ?? null);
    const sRanked = (strict.parsed?.ranked as RankedHit[]) ?? [];
    check("strict recall NON-EMPTY", sRanked.length > 0, { count: sRanked.length });
    // The on-topic ALPHA must be a DIRECT hit (vector/text), never graph.
    const sAlpha = sRanked.find((h) => h.path === seedId);
    check("strict: on-topic alpha present as a DIRECT hit", Boolean(sAlpha) && sAlpha!.via !== "graph", sAlpha ?? null);
    // BETA is disjoint + below the 0.80 threshold => it can ONLY be a graph hit.
    const sBeta = sRanked.find((h) => h.path === betaId);
    check("ASSOCIATIVE WIN: disjoint beta surfaced under strict threshold", Boolean(sBeta), { betaId, ranked: sRanked.map((h) => h.path) });
    check("ASSOCIATIVE WIN: beta arrived via:\"graph\"", sBeta?.via === "graph", sBeta ?? null);
    check("ASSOCIATIVE WIN: beta citation contains \"graph\"", Boolean(sBeta?.citation?.includes("graph")), sBeta?.citation ?? null);
    // Provenance honesty: the graph hit was seeded from the alpha direct hit.
    check("ASSOCIATIVE WIN: beta seeded from the alpha direct hit", sBeta?.seedId === seedId, { seedId, betaSeed: sBeta?.seedId ?? null });
    // Graph hits NEVER outrank the direct hit that seeded them (precision).
    if (sBeta && sAlpha) {
      check("strict: graph beta ranks strictly BELOW its seed alpha", sBeta.rank > sAlpha.rank, { alphaRank: sAlpha.rank, betaRank: sBeta.rank });
    }

    // Phase 3 (FRESH process, DEFAULT threshold): PRECISION GUARDRAIL. The
    // on-topic GAMMA query must keep its direct top-1; graph hits only ever
    // appear at lower rank than the direct hit that seeded them.
    const def = runAssocChild(dir, "read-default");
    console.log("  read-default child stdout:", def.stdout);
    if (def.stderr) console.log("  read-default child stderr:", def.stderr);
    check("read-default child exit 0", def.status === 0);
    check("read-default ok", def.parsed?.ok === true, def.parsed?.error ?? null);
    const dRanked = (def.parsed?.ranked as RankedHit[]) ?? [];
    const gammaId = String((def.parsed?.ids as Record<string, string> | undefined)?.gamma ?? "");
    check("default recall NON-EMPTY", dRanked.length > 0, { count: dRanked.length });
    const dTop = dRanked[0];
    // GUARDRAIL #1: the expected on-topic node is top-1 and is a DIRECT hit.
    check("PRECISION GUARDRAIL: top-1 is the expected direct node (gamma)", dTop?.path === gammaId, { top: dTop?.path, expected: gammaId });
    check("PRECISION GUARDRAIL: top-1 is a DIRECT hit (not graph)", dTop?.via !== "graph", dTop ?? null);
    // GUARDRAIL #2: every graph hit ranks strictly below the direct hit that
    // seeded it (graph expansion is append-only at the tail; it never displaces
    // or reorders ahead of a direct hit). A failure here is a REAL precision
    // regression, not something to paper over.
    const rankOf = new Map(dRanked.map((h) => [h.path, h.rank] as const));
    let guardrailHeld = true;
    for (const h of dRanked) {
      if (h.via !== "graph") continue;
      const seedRank = h.seedId !== null ? rankOf.get(h.seedId) : undefined;
      // The seed of every graph hit must be a direct hit present ABOVE it.
      const ok = seedRank !== undefined && seedRank < h.rank;
      if (!ok) guardrailHeld = false;
      check(
        `PRECISION GUARDRAIL: graph hit ${h.path} ranks below its seed ${h.seedId}`,
        ok,
        { graphRank: h.rank, seedId: h.seedId, seedRank: seedRank ?? null },
      );
    }
    // Also assert no graph hit ever sits at rank 0 (top-1 is always direct).
    const graphAtTop = dRanked.some((h) => h.via === "graph" && h.rank === 0);
    check("PRECISION GUARDRAIL: no graph hit occupies top-1", !graphAtTop, { graphAtTop });
    check("PRECISION GUARDRAIL: held for every graph hit", guardrailHeld, { ranked: dRanked });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw TEST GATE (standalone tsx, against dist/ build)");
  await gateA();
  gateB();
  gateC();
  gateD();
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
