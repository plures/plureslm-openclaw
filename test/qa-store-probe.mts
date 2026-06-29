/**
 * QA real-store-dir + idempotency driver (Path B), exercising the SHIPPED path
 * (dist/api.js -> buildMemoryCapability -> getMemorySearchManager ->
 * manager.sync()/search()). Cross-process to respect the exclusive lock.
 *
 * Sub-commands (each its own process):
 *   write <dir> : open via the shipped capability, write a real session file
 *                 with a sentinel, sync() it ONCE (capture delta + skipped via
 *                 store-return is internal, so we use status() deltas), then
 *                 sync the SAME file AGAIN and report whether the 2nd sync was a
 *                 no-op (idempotency: after-total unchanged). Prints JSON.
 *   read  <dir> : fresh process; status() + search(textQuery) and report
 *                 whether the sentinel comes back and via vector or text; also
 *                 report status.vector.available (semantic availability).
 *   (no args)   : driver — mkdtemp REAL store dir, spawn write, spawn read,
 *                 merge + print, cleanup.
 *
 * The manager.sync() interface does not return counts (void), so idempotency is
 * proven via status().chunks deltas across two syncs of the same file: 1st sync
 * adds N chunks; 2nd sync of the unchanged file must add 0 (after2 == after1).
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
    } catch {}
  } catch {}
  cands.push(join("C:/Projects/pluresdb/crates/pluresdb-node", file));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const MODEL = "BAAI/bge-small-en-v1.5";
const SENTINEL =
  "QASTORE5150 the incident postmortem is filed under the sealed compliance ledger";
const TEXT_QUERY = "incident postmortem is filed under the sealed compliance ledger";

async function loadShipped() {
  // dist/api.js is the compiled named-export barrel.
  const mod = await import("../dist/api.js");
  return mod as {
    buildMemoryCapability: (cfg: any) => any;
  };
}

const cmd = process.argv[2];

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
    const sessionFile = join(dir, "qa-session.md");
    writeFileSync(
      sessionFile,
      `# qa session transcript\n\n${SENTINEL}\n\nunrelated trailing chatter line.\n`,
      "utf8",
    );
    let prog1 = 0;
    await manager.sync({ reason: "qa", force: false, sessionFiles: [sessionFile], progress: () => (prog1 += 1) });
    const after1 = manager.status().chunks ?? 0;

    // Second sync of the SAME, UNCHANGED file -> must be a no-op (delta 0).
    let prog2 = 0;
    await manager.sync({ reason: "qa", force: false, sessionFiles: [sessionFile], progress: () => (prog2 += 1) });
    const after2 = manager.status().chunks ?? 0;

    process.stdout.write(
      JSON.stringify({
        leg: "write",
        ok: true,
        before,
        after1,
        after2,
        delta1: after1 - before,
        delta2: after2 - after1,
        progress1: prog1,
        progress2: prog2,
      }) + "\n",
    );
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ leg: "write", ok: false, error: String(e?.stack ?? e) }) + "\n");
    process.exit(1);
  });
}

if (cmd === "read") {
  const dir = process.argv[3];
  (async () => {
    const { buildMemoryCapability } = await loadShipped();
    const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    const { manager, error } = await cap.runtime.getMemorySearchManager({ cfg: {}, agentId: "qa" });
    if (!manager) {
      process.stdout.write(JSON.stringify({ leg: "read", ok: false, error }) + "\n");
      process.exit(1);
    }
    const status = manager.status();
    const hits = await manager.search(TEXT_QUERY, { maxResults: 5 });
    const sentinelHit = hits.find((h: any) => String(h.snippet).includes("QASTORE5150"));
    process.stdout.write(
      JSON.stringify({
        leg: "read",
        ok: true,
        totalNodes: status.chunks,
        provider: status.provider,
        backend: status.backend,
        vectorAvailable: status.vector?.available ?? null,
        semanticAvailable: status.vector?.semanticAvailable ?? null,
        vectorDims: status.vector?.dims ?? null,
        hitCount: hits.length,
        sentinelRecalled: Boolean(sentinelHit),
        sentinelVia: sentinelHit ? (sentinelHit.vectorScore !== undefined ? "vector" : "text") : null,
        sentinelId: sentinelHit?.path ?? null,
        sentinelSource: sentinelHit?.source ?? null,
        sentinelScore: sentinelHit?.score ?? null,
      }) + "\n",
    );
    process.exit(0);
  })().catch((e) => {
    process.stdout.write(JSON.stringify({ leg: "read", ok: false, error: String(e?.stack ?? e) }) + "\n");
    process.exit(1);
  });
}

// driver
if (cmd !== "write" && cmd !== "read") {
  const selfUrl = fileURLToPath(import.meta.url);
  const tsxCli = join(dirname(selfUrl), "..", "node_modules", "tsx", "dist", "cli.mjs");
  const binding = ensureBinding();
  const childEnv = { ...process.env };
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
  const dir = mkdtempSync(join(tmpdir(), "plureslm-qastore-"));
  try {
    const write = leg("write", dir);
    const read = leg("read", dir);
    console.log(JSON.stringify({ binding, write, read }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
