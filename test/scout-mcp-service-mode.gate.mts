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
} finally {
  await mcp.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SCOUT_MCP_SERVICE_MODE_GATE_OK");
