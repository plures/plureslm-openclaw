import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startPluresLmHttpService } from "../src/service.js";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function encodeMessage(message: Record<string, unknown>): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

class ScoutMcpClient {
  readonly child;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(script: string, args: string[]) {
    this.child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.#consume(Buffer.from(chunk)));
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.#rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.#rejectAll(new Error(`Scout MCP exited before completing request (code=${code}, signal=${signal})`));
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    return result;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(match[1]);
      if (this.#buffer.length < bodyEnd) return;
      const message = JSON.parse(this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonRpcResponse;
      this.#buffer = this.#buffer.subarray(bodyEnd);
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Scout MCP error"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function toolPayload(result: unknown): Record<string, unknown> {
  assert.ok(result && typeof result === "object" && !Array.isArray(result));
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content) && content.length > 0);
  const text = content[0] as { type?: unknown; text?: unknown };
  assert.equal(text.type, "text");
  assert.equal(typeof text.text, "string");
  return JSON.parse(text.text as string) as Record<string, unknown>;
}

const root = await mkdtemp(join(tmpdir(), "plureslm-scout-service-mode-gate-"));
const dbPath = join(root, "service-store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(join(sourceDir, "scout.md"), "SCOUT_SERVICE_MODE_MEMORY\n", "utf8");

const { server, url, token } = await startPluresLmHttpService(
  { dbPath, sourceDir, embeddingModel: "BAAI/bge-small-en-v1.5", maxResults: 5 },
  { port: 0, token: "scout-service-mode-token" },
);
assert.equal(token, "scout-service-mode-token");

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcp = new ScoutMcpClient(join(repoRoot, "scout-mcp", "plureslm-mcp.mjs"), [
  "--repo-root", repoRoot,
  "--service-url", url,
  "--service-token", token,
  "--db-path", join(root, "must-not-open-directly"),
]);

try {
  await mcp.request("initialize", { protocolVersion: "2024-11-05" });
  const toolList = await mcp.request("tools/list") as { tools?: Array<{ name?: string }> };
  assert.ok(
    !toolList.tools?.some((tool) => tool.name === "plures_task_decision_resolve"),
    "Scout MCP must not expose user decision resolution as an agent-callable tool",
  );
  const sync = toolPayload(await mcp.request("tools/call", {
    name: "plures_sync",
    arguments: { force: true },
  }));
  assert.equal(sync.backend, "service");
  assert.equal(sync.ok, true);

  const recall = toolPayload(await mcp.request("tools/call", {
    name: "plures_recall",
    arguments: { query: "SCOUT_SERVICE_MODE_MEMORY", maxResults: 5 },
  }));
  assert.equal(recall.backend, "service");
  assert.equal(recall.graphAvailable, false);
  const first = (recall.results as Array<Record<string, unknown>>)[0];
  assert.ok(first?.path, "service-backed recall must expose an addressable path");
  assert.match(String(first.snippet), /SCOUT_SERVICE_MODE_MEMORY/);

  const read = toolPayload(await mcp.request("tools/call", {
    name: "plures_read",
    arguments: { path: first.path, from: 1, lines: 3 },
  }));
  assert.equal(read.backend, "service");
  assert.match(JSON.stringify(read), /SCOUT_SERVICE_MODE_MEMORY/);

  const created = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_create",
    arguments: {
      title: "Verify Scout task creation",
      labels: ["scout", "service-mode"],
      priority: 25,
    },
  }));
  assert.equal(created.backend, "service");
  const task = created.task as Record<string, unknown>;
  assert.match(String(task.id), /^orch:task:/);
  assert.equal(task.status, "queued");
  assert.deepEqual(task.labels, ["scout", "service-mode"]);

  const readTask = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_get",
    arguments: { taskId: task.id },
  }));
  assert.equal((readTask.task as Record<string, unknown>).status, "queued");

  const ready = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_transition",
    arguments: { taskId: task.id, status: "ready", actor: "scout" },
  }));
  assert.equal((ready.task as Record<string, unknown>).status, "ready");
  const inProgress = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_transition",
    arguments: { taskId: task.id, status: "in_progress", actor: "scout" },
  }));
  assert.equal((inProgress.task as Record<string, unknown>).status, "in_progress");

  const evidence = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_evidence",
    arguments: {
      taskId: task.id,
      kind: "tool_result",
      summary: "Scout MCP service mode gate completed.",
      source: "scout-mcp-service-mode.gate",
    },
  }));
  assert.match(String((evidence.evidence as Record<string, unknown>).id), /^orch:evidence:/);

  const requested = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_decision_request",
    arguments: {
      taskId: task.id,
      question: "Use the safe route?",
      options: ["yes", "no"],
    },
  }));
  const decision = requested.decision as Record<string, unknown>;
  assert.equal((requested.task as Record<string, unknown>).status, "waiting_for_user");

  const blockedResolution = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_decision_resolve",
    arguments: { decisionId: decision.id, answer: "yes", actor: "user" },
  }));
  assert.match(String(blockedResolution.error), /Unknown tool/);

  const events = toolPayload(await mcp.request("tools/call", {
    name: "plures_task_events",
    arguments: { taskId: task.id, limit: 2 },
  }));
  assert.equal((events.events as Array<unknown>).length, 2);
  assert.equal(events.limit, 2);
  assert.equal(typeof events.nextCursor, "string");
} finally {
  await mcp.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SCOUT_MCP_SERVICE_MODE_GATE_OK");
