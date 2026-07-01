/**
 * Child worker for the P2 SALIENCE-WEIGHTED RECALL gate. Runs each phase in its
 * OWN process so the PluresDB exclusive file lock is released between phases
 * (same cross-process contract the other *-child.mts gates honor).
 *
 * It exercises the REAL, SHIPPED capability only \u2014 no fixtures faking recall or
 * salience (C-TEST-002): edges are formed by the shipped sync() link-on-write
 * path, salience (topRanked) is produced by the shipped store.consolidate()
 * PageRank sweep, and ordering is produced by the shipped store.recall(). This
 * child NEVER writes an edge, a pagerank score, or a salient id by hand.
 *
 * Two independent phases, each on its own store:
 *
 *   salient   : seed a cohesive same-session graph via manager.sync(
 *               sessionFiles, force:true). sync() runs link-on-write AND (because
 *               force:true) the shipped consolidate() sweep, so PageRank
 *               populates a non-empty topRanked. recall() here is
 *               salience-weighted. PROVES (a): a salient hit ranks ABOVE an
 *               equally/ more-similar NON-salient peer (the small proportional
 *               bonus tips the tightly-clustered scores in favor of structural
 *               salience) \u2014 WITHOUT a salient node needing the top raw score.
 *
 *   invariant : seed nodes via the DIRECT store.store() write path ONLY. That
 *               path does NOT call consolidate(), so NO checkpoint is written and
 *               the persisted salient set is EMPTY. With an empty salient set the
 *               recall() effective-score reduces to the raw score, so recall()'s
 *               order MUST equal the same hits sorted purely by descending score.
 *               PROVES (b): the empty-salient-set invariant (byte-identical to
 *               the pre-change raw-score ordering).
 *
 * Usage: tsx test/p2-salience-recall-child.mts <dir> <salient|invariant>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPluresLmSearchManager } from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";

// Probe query \u2014 on-topic for the whole cohesive corpus so the returned hits are
// tightly clustered in raw similarity. A tight cluster is exactly where the
// small (15%) proportional salience bonus can flip a near-tie, which is the
// mechanism under test.
const PROBE_QUERY = "kraken deploy runbook failover rehearsal";
const N = 24; // enough same-session nodes that PageRank has real structure
const K = 8; // recall depth

/** Normalize a recall() result to the fields the parent asserts on. */
function rankOf(
  hits: Array<{ id: string; score: number }>,
): Array<{ rank: number; id: string; score: number }> {
  return hits.map((h, i) => ({ rank: i, id: h.id, score: h.score }));
}

if (phase === "salient") {
  (async () => {
    mkdirSync(dir, { recursive: true });
    const { store, manager } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
    // Seed N cohesive same-session memories through the SHIPPED write path. All
    // share the topic (so recall scores cluster) but carry a distinctive
    // per-node token so they stay distinct chunks. sync(force:true) runs
    // link-on-write (auto_link) AND the shipped consolidate() sweep, so
    // PageRank populates topRanked.
    const files: string[] = [];
    for (let i = 0; i < N; i++) {
      const f = join(dir, `sseed-${i}.md`);
      writeFileSync(
        f,
        `# kraken runbook step ${i}\n\nSSEED${i} the kraken deploy runbook covers failover step ${i % 4} for cluster ${i % 3}, rehearsed with the on-call team.\n`,
        "utf8",
      );
      files.push(f);
    }
    await manager.sync({ reason: "p2-salience", force: true, sessionFiles: files });
    // Re-run consolidate explicitly so we capture the exact persisted topRanked
    // the salience-weighted recall will consume (idempotent; same sweep sync
    // already ran, forced so it re-evaluates).
    const consolidated = store.consolidate({ force: true });
    const topRanked = consolidated.topRanked;

    // Salience-weighted recall via the SHIPPED store.recall().
    const hits = store.recall(PROBE_QUERY, K);
    const ranked = rankOf(hits);
    const inTop = (id: string) => topRanked.includes(id);

    // The observable win: find a (salient S, non-salient P) pair where S ranks
    // ABOVE P even though P's RAW score is >= S's raw score. That can ONLY be
    // the salience bonus (empty-set recall would rank P above S). We surface the
    // strongest such witness so the parent asserts on real, computed evidence.
    let witness: {
      salientId: string; salientRank: number; salientScore: number;
      peerId: string; peerRank: number; peerScore: number;
    } | null = null;
    for (const s of ranked) {
      if (!inTop(s.id)) continue;
      for (const p of ranked) {
        if (inTop(p.id)) continue;
        // P is a NON-salient peer that S out-ranks despite P having >= raw score.
        if (s.rank < p.rank && p.score >= s.score) {
          if (!witness || p.score - s.score > witness.peerScore - witness.salientScore) {
            witness = {
              salientId: s.id, salientRank: s.rank, salientScore: s.score,
              peerId: p.id, peerRank: p.rank, peerScore: p.score,
            };
          }
        }
      }
    }

    process.stdout.write(
      JSON.stringify({
        phase: "salient",
        ok: true,
        consolidateRan: consolidated.ran,
        edges: consolidated.edges,
        sessionNodes: consolidated.sessionNodes,
        topRanked,
        salientInRecall: ranked.filter((r) => inTop(r.id)).map((r) => r.id),
        witness,
        ranked,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "salient", ok: false, error: String((err as Error)?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase === "invariant") {
  (async () => {
    mkdirSync(dir, { recursive: true });
    const { store } = createPluresLmSearchManager({ dbPath: dir, embeddingModel: MODEL });
    // Seed via the DIRECT store.store() write path ONLY \u2014 it embeds+indexes but
    // does NOT call consolidate(), so NO checkpoint is ever written and the
    // salient set stays EMPTY. This isolates the empty-salient-set invariant.
    const nodes = [];
    for (let i = 0; i < 12; i++) {
      nodes.push({
        id: `inv:${i}`,
        data: {
          content: `INV${i} the kraken deploy runbook covers failover step ${i % 4} for cluster ${i % 3}, rehearsed with the on-call team.`,
          category: "session",
          type: "memory-chunk",
          hash: `inv-h-${i}`,
        },
      });
    }
    const written = store.store(nodes);

    // Empty salient set => recall() effective-score == raw score => recall()
    // order MUST equal the SAME hits sorted purely by descending score.
    const hits = store.recall(PROBE_QUERY, K);
    const ranked = rankOf(hits);
    const recallOrder = ranked.map((r) => r.id);
    // Independent raw-score order (stable: -score, then original recall index as
    // the tie-break, matching the stable sort recall() itself uses).
    const rawOrder = hits
      .map((h, i) => ({ id: h.id, score: h.score, orig: i }))
      .sort((a, b) => b.score - a.score || a.orig - b.orig)
      .map((h) => h.id);

    process.stdout.write(
      JSON.stringify({
        phase: "invariant",
        ok: true,
        writtenCount: written.written,
        hitCount: hits.length,
        recallOrder,
        rawOrder,
        invariantHolds:
          recallOrder.length === rawOrder.length &&
          recallOrder.every((id, i) => id === rawOrder[i]),
        ranked,
      }) + "\n",
    );
    process.exit(0);
  })().catch((err) => {
    process.stdout.write(JSON.stringify({ phase: "invariant", ok: false, error: String((err as Error)?.stack ?? err) }) + "\n");
    process.exit(1);
  });
}

if (phase !== "salient" && phase !== "invariant") {
  console.error("usage: tsx test/p2-salience-recall-child.mts <dir> <salient|invariant>");
  process.exit(2);
}
