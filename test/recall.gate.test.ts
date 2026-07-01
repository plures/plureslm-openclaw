/**
 * TEST GATE (C-TEST-001): exercise the CORE read path of the plugin against a
 * real PluresDB store — not a mock, not a stub.
 *
 * Two assertions:
 *
 *  A. COMPATIBILITY: open the provided COPY fixture through the real plugin
 *     read path (buildMemoryCapability -> getMemorySearchManager -> status).
 *     The fixture is a stale March copy and is EMPTY for this native
 *     (totalNodes === 0), so we assert it OPENS cleanly and status() works,
 *     proving the read path is wired to a real on-disk store. (Documented
 *     deviation: the fixture holds no recallable nodes — see milestones.)
 *
 *  B. RECALL: seed a known store (child process), reopen it in a fresh child
 *     process through the same plugin read path, and assert recall returns the
 *     correct NON-EMPTY hit and that the reported node count matches what was
 *     seeded. This is the deterministic, non-empty recall proof.
 *
 * Cross-process children are required because the native takes an EXCLUSIVE
 * file lock per store directory.
 *
 *  D. ASSOCIATIVE GRAPH RECALL: through the SHIPPED capability (sync()
 *     link-on-write + search() graph expansion), assert BOTH (a) the
 *     ASSOCIATIVE WIN — a node whose content is disjoint from the query (below
 *     a strict threshold, so NOT a direct vector/text hit) is still surfaced via
 *     graph expansion (citation contains "graph", via:"graph"), durable across a
 *     fresh process — and (b) the PRECISION GUARDRAIL — with the DEFAULT
 *     threshold the on-topic direct hit ranks FIRST and every graph hit ranks
 *     strictly BELOW the direct hit that seeded it (graph hits are appended
 *     after direct hits and never displace top-1). Uses the cross-process child
 *     test/assoc-child.mts. Real shipped path only (C-TEST-002).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

import { buildMemoryCapability } from "../dist/api.js";
import { PluresLmStore } from "../dist/pluresdb.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "store-child.mts");
const ASSOC_CHILD = join(here, "assoc-child.mts");
// Spawn tsx via the Node CLI entry (not the .bin/.cmd shim) so spawnSync works
// cross-platform without a shell. The .cmd shim cannot be spawned directly on
// Windows (spawnSync returns status=null / ENOENT).
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const COPY_FIXTURE =
  "C:/Users/kbristol/.openclaw/workspace/.tmp/plureslm-store-copy-20260626";

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
  // Surface spawn-level failures (status null) with the underlying error so the
  // assertion message is actionable instead of a bare "expected null to be 0".
  const spawnError = res.error ? String((res.error as Error).message ?? res.error) : "";
  return { res, stdout, stderr: ((res.stderr ?? "").trim() + (spawnError ? ` | spawnError=${spawnError}` : "")).trim(), parsed };
}

type RankedHit = {
  rank: number;
  path: string;
  score: number;
  citation: string | null;
  via: "vector" | "text" | "graph";
  seedId: string | null;
};

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
  const spawnError = res.error ? String((res.error as Error).message ?? res.error) : "";
  return { res, stdout, stderr: ((res.stderr ?? "").trim() + (spawnError ? ` | spawnError=${spawnError}` : "")).trim(), parsed };
}

describe("plureslm read-path memory capability", () => {
  it("A. opens the real COPY fixture through the plugin read path (compatibility)", async () => {
    expect(existsSync(COPY_FIXTURE)).toBe(true);
    PluresLmStore._resetForTests(COPY_FIXTURE);

    const capability = buildMemoryCapability({ dbPath: COPY_FIXTURE });
    expect(capability.runtime).toBeTruthy();

    const { manager, error } = await capability.runtime!.getMemorySearchManager({
      cfg: {} as never,
      agentId: "gate",
    });
    expect(error, `getMemorySearchManager error: ${error ?? ""}`).toBeUndefined();
    expect(manager).toBeTruthy();

    const status = manager!.status();
    console.log("[GATE A] COPY fixture status:", JSON.stringify(status));
    expect(status.backend).toBe("builtin");
    expect(status.provider).toBe("plureslm");
    // The stale copy is empty for this native; assert it opened and is queryable.
    expect(typeof status.chunks).toBe("number");
    expect(status.chunks).toBeGreaterThanOrEqual(0);

    // A query against the (empty) copy must not throw; it returns [].
    const hits = await manager!.search("anything", { maxResults: 3 });
    console.log("[GATE A] COPY fixture recall count:", hits.length);
    expect(Array.isArray(hits)).toBe(true);

    PluresLmStore._resetForTests(COPY_FIXTURE);
  });

  it("B. seeds then recalls a known store cross-process (non-empty recall + count stable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plureslm-gate-"));
    try {
      // Phase 1: seed (own process).
      const seed = runChild(dir, "seed");
      console.log("[GATE B] seed stdout:", seed.stdout);
      expect(seed.res.status, `seed exit; stderr=${seed.stderr}`).toBe(0);
      expect(seed.parsed?.phase).toBe("seed");
      // This native bootstraps a baseline of `praxis_constraint` nodes into
      // every fresh store, so totals are `baseline + seeded`. Assert the 3
      // seeded nodes are PRESENT (>= 3) and prove correctness via recall, rather
      // than pinning an exact total that depends on the native bootstrap set.
      const seedStats = seed.parsed?.stats as { totalNodes?: number } | undefined;
      const seedTotal = seedStats?.totalNodes ?? -1;
      expect(seedTotal).toBeGreaterThanOrEqual(3);

      // Phase 2: read through the real plugin path (fresh process).
      const read = runChild(dir, "read");
      console.log("[GATE B] read stdout:", read.stdout);
      expect(read.res.status, `read exit; stderr=${read.stderr}`).toBe(0);
      expect(read.parsed?.ok, `read error: ${read.parsed?.error ?? ""}`).toBe(true);

      // Count consistency: status total is >= 3 and stable across processes.
      const readTotal = read.parsed?.statusTotalNodes as number;
      expect(readTotal).toBeGreaterThanOrEqual(3);
      expect(readTotal).toBe(seedTotal);
      expect(read.parsed?.backend).toBe("builtin");
      expect(read.parsed?.statusProvider).toBe("plureslm");

      // Non-empty, correct-looking recall.
      const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
      expect(hits.length).toBeGreaterThan(0);
      const top = hits[0]!;
      expect(String(top.path)).toBe("mem-dec-1");
      expect(String(top.snippet)).toContain("long-term memory");
      expect(String(top.source)).toBe("memory");
      expect(String(top.citation)).toContain("plureslm:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C. ingests a sentinel via the SHIPPED write path (sync()) then recalls it cross-process", () => {
    const SENTINEL = "ZQX7731SENTINEL";
    const QUERY = "migration runbook lives in the encrypted ops vault";
    const dir = mkdtempSync(join(tmpdir(), "plureslm-gateC-"));
    try {
      // Phase 1: ingest via buildMemoryCapability -> getMemorySearchManager ->
      // manager.sync() (the REAL write path, NOT seedStoreForTests).
      const write = runChild(dir, "write");
      console.log("[GATE C] write stdout:", write.stdout);
      expect(write.res.status, `write exit; stderr=${write.stderr}`).toBe(0);
      expect(write.parsed?.ok, `write error: ${write.parsed?.error ?? ""}`).toBe(true);
      const delta = write.parsed?.delta as number;
      const after = write.parsed?.afterTotalNodes as number;
      expect(delta).toBeGreaterThanOrEqual(1); // sync() actually wrote a node
      expect(write.parsed?.progressCalls as number).toBeGreaterThanOrEqual(1);
      expect(after).toBeGreaterThan(0);

      // Phase 2: reopen in a fresh process (lock released) and recall sentinel.
      const read = runChild(dir, "read", QUERY);
      console.log("[GATE C] read stdout:", read.stdout);
      expect(read.res.status, `read exit; stderr=${read.stderr}`).toBe(0);
      expect(read.parsed?.ok, `read error: ${read.parsed?.error ?? ""}`).toBe(true);
      const readTotal = read.parsed?.statusTotalNodes as number;
      expect(readTotal).toBeGreaterThan(0);
      expect(readTotal).toBe(after); // durable across the process/lock boundary

      const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
      expect(hits.length).toBeGreaterThan(0);
      const sentinelHit = hits.find((h) => String(h.snippet).includes(SENTINEL));
      expect(sentinelHit, `sentinel not recalled; hits=${JSON.stringify(hits)}`).toBeTruthy();
      expect(Number(sentinelHit!.score)).toBeGreaterThan(0);
      expect(String(sentinelHit!.path)).toContain("mem:session:");
      expect(String(sentinelHit!.source)).toBe("sessions");
      // Tolerate vector OR text retrieval (embeddings may be unavailable in env).
      expect(["vector", "text"]).toContain(String(sentinelHit!.via));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D. associative graph recall: associative WIN + precision GUARDRAIL via the shipped path", () => {
    const dir = mkdtempSync(join(tmpdir(), "plureslm-gateD-"));
    try {
      // Phase 1 (own process): write 3 same-session files + ingest via sync()
      // (link-on-write forms category+temporal edges), then confirm the disjoint
      // sibling is a real graph neighbor of the on-topic seed.
      const link = runAssocChild(dir, "link");
      console.log("[GATE D] link stdout:", link.stdout);
      expect(link.res.status, `link exit; stderr=${link.stderr}`).toBe(0);
      expect(link.parsed?.ok, `link error: ${link.parsed?.error ?? ""}`).toBe(true);
      const seedId = String(link.parsed?.seedId ?? "");
      const betaId = String(link.parsed?.siblingId ?? "");
      // Edges really formed via the shipped path: the disjoint BETA is a neighbor
      // of the on-topic ALPHA seed (the structural fact the win relies on).
      expect(Number(link.parsed?.edgeCount)).toBeGreaterThanOrEqual(1);
      expect(link.parsed?.betaIsNeighbor, `alpha neighbors=${JSON.stringify(link.parsed?.alphaNeighborIds)}`).toBe(true);

      // Phase 2 (FRESH process, strict threshold): ASSOCIATIVE WIN. The disjoint
      // BETA can only arrive via graph expansion of the ALPHA direct hit.
      const strict = runAssocChild(dir, "read-strict");
      console.log("[GATE D] read-strict stdout:", strict.stdout);
      expect(strict.res.status, `read-strict exit; stderr=${strict.stderr}`).toBe(0);
      expect(strict.parsed?.ok, `read-strict error: ${strict.parsed?.error ?? ""}`).toBe(true);
      const sRanked = (strict.parsed?.ranked as RankedHit[]) ?? [];
      expect(sRanked.length).toBeGreaterThan(0);
      // ALPHA (on-topic) must be a DIRECT hit, never graph.
      const sAlpha = sRanked.find((h) => h.path === seedId);
      expect(sAlpha, `alpha missing; ranked=${JSON.stringify(sRanked)}`).toBeTruthy();
      expect(sAlpha!.via).not.toBe("graph");
      // BETA is disjoint + below the strict threshold => graph-only.
      const sBeta = sRanked.find((h) => h.path === betaId);
      expect(sBeta, `ASSOCIATIVE WIN failed: beta not surfaced; ranked=${JSON.stringify(sRanked.map((h) => h.path))}`).toBeTruthy();
      expect(sBeta!.via).toBe("graph");
      expect(String(sBeta!.citation)).toContain("graph");
      expect(sBeta!.seedId).toBe(seedId);
      // Graph hits NEVER outrank the direct hit that seeded them.
      expect(sBeta!.rank).toBeGreaterThan(sAlpha!.rank);

      // Phase 3 (FRESH process, DEFAULT threshold): PRECISION GUARDRAIL. The
      // on-topic query keeps its direct top-1; graph hits only appear at lower
      // rank than the direct hit that seeded them.
      const def = runAssocChild(dir, "read-default");
      console.log("[GATE D] read-default stdout:", def.stdout);
      expect(def.res.status, `read-default exit; stderr=${def.stderr}`).toBe(0);
      expect(def.parsed?.ok, `read-default error: ${def.parsed?.error ?? ""}`).toBe(true);
      const dRanked = (def.parsed?.ranked as RankedHit[]) ?? [];
      const gammaId = String((def.parsed?.ids as Record<string, string> | undefined)?.gamma ?? "");
      expect(dRanked.length).toBeGreaterThan(0);
      const dTop = dRanked[0]!;
      // GUARDRAIL #1: the expected on-topic node is top-1 and is a DIRECT hit.
      expect(dTop.path, `top-1=${dTop.path} expected=${gammaId}; ranked=${JSON.stringify(dRanked)}`).toBe(gammaId);
      expect(dTop.via).not.toBe("graph");
      // GUARDRAIL #2: every graph hit ranks strictly below the direct hit that
      // seeded it (append-only at the tail). A failure here is a REAL precision
      // regression, not something to paper over.
      const rankOf = new Map(dRanked.map((h) => [h.path, h.rank] as const));
      for (const h of dRanked) {
        if (h.via !== "graph") continue;
        const seedRank = h.seedId !== null ? rankOf.get(h.seedId) : undefined;
        expect(seedRank, `graph hit ${h.path} seed ${h.seedId} not present as a direct hit above it`).not.toBeUndefined();
        expect(h.rank, `graph hit ${h.path} (rank ${h.rank}) did not rank below its seed ${h.seedId} (rank ${seedRank})`).toBeGreaterThan(seedRank!);
      }
      // No graph hit ever sits at top-1.
      expect(dRanked.some((h) => h.via === "graph" && h.rank === 0)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * HARDENED P3+P4 GATE (vitest mirror). The full adversarial logic lives in the
 * standalone runner `test/p3p4-hardened.gate.mts` (18-shape redaction matrix +
 * TP/FP/TN/FN confusion matrix, governed-write FAIL-CLOSED, P3 consolidation
 * idempotency/durability/best-effort). This mirror runs that runner as a child
 * and asserts it exits 0 with a clean confusion matrix (TP=11 FP=0 TN=7 FN=0,
 * 0 leaks) so `vitest run` covers the same security guarantees as `pnpm test`.
 * Reuses the cross-process child pattern (the native takes an exclusive lock).
 */
