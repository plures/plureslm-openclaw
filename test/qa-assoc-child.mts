/**
 * QA child worker (P1 associative recall, independent QA stage).
 *
 * Drives ONLY the shipped sync()/search()/store API against a REAL store
 * (C-TEST-002 — no fabricated edges/recall). Each phase runs in its OWN process
 * so the PluresDB exclusive file lock is released between write/link and the
 * fresh-process reopen (cross-process durability contract).
 *
 * Usage: tsx test/qa-assoc-child.mts <dir> <phase>
 *
 *  sync         : write N same-session/same-window files into <dir>, ingest via
 *                 the SHIPPED write path (createPluresLmSearchManager ->
 *                 manager.sync()). Then, through the SAME open handle, report
 *                 the real edge inventory: store.execIr([{op:"graph_links"}])
 *                 count, and store.neighbors() for each seed. Prints the full
 *                 edge/neighbor inventory the parent asserts durability against.
 *
 *  inspect      : FRESH process. Reopen the SAME dbPath read-only-ish and report
 *                 the edge inventory again (graph_links count + neighbors per
 *                 seed) WITHOUT writing anything. Proves edges are DURABLE on
 *                 disk across processes (not in-memory). Also runs a search()
 *                 for the disjoint target at a strict threshold to prove the
 *                 via:"graph" recall is durable cross-process.
 *
 *  resync       : FRESH process. Re-run sync() over the SAME unchanged files.
 *                 Reports store.store() {written,skipped} (Path B #isDirty: 0
 *                 new content nodes) AND the edge count before/after the re-link
 *                 so the parent can assert edges are NOT duplicated (deterministic
 *                 edge::{from}::{to} id => last-writer-wins, stable count).
 *
 *  metric       : FRESH process. Compute the ASSOCIATIVE-ONLY recall delta on the
 *                 fixture set: for the assoc query, run search() at a strict
 *                 vector threshold (graph ON, the shipped default) and count the
 *                 relevant targets that appear ONLY via:"graph" (i.e. NOT direct
 *                 hits). Report the count + which ids. Also reports the direct-hit
 *                 set at the same strict threshold (graph contribution = ids
 *                 present via graph but absent from direct). Channel-agnostic:
 *                 direct capability calls only.
 *
 *  sanity       : FRESH process. Monkeypatch the store so neighbors()/execIr
 *                 THROW for a bogus expansion, then call search() for an on-topic
 *                 query and assert the DIRECT hits still come back (read path
 *                 never throws out). Prints {threw, directHitCount, hitPaths}.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";

// --- Fixture set: 4 same-session files written in the same instant ----------
// ALPHA  — on-topic for the assoc query "kraken deployment runbook".
// BETA   — disjoint (photosynthesis); cosine to the assoc query < strict 0.80.
// DELTA  — disjoint (sourdough baking); also below strict threshold.
// GAMMA  — on-topic for the precision query (postgres backup), the guardrail
//          direct top-1.
// All four share category:"session" + the same syncEpoch window, so
// link-on-write joins them with category+temporal edges. Under a strict vector
// threshold for the assoc query, BETA and DELTA can ONLY surface via graph
// expansion of the ALPHA direct hit.
const FILES = {
  alpha: {
    file: "session-alpha.md",
    id: "mem:session:session-alpha:0",
    text:
      "# session alpha\n\nALPHA distinctive note about the kraken deployment runbook and its rollout and failover steps.\n",
  },
  beta: {
    file: "session-beta.md",
    id: "mem:session:session-beta:0",
    text:
      "# session beta\n\nBETA totally unrelated content: photosynthesis chlorophyll wavelength absorption in green leaves.\n",
  },
  delta: {
    file: "session-delta.md",
    id: "mem:session:session-delta:0",
    text:
      "# session delta\n\nDELTA unrelated note: sourdough starter hydration ratios and overnight bulk fermentation tips.\n",
  },
  gamma: {
    file: "session-gamma.md",
    id: "mem:session:session-gamma:0",
    text:
      "# session gamma\n\nGAMMA note: the postgres backup schedule and nightly pg_dump retention policy and WAL archiving.\n",
  },
} as const;

const ASSOC_QUERY = "kraken deployment runbook";
const PRECISION_QUERY = "postgres backup schedule pg_dump retention";
const STRICT_THRESHOLD = 0.8;

// The "relevant targets" for the associative win: the disjoint siblings that
// share the session window with the on-topic alpha seed but are NOT direct hits
// for the assoc query. These should surface ONLY via graph expansion.
const ASSOC_TARGETS = [FILES.beta.id, FILES.delta.id];

function writeFixtures(): void {
  for (const f of Object.values(FILES)) {
    writeFileSync(join(dir, f.file), f.text, "utf8");
  }
}

function edgeInventory(store: {
  execIr: (s: unknown[]) => unknown;
  neighbors: (id: string, depth?: number) => Array<{ id: string }>;
}): {
  graphLinkCount: number;
  neighborsBySeed: Record<string, string[]>;
} {
  let graphLinkCount = -1;
  try {
    const links = store.execIr([{ op: "graph_links" }]) as { nodes?: unknown[] };
    graphLinkCount = Array.isArray(links.nodes) ? links.nodes.length : -1;
  } catch {
    graphLinkCount = -1;
  }
  const neighborsBySeed: Record<string, string[]> = {};
  for (const f of Object.values(FILES)) {
    try {
      neighborsBySeed[f.id] = store.neighbors(f.id, 1).map((n) => n.id).sort();
    } catch {
      neighborsBySeed[f.id] = [];
    }
  }
  return { graphLinkCount, neighborsBySeed };
}

function emit(obj: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

function fail(err: unknown): never {
  process.stdout.write(
    JSON.stringify({ phase, ok: false, error: String((err as Error)?.stack ?? err) }) + "\n",
  );
  process.exit(1);
}

async function doSync(opts?: { reportWritten?: boolean }) {
  const { store, manager } = createPluresLmSearchManager({
    dbPath: dir,
    embeddingModel: MODEL,
  });
  // Capture per-file written/skipped by wrapping store.store via a probe sync.
  // We can't see store.store()'s return from manager.sync(), so for the resync
  // accounting we call status() before/after to get the node-count delta.
  const before = manager.status().chunks ?? -1;
  await manager.sync({
    reason: "qa",
    force: false,
    sessionFiles: Object.values(FILES).map((f) => join(dir, f.file)),
  });
  const after = manager.status().chunks ?? -1;
  return { store, manager, before, after };
}

if (phase === "sync") {
  (async () => {
    writeFixtures();
    const { store, before, after } = await doSync();
    const inv = edgeInventory(store);
    emit({
      phase,
      ok: true,
      beforeTotalNodes: before,
      afterTotalNodes: after,
      nodeDelta: after - before,
      ...inv,
      seeds: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v.id])),
      betaIsAlphaNeighbor: inv.neighborsBySeed[FILES.alpha.id]?.includes(FILES.beta.id) ?? false,
      deltaIsAlphaNeighbor: inv.neighborsBySeed[FILES.alpha.id]?.includes(FILES.delta.id) ?? false,
    });
  })().catch(fail);
}

if (phase === "inspect") {
  // FRESH process: do NOT write/sync. Just reopen and read the edge inventory
  // to prove durability on disk. Then prove via:"graph" recall is durable too.
  (async () => {
    const { store, manager } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
      vectorThreshold: STRICT_THRESHOLD,
    });
    const inv = edgeInventory(store);
    // Durable graph recall: at strict threshold the disjoint beta/delta can only
    // arrive via graph expansion of the alpha direct hit.
    const hits = await manager.search(ASSOC_QUERY, { maxResults: 8 });
    const ranked = hits.map((h, idx) => ({
      rank: idx,
      path: h.path,
      score: h.score,
      via: h.vectorScore !== undefined ? "vector" : h.textScore !== undefined ? "text" : "graph",
      citation: h.citation ?? null,
    }));
    const graphIds = ranked.filter((r) => r.via === "graph").map((r) => r.path);
    emit({
      phase,
      ok: true,
      ...inv,
      betaIsAlphaNeighbor: inv.neighborsBySeed[FILES.alpha.id]?.includes(FILES.beta.id) ?? false,
      deltaIsAlphaNeighbor: inv.neighborsBySeed[FILES.alpha.id]?.includes(FILES.delta.id) ?? false,
      ranked,
      graphIds,
      betaViaGraph: ranked.some((r) => r.path === FILES.beta.id && r.via === "graph"),
      deltaViaGraph: ranked.some((r) => r.path === FILES.delta.id && r.via === "graph"),
    });
  })().catch(fail);
}

if (phase === "resync") {
  // FRESH process: re-run sync() over the SAME unchanged files. Assert (a) 0 new
  // content nodes (dirty tracker), (b) edge count stable (no duplicate edges).
  (async () => {
    const { store } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
    });
    const invBefore = edgeInventory(store);
    const beforeNodes = store.count();
    // Re-sync the SAME files (already-current content => dirty tracker skips).
    const { manager } = { manager: store } as never; // not used
    void manager;
    const mgr = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
    await mgr.manager.sync({
      reason: "qa-resync",
      force: false,
      sessionFiles: Object.values(FILES).map((f) => join(dir, f.file)),
    });
    const afterNodes = store.count();
    const invAfter = edgeInventory(store);
    emit({
      phase,
      ok: true,
      beforeTotalNodes: beforeNodes,
      afterTotalNodes: afterNodes,
      nodeDelta: afterNodes - beforeNodes,
      edgeCountBefore: invBefore.graphLinkCount,
      edgeCountAfter: invAfter.graphLinkCount,
      edgeCountStable: invBefore.graphLinkCount === invAfter.graphLinkCount,
      neighborsStable:
        JSON.stringify(invBefore.neighborsBySeed) === JSON.stringify(invAfter.neighborsBySeed),
    });
  })().catch(fail);
}

if (phase === "metric") {
  // FRESH process. Compute associative-only recall delta. At a STRICT vector
  // threshold the disjoint siblings cannot be direct hits, so any that appear
  // are pure graph contribution. We measure: with graph expansion ON (shipped
  // search), how many ASSOC_TARGETS surface that are NOT in the direct-hit set.
  (async () => {
    const { store, manager } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
      vectorThreshold: STRICT_THRESHOLD,
    });
    const hits = await manager.search(ASSOC_QUERY, { maxResults: 8 });
    const direct = hits.filter((h) => h.vectorScore !== undefined || h.textScore !== undefined);
    const graph = hits.filter(
      (h) => h.vectorScore === undefined && h.textScore === undefined && h.citation?.includes("graph"),
    );
    const directIds = new Set(direct.map((h) => h.path));
    const graphIds = graph.map((h) => h.path);
    // Associative-only: relevant targets that are present via graph AND absent
    // from the direct set (would NOT have been recalled with graph OFF).
    const assocOnly = ASSOC_TARGETS.filter((t) => graphIds.includes(t) && !directIds.has(t));

    // Guardrail re-confirm via a SECOND manager at default threshold (precision
    // query): top-1 direct unchanged, no graph hit outranks its seed.
    const mgrDefault = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
    const pHits = await mgrDefault.manager.search(PRECISION_QUERY, { maxResults: 8 });
    const pRanked = pHits.map((h, idx) => ({
      rank: idx,
      path: h.path,
      via: h.vectorScore !== undefined ? "vector" : h.textScore !== undefined ? "text" : "graph",
      seedId:
        h.vectorScore === undefined && h.textScore === undefined && h.citation
          ? (h.citation.match(/^plureslm:graph:(.+)->(.+)$/)?.[1] ?? null)
          : null,
    }));
    const top = pRanked[0];
    const rankOf = new Map(pRanked.map((h) => [h.path, h.rank] as const));
    let guardrailHeld = true;
    for (const h of pRanked) {
      if (h.via !== "graph") continue;
      const seedRank = h.seedId !== null ? rankOf.get(h.seedId) : undefined;
      if (!(seedRank !== undefined && seedRank < h.rank)) guardrailHeld = false;
    }
    const graphAtTop = pRanked.some((h) => h.via === "graph" && h.rank === 0);

    emit({
      phase,
      ok: true,
      assocQuery: ASSOC_QUERY,
      strictThreshold: STRICT_THRESHOLD,
      directIds: [...directIds],
      graphIds,
      assocTargets: ASSOC_TARGETS,
      associativeOnlyRecallDelta: assocOnly.length,
      associativeOnlyIds: assocOnly,
      // guardrail
      precisionQuery: PRECISION_QUERY,
      precisionTop1: top?.path ?? null,
      precisionTop1Via: top?.via ?? null,
      precisionTop1ExpectedGamma: top?.path === FILES.gamma.id,
      noGraphAtTop1: !graphAtTop,
      guardrailHeld,
      pRanked,
      totalNodes: store.count(),
    });
  })().catch(fail);
}

if (phase === "sanity") {
  // FRESH process. Force the graph-expansion path to ERROR (bogus monkeypatch on
  // the store's neighbors so it throws), then confirm search() STILL returns the
  // direct hits (best-effort expansion never throws out of the read path).
  (async () => {
    const { store, manager } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
    });
    // Sabotage BOTH neighbors() and execIr to throw — search() catches per-seed.
    let threw = false;
    (store as unknown as { neighbors: () => never }).neighbors = () => {
      threw = true;
      throw new Error("QA-INJECTED neighbors() failure");
    };
    (store as unknown as { execIr: () => never }).execIr = () => {
      throw new Error("QA-INJECTED execIr() failure");
    };
    // On-topic query so there ARE direct hits to preserve.
    let hits: Awaited<ReturnType<typeof manager.search>> = [];
    let searchThrew = false;
    try {
      hits = await manager.search(PRECISION_QUERY, { maxResults: 8 });
    } catch {
      searchThrew = true;
    }
    const directHits = hits.filter(
      (h) => h.vectorScore !== undefined || h.textScore !== undefined,
    );
    emit({
      phase,
      ok: true,
      neighborsThrew: threw,
      searchThrew, // MUST be false: read path must not throw out
      directHitCount: directHits.length,
      hitPaths: hits.map((h) => h.path),
      gammaPresent: hits.some((h) => h.path === FILES.gamma.id),
    });
  })().catch(fail);
}
