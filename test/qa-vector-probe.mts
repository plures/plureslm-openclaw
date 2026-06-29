/**
 * QA vector probe (Path B). Root-causes why buildVectorIndex() reports 0
 * entries for freshly `put` nodes in @plures/pluresdb-native@2.0.0-alpha.1.
 *
 * Three sub-commands (each its OWN process; the native lock is per-process, so
 * the reopen leg must run after the writer process has fully exited):
 *
 *   inproc <dir>  : open via newWithEmbeddings, run the FULL battery
 *                   (embed/get/getWithMetadata/buildVectorIndex/vectorSearch +
 *                   a putWithEmbedding control + text search), print JSON, exit
 *                   (releasing the lock). Leaves the written store on disk.
 *   reopen <dir>  : open a FRESH handle on the same dir, buildVectorIndex +
 *                   vectorSearch again, print JSON. Proves whether reopening
 *                   makes the put-node's vector appear (rules (b) in/out).
 *   (no args)     : driver — mkdtemp, spawn `inproc`, then spawn `reopen` on the
 *                   same dir, merge + print, cleanup.
 *
 * Native loaded via the SAME shim pluresdb.ts uses, but for determinism we also
 * honor an explicit NAPI_RS_NATIVE_LIBRARY_PATH (operator override) AND fall
 * back to the local source-crate .node, so the probe runs standalone.
 */

import { createRequire } from "node:module";
import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function bindingFileName(): string | null {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "pluresdb-node.win32-x64-msvc.node";
  if (platform === "darwin" && arch === "arm64") return "pluresdb-node.darwin-arm64.node";
  if (platform === "darwin" && arch === "x64") return "pluresdb-node.darwin-x64.node";
  if (platform === "linux" && arch === "x64") return "pluresdb-node.linux-x64-gnu.node";
  if (platform === "linux" && arch === "arm64") return "pluresdb-node.linux-arm64-gnu.node";
  return null;
}

function sourceCrateRoots(): string[] {
  const roots = new Set<string>();
  const env = process.env.PLURESDB_NODE_DIR;
  if (env) roots.add(env);
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    roots.add(join(here, "pluresdb", "crates", "pluresdb-node"));
    roots.add(join(dirname(here), "pluresdb", "crates", "pluresdb-node"));
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  // Known sibling checkout for this repo.
  roots.add("C:/Projects/pluresdb/crates/pluresdb-node");
  return [...roots];
}

function ensureNativeLibraryPath(): void {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH && existsSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH)) return;
  const file = bindingFileName();
  if (!file) return;
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
    try {
      const realDir = realpathSync(dir);
      if (realDir !== dir) candidates.push(join(realDir, file));
    } catch {
      /* ignore */
    }
  }
  for (const root of sourceCrateRoots()) candidates.push(join(root, file));
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = c;
      return;
    }
  }
}

type NativeMod = { PluresDatabase: any };
function loadNative(): NativeMod {
  ensureNativeLibraryPath();
  const mod = require("@plures/pluresdb-native") as NativeMod;
  if (!mod || typeof mod.PluresDatabase !== "function") throw new Error("native addon failed to load");
  return mod;
}

const MODEL = "BAAI/bge-small-en-v1.5";
const ACTOR = "qa-probe";
const SENTENCE = "QAVEC9001 the disaster recovery plan lives in the locked archive vault";

function vectorish(obj: unknown): { keys: string[]; vectorLen: number | null } {
  if (!obj || typeof obj !== "object") return { keys: [], vectorLen: null };
  const o = obj as Record<string, unknown>;
  let vectorLen: number | null = null;
  for (const k of ["embedding", "vector", "embeddings", "vec", "_embedding", "_vector"]) {
    if (Array.isArray(o[k])) vectorLen = (o[k] as unknown[]).length;
  }
  return { keys: Object.keys(o), vectorLen };
}

const cmd = process.argv[2];

