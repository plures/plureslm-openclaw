/**
 * Child worker for GATE D (associative graph recall). Runs each phase in its
 * OWN process so the PluresDB exclusive file lock is released between the
 * write/link phase and the fresh-process read phases (same cross-process
 * contract store-child.mts honors).
 *
 * It exercises the REAL, SHIPPED capability only — no fixtures faking recall
 * (C-TEST-002): edges are formed by the shipped `sync()` link-on-write path and
 * surfaced by the shipped `search()` graph expansion. Nothing here writes an
 * edge or a `via:"graph"` hit by hand.
 *
 * Usage: tsx test/assoc-child.mts <dir> <link|read-strict|read-default>
 *
 *  link         : write three session files into <dir> and ingest them via the
 *                 SHIPPED write path (buildMemoryCapability ->
 *                 getMemorySearchManager -> manager.sync()), which runs
 *                 link-on-write once post-loop. Then, through the same open
 *                 handle, confirm the disjoint sibling is a real graph neighbor
 *                 of the on-topic seed via the shipped store.neighbors() path.
 *                 Prints { edgeCount, alphaNeighborIds, betaIsNeighbor }.
 *
 *  read-strict  : FRESH process, vectorThreshold:0.80 so the disjoint BETA node
 *                 can NOT be a direct vector/text hit for the ALPHA query — it
 *                 can only arrive via graph expansion. Proves the ASSOCIATIVE
 *                 WIN end-to-end through search(). Prints the full ranked hit
 *                 list + whether BETA surfaced via graph.
 *
 *  read-default : FRESH process, DEFAULT threshold. Runs the on-topic precision
 *                 query and prints the full ranked hit list so the parent can
 *                 assert the PRECISION GUARDRAIL: the expected direct node is
 *                 top-1, and every graph hit ranks strictly below the direct hit
 *                 that seeded it (graph hits are appended after direct hits and
 *                 never displace top-1).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3] as "link" | "read-strict" | "read-default";
const MODEL = "BAAI/bge-small-en-v1.5";

// --- Fixtures (real session content, ingested via the shipped write path) ----
//
// ALPHA  — on-topic for the ASSOCIATIVE-WIN query "kraken deployment runbook".
// BETA   — content DISJOINT from that query (photosynthesis); its baseline
//          cosine to the query (~0.6) sits BELOW the strict 0.80 threshold and
//          it shares no keywords, so under read-strict BETA can ONLY be reached
//          via the alpha<->beta edge link-on-write forms (same session window,
//          both category:"session").
// GAMMA  — on-topic for the PRECISION-GUARDRAIL query so that query has a clear
//          expected direct top-1 that graph expansion must NOT displace.
//
// All three are written in the same instant with category:"session", so
// link-on-write joins them with category+temporal edges; alpha's neighbors thus
// include beta (and gamma), which is exactly what lets the disjoint beta be
// surfaced by association while the on-topic direct hit still ranks first.
const FILE_ALPHA = "session-alpha.md";
const FILE_BETA = "session-beta.md";
const FILE_GAMMA = "session-gamma.md";

const ID_ALPHA = "mem:session:session-alpha:0";
const ID_BETA = "mem:session:session-beta:0";
const ID_GAMMA = "mem:session:session-gamma:0";

const TEXT_ALPHA =
  "# session alpha\n\nALPHA distinctive note about the kraken deployment runbook and its rollout steps.\n";
const TEXT_BETA =
  "# session beta\n\nBETA totally unrelated content: photosynthesis chlorophyll wavelength absorption in leaves.\n";
const TEXT_GAMMA =
  "# session gamma\n\nGAMMA note: the postgres backup schedule and nightly pg_dump retention policy.\n";

// Query that is on-topic for ALPHA only and disjoint from BETA (the win query).
const ASSOC_QUERY = "kraken deployment runbook";
// Query that is on-topic for GAMMA (the precision-guardrail query). GAMMA is the
// expected direct top-1; ALPHA/BETA must not outrank it, and any graph neighbors
// appended must sit strictly below the seed hit.
const PRECISION_QUERY = "postgres backup schedule pg_dump retention";

const STRICT_THRESHOLD = 0.8;

function writeFixtures(): void {
  writeFileSync(join(dir, FILE_ALPHA), TEXT_ALPHA, "utf8");
  writeFileSync(join(dir, FILE_BETA), TEXT_BETA, "utf8");
  writeFileSync(join(dir, FILE_GAMMA), TEXT_GAMMA, "utf8");
}

if (phase === "link") {
  (async () => {
    writeFixtures();
    // Ingest all three through the SHIPPED write path. sync() stamps a numeric
    // data.syncEpoch on every chunk and calls linkRecent() ONCE post-loop, so
    // the three same-session chunks get category+temporal edges. We use the
    // manager+store from createPluresLmSearchManager so we can both sync AND
    // inspect neighbors through the single memoized handle (exclusive lock).
    const { store, manager } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
    });
    await manager.sync({
      reason: "assoc-gate",
      force: false,
      sessionFiles: [
        join(dir, FILE_ALPHA),
        join(dir, FILE_BETA),
        join(dir, FILE_GAMMA),
      ],
    });

    // Prove the disjoint sibling is a real graph neighbor of the on-topic seed
    // via the SHIPPED neighbors() path (the same traversal search() expands on).
    const alphaNeighbors = store.neighbors(ID_ALPHA, 1);
    const alphaNeighborIds = alphaNeighbors.map((n) => n.id);

    // Advisory raw edge count (DEF-PATHB-1: we don't trust the count blindly,
    // we assert the neighbor relationship above).
    let edgeCount = -1;
    try {
      const links = store.execIr([{ op: "graph_links" }]) as { nodes?: unknown[] };
      edgeCount = Array.isArray(links.nodes) ? links.nodes.length : -1;
    } catch {
      edgeCount = -1;
    }

    process.stdout.write(
      JSON.stringify({
        phase: "link",
        ok: true,
        seedId: ID_ALPHA,
        siblingId: ID_BETA,
        gammaId: ID_GAMMA,
        alphaNeighborIds,
        betaIsNeighbor: alphaNeighborIds.includes(ID_BETA),
        gammaIsNeighbor: alphaNeighborIds.includes(ID_GAMMA),
        edgeCount,
        totalNodes: store.count(),
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(
      JSON.stringify({ phase: "link", ok: false, error: String(err?.stack ?? err) }) + "\n",
    );
    process.exit(1);
  });
}

if (phase === "read-strict" || phase === "read-default") {
  (async () => {
    // Fresh process: lock released, edges must be durable on disk. read-strict
    // raises vectorThreshold so the disjoint BETA can ONLY arrive via graph.
    const vectorThreshold = phase === "read-strict" ? STRICT_THRESHOLD : undefined;
    const query = phase === "read-strict" ? ASSOC_QUERY : PRECISION_QUERY;

    const capability = buildMemoryCapability({
      dbPath: dir,
      embeddingModel: MODEL,
      vectorThreshold,
    });
    const { manager, error } = await capability.runtime!.getMemorySearchManager({
      cfg: {} as never,
      agentId: "assoc-gate",
    });
    if (!manager) {
      process.stdout.write(
        JSON.stringify({ phase, ok: false, error: error ?? "no manager" }) + "\n",
      );
      process.exit(1);
    }

    const hits = await manager.search(query, { maxResults: 8 });

    // Normalize the ranked list to exactly the provenance fields the parent
    // asserts on. `viaGraph` is derived from the SHIPPED citation contract
    // (graph hits carry citation `plureslm:graph:<seed>-><id>` and set neither
    // vectorScore nor textScore).
    const ranked = hits.map((h, idx) => {
      const isGraph = Boolean(
        h.citation?.includes("graph") &&
          h.vectorScore === undefined &&
          h.textScore === undefined,
      );
      // Parse the seed id out of a graph citation (plureslm:graph:<seed>-><id>).
      let seedId: string | null = null;
      if (isGraph && h.citation) {
        const m = h.citation.match(/^plureslm:graph:(.+)->(.+)$/);
        seedId = m ? m[1] : null;
      }
      return {
        rank: idx,
        path: h.path,
        score: h.score,
        citation: h.citation ?? null,
        via: isGraph
          ? "graph"
          : h.vectorScore !== undefined
            ? "vector"
            : "text",
        seedId,
      };
    });

    process.stdout.write(
      JSON.stringify({
        phase,
        ok: true,
        query,
        vectorThreshold: vectorThreshold ?? null,
        ids: { alpha: ID_ALPHA, beta: ID_BETA, gamma: ID_GAMMA },
        ranked,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(
      JSON.stringify({ phase, ok: false, error: String(err?.stack ?? err) }) + "\n",
    );
    process.exit(1);
  });
}
