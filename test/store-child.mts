/**
 * Child worker for the recall gate. Runs in its OWN process so the PluresDB
 * exclusive file lock is released between phases (seed -> read).
 *
 * Usage:  tsx test/store-child.mts <dir> <seed|read>
 *
 * `seed`  : write a known set of memories via the native, print stats JSON.
 * `read`  : open via the typed capability read path, recall a known query,
 *           print a JSON result the parent test asserts on.
 *
 * Note: the `seed` phase uses the native `put` directly (test fixture setup is
 * not part of the shipped read-only surface). The `read` phase goes through the
 * real plugin read path (buildMemoryCapability -> getMemorySearchManager).
 */

import { createRequire } from "node:module";
// Import the BUILT runtime artifact (dist), not the TS source, so the gate
// exercises exactly what ships. `dist/api.js` is the compiled named-export
// barrel produced by `tsc` from src/api.ts.
import { buildMemoryCapability, seedStoreForTests } from "../dist/api.js";

const require = createRequire(import.meta.url);

const dir = process.argv[2];
const phase = process.argv[3];

if (!dir || (phase !== "seed" && phase !== "read")) {
  console.error("usage: tsx test/store-child.mts <dir> <seed|read>");
  process.exit(2);
}

const SEED = [
  {
    id: "mem-pref-1",
    data: {
      category: "preference",
      content: "user prefers dark mode and concise answers",
      tags: ["ui"],
    },
  },
  {
    id: "mem-dec-1",
    data: {
      category: "decision",
      content: "use PluresDB native for long-term memory storage",
      tags: ["architecture"],
    },
  },
  {
    id: "mem-ent-1",
    data: {
      category: "entity",
      content: "kbristol works at Microsoft on Azure Local",
      tags: ["person"],
    },
  },
];

const MODEL = "BAAI/bge-small-en-v1.5";

if (phase === "seed") {
  // Fixture setup only — routed through the same native binding resolver as the
  // read path, and seeded WITH embeddings so vector recall is exercised.
  const { totalNodes } = seedStoreForTests(
    dir,
    SEED.map((n) => ({
      id: n.id,
      data: n.data,
      text: String((n.data as { content?: string }).content ?? n.id),
    })),
    MODEL,
  );
  process.stdout.write(
    JSON.stringify({ phase: "seed", stats: { totalNodes } }) + "\n",
  );
  process.exit(0);
}

// phase === "read": go through the REAL plugin read path.
(async () => {
  const capability = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  if (!capability.runtime) throw new Error("capability.runtime missing");
  const { manager, error } = await capability.runtime.getMemorySearchManager({
    // cfg/agentId are required by the contract but unused by our runtime.
    cfg: {} as never,
    agentId: "test-agent",
  });
  if (!manager) {
    process.stdout.write(
      JSON.stringify({ phase: "read", ok: false, error: error ?? "no manager" }) + "\n",
    );
    process.exit(1);
  }
  const status = manager.status();
  const hits = await manager.search("long-term memory storage", { maxResults: 5 });
  const backendCfg = capability.runtime.resolveMemoryBackendConfig({
    cfg: {} as never,
    agentId: "test-agent",
  });
  process.stdout.write(
    JSON.stringify({
      phase: "read",
      ok: true,
      backend: backendCfg.backend,
      statusTotalNodes: status.chunks,
      statusProvider: status.provider,
      statusModel: status.model,
      hitCount: hits.length,
      hits: hits.map((h) => ({
        path: h.path,
        score: h.score,
        snippet: h.snippet,
        source: h.source,
        citation: h.citation,
        via: h.vectorScore !== undefined ? "vector" : "text",
      })),
    }) + "\n",
  );
  process.exit(0);
})().catch((err) => {
  process.stdout.write(
    JSON.stringify({ phase: "read", ok: false, error: String(err?.stack ?? err) }) + "\n",
  );
  process.exit(1);
});
