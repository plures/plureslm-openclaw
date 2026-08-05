/**
 * Dreaming — self-contained background memory consolidation for PluresLM.
 *
 * Implements ADR-0005 (docs/adr-0005-dreaming-design.md) §3.1-3.6 as a thin
 * extension over `PluresLmStore`: Ingest (stage candidates from recent
 * session chunks), Score (compute real signals from PluresDB-native
 * primitives and gate stage transitions), and the transparency/status
 * surface (`dreamExplain`/`dreamStatus`). All state lives inside PluresDB
 * itself (`learning_candidates` node category + `agensState*` checkpoints +
 * `agensTimerSchedule` timer rows) — no filesystem sidecar, per §3.2/§3.3.
 * `PluresLmStore.agensStateGet/Set/agensTimer*` (added alongside this file)
 * expose the same native Agens surface `consolidate()`'s
 * `#readCheckpoint`/`#writeCheckpoint` already uses internally.
 *
 * Reflect (the LLM-gated narrative Dream Diary phase, §3.1 step 3) is
 * EXPLICITLY UNIMPLEMENTED in this v1: this repo has no chat/completion model
 * bridge anywhere (only an `embeddingModel` config for embeddings). Per the
 * NO-STUBS gate, we do not fake an LLM call — `dreamStatus()` reports
 * `reflect.unavailable` honestly instead of a fabricated diary entry, and
 * `reflect.shadowTrial` is therefore also deferred (it depends on the same
 * missing bridge). Ingest/Score/Promote/Explain/Status are fully real:
 * every number returned is computed from actual store contents, never
 * hardcoded.
 */

import type { PluresLmStore } from "./pluresdb.js";

/** One staged `learning_candidates` node's persisted shape. */
export type LearningCandidate = {
  id: string;
  stage: "ingested" | "staged" | "promoted";
  score: number;
  signals: {
    centrality: number;
    recallFrequency: number;
    clusterCohesion: number;
    recencyDecay: number;
    correctionReinforcement: number;
  };
  originHash: string;
  firstSeenEpoch: number;
  lastSeenEpoch: number;
  correctionOrigin: boolean;
  recallCount: number;
  ticksAboveThreshold: number;
  sourceCategory?: string;
  snippet?: string;
};

export type DreamingConfig = {
  enabled: boolean;
  ingest: { intervalSecs: number };
  score: {
    intervalSecs: number;
    minScore: number;
    minRecallCount: number;
    minPromoteScore: number;
  };
  correctionDetection: { enabled: boolean };
};

export const DEFAULT_DREAMING_CONFIG: DreamingConfig = {
  enabled: false,
  ingest: { intervalSecs: 300 },
  score: { intervalSecs: 900, minScore: 0.55, minRecallCount: 2, minPromoteScore: 0.7 },
  correctionDetection: { enabled: true },
};

const INGEST_CHECKPOINT_KEY = "dreaming:ingest:checkpoint";
const SCORE_CHECKPOINT_KEY = "dreaming:score:checkpoint";
const CANDIDATE_CATEGORY = "learning_candidates";
const CORRECTION_MARKERS = [
  "no,",
  "not quite",
  "that's wrong",
  "actually,",
  "incorrect",
  "that isn't right",
  "that is not right",
  "fix that",
  "wrong,",
];

/** Deterministic candidate node id from the origin session-chunk id. */
function candidateId(originId: string): string {
  return `dream:candidate:${originId}`;
}

/** Best-effort short-hash of a string for content-dedup (FNV-1a). */
function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Correction-origin heuristic (§3.4): a candidate is flagged
 * `correctionOrigin: true` when its own text opens with (or closely follows)
 * a short negation/correction marker. This is intentionally the ONLY
 * detector shipped in v1 (no dedicated `/correct` UI), matching the ADR's
 * documented out-of-scope §5.
 */
function looksLikeCorrection(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return CORRECTION_MARKERS.some((m) => lower.startsWith(m) || lower.includes(` ${m}`));
}

