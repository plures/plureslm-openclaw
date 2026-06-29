/**
 * Child worker for the recall gate. Runs in its OWN process so the PluresDB
 * exclusive file lock is released between phases (seed -> write -> read).
 *
 * Usage:  tsx test/store-child.mts <dir> <seed|write|read>
 *
 * `seed`  : write a known set of memories via the test seeder, print stats JSON.
 * `write` : ingest a tmp session file through the SHIPPED write path
 *           (buildMemoryCapability -> getMemorySearchManager -> manager.sync()),
 *           print the resulting stats + written-delta JSON. This is the REAL
 *           write path the host drives, NOT seedStoreForTests.
 * `read`  : open via the typed capability read path, recall a known query,
 *           print a JSON result the parent test asserts on.
 *
 * Note: the `seed` phase uses the test-only seeder (fixture setup is not part
 * of the shipped read surface). The `write` and `read` phases go through the
 * real plugin path (buildMemoryCapability -> getMemorySearchManager).
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
// Import the BUILT runtime artifact (dist), not the TS source, so the gate
// exercises exactly what ships. `dist/api.js` is the compiled named-export
// barrel produced by `tsc` from src/api.ts.
import { buildMemoryCapability, seedStoreForTests } from "../dist/api.js";

const require = createRequire(import.meta.url);

const dir = process.argv[2];
const phase = process.argv[3];

if (!dir || (phase !== "seed" && phase !== "write" && phase !== "read")) {
  console.error("usage: tsx test/store-child.mts <dir> <seed|write|read>");
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

// The sentinel phrase the write->recall round-trip (GATE C) ingests and then
// recalls. It is a CONTIGUOUS phrase so the native substring/phrase text search
// finds it deterministically even when the vector index is unavailable in the
// test env (the write path's `put` is text-searchable regardless of embeddings).
// The leading token is distinctive (won't collide with the praxis_constraint
// baseline nodes the native bootstraps into every fresh store).
export const WRITE_SENTINEL =
  "ZQX7731SENTINEL the migration runbook lives in the encrypted ops vault";
// A contiguous sub-phrase of the sentinel used as the recall query.
export const WRITE_QUERY = "migration runbook lives in the encrypted ops vault";

if (phase === "write") {
  // Exercise the REAL, SHIPPED write path:
  //   buildMemoryCapability -> getMemorySearchManager -> manager.sync()
  // (NOT seedStoreForTests). A tmp session file with the known sentinel is
  // written into `dir` and ingested via sync({ sessionFiles }); we print the
  // resulting stats + the node-count delta. Runs in its own process so the
  // exclusive lock is released before the read child opens.
  (async () => {
    const capability = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    if (!capability.runtime) throw new Error("capability.runtime missing");
    const { manager, error } = await capability.runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "test-agent",
    });
    if (!manager) {
      process.stdout.write(
        JSON.stringify({ phase: "write", ok: false, error: error ?? "no manager" }) + "\n",
      );
      process.exit(1);
    }
    if (typeof manager.sync !== "function") {
      process.stdout.write(
        JSON.stringify({ phase: "write", ok: false, error: "manager.sync is not a function" }) + "\n",
      );
      process.exit(1);
    }

    const before = manager.status();
    const sessionFile = join(dir, "session-gateC.md");
    writeFileSync(
      sessionFile,
      `# session transcript (GATE C)\n\n${WRITE_SENTINEL}\n\nsome unrelated trailing chatter that should not match the query.\n`,
      "utf8",
    );

    let progressCalls = 0;
    await manager.sync({
      reason: "test",
      force: false,
      sessionFiles: [sessionFile],
      progress: () => {
        progressCalls += 1;
      },
    });

    const after = manager.status();
    process.stdout.write(
      JSON.stringify({
        phase: "write",
        ok: true,
        sessionFile,
        beforeTotalNodes: before.chunks,
        afterTotalNodes: after.chunks,
        delta: (after.chunks ?? 0) - (before.chunks ?? 0),
        progressCalls,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(
      JSON.stringify({ phase: "write", ok: false, error: String(err?.stack ?? err) }) + "\n",
    );
    process.exit(1);
  });
}

// phase === "read": go through the REAL plugin read path.
// An optional 4th CLI arg overrides the recall query (GATE C passes the
// sentinel sub-phrase; GATE B relies on the default below). Guarded by an
// explicit phase check because the `write` phase above runs asynchronously and
// must NOT fall through into this block.
if (phase === "read") {
  const query = process.argv[4] || "long-term memory storage";
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
    const hits = await manager.search(query, { maxResults: 5 });
    const backendCfg = capability.runtime.resolveMemoryBackendConfig({
      cfg: {} as never,
      agentId: "test-agent",
    });
    process.stdout.write(
      JSON.stringify({
        phase: "read",
        ok: true,
        query,
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
}
