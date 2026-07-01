# P3 + P4 IMPLEMENT NOTES — EPIC-MEMORY-SUPERIORITY

**Worktree:** `C:\Projects\plureslm-openclaw-p3p4`\n**Branch:** `feat/p3p4-reactive-governed` (built on Path B write path + P1 link-on-write graph recall, committed `7f79f02`)
**Native:** `@plures/pluresdb-native` → `file:../pluresdb/crates/pluresdb-node` (v2.0.0-alpha.1, on-disk `.node` ~36 MB)
**Status:** `pnpm run build` → exit 0. `pnpm test` → **ALL CHECKS PASSED** (recall GATE A/B/C + new GATE P3/P4), exit 0.

This document is the honest record of what was built, what is genuinely DB-governed, and what is deliberately ABSENT (not stubbed — C-NOSTUB-001).

---

## P4 — Governed write redaction (C-MEM-REDACT)

### Does it really block a secret? YES — proven on this run.

From the P3+P4 gate (`test/p3p4.gate.mts`, run against the `dist/` build, across the PluresDB exclusive-lock child boundary):

- **Direct `store.store([secretNode, cleanNode])`** →
  `{ written: 1, skipped: 0, refused: 1, refusedDetail: [{ id: "mem:direct:secret", reason: "secret", kind: "pem-private-key" }] }`
  - The secret node is **REFUSED**, the clean sibling is **WRITTEN**. The refusal is **reported**, never silently dropped.
- **`store.get("mem:direct:secret")` === null** (refused node truly never persisted); `store.get("mem:direct:clean")` is present.
- **Same-file, chunk-level proof via the shipped `sync()` path:** a session file with two oversized paragraphs → two chunks. Chunk 0 carries the secret (`AKIA…` + `BEGIN PRIVATE KEY`), chunk 1 is clean.
  - `mem:session:session-secret:0` (secret chunk) → **ABSENT** after sync (refused in the write path).
  - `mem:session:session-secret:1` (clean sibling chunk) → **WRITTEN**.
- **RECALL MISS:** querying the secret sentinel returns only clean nodes; no `AKIA` / `PRIVATE KEY` / secret-sentinel text ever comes back from `recall()`.
- **RECALL HIT:** the clean sibling chunk *is* recallable, and that recall set carries **no** secret material.

→ The redaction gate enforces at **chunk granularity**: a chunk containing secret material is refused *whole* (no partial/silent redaction — partial scrubbing would be a silent mutation), while clean sibling chunks in the same file are written and remain recallable.

### Was governance routed through native px, or a TS gate with documented absence? **Native px — DB-governed.**

Confirmed empirically against the binding (throwaway probes, since deleted):

- `pxInsertConstraint({ id, text })` (NL/text form) compiles but is forced to `severity:"warning"` → it would **detect but not block**. Rejected.
- `pxInsertConstraint` with a **pre-built structured Condition** `{ field:"has_secret", op:"field_eq", value:0 }` + `severity:"error"` **persists a real enforcing constraint as a CRDT node**, and then:
  - `pxOnAction({ metadata:{ has_secret:1 } })` **THROWS** `[CORE_INVALID_INPUT] action blocked by 1 constraint(s): [C-MEM-REDACT]…`
  - `pxOnAction({ metadata:{ has_secret:0 } })` returns `{ violations: [] }` (PASS).

So the **block/allow decision is made by the native `on_action` engine over a real persisted constraint**, not by a TS `if`. The TS layer's only job is to compute `has_secret` from chunk text and hand the metadata to `pxOnAction`.