describe("hardened P3+P4 gate (adversarial redaction matrix + consolidation idempotency)", () => {
  const HARDENED_RUNNER = join(here, "p3p4-hardened.gate.mts");

  it("blocks 11/11 secret shapes, 0 false-positives, fails closed, and consolidation is idempotent+durable", () => {
    const res = spawnSync(process.execPath, [TSX_CLI, HARDENED_RUNNER], {
      encoding: "utf8",
      timeout: 240_000,
    });
    const out = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
    // The runner self-asserts every check and exits non-zero on ANY failure.
    expect(res.status, `hardened gate runner failed; tail=\n${out.slice(-1600)}`).toBe(0);
    expect(out).toContain("HARDENED RESULT: ALL CHECKS PASSED");
    // Pin the security-critical confusion matrix explicitly (100% block / 0 FN / 0 FP).
    expect(out, "confusion matrix not clean").toContain("CONFUSION MATRIX (detection): TP=11 FP=0 TN=7 FN=0");
    expect(out, "a secret leaked into recall").toContain("secretLeaks=0");
  });
});

/**
 * P3+P4 QA REGRESSION GATE (vitest mirror). The full QA logic lives in the
 * standalone runner `test/p3p4-qa.gate.mts` and pins the defects the QA stage
 * found and fixed: the SECONDARY-FIELD secret leak (a live token hidden in
 * `value`/`body`/`note`/an arbitrary content field used to be written then
 * recalled — now refused), the NON-WEAKENING proof (a clean node carrying an
 * id-shaped `hash` is still written; every secret shape still flags), the
 * chunk-boundary contract (full-in-one refused; split never reassembled by
 * recall), and consolidate-at-scale idempotency/durability. This mirror runs
 * that runner as a child and asserts exit 0 so `vitest run` covers the same
 * regression guarantees as `pnpm test`.
 */