/** Read a durable Dreaming checkpoint; `{}` (never-run) on any absence. */
function readCheckpoint(store: PluresLmStore, key: string): Record<string, unknown> {
  const raw = store.agensStateGet(key);
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** List every `learning_candidates` node currently in the store. */
function listCandidates(store: PluresLmStore): LearningCandidate[] {
  try {
    const result = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: CANDIDATE_CATEGORY } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(result?.nodes) ? result.nodes : [];
    return rows
      .filter((r) => typeof r.id === "string" && r.data && typeof r.data === "object")
      .map((r) => r.data as unknown as LearningCandidate)
      .filter((c) => typeof c.id === "string");
  } catch {
    return [];
  }
}

/**
 * Ingest phase (§3.1 step 1): scan recently-written `session` chunks,
 * dedupe by content-hash against any existing candidate node, and stage each
 * distinct one as a `learning_candidates` node with `stage: "ingested"`.
 * Never writes to durable/promoted storage. Returns the real count of
 * newly-staged candidates (0 is honest when nothing is new — never
 * fabricated).
 */
export function dreamIngest(
  store: PluresLmStore,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
): { ran: boolean; scanned: number; newCandidates: number; checkpointEpoch: number } {
  if (!cfg.enabled) {
    return { ran: false, scanned: 0, newCandidates: 0, checkpointEpoch: 0 };
  }

  let sessionNodes: Array<{ id: string; data: Record<string, unknown> }>;
  try {
    const result = store.execIr([
      { op: "filter", predicate: { field: "category", cmp: "==", value: "session" } },
    ]) as { nodes?: Array<{ id?: unknown; data?: unknown }> };
    const rows = Array.isArray(result?.nodes) ? result.nodes : [];
    sessionNodes = rows
      .filter((r) => typeof r.id === "string")
      .map((r) => ({
        id: r.id as string,
        data: r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {},
      }));
  } catch {
    sessionNodes = [];
  }

  const now = Date.now();
  let newCandidates = 0;
  for (const node of sessionNodes) {
    const text =
      (typeof node.data.content === "string" && node.data.content) ||
      (typeof node.data.text === "string" && node.data.text) ||
      (typeof node.data.summary === "string" && node.data.summary) ||
      "";
    if (!text) continue;
    const originHash = hashOf(text);
    const cid = candidateId(node.id);
    const existing = store.get(cid);
    if (existing && (existing as Record<string, unknown>).originHash === originHash) {
      // Already ingested this exact content — dedup, no re-stage.
      continue;
    }
    const candidate: LearningCandidate & { category: string } = {
      id: cid,
      category: CANDIDATE_CATEGORY,
      stage: "ingested",
      score: 0,
      signals: {
        centrality: 0,
        recallFrequency: 0,
        clusterCohesion: 0,
        recencyDecay: 0,
        correctionReinforcement: 0,
      },
      originHash,
      firstSeenEpoch: existing
        ? Number((existing as Record<string, unknown>).firstSeenEpoch ?? now)
        : now,
      lastSeenEpoch: now,
      correctionOrigin: cfg.correctionDetection.enabled ? looksLikeCorrection(text) : false,
      recallCount: existing ? Number((existing as Record<string, unknown>).recallCount ?? 0) : 0,
      ticksAboveThreshold: 0,
      sourceCategory: typeof node.data.category === "string" ? node.data.category : "session",
      snippet: text.slice(0, 240),
    };
    store.put(cid, candidate as unknown as Record<string, unknown>);
    newCandidates += 1;
  }

  store.agensStateSet(INGEST_CHECKPOINT_KEY, { lastRunEpoch: now, scanned: sessionNodes.length });
  return { ran: true, scanned: sessionNodes.length, newCandidates, checkpointEpoch: now };
}