// ----- inproc leg -----------------------------------------------------------
if (cmd === "inproc") {
  const dir = process.argv[3];
  const out: Record<string, unknown> = { leg: "inproc", dbPath: dir };
  const { PluresDatabase } = loadNative();
  const db = PluresDatabase.newWithEmbeddings(MODEL, ACTOR, dir);

  const dim = db.embeddingDimension();
  let embedVec: number[] | null = null;
  try {
    embedVec = db.embed(["hello world"])[0] ?? null;
  } catch (e) {
    out.embedError = String((e as Error)?.message ?? e);
  }
  out.embeddingDimension = dim;
  out.embedLength = Array.isArray(embedVec) ? embedVec.length : null;
  out.embedderWorks = typeof dim === "number" && dim > 0 && out.embedLength === dim;

  const id = "qa:vec:1";
  out.putReturn = db.put(id, { content: SENTENCE, category: "qa", type: "qa-probe", source: "sessions" });
  out.get = vectorish(db.get(id));
  out.getWithMetadata = typeof db.getWithMetadata === "function" ? vectorish(db.getWithMetadata(id)) : "n/a";

  out.buildVectorIndexReturn_afterPut = db.buildVectorIndex();

  if (Array.isArray(embedVec)) {
    const qvec = db.embed([SENTENCE])[0];
    const hits = db.vectorSearch(qvec, 5, 0.0) ?? [];
    out.vectorSearchHitCount_inProc = hits.length;
    out.vectorSearchTopId_inProc = hits[0]?.id ?? null;
  }

  // CONTROL: explicit precomputed embedding via putWithEmbedding.
  if (Array.isArray(embedVec) && typeof db.putWithEmbedding === "function") {
    const ctrlVec = db.embed([SENTENCE])[0];
    db.putWithEmbedding("qa:vec:ctrl", { content: SENTENCE, category: "qa", source: "sessions" }, ctrlVec);
    out.control_buildReturn = db.buildVectorIndex();
    out.control_vectorSearchHitCount = (db.vectorSearch(ctrlVec, 5, 0.0) ?? []).length;
  }

  const textHits = db.search("disaster recovery plan", 5) ?? [];
  out.textSearchHitCount = textHits.length;
  out.textSearchTopId = textHits[0]?.id ?? null;
  out.statsTotalNodes = db.stats()?.totalNodes ?? null;

  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

// ----- reopen leg -----------------------------------------------------------
if (cmd === "reopen") {
  const dir = process.argv[3];
  const out: Record<string, unknown> = { leg: "reopen", dbPath: dir };
  const { PluresDatabase } = loadNative();
  const db = PluresDatabase.newWithEmbeddings(MODEL, ACTOR, dir);
  out.totalNodes = db.stats()?.totalNodes ?? null;
  out.buildVectorIndexReturn = db.buildVectorIndex();
  // Is the put-node's vector now present on get?
  out.get_putNode = vectorish(db.get("qa:vec:1"));
  let vec: number[] | null = null;
  try {
    vec = db.embed([SENTENCE])[0] ?? null;
  } catch {
    vec = null;
  }
  if (Array.isArray(vec)) {
    const hits = db.vectorSearch(vec, 5, 0.0) ?? [];
    out.vectorSearchHitCount = hits.length;
    out.vectorSearchTopId = hits[0]?.id ?? null;
    out.vectorSearchTopIds = hits.map((h: any) => h?.id).slice(0, 5);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

// ----- driver ---------------------------------------------------------------
const selfUrl = fileURLToPath(import.meta.url);
const tsxCli = join(dirname(selfUrl), "..", "node_modules", "tsx", "dist", "cli.mjs");
function spawnLeg(leg: string, dir: string) {
  const res = spawnSync(process.execPath, [tsxCli, selfUrl, leg, dir], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  const last = (res.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = { raw: last, stderr: (res.stderr ?? "").trim().slice(0, 500), status: res.status };
  }
  return parsed;
}

const dir = mkdtempSync(join(tmpdir(), "plureslm-qavec-"));
try {
  const inproc = spawnLeg("inproc", dir); // writer process exits -> lock freed
  const reopen = spawnLeg("reopen", dir); // fresh process opens same dir
  console.log(JSON.stringify({ inproc, reopen }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
