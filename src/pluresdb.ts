/**
 * Typed read+write+graph wrapper around `@plures/pluresdb-native`.
 *
 * Surface: this module opens a PluresDB store and exposes a narrow recall
 * surface (vector + text search, status, availability probes), a narrow
 * write surface (`put` / `store`) used by the memory capability's `sync()`,
 * AND a narrow GRAPH surface (`execIr` pass-through, `linkRecent`,
 * `neighbors`) that turns the flat store into an associative graph: edges are
 * created between freshly-written same-session/same-category chunks
 * (link-on-write) and traversed at recall time to surface adjacent memories.
 * All three surfaces reuse the SAME memoized native handle the read side
 * opened (see the exclusive-lock constraint below) — it never opens a second
 * `PluresDatabase` on a live dbPath. Graph ops are EXEC-ONLY in the native
 * (`@plures/pluresdb-native@2.0.0-alpha.1` exposes no direct `autoLink`/
 * `graphNeighbors` method), so they run through `execIr(steps)`; the only
 * mutation the graph surface performs is `auto_link` writing deterministic
 * `edge::{from}::{to}` CRDT nodes (idempotent re-sync). It still never calls
 * `delete` directly, and beyond `put`/`auto_link` + the best-effort
 * `buildVectorIndex` it performs no other mutating native call.
 *
 * Two hard constraints from the native, verified against
 * `@plures/pluresdb-native@2.0.0-alpha.1`:
 *
 *  1. A given `dbPath` holds an EXCLUSIVE file lock — only one open handle may
 *     exist per path per process. We therefore memoize one handle per resolved
 *     dbPath (a process-local singleton). Reads AND writes go through that one
 *     handle; opening a second handle on the same path would deadlock/throw
 *     against the live one.
 *  2. `search()` / `vectorSearch()` / `list()` return records shaped like
 *     `{ id, data, score, timestamp }`. `stats()` returns
 *     `{ totalNodes, typeCounts }`. `get(id)` returns the stored payload object
 *     or `null`.
 *
 * Write path / embed-on-write (DEF-PATHB-1): the native alpha documents that
 * `put(id, data)` auto-embeds text content when the handle was opened via
 * `newWithEmbeddings(...)`, but `@plures/pluresdb-native@2.0.0-alpha.1` does NOT
 * honor that contract — a plain `put` stores the node WITHOUT a vector, so
 * `buildVectorIndex()` finds nothing and a purely semantic (vector) query of a
 * just-written node returns 0 (root-caused in PATH-B-QA-NOTES.md via
 * `test/qa-vector-probe.mts`). The embedder itself works (`embed()` returns a
 * full-dimension row) and the index/search machinery works when an embedding is
 * actually stored. We therefore embed text explicitly on the write path and
 * persist the vector via `putWithEmbedding(id, data, vec)` — proven to restore
 * end-to-end vector recall — falling back to plain `put(id, data)` only when no
 * embedder is available or the node carries no embeddable text (an honest
 * text-only write, never a fabricated vector).
 */

import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluresDatabase as PluresDatabaseType } from "@plures/pluresdb-native";

// The package ships a CommonJS `index.js` that loads the platform `.node`
// addon. Load it through createRequire so this ESM module stays NodeNext-clean
// without a default-interop shim.
const require = createRequire(import.meta.url);

/**
 * NAPI-RS binding resolution.
 *
 * `@plures/pluresdb-native` is consumed as a local (`file:`) dependency and its
 * generated `index.js` resolves the platform addon either as a sibling
 * `pluresdb-node.<triple>.node` or as an optional `@plures/pluresdb-native-<triple>`
 * package. When the dependency is linked through a package manager store, the
 * large `.node` artifact is not always copied next to `index.js`, so the sibling
 * `require` fails. The loader checks `NAPI_RS_NATIVE_LIBRARY_PATH` FIRST, so we
 * resolve the real `.node` on disk and point the loader at it before requiring.
 *
 * This is a pure-consumer shim: it changes nothing in the native package, it
 * only tells the existing loader where the already-built addon lives.
 */
