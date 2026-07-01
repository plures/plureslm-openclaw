/**
 * Child worker for the P3+P4 gate. Own process per phase (PluresDB exclusive
 * lock). All phases drive the BUILT artifact (../dist/api.js) so the gate
 * exercises exactly what ships.
 *
 * Phases:
 *  secret-write : Ingest, via the SHIPPED sync() path, a session file whose
 *                 FIRST chunk contains a real secret (AWS AKIA + PEM) and whose
 *                 SECOND chunk is clean prose. Then ALSO call store.store()
 *                 directly with one secret node + one clean node to capture the
 *                 governed-write accounting ({written,refused,refusedDetail}).
 *                 Print totals + the refusal detail.
 *  consolidate  : Call store.consolidate({force:true}) TWICE; print both results
 *                 to prove it runs via the shipped path, is idempotent (edge
 *                 count stable, runs increments, no throw), and persists a
 *                 durable checkpoint.
 *  read         : Open via the capability read path, recall a query (4th arg),
 *                 print hits. Used to prove the secret chunk is NOT recallable
 *                 while the clean chunk IS, across the process/lock boundary.
 *
 * Usage: tsx test/p3p4-child.mts <dir> <secret-write|consolidate|read> [query]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
  PluresLmStore,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";

// Distinctive sentinels so recall hits are unambiguous and won't collide with
// the native's bootstrap nodes.
export const SECRET_SENTINEL_PHRASE = "QZX9001SECRET deployment notes follow";
export const CLEAN_SENTINEL_PHRASE = "PLM8800CLEAN the kraken runbook lives in the wiki";
// A real AWS access key id + a PEM private-key header -> the detector MUST flag.
const REAL_SECRET_BLOCK =
  "AWS access key AKIAIOSFODNN7EXAMPLE and a private key\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7secretmaterialxyz\n-----END RSA PRIVATE KEY-----";
// Filler so each paragraph EXCEEDS the chunker's 2000-char cap and therefore
// stands alone as its OWN chunk (proven: a single paragraph >= CHUNK_MAX_CHARS
// is flushed on its own). This makes the secret chunk and the clean chunk
// genuinely SEPARATE chunks of the SAME file, so the gate can prove the secret
// chunk is refused while the clean sibling chunk is written.
const FILLER = ("lorem ipsum dolor sit amet consectetur adipiscing elit ").repeat(45);

if (!dir || (phase !== "secret-write" && phase !== "consolidate" && phase !== "read")) {
  console.error("usage: tsx test/p3p4-child.mts <dir> <secret-write|consolidate|read> [query]");
  process.exit(2);
}

if (phase === "secret-write") {
  (async () => {
    // (A) SHIPPED path: a session file with a SECRET chunk then a CLEAN chunk
    // (blank line separates them into two chunks). Drive manager.sync().
    const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "p3p4" });
    if (!manager) throw new Error("no manager");

    const before = manager.status().chunks ?? 0;
    const sessionFile = join(dir, "session-secret.md");
    // Two OVERSIZED paragraphs (each > 2000 chars via FILLER) so they become two
    // SEPARATE chunks: chunk 0 carries the secret (must be refused), chunk 1 is
    // clean (must be written). Blank line separates the paragraphs.
    writeFileSync(
      sessionFile,
      `${SECRET_SENTINEL_PHRASE} ${REAL_SECRET_BLOCK} ${FILLER}\n\n${CLEAN_SENTINEL_PHRASE} and ordinary trailing prose ${FILLER}\n`,
      "utf8",
    );
    await manager.sync({ reason: "test", force: false, sessionFiles: [sessionFile] });
    const afterSync = manager.status().chunks ?? 0;

    // (B) DIRECT governed-write accounting: one secret node + one clean node via
    // the same shipped store.store() the write path uses. Captures refusedDetail.
    const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
    const direct = store.store([
      {
        id: "mem:direct:secret",
        data: { content: `DIRECTSECRET ${REAL_SECRET_BLOCK}`, category: "session", type: "memory-chunk", hash: "h-secret-1" },
      },
      {
        id: "mem:direct:clean",
        data: { content: "DIRECTCLEAN ordinary note about the wiki runbook", category: "session", type: "memory-chunk", hash: "h-clean-1" },
      },
    ]);

    // Did the refused secret node actually NOT land? get() it back.
    const secretNodePresent = Boolean(store.get("mem:direct:secret"));
    const cleanNodePresent = Boolean(store.get("mem:direct:clean"));
    // Sync-path chunk presence: chunk 0 = secret (refused), chunk 1 = clean.
    const syncSecretChunkPresent = Boolean(store.get("mem:session:session-secret:0"));
    const syncCleanChunkPresent = Boolean(store.get("mem:session:session-secret:1"));

    process.stdout.write(
      JSON.stringify({
        phase: "secret-write",
        ok: true,
        beforeTotalNodes: before,
        afterSyncTotalNodes: afterSync,
        direct,
        secretNodePresent,
        cleanNodePresent,
        syncSecretChunkPresent,
        syncCleanChunkPresent,
        afterAllTotalNodes: store.count(),
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "secret-write", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "consolidate") {
  (async () => {
    const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
    // Seed a small same-session set via the shipped sync() so auto_link has
    // something real to consolidate (>=2 nodes => edges form).
    const fileA = join(dir, "c-alpha.md");
    const fileB = join(dir, "c-beta.md");
    writeFileSync(fileA, "# alpha\n\nALPHA note about kraken deploy runbook step one.\n", "utf8");
    writeFileSync(fileB, "# beta\n\nBETA note about kraken deploy runbook step two.\n", "utf8");
    await manager.sync({ reason: "test", force: false, sessionFiles: [fileA, fileB] });

    // Force two consolidation sweeps back-to-back: idempotency proof.
    const run1 = store.consolidate({ force: true });
    const run2 = store.consolidate({ force: true });

    process.stdout.write(
      JSON.stringify({ phase: "consolidate", ok: true, run1, run2, totalNodes: store.count() }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "consolidate", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "read") {
  const query = process.argv[4] || "anything";
  (async () => {
    const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
    const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "p3p4" });
    if (!manager) throw new Error("no manager");
    const status = manager.status();
    const hits = await manager.search(query, { maxResults: 8 });
    process.stdout.write(
      JSON.stringify({
        phase: "read",
        ok: true,
        query,
        statusTotalNodes: status.chunks,
        hits: hits.map((h) => ({ path: h.path, score: h.score, snippet: h.snippet, source: h.source })),
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "read", ok: false, error: String(err?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}
