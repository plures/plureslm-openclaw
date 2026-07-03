/**
 * Bridge from the read+write {@link PluresLmStore} to OpenClaw's exclusive
 * memory capability contract.
 *
 * The exclusive memory path is `MemoryPluginCapability.runtime`
 * (`MemoryPluginRuntime`), whose `getMemorySearchManager(...)` returns a
 * `MemorySearchManager`. We implement that manager's READ surface:
 *   - `search(query, opts)` -> ranked `MemorySearchResult[]`
 *   - `readFile({ relPath })` -> `MemoryReadResult` (relPath is a node id)
 *   - `status()` -> `MemoryProviderStatus`
 *   - `probeEmbeddingAvailability()` / `probeVectorAvailability()`
 * AND the WRITE surface:
 *   - `sync(params?)` -> ingests session-transcript files (and, when a
 *     `sourceDir` is configured + `force` is set, that directory) into the
 *     store so the content becomes recallable by `search()`.
 *
 * Write path: `sync()` chunks each file, sha256-hashes each chunk for cheap
 * dirty-tracking, and `put()`s `{content,category,type,source,path,hash,...}`
 * nodes through the SAME memoized embedder-backed handle the read path uses
 * (text content auto-embeds), then builds the vector index once. It is
 * idempotent and cheap when nothing changed (so the `reason:"search"` lazy
 * sync the host fires before every search does not re-embed unchanged content).
 *
 * Associative recall (P1): after the per-file write loop, `sync()` calls
 * `store.linkRecent(...)` ONCE to create graph edges among this sync's freshly
 * written session chunks (same-category + same-temporal-window), and `search()`
 * expands the direct vector/text hit set by pulling each top seed's graph
 * neighbors in as additional `via:"graph"` hits (appended after the direct
 * hits, de-duped, never reordered ahead of them — top-k precision preserved).
 * This gives the store associativity a flat memory backend structurally lacks:
 * "the other memories written alongside this one". Edge creation/traversal is
 * caller-triggered from `sync()`/`search()` (a DB-reactive on-write trigger is
 * a later phase), and v1 links on `category`+`temporal` only — embedding-cosine
 * "semantic" edges are honestly deferred, not stubbed.
 *
 * Honestly ABSENT this pass (per the Path B scope decision, not a stub): a
 * standing file-WATCHER for workspace memory-docs (MEMORY.md / memory/*.md).
 * Session files are ingested when the host passes them in `sessionFiles`, and
 * a configured `sourceDir` is rescanned on `force:true`; continuous memory-doc
 * watching is additive and can be layered on without changing this seam.
 *
 * The backend config reports the generic `builtin` backend (we are not a qmd CLI).
 */

import { createHash } from "node:crypto";
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

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
  /**
   * Optional absolute path to a directory of memory-doc source files
   * (markdown/text) to ingest on a `force:true` sync. When unset, the forced
   * full-rescan branch is a no-op — that is honest (nothing to scan), not a
   * stub. Session transcripts passed via `sessionFiles` are ingested
   * regardless of this setting.
   */
  sourceDir?: string;
  /**
   * Headroom write-path compression floor (tokens). When > 0 and the native
   * headroom surface is available, node bodies whose exact cl100k token count
   * exceeds this floor are compacted by native `compressText` before
   * persistence. 0 / undefined = disabled (bodies persisted verbatim). Plumbed
   * from `plugins.entries.plureslm.config.compressAboveTokens`.
   */
  compressAboveTokens?: number;
  /** Reactive .px on write (opt-in). Plumbed from config.reactivePx. */
  reactivePx?: boolean;
  /** Path to a .px policy file, plumbed from config.reactivePxPolicy. */
  reactivePxPolicy?: string;
};

function toStoreOptions(cfg: PluresLmCapabilityConfig): PluresLmStoreOptions {
  return {
    dbPath: cfg.dbPath,
    embeddingModel: cfg.embeddingModel,
    vectorThreshold: cfg.vectorThreshold,
    maxResults: cfg.maxResults,
    compressAboveTokens: cfg.compressAboveTokens,
    reactivePx: cfg.reactivePx,
    reactivePxPolicy: cfg.reactivePxPolicy,
  };
}

// --- Write-path helpers (chunking, hashing, id derivation) ------------------

/** Max characters per chunk before we split. Keeps embeddings well-formed. */
const CHUNK_MAX_CHARS = 2000;
/** File extensions we treat as ingestible text. */
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text", ".mdx"]);

