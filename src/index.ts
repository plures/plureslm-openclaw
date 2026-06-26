/**
 * plureslm-openclaw — Stage A entry point.
 *
 * Registers a READ-PATH memory capability backed by `@plures/pluresdb-native`.
 * No write path, no flush plan, no prompt-section takeover — only the exclusive
 * memory capability's read runtime (search / readFile / status / probes).
 *
 * Config (plugins.entries.plureslm.config):
 *   - dbPath:        absolute path to the PluresDB store directory
 *   - embeddingModel: HF model id (default BAAI/bge-small-en-v1.5)
 *   - vectorThreshold: cosine floor 0..1 (default 0.3)
 *   - maxResults:    default recall limit (default 8)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { buildMemoryCapability } from "./memory-capability.js";

type PluresLmPluginConfig = {
  dbPath?: string;
  embeddingModel?: string;
  vectorThreshold?: number;
  maxResults?: number;
};

function readConfig(raw: Record<string, unknown> | undefined): PluresLmPluginConfig {
  const cfg = raw ?? {};
  const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : undefined;
  const embeddingModel =
    typeof cfg.embeddingModel === "string" ? cfg.embeddingModel : undefined;
  const vectorThreshold =
    typeof cfg.vectorThreshold === "number" ? cfg.vectorThreshold : undefined;
  const maxResults =
    typeof cfg.maxResults === "number" ? cfg.maxResults : undefined;
  return { dbPath, embeddingModel, vectorThreshold, maxResults };
}

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "plureslm",
  name: "PluresLM Memory",
  description:
    "Read-path memory recall for OpenClaw backed by @plures/pluresdb-native.",
  register(api) {
    const cfg = readConfig(api.pluginConfig);
    if (!cfg.dbPath) {
      api.logger.warn(
        "[plureslm] no dbPath configured; registering an inert read-path memory capability.",
      );
    } else {
      api.logger.info(
        `[plureslm] registering read-path memory capability over ${cfg.dbPath}`,
      );
    }
    api.registerMemoryCapability(buildMemoryCapability(cfg));
  },
});

export default plugin;
