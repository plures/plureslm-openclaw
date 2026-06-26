/**
 * Standalone TEST GATE runner (C-TEST-001), executed via tsx.
 *
 * Why standalone tsx and not vitest: on this Windows host, pnpm sandboxes
 * esbuild's postinstall (ERR_PNPM_IGNORED_BUILDS), so vitest's TS transform
 * binary is not provisioned. tsx bundles its own working esbuild, so the gate
 * runs deterministically without approving third-party build scripts. The
 * brief explicitly permits "vitest OR standalone tsx". The vitest spec
 * (test/recall.gate.test.ts) is kept for environments where esbuild is built.
 *
 * The gate runs the REAL plugin read path against the BUILT artifact
 * (../dist/api.js -> buildMemoryCapability), via two child processes to respect
 * the PluresDB exclusive file lock.
 *
 *  GATE A (compatibility): open the stale COPY fixture through the plugin read
 *    path; assert it opens and status() works (the copy is empty for this
 *    native -> totalNodes 0, documented deviation).
 *  GATE B (recall): seed a known store, reopen in a fresh process through the
 *    built plugin path, assert NON-EMPTY correct recall + count == stats().
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildMemoryCapability } from "../dist/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "store-child.mts");
// Spawn the child as `node <tsx-cli> <child>`. On Windows, spawnSync on the
// `tsx.cmd` shim does not reliably capture stdio / launch; invoking the tsx
// CLI .mjs through the current node binary is robust and cross-platform.
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const COPY_FIXTURE =
  "C:/Users/kbristol/.openclaw/workspace/.tmp/plureslm-store-copy-20260626";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: "seed" | "read") {
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

async function gateA(): Promise<void> {
  console.log("\n=== GATE A: open real COPY fixture via built plugin read path ===");
  check("fixture exists on disk", existsSync(COPY_FIXTURE), COPY_FIXTURE);
  const capability = buildMemoryCapability({ dbPath: COPY_FIXTURE });
  check("capability.runtime present", Boolean(capability.runtime));
  const got = await capability.runtime!.getMemorySearchManager({
    cfg: {} as never,
    agentId: "gate",
  });
  check("getMemorySearchManager returned a manager (no error)", Boolean(got.manager) && !got.error, got.error ?? null);
  if (!got.manager) return;
  const status = got.manager.status();
  console.log("  COPY status:", JSON.stringify(status));
  check("status.backend === builtin", status.backend === "builtin");
  check("status.provider === plureslm", status.provider === "plureslm");
  check("status.chunks is a number >= 0", typeof status.chunks === "number" && (status.chunks ?? -1) >= 0, status.chunks);
  const hits = await got.manager.search("anything", { maxResults: 3 });
  check("search() returns an array (empty ok for stale copy)", Array.isArray(hits), { count: hits.length });
}

function gateB(): void {
  console.log("\n=== GATE B: seed -> reopen cross-process -> non-empty recall (built path) ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-gate-"));
  try {
    const seed = runChild(dir, "seed");
    console.log("  seed child stdout:", seed.stdout);
    if (seed.stderr) console.log("  seed child stderr:", seed.stderr);
    check("seed child exit 0", seed.status === 0);
    const seedStats = seed.parsed?.stats as { totalNodes?: number } | undefined;
    check("seed wrote 3 nodes", seedStats?.totalNodes === 3, seedStats);

    const read = runChild(dir, "read");
    console.log("  read child stdout:", read.stdout);
    if (read.stderr) console.log("  read child stderr:", read.stderr);
    check("read child exit 0", read.status === 0);
    check("read ok", read.parsed?.ok === true, read.parsed?.error ?? null);
    check("status node count == 3 (matches seed)", read.parsed?.statusTotalNodes === 3, read.parsed?.statusTotalNodes);
    check("backend == builtin", read.parsed?.backend === "builtin");
    check("provider == plureslm", read.parsed?.statusProvider === "plureslm");

    const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
    check("recall NON-EMPTY", hits.length > 0, { count: hits.length });
    const top = hits[0];
    check("top hit is the correct node (mem-dec-1)", String(top?.path) === "mem-dec-1", top?.path);
    check("top snippet contains expected content", String(top?.snippet).includes("long-term memory"), top?.snippet);
    check("top source == memory", String(top?.source) === "memory");
    check("citation namespaced to plureslm", String(top?.citation).startsWith("plureslm:"), top?.citation);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw TEST GATE (standalone tsx, against dist/ build)");
  await gateA();
  gateB();
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
