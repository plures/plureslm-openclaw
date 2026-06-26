/**
 * Bridge from the read-only {@link PluresLmStore} to OpenClaw's exclusive
 * memory capability contract.
 *
 * The exclusive read path is `MemoryPluginCapability.runtime`
 * (`MemoryPluginRuntime`), whose `getMemorySearchManager(...)` returns a
 * `MemorySearchManager`. We implement that manager's READ surface:
 *   - `search(query, opts)` -> ranked `MemorySearchResult[]`
 *   - `readFile({ relPath })` -> `MemoryReadResult` (relPath is a node id)
 *   - `status()` -> `MemoryProviderStatus`
 *   - `probeEmbeddingAvailability()` / `probeVectorAvailability()`
 *
 * Stage A implements NO write path: there is no `sync`, no flush, no put. The
 * backend config reports the generic `builtin` backend (we are not a qmd CLI).
 */

import type {
  MemoryPluginCapability,
  MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core";

import { PluresLmStore, type PluresLmStoreOptions } from "./pluresdb.js";

// NOTE: `MemorySearchResult`, `MemoryReadResult`, and `MemoryProviderStatus`
// are NOT re-exported by the `openclaw/plugin-sdk/memory-core` subpath (they
// live in an internal chunk, surfaced only transitively through
// `MemoryPluginRuntime`'s method signatures). We therefore avoid importing
// those names directly and instead let TypeScript infer/structurally check the
// manager and runtime shapes: `buildMemoryCapability` returns a typed
// `MemoryPluginCapability` whose `runtime` is annotated `MemoryPluginRuntime`,
// so any drift in the search/read/status return shapes is still a compile
// error at the assignment site. Local mirror types below exist only for
// readability and are width-compatible subsets of the SDK contract.

/** Local mirror of the SDK `MemorySearchResult` (subset we populate). */
type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
};

/** Local mirror of the SDK `MemoryReadResult`. */
type ReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

const BACKEND = "builtin" as const;
const PROVIDER_LABEL = "plureslm";

export type PluresLmCapabilityConfig = {
  dbPath: string;
  embeddingModel: string;
  vectorThreshold?: number;
  maxResults?: number;
};

function toStoreOptions(cfg: PluresLmCapabilityConfig): PluresLmStoreOptions {
  return {
    dbPath: cfg.dbPath,
    embeddingModel: cfg.embeddingModel,
    vectorThreshold: cfg.vectorThreshold,
    maxResults: cfg.maxResults,
  };
}

/**
 * A `MemorySearchManager` backed by one PluresDB store. Exposed for the test
 * gate so the exact read path the host calls can be exercised directly.
 */
export function createPluresLmSearchManager(cfg: PluresLmCapabilityConfig) {
  const store = PluresLmStore.open(toStoreOptions(cfg));

  async function search(
    query: string,
    opts?: { maxResults?: number },
  ): Promise<SearchResult[]> {
    const hits = store.recall(query, opts?.maxResults);
    return hits.map((hit): SearchResult => {
      const lineCount = hit.snippet.split("\n").length;
      return {
        path: hit.id,
        startLine: 1,
        endLine: Math.max(1, lineCount),
        score: hit.score,
        vectorScore: hit.via === "vector" ? hit.score : undefined,
        textScore: hit.via === "text" ? hit.score : undefined,
        snippet: hit.snippet,
        source: "memory",
        citation: hit.category
          ? `plureslm:${hit.category}:${hit.id}`
          : `plureslm:${hit.id}`,
      };
    });
  }

  async function readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<ReadResult> {
    // `relPath` is a PluresDB node id. We resolve it via recall on the id so
    // the read path stays read-only and uses the same store handle.
    const hits = store.recall(params.relPath, 1);
    const match = hits.find((h) => h.id === params.relPath) ?? hits[0];
    const text = match ? match.snippet : "";
    return {
      text,
      path: params.relPath,
      truncated: false,
      from: params.from,
      lines: params.lines,
    };
  }

  function status() {
    const s = store.status();
    return {
      backend: BACKEND,
      provider: PROVIDER_LABEL,
      model: s.embeddingModel,
      chunks: s.totalNodes,
      files: Object.keys(s.typeCounts).length || undefined,
      dbPath: s.dbPath,
      sources: ["memory"] as Array<"memory" | "sessions">,
      vector: {
        enabled: true,
        storeAvailable: true,
        semanticAvailable: store.hasEmbedder(),
        available: store.probeVector(),
        dims: s.embeddingDimension ?? undefined,
      },
    };
  }

  async function probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    const open = store.probeOpen();
    if (!open.ok) return { ok: false, error: open.error };
    return { ok: store.hasEmbedder() };
  }

  async function probeVectorAvailability(): Promise<boolean> {
    return store.probeVector();
  }

  // Shape matches `MemorySearchManager` (read-only subset; no `sync`).
  return {
    store,
    manager: {
      search,
      readFile,
      status,
      probeEmbeddingAvailability,
      probeVectorAvailability,
    },
  };
}

/**
 * Build the `MemoryPluginCapability` to hand to
 * `api.registerMemoryCapability(...)`. When `dbPath` is absent the capability
 * stays inert: `getMemorySearchManager` returns `{ manager: null, error }` and
 * the host degrades gracefully rather than crashing.
 */
export function buildMemoryCapability(
  cfg: Partial<PluresLmCapabilityConfig>,
): MemoryPluginCapability {
  const runtime: MemoryPluginRuntime = {
    async getMemorySearchManager() {
      if (!cfg.dbPath) {
        return {
          manager: null,
          error:
            "[plureslm] no dbPath configured (plugins.entries.plureslm.config.dbPath); memory capability is inert.",
        };
      }
      const resolved: PluresLmCapabilityConfig = {
        dbPath: cfg.dbPath,
        embeddingModel: cfg.embeddingModel ?? "BAAI/bge-small-en-v1.5",
        vectorThreshold: cfg.vectorThreshold,
        maxResults: cfg.maxResults,
      };
      const { manager, store } = createPluresLmSearchManager(resolved);
      const open = store.probeOpen();
      if (!open.ok) {
        return { manager: null, error: open.error };
      }
      return { manager };
    },
    resolveMemoryBackendConfig() {
      return { backend: BACKEND };
    },
  };

  return { runtime };
}
