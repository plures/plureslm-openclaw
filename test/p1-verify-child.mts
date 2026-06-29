/**
 * P1 VERIFY child worker (the FINAL P1 gate, capability-contract proof).
 *
 * Distinct from the Path B `test/verify-child.mts` (which proves the read/write
 * round-trip + inert fallback). THIS child proves P1 ASSOCIATIVE RECALL works
 * END-TO-END through the EXACT public capability boundary OpenClaw's
 * MemorySearchManager host consumes — and NOTHING ELSE (C-TEST-001/002):
 *
 *   buildMemoryCapability(cfg)            // the plugin's real factory export
 *     .runtime.getMemorySearchManager({cfg, agentId})   // the host call
 *       -> { manager, error }
 *   manager.sync({ sessionFiles })        // the ONLY write entrypoint used
 *   manager.search(query, { maxResults }) // the ONLY read entrypoint used
 *
 * It NEVER touches an internal store method (no store.neighbors / store.execIr /
 * createPluresLmSearchManager) for any assertion — verify must behave correctly
 * at the SAME seam the gateway uses, not a bespoke harness. The only knob is the
 * real, shipped `vectorThreshold` config (used exactly as the host would set
 * it), to push the disjoint sibling below the direct-hit cutoff so the graph
 * path is the only way it can surface. No fabricated edges, no fabricated
 * recall, no stubs.
 *
 * Each phase runs in its OWN process so the PluresDB exclusive file lock is
 * released between the write/link phase and the fresh-process read phases —
 * which is ALSO how DURABILITY is proven (a read phase reopens the SAME dbPath
 * in a brand-new process; if associative recall still works, the edges were
 * persisted to disk, not held in memory).
 *
 * Usage: tsx test/p1-verify-child.mts <dir> <phase>
 *   ingest        : write session fixtures into <dir>, then drive
 *                   getMemorySearchManager -> manager.sync({sessionFiles}) to
 *                   ingest + link-on-write. Prints status() before/after.
 *   read-strict   : FRESH process. getMemorySearchManager (vectorThreshold 0.80)
 *                   -> manager.search(ASSOC_QUERY). Proves DIRECT-MISS/GRAPH-HIT:
 *                   the disjoint sibling arrives via:"graph".
 *   read-default  : FRESH process. getMemorySearchManager (default threshold)
 *                   -> manager.search(PRECISION_QUERY). Proves PRECISION: the
 *                   on-topic node is top-1 direct; graph never displaces it.
 *   ingest-lone   : write a SINGLE isolated session file (no same-session
 *                   siblings => link-on-write forms no usable edge) and sync it
 *                   via the manager. Sets up the GRACEFUL-FALLBACK read.
 *   read-lone     : FRESH process. manager.search(LONE_QUERY). Proves graceful
 *                   fallback: with no graph edges to expand, search() STILL
 *                   returns the direct hit (augment-not-replace: enabling P1 can
 *                   never make recall worse than baseline vector recall).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// IMPORTANT: import ONLY the public plugin factory from the BUILT artifact —
// the same symbol package.json's `main`/`openclaw.extensions` ship and that
// `src/index.ts` hands to `api.registerMemoryCapability`. No internal store.
import { buildMemoryCapability } from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const MODEL = "BAAI/bge-small-en-v1.5";
const STRICT_THRESHOLD = 0.8;

// --- Realistic session fixtures (not the toy fixture) ------------------------
//
// A small set of session memories written in the SAME sync (same category +
// same temporal window => link-on-write joins them). Two of them are TOPICALLY
// ASSOCIATED-by-context but LEXICALLY/VECTORALLY DISSIMILAR:
//
//   ONCALL  — on-topic for the assoc query: the on-call escalation runbook for
//             the payments service (kraken). This is what the query vector-hits.
//   ROTA    — the SAME incident's on-call rota / pager handoff names. Disjoint
//             vocabulary from the query (people + scheduling, no "runbook"/
//             "escalation" terms), low cosine — but written in the same session,
//             so it is the memory you actually want surfaced ALONGSIDE the
//             runbook. This is the DIRECT-MISS / GRAPH-HIT target.
//   BACKUP  — on-topic for the PRECISION query (postgres backup schedule). Gives
//             the precision query a clear expected DIRECT top-1 that graph
//             expansion must never displace.
//   PLANTS  — fully off-topic control (photosynthesis) so the graph set isn't
//             trivially everything; it is same-session too, so it tests that
//             graph breadth doesn't wreck precision.
const FILE_ONCALL = "sess-oncall.md";
const FILE_ROTA = "sess-rota.md";
const FILE_BACKUP = "sess-backup.md";
const FILE_PLANTS = "sess-plants.md";

const ID_ONCALL = "mem:session:sess-oncall:0";
const ID_ROTA = "mem:session:sess-rota:0";
const ID_BACKUP = "mem:session:sess-backup:0";

const TEXT_ONCALL =
  "# oncall\n\nThe kraken payments service on-call escalation runbook: page the " +
  "primary, then escalate to the incident commander if not acked in ten minutes.\n";
// Deliberately disjoint vocabulary from the assoc query (names + handoff, no
// "kraken"/"runbook"/"escalation"/"payments" terms) so its cosine to the query
// stays below the strict 0.80 bar — it can ONLY be reached by association.
const TEXT_ROTA =
  "# rota\n\nPager handoff schedule for this week: Mara takes Monday and Tuesday, " +
  "Devin covers Wednesday through Friday, Priya owns the weekend shift.\n";
const TEXT_BACKUP =
  "# backup\n\nThe postgres backup schedule and nightly pg_dump retention policy " +
  "for the warehouse cluster, kept for thirty days.\n";
const TEXT_PLANTS =
  "# plants\n\nPhotosynthesis converts light into chemical energy; chlorophyll " +
  "absorbs red and blue wavelengths in the leaf.\n";

// Lone fixture for the graceful-fallback phase (no same-session sibling, so
// link-on-write has no pair to edge => no graph expansion at read time).
const FILE_LONE = "sess-lone.md";
const ID_LONE = "mem:session:sess-lone:0";
const TEXT_LONE =
  "# lone\n\nStandalone memory: the quarterly capacity-planning review for the " +
  "search index shards is scheduled for the first week of the month.\n";

// On-topic for ONCALL, disjoint from ROTA (the DIRECT-MISS/GRAPH-HIT query).
const ASSOC_QUERY = "incident escalation runbook for the payments service";
// On-topic for BACKUP (the PRECISION query) — clear expected direct top-1.
const PRECISION_QUERY = "postgres backup schedule pg_dump retention";
// On-topic for the lone node (graceful-fallback query).
const LONE_QUERY = "quarterly capacity planning review for the search index shards";

function writeSessionFixtures(): void {
  writeFileSync(join(dir, FILE_ONCALL), TEXT_ONCALL, "utf8");
  writeFileSync(join(dir, FILE_ROTA), TEXT_ROTA, "utf8");
  writeFileSync(join(dir, FILE_BACKUP), TEXT_BACKUP, "utf8");
  writeFileSync(join(dir, FILE_PLANTS), TEXT_PLANTS, "utf8");
}

/**
 * Acquire a manager EXACTLY as the gateway does: build the capability from the
 * plugin factory, then call runtime.getMemorySearchManager({cfg, agentId}).
 * Returns the manager or throws with the host-surfaced error. No store access.
 */
