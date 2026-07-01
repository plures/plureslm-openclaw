/**
 * P2 SALIENCE-WEIGHTED RECALL TEST GATE (standalone tsx, against the dist/ build).
 *
 * Proves the P2 consumption layer end-to-end through the SHIPPED path, across
 * the PluresDB exclusive-lock (child) boundary. It is the LAST child of the
 * Memory-Superiority epic: consolidate() already COMPUTES + PERSISTS structural
 * salience (topRanked, top PageRank ids); P2 makes recall() CONSUME it.
 *
 *  PROOF (a) \u2014 SALIENCE LIFTS A SALIENT HIT ABOVE AN EQUAL/HIGHER-SCORE PEER:
 *    salient child: seed a cohesive same-session graph via the shipped
 *    manager.sync(sessionFiles, force:true) so auto_link forms real edges and
 *    consolidate() populates a non-empty topRanked, then recall() a probe query.
 *    Assert consolidate ran with real edges + a non-empty topRanked, and that a
 *    (salient S, non-salient P) WITNESS exists where S ranks ABOVE P even though
 *    P's RAW score is >= S's \u2014 an outcome ONLY the salience bonus can produce
 *    (empty-set recall would rank P above S). Salience did real, observable work
 *    WITHOUT a salient node needing the top raw score (protects P1 precision:
 *    the bonus is small+proportional, it breaks near-ties, it does not let a
 *    weak-but-central node leapfrog a strong hit).
 *
 *  PROOF (b) \u2014 EMPTY-SALIENT-SET INVARIANT (byte-identical to pre-change order):
 *    invariant child: seed nodes via the DIRECT store.store() write path ONLY
 *    (which does NOT consolidate, so NO checkpoint / EMPTY salient set), then
 *    recall(). Assert recall()'s order EQUALS the same hits sorted purely by
 *    descending score \u2014 i.e. with an empty salient set the effective-score sort
 *    reduces to the raw-score sort, exactly as before P2.
 *
 * C-TEST-002: real-store gate, channel-agnostic. Edges, salience, and ordering
 * are all produced by shipped code; nothing here fabricates a hit, an edge, a
 * pagerank score, or a salient id.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "p2-salience-recall-child.mts");
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function runChild(dir: string, phase: string) {
  const res = spawnSync(process.execPath, [TSX_CLI, CHILD, dir, phase], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(lastLine); } catch { parsed = null; }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

function gateSalient(): void {
  console.log("\n=== GATE P2(a): salience-weighted recall lifts a salient hit above an equal/higher-score peer ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p2s-"));
  try {
    const s = runChild(dir, "salient");
    if (s.stderr) console.log("  salient stderr:", s.stderr);
    check("salient child exit 0", s.status === 0, s.parsed?.error ?? null);
    check("salient ok", s.parsed?.ok === true, s.parsed?.error ?? null);

    const edges = Number(s.parsed?.edges ?? 0);
    const sessionNodes = Number(s.parsed?.sessionNodes ?? 0);
    const topRanked = (s.parsed?.topRanked as string[]) ?? [];
    check("consolidate ran (shipped sweep executed)", s.parsed?.consolidateRan === true, s.parsed?.consolidateRan);
    check("real associative edges formed (>=1)", edges >= 1, edges);
    check("session graph seeded (>=2 nodes)", sessionNodes >= 2, sessionNodes);
    check("structural salience is NON-EMPTY (topRanked populated)", topRanked.length >= 1, topRanked);

    // At least one salient id must actually appear in the recall top-K for the
    // bonus to be observable at all.
    const salientInRecall = (s.parsed?.salientInRecall as string[]) ?? [];
    check("a salient id appears in the recall top-K", salientInRecall.length >= 1, salientInRecall);

    // THE OBSERVABLE WIN: a salient hit ranks ABOVE a non-salient peer whose RAW
    // score is >= the salient hit's score. Only the salience bonus can do this.
    const w = s.parsed?.witness as null | {
      salientId: string; salientRank: number; salientScore: number;
      peerId: string; peerRank: number; peerScore: number;
    };
    check("WITNESS exists: salient hit out-ranks a >= -raw-score non-salient peer", w != null, w);
    if (w) {
      check("witness: salient ranks strictly above the peer", w.salientRank < w.peerRank, { s: w.salientRank, p: w.peerRank });
      check("witness: peer's RAW score is >= salient's (so only salience can explain the flip)", w.peerScore >= w.salientScore, { salient: w.salientScore, peer: w.peerScore });
      check("witness: salient id is in topRanked, peer id is NOT", topRanked.includes(w.salientId) && !topRanked.includes(w.peerId), { salientId: w.salientId, peerId: w.peerId });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateInvariant(): void {
  console.log("\n=== GATE P2(b): empty-salient-set recall is byte-identical to the raw-score order ===");
  const dir = mkdtempSync(join(tmpdir(), "plureslm-p2i-"));
  try {
    const i = runChild(dir, "invariant");
    if (i.stderr) console.log("  invariant stderr:", i.stderr);
    check("invariant child exit 0", i.status === 0, i.parsed?.error ?? null);
    check("invariant ok", i.parsed?.ok === true, i.parsed?.error ?? null);
    check("nodes written via direct store.store() (no consolidate side-effect)", Number(i.parsed?.writtenCount ?? 0) >= 2, i.parsed?.writtenCount);
    check("recall returned a non-empty hit set to order", Number(i.parsed?.hitCount ?? 0) >= 2, i.parsed?.hitCount);

    const recallOrder = (i.parsed?.recallOrder as string[]) ?? [];
    const rawOrder = (i.parsed?.rawOrder as string[]) ?? [];
    // The core invariant: empty salient set => recall order == pure raw-score order.
    check("INVARIANT: empty-salient recall order == raw-score order (identical sequence)", i.parsed?.invariantHolds === true, { recallOrder, rawOrder });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw P2 SALIENCE-WEIGHTED RECALL GATE (standalone tsx, against dist/ build)");
  gateSalient();
  gateInvariant();
  console.log(`\n=== P2 SALIENCE RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("P2 SALIENCE GATE RUNNER ERROR:", err?.stack ?? err);
  process.exit(1);
});
