import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluresLmServiceSearchManager } from "../src/service-client.js";
import { startPluresLmHttpService } from "../src/service.js";

const root = await mkdtemp(join(tmpdir(), "plureslm-service-client-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(
  join(sourceDir, "2026-07-17.md"),
  [
    "# Service client gate memory",
    "",
    "ASTER_SERVICE_CLIENT proves the OpenClaw adapter can use the PluresLM service instead of opening PluresDB directly.",
  ].join("\n"),
  "utf8",
);

const { server, url } = await startPluresLmHttpService(
  {
    dbPath,
    sourceDir,
    embeddingModel: "BAAI/bge-small-en-v1.5",
    maxResults: 5,
  },
  { port: 0 },
);

try {
  const { manager } = createPluresLmServiceSearchManager({ serviceUrl: url });
  await manager.sync({ reason: "service-client-gate", force: true });

  const search = await manager.search("ASTER_SERVICE_CLIENT", { maxResults: 5 });
  assert.ok(search.length > 0, "expected service-backed manager search hit");
  assert.match(String(search[0].snippet), /ASTER_SERVICE_CLIENT/);
  assert.ok(search[0].path, "service-backed search hit should include path");

  const read = await manager.readFile({ relPath: String(search[0].path), from: 1, lines: 5 });
  assert.match(JSON.stringify(read), /ASTER_SERVICE_CLIENT/);

  const embedding = await manager.probeEmbeddingAvailability();
  assert.equal(typeof embedding.ok, "boolean");
  assert.equal(typeof await manager.probeVectorAvailability(), "boolean");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SERVICE_CLIENT_GATE_OK");