type Chunk = {
  content: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  hash: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Narrow an unknown node payload to a plain record (or undefined). */
function asPayload(data: unknown): Record<string, unknown> | undefined {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : undefined;
}

/**
 * Best-effort text snippet from a node payload, mirroring the read path's
 * field priority (`content` -> `text` -> `summary` -> ...). Used for graph-
 * expanded neighbor nodes, whose raw `data` we surface as an associative hit.
 */
function deriveSnippetFromData(data: Record<string, unknown>): string {
  for (const key of ["content", "text", "summary", "value", "body", "note"]) {
    const val = data[key];
    if (typeof val === "string" && val.trim().length > 0) return val;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * Split markdown/text into reasonably-sized chunks, tracking 1-based start/end
 * line numbers per chunk. Splits on blank-line paragraph boundaries and packs
 * paragraphs up to {@link CHUNK_MAX_CHARS}; a single oversized paragraph is
 * emitted on its own (we do not mid-word slice — line fidelity matters more
 * than a hard cap here). Empty/whitespace-only input yields no chunks.
 */
function chunkText(raw: string): Chunk[] {
  const lines = raw.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufStartLine = 1; // 1-based line of the first buffered line
  let cursorLine = 0; // 1-based line index as we walk

  const flush = (endLine: number) => {
    const content = buf.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        content,
        chunkIndex: chunks.length,
        startLine: bufStartLine,
        endLine,
        hash: sha256(content),
      });
    }
    buf = [];
  };

  let pendingParagraph: string[] = [];
  let paragraphStartLine = 1;
  let bufChars = 0;

  const closeParagraph = (paraEndLine: number) => {
    if (pendingParagraph.length === 0) return;
    const paraText = pendingParagraph.join("\n");
    const paraChars = paraText.length;
    // If adding this paragraph would overflow the current buffer, flush first.
    if (bufChars > 0 && bufChars + paraChars > CHUNK_MAX_CHARS) {
      flush(paragraphStartLine - 1);
      bufStartLine = paragraphStartLine;
      bufChars = 0;
    }
    if (buf.length === 0) bufStartLine = paragraphStartLine;
    if (buf.length > 0) buf.push("");
    buf.push(...pendingParagraph);
    bufChars += paraChars + (bufChars > 0 ? 1 : 0);
    pendingParagraph = [];
    // A single paragraph at/over the cap stands alone.
    if (paraChars >= CHUNK_MAX_CHARS) {
      flush(paraEndLine);
      bufChars = 0;
    }
  };

  for (const line of lines) {
    cursorLine += 1;
    if (line.trim().length === 0) {
      closeParagraph(cursorLine - 1);
      continue;
    }
    if (pendingParagraph.length === 0) paragraphStartLine = cursorLine;
    pendingParagraph.push(line);
  }
  closeParagraph(cursorLine);
  flush(cursorLine);
  return chunks;
}

