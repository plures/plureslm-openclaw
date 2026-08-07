#!/usr/bin/env node
/**
 * migrate-memory.mjs — NON-DESTRUCTIVE migration of the OpenClaw builtin memory
 * index (main.sqlite, text-embedding-3-small 1536d) into a PluresLmStore
 * (bge-small-en-v1.5 384d, RE-EMBEDDED on write). The 1536d stored vectors are
 * NEVER reused — chunk TEXT is re-embedded by the target store on write.
 *
 * READ path: node:sqlite DatabaseSync in readOnly mode (Node v26). No new deps.
 * WRITE path: PluresLmStore.store([{id,data}]) — batch, embed-on-write,
 *             idempotent (its internal #isDirty skips unchanged nodes on re-run).
 *
 * Provenance preserved as node metadata: path, source, start_line, end_line,
 * hash, updated_at, origin:"main.sqlite". Chunk text -> data.content (that is
 * the field the store embeds). category:"memory-chunk" so these are typed
 * distinctly and never mistaken for the graph linker's "session" set.
 *
 * Env / argv:
 *   SOURCE_SQLITE  (argv[2]) default main.sqlite under .openclaw\memory
 *   TARGET_DBPATH  (argv[3]) default migrated-store under .pluresLM
 *   MIGRATE_LIMIT  optional integer - import only the first N chunks (dry-run).
 *   BATCH_SIZE     optional integer, default 100.
 *
 * Idempotent: keyed by chunk id; re-running skips unchanged nodes.
 * Per-row errors are COUNTED and logged (first 5), never silently dropped.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_SQLITE =
  process.argv[2] ||
  process.env.SOURCE_SQLITE ||
  "C:\\Users\\kbristol\\.openclaw\\memory\\main.sqlite";

const TARGET_DBPATH =
  process.argv[3] ||
  process.env.TARGET_DBPATH ||
  "C:\\Users\\kbristol\\.pluresLM\\migrated-store";

const MIGRATE_LIMIT = process.env.MIGRATE_LIMIT
  ? Math.max(0, parseInt(process.env.MIGRATE_LIMIT, 10) || 0)
  : 0;

const BATCH_SIZE = process.env.BATCH_SIZE
  ? Math.max(1, parseInt(process.env.BATCH_SIZE, 10) || 100)
  : 100;

function log(...args) {
  console.log(...args);
}

async function main() {
  log(`[migrate] SOURCE_SQLITE = ${SOURCE_SQLITE}`);
  log(`[migrate] TARGET_DBPATH = ${TARGET_DBPATH}`);
  log(`[migrate] MIGRATE_LIMIT = ${MIGRATE_LIMIT || "(none — full)"}`);
  log(`[migrate] BATCH_SIZE    = ${BATCH_SIZE}`);

  // Ensure the target directory exists (fresh store dir).
  mkdirSync(TARGET_DBPATH, { recursive: true });

  // Import the compiled store from dist.
  const distUrl = new URL("./dist/pluresdb.js", import.meta.url);
  const { PluresLmStore } = await import(distUrl.href);
  if (typeof PluresLmStore?.open !== "function") {
    throw new Error("PluresLmStore.open not found in ./dist/pluresdb.js");
  }

  // Open the SOURCE read-only. Never mutate main.sqlite.
  const src = new DatabaseSync(resolve(SOURCE_SQLITE), { readOnly: true });

  // Open the TARGET store (embed-on-write with bge-small).
  const store = PluresLmStore.open({
    dbPath: TARGET_DBPATH,
    embeddingModel: "BAAI/bge-small-en-v1.5",
  });

  const probe = store.probeOpen?.();
  if (probe && probe.ok !== true) {
    throw new Error(`target store not openable: ${probe.error || "unknown"}`);
  }

  const limitClause = MIGRATE_LIMIT > 0 ? ` LIMIT ${MIGRATE_LIMIT}` : "";
  const rows = src
    .prepare(
      `SELECT id, path, source, start_line, end_line, hash, updated_at, text
         FROM chunks
        ORDER BY path, start_line${limitClause}`,
    )
    .all();

  log(`[migrate] read ${rows.length} chunk row(s) from source (read-only)`);

  let imported = 0; // store reported written
  let skipped = 0; // store reported skipped (idempotent unchanged) OR row-level skip
  let errors = 0;
  let refused = 0; // governed-write gate refusals (e.g. secret detected)
  const firstErrors = [];

  let batch = [];
  let processed = 0;

  const flush = () => {
    if (batch.length === 0) return;
    try {
      const res = store.store(batch);
      imported += res.written || 0;
      skipped += res.skipped || 0;
      refused += res.refused || 0;
      if (res.refused > 0 && Array.isArray(res.refusedDetail)) {
        for (const r of res.refusedDetail.slice(0, 3)) {
          log(`[migrate] REFUSED id=${r.id} reason=${r.reason} kind=${r.kind || "?"}`);
        }
      }
    } catch (err) {
      // A whole-batch failure: fall back to per-node so one bad row cannot
      // sink the batch, and each error is counted (never silently dropped).
      for (const node of batch) {
        try {
          const res = store.store([node]);
          imported += res.written || 0;
          skipped += res.skipped || 0;
          refused += res.refused || 0;
        } catch (e2) {
          errors += 1;
          if (firstErrors.length < 5) {
            firstErrors.push(`id=${node.id}: ${e2 && e2.message ? e2.message : String(e2)}`);
          }
        }
      }
    }
    batch = [];
  };

  for (const row of rows) {
    processed += 1;

    // Guard: a chunk must have an id and some text to be embeddable/keyed.
    const id = typeof row.id === "string" ? row.id : null;
    const text = typeof row.text === "string" ? row.text : "";
    if (!id || text.trim().length === 0) {
      skipped += 1;
      if (firstErrors.length < 5 && !id) {
        firstErrors.push(`row#${processed}: missing id`);
      }
      continue;
    }

    const data = {
      content: text, // the field PluresLmStore embeds
      category: "memory-chunk",
      path: row.path ?? null,
      source: row.source ?? null,
      start_line: typeof row.start_line === "number" ? row.start_line : null,
      end_line: typeof row.end_line === "number" ? row.end_line : null,
      hash: row.hash ?? null,
      updated_at: typeof row.updated_at === "number" ? row.updated_at : null,
      origin: "main.sqlite",
    };

    batch.push({ id, data });

    if (batch.length >= BATCH_SIZE) {
      flush();
    }

    if (processed % 100 === 0) {
      log(
        `[migrate] progress processed=${processed}/${rows.length} imported=${imported} skipped=${skipped} refused=${refused} errors=${errors}`,
      );
    }
  }

  flush();

  src.close();

  log(
    `MIGRATION_DONE imported=${imported} skipped=${skipped} errors=${errors} refused=${refused} processed=${processed} target=${TARGET_DBPATH}`,
  );
}

main().catch((err) => {
  console.error(`MIGRATION_FATAL ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
});
