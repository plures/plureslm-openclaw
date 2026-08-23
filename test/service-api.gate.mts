import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPluresLmHttpService } from "../src/service.js";

async function requestJson(
  url: string,
  path: string,
  body?: Record<string, unknown>,
  serviceToken?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (serviceToken) headers.authorization = `Bearer ${serviceToken}`;
  const response = await fetch(`${url}${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers,
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`non-json response ${response.status}: ${text}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return json as Record<string, unknown>;
}

const root = await mkdtemp(join(tmpdir(), "plureslm-service-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(
  join(sourceDir, "2026-07-17.md"),
  [
    "# Service gate memory",
    "",
    "ZEPHYR_SERVICE_BOUNDARY proves the PluresLM memory service can sync and search a real PluresDB-backed memory file.",
  ].join("\n"),
  "utf8",
);

const { server, url, token } = await startPluresLmHttpService(
  {
    dbPath,
    sourceDir,
    embeddingModel: "BAAI/bge-small-en-v1.5",
    maxResults: 5,
  },
  { port: 0 },
);
assert.ok(token, "service must require an authentication token by default");

try {
  const health = await requestJson(url, "/health");
  assert.equal(health.ok, true);
  assert.equal(health.provider, "plureslm");

  await requestJson(url, "/sync", { reason: "service-api-gate", force: true }, token);

  const search = await requestJson(url, "/search", {
    query: "ZEPHYR_SERVICE_BOUNDARY",
    maxResults: 5,
    corpus: "memory",
  }, token);
  assert.equal(search.provider, "plureslm");
  assert.equal(search.query, "ZEPHYR_SERVICE_BOUNDARY");
  assert.equal(typeof search.count, "number");
  assert.ok((search.count as number) > 0, "expected at least one real service-backed search hit");

  const first = (search.results as Array<Record<string, unknown>>)[0];
  assert.ok(first.path, "search hit should include path");
  assert.match(String(first.snippet), /ZEPHYR_SERVICE_BOUNDARY/);

  const get = await requestJson(url, "/get", { path: first.path, from: 1, lines: 5 }, token);
  assert.equal(get.provider, "plureslm");
  assert.match(JSON.stringify(get), /ZEPHYR_SERVICE_BOUNDARY/);

  const created = await requestJson(url, "/tasks", {
    title: "Verify the service task resource",
    description: "Created by the authenticated service gate.",
    labels: ["release", "service"],
    priority: 50,
  }, token);
  assert.equal(created.ok, true);
  const task = created.task as Record<string, unknown>;
  assert.match(String(task.id), /^orch:task:/);
  assert.equal(task.status, "queued");
  assert.deepEqual(task.labels, ["release", "service"]);

  const fetched = await requestJson(url, `/tasks/${encodeURIComponent(String(task.id))}`, undefined, token);
  assert.deepEqual(fetched.task, task);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SERVICE_API_GATE_OK");
