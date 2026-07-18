import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pluresLmPlugin from "../src/index.js";
import { createPluresLmServiceSearchManager } from "../src/service-client.js";
import { startPluresLmHttpService } from "../src/service.js";

const activeMemoryModule = await import("../node_modules/openclaw/dist/extensions/active-memory/index.js");
const activeMemoryPlugin = activeMemoryModule.default as { register(api: unknown): void };

type Tool = {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<unknown>;
};

type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

function parseToolJson(result: unknown): Record<string, unknown> {
  assert.ok(result && typeof result === "object" && !Array.isArray(result), "tool result object");
  const content = (result as Record<string, unknown>).content;
  assert.ok(Array.isArray(content), "tool result content array");
  const first = content[0] as Record<string, unknown> | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first.text, "string");
  return JSON.parse(first.text as string) as Record<string, unknown>;
}

const root = await mkdtemp(join(tmpdir(), "plureslm-active-memory-service-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
await mkdir(sourceDir, { recursive: true });
await writeFile(
  join(sourceDir, "2026-07-17.md"),
  [
    "# Active-memory service gate",
    "",
    "LYRA_ACTIVE_MEMORY_SERVICE proves OpenClaw active-memory embedded recall can resolve memory_search and read from the PluresLM service boundary.",
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
  const serviceManager = createPluresLmServiceSearchManager({ serviceUrl: url }).manager;
  await serviceManager.sync({ reason: "active-memory-service-embedded-gate", force: true });

  const toolFactories: Array<{ names?: string[]; factory: () => unknown }> = [];
  const hooks = new Map<string, Hook[]>();
  const sessionEntries = new Map<string, Record<string, unknown>>();
  const stateStore = new Map<string, Record<string, unknown>>();

  const baseConfig = {
    session: { mainKey: "main" },
    agents: {
      defaults: { workspace: root },
      entries: { main: { workspace: root, agentDir: join(root, "agent") } },
    },
    plugins: {
      slots: { memory: "plureslm" },
      entries: {
        plureslm: { enabled: true, config: { serviceUrl: url, maxResults: 5 } },
        "active-memory": {
          enabled: true,
          config: {
            enabled: true,
            agents: ["main"],
            model: "github-copilot/gpt-5.5",
            allowedChatTypes: ["direct"],
            queryMode: "message",
            timeoutMs: 5000,
            setupGraceTimeoutMs: 0,
            maxSummaryChars: 500,
            cacheTtlMs: 1000,
            logging: true,
          },
        },
      },
    },
  };

  const api = {
    config: baseConfig,
    pluginConfig: {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    registerMemoryCapability(_value: unknown) {},
    registerCommand(_value: unknown) {},
    registerTool(factory: () => unknown, options?: { names?: string[] }) {
      toolFactories.push({ factory, names: options?.names });
    },
    on(name: string, hook: Hook) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    },
    runtime: {
      config: { current: () => baseConfig },
      state: {
        resolveStateDir: () => root,
        openKeyedStore: () => ({
          async lookup(key: string) { return stateStore.get(key); },
          async register(key: string, value: Record<string, unknown>) { stateStore.set(key, value); },
          async delete(key: string) { stateStore.delete(key); },
        }),
      },
      agent: {
        session: {
          listSessionEntries: () => [...sessionEntries.entries()].map(([sessionKey, entry]) => ({ sessionKey, entry })),
          getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessionEntries.get(sessionKey),
          async patchSessionEntry({ sessionKey, update }: { sessionKey: string; update: (existing: Record<string, unknown>) => Record<string, unknown> }) {
            const existing = sessionEntries.get(sessionKey) ?? {};
            sessionEntries.set(sessionKey, { ...existing, ...update(existing) });
          },
        },
        async runEmbeddedAgent(params: {
          toolsAllow: string[];
          prompt: string;
          onAgentToolResult?: (event: Record<string, unknown>) => void;
        }) {
          const tools = new Map<string, Tool>();
          for (const entry of toolFactories) {
            const tool = entry.factory() as Tool | null;
            if (!tool) continue;
            const names = entry.names?.length ? entry.names : [tool.name];
            for (const name of names) tools.set(name, tool);
          }
          const allowed = params.toolsAllow.filter((name) => tools.has(name));
          if (allowed.length === 0) {
            throw new Error(`No callable tools remain after resolving explicit tool allowlist (runtime toolsAllow: ${params.toolsAllow.join(", ")}); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.`);
          }
          assert.ok(allowed.includes("memory_search"), "embedded active-memory run should resolve memory_search");
          const searchTool = tools.get("memory_search");
          assert.ok(searchTool, "memory_search should be registered");
          const toolResult = await searchTool.execute("active-memory-tool-call-1", {
            query: "LYRA_ACTIVE_MEMORY_SERVICE",
            maxResults: 5,
            corpus: "memory",
          });
          params.onAgentToolResult?.({ toolName: "memory_search", result: toolResult });
          const json = parseToolJson(toolResult);
          assert.ok((json.count as number) > 0, "service-backed memory_search should return a hit");
          const first = (json.results as Array<Record<string, unknown>>)[0];
          return {
            status: "ok",
            payloads: [{ text: `LYRA_ACTIVE_MEMORY_SERVICE: ${String(first.snippet)}` }],
          };
        },
      },
    },
  };

  const pluresApi = { ...api, pluginConfig: { serviceUrl: url, maxResults: 5 } };
  (pluresLmPlugin as unknown as { register(api: typeof pluresApi): void }).register(pluresApi);
  const activeApi = { ...api, pluginConfig: baseConfig.plugins.entries["active-memory"].config };
  activeMemoryPlugin.register(activeApi);

  const beforePromptHooks = hooks.get("before_prompt_build") ?? [];
  assert.equal(beforePromptHooks.length, 1, "active-memory should register one before_prompt_build hook");

  const sessionKey = "agent:main:telegram:direct:active-memory-service-gate";
  sessionEntries.set(sessionKey, {
    sessionId: "active-memory-service-gate-session",
    lastChannel: "telegram",
    origin: { provider: "telegram" },
    updatedAt: Date.now(),
  });

  const result = await beforePromptHooks[0](
    {
      prompt: "What should I remember about LYRA_ACTIVE_MEMORY_SERVICE?",
      messages: [{ role: "user", content: "What should I remember about LYRA_ACTIVE_MEMORY_SERVICE?" }],
    },
    {
      trigger: "user",
      sessionKey,
      sessionId: "active-memory-service-gate-session",
      messageProvider: "telegram",
      channelId: "telegram",
      modelProviderId: "github-copilot",
      modelId: "gpt-5.5",
    },
  ) as Record<string, unknown> | undefined;

  assert.ok(result, "active-memory hook should return prepended context");
  assert.equal(typeof result.prependContext, "string");
  assert.match(result.prependContext as string, /LYRA_ACTIVE_MEMORY_SERVICE/);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("ACTIVE_MEMORY_SERVICE_EMBEDDED_GATE_OK");
