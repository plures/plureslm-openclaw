/**
 * QA vector-after-fix probe (Path B, DEF-PATHB-1 FIX verification).
 *
 * Proves that semantic (VECTOR) recall of memory written through the SHIPPED
 * `sync()` path now works, after routing the write path through
 * `putWithEmbedding` (explicit embed-on-write) instead of the native alpha's
 * non-auto-embedding `put`.
 *
 * Two legs, each its OWN process (the native holds a per-process exclusive lock,
 * so the reopen/read leg runs only after the writer process has fully exited):
 *
 *   write <dir> : open the SHIPPED capability (dist/api.js ->
 *                 buildMemoryCapability -> getMemorySearchManager), write a real
 *                 session file with a unique sentinel sentence, and `sync()` it
 *                 through the shipped path. Prints the sync delta. Exits
 *                 (releasing the lock), leaving the store on disk.
 *   read  <dir> : FRESH process on the SAME dir. Opens the native directly via
 *                 newWithEmbeddings (same model), embeds the query, and calls
 *                 db.vectorSearch(embed(query)[0], 5, 0.0) DIRECTLY -- i.e. the
 *                 same low-level vector call the qa-vector-probe control used.
 *                 Asserts the synced sentinel node comes back via VECTOR (hit
 *                 count > 0). Also runs manager.search() to confirm the shipped
 *                 read path reports it via vector too.
 *
 * The point: BEFORE the fix this returned 0 (DEF-PATHB-1). AFTER the fix it must
 * be > 0 for the synced node. We assert that, and print verbatim hit counts.
 */

import { createRequire } from "node:module";
import { existsSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function bindingFileName(): string | null {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "pluresdb-node.win32-x64-msvc.node";
  if (platform === "linux" && arch === "x64") return "pluresdb-node.linux-x64-gnu.node";
  if (platform === "darwin" && arch === "arm64") return "pluresdb-node.darwin-arm64.node";
  if (platform === "darwin" && arch === "x64") return "pluresdb-node.darwin-x64.node";
  return null;
}

function ensureBinding(): string | null {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH && existsSync(process.env.NAPI_RS_NATIVE_LIBRARY_PATH))
    return process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  const file = bindingFileName();
  if (!file) return null;
  const cands: string[] = [];
  try {
    const dir = dirname(require.resolve("@plures/pluresdb-native"));
    cands.push(join(dir, file));
    try {
      const rd = realpathSync(dir);
      if (rd !== dir) cands.push(join(rd, file));
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  cands.push(join("C:/Projects/pluresdb/crates/pluresdb-node", file));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const MODEL = "BAAI/bge-small-en-v1.5";
// Unique, distinctive sentinel so the vector query has a clear semantic target.
const SENTINEL =
  "VECFIX8842 the quarterly disaster recovery rehearsal is scheduled in the cold storage bunker";
// A semantically-close query that shares NO long verbatim phrase with the
// trailing chatter, so a vector hit is a genuine semantic match (text fallback
// would also work, but we assert the VECTOR path specifically below).
const QUERY = "where is the disaster recovery rehearsal held";

type NativeMod = { PluresDatabase: any };
function loadNative(): NativeMod {
  const b = ensureBinding();
  if (b) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = b;
  const mod = require("@plures/pluresdb-native") as NativeMod;
  if (!mod || typeof mod.PluresDatabase !== "function") throw new Error("native addon failed to load");
  return mod;
}

async function loadShipped() {
  const mod = await import("../dist/api.js");
  return mod as { buildMemoryCapability: (cfg: any) => any };
}

const cmd = process.argv[2];

// ----- write leg (SHIPPED sync path) ---------------------------------------
if (cmd === "write") {
  const dir = process.argv[3];
  (async () => {
    const { buildMemoryCapability } = await loadShipped();
    const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    const { manager, error } = await cap.runtime.getMemorySearchManager({ cfg: {}, agentId: "qa" });
    if (!manager) {
      process.stdout.write(JSON.stringify({ leg: "write", ok: false, error }) + "\n");
      process.exit(1);
    }
    const before = manager.status().chunks ?? 0;
    const sessionFile = join(dir, "vecfix-session.md");
    writeFileSync(
      sessionFile,
      `# session transcript (vector-after-fix)\n\n${SENTINEL}\n\nunrelated trailing chatter that is not about recovery at all.\n`,
      "utf8",
    );
    let prog = 0;
    await manager.sync({
      reason: "qa",
      force: false,
      sessionFiles: [sessionFile],
      progress: () => (prog += 1),
    });
    const after = manager.status().chunks ?? 0;
    process.stdout.write(
      JSON.stringify({ leg: "write", ok: true, before, after, delta: after - before, progress: prog }) + "\n",
    );
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ leg: "write", ok: false, error: String(e?.stack ?? e) }) + "\n");
    process.exit(1);
  });
}