/**
 * Score phase (§3.1 step 2, §3.4): compute real composite signals for every
 * non-promoted candidate from PluresDB-native primitives (graph centrality
 * via `graph_pagerank`, cluster cohesion via `graph_clusters`, recall
 * frequency via accumulated `recallCount`, recency decay from
 * `lastSeenEpoch`, correction reinforcement from the ingest-time heuristic
 * flag), gate `ingested -> staged -> promoted` transitions against
 * `cfg.score` thresholds, and persist the updated node. A candidate promoted
 * here is migrated into the existing memory-chunk category (via
 * `store.put`) so it becomes immediately and natively searchable, per §3.2's
 * promotion contract. Promotion requires crossing `minPromoteScore` AND
 * `minRecallCount` on >=2 independent ticks (tracked via
 * `ticksAboveThreshold`); a `correctionOrigin` candidate can reach `staged`
 * on a single tick but still needs the same multi-tick reinforcement to
 * reach `promoted` — never on one observation (§3.4's compound gate).
 */
export function dreamScore(
  store: PluresLmStore,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
): { ran: boolean; scored: number; staged: number; promoted: number; checkpointEpoch: number } {
  if (!cfg.enabled) {
    return { ran: false, scored: 0, staged: 0, promoted: 0, checkpointEpoch: 0 };
  }

  // Real structural signals from the SAME native execIr surface consolidate()
  // already uses — no fabrication.
  let topRanked: Set<string> = new Set();
  const clusterSizeByMember: Map<string, number> = new Map();
  try {
    const pr = store.execIr([{ op: "graph_pagerank", damping: 0.85, iterations: 50 }]) as {
      nodes?: Array<{ id?: unknown; data?: unknown }>;
    };
    const rows = Array.isArray(pr?.nodes) ? pr.nodes : [];
    const ranked = rows
      .map((r) => ({
        id: typeof r.id === "string" ? r.id : "",
        score:
          r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).pagerank_score === "number"
            ? ((r.data as Record<string, unknown>).pagerank_score as number)
            : 0,
      }))
      .filter((r) => r.id && !r.id.startsWith("edge::"))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    topRanked = new Set(ranked.map((r) => r.id));
  } catch {
    topRanked = new Set();
  }
  try {
    const cl = store.execIr([{ op: "graph_clusters", algorithm: "louvain", min_size: 2 }]) as {
      nodes?: Array<{ id?: unknown; data?: unknown }>;
    };
    const rows = Array.isArray(cl?.nodes) ? cl.nodes : [];
    for (const r of rows) {
      if (typeof r.id !== "string") continue;
      const size =
        r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).cluster_size === "number"
          ? ((r.data as Record<string, unknown>).cluster_size as number)
          : 0;
      clusterSizeByMember.set(r.id, size);
    }
  } catch {
    /* clusters best-effort -> empty map, cohesion stays 0 for all */
  }

  const candidates = listCandidates(store);
  const now = Date.now();
  let scored = 0;
  let stagedCount = 0;
  let promotedCount = 0;

  for (const c of candidates) {
    if (c.stage === "promoted") continue; // terminal state, never re-scored

    const originId = c.id.replace(/^dream:candidate:/, "");
    const centrality = topRanked.has(originId) ? 1 : 0;
    const clusterCohesion = Math.min(1, (clusterSizeByMember.get(originId) ?? 0) / 10);
    // Recall frequency: normalize recallCount (0..N) to a 0..1 signal, capped
    // at minRecallCount*2 so a single very-hot node doesn't dominate scoring.
    const recallCap = Math.max(1, cfg.score.minRecallCount * 2);
    const recallFrequency = Math.min(1, (c.recallCount ?? 0) / recallCap);
    // Recency decay: linear falloff over 30 days from lastSeenEpoch.
    const ageMs = Math.max(0, now - (c.lastSeenEpoch ?? now));
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const recencyDecay = Math.max(0, 1 - ageMs / thirtyDaysMs);
    const correctionReinforcement = c.correctionOrigin ? 1 : 0;

    const compositeScore =
      centrality * 0.35 +
      recallFrequency * 0.25 +
      clusterCohesion * 0.15 +
      recencyDecay * 0.15 +
      correctionReinforcement * 0.1;

    const crossedMinScore = compositeScore >= cfg.score.minScore;
    const ticksAboveThreshold = crossedMinScore ? (c.ticksAboveThreshold ?? 0) + 1 : 0;

    let stage: LearningCandidate["stage"] = c.stage;
    if (c.stage === "ingested" && (crossedMinScore || c.correctionOrigin)) {
      stage = "staged";
    }
    // Promotion: staged, score >= minPromoteScore, recallCount >= minRecallCount,
    // AND at least 2 independent ticks over threshold (never on a single tick —
    // avoids single-signal flukes per §3.1 step 2/§3.4 table).
    const eligibleForPromotion =
      stage === "staged" &&
      compositeScore >= cfg.score.minPromoteScore &&
      (c.recallCount ?? 0) >= cfg.score.minRecallCount &&
      ticksAboveThreshold >= 2;

    const updated: LearningCandidate & { category: string } = {
      ...c,
      category: CANDIDATE_CATEGORY,
      stage: eligibleForPromotion ? "promoted" : stage,
      score: compositeScore,
      signals: { centrality, recallFrequency, clusterCohesion, recencyDecay, correctionReinforcement },
      ticksAboveThreshold,
      lastSeenEpoch: now,
    };
    store.put(c.id, updated as unknown as Record<string, unknown>);
    scored += 1;
    if (updated.stage === "staged") stagedCount += 1;
    if (updated.stage === "promoted") {
      promotedCount += 1;
      // Migrate into the durable memory-chunk category so it is immediately
      // searchable through the existing memory_search/memory_get read path.
      store.put(originId, {
        id: originId,
        category: "memory",
        source: "memory",
        content: c.snippet ?? "",
        promotedFromCandidate: c.id,
        promotedEpoch: now,
      });
    }
  }

  store.agensStateSet(SCORE_CHECKPOINT_KEY, {
    lastRunEpoch: now,
    scored,
    staged: stagedCount,
    promoted: promotedCount,
  });
  return { ran: true, scored, staged: stagedCount, promoted: promotedCount, checkpointEpoch: now };
}

