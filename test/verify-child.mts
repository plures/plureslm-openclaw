/**
 * VERIFY child worker (Path B, channel-agnostic — C-TEST-002).
 *
 * Runs ONE phase in its OWN process so the PluresDB exclusive file lock is
 * released between phases. Exercises the SHIPPED plugin path only
 * (buildMemoryCapability -> runtime.getMemorySearchManager -> manager.*),
 * never a chat adapter, never a second native handle on a live dbPath.
 *
 * Usage:  tsx test/verify-child.mts <dir> <seed|read|inert-nodb|inert-badpath>
 *
 *  seed          : ingest a sentinel session file through the SHIPPED write
 *                  path (manager.sync({sessionFiles})). Prints write stats.
 *  read          : reopen via the SHIPPED read path, recall the sentinel, dump
 *                  the FULL status() object + the top hit. (PROOF 1 evidence.)
 *  inert-nodb    : call buildMemoryCapability({}) with NO dbPath and dump the
 *                  verbatim {manager,error} shape getMemorySearchManager
 *                  returns. (PROOF 2a evidence — drives the host fallback.)
 *  inert-badpath : call buildMemoryCapability({dbPath:<parent-is-a-file>}) and
 *                  dump the verbatim {manager,error} shape. (PROOF 2b — store
 *                  open failure surfaced honestly, no crash, no fake manager.)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Import the BUILT artifact (dist), exactly what ships.
import { buildMemoryCapability } from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const VALID = new Set(["seed", "read", "inert-nodb", "inert-badpath"]);

if (!phase || !VALID.has(phase)) {
  console.error("usage: tsx test/verify-child.mts <dir> <seed|read|inert-nodb|inert-badpath>");
  process.exit(2);
}

const MODEL = "BAAI/bge-small-en-v1.5";

// Sentinel ingested by `seed` and recalled by `read`. Distinctive leading token
// so it never collides with the praxis_constraint baseline the native seeds.
const VERIFY_SENTINEL =
  "VRFYB8842SENTINEL the disaster-recovery failover plan is rehearsed every quarter";
const VERIFY_QUERY = "disaster-recovery failover plan is rehearsed every quarter";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ---- PROOF 2a: no dbPath / empty config -> inert {manager:null,error} --------
if (phase === "inert-nodb") {
  (async () => {
    // Empty config object: the host passes whatever is under
    // plugins.entries.plureslm.config; with no dbPath the capability is inert.
    const capability = buildMemoryCapability({});
    const hasRuntime = Boolean(capability.runtime);
    const result = hasRuntime
      ? await capability.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "verify" })
      : { manager: undefined, error: "no runtime" };
    emit({
      phase,
      hasRuntime,
      managerIsNull: result.manager === null,
      managerType: result.manager === null ? "null" : typeof result.manager,
      error: result.error ?? null,
      // The verbatim shape the host sees:
      returned: { manager: result.manager === null ? null : "<non-null>", error: result.error ?? null },
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, fatal: true, error: String(err?.stack ?? err) });
    process.exit(1);
  });
}

// ---- PROOF 2b: invalid/unwritable dbPath -> inert {manager:null,error} -------
if (phase === "inert-badpath") {
  (async () => {
    // Make a real FILE, then point dbPath at a child path UNDER that file, so
    // the store cannot create its directory (parent is a file -> ENOTDIR). This
    // is a genuine open failure, surfaced — not a contrived throw.
    const fileAsParent = join(dir, "not-a-dir.txt");
    writeFileSync(fileAsParent, "i am a file, not a directory\n", "utf8");
    const badDbPath = join(fileAsParent, "store-under-a-file");

    const capability = buildMemoryCapability({ dbPath: badDbPath, embeddingModel: MODEL });
    const hasRuntime = Boolean(capability.runtime);
    let threw = false;
    let result: { manager: unknown; error?: string } = { manager: undefined };
    try {
      result = hasRuntime
        ? await capability.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "verify" })
        : { manager: undefined, error: "no runtime" };
    } catch (err) {
      // A throw here would be a FAILURE of the "graceful" contract; capture it
      // honestly rather than hiding it.
      threw = true;
      result = { manager: "<THREW>", error: String(err instanceof Error ? err.message : err) };
    }
    emit({
      phase,
      badDbPath,
      hasRuntime,
      threw,
      managerIsNull: result.manager === null,
      managerType: result.manager === null ? "null" : typeof result.manager,
      error: result.error ?? null,
      returned: { manager: result.manager === null ? null : String(result.manager), error: result.error ?? null },
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, fatal: true, error: String(err?.stack ?? err) });
    process.exit(1);
  });
}

// ---- PROOF 1 (write leg): seed a sentinel via the shipped sync() ------------
if (phase === "seed") {
  (async () => {
    const capability = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    if (!capability.runtime) throw new Error("capability.runtime missing");
    const { manager, error } = await capability.runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "verify",
    });
    if (!manager) {
      emit({ phase, ok: false, error: error ?? "no manager" });
      process.exit(1);
    }
    if (typeof manager.sync !== "function") {
      emit({ phase, ok: false, error: "manager.sync is not a function" });
      process.exit(1);
    }
    const before = manager.status();
    const sessionFile = join(dir, "verify-session.md");
    writeFileSync(
      sessionFile,
      `# verify session transcript\n\n${VERIFY_SENTINEL}\n\nunrelated trailing chatter that must not match the query.\n`,
      "utf8",
    );
    let progressCalls = 0;
    await manager.sync({
      reason: "verify",
      sessionFiles: [sessionFile],
      progress: () => {
        progressCalls += 1;
      },
    });
    const after = manager.status();
    emit({
      phase,
      ok: true,
      sessionFile,
      beforeChunks: before.chunks,
      afterChunks: after.chunks,
      delta: (after.chunks ?? 0) - (before.chunks ?? 0),
      progressCalls,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String(err?.stack ?? err) });
    process.exit(1);
  });
}

// ---- PROOF 1 (read leg): reopen, dump full status() + recall the sentinel ----
if (phase === "read") {
  (async () => {
    const capability = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    if (!capability.runtime) throw new Error("capability.runtime missing");
    const { manager, error } = await capability.runtime.getMemorySearchManager({
      cfg: {} as never,
      agentId: "verify",
    });
    if (!manager) {
      emit({ phase, ok: false, error: error ?? "no manager" });
      process.exit(1);
    }
    const status = manager.status();
    const hits = await manager.search(VERIFY_QUERY, { maxResults: 5 });
    const sentinelHit = hits.find((h) => String(h.snippet).includes("VRFYB8842SENTINEL"));
    emit({
      phase,
      ok: true,
      query: VERIFY_QUERY,
      // FULL status object — the PROOF 1 assertion target.
      status,
      hitCount: hits.length,
      sentinel: sentinelHit
        ? {
            path: sentinelHit.path,
            score: sentinelHit.score,
            source: sentinelHit.source,
            citation: sentinelHit.citation,
            via:
              sentinelHit.vectorScore !== undefined
                ? "vector"
                : sentinelHit.textScore !== undefined
                  ? "text"
                  : "unknown",
            snippet: sentinelHit.snippet,
          }
        : null,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String(err?.stack ?? err) });
    process.exit(1);
  });
}
