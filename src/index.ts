/**
 * plureslm-openclaw — entry point.
 *
 * Registers a read+write memory capability backed by `@plures/pluresdb-native`.
 * Read surface: search / readFile / status / probes. Write surface: the memory
 * manager's `sync()` ingests session transcripts (and, on a forced rescan, an
 * optional configured `sourceDir`) into the store so they are recallable. The
 * write path additionally applies native HEADROOM token-compression to
 * oversized node bodies before persistence when `compressAboveTokens > 0`.
 * The registered capability now owns the full memory seam: prompt recall
 * guidance, memory-flush planning, and the exclusive runtime/search manager.
 *
 * Config (plugins.entries.plureslm.config):
 *   - dbPath:        absolute path to the PluresDB store directory
 *   - embeddingModel: HF model id (default BAAI/bge-small-en-v1.5)
 *   - vectorThreshold: cosine floor 0..1 (default 0.3)
 *   - maxResults:    default recall limit (default 8)
 *   - sourceDir:     optional absolute dir of memory-doc files ingested on a
 *                    force:true sync (session transcripts ingest regardless)
 *   - compressAboveTokens: token floor (>0) above which a node body is
 *                    compacted by native headroom `compressText` before
 *                    persistence; 0/unset disables it (bodies stored verbatim)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
  type PluresLmCapabilityConfig,
} from "./memory-capability.js";
import { createPluresLmServiceSearchManager } from "./service-client.js";

type PluresLmPluginConfig = {
  dbPath?: string;
  serviceUrl?: string;
  embeddingModel?: string;
  vectorThreshold?: number;
  maxResults?: number;
  sourceDir?: string;
  compressAboveTokens?: number;
  reactivePx?: boolean;
  reactivePxPolicy?: string;
};

function readConfig(raw: Record<string, unknown> | undefined): PluresLmPluginConfig {
  const cfg = raw ?? {};
  const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : undefined;
  const serviceUrl = typeof cfg.serviceUrl === "string" ? cfg.serviceUrl : undefined;
  const embeddingModel =
    typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : undefined;
  const vectorThreshold =
    typeof cfg.vectorThreshold === "number" ? cfg.vectorThreshold : undefined;
  const maxResults =
    typeof cfg.maxResults === "number" ? cfg.maxResults : undefined;
  const sourceDir = typeof cfg.sourceDir === "string" ? cfg.sourceDir : undefined;
  const compressAboveTokens =
    typeof cfg.compressAboveTokens === "number" ? cfg.compressAboveTokens : undefined;
  const reactivePx = typeof cfg.reactivePx === "boolean" ? cfg.reactivePx : undefined;
  const reactivePxPolicy =
    typeof cfg.reactivePxPolicy === "string" ? cfg.reactivePxPolicy : undefined;
  return { dbPath, serviceUrl, embeddingModel, vectorThreshold, maxResults, sourceDir, compressAboveTokens, reactivePx, reactivePxPolicy };
}

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
    corpus: { type: "string", enum: ["memory", "sessions", "all", "wiki"] },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
    corpus: { type: "string", enum: ["memory", "all", "wiki"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

function toolJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function resolveCapabilityConfig(cfg: PluresLmPluginConfig): PluresLmCapabilityConfig | null {
  if (!cfg.dbPath) return null;
  return {
    dbPath: cfg.dbPath,
    embeddingModel: cfg.embeddingModel ?? "BAAI/bge-small-en-v1.5",
    vectorThreshold: cfg.vectorThreshold,
    maxResults: cfg.maxResults,
    sourceDir: cfg.sourceDir,
    compressAboveTokens: cfg.compressAboveTokens,
    reactivePx: cfg.reactivePx,
    reactivePxPolicy: cfg.reactivePxPolicy,
  };
}

function sourceMatchesCorpus(
  source: "memory" | "sessions" | undefined,
  corpus: unknown,
): boolean {
  if (corpus === undefined || corpus === "all") return true;
  if (corpus === "wiki") return false;
  if (corpus === "memory") return source !== "sessions";
  if (corpus === "sessions") return source === "sessions";
  return true;
}

function createPluresLmSearchTool(cfg: PluresLmPluginConfig) {
  if (!cfg.serviceUrl && !cfg.dbPath) return null;
  return {
    label: "PluresLM Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search PluresLM memory before answering questions about prior work, decisions, dates, people, preferences, or todos.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId: string, toolParams: Record<string, unknown>) => {
      const query = typeof toolParams.query === "string" ? toolParams.query.trim() : "";
      if (!query) {
        return toolJson({ disabled: true, unavailable: true, error: "query required" });
      }

      const maxResults =
        typeof toolParams.maxResults === "number" && Number.isFinite(toolParams.maxResults)
          ? Math.max(1, Math.floor(toolParams.maxResults))
          : cfg.maxResults;
      const minScore =
        typeof toolParams.minScore === "number" && Number.isFinite(toolParams.minScore)
          ? toolParams.minScore
          : undefined;

      const directConfig = resolveCapabilityConfig(cfg);
      if (!cfg.serviceUrl && !directConfig) {
        return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
      }
      const { manager } = cfg.serviceUrl
        ? createPluresLmServiceSearchManager({ serviceUrl: cfg.serviceUrl })
        : createPluresLmSearchManager(directConfig!);
      const rawResults = await manager.search(query, { maxResults });
      const results = rawResults
        .filter((result) => minScore === undefined || result.score >= minScore)
        .filter((result) => sourceMatchesCorpus(result.source, toolParams.corpus))
        .map((result) => ({
          path: result.path,
          startLine: result.startLine,
          endLine: result.endLine,
          score: result.score,
          vectorScore: result.vectorScore,
          textScore: result.textScore,
          source: result.source,
          citation: result.citation,
          snippet: result.snippet,
        }));
      return toolJson({ provider: "plureslm", query, count: results.length, results });
    },
  };
}

function createPluresLmGetTool(cfg: PluresLmPluginConfig) {
  if (!cfg.serviceUrl && !cfg.dbPath) return null;
  return {
    label: "PluresLM Memory Get",
    name: "memory_get",
    description: "Read an exact PluresLM memory excerpt by path returned from memory_search.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId: string, toolParams: Record<string, unknown>) => {
      const relPath = typeof toolParams.path === "string" ? toolParams.path.trim() : "";
      if (!relPath) {
        return toolJson({ disabled: true, unavailable: true, error: "path required" });
      }
      if (toolParams.corpus === "wiki") {
        return toolJson({
          disabled: true,
          unavailable: true,
          error: "wiki corpus is not provided by plureslm",
        });
      }
      const from =
        typeof toolParams.from === "number" && Number.isFinite(toolParams.from)
          ? Math.max(1, Math.floor(toolParams.from))
          : undefined;
      const lines =
        typeof toolParams.lines === "number" && Number.isFinite(toolParams.lines)
          ? Math.max(1, Math.floor(toolParams.lines))
          : undefined;
      const directConfig = resolveCapabilityConfig(cfg);
      if (!cfg.serviceUrl && !directConfig) {
        return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
      }
      const { manager } = cfg.serviceUrl
        ? createPluresLmServiceSearchManager({ serviceUrl: cfg.serviceUrl })
        : createPluresLmSearchManager(directConfig!);
      const result = await manager.readFile({ relPath, from, lines });
      return toolJson({ provider: "plureslm", ...result });
    },
  };
}

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "plureslm",
  name: "PluresLM Memory",
  description:
    "Read+write memory capability for OpenClaw backed by @plures/pluresdb-native.",
  register(api) {
    const cfg = readConfig(api.pluginConfig);
    if (cfg.serviceUrl) {
      api.logger.info(
        `[plureslm] registering read+write memory capability through service ${cfg.serviceUrl}`,
      );
    } else if (cfg.dbPath) {
      api.logger.info(
        `[plureslm] registering read+write memory capability over ${cfg.dbPath}`,
      );
    } else {
      api.logger.warn(
        "[plureslm] no serviceUrl or dbPath configured; registering an inert memory capability.",
      );
    }
    api.registerMemoryCapability(buildMemoryCapability(cfg));
    api.registerTool(() => createPluresLmSearchTool(cfg), { names: ["memory_search"] });
    api.registerTool(() => createPluresLmGetTool(cfg), { names: ["memory_get"] });
  },
});

export default plugin;