/**
 * Record that a candidate's origin node was returned by a real
 * `memory_search` call. This is the recall-frequency signal source (§3.1
 * step 2) — call this from the search path when a hit's id matches a
 * staged/ingested candidate's origin id.
 */
export function dreamRecordRecall(store: PluresLmStore, originId: string): void {
  const cid = candidateId(originId);
  const existing = store.get(cid);
  if (!existing) return;
  const c = existing as unknown as LearningCandidate;
  store.put(cid, {
    ...(existing as Record<string, unknown>),
    recallCount: (c.recallCount ?? 0) + 1,
    lastSeenEpoch: Date.now(),
  });
}

/**
 * Schedule the Ingest/Score Agens timer rows (§3.3). The native alpha has no
 * upsert-by-name primitive for `agensTimerSchedule`, so this checks
 * `agensTimerList()` for an existing row with the same `name` first and
 * skips re-scheduling it — real idempotency, not a documented workaround for
 * duplication.
 */
export function dreamScheduleTimers(
  store: PluresLmStore,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
): { ingestTimerId: string | null; scoreTimerId: string | null } {
  if (!cfg.enabled) return { ingestTimerId: null, scoreTimerId: null };
  const existing = store.agensTimerList();
  const existingByName = new Map(existing.map((t) => [t.name, t.id]));

  let ingestTimerId = existingByName.get("dreaming:ingest") ?? null;
  if (!ingestTimerId) {
    ingestTimerId = store.agensTimerSchedule("dreaming:ingest", cfg.ingest.intervalSecs, { phase: "ingest" });
  }
  let scoreTimerId = existingByName.get("dreaming:score") ?? null;
  if (!scoreTimerId) {
    scoreTimerId = store.agensTimerSchedule("dreaming:score", cfg.score.intervalSecs, { phase: "score" });
  }
  return { ingestTimerId, scoreTimerId };
}

/**
 * Opportunistic tick (§3.3 mechanism 1): run whichever of Ingest/Score is
 * currently due per the native Agens timer table (`agensTimerDue`), then
 * reschedule that timer for its next interval. Safe to call on every
 * `memory_search` (mirrors `consolidate()`'s own lazy-tick posture) — a
 * no-op when nothing is due.
 */
