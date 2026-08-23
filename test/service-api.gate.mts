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

  const createResponse = await fetch(`${url}/tasks`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Verify the service task resource",
      description: "Created by the authenticated service gate.",
      labels: ["release", "service"],
      priority: 50,
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = JSON.parse(await createResponse.text()) as Record<string, unknown>;
  assert.equal(created.ok, true);
  const task = created.task as Record<string, unknown>;
  assert.match(String(task.id), /^orch:task:/);
  assert.equal(task.status, "queued");
  assert.deepEqual(task.labels, ["release", "service"]);
  assert.equal(createResponse.headers.get("location"), `/tasks/${encodeURIComponent(String(task.id))}`);

  const fetched = await requestJson(url, `/tasks/${encodeURIComponent(String(task.id))}`, undefined, token);
  assert.deepEqual(fetched.task, task);

  const taskPath = `/tasks/${encodeURIComponent(String(task.id))}`;
  const ready = await requestJson(url, `${taskPath}/transition`, { status: "ready", actor: "scout" }, token);
  assert.equal((ready.task as Record<string, unknown>).status, "ready");
  const inProgress = await requestJson(url, `${taskPath}/transition`, { status: "in_progress", actor: "scout" }, token);
  assert.equal((inProgress.task as Record<string, unknown>).status, "in_progress");

  const prematureDone = await fetch(`${url}${taskPath}/transition`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "done", actor: "scout" }),
  });
  assert.equal(prematureDone.status, 400, "PX must refuse completion without evidence");

  const evidence = await requestJson(url, `${taskPath}/evidence`, {
    kind: "test_result",
    summary: "Focused service gate passed.",
    source: "service-api.gate",
    actor: "scout",
  }, token);
  assert.match(String((evidence.evidence as Record<string, unknown>).id), /^orch:evidence:/);
  assert.equal((evidence.task as Record<string, unknown>).evidenceCount, 1);

  const requested = await requestJson(url, `${taskPath}/decision-requests`, {
    question: "Which execution path should Scout use?",
    options: ["safe", "fast"],
    actor: "scout",
  }, token);
  const decision = requested.decision as Record<string, unknown>;
  assert.match(String(decision.id), /^orch:decision:/);
  assert.equal((requested.task as Record<string, unknown>).status, "waiting_for_user");

  const resolved = await requestJson(url, `/decision-requests/${encodeURIComponent(String(decision.id))}/resolve`, {
    answer: "safe",
    actor: "user",
  }, token);
  assert.equal((resolved.decision as Record<string, unknown>).status, "resolved");
  assert.equal((resolved.task as Record<string, unknown>).status, "ready");

  await requestJson(url, `${taskPath}/transition`, { status: "in_progress", actor: "scout" }, token);
  const completed = await requestJson(url, `${taskPath}/transition`, { status: "done", actor: "scout" }, token);
  assert.equal((completed.task as Record<string, unknown>).status, "done");

  const events = await requestJson(url, `${taskPath}/events`, undefined, token);
  const eventTypes = (events.events as Array<Record<string, unknown>>).map((event) => event.eventType);
  assert.deepEqual(eventTypes, [
    "task_created",
    "task_transitioned",
    "task_transitioned",
    "evidence_added",
    "decision_requested",
    "decision_resolved",
    "task_transitioned",
    "task_transitioned",
  ]);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SERVICE_API_GATE_OK");
