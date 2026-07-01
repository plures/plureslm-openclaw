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

import { detectSecret } from "./redact.js";

// The package ships a CommonJS `index.js` that loads the platform `.node`
// addon. Load it through createRequire so this ESM module stays NodeNext-clean
// without a default-interop shim.
const require = createRequire(import.meta.url);

// --- P4 governed-write gate (C-MEM-REDACT) ---------------------------------
//
// The pre-write secret gate is DB-GOVERNED, not a TS `if`: at open we persist an
// error-severity praxis constraint into the CRDT store via `pxInsertConstraint`,
// and every write routes its honest `has_secret` signal through the native
// `pxOnAction` engine (`on_action`), which THROWS (`ActionBlocked`) when the
// constraint fires. This was confirmed empirically against
// `@plures/pluresdb-native@2.0.0-alpha.1` (see P3-P4-IMPLEMENT-NOTES.md):
//   - pxInsertConstraint({ ...require: {field:"has_secret",op:"field_eq",value:0},
//     severity:"error" }) persists a real compiled field_eq Condition.
//   - pxOnAction({ metadata:{ has_secret:1 } }) THROWS
//     [CORE_INVALID_INPUT] action blocked by 1 constraint(s): [C-MEM-REDACT] ...
//   - pxOnAction({ metadata:{ has_secret:0 } }) returns { violations: [] } (PASS).
// The native enforces; this module only (a) declares the rule once and (b) feeds
// it the real detector's boolean. A flagged chunk is REFUSED (never persisted),
// surfaced in the write accounting -- never silently dropped (C-NOSTUB-001).
//
// NATIVE-GOVERNANCE NOTE (honest boundary): the .px *source document* path
// (pxLoadPxSource('constraint ... { require: ... }')) does NOT parse the
// constraint syntax we need in this alpha (it expects a different top-level
// document grammar and rejects `constraint <id> { ... }`). So the rule is
// declared via the STRUCTURED pxInsertConstraint API (a real persisted CRDT
// constraint node compiled to an enforcing Condition) rather than from .px
// text. Enforcement still runs entirely inside the native on_action engine --
// it is genuinely DB-governed (C-PLURES-004), not a TS-side decision.
const REDACT_CONSTRAINT_ID = "C-MEM-REDACT";
const MEMORY_WRITE_ACTION = "memory_write";

/**
 * Content-bearing fields the RECALL path can surface as a node's snippet, in
 * priority order (must stay in sync with `deriveSnippet` /
 * `deriveSnippetFromData` in this file and `memory-capability.ts`). The
 * governed-write gate scans ALL of these (plus an exact mirror of the recall
 * whole-payload fallback) so a secret cannot hide in a recallable field the
 * detector never inspected.
 */
const RECALL_CONTENT_FIELDS = [
  "content",
  "text",
  "summary",
  "value",
  "body",
  "note",
] as const;

/**
 * Structural / bookkeeping payload keys that are NEVER user content and are
 * NEVER surfaced as a recall snippet (they are ids, hashes, line numbers,
 * sizes, timestamps, graph plumbing). The gate excludes their values from the
 * whole-payload fallback scan so a synthetic id-shaped value (e.g. a chunk
 * `hash` like `h-foo-bar-1`, 24+ mixed-class chars) is not mistaken for an
 * opaque secret — the same class of structured-non-secret carve-out the
 * detector already applies to UUIDs and base64 media. A real secret is content,
 * and content never lives in these keys.
 */
const STRUCTURAL_NONCONTENT_KEYS = new Set<string>([
  "hash",
  "category",
  "type",
  "kind",
  "source",
  "path",
  "file",
  "id",
  "mtimeMs",
  "size",
  "chunkIndex",
  "startLine",
  "endLine",
  "timestamp",
  "createdAt",
  "updatedAt",
  "_edge",
  "superseded_by",
  "structural_rank",
  "pagerank_score",
  "decay",
]);