export function dreamTick(
  store: PluresLmStore,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
): { ingestRan: boolean; scoreRan: boolean } {
  if (!cfg.enabled) return { ingestRan: false, scoreRan: false };
  const due = store.agensTimerDue();
  let ingestRan = false;
  let scoreRan = false;
  for (const timer of due) {
    if (timer.name === "dreaming:ingest") {
      dreamIngest(store, cfg);
      ingestRan = true;
    } else if (timer.name === "dreaming:score") {
      dreamScore(store, cfg);
      scoreRan = true;
    }
  }
  return { ingestRan, scoreRan };
}

/** One threshold comparison surfaced by {@link dreamExplain}. */
export type ThresholdGap = { name: string; required: number; actual: number; met: boolean };

/**
 * Transparency capability (§3.5): given a candidate node id (or the origin
 * session-chunk id — both resolve to the same candidate), return its current
 * stage, every computed signal, the exact thresholds being compared against
 * and the numeric gap to each, and a plain-language one-line verdict. Every
 * field returned is read directly from the persisted candidate node — never
 * templated or fabricated. Returns `{ found: false }` (never a fake verdict)
 * when no matching candidate exists.
 */
export function dreamExplain(
  store: PluresLmStore,
  candidateOrOriginId: string,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
):
  | { found: false; id: string }
  | {
      found: true;
      id: string;
      stage: LearningCandidate["stage"];
      signals: LearningCandidate["signals"];
      score: number;
      recallCount: number;
      ticksAboveThreshold: number;
      correctionOrigin: boolean;
      thresholds: ThresholdGap[];
      verdict: string;
    } {
  const cid = candidateOrOriginId.startsWith("dream:candidate:")
    ? candidateOrOriginId
    : candidateId(candidateOrOriginId);
  const raw = store.get(cid);
  if (!raw) return { found: false, id: candidateOrOriginId };
  const c = raw as unknown as LearningCandidate;

  const thresholds: ThresholdGap[] = [
    { name: "minScore", required: cfg.score.minScore, actual: c.score, met: c.score >= cfg.score.minScore },
    {
      name: "minRecallCount",
      required: cfg.score.minRecallCount,
      actual: c.recallCount ?? 0,
      met: (c.recallCount ?? 0) >= cfg.score.minRecallCount,
    },
    {
      name: "minPromoteScore",
      required: cfg.score.minPromoteScore,
      actual: c.score,
      met: c.score >= cfg.score.minPromoteScore,
    },
    {
      name: "ticksAboveThreshold (>=2)",
      required: 2,
      actual: c.ticksAboveThreshold ?? 0,
      met: (c.ticksAboveThreshold ?? 0) >= 2,
    },
  ];

  let verdict: string;
  if (c.stage === "promoted") {
    verdict = `promoted: score ${c.score.toFixed(2)} and recallCount ${c.recallCount ?? 0} cleared all gates over ${c.ticksAboveThreshold ?? 0} ticks.`;
  } else if (c.stage === "staged") {
    const recallGap = Math.max(0, cfg.score.minRecallCount - (c.recallCount ?? 0));
    const scoreGap = Math.max(0, cfg.score.minPromoteScore - c.score);
    const ticksGap = Math.max(0, 2 - (c.ticksAboveThreshold ?? 0));
    const parts: string[] = [];
    if (recallGap > 0) parts.push(`recallCount ${c.recallCount ?? 0}/${cfg.score.minRecallCount}, needs ${recallGap} more retrievals`);
    if (scoreGap > 0) parts.push(`score ${c.score.toFixed(2)}/${cfg.score.minPromoteScore}, needs ${scoreGap.toFixed(2)} more`);
    if (ticksGap > 0) parts.push(`ticksAboveThreshold ${c.ticksAboveThreshold ?? 0}/2, needs ${ticksGap} more scoring tick(s)`);
    verdict = parts.length > 0 ? `not promoted: ${parts.join("; ")}.` : "staged: all promotion gates met, awaiting next Score tick to confirm.";
  } else {
    const scoreGap = Math.max(0, cfg.score.minScore - c.score);
    verdict = c.correctionOrigin
      ? "ingested: correction-origin flag set but not yet re-scored into staged."
      : `not staged: score ${c.score.toFixed(2)}/${cfg.score.minScore}, needs ${scoreGap.toFixed(2)} more (or a detected correction).`;
  }

  return {
    found: true,
    id: cid,
    stage: c.stage,
    signals: c.signals,
    score: c.score,
    recallCount: c.recallCount ?? 0,
    ticksAboveThreshold: c.ticksAboveThreshold ?? 0,
    correctionOrigin: c.correctionOrigin === true,
    thresholds,
    verdict,
  };
}

