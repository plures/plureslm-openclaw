/**
 * Typed, read-only wrapper around `@plures/pluresdb-native`.
 *
 * Stage A scope: READ PATH ONLY. This module never calls `put`, `delete`,
 * `exec`, or any mutating method. It opens a PluresDB store and exposes a
 * narrow recall surface (vector + text search), status, and availability
 * probes.
 *
 * Two hard constraints from the native, verified against
 * `@plures/pluresdb-native@2.0.0-alpha.1`:
 *
 *  1. A given `dbPath` holds an EXCLUSIVE file lock — only one open handle may
 *     exist per path per process. We therefore memoize one handle per resolved
 *     dbPath (a process-local singleton) instead of opening a fresh handle on
 *     every recall.
 *  2. `search()` / `vectorSearch()` / `list()` return records shaped like
 *     `{ id, data, score, timestamp }`. `stats()` returns
 *     `{ totalNodes, typeCounts }`.
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
  /** Which retrieval path produced the hit. */
  via: "vector" | "text";
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
  /** Actor id for the read handle. Read-only, but the native requires one. */
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

function normalizeHit(raw: unknown, via: "vector" | "text"): RecallHit | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as RawNode;
  const id = asString(node.id);
  if (!id) return null;
  const data = node.data;
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
    return "plureslm-reader";
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
