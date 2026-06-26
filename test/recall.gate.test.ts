/**
 * TEST GATE (C-TEST-001): exercise the CORE read path of the plugin against a
 * real PluresDB store — not a mock, not a stub.
 *
 * Two assertions:
 *
 *  A. COMPATIBILITY: open the provided COPY fixture through the real plugin
 *     read path (buildMemoryCapability -> getMemorySearchManager -> status).
 *     The fixture is a stale March copy and is EMPTY for this native
 *     (totalNodes === 0), so we assert it OPENS cleanly and status() works,
 *     proving the read path is wired to a real on-disk store. (Documented
 *     deviation: the fixture holds no recallable nodes — see milestones.)
 *
 *  B. RECALL: seed a known store (child process), reopen it in a fresh child
 *     process through the same plugin read path, and assert recall returns the
 *     correct NON-EMPTY hit and that the reported node count matches what was
 *     seeded. This is the deterministic, non-empty recall proof.
 *
 * Cross-process children are required because the native takes an EXCLUSIVE
 * file lock per store directory.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

import { buildMemoryCapability } from "../dist/api.js";
import { PluresLmStore } from "../dist/pluresdb.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "store-child.mts");
// Spawn tsx via the Node CLI entry (not the .bin/.cmd shim) so spawnSync works
// cross-platform without a shell. The .cmd shim cannot be spawned directly on
// Windows (spawnSync returns status=null / ENOENT).
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const COPY_FIXTURE =
  "C:/Users/kbristol/.openclaw/workspace/.tmp/plureslm-store-copy-20260626";

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
  // Surface spawn-level failures (status null) with the underlying error so the
  // assertion message is actionable instead of a bare "expected null to be 0".
  const spawnError = res.error ? String((res.error as Error).message ?? res.error) : "";
  return { res, stdout, stderr: ((res.stderr ?? "").trim() + (spawnError ? ` | spawnError=${spawnError}` : "")).trim(), parsed };
}

describe("plureslm read-path memory capability", () => {
  it("A. opens the real COPY fixture through the plugin read path (compatibility)", async () => {
    expect(existsSync(COPY_FIXTURE)).toBe(true);
    PluresLmStore._resetForTests(COPY_FIXTURE);

    const capability = buildMemoryCapability({ dbPath: COPY_FIXTURE });
    expect(capability.runtime).toBeTruthy();

    const { manager, error } = await capability.runtime!.getMemorySearchManager({
      cfg: {} as never,
      agentId: "gate",
    });
    expect(error, `getMemorySearchManager error: ${error ?? ""}`).toBeUndefined();
    expect(manager).toBeTruthy();

    const status = manager!.status();
    console.log("[GATE A] COPY fixture status:", JSON.stringify(status));
    expect(status.backend).toBe("builtin");
    expect(status.provider).toBe("plureslm");
    // The stale copy is empty for this native; assert it opened and is queryable.
    expect(typeof status.chunks).toBe("number");
    expect(status.chunks).toBeGreaterThanOrEqual(0);

    // A query against the (empty) copy must not throw; it returns [].
    const hits = await manager!.search("anything", { maxResults: 3 });
    console.log("[GATE A] COPY fixture recall count:", hits.length);
    expect(Array.isArray(hits)).toBe(true);

    PluresLmStore._resetForTests(COPY_FIXTURE);
  });

  it("B. seeds then recalls a known store cross-process (non-empty recall + count match)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plureslm-gate-"));
    try {
      // Phase 1: seed (own process).
      const seed = runChild(dir, "seed");
      console.log("[GATE B] seed stdout:", seed.stdout);
      expect(seed.res.status, `seed exit; stderr=${seed.stderr}`).toBe(0);
      expect(seed.parsed?.phase).toBe("seed");
      const seedStats = seed.parsed?.stats as { totalNodes?: number } | undefined;
      expect(seedStats?.totalNodes).toBe(3);

      // Phase 2: read through the real plugin path (fresh process).
      const read = runChild(dir, "read");
      console.log("[GATE B] read stdout:", read.stdout);
      expect(read.res.status, `read exit; stderr=${read.stderr}`).toBe(0);
      expect(read.parsed?.ok, `read error: ${read.parsed?.error ?? ""}`).toBe(true);

      // Count consistency: status node count matches what we seeded.
      expect(read.parsed?.statusTotalNodes).toBe(3);
      expect(read.parsed?.backend).toBe("builtin");
      expect(read.parsed?.statusProvider).toBe("plureslm");

      // Non-empty, correct-looking recall.
      const hits = (read.parsed?.hits as Array<Record<string, unknown>>) ?? [];
      expect(hits.length).toBeGreaterThan(0);
      const top = hits[0]!;
      expect(String(top.path)).toBe("mem-dec-1");
      expect(String(top.snippet)).toContain("long-term memory");
      expect(String(top.source)).toBe("memory");
      expect(String(top.citation)).toContain("plureslm:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
