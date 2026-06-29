/**
 * QA structural probe (one process): verify the exact node/edge composition so
 * the QA report's counts are HONEST, not assumed.
 *
 *  - Confirms the 4 fixture content nodes exist by id (get()).
 *  - Confirms graph_links returns exactly the 6 expected undirected pairs among
 *    the 4 same-session nodes (C(4,2)=6), each an _edge node with id
 *    edge::{from}::{to}.
 *  - Confirms no edge node leaks into a plain recall (edges are graph plumbing).
 *
 * Usage: tsx test/qa-structural-probe.mts <dir>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPluresLmSearchManager } from "../dist/api.js";

const dir = process.argv[2];
const MODEL = "BAAI/bge-small-en-v1.5";

const FILES = [
  { file: "session-alpha.md", id: "mem:session:session-alpha:0", text: "# session alpha\n\nALPHA kraken deployment runbook rollout failover.\n" },
  { file: "session-beta.md", id: "mem:session:session-beta:0", text: "# session beta\n\nBETA photosynthesis chlorophyll wavelength leaves.\n" },
  { file: "session-delta.md", id: "mem:session:session-delta:0", text: "# session delta\n\nDELTA sourdough starter hydration fermentation.\n" },
  { file: "session-gamma.md", id: "mem:session:session-gamma:0", text: "# session gamma\n\nGAMMA postgres backup pg_dump retention WAL.\n" },
];
const IDS = FILES.map((f) => f.id).sort();

(async () => {
  for (const f of FILES) writeFileSync(join(dir, f.file), f.text, "utf8");
  const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
  await manager.sync({ reason: "probe", force: false, sessionFiles: FILES.map((f) => join(dir, f.file)) });

  // 1) The 4 content nodes exist by id, carry category:"session", NOT _edge.
  const db = (store as unknown as { ["#db"]?: unknown }); // not accessible; use execIr list instead
  void db;
  const contentPresent: Record<string, boolean> = {};
  // graph_links gives edges; use a filter to list the 4 session content nodes.
  const sessionNodes = store.execIr([
    { op: "filter", predicate: { field: "category", cmp: "==", value: "session" } },
  ]) as { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> };
  const sessionIds = (sessionNodes.nodes ?? [])
    .filter((n) => n?.data?._edge !== true)
    .map((n) => String(n.id))
    .sort();
  for (const id of IDS) contentPresent[id] = sessionIds.includes(id);

  // 2) graph_links: exactly the edges, each _edge:true, id edge::{from}::{to}.
  const links = store.execIr([{ op: "graph_links" }]) as {
    nodes?: Array<{ id?: string; data?: Record<string, unknown> }>;
  };
  const edges = (links.nodes ?? []).map((n) => ({
    id: String(n.id),
    isEdge: n?.data?._edge === true,
    from: n?.data?.from,
    to: n?.data?.to,
    edgeIdShape: /^edge::.+::.+$/.test(String(n.id)),
  }));
  // Expected undirected pairs among the 4 ids.
  const expectedPairs: string[] = [];
  for (let i = 0; i < IDS.length; i++)
    for (let j = i + 1; j < IDS.length; j++) expectedPairs.push(`${IDS[i]}|${IDS[j]}`);
  const actualPairs = edges
    .map((e) => [String(e.from), String(e.to)].sort().join("|"))
    .sort();
  const expectedSorted = [...new Set(expectedPairs)].sort();

  // 3) No edge node leaks into a plain recall.
  const recallHits = await manager.search("kraken deployment runbook", { maxResults: 8 });
  const anyEdgeInRecall = recallHits.some((h) => String(h.path).startsWith("edge::"));

  process.stdout.write(JSON.stringify({
    ok: true,
    sessionContentIds: sessionIds,
    contentPresent,
    allFourContentPresent: IDS.every((id) => contentPresent[id]),
    edgeCount: edges.length,
    allEdgesAreEdgeNodes: edges.every((e) => e.isEdge),
    allEdgeIdsWellFormed: edges.every((e) => e.edgeIdShape),
    expectedPairCount: expectedSorted.length,
    actualPairs,
    pairsMatchFullMesh: JSON.stringify(actualPairs) === JSON.stringify(expectedSorted),
    anyEdgeLeakedIntoRecall: anyEdgeInRecall,
  }) + "\n");
  process.exit(0);
})().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }) + "\n");
  process.exit(1);
});
