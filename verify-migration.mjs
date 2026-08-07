#!/usr/bin/env node
/**
 * verify-migration.mjs — opens the migrated PluresLmStore READ side and proves
 * the import landed: prints count() + status(), then runs 3 sample text
 * searches (recall) over distinctive strings and reports whether each returns
 * >= 1 hit.
 *
 * Env / argv:
 *   TARGET_DBPATH  (argv[2]) default migrated-store under .pluresLM
 *   VERIFY_QUERIES optional - comma-separated override for the 3 sample queries.
 *
 * Final line: "VERIFY_OK count=<n>" or "VERIFY_FAIL <reason>".
 */

import { PluresLmStore } from "./dist/pluresdb.js";

const TARGET_DBPATH =
  process.argv[2] ||
  process.env.TARGET_DBPATH ||
  "C:\\Users\\kbristol\\.pluresLM\\migrated-store";

// Distinctive strings actually present in the source chunk texts.
// (MEMORY.md stub header; the deprecated-memory note; PluresLM itself.)
const DEFAULT_QUERIES = [
  "long-term memory stub",
  "MEMORY.md deprecated",
  "PluresLM native embeddings",
];

const QUERIES = process.env.VERIFY_QUERIES
  ? process.env.VERIFY_QUERIES.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_QUERIES;

function fail(reason) {
  console.log(`VERIFY_FAIL ${reason}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`[verify] TARGET_DBPATH = ${TARGET_DBPATH}`);

  const store = PluresLmStore.open({
    dbPath: TARGET_DBPATH,
    embeddingModel: "BAAI/bge-small-en-v1.5",
  });

  const probe = store.probeOpen?.();
  if (probe && probe.ok !== true) {
    return fail(`store not openable: ${probe.error || "unknown"}`);
  }

  const count = store.count();
  const status = store.status();
  console.log(`[verify] count() = ${count}`);
  console.log(`[verify] status() = ${JSON.stringify(status)}`);
  console.log(`[verify] hasEmbedder() = ${store.hasEmbedder?.()}`);

  if (!count || count < 1) {
    return fail(`count=${count} (empty store — nothing imported)`);
  }

  let anyHit = false;
  let allHit = true;
  for (const q of QUERIES) {
    let hits = [];
    try {
      hits = store.recall(q, 3) || [];
    } catch (err) {
      console.log(`[verify] recall("${q}") ERROR ${err && err.message ? err.message : String(err)}`);
      allHit = false;
      continue;
    }
    const n = hits.length;
    const top = n > 0 ? `top.id=${hits[0].id?.slice(0, 12)} score=${(hits[0].score ?? 0).toFixed(3)}` : "";
    console.log(`[verify] recall("${q}") -> ${n} hit(s) ${top}`);
    if (n >= 1) anyHit = true;
    else allHit = false;
  }

  if (!anyHit) {
    return fail(`no sample query returned any hit (count=${count})`);
  }

  // count >= 1 AND at least one distinctive query recalled a chunk.
  console.log(`VERIFY_OK count=${count}${allHit ? "" : " (partial: some queries returned 0)"}`);
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