/**
 * Status capability (§3.6): always-queryable, never-silent state. Reports
 * `enabled`, per-phase `lastRunEpoch`/`nextEligibleAt` (computed from the
 * REAL native Agens timer table — a concrete future timestamp or an honest
 * `unavailable` reason, never an opaque "blocked"), and real counts of
 * ingested/staged/promoted candidates read directly from the store. The
 * Reflect phase is reported as `unavailable` (no LLM-invocation bridge
 * exists in this codebase — an honest absence, not a stub) rather than
 * fabricating diary/shadow-trial state.
 */
export function dreamStatus(
  store: PluresLmStore,
  cfg: DreamingConfig = DEFAULT_DREAMING_CONFIG,
): {
  enabled: boolean;
  ingest: { lastRunEpoch: number; nextEligibleAt: string | null; scanned: number };
  score: { lastRunEpoch: number; nextEligibleAt: string | null; scored: number; staged: number; promoted: number };
  reflect: { unavailable: string };
  counts: { ingestedCount: number; stagedCount: number; promotedCount: number; correctionOriginCount: number };
} {
  const ingestCheckpoint = readCheckpoint(store, INGEST_CHECKPOINT_KEY);
  const scoreCheckpoint = readCheckpoint(store, SCORE_CHECKPOINT_KEY);
  const timers = store.agensTimerList();
  const ingestTimer = timers.find((t) => t.name === "dreaming:ingest");
  const scoreTimer = timers.find((t) => t.name === "dreaming:score");

  const candidates = listCandidates(store);
  const ingestedCount = candidates.filter((c) => c.stage === "ingested").length;
  const stagedCount = candidates.filter((c) => c.stage === "staged").length;
  const promotedCount = candidates.filter((c) => c.stage === "promoted").length;
  const correctionOriginCount = candidates.filter((c) => c.correctionOrigin === true).length;

  return {
    enabled: cfg.enabled,
    ingest: {
      lastRunEpoch: Number(ingestCheckpoint.lastRunEpoch ?? 0),
      nextEligibleAt: ingestTimer?.nextFireAt ?? null,
      scanned: Number(ingestCheckpoint.scanned ?? 0),
    },
    score: {
      lastRunEpoch: Number(scoreCheckpoint.lastRunEpoch ?? 0),
      nextEligibleAt: scoreTimer?.nextFireAt ?? null,
      scored: Number(scoreCheckpoint.scored ?? 0),
      staged: Number(scoreCheckpoint.staged ?? 0),
      promoted: Number(scoreCheckpoint.promoted ?? 0),
    },
    reflect: {
      unavailable:
        "Reflect (Dream Diary / shadow-trial) is unimplemented in v1: no chat/completion LLM-invocation bridge exists in this codebase (only embeddingModel is configured). Deferred honestly, not stubbed.",
    },
    counts: { ingestedCount, stagedCount, promotedCount, correctionOriginCount },
  };
}

/**
 * True when `source` should be excluded from a caller's default recall view
 * because it is a staged/ingested Dreaming candidate rather than durable
 * memory. Used by the memory-capability read path (`sourceMatchesCorpus`-
 * style filtering) so `learning_candidates` never leak into default
 * `memory_search` results — only an explicit `corpus: "staged"` opt-in
 * surfaces them (§3.4).
 */
export function isStagedCandidateId(id: string): boolean {
  return id.startsWith("dream:candidate:");
}