/** Slugify a path fragment for use inside a node id. */
function slugify(value: string): string {
  return value
    .replace(/[\\/\s]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** File stem (name without extension), slugified, for session ids. */
function fileStemSlug(filePath: string): string {
  return slugify(basename(filePath, extname(filePath)));
}

/** Recursively list ingestible text files under a directory (best-effort). */
function listTextFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — honest no-op
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTextFiles(full));
    } else if (entry.isFile() && TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
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

    // Map one recall hit to the SDK SearchResult shape. Shared between the
    // DIRECT vector/text hits and the associative GRAPH hits so provenance
    // (source/line/citation/score) is derived identically.
    const toResult = (
      id: string,
      score: number,
      snippet: string,
      category: string | undefined,
      data: Record<string, unknown> | undefined,
      via: "vector" | "text" | "graph",
      seedId?: string,
    ): SearchResult => {
      const lineCount = snippet.split("\n").length;
      // Honor the stored `source`/line metadata when present (written by
      // sync()); fall back to defaults for nodes that predate the write path.
      const payload = data;
      const storedSource = payload?.source;
      const source: "memory" | "sessions" =
        storedSource === "sessions" ? "sessions" : "memory";
      const startLine =
        typeof payload?.startLine === "number" && payload.startLine > 0
          ? payload.startLine
          : 1;
      const endLine =
        typeof payload?.endLine === "number" && payload.endLine >= startLine
          ? payload.endLine
          : Math.max(startLine, lineCount);
      // Graph hits have no cosine/text score of their own — they are surfaced by
      // association, so we set neither vectorScore nor textScore and carry an
      // honest provenance citation noting the seed they were reached from.
      const citation =
        via === "graph"
          ? `plureslm:graph:${seedId ?? "?"}->${id}`
          : category
            ? `plureslm:${category}:${id}`
            : `plureslm:${id}`;
      return {
        path: id,
        startLine,
        endLine,
        score,
        vectorScore: via === "vector" ? score : undefined,
        textScore: via === "text" ? score : undefined,
        snippet,
        source,
        citation,
      };
    };

    const results: SearchResult[] = hits.map((hit) =>
      toResult(hit.id, hit.score, hit.snippet, hit.category, asPayload(hit.data), hit.via),
    );

    // --- Associative graph expansion (P1) ------------------------------------
    // After the DIRECT vector+text hits, pull in adjacent memories via the
    // edges link-on-write created (same session window / same category). This
    // gives memory-core associativity a flat store structurally cannot: "the
    // other memories written alongside this hit". Precision guard: graph hits
    // are APPENDED AFTER the direct hits (never reordered ahead of them) and
    // de-duped by id, so top-k precision of the primary results is preserved.
    // Bounded blast radius: expand only from the top-3 seeds, depth 1.
    const SEED_N = 3;
    const EXPAND_DEPTH = 1;
    const seen = new Set(results.map((r) => r.path));
    const seeds = hits.slice(0, SEED_N);
    for (const seed of seeds) {
      let neighbors: Array<{ id: string; data: Record<string, unknown> }>;
      try {
        neighbors = store.neighbors(seed.id, EXPAND_DEPTH);
      } catch {
        neighbors = []; // best-effort: expansion never breaks the read path
      }
      for (const n of neighbors) {
        if (seen.has(n.id)) continue; // de-dupe; never displace a direct hit
        seen.add(n.id);
        const snippet = deriveSnippetFromData(n.data);
        const category =
          typeof n.data.category === "string" ? n.data.category : undefined;
        results.push(
          toResult(n.id, seed.score, snippet, category, n.data, "graph", seed.id),
        );
      }
    }

    return results;
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
      sources: ["memory", "sessions"] as Array<"memory" | "sessions">,
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

  /**
   * Ingest session-transcript files (and, on `force:true`, a configured
   * `sourceDir`) into the store so the content is recallable by `search()`.
   *
   * Matches the SDK `MemorySearchManager.sync` signature exactly. Behavior:
   *   - `params === undefined` is safe: sync whatever is configured/dirty
   *     (effectively a no-op when no sessionFiles + no force).
   *   - For each `sessionFiles` path: chunk -> sha256 per chunk -> nodes with
   *     id `mem:session:<fileStem>:<chunkIndex>`, category/source "session".
   *   - On `force:true` with a configured `sourceDir`: rescan that dir the same
   *     way with id `mem:memory:<relPathSlug>:<chunkIndex>`, category/source
   *     "memory". Without a `sourceDir`, this branch is a no-op (honest).
   *   - Dirty-tracking in {@link PluresLmStore.store} keeps it cheap when the
   *     content is unchanged (the lazy `reason:"search"` sync stays idempotent).
   *   - `progress({completed,total,label})` is invoked as files are processed
   *     when the host supplied a callback.
   */
  async function sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void> {
    const sessionFiles = (params?.sessionFiles ?? []).filter(
      (p) => typeof p === "string" && p.trim().length > 0,
    );
    const force = params?.force === true;

    // Build the work list: explicit session files, plus the configured source
    // dir on a forced rescan. Each work item carries how to derive its node id
    // and its category/source tag.
    type WorkItem = {
      path: string;
      kind: "session" | "memory";
      idStem: string; // already-slugged stem used in the node id
    };
    const work: WorkItem[] = [];

    for (const filePath of sessionFiles) {
      work.push({ path: filePath, kind: "session", idStem: fileStemSlug(filePath) });
    }

    if (force && cfg.sourceDir) {
      const root = cfg.sourceDir;
      for (const filePath of listTextFiles(root)) {
        let rel = filePath;
        try {
          rel = relative(root, filePath) || basename(filePath);
        } catch {
          rel = basename(filePath);
        }
        work.push({ path: filePath, kind: "memory", idStem: slugify(rel) });
      }
    }
    // NOTE: when `sessionFiles` is empty and `force` is false (e.g. the lazy
    // `reason:"search"` sync), there is intentionally nothing to do here — a
    // standing memory-doc watcher is ABSENT this pass by design (see header).

    const total = work.length;
    if (total === 0) {
      params?.progress?.({ completed: 0, total: 0, label: params?.reason });
      return;
    }

    let completed = 0;
    const nowIso = new Date().toISOString();
    // Numeric lower bound for the post-loop associative link pass. Every chunk
    // written this sync is stamped with `data.syncEpoch === syncStartEpoch`, so
    // a NUMERIC `syncEpoch >= syncStartEpoch` filter scopes link-on-write to
    // exactly this sync's fresh set. We use a numeric epoch (not the ISO
    // `timestamp` string) because the engine's `>=` only compares numbers — an
    // ISO-string `>=` filter is always empty (see PluresLmStore.linkRecent).
    const syncStartEpoch = Date.now();
    let wroteAny = false;

    for (const item of work) {
      let rawText: string;
      let stat: { mtimeMs: number; size: number };
      try {
        rawText = readFileSync(item.path, "utf8");
        const st = statSync(item.path);
        stat = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        // Unreadable/disappeared file — skip it honestly; report progress.
        completed += 1;
        params?.progress?.({ completed, total, label: item.path });
        continue;
      }

      const chunks = chunkText(rawText);
      const source: "sessions" | "memory" =
        item.kind === "session" ? "sessions" : "memory";
      const category = item.kind; // "session" | "memory"
      const idPrefix = item.kind === "session" ? "mem:session" : "mem:memory";

      const nodes = chunks.map((chunk) => ({
        id: `${idPrefix}:${item.idStem}:${chunk.chunkIndex}`,
        data: {
          content: chunk.content,
          category,
          type: "memory-chunk",
          source,
          path: item.path,
          chunkIndex: chunk.chunkIndex,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunk.hash,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          timestamp: nowIso,
          // Numeric per-sync stamp used by link-on-write's pre-filter
          // (`syncEpoch >= syncStartEpoch`). Numeric because the engine's `>=`
          // only compares numbers; the ISO `timestamp` above is for display/
          // ordering and is NOT a valid `>=` filter key.
          syncEpoch: syncStartEpoch,
        } as Record<string, unknown>,
      }));

      if (nodes.length > 0) {
        // Dirty-tracked batch write through the SAME handle; auto-embeds text.
        const { written } = store.store(nodes);
        if (written > 0) wroteAny = true;
      }

      completed += 1;
      params?.progress?.({ completed, total, label: item.path });
    }

    // Link-on-write (associative recall, P1): run ONCE after the whole per-file
    // loop closes — not per file — so `auto_link` sees ALL chunks written this
    // sync at once (including cross-file same-category/same-window pairs) and is
    // invoked a single time rather than O(n²) per file. Skip entirely when
    // nothing was actually written (a clean/idempotent re-sync stays cheap: no
    // dirty nodes => no new edges to form). `linkRecent` is best-effort and
    // never throws out of `sync()`, preserving the write contract.
    if (wroteAny) {
      store.linkRecent(syncStartEpoch);
    }

    // Reactive consolidation sweep (P3, PULL/TICK — not push). The native has no
    // on-write trigger, so we run the idempotent in-DB consolidation sweep
    // opportunistically here on the SAME handle: forced when the caller forces a
    // sync, otherwise interval-guarded by a DURABLE checkpoint so the lazy
    // `reason:"search"` sync that fires before every search calls it for free
    // (a cheap no-op when it ran < the min interval ago). `consolidate()` is
    // best-effort and self-contained; it never throws out of `sync()`.
    try {
      store.consolidate({ force });
    } catch {
      // Consolidation is additive maintenance; a failure must never break the
      // write/search contract.
    }
  }

  // Shape matches `MemorySearchManager` (read surface + write `sync`).
  return {
    store,
    manager: {
      search,
      readFile,
      status,
      probeEmbeddingAvailability,
      probeVectorAvailability,
      sync,
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
        sourceDir: cfg.sourceDir,
        compressAboveTokens: cfg.compressAboveTokens,
        reactivePx: cfg.reactivePx,
        reactivePxPolicy: cfg.reactivePxPolicy,
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
