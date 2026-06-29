/**
 * P1 throwaway smoke (NOT a gate; deleted after proving edge formation).
 *
 * Proves link-on-write forms real edges via the SHIPPED sync() path and that
 * neighbors() traverses them:
 *   phase=link  : sync() two session files in the same temporal window, both
 *                 category:"session" -> linkRecent() runs -> then in the SAME
 *                 process (one open handle) call store.neighbors(<chunk id>)
 *                 and confirm the OTHER file's chunk comes back as a neighbor.
 *   phase=verify: reopen in a FRESH process (lock released) and confirm the
 *                 edges are durable: neighbors(<chunk id>) still returns sibling.
 *
 * Usage: tsx test/p1-smoke.mts <dir> <link|verify> [seedChunkId]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3] as "link" | "verify" | "verify-strict";
const MODEL = "BAAI/bge-small-en-v1.5";

if (phase === "link") {
  (async () => {
    // Two session files, distinct content, written this instant -> same 24h
    // temporal window AND same category:"session" => category+temporal edges.
    const fileA = join(dir, "session-alpha.md");
    const fileB = join(dir, "session-beta.md");
    writeFileSync(
      fileA,
      "# session alpha\n\nALPHA distinctive note about the kraken deployment runbook.\n",
      "utf8",
    );
    writeFileSync(
      fileB,
      "# session beta\n\nBETA totally unrelated content: photosynthesis chlorophyll wavelength absorption.\n",
      "utf8",
    );

    // Use the manager+store directly so we can both sync AND inspect neighbors
    // through the one memoized handle (exclusive lock: one open per process).
    const { store, manager } = createPluresLmSearchManager({
      dbPath: dir,
      embeddingModel: MODEL,
    });
    await manager.sync({
      reason: "smoke",
      force: false,
      sessionFiles: [fileA, fileB],
    });

    // Chunk ids are deterministic: mem:session:<fileStemSlug>:<idx>.
    const seedId = "mem:session:session-alpha:0";
    const siblingId = "mem:session:session-beta:0";

    // Prove edges exist via the SHIPPED neighbors() path.
    const neighbors = store.neighbors(seedId, 1);
    const neighborIds = neighbors.map((n) => n.id);

    // Also pull the raw edge list via execIr graph_links to show real edges
    // were written (advisory, per DEF-PATHB-1 we don't trust counts blindly).
    let edgeCount = -1;
    let edgeSample: unknown = null;
    try {
      const links = store.execIr([{ op: "graph_links" }]) as {
        nodes?: unknown[];
      };
      edgeCount = Array.isArray(links.nodes) ? links.nodes.length : -1;
      edgeSample = Array.isArray(links.nodes) ? links.nodes.slice(0, 2) : null;
    } catch (e) {
      edgeSample = String(e);
    }

    process.stdout.write(
      JSON.stringify({
        phase: "link",
        ok: true,
        seedId,
        siblingId,
        neighborIds,
        siblingIsNeighbor: neighborIds.includes(siblingId),
        edgeCount,
        edgeSample,
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

if (phase === "verify" || phase === "verify-strict") {
  (async () => {
    // Fresh process: lock released, edges must be durable on disk.
    // `verify-strict` raises vectorThreshold so the fuzzy vector recall does NOT
    // surface BETA directly (its baseline cosine ~0.63 < 0.80), forcing BETA to
    // arrive ONLY via graph expansion of the ALPHA seed — a clean end-to-end
    // proof that search() pulls associative neighbors in as via:"graph" hits.
    const vectorThreshold = phase === "verify-strict" ? 0.8 : undefined;
    const capability = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL, vectorThreshold });
    const { manager } = await capability.runtime!.getMemorySearchManager({
      cfg: {} as never,
      agentId: "smoke",
    });
    if (!manager) throw new Error("no manager");

    // Query matches ALPHA strongly; BETA's content (photosynthesis/...) is
    // disjoint so under a strict threshold it is NOT a direct hit. If BETA
    // appears, it can only have arrived via graph expansion (edge alpha<->beta).
    const hits = await manager.search("kraken deployment runbook", { maxResults: 5 });
    const beta = hits.find((h) => h.path === "mem:session:session-beta:0");
    const betaViaGraph = Boolean(beta && beta.citation?.includes("graph"));

    process.stdout.write(
      JSON.stringify({
        phase,
        ok: true,
        vectorThreshold: vectorThreshold ?? null,
        hitPaths: hits.map((h) => ({
          path: h.path,
          citation: h.citation,
          vScore: h.vectorScore,
          tScore: h.textScore,
        })),
        betaPresent: Boolean(beta),
        betaSurfacedViaGraph: betaViaGraph,
        betaCitation: beta?.citation ?? null,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(
      JSON.stringify({ phase: "verify", ok: false, error: String(err?.stack ?? err) }) + "\n",
    );
    process.exit(1);
  });
}
