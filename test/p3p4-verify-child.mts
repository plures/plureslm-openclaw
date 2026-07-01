/**
 * P3+P4 VERIFY child worker (EPIC-MEMORY-SUPERIORITY, the FINAL gate).
 *
 * Runs ONE phase in its OWN process so the PluresDB exclusive file lock is
 * released between phases — every durability claim is therefore reproduced
 * across a genuinely FRESH process, not a reused handle.
 *
 * CHANNEL-AGNOSTIC (C-TEST-002): drives the SHIPPED MemorySearchManager
 *   buildMemoryCapability(cfg).runtime.getMemorySearchManager({cfg,agentId})
 *     -> manager.sync(...) / manager.search(...)
 * against the real SDK contract (memory-state .d.ts: search/sync/status). NO
 * chat adapter, NO mock. Write-accounting + the consolidation checkpoint use
 * the shipped PluresLmStore (also part of the public api.js barrel) — never a
 * second native handle on a live dbPath, never reaching into private state.
 *
 * Usage:  tsx test/p3p4-verify-child.mts <dir> <phase>
 *   redact-write    : sync a realistic batch (clean + secrets in content/
 *                     secondary-field/PEM/AWS) via the SHIPPED manager.sync();
 *                     ALSO record store.store() write-accounting for the same
 *                     batch shapes (the manager.sync surface returns void). Emit
 *                     the per-id persisted/refused facts + accounting.
 *   redact-recall   : FRESH process. manager.search() each probe; assert the
 *                     credential strings NEVER appear in any snippet and the
 *                     credential-bearing nodes are NEVER recalled, while the
 *                     clean memory IS recalled. Emit per-probe leak booleans.
 *   consolidate-seed: seed N session memories via manager.sync(), run K forced
 *                     consolidate sweeps, emit edge/run/cluster series + the
 *                     associative-recall observable (graph neighbors present).
 *   consolidate-reopen: FRESH process. reopen same dbPath, read the durable
 *                     checkpoint via one more consolidate({force}); assert the
 *                     run counter advanced (= prior + 1) and edges still bounded
 *                     + stable; re-assert associative recall still works.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Import the BUILT artifact (dist) — exactly what ships.
import {
  buildMemoryCapability,
  PluresLmStore,
  detectSecret,
} from "../dist/api.js";

const dir = process.argv[2];
const phase = process.argv[3];
const VALID = new Set([
  "redact-write",
  "redact-recall",
  "consolidate-seed",
  "consolidate-reopen",
]);
if (!phase || !VALID.has(phase)) {
  console.error(
    "usage: tsx test/p3p4-verify-child.mts <dir> redact-write|redact-recall|consolidate-seed|consolidate-reopen",
  );
  process.exit(2);
}

const MODEL = "BAAI/bge-small-en-v1.5";

// ---------------------------------------------------------------------------
// Realistic secret material (well-known PUBLIC example/non-functional values —
// nothing live; these are canonical doc placeholders that match the detector's
// real regex shapes). Distinctive sentinels let recall queries target them.
// ---------------------------------------------------------------------------
const AKIA = "AKIAIOSFODNN7EXAMPLE"; // canonical AWS docs example id
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40-char AWS docs example secret
const GHP = "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000"; // GitHub classic token shape
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEA7exampleNOTREALkeymaterial0000000000000000000000",
  "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

// Each probe: a realistic memory the user might try to persist. `secret` is the
// raw string that MUST never be recalled; `field` documents WHERE it lives.
type Probe = {
  id: string;
  label: string;
  query: string; // distinctive sentinel to search for
  secret: string;
  field: string;
  data: Record<string, unknown>;
};

const CLEAN_QUERY = "VRFYCLEAN disaster recovery failover runbook rehearsed quarterly";
const probes: Probe[] = [
  {
    id: "mem:vrfy:clean",
    label: "clean",
    query: "disaster recovery failover runbook rehearsed quarterly",
    secret: "\u0000NO_SECRET_SENTINEL\u0000", // never present -> leak check is trivially false
    field: "(none)",
    data: {
      content: `VRFYCLEAN the disaster recovery failover runbook is rehearsed quarterly by the on-call rotation`,
      category: "session",
      type: "memory-chunk",
      source: "sessions",
      path: "/vrfy/clean.md",
      hash: "h-vrfy-clean-1",
    },
  },
  {
    id: "mem:vrfy:content",
    label: "secret-in-content",
    query: "VRFYCONTENT production deploy credentials",
    secret: GHP,
    field: "content",
    data: {
      content: `VRFYCONTENT production deploy credentials: the github token is ${GHP} keep it safe`,
      category: "session",
      type: "memory-chunk",
      source: "sessions",
      path: "/vrfy/content.md",
      hash: "h-vrfy-content-1",
    },
  },
  {
    id: "mem:vrfy:secondary",
    label: "secret-in-secondary-field(value)",
    query: "VRFYSECONDARY onboarding notes new engineer",
    secret: AKIA,
    field: "value",
    data: {
      // benign primary content; the live credential hides in a SECONDARY
      // recall-surfaced field (the bug QA found + fixed).
      content: `VRFYSECONDARY onboarding notes for the new engineer, see the runbook`,
      value: `aws_access_key_id = ${AKIA}`,
      category: "session",
      type: "memory-chunk",
      source: "sessions",
      path: "/vrfy/secondary.md",
      hash: "h-vrfy-secondary-1",
    },
  },
  {
    id: "mem:vrfy:pem",
    label: "secret-multiline-PEM(note)",
    query: "VRFYPEM provisioning script private key",
    secret: "BEGIN RSA PRIVATE KEY",
    field: "note",
    data: {
      content: `VRFYPEM provisioning script notes for the gateway host`,
      note: PEM,
      category: "session",
      type: "memory-chunk",
      source: "sessions",
      path: "/vrfy/pem.md",
      hash: "h-vrfy-pem-1",
    },
  },
  {
    id: "mem:vrfy:awssecret",
    label: "secret-aws-40char(body)",
    query: "VRFYAWS terraform backend configuration",
    secret: AWS_SECRET,
    field: "body",
    data: {
      content: `VRFYAWS terraform backend configuration notes`,
      body: `aws_secret_access_key = ${AWS_SECRET}`,
      category: "session",
      type: "memory-chunk",
      source: "sessions",
      path: "/vrfy/awssecret.md",
      hash: "h-vrfy-awssecret-1",
    },
  },
];

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function getManager(cfgDir: string, agentId: string) {
  const capability = buildMemoryCapability({ dbPath: cfgDir, embeddingModel: MODEL });
  if (!capability.runtime) throw new Error("capability.runtime missing");
  const { manager, error } = await capability.runtime.getMemorySearchManager({
    cfg: {} as never,
    agentId,
  });
  if (!manager) throw new Error(`no manager: ${error ?? "unknown"}`);
  return manager;
}

// ===========================================================================
// PROOF 1 — C-MEM-REDACT end-to-end, WRITE leg.
// ===========================================================================
if (phase === "redact-write") {
  (async () => {
    mkdirSync(dir, { recursive: true });
    const manager = await getManager(dir, "vrfy-redact");

    // (A) Drive the SHIPPED write path: write each probe as its own session
    // file and sync through manager.sync() (the real consumer write surface).
    const sessionFiles: string[] = [];
    for (const p of probes) {
      const f = join(dir, `${p.label.replace(/[^a-z0-9]+/gi, "_")}.md`);
      // Render the SAME content the data carries, including secondary fields,
      // so the file-chunk path sees the secret exactly where the probe puts it.
      const parts = [String(p.data.content ?? "")];
      for (const k of ["value", "note", "body"]) {
        if (p.data[k]) parts.push(String(p.data[k]));
      }
      writeFileSync(f, `# ${p.label}\n\n${parts.join("\n\n")}\n`, "utf8");
      sessionFiles.push(f);
    }
    const before = manager.status();
    await manager.sync({ reason: "verify", force: false, sessionFiles });
    const after = manager.status();

    // (B) ALSO record the write-accounting the manager.sync() void surface can't
    // return, by replaying the SAME node shapes through the shipped
    // store.store() (the public API that surfaces {written,skipped,refused}).
    // Same dbPath, same process -> reuses the memoized handle (no 2nd lock).
    const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
    const accounting: Array<Record<string, unknown>> = [];
    for (const p of probes) {
      const res = store.store([{ id: p.id, data: p.data }]);
      const persisted = Boolean(store.get(p.id));
      accounting.push({
        id: p.id,
        label: p.label,
        field: p.field,
        written: res.written,
        skipped: res.skipped,
        refused: res.refused,
        refusedDetail: res.refusedDetail,
        persisted,
        // independent detector read on the exact field value (evidence the
        // secret IS detectable where it lives):
        detectorFlagsField:
          p.field === "(none)"
            ? false
            : detectSecret(String(p.data[p.field] ?? p.data.content ?? "")).has_secret,
      });
    }

    emit({
      phase,
      ok: true,
      beforeChunks: before.chunks,
      afterChunks: after.chunks,
      delta: (after.chunks ?? 0) - (before.chunks ?? 0),
      accounting,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String((err as Error)?.stack ?? err) });
    process.exit(1);
  });
}

// ===========================================================================
// PROOF 1 — C-MEM-REDACT end-to-end, RECALL leg (FRESH PROCESS).
// ===========================================================================
if (phase === "redact-recall") {
  (async () => {
    const manager = await getManager(dir, "vrfy-redact");
    const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });

    const results: Array<Record<string, unknown>> = [];
    let cleanRecalled = false;
    for (const p of probes) {
      const hits = await manager.search(p.query, { maxResults: 10 });
      const snippets = hits.map((h) => String(h.snippet));
      // Does the raw secret string surface in ANY snippet?
      const secretInSnippet =
        p.field !== "(none)" && snippets.some((s) => s.includes(p.secret));
      // Is the credential-bearing node itself recalled (by id)?
      const idRecalled = hits.some((h) => h.path === p.id);
      // Independent absence proof: the node never persisted at all.
      const persisted = Boolean(store.get(p.id));

      if (p.label === "clean") {
        cleanRecalled = hits.some((h) => h.path === p.id) ||
          snippets.some((s) => s.includes("VRFYCLEAN"));
      }
      results.push({
        id: p.id,
        label: p.label,
        field: p.field,
        hitCount: hits.length,
        secretInSnippet,
        idRecalled,
        persisted,
        topPaths: hits.slice(0, 3).map((h) => h.path),
      });
    }

    // Belt-and-suspenders: a broad query that could surface ANY chunk must
    // still never carry a raw secret in any snippet.
    const broad = await manager.search("credentials key token runbook deploy", {
      maxResults: 20,
    });
    const anySecretAnywhere = broad.some((h) =>
      [AKIA, AWS_SECRET, GHP, "BEGIN RSA PRIVATE KEY"].some((s) =>
        String(h.snippet).includes(s),
      ),
    );

    emit({
      phase,
      ok: true,
      cleanRecalled,
      anySecretAnywhere,
      results,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String((err as Error)?.stack ?? err) });
    process.exit(1);
  });
}

// ===========================================================================
// PROOF 2 — consolidation real value, SEED + sweeps.
// ===========================================================================
if (phase === "consolidate-seed") {
  (async () => {
    mkdirSync(dir, { recursive: true });
    const manager = await getManager(dir, "vrfy-consolidate");

    // Seed enough same-session memories that consolidation forms real graph
    // structure. Use a cohesive topic so associative recall is observable.
    const N = 24;
    const files: string[] = [];
    for (let i = 0; i < N; i++) {
      const f = join(dir, `cseed-${i}.md`);
      writeFileSync(
        f,
        `# kraken runbook step ${i}\n\nKRAKEN${i} the kraken deploy runbook covers failover step ${i % 4} for cluster ${i % 3}, rehearsed with the on-call team.\n`,
        "utf8",
      );
      files.push(f);
    }
    // The SHIPPED write path: sync() chunks+writes+links, then opportunistically
    // consolidates (forced here because the caller forces the sync).
    await manager.sync({ reason: "verify", force: true, sessionFiles: files });

    // Drive the consolidation path the way it actually triggers: opportunistic
    // from sync(). We additionally call the shipped store.consolidate({force})
    // (the same method sync() invokes) repeatedly to prove idempotency/bounded.
    const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });
    const sweeps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      const r = store.consolidate({ force: true });
      sweeps.push({
        ran: r.ran,
        reason: r.reason,
        edges: r.edges,
        sessionNodes: r.sessionNodes,
        clusters: r.clusters,
        runs: r.runs,
        checkpointEpoch: r.checkpointEpoch,
        topRanked: r.topRanked.slice(0, 3),
      });
    }

    // OBSERVABLE VALUE: associative recall — a direct hit should pull in graph
    // neighbors (the edges consolidation/link-on-write materialized).
    const hits = await manager.search("kraken deploy runbook failover", {
      maxResults: 5,
    });
    const status = manager.status();

    // Direct evidence the graph has structure: neighbors of a seed node.
    let neighborCount = 0;
    if (hits.length > 0) {
      const seedId = hits[0].path;
      neighborCount = store.neighbors(seedId, 1, 0.5).length;
    }

    emit({
      phase,
      ok: true,
      N,
      sweeps,
      lastRuns: sweeps[sweeps.length - 1]?.runs,
      lastEdges: sweeps[sweeps.length - 1]?.edges,
      recallHits: hits.length,
      neighborCount,
      statusChunks: status.chunks,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String((err as Error)?.stack ?? err) });
    process.exit(1);
  });
}

// ===========================================================================
// PROOF 2 + 4 — consolidation checkpoint DURABLE across a FRESH process.
// ===========================================================================
if (phase === "consolidate-reopen") {
  (async () => {
    const priorRuns = Number(process.argv[4] ?? "NaN");
    const priorEdges = Number(process.argv[5] ?? "NaN");
    const manager = await getManager(dir, "vrfy-consolidate");
    const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });

    // One more forced sweep in this FRESH process — reads the DURABLE checkpoint
    // and must advance the monotonic run counter (= prior + 1) while leaving the
    // edge set bounded + stable (idempotent across the process boundary).
    const r = store.consolidate({ force: true });

    // Associative recall still works after restart (observable value persisted).
    const hits = await manager.search("kraken deploy runbook failover", {
      maxResults: 5,
    });
    let neighborCount = 0;
    if (hits.length > 0) {
      neighborCount = store.neighbors(hits[0].path, 1, 0.5).length;
    }

    emit({
      phase,
      ok: true,
      priorRuns,
      priorEdges,
      runsAfterReopen: r.runs,
      edgesAfterReopen: r.edges,
      runCounterAdvanced: Number.isFinite(priorRuns) ? r.runs === priorRuns + 1 : null,
      edgesStable: Number.isFinite(priorEdges) ? r.edges === priorEdges : null,
      recallHits: hits.length,
      neighborCount,
    });
    process.exit(0);
  })().catch((err) => {
    emit({ phase, ok: false, error: String((err as Error)?.stack ?? err) });
    process.exit(1);
  });
}
