/**
 * QA attacks #2 (chunk-boundary split) and #6 (consolidation at scale), driven
 * through the real shipped sync()/store()/consolidate() API on the built dist.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryCapability, PluresLmStore, createPluresLmSearchManager } from "../dist/api.js";

const MODEL = "BAAI/bge-small-en-v1.5";

// ---- Attack #2: credential split across a chunk boundary -----------------
// The chunker splits on blank-line paragraph boundaries and packs paragraphs up
// to ~2000 chars. We craft a file where:
//  (A) a FULL secret lives entirely inside ONE oversized paragraph (own chunk)
//      -> MUST be refused (the in-one-chunk case must always be caught).
//  (B) a secret is SPLIT: first half ends paragraph 1, second half starts
//      paragraph 2 (forced apart by a blank line) -> document the real behavior:
//      neither half is a valid credential shape, so each chunk is individually
//      clean; we assert NEITHER chunk that contains the FULL secret is written
//      (because no single chunk holds it) and record this as the honest, pinned
//      limitation (partial-secret-across-chunks).
async function attackChunkBoundary() {
  const dir = mkdtempSync(join(tmpdir(), "qa-chunk-"));
  const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  const { manager } = await cap.runtime.getMemorySearchManager({ cfg: {}, agentId: "chunk" });
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(45);

  // (A) full secret in its own oversized chunk.
  const GHP = "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000";
  const fileA = join(dir, "boundary-A.md");
  writeFileSync(fileA, `CHUNKA01 deploy token ${GHP} for the runner ${FILLER}\n\ntrailing clean paragraph CHUNKA01TAIL ${FILLER}\n`, "utf8");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileA] });
  const aChunk0 = Boolean(store.get("mem:session:boundary-a:0"));
  const aChunk1 = Boolean(store.get("mem:session:boundary-a:1"));

  // (B) secret SPLIT across two paragraphs (blank line forces two chunks).
  // ghp_ prefix + first 20 chars in para1; remaining chars in para2. Neither
  // half matches a token pattern on its own.
  const half1 = "ghp_ABCDEFGHIJKLMNOPQR";
  const half2 = "STUVWXYZ0123456789ab";
  const fileB = join(dir, "boundary-B.md");
  writeFileSync(fileB, `CHUNKB01 the token begins ${half1} ${FILLER}\n\n${half2} is the rest of it CHUNKB01TAIL ${FILLER}\n`, "utf8");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileB] });
  const bChunk0 = Boolean(store.get("mem:session:boundary-b:0"));
  const bChunk1 = Boolean(store.get("mem:session:boundary-b:1"));
  // Does recall reassemble the secret? Search for the full token; assert the
  // full contiguous secret never appears in any single snippet.
  const hits = await manager.search("CHUNKB01", { maxResults: 10 });
  const fullSecret = half1 + half2;
  const anySnippetHasFull = hits.some((h) => String(h.snippet).includes(fullSecret));

  return {
    A_fullSecretOwnChunk_refused: aChunk0 === false, // expect true (refused)
    A_cleanTail_written: aChunk1 === true,            // expect true
    B_chunk0_written: bChunk0,                        // half1 only — clean shape
    B_chunk1_written: bChunk1,                        // half2 only — clean shape
    B_fullSecretInAnySnippet: anySnippetHasFull,      // expect false (never reassembled)
  };
}

// ---- Attack #6: consolidation at scale -----------------------------------
async function attackConsolidateScale() {
  const dir = mkdtempSync(join(tmpdir(), "qa-scale-"));
  const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
  // Seed ~40 same-session files so auto_link forms a real graph.
  const files = [];
  for (let i = 0; i < 40; i++) {
    const f = join(dir, `s-${i}.md`);
    writeFileSync(f, `# node ${i}\n\nNODE${i} note about the kraken deploy runbook step ${i % 5} in the ops wiki, cluster ${i % 4}.\n`, "utf8");
    files.push(f);
  }
  await manager.sync({ reason: "test", force: false, sessionFiles: files });

  // Run consolidate 6 times; capture edge count + runs each time.
  const runs = [];
  for (let i = 0; i < 6; i++) runs.push(store.consolidate({ force: true }));
  const edgeCounts = runs.map((r) => r.edges);
  const runCounters = runs.map((r) => r.runs);
  const edgesStable = edgeCounts.every((e) => e === edgeCounts[0]);
  const runsMonotonic = runCounters.every((v, i) => i === 0 || v === runCounters[i - 1] + 1);
  // Checkpoint durability across a fresh process/reopen.
  const beforeReopen = runs[runs.length - 1].runs;
  const store2 = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const afterReopen = store2.consolidate({ force: true });
  return {
    sessionNodes: runs[0].sessionNodes,
    edgeCounts,
    edgesStable,
    runCounters,
    runsMonotonic,
    checkpointDurable: afterReopen.runs === beforeReopen + 1,
    edgesBoundedReasonable: edgeCounts[0] >= 1 && edgeCounts[0] < 40 * 40, // not an N^2 explosion
    finalTotal: store.count(),
  };
}

(async () => {
  const chunk = await attackChunkBoundary();
  const scale = await attackConsolidateScale();
  console.log(JSON.stringify({ chunk, scale }, null, 2));
})();
