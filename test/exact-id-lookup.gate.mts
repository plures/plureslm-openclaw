/**
 * Gate: `readFile()` must be an EXACT node-by-id lookup, never a semantic
 * "nearest" fallback.
 *
 * Bug (found empirically 2026-07-24 against the real migrated live store,
 * C:\Users\kbristol\.pluresLM\migrated-store, 3,309 chunks): the old
 * `readFile()` resolved `relPath` (a PluresDB node id) via
 * `store.recall(relPath, 1)` - a semantic similarity search over the id
 * STRING - then fell back to `hits[0]` when no hit's id matched exactly. Ids
 * in the real migrated store are OPAQUE (e.g. `mem:memory:2026-05-12:3`) and
 * do not resemble their own content, so this "search for the id text" never
 * exact-matches and silently returns whatever chunk happens to be nearest to
 * the id string - an UNRELATED memory. This gate proves:
 *   1. An opaque, migrated-style id (content has NO lexical relationship to
 *      the id string) resolves to its OWN content, not a lexically-similar
 *      decoy planted under a different id.
 *   2. A totally unknown id throws/rejects instead of silently returning a
 *      decoy (`hits[0]`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluresLmSearchManager } from "../dist/api.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// Opaque ids that look nothing like their own content - mirrors the real
// migrated store's `mem:memory:<slug>:<chunkIndex>` id shape.
const TARGET_ID = "mem:memory:2026-05-12-standup-notes:3";
const DECOY_ID = "mem:memory:2026-06-01-unrelated-topic:0";

const TARGET_TEXT =
  "The quarterly budget review is scheduled for Tuesday with finance leadership.";
// Decoy content is crafted to be lexically/semantically CLOSER to TARGET_ID's
// own id string than TARGET_TEXT is, so a recall(id-as-query) fallback would
// plausibly surface this instead of the real target.
const DECOY_TEXT =
  "Standup notes 2026-05-12 item three: unrelated decoy chunk planted to be the nearest neighbor of the target id string, not the target's real content.";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "plureslm-exact-id-gate-"));
  const dbPath = join(root, "store");
  try {
    const { manager, store } = createPluresLmSearchManager({
      dbPath,
      embeddingModel: "BAAI/bge-small-en-v1.5",
      vectorThreshold: 0,
      maxResults: 5,
    });

    store.store([
      { id: TARGET_ID, data: { content: TARGET_TEXT, category: "memory", source: "memory" } },
      { id: DECOY_ID, data: { content: DECOY_TEXT, category: "memory", source: "memory" } },
    ]);

    // 1. Exact lookup by opaque id must return ITS OWN content, never the decoy.
    const read = await manager.readFile({ relPath: TARGET_ID });
    check("exact id returns its own content", read.text.includes(TARGET_TEXT), read.text);
    check("exact id does NOT return the decoy's content", !read.text.includes(DECOY_TEXT), read.text);

    // 2. An unknown id must error, never silently fall back to hits[0].
    let threw = false;
    let errMessage = "";
    try {
      await manager.readFile({ relPath: "mem:memory:does-not-exist:0" });
    } catch (error) {
      threw = true;
      errMessage = error instanceof Error ? error.message : String(error);
    }
    check("unknown id rejects instead of returning a decoy", threw, errMessage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`exact-id-lookup gate failed: ${failures}`);
    process.exit(1);
  }
  console.log("exact-id-lookup gate passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