async function getManagerViaHostBoundary(vectorThreshold?: number) {
  const capability = buildMemoryCapability({
    dbPath: dir,
    embeddingModel: MODEL,
    vectorThreshold,
  });
  if (!capability.runtime) {
    throw new Error("capability.runtime missing — not a valid memory capability");
  }
  // The host passes {cfg, agentId} (and an optional purpose). We pass the same
  // shape; the plugin captures its real config at buildMemoryCapability() time.
  const { manager, error } = await capability.runtime.getMemorySearchManager({
    cfg: {} as never,
    agentId: "verify",
    purpose: "default",
  });
  if (!manager) throw new Error(error ?? "getMemorySearchManager returned no manager");
  return manager;
}

/** Normalize a host MemorySearchResult[] to the provenance fields we assert. */
function rank(hits: Array<Record<string, unknown>>) {
  return hits.map((h, idx) => {
    const citation = typeof h.citation === "string" ? h.citation : null;
    const isGraph = Boolean(
      citation?.includes("graph") &&
        h.vectorScore === undefined &&
        h.textScore === undefined,
    );
    let seedId: string | null = null;
    if (isGraph && citation) {
      const m = citation.match(/^plureslm:graph:(.+)->(.+)$/);
      seedId = m ? m[1] : null;
    }
    return {
      rank: idx,
      path: String(h.path),
      score: typeof h.score === "number" ? h.score : 0,
      citation,
      via: isGraph ? "graph" : h.vectorScore !== undefined ? "vector" : "text",
      seedId,
      source: typeof h.source === "string" ? h.source : null,
    };
  });
}

