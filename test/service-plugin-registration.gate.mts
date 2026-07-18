import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../src/index.js";
import { startPluresLmHttpService } from "../src/service.js";

type RegisteredTool = {
  names?: string[];
  factory: (...args: unknown[]) => unknown;
};

function parseToolResult(result: unknown): Record<string, unknown> {
  assert.ok(result && typeof result === "object" && !Array.isArray(result), "tool result should be object");
  const content = (result as Record<string, unknown>).content;
  assert.ok(Array.isArray(content), "tool result should include content array");
  const first = content[0] as Record<string, unknown> | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first.text, "string");
  return JSON.parse(first.text as string) as Record<string, unknown>;
}

const root = await mkdtemp(join(tmpdir(), "plureslm-service-plugin-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(
  join(sourceDir, "2026-07-17.md"),
  [
    "# Service plugin gate memory",
    "",
    "ORION_PLUGIN_SERVICE proves registered OpenClaw memory_search and memory_get tools can call the PluresLM service boundary.",
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
  const tools: RegisteredTool[] = [];
  let memoryCapability: unknown;
  const api = {
    pluginConfig: { serviceUrl: url, maxResults: 5 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerMemoryCapability(value: unknown) {
      memoryCapability = value;
    },
    registerTool(factory: (...args: unknown[]) => unknown, options?: { names?: string[] }) {
      tools.push({ factory, names: options?.names });
    },
  };

  (plugin as unknown as { register(api: typeof api): void }).register(api);
  assert.ok(memoryCapability, "plugin should register memory capability");

  const searchFactory = tools.find((tool) => tool.names?.includes("memory_search"))?.factory;
  const getFactory = tools.find((tool) => tool.names?.includes("memory_get"))?.factory;
  assert.ok(searchFactory, "plugin should register memory_search");
  assert.ok(getFactory, "plugin should register memory_get");

  const capabilityRuntime = (memoryCapability as { runtime?: { getMemorySearchManager?: () => Promise<{ manager: unknown }> } }).runtime;
  const runtimeResult = await capabilityRuntime?.getMemorySearchManager?.();
  assert.ok(runtimeResult?.manager, "serviceUrl memory capability should provide a manager");
  const manager = runtimeResult.manager as { sync(params: { reason: string; force: boolean }): Promise<void> };
  await manager.sync({ reason: "service-plugin-registration-gate", force: true });

  const searchTool = searchFactory() as { execute(id: string, params: Record<string, unknown>): Promise<unknown> };
  const searchJson = parseToolResult(await searchTool.execute("tool-call-1", {
    query: "ORION_PLUGIN_SERVICE",
    maxResults: 5,
    corpus: "memory",
  }));
  assert.equal(searchJson.provider, "plureslm");
  assert.ok((searchJson.count as number) > 0, "expected registered memory_search to return service-backed hit");
  const first = (searchJson.results as Array<Record<string, unknown>>)[0];
  assert.match(String(first.snippet), /ORION_PLUGIN_SERVICE/);

  const getTool = getFactory() as { execute(id: string, params: Record<string, unknown>): Promise<unknown> };
  const getJson = parseToolResult(await getTool.execute("tool-call-2", {
    path: first.path,
    from: 1,
    lines: 5,
  }));
  assert.equal(getJson.provider, "plureslm");
  assert.match(JSON.stringify(getJson), /ORION_PLUGIN_SERVICE/);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SERVICE_PLUGIN_REGISTRATION_GATE_OK");
