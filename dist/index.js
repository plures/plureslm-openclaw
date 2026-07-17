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
import { buildMemoryCapability } from "./memory-capability.js";
function readConfig(raw) {
    const cfg = raw ?? {};
    const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : undefined;
    const embeddingModel = typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : undefined;
    const vectorThreshold = typeof cfg.vectorThreshold === "number" ? cfg.vectorThreshold : undefined;
    const maxResults = typeof cfg.maxResults === "number" ? cfg.maxResults : undefined;
    const sourceDir = typeof cfg.sourceDir === "string" ? cfg.sourceDir : undefined;
    const compressAboveTokens = typeof cfg.compressAboveTokens === "number" ? cfg.compressAboveTokens : undefined;
    const reactivePx = typeof cfg.reactivePx === "boolean" ? cfg.reactivePx : undefined;
    const reactivePxPolicy = typeof cfg.reactivePxPolicy === "string" ? cfg.reactivePxPolicy : undefined;
    return { dbPath, embeddingModel, vectorThreshold, maxResults, sourceDir, compressAboveTokens, reactivePx, reactivePxPolicy };
}
const plugin = definePluginEntry({
    id: "plureslm",
    name: "PluresLM Memory",
    description: "Read+write memory capability for OpenClaw backed by @plures/pluresdb-native.",
    register(api) {
        const cfg = readConfig(api.pluginConfig);
        if (!cfg.dbPath) {
            api.logger.warn("[plureslm] no dbPath configured; registering an inert memory capability.");
        }
        else {
            api.logger.info(`[plureslm] registering read+write memory capability over ${cfg.dbPath}`);
        }
        api.registerMemoryCapability(buildMemoryCapability(cfg));
    },
});
export default plugin;
//# sourceMappingURL=index.js.map