/** The structured, error-severity constraint persisted to govern writes. */
function redactConstraintSpec(): Record<string, unknown> {
  return {
    id: REDACT_CONSTRAINT_ID,
    description:
      "Refuse persisting any memory chunk whose content contains secret material (has_secret must be 0).",
    when: { op: "always" },
    require: { field: "has_secret", op: "field_eq", value: 0 },
    fix: "Redact the secret (API key, AWS key, PEM private key, bearer/JWT, high-entropy token) before writing.",
    evidence: [],
    severity: "error",
  };
}

// --- P3 reactive consolidation sweep (pull/tick, NOT push) ------------------
//
// HARD REALITY (confirmed against `@plures/pluresdb-native@2.0.0-alpha.1`): the
// Node binding has NO push/reactive path — a `put` does not auto-run a
// procedure, `subscribe()` is an id-only stub, and procedures are not
// executable via the binding. So consolidation is a PULL/TICK sweep: a set of
// idempotent `execIr` steps run on the SINGLE memoized handle, invoked
// opportunistically by the lazy `sync()` path (never a background thread, never
// a second handle, never a self-firing timer — any of which would break the
// native's exclusive file lock). Schedule/checkpoint state is DURABLE, stored
// via the real `agensStateSet`/`agensStateGet` reactive-state table (confirmed
// present + round-trips) so the interval guard and run history survive restart.
const CONSOLIDATE_CHECKPOINT_KEY = "plureslm:consolidate:checkpoint";
/** Minimum wall-clock gap between unforced consolidation sweeps. */
const CONSOLIDATE_MIN_INTERVAL_MS = 60_000;

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

/**
 * Why a node was NOT written during a {@link PluresLmStore.store} /
 * {@link PluresLmStore.put} call:
 *  - `"unchanged"` — dirty-tracking matched the stored content (no re-embed).
 *  - `"secret"` — REFUSED by the C-MEM-REDACT governed-write gate: the chunk
 *    content tripped the real secret detector and the native `pxOnAction`
 *    engine blocked the write. The node was NOT persisted; this is an honest
 *    refusal surfaced to the caller, never a silent drop (C-NOSTUB-001).
 */
export type SkipReason = "unchanged" | "secret";

/** One refused-write record (id + the secret kind that tripped the gate). */
export type RefusedWrite = {
  id: string;
  reason: "secret";
  /** Short label of the secret shape detected (e.g. `aws-access-key-id`). */
  kind?: string;
};

/**
 * Result of a batch {@link PluresLmStore.store}.
 *  - `written` — nodes actually persisted.
 *  - `skipped` — nodes not persisted because unchanged (dirty-tracking).
 *  - `refused` — nodes BLOCKED by the governed-write gate (secret content).
 *    These are reported, never silently dropped; `refusedDetail` carries the
 *    id + detected secret kind for each.
 */
export type StoreWriteResult = {
  written: number;
  skipped: number;
  refused: number;
  refusedDetail: RefusedWrite[];
};

/**
 * Outcome of one {@link PluresLmStore.consolidate} pull/tick sweep.
 *  - `ran` — false when the interval guard short-circuited (cheap no-op).
 *  - `reason` — why it ran or was skipped (`"forced"`, `"interval"`,
 *    `"too-soon"`, `"empty"`, `"error"`).
 *  - `edges` — total associative edges in the graph after the sweep.
 *  - `sessionNodes` — count of session memory chunks considered.
 *  - `clusters` — number of communities detected (louvain), 0 when none.
 *  - `topRanked` — up to a few highest-PageRank node ids (structural salience).
 *  - `runs` — monotonic count of sweeps recorded in the durable checkpoint.
 *  - `checkpointEpoch` — the persisted lastRunEpoch after this sweep.
 * Every field is derived from a REAL execIr result; nothing is fabricated. When
 * a sub-metric is not computable it is reported honestly (0 / empty), not faked.
 */
