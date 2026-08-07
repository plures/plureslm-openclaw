/**
 * Child worker for the Dreaming gate. Own process per phase (PluresDB
 * exclusive lock). All phases drive the BUILT artifact (../dist/api.js) so
 * the gate exercises exactly what ships.
 *
 * Phases:
 *  ingest         : sync() two real session files, then dreamIngest() and
 *                   print the raw candidate node it staged (real content,
 *                   real originHash, real firstSeen/lastSeen epochs).
 *  ingest-dedup   : call dreamIngest() TWICE against the same synced session
 *                   files; prove the second run adds 0 new candidates
 *                   (content-hash dedup, not a re-stage).
 *  score-promote  : sync() + dreamIngest(), record enough dreamRecordRecall()
 *                   hits and run dreamScore() across enough ticks to cross
 *                   the real minPromoteScore/minRecallCount/ticksAboveThreshold
 *                   gates, then assert the promoted node is readable through
 *                   the normal capability search path (memory category).
 *  explain        : after staging + one score tick (not yet promoted), call
 *                   dreamExplain() on the real candidate id and print the
 *                   full explain payload so the parent can assert every
 *                   number ties to the real signals just computed.
 *  status         : call dreamStatus() before and after dreamScheduleTimers()
 *                   + dreamTick(), printing both so the parent can assert
 *                   nextEligibleAt goes from null to a real ISO timestamp.
 *  search-exclude : sync() a session file, dreamIngest() to stage it as a
 *                   candidate (NOT promoted), then run a normal memory_search
 *                   via createPluresLmSearchManager and assert the staged
 *                   candidate id never appears in results.
 *
 * Usage: tsx test/dreaming-child.mts <dir> <phase>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPluresLmSearchManager,
  PluresLmStore,
  dreamIngest,
  dreamScore,
  dreamRecordRecall,
  dreamExplain,
  dreamStatus,
  dreamScheduleTimers,
  dreamTick,
  isStagedCandidateId,
  DEFAULT_DREAMING_CONFIG,
  type DreamingConfig,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";

// Real cfg: enabled, aggressive thresholds so we can cross gates deterministically
// in a short test run without waiting on real wall-clock intervals.
const CFG: DreamingConfig = {
  ...DEFAULT_DREAMING_CONFIG,
  enabled: true,
  score: { intervalSecs: 900, minScore: 0.05, minRecallCount: 2, minPromoteScore: 0.05 },
};

const SENTINEL = "DREAM7700 the octopus migration plan";

function seedSession(d: string, name: string, text: string): string {
  const f = join(d, name);
  writeFileSync(f, `# ${name}\n\n${text}\n`, "utf8");
  return f;
}

if (!dir || !["ingest", "ingest-dedup", "score-promote", "explain", "status", "search-exclude"].includes(phase)) {
  console.error("usage: tsx test/dreaming-child.mts <dir> <phase>");
  process.exit(2);
}

async function seedAndSync(): Promise<{ store: PluresLmStore; manager: ReturnType<typeof createPluresLmSearchManager>["manager"] }> {
  const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
  const fileA = seedSession(dir, "dream-a.md", `${SENTINEL} note alpha about octopus migration step one.`);
  const fileB = seedSession(dir, "dream-b.md", "BETA unrelated note about kraken deploy runbook.");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileA, fileB] });
  return { store, manager };
}

if (phase === "ingest") {
  (async () => {
    const { store } = await seedAndSync();
    const result = dreamIngest(store, CFG);
    const candidates = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: "learning_candidates" } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(candidates?.nodes) ? candidates.nodes : [];
    process.stdout.write(
      JSON.stringify({
        phase: "ingest",
        ok: true,
        result,
        candidateIds: rows.map((r) => r.id),
        candidates: rows.map((r) => r.data),
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "ingest", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "ingest-dedup") {
  (async () => {
    const { store } = await seedAndSync();
    const run1 = dreamIngest(store, CFG);
    const run2 = dreamIngest(store, CFG);
    process.stdout.write(JSON.stringify({ phase: "ingest-dedup", ok: true, run1, run2 }) + "\n");
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "ingest-dedup", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "score-promote") {
  (async () => {
    const { store } = await seedAndSync();
    dreamIngest(store, CFG);
    const candidates = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: "learning_candidates" } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(candidates?.nodes) ? candidates.nodes : [];
    const targetId = String(rows[0]?.id ?? "");
    const targetOrigin = targetId.replace(/^dream:candidate:/, "");

    // Real recall signal: record enough recalls to clear minRecallCount.
    dreamRecordRecall(store, targetOrigin);
    dreamRecordRecall(store, targetOrigin);
    dreamRecordRecall(store, targetOrigin);

    // Real multi-tick scoring: run dreamScore() repeatedly (ticksAboveThreshold
    // must reach >=2 on independent ticks per the real compound gate).
    const scoreRuns = [];
    for (let i = 0; i < 4; i++) {
      scoreRuns.push(dreamScore(store, CFG));
    }

    const finalCandidate = store.get(targetId) as Record<string, unknown> | null;
    const promotedMemoryNode = store.get(targetOrigin) as Record<string, unknown> | null;

    process.stdout.write(
      JSON.stringify({
        phase: "score-promote",
        ok: true,
        targetId,
        targetOrigin,
        scoreRuns,
        finalCandidateStage: finalCandidate?.stage ?? null,
        finalCandidateScore: finalCandidate?.score ?? null,
        promotedMemoryNodePresent: Boolean(promotedMemoryNode),
        promotedMemoryNodeCategory: promotedMemoryNode?.category ?? null,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "score-promote", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "explain") {
  (async () => {
    const { store } = await seedAndSync();
    dreamIngest(store, CFG);
    const candidates = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: "learning_candidates" } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(candidates?.nodes) ? candidates.nodes : [];
    const targetId = String(rows[0]?.id ?? "");
    const targetOrigin = targetId.replace(/^dream:candidate:/, "");

    dreamRecordRecall(store, targetOrigin);
    dreamScore(store, CFG); // one tick only -> not yet promoted

    const rawAfterOneTick = store.get(targetId) as Record<string, unknown> | null;
    const explainResult = dreamExplain(store, targetId, CFG);
    const explainByOriginId = dreamExplain(store, targetOrigin, CFG);
    const explainMissing = dreamExplain(store, "dream:candidate:does-not-exist", CFG);

    process.stdout.write(
      JSON.stringify({
        phase: "explain",
        ok: true,
        targetId,
        rawScore: rawAfterOneTick?.score ?? null,
        rawSignals: rawAfterOneTick?.signals ?? null,
        rawTicksAboveThreshold: rawAfterOneTick?.ticksAboveThreshold ?? null,
        explainResult,
        explainByOriginIdSameId: explainByOriginId && "found" in explainByOriginId ? explainByOriginId.id === explainResult.id : false,
        explainMissingFound: explainMissing.found,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "explain", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "status") {
  (async () => {
    const { store } = await seedAndSync();
    const statusBefore = dreamStatus(store, CFG);
    const timers = dreamScheduleTimers(store, CFG);
    dreamIngest(store, CFG);
    dreamTick(store, CFG);
    const statusAfter = dreamStatus(store, CFG);

    process.stdout.write(
      JSON.stringify({ phase: "status", ok: true, statusBefore, timers, statusAfter }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "status", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "search-exclude") {
  (async () => {
    const { store, manager } = await seedAndSync();
    dreamIngest(store, CFG); // stages candidates, NOT promoted (score() never called)

    const candidates = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: "learning_candidates" } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(candidates?.nodes) ? candidates.nodes : [];
    const stagedIds = rows.map((r) => String(r.id));

    const hits = await manager.search("octopus migration plan DREAM7700", { maxResults: 20 });
    const leaked = hits.filter((h) => isStagedCandidateId(h.path) || stagedIds.includes(h.path));

    process.stdout.write(
      JSON.stringify({
        phase: "search-exclude",
        ok: true,
        stagedIds,
        hitPaths: hits.map((h) => h.path),
        leakedCount: leaked.length,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "search-exclude", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}