function emit(obj: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(typeof obj.ok === "boolean" && obj.ok === false ? 1 : 0);
}

async function main(): Promise<void> {
  if (phase === "ingest" || phase === "ingest-lone") {
    if (phase === "ingest") writeSessionFixtures();
    else writeFileSync(join(dir, FILE_LONE), TEXT_LONE, "utf8");

    const manager = await getManagerViaHostBoundary();
    if (typeof manager.sync !== "function") {
      emit({ phase, ok: false, error: "manager.sync is not a function" });
    }
    const before = manager.status();
    let progressCalls = 0;
    const sessionFiles =
      phase === "ingest"
        ? [
            join(dir, FILE_ONCALL),
            join(dir, FILE_ROTA),
            join(dir, FILE_BACKUP),
            join(dir, FILE_PLANTS),
          ]
        : [join(dir, FILE_LONE)];
    // The ONLY write entrypoint used — exactly the host's lazy/forced sync call.
    await manager.sync!({
      reason: "verify-ingest",
      force: false,
      sessionFiles,
      progress: () => {
        progressCalls += 1;
      },
    });
    const after = manager.status();
    emit({
      phase,
      ok: true,
      beforeChunks: before.chunks ?? null,
      afterChunks: after.chunks ?? null,
      delta: (after.chunks ?? 0) - (before.chunks ?? 0),
      progressCalls,
      backend: after.backend,
      provider: after.provider,
      sessionFileCount: sessionFiles.length,
    });
  }

  if (phase === "read-strict") {
    // FRESH process, strict threshold: the disjoint ROTA can only arrive via
    // graph expansion of the ONCALL direct hit. This is the DIRECT-MISS/GRAPH-HIT
    // proof through the REAL manager boundary.
    const manager = await getManagerViaHostBoundary(STRICT_THRESHOLD);
    const hits = await manager.search(ASSOC_QUERY, { maxResults: 8 });
    emit({
      phase,
      ok: true,
      query: ASSOC_QUERY,
      vectorThreshold: STRICT_THRESHOLD,
      ids: { oncall: ID_ONCALL, rota: ID_ROTA, backup: ID_BACKUP },
      ranked: rank(hits as Array<Record<string, unknown>>),
    });
  }

  if (phase === "read-default") {
    // FRESH process, DEFAULT threshold: the on-topic BACKUP must be top-1 direct
    // for the precision query; graph hits never displace it.
    const manager = await getManagerViaHostBoundary();
    const hits = await manager.search(PRECISION_QUERY, { maxResults: 8 });
    emit({
      phase,
      ok: true,
      query: PRECISION_QUERY,
      vectorThreshold: null,
      ids: { oncall: ID_ONCALL, rota: ID_ROTA, backup: ID_BACKUP },
      ranked: rank(hits as Array<Record<string, unknown>>),
    });
  }

  if (phase === "read-lone") {
    // FRESH process: a single isolated memory with NO same-session sibling, so
    // link-on-write formed no usable edge and search() has nothing to graph-
    // expand. The graceful-fallback property: search() STILL returns the direct
    // hit (augment-not-replace). We use the DEFAULT threshold so the on-topic
    // lone node is a normal direct vector hit.
    const manager = await getManagerViaHostBoundary();
    const hits = await manager.search(LONE_QUERY, { maxResults: 8 });
    const ranked = rank(hits as Array<Record<string, unknown>>);
    emit({
      phase,
      ok: true,
      query: LONE_QUERY,
      ids: { lone: ID_LONE },
      ranked,
      graphHitCount: ranked.filter((r) => r.via === "graph").length,
    });
  }

  emit({ phase, ok: false, error: `unknown phase: ${phase}` });
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ phase, ok: false, error: String(err?.stack ?? err) }) + "\n",
  );
  process.exit(1);
});