function bindingFileName(): string | null {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "pluresdb-node.win32-x64-msvc.node";
  if (platform === "darwin" && arch === "arm64") return "pluresdb-node.darwin-arm64.node";
  if (platform === "darwin" && arch === "x64") return "pluresdb-node.darwin-x64.node";
  if (platform === "linux" && arch === "x64") return "pluresdb-node.linux-x64-gnu.node";
  if (platform === "linux" && arch === "arm64") return "pluresdb-node.linux-arm64-gnu.node";
  return null;
}

/**
 * Candidate source-crate roots for a local development checkout, where the
 * NAPI addon is built as a sibling of `index.js`. These are only used as a
 * fallback when the package-manager store copy lacks the `.node` artifact.
 */
function nativeCrateRoots(): string[] {
  const roots = new Set<string>();
  const env = process.env.PLURESDB_NODE_DIR;
  if (env) roots.add(env);
  // Walk up from this module looking for a sibling `pluresdb/crates/pluresdb-node`.
  let here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 8; i++) {
    roots.add(join(here, "pluresdb", "crates", "pluresdb-node"));
    roots.add(join(dirname(here), "pluresdb", "crates", "pluresdb-node"));
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  return [...roots];
}

function ensureNativeLibraryPath(): void {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return; // operator override wins
  const file = bindingFileName();
  if (!file) return; // unknown platform: let the loader try its own resolution
  // The package's index.js sits next to the (possibly missing) .node sibling.
  // Resolve the package dir, then look for the .node next to it; if absent,
  // fall back to the source crate layout used during local development.
  let pkgIndex: string | null = null;
  try {
    pkgIndex = require.resolve("@plures/pluresdb-native");
  } catch {
    pkgIndex = null;
  }
  const candidates: string[] = [];
  if (pkgIndex) {
    const dir = dirname(pkgIndex);
    candidates.push(join(dir, file));
    // A package-manager store may symlink the package DIRECTORY to its real
    // on-disk location (e.g. the source crate) where the .node sibling exists.
    // Resolve the realpath of the package root, not just the index file.
    try {
      const realDir = realpathSync(dir);
      if (realDir !== dir) candidates.push(join(realDir, file));
    } catch {
      /* realpath unavailable; ignore */
    }
  }
  // Deterministic local-development fallback: the source crate sits next to the
  // consuming repo under a sibling `pluresdb` checkout. Probe a few likely roots.
  for (const root of nativeCrateRoots()) {
    candidates.push(join(root, file));
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = c;
      return;
    }
  }
  // No sibling .node found; leave the env unset so the loader can still try the
  // optional per-triple package and report a precise error if that is missing.
}

type PluresNativeModule = {
  PluresDatabase: typeof PluresDatabaseType;
  init?: () => void;
};

let cachedModule: PluresNativeModule | null = null;

function loadNative(): PluresNativeModule {
  if (cachedModule) return cachedModule;
  ensureNativeLibraryPath();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@plures/pluresdb-native") as PluresNativeModule;
  if (!mod || typeof mod.PluresDatabase !== "function") {
    throw new Error(
      "[plureslm] @plures/pluresdb-native loaded but PluresDatabase export is missing — native addon failed to load.",
    );
  }
  cachedModule = mod;
  return mod;
}

/** One ranked recall hit, normalized from a raw PluresDB node record. */
export type RecallHit = {
  /** Stable node id (used as the citation/path handle). */
  id: string;
  /** Relevance score as returned by the underlying search (0..1-ish). */
  score: number;
  /** Best-effort text snippet derived from the node payload. */
  snippet: string;
  /** Node category/type when present in the payload. */
  category?: string;
  /** ISO timestamp of the node when present. */
  timestamp?: string;
  /** Raw node payload (the object that was originally stored). */
  data: unknown;
  /**
   * Which retrieval path produced the hit:
   *  - `"vector"` / `"text"` — a DIRECT hit from the cosine/keyword search.
   *  - `"graph"` — an ASSOCIATIVE hit pulled in via {@link PluresLmStore.neighbors}
   *    by expanding a direct hit's graph edges. Graph hits carry no cosine/text
   *    score of their own; they are appended after the direct hits so top-k
   *    precision is preserved (they never displace/outrank a direct hit).
   */
  via: "vector" | "text" | "graph";
};

