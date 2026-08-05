/**
 * DREAMING TEST GATE (standalone tsx, against the dist/ build).
 *
 * Proves ADR-0005 §3.1-3.6 Ingest/Score/Promote/Explain/Status end-to-end
 * through the SHIPPED path, across the PluresDB exclusive-lock (child)
 * boundary, following the same convention as test/p3p4.gate.mts.
 *
 *  GATE INGEST: dreamIngest() stages real `learning_candidates` nodes from
 *    real synced session content (not fabricated); re-running ingest against
 *    unchanged content dedupes (0 new candidates the second time).
 *
 *  GATE SCORE/PROMOTE: recording real recalls + running dreamScore() across
 *    multiple ticks crosses the real compound gate (score, recallCount,
 *    ticksAboveThreshold>=2) and migrates the candidate into the durable
 *    `memory` category, per the promotion contract.
 *
 *  GATE EXPLAIN: dreamExplain() ties every returned number to the actual
 *    persisted candidate signals/score/ticksAboveThreshold computed by the
 *    real dreamScore() tick just run - never templated. Also resolves by
 *    origin id and reports {found:false} honestly for a missing id.
 *
 *  GATE STATUS: dreamStatus()'s nextEligibleAt goes from null (no timers
 *    scheduled yet) to a real computed timestamp string once
 *    dreamScheduleTimers() has run - not hardcoded.
 *
 *  GATE SEARCH-EXCLUDE: staged (not yet promoted) `learning_candidates` never
 *    appear in a normal memory_search() result set.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "dreaming-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: string) {
  const args = [TSX_CLI, CHILD, dir, phase];
  const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180_000 });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(lastLine); } catch { parsed = null; }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

function gateIngest(): void {
  console.log("\n=== GATE INGEST: dreamIngest() stages real candidates from real session content ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-dream-ingest-"));
  try {
    const r = runChild(dir, "ingest");
    console.log("  ingest stdout:", r.stdout);
    if (r.stderr) console.log("  ingest stderr:", r.stderr);
    check("ingest child exit 0", r.status === 0);
    check("ingest ok", r.parsed?.ok === true, r.parsed?.error ?? null);

    const result = (r.parsed?.result ?? {}) as { ran?: boolean; scanned?: number; newCandidates?: number };
    check("ingest ran (enabled cfg)", result.ran === true, result);
    check("ingest scanned real session nodes (>=2)", (result.scanned ?? 0) >= 2, result.scanned);
    check("ingest staged >=1 new real candidate", (result.newCandidates ?? 0) >= 1, result.newCandidates);

    const candidateIds = (r.parsed?.candidateIds as string[]) ?? [];
    check("candidate ids follow dream:candidate: prefix", candidateIds.every((id) => id.startsWith("dream:candidate:")), candidateIds);
    const candidates = (r.parsed?.candidates as Array<Record<string, unknown>>) ?? [];
    check("staged candidate carries real snippet text (not empty)", candidates.length > 0 && typeof candidates[0]?.snippet === "string" && (candidates[0].snippet as string).length > 0, candidates[0]?.snippet);
    check("staged candidate stage is 'ingested' before any score tick", candidates.every((c) => c.stage === "ingested"), candidates.map((c) => c.stage));

    const dedupDir = mkdtempSync(join(tmpdir(), "plureslm-dream-dedup-"));
    const dedup = runChild(dedupDir, "ingest-dedup");
    console.log("  ingest-dedup stdout:", dedup.stdout);
    check("ingest-dedup child exit 0", dedup.status === 0);
    const run1 = (dedup.parsed?.run1 ?? {}) as { newCandidates?: number };
    const run2 = (dedup.parsed?.run2 ?? {}) as { newCandidates?: number };
    check("first ingest stages new candidates (>=1)", (run1.newCandidates ?? 0) >= 1, run1);
    check("DEDUP: second ingest of unchanged content stages 0 new candidates", (run2.newCandidates ?? -1) === 0, run2);
    rmSync(dedupDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateScorePromote(): void {
  console.log("\n=== GATE SCORE/PROMOTE: real recall + multi-tick score crosses the real compound gate ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-dream-promote-"));
  try {
    const r = runChild(dir, "score-promote");
    console.log("  score-promote stdout:", r.stdout);
    if (r.stderr) console.log("  score-promote stderr:", r.stderr);
    check("score-promote child exit 0", r.status === 0);
    check("score-promote ok", r.parsed?.ok === true, r.parsed?.error ?? null);

    const scoreRuns = (r.parsed?.scoreRuns as Array<{ ran?: boolean; scored?: number }>) ?? [];
    check("every score tick ran and scored the candidate", scoreRuns.length === 4 && scoreRuns.every((s) => s.ran === true && (s.scored ?? 0) >= 1), scoreRuns);

    check("final candidate stage reached 'promoted' after multi-tick gate", r.parsed?.finalCandidateStage === "promoted", r.parsed?.finalCandidateStage);
    check("final candidate score is a real positive number", typeof r.parsed?.finalCandidateScore === "number" && (r.parsed?.finalCandidateScore as number) > 0, r.parsed?.finalCandidateScore);
    check("promoted origin node migrated into durable store", r.parsed?.promotedMemoryNodePresent === true, r.parsed?.promotedMemoryNodePresent);
    check("promoted origin node landed in 'memory' category (searchable)", r.parsed?.promotedMemoryNodeCategory === "memory", r.parsed?.promotedMemoryNodeCategory);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateExplain(): void {
  console.log("\n=== GATE EXPLAIN: dreamExplain() ties every number to the real persisted candidate ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-dream-explain-"));
  try {
    const r = runChild(dir, "explain");
    console.log("  explain stdout:", r.stdout);
    if (r.stderr) console.log("  explain stderr:", r.stderr);
    check("explain child exit 0", r.status === 0);
    check("explain ok", r.parsed?.ok === true, r.parsed?.error ?? null);

    const explainResult = (r.parsed?.explainResult ?? {}) as {
      found?: boolean; score?: number; signals?: Record<string, number>; ticksAboveThreshold?: number; thresholds?: unknown[]; verdict?: string;
    };
    check("explain found the real candidate", explainResult.found === true, explainResult);
    check("explain.score matches the actual persisted score (not templated)", explainResult.score === r.parsed?.rawScore, { explain: explainResult.score, raw: r.parsed?.rawScore });
    check("explain.signals match the actual persisted signals object", JSON.stringify(explainResult.signals) === JSON.stringify(r.parsed?.rawSignals), { explain: explainResult.signals, raw: r.parsed?.rawSignals });
    check("explain.ticksAboveThreshold matches actual persisted value", explainResult.ticksAboveThreshold === r.parsed?.rawTicksAboveThreshold, { explain: explainResult.ticksAboveThreshold, raw: r.parsed?.rawTicksAboveThreshold });
    check("explain returns real threshold comparisons (>=4)", Array.isArray(explainResult.thresholds) && explainResult.thresholds.length >= 4, explainResult.thresholds);
    check("explain returns a non-empty verdict string", typeof explainResult.verdict === "string" && explainResult.verdict.length > 0, explainResult.verdict);

    check("explain resolves identically by origin id and candidate id", r.parsed?.explainByOriginIdSameId === true, r.parsed?.explainByOriginIdSameId);
    check("explain of a nonexistent id honestly reports found:false (no fabricated verdict)", r.parsed?.explainMissingFound === false, r.parsed?.explainMissingFound);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateStatus(): void {
  console.log("\n=== GATE STATUS: dreamStatus() next-eligible timestamp is computed, not hardcoded ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-dream-status-"));
  try {
    const r = runChild(dir, "status");
    console.log("  status stdout:", r.stdout);
    if (r.stderr) console.log("  status stderr:", r.stderr);
    check("status child exit 0", r.status === 0);
    check("status ok", r.parsed?.ok === true, r.parsed?.error ?? null);

    const before = (r.parsed?.statusBefore ?? {}) as { ingest?: { nextEligibleAt?: string | null }; score?: { nextEligibleAt?: string | null }; reflect?: { unavailable?: string } };
    const after = (r.parsed?.statusAfter ?? {}) as {
      ingest?: { nextEligibleAt?: string | null; scanned?: number };
      score?: { nextEligibleAt?: string | null };
      counts?: { ingestedCount?: number };
    };

    check("status before scheduling: no timer -> nextEligibleAt is null (honest absence)", before.ingest?.nextEligibleAt === null && before.score?.nextEligibleAt === null, before);
    check("reflect phase honestly reports unavailable (no LLM bridge, not a fabricated diary)", typeof before.reflect?.unavailable === "string" && before.reflect.unavailable.length > 0, before.reflect);

    check("status after scheduleTimers: ingest nextEligibleAt is a real computed timestamp", typeof after.ingest?.nextEligibleAt === "string" && (after.ingest?.nextEligibleAt as string).length > 0, after.ingest?.nextEligibleAt);
    check("status after scheduleTimers: score nextEligibleAt is a real computed timestamp", typeof after.score?.nextEligibleAt === "string" && (after.score?.nextEligibleAt as string).length > 0, after.score?.nextEligibleAt);
    check("status after dreamTick: real ingested candidate count reflects the tick that ran", (after.counts?.ingestedCount ?? 0) >= 1, after.counts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateSearchExclude(): void {
  console.log("\n=== GATE SEARCH-EXCLUDE: staged (unpromoted) candidates never leak into memory_search ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-dream-search-"));
  try {
    const r = runChild(dir, "search-exclude");
    console.log("  search-exclude stdout:", r.stdout);
    if (r.stderr) console.log("  search-exclude stderr:", r.stderr);
    check("search-exclude child exit 0", r.status === 0);
    check("search-exclude ok", r.parsed?.ok === true, r.parsed?.error ?? null);

    const stagedIds = (r.parsed?.stagedIds as string[]) ?? [];
    check("candidates were really staged (>=1) before the search", stagedIds.length >= 1, stagedIds);
    check("memory_search returns 0 leaked staged-candidate ids", r.parsed?.leakedCount === 0, { leakedCount: r.parsed?.leakedCount, stagedIds, hitPaths: r.parsed?.hitPaths });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw DREAMING GATE (standalone tsx, against dist/ build)");
  gateIngest();
  gateScorePromote();
  gateExplain();
  gateStatus();
  gateSearchExclude();
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("DREAMING GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