describe("P3+P4 QA regression gate (secondary-field leak fix + non-weakening + scale)", () => {
  const QA_RUNNER = join(here, "p3p4-qa.gate.mts");

  it("refuses secrets in secondary content fields, does not over-block clean payloads, and stays idempotent at scale", () => {
    const res = spawnSync(process.execPath, [TSX_CLI, QA_RUNNER], {
      encoding: "utf8",
      timeout: 240_000,
    });
    const out = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
    expect(res.status, `QA regression gate runner failed; tail=\n${out.slice(-1600)}`).toBe(0);
    expect(out).toContain("QA REGRESSION RESULT: ALL CHECKS PASSED");
    // Pin the safety-critical claims explicitly.
    expect(out, "secondary-field secret not refused").toContain("QA-1 secret-in-value: REFUSED");
    expect(out, "clean id-shaped-hash node was over-blocked").toContain("QA-2 clean node WITH id-shaped hash: WRITTEN");
    expect(out, "split secret was reassembled by recall").toContain("QA-3 PINNED: split secret NEVER reassembled");
  });
});

/**
 * P3+P4 VERIFY GATE (vitest mirror) — the FINAL gate, loop-closer. The full
 * end-to-end consumer-boundary proof lives in `test/p3p4-verify.driver.mts`:
 * it drives the SHIPPED MemorySearchManager (buildMemoryCapability ->
 * getMemorySearchManager -> sync()/search()) channel-agnostically (C-TEST-002)
 * and proves, each reproduced across a FRESH process, (1) C-MEM-REDACT blocks a
 * realistic batch end-to-end — credential chunks (content + a SECONDARY field +
 * multiline PEM + AWS 40-char) are NEVER recalled and the raw secret NEVER
 * appears in any snippet, while the clean memory IS recalled; (2) consolidation
 * is bounded + idempotent + durable across a process restart with observable
 * associative recall. This mirror runs that driver as a child and asserts exit 0
 * so `vitest run` covers the same end-to-end guarantees as `pnpm test`.
 */
describe("P3+P4 VERIFY gate (C-MEM-REDACT end-to-end never-recalled + consolidation durable across restart)", () => {
  const VERIFY_RUNNER = join(here, "p3p4-verify.driver.mts");

  it("never recalls a secret (incl. the secondary-field case) and keeps the consolidation checkpoint durable across a fresh process", () => {
    const res = spawnSync(process.execPath, [TSX_CLI, VERIFY_RUNNER], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
    expect(res.status, `VERIFY driver failed; tail=\n${out.slice(-1800)}`).toBe(0);
    expect(out).toContain("P3+P4 VERIFY RESULT: ALL CHECKS PASSED");
    // Pin the headline safety/value claims explicitly.
    expect(out, "secondary-field secret was recalled").toContain("PROOF1 secret-in-secondary-field(value): credential node NEVER recalled");
    expect(out, "a raw secret surfaced in a snippet").toContain("PROOF1 NO raw secret in ANY snippet of a broad query");
    expect(out, "clean memory was not recalled").toContain("PROOF1 clean memory IS recalled");
    expect(out, "consolidation checkpoint not durable across restart").toContain("PROOF2 checkpoint DURABLE across reopen");
  });
});