/** Aggregate store status, normalized from `stats()`. */
export type StoreStatus = {
  totalNodes: number;
  typeCounts: Record<string, number>;
  dbPath: string;
  embeddingModel: string;
  /** Embedding dimension reported by the configured embedder, if any. */
  embeddingDimension: number | null;
};

export type PluresLmStoreOptions = {
  dbPath: string;
  embeddingModel: string;
  /** Actor id for the handle. The handle reads AND writes; the native requires one. */
  actorId?: string;
  vectorThreshold?: number;
  maxResults?: number;
};

type RawNode = {
  id?: unknown;
  data?: unknown;
  score?: unknown;
  timestamp?: unknown;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function deriveSnippet(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Prefer common content-bearing fields, in priority order.
    for (const key of ["content", "text", "summary", "value", "body", "note"]) {
      const val = obj[key];
      if (typeof val === "string" && val.trim().length > 0) return val;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return typeof data === "string" ? data : String(data ?? "");
}

function deriveCategory(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["category", "type", "kind"]) {
      const val = obj[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
  }
  return undefined;
}

function normalizeHit(
  raw: unknown,
  via: "vector" | "text" | "graph",
): RecallHit | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as RawNode;
  const id = asString(node.id);
  if (!id) return null;
  const data = node.data;
  // Edges live in the same node space as memory chunks (an edge is just a node
  // with `data._edge === true`, id `edge::{from}::{to}`). Once link-on-write
  // populates them, a plain vector/text search could surface one. Drop edge
  // nodes from recall hits — they are graph plumbing, never a memory result.
  if (
    data &&
    typeof data === "object" &&
    (data as Record<string, unknown>)._edge === true
  ) {
    return null;
  }
  const score = typeof node.score === "number" ? node.score : 0;
  return {
    id,
    score,
    snippet: deriveSnippet(data),
    category: deriveCategory(data),
    timestamp: asString(node.timestamp),
    data,
    via,
  };
}

/**
 * Read-only handle over one PluresDB store. Memoized per resolved dbPath to
 * respect the native's exclusive file lock.
 */
export class PluresLmStore {
  readonly dbPath: string;
  readonly embeddingModel: string;
  readonly vectorThreshold: number;
  readonly maxResults: number;
  #db: PluresDatabaseType | null = null;
  #openError: string | null = null;
  #embedderAvailable: boolean | null = null;

  private constructor(opts: PluresLmStoreOptions) {
    this.dbPath = opts.dbPath;
    this.embeddingModel = opts.embeddingModel;
    this.vectorThreshold = opts.vectorThreshold ?? 0.3;
    this.maxResults = opts.maxResults ?? 8;
  }

  /** Process-local singletons keyed by resolved dbPath. */
  static #instances = new Map<string, PluresLmStore>();

  static open(opts: PluresLmStoreOptions): PluresLmStore {
    const key = opts.dbPath;
    const existing = PluresLmStore.#instances.get(key);
    if (existing) return existing;
    const created = new PluresLmStore(opts);
    PluresLmStore.#instances.set(key, created);
    return created;
  }

  /** For tests: drop a cached handle so a fresh process-equivalent open works. */
  static _resetForTests(dbPath?: string): void {
    if (dbPath) PluresLmStore.#instances.delete(dbPath);
    else PluresLmStore.#instances.clear();
  }

  /**
   * Lazily open the underlying database with the configured embedding model.
   * If embedder construction fails (e.g. model unavailable offline), we fall
   * back to a plain handle so text search + status still work — vector recall
   * is then skipped, never faked.
   */
  #ensureDb(): PluresDatabaseType {
    if (this.#db) return this.#db;
    if (this.#openError) throw new Error(this.#openError);
    const { PluresDatabase } = loadNative();
    try {
      this.#db = PluresDatabase.newWithEmbeddings(
        this.embeddingModel,
        this.#actorId(),
        this.dbPath,
      );
      this.#embedderAvailable = true;
    } catch (err) {
      // Embedder path failed — degrade to a plain read handle (text-only).
      const msg = err instanceof Error ? err.message : String(err);
      try {
        this.#db = new PluresDatabase(this.#actorId(), this.dbPath);
        this.#embedderAvailable = false;
      } catch (err2) {
        this.#openError = `[plureslm] failed to open store at ${this.dbPath}: ${
          err2 instanceof Error ? err2.message : String(err2)
        } (embedder error: ${msg})`;
        throw new Error(this.#openError);
      }
    }
    return this.#db;
  }

  #actorId(): string {
    // The store now READS and WRITES through this one handle, so the actor is
    // a neutral "plureslm" rather than the old read-only "plureslm-reader".
    // The read path is unaffected by the actor string.
    return "plureslm";
  }

  /**
   * Embed `text` and return the vector iff it has the expected dimension.
   * Returns `null` on any failure or shape mismatch — the caller then falls
   * back to a plain (text-only) `put`. Never throws; never fabricates a vector.
   */
  #embedForWrite(db: PluresDatabaseType, text: string): number[] | null {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) return null;
    let vec: unknown;
    try {
      vec = db.embed([text])?.[0];
    } catch {
      return null;
    }
    if (!Array.isArray(vec) || vec.length === 0) return null;
    // If the embedder reports a concrete dimension, require an exact match so we
    // never persist a malformed/short vector against the index.
    let dim: number | null = null;
    try {
      dim = db.embeddingDimension();
    } catch {
      dim = null;
    }
    if (typeof dim === "number" && dim > 0 && vec.length !== dim) return null;
    return vec as number[];
  }

  /**
   * Embeddable text for a node, using the SAME field priority the read path
   * derives snippets from: `content` (primary, what `sync()` always writes) →
   * `text` → `summary`. Returns an empty string when none is present (caller
   * then writes text-only).
   */
  #embeddableText(data: Record<string, unknown>): string {
    for (const key of ["content", "text", "summary"]) {
      const val = data[key];
      if (typeof val === "string" && val.trim().length > 0) return val;
    }
    return "";
  }

  /**
   * Write one node, embedding-on-write when an embedder is available.
   *
   * When `#embedderAvailable === true` and the node carries embeddable text, we
   * compute the vector and persist it via `putWithEmbedding` (DEF-PATHB-1: the
   * native alpha's `put` does not auto-embed, so an explicit embedding is the
   * only way the node becomes vector-searchable). Otherwise — no embedder, no
   * text, or an embed failure/shape-mismatch — we fall back to plain `put`,
   * which is an honest text-only write (never a fabricated vector).
   *
   * Assumes the caller already decided the node is dirty (see `#isDirty`); this
   * helper does NOT re-check dirtiness, so a node that will be skipped is never
   * embedded.
   */
  #writeNode(db: PluresDatabaseType, id: string, data: Record<string, unknown>): void {
    if (this.#embedderAvailable === true) {
      const vec = this.#embedForWrite(db, this.#embeddableText(data));
      if (vec) {
        db.putWithEmbedding(id, data, vec);
        return;
      }
    }
    // Degraded (no embedder), empty text, or embed failure → honest text-only.
    db.put(id, data);
  }

  /** True once the store has been opened with a working embedder. */
  hasEmbedder(): boolean {
    if (this.#embedderAvailable === null) {
      try {
        this.#ensureDb();
      } catch {
        return false;
      }
    }
    return this.#embedderAvailable === true;
  }

  /** Probe that the store is openable. Read-only; never throws. */
  probeOpen(): { ok: boolean; error?: string } {
    try {
      this.#ensureDb();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Probe vector-search availability (embedder + non-empty dimension). */
  probeVector(): boolean {
    try {
      const db = this.#ensureDb();
      if (this.#embedderAvailable !== true) return false;
      const dim = db.embeddingDimension();
      return typeof dim === "number" && dim > 0;
    } catch {
      return false;
    }
  }

  /** Normalized store status from `stats()` + embedding dimension. */
  status(): StoreStatus {
    const db = this.#ensureDb();
    const raw = db.stats() as { totalNodes?: unknown; typeCounts?: unknown } | null;
    const totalNodes =
      raw && typeof raw.totalNodes === "number" ? raw.totalNodes : 0;
    const typeCounts =
      raw && raw.typeCounts && typeof raw.typeCounts === "object"
        ? (raw.typeCounts as Record<string, number>)
        : {};
    let dim: number | null = null;
    try {
      dim = db.embeddingDimension();
    } catch {
      dim = null;
    }
    return {
      totalNodes,
      typeCounts,
      dbPath: this.dbPath,
      embeddingModel: this.embeddingModel,
      embeddingDimension: dim,
    };
  }

  /** Total node count (cheap; from `stats()`). */
  count(): number {
    return this.status().totalNodes;
  }

  /**
   * Recall up to `limit` hits for `query`. Prefers vector search when an
   * embedder is available, then falls back to / merges text search. Returns a
   * normalized, de-duplicated, score-sorted list. Never fabricates results.
   */
  recall(query: string, limit?: number): RecallHit[] {
    const db = this.#ensureDb();
    const k = Math.max(1, limit ?? this.maxResults);
    const byId = new Map<string, RecallHit>();

    // 1) Vector path (best when embeddings are present).
    if (this.#embedderAvailable === true) {
      try {
        const embeddings = db.embed([query]);
        const vec = embeddings?.[0];
        if (Array.isArray(vec) && vec.length > 0) {
          const raw = db.vectorSearch(vec, k, this.vectorThreshold);
          for (const r of raw ?? []) {
            const hit = normalizeHit(r, "vector");
            if (hit && !byId.has(hit.id)) byId.set(hit.id, hit);
          }
        }
      } catch {
        // Vector path unavailable at runtime — fall through to text search.
      }
    }

    // 2) Text path (always attempted; fills remaining slots).
    if (byId.size < k) {
      try {
        const raw = db.search(query, k);
        for (const r of raw ?? []) {
          const hit = normalizeHit(r, "text");
          if (hit && !byId.has(hit.id)) byId.set(hit.id, hit);
        }
      } catch {
        // Text search failed — return whatever the vector path produced.
      }
    }

    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  /**
   * Write one node through the SAME memoized handle the read path uses.
   *
   * Dirty-tracking: when the dirty key (the chunk `hash`, falling back to
   * `mtimeMs`+`size`) matches what is already stored under `id`, the put is
   * SKIPPED and `false` is returned — so a re-sync of unchanged content does not
   * re-embed. Returns `true` when a put actually happened.
   *
   * Embed-on-write (DEF-PATHB-1): when an embedder is available and the node
   * carries embeddable text (`content` → `text` → `summary`), the vector is
   * computed and persisted via `putWithEmbedding` so the node is vector-
   * searchable — the native alpha's `put` does NOT auto-embed despite its docs,
   * so an explicit embedding is required (proven in PATH-B-QA-NOTES.md). If the
   * embedder degraded (`#embedderAvailable === false`), or the node carries no
   * text, or the embed call fails, the node is STILL written via plain `put` —
   * an honest text-only write, never a fabricated embedding. Callers can inspect
   * {@link hasEmbedder} / {@link status} to surface that distinction honestly.
   */
  put(id: string, data: Record<string, unknown>): boolean {
    const db = this.#ensureDb();
    if (!this.#isDirty(db, id, data)) return false;
    this.#writeNode(db, id, data);
    return true;
  }

  /**
   * Write a batch of nodes, then build the vector index once (best-effort).
   * Returns how many were actually written vs skipped as unchanged.
   *
   * Skips are driven by per-node dirty-tracking (see {@link put}); a re-sync of
   * already-current chunks is therefore cheap (no re-embed, no index rebuild
   * cost beyond the single best-effort call). When nothing was written the
   * index rebuild is skipped entirely.
   */
  store(
    nodes: Array<{ id: string; data: Record<string, unknown> }>,
  ): { written: number; skipped: number } {
    const db = this.#ensureDb();
    let written = 0;
    let skipped = 0;
    for (const node of nodes) {
      // Check dirtiness FIRST so an unchanged node is never embedded — the lazy
      // pre-search sync stays cheap (no wasted embed calls on skips).
      if (this.#isDirty(db, node.id, node.data)) {
        this.#writeNode(db, node.id, node.data);
        written += 1;
      } else {
        skipped += 1;
      }
    }
    if (written > 0) {
      try {
        // Best-effort: vectors written via putWithEmbedding are already
        // searchable (proven by the QA control); this call may report 0 in the
        // alpha — its return value is NOT relied upon (see DEF-PATHB-1 notes).
        db.buildVectorIndex();
      } catch {
        // Index build is best-effort: text recall still works, and the next
        // successful build (or a vector search that triggers hydration) will
        // pick the new vectors up. Never let a failed index build lose a write.
      }
    }
    return { written, skipped };
  }

  // --- Graph surface (associative recall) ----------------------------------
  //
  // Graph ops are EXEC-ONLY in `@plures/pluresdb-native@2.0.0-alpha.1`: there is
  // no direct `db.autoLink(...)` / `db.graphNeighbors(...)` NAPI method, only
  // `execIr(steps)` / `execDsl(query)`. We use `execIr` (JSON IR) over `execDsl`
  // so we never string-interpolate a category value or ISO timestamp into a DSL
  // string (quoting/injection safety). The IR field names below are verified
  // against the procedures crate (`ir.rs` `Step`/`Predicate`/`CmpOp`,
  // `ops/graph.rs` `auto_link`/`graph_neighbors`).

  /**
   * Run a raw procedure-IR pipeline through the SAME memoized handle and return
   * the native result (`{ nodes, aggregate?, mutated? }`). Thin pass-through:
   * callers (link-on-write, recall expansion) own the step shapes. Never throws
   * here — lets the focused helpers below decide best-effort behavior.
   */
  execIr(steps: unknown[]): unknown {
    return this.#ensureDb().execIr(steps);
  }

  /**
   * Link-on-write: create associative edges among the chunks written at/after
   * `sinceIso` (this sync's freshly-touched `session` nodes), so memory-core
   * gains structure a flat store cannot — "the other memories written in the
   * same session window / same category as this one".
   *
   * The leading `filter` is MANDATORY, not cosmetic: the engine seeds every
   * pipeline with `store.list()` (the ENTIRE store), and `auto_link` is O(n²)
   * over whatever set the prior step produced. Without the pre-filter,
   * `auto_link` would attempt to link the whole store (~499,500 candidate pairs
   * at 1k nodes). The filter scopes it to this sync's fresh `session` set:
   * `category == "session" AND timestamp >= sinceIso` (both are top-level fields
   * of the chunk `data` that `sync()` writes, so they resolve in the filter).
   *
   * `algorithms` is passed EXPLICITLY: an empty array makes the engine default
   * to ALL THREE algorithms, including the inert lexical `semantic` (Jaccard
   * over `data.text`/`data.tags`, which the chunk payload does not carry — so
   * v1 scopes to `category` + `temporal`, the honest same-session/same-category
   * association; embedding-cosine edges are deferred, not stubbed).
   *
   * Best-effort: edges are deterministic (`edge::{from}::{to}`) so re-running
   * over the same pair converges (no duplicate); any native error is swallowed
   * so a failed link never breaks `sync()`'s write contract.
   */
  linkRecent(
    sinceIso: string,
    algorithms: string[] = ["category", "temporal"],
    minStrength = 0.5,
  ): void {
    try {
      this.#ensureDb().execIr([
        {
          op: "filter",
          predicate: {
            and: [
              { field: "category", cmp: "==", value: "session" },
              { field: "timestamp", cmp: ">=", value: sinceIso },
            ],
          },
        },
        { op: "auto_link", algorithms, min_strength: minStrength },
      ]);
    } catch {
      // Best-effort: linking is additive associative enrichment. A failure here
      // must never propagate out of the caller's write path.
    }
  }

  /**
   * Associative expansion: return the graph neighbors of `seedId` (memory
   * chunks one or more hops away over the edges link-on-write created), mapped
   * to `{ id, data }`. `graph_neighbors` already excludes `_edge` nodes and the
   * root itself (`ops/graph.rs`), so every row is a real memory chunk.
   * `bidirectional:true` so orientation of the deterministic `from<to` edges
   * does not hide a neighbor at recall. Best-effort: returns `[]` on any error.
   */
  neighbors(
    seedId: string,
    depth = 1,
    minStrength = 0.5,
  ): Array<{ id: string; data: Record<string, unknown> }> {
    let result: unknown;
    try {
      result = this.#ensureDb().execIr([
        {
          op: "graph_neighbors",
          root: seedId,
          depth,
          min_strength: minStrength,
          bidirectional: true,
        },
      ]);
    } catch {
      return [];
    }
    const nodes =
      result && typeof result === "object"
        ? (result as { nodes?: unknown }).nodes
        : undefined;
    if (!Array.isArray(nodes)) return [];
    const out: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as RawNode;
      const id = asString(node.id);
      if (!id) continue;
      const data =
        node.data && typeof node.data === "object"
          ? (node.data as Record<string, unknown>)
          : {};
      // Defensive: graph_neighbors already drops edges, but never surface an
      // edge node as an associative "memory" even if the native shape changes.
      if (data._edge === true) continue;
      out.push({ id, data });
    }
    return out;
  }

  /**
   * Dirty check: returns true when `id` should be (re-)written. Reads the
   * existing node via the native `get(id)` and compares the stored `hash`
   * (primary) or `mtimeMs`+`size` (fallback) to the incoming payload. A missing
   * node, or any mismatch / unavailable signal, is treated as dirty (write).
   */
  #isDirty(
    db: PluresDatabaseType,
    id: string,
    data: Record<string, unknown>,
  ): boolean {
    let existing: unknown;
    try {
      existing = db.get(id);
    } catch {
      // get() failed — cannot prove it is clean, so write.
      return true;
    }
    if (!existing || typeof existing !== "object") return true;
    const prev = existing as Record<string, unknown>;

    // Primary signal: content hash.
    const nextHash = data.hash;
    if (typeof nextHash === "string" && nextHash.length > 0) {
      return prev.hash !== nextHash;
    }

    // Fallback signal: source mtime + size.
    const nextMtime = data.mtimeMs;
    const nextSize = data.size;
    if (typeof nextMtime === "number" && typeof nextSize === "number") {
      return prev.mtimeMs !== nextMtime || prev.size !== nextSize;
    }

    // No comparable signal on the incoming payload — default to writing so we
    // never silently drop a real update.
    return true;
  }
}

/**
 * TEST-ONLY fixture seeding. NOT part of the shipped read-only surface — it is
 * exported solely so the recall gate can populate a throwaway store through the
 * SAME native loader (and therefore the same binding resolver) used by the read
 * path. It writes WITH embeddings so vector recall is exercised end-to-end.
 *
 * Never import this from `index.ts` or any runtime path.
 */
export function seedStoreForTests(
  dbPath: string,
  nodes: Array<{ id: string; data: unknown; text: string }>,
  embeddingModel = "BAAI/bge-small-en-v1.5",
): { totalNodes: number } {
  const { PluresDatabase } = loadNative();
  // Open WITH embeddings: per the native contract, every subsequent `put` whose
  // data carries text content is auto-embedded and indexed, so we just `put`.
  const db = PluresDatabase.newWithEmbeddings(embeddingModel, "plureslm-seed", dbPath);
  for (const node of nodes) {
    db.put(node.id, node.data);
  }
  try {
    (db as unknown as { buildVectorIndex?: () => number }).buildVectorIndex?.();
  } catch {
    /* index build optional */
  }
  const raw = db.stats() as { totalNodes?: unknown } | null;
  const totalNodes = raw && typeof raw.totalNodes === "number" ? raw.totalNodes : 0;
  return { totalNodes };
}
