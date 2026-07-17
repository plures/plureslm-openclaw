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
declare const plugin: ReturnType<typeof definePluginEntry>;
export default plugin;
//# sourceMappingURL=index.d.ts.map