// ----- read leg (DIRECT vectorSearch + shipped manager.search) --------------
if (cmd === "read") {
  const dir = process.argv[3];
  (async () => {
    // (a) Direct low-level vector recall, exactly like the qa-vector-probe control.
    const { PluresDatabase } = loadNative();
    const db = PluresDatabase.newWithEmbeddings(MODEL, "qa-vecfix", dir);
    const totalNodes = db.stats()?.totalNodes ?? null;
    // Best-effort (return value is unreliable in the alpha; we judge by hits).
    let buildReturn: number | null = null;
    try {
      buildReturn = db.buildVectorIndex();
    } catch {
      buildReturn = null;
    }
    const qvec = db.embed([QUERY])[0];
    const rawHits = db.vectorSearch(qvec, 5, 0.0) ?? [];
    const vectorHitCount = rawHits.length;
    const vectorTopId = rawHits[0]?.id ?? null;
    const sentinelInVector = rawHits.some((h: any) => {
      const data = h?.data;
      const content = data && typeof data === "object" ? (data as any).content : undefined;
      return typeof content === "string" && content.includes("VECFIX8842");
    });
    const sentinelVectorScore =
      rawHits.find((h: any) => {
        const c = h?.data && typeof h.data === "object" ? (h.data as any).content : undefined;
        return typeof c === "string" && c.includes("VECFIX8842");
      })?.score ?? null;

    process.stdout.write(
      JSON.stringify({
        leg: "read",
        ok: true,
        totalNodes,
        buildReturn,
        vectorHitCount,
        vectorTopId,
        sentinelInVector,
        sentinelVectorScore,
      }) + "\n",
    );
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ leg: "read", ok: false, error: String(e?.stack ?? e) }) + "\n");
    process.exit(1);
  });
}

// ----- read-shipped leg (manager.search reports via vector) -----------------
if (cmd === "read-shipped") {
  const dir = process.argv[3];
  (async () => {
    const { buildMemoryCapability } = await loadShipped();
    const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    const { manager } = await cap.runtime.getMemorySearchManager({ cfg: {}, agentId: "qa" });
    const hits = await manager.search(QUERY, { maxResults: 5 });
    const sentinel = hits.find((h: any) => String(h.snippet).includes("VECFIX8842"));
    process.stdout.write(
      JSON.stringify({
        leg: "read-shipped",
        ok: true,
        hitCount: hits.length,
        sentinelRecalled: Boolean(sentinel),
        sentinelVia: sentinel ? (sentinel.vectorScore !== undefined ? "vector" : "text") : null,
        sentinelScore: sentinel?.score ?? null,
      }) + "\n",
    );
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ leg: "read-shipped", ok: false, error: String(e?.stack ?? e) }) + "\n");
    process.exit(1);
  });
}

// ----- driver --------------------------------------------------------------
if (cmd !== "write" && cmd !== "read" && cmd !== "read-shipped") {
  const selfUrl = fileURLToPath(import.meta.url);
  const tsxCli = join(dirname(selfUrl), "..", "node_modules", "tsx", "dist", "cli.mjs");
  const binding = ensureBinding();
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (binding) childEnv.NAPI_RS_NATIVE_LIBRARY_PATH = binding;
  function leg(name: string, dir: string) {
    const res = spawnSync(process.execPath, [tsxCli, selfUrl, name, dir], {
      encoding: "utf8",
      timeout: 120_000,
      env: childEnv,
    });
    const last = (res.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
      return JSON.parse(last);
    } catch {
      return { raw: last, stderr: (res.stderr ?? "").trim().slice(0, 600), status: res.status };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "plureslm-vecfix-"));
  try {
    const write = leg("write", dir); // writer exits -> lock freed
    const read = leg("read", dir); // direct vectorSearch
    const readShipped = leg("read-shipped", dir); // shipped manager.search
    const result = { binding, write, read, readShipped };
    console.log(JSON.stringify(result, null, 2));
    const ok =
      write?.ok === true &&
      (write?.delta ?? 0) >= 1 &&
      read?.ok === true &&
      (read?.vectorHitCount ?? 0) > 0 &&
      read?.sentinelInVector === true;
    console.log(ok ? "VECFIX_RESULT: PASS" : "VECFIX_RESULT: FAIL");
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
