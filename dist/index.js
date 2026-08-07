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
import { buildMemoryCapability, createPluresLmSearchManager, } from "./memory-capability.js";
import { createPluresLmServiceSearchManager } from "./service-client.js";
import { PluresLmStore } from "./pluresdb.js";
import { DEFAULT_DREAMING_CONFIG, dreamExplain, dreamScheduleTimers, dreamStatus, dreamTick, isStagedCandidateId, } from "./dreaming.js";
function readConfig(raw) {
    const cfg = raw ?? {};
    const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : undefined;
    const serviceUrl = typeof cfg.serviceUrl === "string" ? cfg.serviceUrl : undefined;
    const embeddingModel = typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : undefined;
    const vectorThreshold = typeof cfg.vectorThreshold === "number" ? cfg.vectorThreshold : undefined;
    const maxResults = typeof cfg.maxResults === "number" ? cfg.maxResults : undefined;
    const sourceDir = typeof cfg.sourceDir === "string" ? cfg.sourceDir : undefined;
    const compressAboveTokens = typeof cfg.compressAboveTokens === "number" ? cfg.compressAboveTokens : undefined;
    const reactivePx = typeof cfg.reactivePx === "boolean" ? cfg.reactivePx : undefined;
    const reactivePxPolicy = typeof cfg.reactivePxPolicy === "string" ? cfg.reactivePxPolicy : undefined;
    const dreaming = typeof cfg.dreaming === "boolean" ? cfg.dreaming : undefined;
    const dreamingIngestIntervalSecs = typeof cfg.dreamingIngestIntervalSecs === "number" ? cfg.dreamingIngestIntervalSecs : undefined;
    const dreamingScoreIntervalSecs = typeof cfg.dreamingScoreIntervalSecs === "number" ? cfg.dreamingScoreIntervalSecs : undefined;
    return { dbPath, serviceUrl, embeddingModel, vectorThreshold, maxResults, sourceDir, compressAboveTokens, reactivePx, reactivePxPolicy, dreaming, dreamingIngestIntervalSecs, dreamingScoreIntervalSecs };
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
};
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
};
const DreamExplainSchema = {
    type: "object",
    properties: { candidateId: { type: "string", minLength: 1 } },
    required: ["candidateId"],
    additionalProperties: false,
};
const DreamStatusSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
};
function toolJson(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: value,
    };
}
function resolveCapabilityConfig(cfg) {
    if (!cfg.dbPath)
        return null;
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
function resolveDreamingConfig(cfg) {
    return {
        ...DEFAULT_DREAMING_CONFIG,
        enabled: cfg.dreaming ?? DEFAULT_DREAMING_CONFIG.enabled,
        ingest: {
            intervalSecs: typeof cfg.dreamingIngestIntervalSecs === "number" && cfg.dreamingIngestIntervalSecs > 0
                ? Math.floor(cfg.dreamingIngestIntervalSecs)
                : DEFAULT_DREAMING_CONFIG.ingest.intervalSecs,
        },
        score: {
            ...DEFAULT_DREAMING_CONFIG.score,
            intervalSecs: typeof cfg.dreamingScoreIntervalSecs === "number" && cfg.dreamingScoreIntervalSecs > 0
                ? Math.floor(cfg.dreamingScoreIntervalSecs)
                : DEFAULT_DREAMING_CONFIG.score.intervalSecs,
        },
    };
}
function sourceMatchesCorpus(source, corpus) {
    if (corpus === undefined || corpus === "all")
        return true;
    if (corpus === "wiki")
        return false;
    if (corpus === "memory")
        return source !== "sessions";
    if (corpus === "sessions")
        return source === "sessions";
    return true;
}
function createPluresLmSearchTool(cfg) {
    if (!cfg.serviceUrl && !cfg.dbPath)
        return null;
    return {
        label: "PluresLM Memory Search",
        name: "memory_search",
        description: "Mandatory recall step: semantically search PluresLM memory before answering questions about prior work, decisions, dates, people, preferences, or todos.",
        parameters: MemorySearchSchema,
        execute: async (_toolCallId, toolParams) => {
            const query = typeof toolParams.query === "string" ? toolParams.query.trim() : "";
            if (!query) {
                return toolJson({ disabled: true, unavailable: true, error: "query required" });
            }
            const maxResults = typeof toolParams.maxResults === "number" && Number.isFinite(toolParams.maxResults)
                ? Math.max(1, Math.floor(toolParams.maxResults))
                : cfg.maxResults;
            const minScore = typeof toolParams.minScore === "number" && Number.isFinite(toolParams.minScore)
                ? toolParams.minScore
                : undefined;
            const directConfig = resolveCapabilityConfig(cfg);
            if (!cfg.serviceUrl && !directConfig) {
                return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
            }
            const { manager } = cfg.serviceUrl
                ? createPluresLmServiceSearchManager({ serviceUrl: cfg.serviceUrl })
                : createPluresLmSearchManager(directConfig);
            const rawResults = await manager.search(query, { maxResults });
            const results = rawResults
                // Staged Dreaming material is private until Score promotes it. Filter
                // before corpus/min-score checks so graph-expanded candidates cannot leak.
                .filter((result) => !isStagedCandidateId(result.path))
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
function createDreamStatusTool(cfg) {
    if (!cfg.dbPath)
        return null;
    return {
        label: "PluresLM Dreaming Status",
        name: "plureslm_dream_status",
        description: "Show real Dreaming checkpoints, scheduled timer eligibility, candidate counts, and the deferred Reflect phase.",
        parameters: DreamStatusSchema,
        execute: async () => {
            const directConfig = resolveCapabilityConfig(cfg);
            const store = PluresLmStore.open(directConfig);
            const dreaming = resolveDreamingConfig(cfg);
            if (dreaming.enabled) {
                dreamScheduleTimers(store, dreaming);
                dreamTick(store, dreaming);
            }
            return toolJson(dreamStatus(store, dreaming));
        },
    };
}
function createDreamExplainTool(cfg) {
    if (!cfg.dbPath)
        return null;
    return {
        label: "PluresLM Dreaming Explain",
        name: "plureslm_dream_explain",
        description: "Explain a Dreaming candidate from its persisted computed signals and promotion thresholds.",
        parameters: DreamExplainSchema,
        execute: async (_toolCallId, toolParams) => {
            const candidateId = typeof toolParams.candidateId === "string" ? toolParams.candidateId.trim() : "";
            if (!candidateId)
                return toolJson({ unavailable: true, error: "candidateId required" });
            const store = PluresLmStore.open(resolveCapabilityConfig(cfg));
            return toolJson(dreamExplain(store, candidateId, resolveDreamingConfig(cfg)));
        },
    };
}
function createPluresLmGetTool(cfg) {
    if (!cfg.serviceUrl && !cfg.dbPath)
        return null;
    return {
        label: "PluresLM Memory Get",
        name: "memory_get",
        description: "Read an exact PluresLM memory excerpt by path returned from memory_search.",
        parameters: MemoryGetSchema,
        execute: async (_toolCallId, toolParams) => {
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
            const from = typeof toolParams.from === "number" && Number.isFinite(toolParams.from)
                ? Math.max(1, Math.floor(toolParams.from))
                : undefined;
            const lines = typeof toolParams.lines === "number" && Number.isFinite(toolParams.lines)
                ? Math.max(1, Math.floor(toolParams.lines))
                : undefined;
            const directConfig = resolveCapabilityConfig(cfg);
            if (!cfg.serviceUrl && !directConfig) {
                return toolJson({ disabled: true, unavailable: true, error: "serviceUrl or dbPath not configured" });
            }
            const { manager } = cfg.serviceUrl
                ? createPluresLmServiceSearchManager({ serviceUrl: cfg.serviceUrl })
                : createPluresLmSearchManager(directConfig);
            const result = await manager.readFile({ relPath, from, lines });
            return toolJson({ provider: "plureslm", ...result });
        },
    };
}
const plugin = definePluginEntry({
    id: "plureslm",
    name: "PluresLM Memory",
    description: "Read+write memory capability for OpenClaw backed by @plures/pluresdb-native.",
    register(api) {
        const cfg = readConfig(api.pluginConfig);
        if (cfg.serviceUrl) {
            api.logger.info(`[plureslm] registering read+write memory capability through service ${cfg.serviceUrl}`);
        }
        else if (cfg.dbPath) {
            api.logger.info(`[plureslm] registering read+write memory capability over ${cfg.dbPath}`);
        }
        else {
            api.logger.warn("[plureslm] no serviceUrl or dbPath configured; registering an inert memory capability.");
        }
        api.registerMemoryCapability(buildMemoryCapability(cfg));
        api.registerTool(() => createPluresLmSearchTool(cfg), { names: ["memory_search"] });
        api.registerTool(() => createPluresLmGetTool(cfg), { names: ["memory_get"] });
        api.registerTool(() => createDreamStatusTool(cfg), { names: ["plureslm_dream_status"] });
        api.registerTool(() => createDreamExplainTool(cfg), { names: ["plureslm_dream_explain"] });
    },
});
export default plugin;
//# sourceMappingURL=index.js.map