import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPluresLmHttpService } from "../src/service.js";

async function request(
  url: string,
  path: string,
  token?: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${url}${path}`, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers,
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

const root = await mkdtemp(join(tmpdir(), "plureslm-service-auth-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(join(sourceDir, "auth.md"), "AUTHENTICATED_SERVICE_MEMORY\n", "utf8");

const { server, url, token } = await startPluresLmHttpService(
  { dbPath, sourceDir, embeddingModel: "BAAI/bge-small-en-v1.5" },
  { port: 0, token: "service-auth-gate-token" },
);
assert.equal(token, "service-auth-gate-token");

try {
  const health = await request(url, "/health");
  assert.equal(health.status, 200, "health remains a liveness-only unauthenticated endpoint");

  for (const [path, body] of [
    ["/status", undefined],
    ["/search", { query: "AUTHENTICATED_SERVICE_MEMORY" }],
    ["/get", { path: "auth.md" }],
    ["/sync", { reason: "auth-gate" }],
    ["/tasks", { title: "Authentication gate task" }],
  ] as const) {
    const missing = await request(url, path, undefined, body);
    assert.equal(missing.status, 401, `${path} must reject a missing token`);
    assert.equal(missing.body.error, "unauthorized");
    const wrong = await request(url, path, "wrong-token", body);
    assert.equal(wrong.status, 401, `${path} must reject a wrong token`);
  }

  const missingTask = await request(url, "/tasks/orch:task:missing");
  assert.equal(missingTask.status, 401, "task reads must reject a missing token");
  const wrongTask = await request(url, "/tasks/orch:task:missing", "wrong-token");
  assert.equal(wrongTask.status, 401, "task reads must reject a wrong token");

  const sync = await request(url, "/sync", token, { reason: "auth-gate", force: true });
  assert.equal(sync.status, 200);
  const search = await request(url, "/search", token, {
    query: "AUTHENTICATED_SERVICE_MEMORY",
    maxResults: 5,
  });
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.results) && search.body.results.length > 0);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SERVICE_AUTH_GATE_OK");