**Honest boundary (documented, not a stub):** `pxLoadPxSource('constraint … { … }')` does **not** parse the redaction rule (the `.px` constraint grammar exposed to the binding doesn't accept this shape). Therefore the rule is declared via the **structured `pxInsertConstraint` API** (a real persisted CRDT constraint node enforced natively), *not* via `.px` source text. The governance is genuinely in-DB; only the *authoring surface* is the structured API rather than `.px` text. This boundary is called out in the code comment block at the top of `src/pluresdb.ts` (the "NATIVE GOVERNANCE" section).

### `detectSecret()` — the real detector (`src/redact.ts`)

`detectSecret(text): { has_secret: boolean; kind?: string; line?: number }`. Real patterns, no fakes:

| Class | Detection |
|---|---|
| PEM private keys | `-----BEGIN … PRIVATE KEY-----` armor |
| AWS access key id | `\b(AKIA\|ASIA\|AGPA\|AIDA\|AROA\|ANPA\|ANVA)[A-Z0-9]{16}\b` |
| GitHub tokens | classic `gh[posru]_[A-Za-z0-9]{36,}` + fine-grained `github_pat_…{60,}` |
| Google API key | `AIza[0-9A-Za-z\-_]{35}` |
| Slack | `xox[baprs]-…` |
| Stripe | `(sk\|rk)_(live\|test)_…{20,}` |
| OpenAI-style | `sk-(proj-)?[A-Za-z0-9_-]{20,}` |
| JWT | `eyJ….….…` three base64url segments |
| Azure account key | `AccountKey=[A-Za-z0-9+/]{40,}={0,2}` |
| Bearer token | `Authorization: Bearer …` / `bearer <token>` |
| Credential assignment | `(password\|secret\|api_key\|token\|aws_secret_access_key\|…) = <opaque value>` |
| High-entropy fallback | `looksLikeOpaqueSecret`: length ≥ 24, mixed char-class + Shannon-entropy gate; **pure-hex / sha excluded** so commit hashes & version strings don't false-positive |

**Calibration proof** (throwaway sanity, since deleted): 8/8 real secret shapes flagged; 0 false positives across ordinary prose, a 40-char sha, a code snippet, markdown, short strings, and a semver. The high-entropy gate is deliberately conservative (whole-chunk refusal is heavy, so the bar to trip it is high) to avoid eating legitimate memory.

### Where the gate runs (`src/pluresdb.ts`)

- `#ensureGovernance(db)` — declares `C-MEM-REDACT` once via structured `pxInsertConstraint` (idempotent upsert by id + a latch). **Fails CLOSED**: if the constraint can't be installed, the gate refuses writes rather than letting secrets through.
- `#gateWrite(db, id, data)` — runs `detectSecret` over the chunk's embeddable/snippet text → builds `{ action_type:"memory_write", metadata:{ has_secret:0\|1 } }` → calls native `pxOnAction`. A throw (or `violations` non-empty) → `{ allow:false, kind }`. Defense-in-depth: even if the native engine were somehow permissive, a positive `detectSecret` still refuses.
- `put()` — gates before `#writeNode`; refusal → returns `false`.
- `store()` — gates per node; refusals are counted and surfaced in the new `StoreWriteResult.refusedDetail` (`{ id, reason:"secret", kind }`).

New exported types (`src/api.ts`): `SkipReason`, `RefusedWrite`, `StoreWriteResult`, plus `detectSecret` / `SecretFinding`.

**`memory-capability.ts` note:** the SDK `sync()` returns `void`, so it cannot itself surface a refusal list; honest refusal reporting lives in `store.store()`'s return (which callers can inspect). `sync()` still *enforces* — proven by the chunk-level absence + recall-miss above.

---

## P3 — Reactive consolidation sweep (PULL/TICK, not push)

### Hard reality

The Node binding has **no push/reactive path**: a `put` does not auto-run a procedure, `subscribe()` is an id-only stub, and procedures aren't executable via the binding. So consolidation is a **PULL/TICK sweep**: idempotent `execIr` steps on the **single memoized handle**, invoked opportunistically by the lazy `sync()` path. **No background thread, no second handle, no self-firing timer** — any of which would break the native exclusive file lock.

### What `consolidate()` really does (`PluresLmStore.consolidate(opts?)` in `src/pluresdb.ts`)

Each step is a **real native op**, confirmed by probe and exercised by the gate:

1. **Interval guard (durable):** read the checkpoint via `agensStateGet`. If the last sweep was `< CONSOLIDATE_MIN_INTERVAL_MS` (60 s) ago and not `force`, return `{ ran:false, reason:"too-soon" }` — a cheap no-op so the per-search lazy `sync()` can call it for free.
2. **Scope:** `filter(category=="session")` + `aggregate(count)`. Zero → `{ ran:false, reason:"empty" }` (records the run so the guard still advances) — honest, not a fabricated result.
3. **Consolidate edges:** `auto_link(["category","temporal"], min_strength:0.5)` over the session set. Edges are deterministic (`edge::{from}::{to}`), so re-running **converges** (no duplication/explosion). This is the materialized associative structure.
4. **Salience:** `graph_pagerank(damping:0.85, iterations:50)` → top-ranked node ids (structural importance); `graph_clusters(algorithm:"louvain", min_size:2)` → community count. Both real; outputs summarized, never faked. Node payloads are **not** mutated with pagerank (it drifts each run → would create write churn); the salient ids live in the checkpoint instead.
5. **Durable checkpoint:** `agensStateSet("plures…oint", { lastRunEpoch, runs, edges, clusters, topRanked })` — bumps a **monotonic `runs` counter**; survives restart; feeds the next interval guard.

Returns `ConsolidateResult` (`{ ran, reason, edges, sessionNodes, clusters, topRanked, runs, checkpointEpoch }`), every field derived from a real `execIr` result.

**Opportunistic trigger:** `memory-capability.ts` `sync()` calls `store.consolidate({ force })` after `linkRecent`, wrapped so it never throws out of the write/search contract. Forced when the caller forces a sync; otherwise interval-guarded (free on the hot search path).

### Idempotency — proven this run

`consolidate({force:true})` called twice back-to-back (GATE P3):
- run1: `{ ran:true, edges:1, sessionNodes:2, clusters:1, runs:2 }`
- run2: `{ ran:true, edges:1, …, runs:3 }`
- **Edge count STABLE 1→1** (deterministic edges converge, no explosion).
- **Durable run counter incremented** 2→3 (`agensStateSet`/`agensStateGet` round-trip survives across calls).
- Store still healthy after consolidation (recall non-empty).

### What's ABSENT (honest — not stubbed)

- **Decay-by-eviction (DELETE of stale low-salience nodes):** intentionally **not** performed. This surface never calls native `delete` (the read+write+graph contract is augment-only), so true decay-by-removal is **deferred, not faked**. The monotonic `runs` counter is the durable age/decay signal a future eviction policy can build on.
- **`.px`-authored consolidation procedure:** procedures aren't executable via the binding, so the sweep is composed from first-class `execIr` IR steps (the real, available primitive), not a stored `.px` procedure.

---

## Native ops actually used

`execIr` steps: `filter`, `aggregate(count)`, `auto_link`, `graph_links`, `graph_pagerank`, `graph_clusters(louvain)`.
Governance: `pxInsertConstraint` (structured Condition, `severity:"error"`), `pxOnAction`.
Durable state: `agensStateSet` / `agensStateGet`.
All verified present in `index.d.ts` and exercised live (probes since deleted; gate exercises them on every run).

---

## Test / gate results (this run)

- `pnpm run build` → **exit 0**.
- `pnpm test` (`recall.gate.mts && p3p4.gate.mts`) → **ALL CHECKS PASSED**, exit 0.
  - recall GATE A (open real copy fixture), GATE B (seed→reopen→recall), GATE C (sync→reopen→recall sentinel) — **Path B + P1 NOT regressed**.
  - GATE P4 (C-MEM-REDACT blocks: refusal accounting + secret node absent + chunk-level sync absence + recall-miss; clean sibling written + recallable + no leak).
  - GATE P3 (consolidate runs via shipped path, formed edges, idempotent edge count, durable run-counter increment, store healthy after).

New / changed files (committed): `src/redact.ts`, `src/pluresdb.ts`, `src/memory-capability.ts`, `src/api.ts`, `test/p3p4-child.mts`, `test/p3p4.gate.mts`, `package.json`, this notes file. No `node_modules` / `.node` committed.

### No-stub attestation (C-NOSTUB-001)

Every claim above is backed by a real run on the built artifact. The secret detector is real regex+entropy logic; the block is enforced by the native `pxOnAction` engine over a real persisted constraint; the consolidation sweep runs real `execIr` graph ops with a durable `agensState` checkpoint. Absent items (decay-by-eviction, `.px`-text authoring of the rule, `.px` procedure execution) are reported as **absent**, not faked.