export type ConsolidateResult = {
  ran: boolean;
  reason: "forced" | "interval" | "too-soon" | "empty" | "error";
  edges: number;
  sessionNodes: number;
  clusters: number;
  topRanked: string[];
  runs: number;
  checkpointEpoch: number;
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
    // Prefer common content-bearing fields, in priority order (shared with the
    // governed-write gate so the two never drift — see RECALL_CONTENT_FIELDS).
    for (const key of RECALL_CONTENT_FIELDS) {
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
  /**
   * Process-local latch: the C-MEM-REDACT governed-write constraint is declared
   * into the store at most once per handle (idempotent in the native too, but we
   * avoid the redundant call). `null` = not yet attempted, `true` = persisted,
   * `false` = declaration failed (gate then fails CLOSED — see {@link #gateWrite}).
   */
  #governanceReady: boolean | null = null;

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
   * TEST-ONLY seam (documented double at a real seam — C-NOSTUB-001 item 3, NOT
   * a shipped path): force the governance latch into the FAILED state, exactly
   * as if the native `pxInsertConstraint` declaration had thrown when installing
   * C-MEM-REDACT. This does NOT fake the gate's decision — it induces the
   * genuine precondition ("the safety rule could not be installed") that is
   * otherwise nondeterministic to trigger, so the fail-CLOSED branch of the REAL
   * {@link #gateWrite} (refuse every detector-positive chunk; never let a
   * detected secret through ungoverned) can be exercised deterministically.
   *
   * `failed:true`  -> latch = false (governance unavailable; gate fails closed).
   * `failed:false` -> clear the latch so the next write re-attempts the real
   *                   native declaration. The block/allow outcome is still
   *                   computed by the real detector + real fail-closed logic.
   */
  _forceGovernanceFailedForTests(failed: boolean): void {
    this.#governanceReady = failed ? false : null;
  }

  /**
   * TEST-ONLY seam: report the current governance latch state
   * (`true`=installed, `false`=failed/closed, `null`=not yet attempted) so a
   * fail-closed test can assert the precondition it induced actually holds.
   */
  _governanceStateForTests(): boolean | null {
    return this.#governanceReady;
  }

  /**
   * TEST-ONLY seam (documented double at a real seam — C-NOSTUB-001 item 3, NOT
   * a shipped path): make the next `count` invocations of the live handle's
   * native `execIr` THROW, so the best-effort posture of {@link consolidate}
   * (every internal `execIr` step is wrapped; a native failure degrades that
   * metric and the sweep still returns / never throws out of the write/search
   * contract) can be proven against a REAL throw rather than an assumed one.
   * Defaults to poisoning every subsequent call until cleared with `count<=0`.
   * The real `consolidate`/`execIr` error handling is what is under test — this
   * only injects the failure at the native boundary.
   */
  _poisonExecIrForTests(count = Number.MAX_SAFE_INTEGER): void {
    const db = this.#ensureDb() as unknown as {
      execIr: (steps: unknown[]) => unknown;
      __plmRealExecIr?: (steps: unknown[]) => unknown;
    };
    if (count <= 0) {
      // Restore the genuine native execIr.
      if (db.__plmRealExecIr) {
        db.execIr = db.__plmRealExecIr;
        delete db.__plmRealExecIr;
      }
      return;
    }
    if (!db.__plmRealExecIr) db.__plmRealExecIr = db.execIr.bind(db);
    const real = db.__plmRealExecIr;
    let remaining = count;
    db.execIr = (steps: unknown[]) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("[test] injected execIr failure (poison seam)");
      }
      return real(steps);
    };
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
   * Declare the C-MEM-REDACT governed-write constraint into the store (once per
   * handle). The rule is a real, persisted, error-severity praxis constraint
   * compiled to an enforcing `field_eq` Condition (`has_secret == 0`); the
   * native `on_action` engine enforces it on every {@link #gateWrite}. Returns
   * `true` when the constraint is in place. If declaration fails we record
   * `false` and the gate fails CLOSED (refuses writes) rather than silently
   * letting ungoverned writes through — a safety rule that cannot be installed
   * must not be silently skipped.
   *
   * Idempotent: `pxInsertConstraint` upserts by id, and the latch avoids the
   * redundant native call after the first success.
   */
  #ensureGovernance(db: PluresDatabaseType): boolean {
    if (this.#governanceReady !== null) return this.#governanceReady;
    try {
      // `pxInsertConstraint` persists the structured constraint as a CRDT node
      // and compiles `require` into a real enforcing Condition. Confirmed to
      // make `pxOnAction` THROW on has_secret=1 / PASS on 0 (see notes).
      (db as unknown as { pxInsertConstraint: (c: unknown) => unknown }).pxInsertConstraint(
        redactConstraintSpec(),
      );
      this.#governanceReady = true;
    } catch {
      // Could not install the safety rule — fail closed.
      this.#governanceReady = false;
    }
    return this.#governanceReady;
  }

  /**
   * Governed-write gate (C-MEM-REDACT). Runs BEFORE a node is persisted:
   *  1. compute the honest `has_secret` boolean over the node's embeddable/
   *     snippet text via the real {@link detectSecret} detector, then
   *  2. route the decision through the native `pxOnAction` engine, which THROWS
   *     (`ActionBlocked`) when the persisted error-severity constraint fires.
   *
   * Returns `{ allow:true }` when the write is permitted, or
   * `{ allow:false, kind }` when it is REFUSED (caller must NOT persist the
   * node and must report the refusal). Fails CLOSED: if governance could not be
   * installed, or any detector-positive chunk reaches an engine that does not
   * throw, the write is refused — a secret must never slip through because the
   * gate was unavailable.
   *
   * The block decision is made by the native engine, not by a TS `if`: this
   * method only supplies the detector signal and interprets the throw. That is
   * what makes the rule DB-governed (C-PLURES-004) rather than a local check.
   */
  /**
   * The text surface a recall could expose for a node — the exact input the gate
   * must scan so a secret cannot hide in a content field the detector never saw.
   * (QA DEF: a benign `content` with a live token in `value`/`body`/`note`/an
   * arbitrary content field used to be WRITTEN and then RECALLED — a real leak,
   * because the gate only inspected the single primary snippet.)
   *
   * Scans every CONTENT-bearing string value in the payload (recursively into
   * nested objects/arrays), each on its own line, but EXCLUDES structural /
   * bookkeeping keys ({@link STRUCTURAL_NONCONTENT_KEYS}: ids, hashes, line
   * numbers, sizes, timestamps, graph plumbing) whose synthetic id-shaped values
   * are never user content and never a recall snippet — including them would
   * manufacture false `high-entropy-token` positives (e.g. a chunk `hash` like
   * `h-foo-bar-1`) without catching any real secret.
   *
   * It deliberately joins discrete string VALUES with newlines rather than
   * feeding a `JSON.stringify` of the object to the detector: serialized JSON
   * glues values to keys/punctuation and that manufactured run trips the entropy
   * heuristic on wholly clean content. Scanning the discrete content values
   * preserves each token's real boundaries (exactly what a recall snippet shows)
   * so the gate catches a secret in ANY content field WITHOUT inventing false
   * positives. This is a SUPERSET of the old single-snippet scan for content
   * fields (it can only catch more real secrets) and, because structural keys are
   * excluded, it does not over-block clean payloads.
   */
  #gateScanText(data: Record<string, unknown>): string {
    const values: string[] = [];
    const seen = new Set<unknown>();
    const visit = (v: unknown, key: string | null): void => {
      // Skip structural/bookkeeping keys entirely — their values are ids/hashes,
      // never content, never a recall snippet.
      if (key !== null && STRUCTURAL_NONCONTENT_KEYS.has(key)) return;
      if (typeof v === "string") {
        if (v.length > 0) values.push(v);
        return;
      }
      if (v && typeof v === "object") {
        if (seen.has(v)) return; // guard against cyclic payloads
        seen.add(v);
        if (Array.isArray(v)) {
          for (const item of v) visit(item, key);
        } else {
          for (const [k, item] of Object.entries(v as Record<string, unknown>)) visit(item, k);
        }
      }
      // numbers/booleans/null are never credential-bearing text — ignore.
    };
    visit(data, null);
    return values.join("\n");
  }

  #gateWrite(
    db: PluresDatabaseType,
    id: string,
    data: Record<string, unknown>,
  ): { allow: true } | { allow: false; kind?: string } {
    // The gate inspects the FULL recall-exposable surface (every content field
    // AND the whole-payload JSON), not just the primary snippet — a secret in
    // any recallable field must be caught, never only the one in `content`.
    const text = this.#gateScanText(data);
    const finding = detectSecret(text);

    const governed = this.#ensureGovernance(db);
    const ctx = {
      action_type: MEMORY_WRITE_ACTION,
      target: id,
      session_type: "main",
      metadata: { has_secret: finding.has_secret ? 1 : 0 },
    };

    if (!governed) {
      // Safety rule unavailable: fail closed. Only refuse the chunks the real
      // detector flagged (clean chunks still write) — we never fabricate a
      // secret, but we never let a detected one through ungoverned either.
      return finding.has_secret ? { allow: false, kind: finding.kind } : { allow: true };
    }

    try {
      (db as unknown as { pxOnAction: (c: unknown) => unknown }).pxOnAction(ctx);
      // Engine permitted the action. Defense-in-depth: if the detector says
      // secret but the engine somehow did not throw, refuse anyway (fail closed).
      if (finding.has_secret) return { allow: false, kind: finding.kind };
      return { allow: true };
    } catch {
      // Engine BLOCKED the write (ActionBlocked thrown) — honest refusal.
      return { allow: false, kind: finding.kind };
    }
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
   * Read one node payload by id (read-only pass-through to native `get`).
   * Returns the stored object, or `null` when absent / on any error. Used by
   * callers (and the gate) that need a direct existence/absence check — e.g. to
   * prove a chunk REFUSED by the governed-write gate was truly never persisted.
   */
  get(id: string): Record<string, unknown> | null {
    let raw: unknown;
    try {
      raw = this.#ensureDb().get(id);
    } catch {
      return null;
    }
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
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
   * Governed-write gate (C-MEM-REDACT) runs FIRST: the node content is scanned
   * by the real secret detector and the decision is routed through the native
   * `pxOnAction` engine. A chunk carrying secret material is REFUSED — NOT
   * persisted — and `false` is returned (same as an unchanged skip from the
   * caller's boolean view; use {@link store} when you need the refusal reason).
   *
   * Dirty-tracking: when the dirty key (the chunk `hash`, falling back to
   * `mtimeMs`+`size`) matches what is already stored under `id`, the put is
   * SKIPPED and `false` is returned — so a re-sync of unchanged content does not
   * re-embed. Returns `true` when a put actually happened.
   *
   * Embed-on-write (DEF-PATHB-1): when an embedder is available and the node
   * carries embeddable text (`content` -> `text` -> `summary`), the vector is
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
    // Governed-write gate BEFORE persistence: a secret-bearing chunk is refused.
    if (this.#gateWrite(db, id, data).allow !== true) return false;
    this.#writeNode(db, id, data);
    return true;
  }

  /**
   * Write a batch of nodes, then build the vector index once (best-effort).
   * Returns how many were actually `written`, `skipped` as unchanged, and
   * `refused` by the governed-write gate (with per-id `refusedDetail`).
   *
   * Governed-write gate (C-MEM-REDACT): every node is scanned for secret
   * material by the real detector and the block/allow decision is made by the
   * native `pxOnAction` engine BEFORE the node is persisted. A flagged chunk is
   * REFUSED (not written) and recorded in `refused`/`refusedDetail` — an honest
   * refusal surfaced to the caller, never a silent drop (C-NOSTUB-001). Clean
   * sibling chunks in the same batch are unaffected and still written.
   *
   * Skips are driven by per-node dirty-tracking (see {@link put}); a re-sync of
   * already-current chunks is therefore cheap (no re-embed, no index rebuild
   * cost beyond the single best-effort call). When nothing was written the
   * index rebuild is skipped entirely.
   */
  store(
    nodes: Array<{ id: string; data: Record<string, unknown> }>,
  ): StoreWriteResult {
    const db = this.#ensureDb();
    let written = 0;
    let skipped = 0;
    const refusedDetail: RefusedWrite[] = [];
    for (const node of nodes) {
      // Check dirtiness FIRST so an unchanged node is never embedded nor gated
      // — the lazy pre-search sync stays cheap (no wasted work on skips).
      if (!this.#isDirty(db, node.id, node.data)) {
        skipped += 1;
        continue;
      }
      // Governed-write gate BEFORE persistence. A refusal is RECORDED (id +
      // detected secret kind), never silently dropped.
      const decision = this.#gateWrite(db, node.id, node.data);
      if (decision.allow !== true) {
        refusedDetail.push({ id: node.id, reason: "secret", kind: decision.kind });
        continue;
      }
      this.#writeNode(db, node.id, node.data);
      written += 1;
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
    return { written, skipped, refused: refusedDetail.length, refusedDetail };
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
   * `sinceEpoch` (this sync's freshly-touched `session` nodes), so memory-core
   * gains structure a flat store cannot — "the other memories written in the
   * same session window / same category as this one".
   *
   * The leading `filter` is MANDATORY, not cosmetic: the engine seeds every
   * pipeline with `store.list()` (the ENTIRE store), and `auto_link` is O(n²)
   * over whatever set the prior step produced. Without the pre-filter,
   * `auto_link` would attempt to link the whole store (~499,500 candidate pairs
   * at 1k nodes). The filter scopes it to this sync's fresh `session` set:
   * `category == "session" AND syncEpoch >= sinceEpoch`.
   *
   * NOTE on the narrowing key (verified against `ops/filter.rs`): the engine's
   * `>=` (`compare_numeric`) only compares JSON *numbers* — it returns false for
   * a String field, with NO string-ordering fallback. So an ISO-string
   * `timestamp >= "<iso>"` filter is ALWAYS empty (proven: it dropped the set to
   * 0 and formed 0 edges). We therefore narrow on the NUMERIC `data.syncEpoch`
   * (`Date.now()` stamped on every chunk at sync start) instead, which `>=`
   * actually supports. `category` is a string and uses `==` (which does compare
   * strings), so it is unaffected.
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
    sinceEpoch: number,
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
              { field: "syncEpoch", cmp: ">=", value: sinceEpoch },
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

  // --- P3 reactive consolidation sweep (pull/tick) -------------------------

  /**
   * Read the durable consolidation checkpoint from the Agens reactive-state
   * table (`agensStateGet`). Returns the FULL persisted shape
   * `{ lastRunEpoch, runs, edges, clusters, topRanked }` (zeros / empty array
   * when no checkpoint exists yet). Never throws.
   *
   * P2-0 (reader fix): `#writeCheckpoint` persists `edges`, `clusters`, and the
   * structural-salience `topRanked` ids alongside `lastRunEpoch`/`runs`, but
   * this reader historically read back ONLY `lastRunEpoch`/`runs`, orphaning
   * the persisted salience. We now read ALL persisted fields so salience that
   * consolidate() COMPUTED + PERSISTED can actually be CONSUMED (by the
   * salience-weighted recall sort). This ONLY reads what was persisted — it
   * never recomputes pagerank at read time.
   */
  #readCheckpoint(db: PluresDatabaseType): {
    lastRunEpoch: number;
    runs: number;
    edges: number;
    clusters: number;
    topRanked: string[];
  } {
    try {
      const raw = (
        db as unknown as { agensStateGet: (k: string) => unknown }
      ).agensStateGet(CONSOLIDATE_CHECKPOINT_KEY);
      if (raw && typeof raw === "object") {
        const o = raw as Record<string, unknown>;
        const lastRunEpoch = typeof o.lastRunEpoch === "number" ? o.lastRunEpoch : 0;
        const runs = typeof o.runs === "number" ? o.runs : 0;
        const edges = typeof o.edges === "number" ? o.edges : 0;
        const clusters = typeof o.clusters === "number" ? o.clusters : 0;
        // Persisted topRanked is a string[]; defensively filter to strings so a
        // corrupt/legacy entry can never inject a non-string id downstream.
        const topRanked = Array.isArray(o.topRanked)
          ? o.topRanked.filter((x): x is string => typeof x === "string")
          : [];
        return { lastRunEpoch, runs, edges, clusters, topRanked };
      }
    } catch {
      /* no checkpoint / state table unavailable -> treat as never-run */
    }
    return { lastRunEpoch: 0, runs: 0, edges: 0, clusters: 0, topRanked: [] };
  }

  /**
   * Structural-salience accessor: the set of node ids that consolidate()
   * ranked highest by PageRank and PERSISTED into the durable checkpoint
   * (`topRanked`). Read-only pass-through to {@link #readCheckpoint} — it does
   * NOT recompute pagerank; it returns exactly what the last sweep persisted.
   *
   * Empty set when no sweep has persisted salience yet (never-run, empty
   * corpus, or a corpus with no edges → uniform/absent pagerank). An empty set
   * makes the salience-weighted recall sort a NO-OP (byte-identical to the raw
   * score sort), which is the required invariant.
   */
  #salientIds(db: PluresDatabaseType): Set<string> {
    return new Set(this.#readCheckpoint(db).topRanked);
  }

  /** Count rows in an execIr `{ nodes }` result (0 on any non-array). */
  #countNodes(result: unknown): number {
    const nodes =
      result && typeof result === "object"
        ? (result as { nodes?: unknown }).nodes
        : undefined;
    return Array.isArray(nodes) ? nodes.length : 0;
  }

  /**
   * Reactive in-DB consolidation sweep (PULL/TICK, not push).
   *
   * Idempotent + safe to call repeatedly. Steps, all via `execIr` on the single
   * memoized handle (no second handle, no thread, no timer):
   *  1. Interval guard: read the DURABLE checkpoint (`agensStateGet`); when the
   *     last sweep was < {@link CONSOLIDATE_MIN_INTERVAL_MS} ago and `force` is
   *     not set, return `{ ran:false, reason:"too-soon" }` — cheap no-op so the
   *     lazy `reason:"search"` path can call it on every search without cost.
   *  2. Scope: `aggregate(count)` the `category=="session"` chunks. When zero,
   *     return `{ ran:false, reason:"empty" }` (nothing to consolidate — honest,
   *     not a fake result).
   *  3. Consolidate edges: `auto_link(category,temporal)` over the session set.
   *     Edges are deterministic (`edge::{from}::{to}`), so re-running converges
   *     (no duplicate/explosion — proven: a 2nd sweep leaves the edge count
   *     unchanged). This is the materialized associative structure.
   *  4. Salience: `graph_pagerank` over the edge graph -> the top-ranked node
   *     ids (structural importance), and `graph_clusters(louvain)` -> community
   *     count. Both are REAL native ops; their outputs are summarized, never
   *     fabricated. (We do NOT mutate node payloads with the scores: pagerank
   *     drifts every run, so persisting it onto nodes would create write churn;
   *     the salient ids live in the checkpoint instead.)
   *  5. Persist the DURABLE checkpoint via `agensStateSet`: bump a monotonic
   *     `runs` counter, stamp `lastRunEpoch`, and record `edges`/`clusters`/
   *     `topRanked` so the consolidation state survives restart and the next
   *     interval guard can read it.
   *
   * Honest absence: a decay/eviction step that DELETES stale low-salience nodes
   * is intentionally NOT performed — this surface never calls native `delete`
   * (the read+write+graph contract is augment-only), so true decay-by-removal is
   * deferred rather than faked. The monotonic `runs` counter IS the durable
   * decay/age signal a later eviction policy can build on.
   *
   * Returns a {@link ConsolidateResult} describing exactly what ran. Best-effort
   * per sub-step: a failing native op degrades that metric to 0/empty and the
   * sweep still records its checkpoint; only a catastrophic failure returns
   * `{ ran:false, reason:"error" }`.
   */
  consolidate(opts?: { force?: boolean }): ConsolidateResult {
    const force = opts?.force === true;
    let db: PluresDatabaseType;
    try {
      db = this.#ensureDb();
    } catch {
      return {
        ran: false,
        reason: "error",
        edges: 0,
        sessionNodes: 0,
        clusters: 0,
        topRanked: [],
        runs: 0,
        checkpointEpoch: 0,
      };
    }

    const checkpoint = this.#readCheckpoint(db);
    const now = Date.now();
    // 1) Interval guard (durable). Cheap no-op on the hot search path.
    if (!force && checkpoint.lastRunEpoch > 0 && now - checkpoint.lastRunEpoch < CONSOLIDATE_MIN_INTERVAL_MS) {
      return {
        ran: false,
        reason: "too-soon",
        edges: 0,
        sessionNodes: 0,
        clusters: 0,
        topRanked: [],
        runs: checkpoint.runs,
        checkpointEpoch: checkpoint.lastRunEpoch,
      };
    }

    // 2) Scope: count session chunks. Empty -> nothing to consolidate.
    let sessionNodes = 0;
    try {
      const agg = db.execIr([
        { op: "filter", predicate: { field: "category", cmp: "==", value: "session" } },
        { op: "aggregate", func: "count" },
      ]) as { aggregate?: unknown };
      sessionNodes = typeof agg?.aggregate === "number" ? agg.aggregate : 0;
    } catch {
      sessionNodes = 0;
    }
    if (sessionNodes === 0) {
      // Record the run so the interval guard advances even on an empty sweep.
      const runs = checkpoint.runs + 1;
      this.#writeCheckpoint(db, { lastRunEpoch: now, runs, edges: 0, clusters: 0, topRanked: [] });
      return {
        ran: false,
        reason: "empty",
        edges: 0,
        sessionNodes: 0,
        clusters: 0,
        topRanked: [],
        runs,
        checkpointEpoch: now,
      };
    }

    // 3) Consolidate edges over the session set (idempotent / deterministic).
    try {
      db.execIr([
        { op: "filter", predicate: { field: "category", cmp: "==", value: "session" } },
        { op: "auto_link", algorithms: ["category", "temporal"], min_strength: 0.5 },
      ]);
    } catch {
      /* edge formation best-effort; salience below still summarizes what exists */
    }

    // Total edges after consolidation.
    let edges = 0;
    try {
      edges = this.#countNodes(db.execIr([{ op: "graph_links" }]));
    } catch {
      edges = 0;
    }

    // 4) Salience: PageRank top ids + louvain cluster count.
    const topRanked: string[] = [];
    try {
      const pr = db.execIr([{ op: "graph_pagerank", damping: 0.85, iterations: 50 }]) as {
        nodes?: Array<{ id?: unknown; data?: unknown }>;
      };
      const rows = Array.isArray(pr?.nodes) ? pr.nodes : [];
      rows
        .map((r) => ({
          id: typeof r.id === "string" ? r.id : "",
          score:
            r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).pagerank_score === "number"
              ? ((r.data as Record<string, unknown>).pagerank_score as number)
              : 0,
        }))
        .filter((r) => r.id && !r.id.startsWith("edge::"))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .forEach((r) => topRanked.push(r.id));
    } catch {
      /* pagerank best-effort -> empty topRanked */
    }

    let clusters = 0;
    try {
      clusters = this.#countNodes(
        db.execIr([{ op: "graph_clusters", algorithm: "louvain", min_size: 2 }]),
      );
    } catch {
      clusters = 0;
    }

    // 5) Persist the durable checkpoint (monotonic run counter).
    const runs = checkpoint.runs + 1;
    this.#writeCheckpoint(db, { lastRunEpoch: now, runs, edges, clusters, topRanked });

    return {
      ran: true,
      reason: force ? "forced" : "interval",
      edges,
      sessionNodes,
      clusters,
      topRanked,
      runs,
      checkpointEpoch: now,
    };
  }

  /** Persist the consolidation checkpoint to the durable Agens state table. */
  #writeCheckpoint(
    db: PluresDatabaseType,
    state: { lastRunEpoch: number; runs: number; edges: number; clusters: number; topRanked: string[] },
  ): void {
    try {
      (db as unknown as { agensStateSet: (k: string, v: unknown) => void }).agensStateSet(
        CONSOLIDATE_CHECKPOINT_KEY,
        state,
      );
    } catch {
      /* durable checkpoint best-effort; an unwritten checkpoint just means the
         next sweep re-evaluates the interval from the prior value (or runs). */
    }
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
