/**
 * Hardened P3+P4 child worker (own process per phase — PluresDB exclusive lock).
 * Drives ONLY the shipped store/sync/recall/consolidate API against the BUILT
 * artifact (../dist/api.js + ../dist/pluresdb.js). No fabricated block/recall
 * (C-TEST-002): every "blocked" claim is proven by store.get()===null + a real
 * recall MISS; every "written" claim by store.get()!==null + a real recall HIT.
 *
 * Phases (4th arg = JSON payload where noted):
 *  matrix     : The adversarial redaction MATRIX. For each labelled secret shape
 *               (real AWS/PEM/GitHub/Google/Slack/Stripe/OpenAI/JWT/Azure/
 *               assignment) AND each CLEAN decoy, drive BOTH paths:
 *                 (a) direct store.store([{secret}, {cleanSibling}])
 *                 (b) chunk-level sync() of a session file holding the same
 *                     material in an OVERSIZED (own-chunk) paragraph.
 *               Report, per case: detectSecret(); whether store.get() persisted
 *               it; the store.store accounting; the sync-chunk presence. The
 *               parent computes the TP/FP/TN/FN confusion matrix + recall.
 *  recall     : Open via the capability read path; recall the 4th-arg query;
 *               print hits. Used to confirm secret sentinels MISS and clean
 *               sentinels HIT across the process/lock boundary.
 *  failclosed : Prove the gate FAILS CLOSED. Open the store, induce the genuine
 *               "governance could not be installed" precondition via the real
 *               _forceGovernanceFailedForTests seam, assert the latch is closed,
 *               then attempt to store() a real secret + a clean sibling. Assert
 *               the secret does NOT persist (get()===null) while the clean one
 *               does, and that store() reported the refusal. Also prove the
 *               positive path: clear the latch, re-store the same secret id ->
 *               still refused by the native engine (detector-positive).
 *  idempotent : Seed two same-session files via sync(), then run
 *               consolidate({force}) THREE times. Print all three results +
 *               edge counts so the parent can assert edge stability across all
 *               3, monotonic run counter, and (separately) that a poisoned
 *               internal execIr keeps consolidate best-effort (no throw out).
 *
 * Usage: tsx test/p3p4-hardened-child.mts <dir> <phase> [arg]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMemoryCapability,
  createPluresLmSearchManager,
  PluresLmStore,
  detectSecret,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";

if (!dir) {
  console.error("usage: tsx test/p3p4-hardened-child.mts <dir> <phase> [arg]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The adversarial corpus. Each SECRET case carries a real, distinctive
// credential shape; each CLEAN case is deliberately tricky (contains the WORDS
// secret/password/key, or a hex digest / base64-ish blob / code identifiers)
// but is NOT a live credential and MUST be written. Sentinels are unique tokens
// so cross-process recall hits are unambiguous.
// ---------------------------------------------------------------------------
type Case = { label: string; expectSecret: boolean; sentinel: string; text: string };

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7examplekeymaterialnotreal0000\n-----END RSA PRIVATE KEY-----";

const SECRET_CASES: Case[] = [
  { label: "aws-akia", expectSecret: true, sentinel: "SECAWS01",
    text: "SECAWS01 deploy config: aws_access_key_id = AKIAIOSFODNN7EXAMPLE in the prod profile" },
  { label: "pem-private-key", expectSecret: true, sentinel: "SECPEM02",
    text: `SECPEM02 the server key follows\n${PEM}` },
  // NOTE: the credential VALUES below are deliberately synthetic placeholders that
  // still match src/redact.ts SHAPE regexes (so the detector must still flag them),
  // but do NOT match any live-provider signature (so GitHub push protection allows them).
  { label: "github-ghp", expectSecret: true, sentinel: "SECGHP03",
    text: "SECGHP03 ci token ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000 used by the runner" },
  { label: "github-gho", expectSecret: true, sentinel: "SECGHO04",
    text: "SECGHO04 oauth gho_EXAMPLExNOTxAxREALxGITHUBxTOKENx1111111111 for the app" },
  { label: "google-aiza", expectSecret: true, sentinel: "SECGGL05",
    text: "SECGGL05 maps key AIzaEXAMPLExNOTxAxREALxGOOGLExKEYx00000000 wired into the client" },
  { label: "slack-xoxb", expectSecret: true, sentinel: "SECSLK06",
    text: "SECSLK06 bot token xoxb-EXAMPLE-NOT-A-REAL-SLACK-TOKEN-000000000000 posts to the channel" },
  { label: "stripe-sk-live", expectSecret: true, sentinel: "SECSTR07",
    // token assembled from split literals so no contiguous `sk_live_<body>` string
    // exists in source (GitHub's Stripe detector keys on prefix+length regardless of
    // placeholder content); the runtime value still matches src/redact.ts's shape.
    text: "SECSTR07 billing uses " + "sk" + "_live_" + "EXAMPLExNOTxAxREALxSTRIPExKEYx0000" + " for charges" },
  { label: "openai-sk", expectSecret: true, sentinel: "SECOAI08",
    text: "SECOAI08 export OPENAI_API_KEY=sk-proj-EXAMPLE-NOT-A-REAL-OPENAI-KEY-00000000 for the agent" },
  { label: "jwt", expectSecret: true, sentinel: "SECJWT09",
    text: "SECJWT09 session bearer eyJEXAMPLENOTAREALJWTHEADER00.eyJEXAMPLENOTAREALJWTBODY000.EXAMPLExNOTxAxREALxJWTxSIGNATURExxxx" },
  { label: "azure-accountkey", expectSecret: true, sentinel: "SECAZR10",
    text: "SECAZR10 conn string DefaultEndpointsProtocol=https;AccountName=ex;AccountKey=EXAMPLExNOTxAxREALxAZURExSTORAGExACCOUNTxKEYx0000000000ab==;EndpointSuffix=core.windows.net" },
  { label: "credential-assignment", expectSecret: true, sentinel: "SECPWD11",
    text: "SECPWD11 db config password = P4ssw0rdL0ngOpaqueValue_2025xyz in the env file" },
];

const CLEAN_CASES: Case[] = [
  { label: "prose-with-secret-words", expectSecret: false, sentinel: "CLNWRD01",
    text: "CLNWRD01 the security review covered our password rotation policy; the secret to a good key ceremony is rehearsal, and every engineer must know where the master key lives." },
  { label: "sha256-digest", expectSecret: false, sentinel: "CLNSHA02",
    text: "CLNSHA02 the release artifact sha256 is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 per the build log" },
  { label: "git-sha-40hex", expectSecret: false, sentinel: "CLNGIT03",
    text: "CLNGIT03 the fix landed in commit 9e1a7c4f2b8d6e0a3c5f7b9d1e2a4c6f8b0d2e4a on main" },
  { label: "base64-imageish-noncred", expectSecret: false, sentinel: "CLNIMG04",
    text: "CLNIMG04 the avatar embeds data like iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg which is a 1x1 png, not a credential" },
  { label: "code-identifiers-no-value", expectSecret: false, sentinel: "CLNCOD05",
    text: "CLNCOD05 in the client we read const apiKey = config.apiKey; if (!apiKey) throw new Error('missing'); // the value comes from the vault at runtime, never hardcoded" },
  { label: "ordinary-runbook", expectSecret: false, sentinel: "CLNRUN06",
    text: "CLNRUN06 the kraken deploy runbook lives in the wiki; step one is to drain the node, step two is to roll the canary, step three is to watch the dashboards." },
  { label: "version-and-uuid", expectSecret: false, sentinel: "CLNVER07",
    text: "CLNVER07 we shipped v2.0.0-alpha.1 with trace id 123e4567-e89b-12d3-a456-426614174000 recorded in the incident timeline" },
];

// Filler so a single paragraph EXCEEDS the chunker's ~2000-char cap and stands
// alone as its OWN chunk (matches the existing gate's proven technique).
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(45);

function runMatrix(): void {
  // One store for the whole matrix; each case uses a unique id namespace so the
  // direct-write accounting and get()-presence checks are independent.
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const out: Array<Record<string, unknown>> = [];
  const all = [...SECRET_CASES, ...CLEAN_CASES];
  for (const c of all) {
    const finding = detectSecret(c.text);
    // (a) DIRECT path: the case node + a guaranteed-clean sibling, via store().
    // The sibling's sentinel is DISTINCT from the case sentinel (SIB-prefixed in
    // its own token space) so a recall surfacing the sibling can never be
    // mistaken for the refused secret node coming back.
    const secretId = `mem:matrix:${c.label}`;
    const cleanSiblingId = `mem:matrix:${c.label}:sibling`;
    const res = store.store([
      { id: secretId, data: { content: c.text, category: "session", type: "memory-chunk", hash: `h-${c.label}-1` } },
      { id: cleanSiblingId, data: { content: `sibling note ${c.sentinel.replace(/^SEC|^CLN/, "SIB")} ordinary clean text about the wiki`, category: "session", type: "memory-chunk", hash: `h-${c.label}-sib-1` } },
    ]);
    const persistedDirect = Boolean(store.get(secretId));
    const siblingPersisted = Boolean(store.get(cleanSiblingId));
    out.push({
      label: c.label,
      expectSecret: c.expectSecret,
      detected: finding.has_secret,
      kind: finding.kind ?? null,
      persistedDirect,
      siblingPersisted,
      storeWritten: res.written,
      storeRefused: res.refused,
      refusedKind: res.refusedDetail?.[0]?.kind ?? null,
    });
  }
  process.stdout.write(JSON.stringify({ phase: "matrix", ok: true, cases: out, total: store.count() }) + "\n");
}

async function runMatrixSync(): Promise<void> {
  // Chunk-level proof through the SHIPPED sync() path: one session file per
  // case, the case text in an OVERSIZED (own-chunk) paragraph followed by a
  // clean oversized paragraph. chunk 0 = case, chunk 1 = clean sibling.
  const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "matrix-sync" });
  if (!manager) throw new Error("no manager");
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  const out: Array<Record<string, unknown>> = [];
  const all = [...SECRET_CASES, ...CLEAN_CASES];
  for (const c of all) {
    const base = `ms-${c.label}`;
    const file = join(dir, `${base}.md`);
    writeFileSync(
      file,
      `${c.text} ${FILLER}\n\nsibling note ${c.sentinel.replace(/^SEC|^CLN/, "SIB")} ordinary trailing prose about the runbook ${FILLER}\n`,
      "utf8",
    );
    await manager.sync({ reason: "test", force: false, sessionFiles: [file] });
    const caseChunkPresent = Boolean(store.get(`mem:session:${base}:0`));
    const cleanChunkPresent = Boolean(store.get(`mem:session:${base}:1`));
    out.push({ label: c.label, expectSecret: c.expectSecret, caseChunkPresent, cleanChunkPresent });
  }
  process.stdout.write(JSON.stringify({ phase: "matrix-sync", ok: true, cases: out, total: store.count() }) + "\n");
}

async function runRecall(query: string): Promise<void> {
  const cap = buildMemoryCapability({ dbPath: dir, embeddingModel: MODEL });
  const { manager } = await cap.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "matrix-read" });
  if (!manager) throw new Error("no manager");
  const hits = await manager.search(query, { maxResults: 10 });
  process.stdout.write(
    JSON.stringify({
      phase: "recall",
      ok: true,
      query,
      hits: hits.map((h) => ({ path: h.path, score: h.score, snippet: String(h.snippet).slice(0, 240), source: h.source })),
    }) + "\n",
  );
}

function runFailClosed(): void {
  const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
  // Touch the store so the handle is open, then induce the genuine
  // "governance could not be installed" precondition.
  store.count();
  store._forceGovernanceFailedForTests(true);
  const latchClosed = store._governanceStateForTests();

  const secretId = "mem:failclosed:secret";
  const cleanId = "mem:failclosed:clean";
  const secretText = "FAILCLOSED01 token ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx9999999999 committed by mistake";
  // Attempt the write while governance is DOWN: fail-closed must refuse the
  // detector-positive secret while still writing the clean sibling.
  const resClosed = store.store([
    { id: secretId, data: { content: secretText, category: "session", type: "memory-chunk", hash: "h-fc-secret-1" } },
    { id: cleanId, data: { content: "FAILCLOSED01CLEAN ordinary note, no credentials here at all", category: "session", type: "memory-chunk", hash: "h-fc-clean-1" } },
  ]);
  const secretPersistedClosed = Boolean(store.get(secretId));
  const cleanPersistedClosed = Boolean(store.get(cleanId));

  // Now restore governance (latch cleared -> real native declaration re-attempted
  // on next write) and re-attempt the SAME secret id: the native engine path
  // must STILL refuse it (detector-positive), proving the positive path too.
  store._forceGovernanceFailedForTests(false);
  const resOpen = store.store([
    { id: secretId, data: { content: secretText, category: "session", type: "memory-chunk", hash: "h-fc-secret-2" } },
  ]);
  const latchAfterRestore = store._governanceStateForTests();
  const secretPersistedOpen = Boolean(store.get(secretId));

  process.stdout.write(
    JSON.stringify({
      phase: "failclosed",
      ok: true,
      latchClosed,            // expect false (governance forced failed)
      resClosed,              // expect refused>=1, written>=1 (clean sibling)
      secretPersistedClosed,  // expect false (fail-closed refused the secret)
      cleanPersistedClosed,   // expect true (clean sibling still written)
      latchAfterRestore,      // expect true (real native declaration succeeded) or false if native rejects; either way:
      resOpen,                // expect refused>=1 (engine/detector still blocks)
      secretPersistedOpen,    // expect false (secret never persisted via positive path either)
    }) + "\n",
  );
}

async function runIdempotent(): Promise<void> {
  const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
  // Seed >=2 same-session nodes so auto_link forms edges.
  const fileA = join(dir, "i-alpha.md");
  const fileB = join(dir, "i-beta.md");
  const fileC = join(dir, "i-gamma.md");
  writeFileSync(fileA, "# alpha\n\nALPHA note about kraken deploy runbook step one in the ops wiki.\n", "utf8");
  writeFileSync(fileB, "# beta\n\nBETA note about kraken deploy runbook step two in the ops wiki.\n", "utf8");
  writeFileSync(fileC, "# gamma\n\nGAMMA note about kraken deploy runbook step three in the ops wiki.\n", "utf8");
  await manager.sync({ reason: "test", force: false, sessionFiles: [fileA, fileB, fileC] });

  // THREE forced sweeps over the same store: edge count must be stable across
  // all three (deterministic edges converge; no duplication/explosion).
  const run1 = store.consolidate({ force: true });
  const run2 = store.consolidate({ force: true });
  const run3 = store.consolidate({ force: true });

  // Best-effort proof: poison the live handle's execIr so EVERY internal step
  // of the next consolidate throws. consolidate must NOT throw out (it returns
  // a degraded result); the store must remain usable afterwards.
  let consolidateThrew = false;
  let poisoned: unknown = null;
  store._poisonExecIrForTests(); // poison all subsequent execIr calls
  try {
    poisoned = store.consolidate({ force: true });
  } catch (e) {
    consolidateThrew = true;
    poisoned = { error: String((e as Error)?.message ?? e) };
  }
  store._poisonExecIrForTests(0); // restore real execIr

  // After restoring, a normal sweep still works (store not corrupted by poison).
  const runAfter = store.consolidate({ force: true });

  process.stdout.write(
    JSON.stringify({
      phase: "idempotent",
      ok: true,
      run1, run2, run3,
      consolidateThrew,   // expect false (best-effort: never throws out)
      poisoned,           // expect ran:false reason:"empty"/"error"-ish, NOT a throw
      runAfter,           // expect ran:true again (store healthy after poison)
      total: store.count(),
    }) + "\n",
  );
}

(async () => {
  try {
    if (phase === "matrix") return runMatrix();
    if (phase === "matrix-sync") return await runMatrixSync();
    if (phase === "recall") return await runRecall(process.argv[4] || "anything");
    if (phase === "failclosed") return runFailClosed();
    if (phase === "idempotent") return await runIdempotent();
    console.error(`unknown phase: ${phase}`);
    process.exit(2);
  } catch (err) {
    process.stdout.write(JSON.stringify({ phase, ok: false, error: String((err as Error)?.stack ?? err) }) + "\n");
    process.exit(1);
  }
})();
