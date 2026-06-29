/**
 * Path B VERIFY driver (channel-agnostic — C-TEST-002). NO chat adapter.
 *
 * Proves, via the SHIPPED plugin capability API + config shapes only (never via
 * Telegram/Discord/any chat surface):
 *
 *   PROOF 1  — provider=plureslm OWNS the slot when configured: seed a sentinel
 *              through the shipped manager.sync(), reopen in a fresh process,
 *              and assert status() reports provider=plureslm / backend=builtin /
 *              model=BAAI/bge-small-en-v1.5 / chunks>0 AND the sentinel recalls.
 *
 *   PROOF 2a — no dbPath  -> getMemorySearchManager returns {manager:null,error}
 *              (the inert path that makes the host fall back to memory-core).
 *   PROOF 2b — bad dbPath -> ALSO {manager:null,error}, gracefully (no crash,
 *              no stub, no partial fake).
 *
 * Each store-touching phase runs in its own process (verify-child.mts) so the
 * PluresDB exclusive file lock is respected. Host-side selection evidence
 * (DEFAULT_SLOT_BY_KEY.memory, the unset/"memory-core" => no-plugin gate, and
 * the consumer null-manager handling) is documented in PATH-B-VERIFY-NOTES.md
 * from bounded greps of the installed OpenClaw dist — this driver proves the
 * PLUGIN half (owns-when-configured / inert-when-not).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "verify-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: string) {
  const res = spawnSync(process.execPath, [TSX_CLI, CHILD, dir, phase], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    parsed = null;
  }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

// ---------------------------------------------------------------------------
function proof1(): void {
  console.log("\n=== PROOF 1: provider=plureslm OWNS the slot when configured ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-verify-p1-"));
  try {
    // Write leg: shipped manager.sync() seeds the sentinel.
    const seed = runChild(dir, "seed");
    if (seed.stderr) console.log("  seed stderr:", seed.stderr);
    check("seed child exit 0", seed.status === 0, seed.parsed?.error ?? null);
    check("seed ok (sync ran)", seed.parsed?.ok === true, seed.parsed?.error ?? null);
    check("sync() wrote >= 1 node (delta)", Number(seed.parsed?.delta) >= 1, {
      before: seed.parsed?.beforeChunks,
      after: seed.parsed?.afterChunks,
      delta: seed.parsed?.delta,
    });
    check("sync() invoked progress", Number(seed.parsed?.progressCalls) >= 1, seed.parsed?.progressCalls);

    // Read leg: fresh process, full status() + recall.
    const read = runChild(dir, "read");
    if (read.stderr) console.log("  read stderr:", read.stderr);
    check("read child exit 0", read.status === 0, read.parsed?.error ?? null);
    check("read ok", read.parsed?.ok === true, read.parsed?.error ?? null);

    const status = (read.parsed?.status ?? {}) as Record<string, unknown>;
    console.log("  FULL status() =", JSON.stringify(status));
    check("status.provider === plureslm", status.provider === "plureslm", status.provider);
    check("status.backend === builtin", status.backend === "builtin", status.backend);
    check("status.model === BAAI/bge-small-en-v1.5", status.model === "BAAI/bge-small-en-v1.5", status.model);
    check("status.chunks > 0", Number(status.chunks) > 0, status.chunks);
    const vector = (status.vector ?? {}) as Record<string, unknown>;
    check("status.vector.dims === 384", Number(vector.dims) === 384, vector.dims);

    const sentinel = read.parsed?.sentinel as Record<string, unknown> | null;
    console.log("  sentinel recall =", JSON.stringify(sentinel));
    check("sentinel recalled (round-trip)", Boolean(sentinel), { hitCount: read.parsed?.hitCount });
    check("sentinel is a session node (mem:session:...)", String(sentinel?.path).startsWith("mem:session:"), sentinel?.path);
    check("sentinel source === sessions", sentinel?.source === "sessions", sentinel?.source);
    check("sentinel score > 0", Number(sentinel?.score) > 0, sentinel?.score);
    check("sentinel citation namespaced plureslm:", String(sentinel?.citation).startsWith("plureslm:"), sentinel?.citation);
    check("sentinel via vector or text", sentinel?.via === "vector" || sentinel?.via === "text", sentinel?.via);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
function proof2a(): Record<string, unknown> | null {
  console.log("\n=== PROOF 2a: no dbPath -> inert {manager:null,error} (host falls back to memory-core) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-verify-p2a-"));
  try {
    const r = runChild(dir, "inert-nodb");
    if (r.stderr) console.log("  stderr:", r.stderr);
    check("child exit 0 (no crash)", r.status === 0, r.parsed?.error ?? null);
    check("capability.runtime present", r.parsed?.hasRuntime === true);
    check("manager === null", r.parsed?.managerIsNull === true, r.parsed?.managerType);
    check("honest error string present", typeof r.parsed?.error === "string" && (r.parsed?.error as string).length > 0, r.parsed?.error);
    check("error names the missing dbPath cause", String(r.parsed?.error).toLowerCase().includes("dbpath"), r.parsed?.error);
    console.log("  VERBATIM returned =", JSON.stringify(r.parsed?.returned));
    return r.parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function proof2b(): Record<string, unknown> | null {
  console.log("\n=== PROOF 2b: bad/unwritable dbPath -> inert {manager:null,error} (graceful, no crash) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-verify-p2b-"));
  try {
    const r = runChild(dir, "inert-badpath");
    if (r.stderr) console.log("  stderr:", r.stderr);
    check("child exit 0 (no crash)", r.status === 0, r.parsed?.error ?? null);
    check("did NOT throw out of getMemorySearchManager", r.parsed?.threw === false, r.parsed?.threw);
    check("manager === null", r.parsed?.managerIsNull === true, r.parsed?.managerType);
    check("honest open-failure error present", typeof r.parsed?.error === "string" && (r.parsed?.error as string).length > 0, r.parsed?.error);
    check("error mentions plureslm/store/open", /plureslm|store|open|fail/i.test(String(r.parsed?.error)), r.parsed?.error);
    console.log("  VERBATIM returned =", JSON.stringify(r.parsed?.returned));
    return r.parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log("plureslm-openclaw PATH B VERIFY (channel-agnostic, against dist/ build)");
  proof1();
  const p2a = proof2a();
  const p2b = proof2b();
  console.log("\n--- machine-readable summary ---");
  console.log(JSON.stringify({ proof2a: p2a?.returned, proof2b: p2b?.returned }));
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("VERIFY DRIVER ERROR:", err?.stack ?? err);
  process.exit(1);
});
