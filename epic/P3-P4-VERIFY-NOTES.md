# P3 + P4 — VERIFY stage notes (EPIC-MEMORY-SUPERIORITY)

**Worktree:** `C:\Projects\plureslm-openclaw-p3p4` · branch `feat/p3p4-reactive-governed`\n**Stage:** VERIFY — the FINAL gate for P3+P4 **and the last stage of the whole memory epic** (loop-closer).
**Scope:** prove BOTH capabilities deliver real end-to-end value the way a **consumer** actually uses them, **channel-agnostic** (C-TEST-002): drive the SHIPPED `MemorySearchManager` via
`buildMemoryCapability(cfg).runtime.getMemorySearchManager({cfg,agentId})` → `manager.sync()` / `manager.search()` — against the real SDK contract (`memory-state-Bjyq6ufc.d.ts`: `MemorySearchManager.search(query,opts?)` / `sync(params?)` / `status()`). **NO chat adapter, NO mock, NO reaching into private store state for the safety assertions** (the never-recalled proof is made purely from `manager.search()` snippets/paths). Write-accounting + the consolidation checkpoint use the shipped `PluresLmStore` (public `api.js` barrel) — the SAME memoized handle, never a second native lock.

Every store-touching phase runs in its **own process** (`test/p3p4-verify-child.mts`), so every durability claim is reproduced across a genuinely **FRESH process**, not a reused handle.

---

## 0. Headline verdicts

- **(a) C-MEM-REDACT end-to-end — secret-block verdict incl. the secondary-field case: PASS.** A realistic batch (clean + secrets in `content` / a SECONDARY field `value` / multiline PEM in `note` / AWS 40-char secret in `body`) was synced through the shipped `manager.sync()`. In a **fresh process**, `manager.search()` proved **every** credential-bearing node is **NEVER recalled** (not by id, not as a snippet), the **raw secret string NEVER appears in any snippet** (per-probe AND under a broad catch-all query), and the **secondary-field case** (the bug QA found+fixed) is explicitly refused + never recalled — while the **clean memory IS recalled**. Write-accounting from `store.store()`: each secret node `{written:0, refused:1}` with the correct `kind`; clean node `{written:1, refused:0}`.
- **(b) Consolidation durable + idempotent verdict: PASS.** 24 same-session memories → **276 edges = the complete same-session graph (24×23/2 = 276)**, **STABLE across all 6 forced sweeps** (idempotent, bounded, no runaway), run counter **monotonic 2→7**, checkpoint **DURABLE across a fresh process** (reopen → run **8** = prior **7** + 1, edges still **276**). Tied to **observable value**: associative recall returns **23 graph neighbors** of a direct hit — before AND after the restart.
- **(c) Full-suite result on my own run: PASS.** `pnpm run build` exit 0; `pnpm test` (recall.gate + p3p4.gate + p3p4-hardened.gate + p3p4-qa.gate + **new p3p4-verify.driver**) → **ALL CHECKS PASSED, exit 0**; `vitest run` → **6 passed, exit 0** (was 5; my VERIFY mirror is the 6th); `tsc --noEmit` exit 0.
- **(d) Durability across restart: PASS.** The secret-block is re-verified in the FRESH recall process (nodes still absent, still never recalled); the consolidation checkpoint is re-verified in the FRESH reopen process (run counter advanced, edges stable). Both survive a process restart.
- **(e) PULL/TICK honesty: STATED.** P3's "reactive" sweep is **PULL/TICK, not push**. The Node binding has **no push/reactive path** — a write does NOT auto-run a procedure, `subscribe()` is an **id-only stub**, procedures aren't executable via the binding. The sweep is invoked **opportunistically from `sync()`** (forced when the caller forces a sync; otherwise interval-guarded). This is **NOT** event-driven reactivity and is reported as such. No claim of self-firing/event-driven behavior is made anywhere in this gate.

---

## 1. PROOF 1 — C-MEM-REDACT end-to-end (the headline safety proof)

**The realistic batch (`test/p3p4-verify-child.mts`, `probes[]`).** Five memories a user might try to persist, each written as its own session file and ingested through the shipped `manager.sync({sessionFiles})`; the SAME shapes are replayed through `store.store()` to capture the `{written,skipped,refused}` accounting the void `sync()` surface cannot return. Secret material uses canonical PUBLIC doc placeholders (non-functional) matching the detector's real regex shapes:

| probe | secret field | benign `content`? | raw secret |
|---|---|---|---|
| clean | (none) | — | — (no secret) |
| secret-in-content | `content` | no (secret is in content) | GitHub `ghp_…` |
| **secret-in-secondary-field** | **`value`** | **yes** | **AWS `AKIA…`** ← the QA-fixed bug |
| secret-multiline-PEM | `note` | yes | full `-----BEGIN RSA PRIVATE KEY-----` block |
| secret-aws-40char | `body` | yes | AWS 40-char `wJalrXUtnFEMI/…EXAMPLEKEY` |

### Per-field write-accounting (from `store.store()`, evidence the gate refuses where the secret lives)

```
clean              -> {written:1, skipped:0, refused:0}  persisted=true   detectorFlagsField=false
secret-in-content  -> {written:0, skipped:0, refused:1}  persisted=false  kind=github-token          detectorFlagsField=true
secret-in-value    -> {written:0, skipped:0, refused:1}  persisted=false  kind=aws-access-key-id      detectorFlagsField=true
secret-in-note(PEM)-> {written:0, skipped:0, refused:1}  persisted=false  kind=pem-private-key        detectorFlagsField=true
secret-in-body(AWS)-> {written:0, skipped:0, refused:1}  persisted=false  kind=credential-assignment  detectorFlagsField=true
```

Every credential node is **REFUSED** (`refused:1`, `get()===null`) with a correct `kind`; the clean node is **WRITTEN** (`written:1`, `get()!==null`). The refusal is **reported**, never silently dropped. `detectorFlagsField=true` on each confirms the secret is independently detectable in the exact field it was placed.

### Never-recalled proof (FRESH process, purely from `manager.search()`)

In a separate process (`redact-recall`), `manager.search(<each probe's distinctive query>, {maxResults:10})`:

```
secret-in-content     -> secretInSnippet=false  idRecalled=false  persisted=false
secret-in-value       -> secretInSnippet=false  idRecalled=false  persisted=false   ← secondary-field case
secret-multiline-PEM  -> secretInSnippet=false  idRecalled=false  persisted=false
secret-aws-40char     -> secretInSnippet=false  idRecalled=false  persisted=false
clean                 -> recalled=true (round-trips: by id mem:vrfy:clean AND the chunk mem:session:clean:0)
broad catch-all query -> anySecretAnywhere=false   (no AKIA / AWS-40 / ghp_ / "BEGIN RSA PRIVATE KEY" in ANY snippet)
```

- **Credential chunks NEVER recalled** — neither by node id (`idRecalled=false`) nor as snippet text (`secretInSnippet=false`).
- **Raw secret NEVER surfaces** — proven per-probe AND under a broad `"credentials key token runbook deploy"` query that could surface any chunk (`anySecretAnywhere=false`).
- **Clean memory IS recalled** — the round-trip works, so the gate is not just "block everything".
- **Secondary-field case is first-class** — the `value`-field AWS secret behind a benign `content` (the exact evasion QA fixed) is refused + never recalled, asserted explicitly.

> This is the proof that **the live memory store cannot be made to persist+leak a secret** through the shipped consumer write/recall path — including the secondary-field shape that previously evaded the gate.

---

## 2. PROOF 2 — consolidation real value (bounded + idempotent + durable)

**Seed (`consolidate-seed`):** 24 same-session memories on a cohesive topic ("kraken deploy runbook failover") ingested via the shipped `manager.sync({force:true})` (which chunks → writes → links → opportunistically consolidates). Then the shipped `store.consolidate({force:true})` (the SAME method `sync()` invokes) is called 6× to exercise idempotency.

```
sweep 1: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:2}
sweep 2: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:3}
sweep 3: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:4}
sweep 4: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:5}
sweep 5: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:6}
sweep 6: {ran:true, reason:"forced", edges:276, sessionNodes:24, clusters:1, runs:7}
```

- **(a) Bounded graph:** `edges = 276 = 24×23/2` = the **complete** same-session graph (every same-session/same-category pair linked by `auto_link(category,temporal)`). Asserted `edges ≤ N(N-1)/2` — deterministic and bounded, **NOT** a runaway "N²-of-everything" explosion.
- **(b) Idempotent across repeated sweeps:** edge count **STABLE at 276 across all 6** (deterministic `edge::{from}::{to}` keys converge on re-run); run counter **monotonic 2→7**; every sweep `ran:true`.
- **(c) Durable checkpoint across a FRESH process (`consolidate-reopen`):** reopen the same dbPath in a new process → one more `consolidate({force})` reads the durable checkpoint and returns `runs:8` (= prior 7 + 1) with `edges:276` (unchanged). `runCounterAdvanced=true`, `edgesStable=true`.
- **Observable value (not just a counter):** associative recall — `store.neighbors(<top hit>, 1, 0.5)` returns **23 neighbors** (the edges consolidation/link-on-write materialized), so a direct hit pulls in the other memories written alongside it. The neighbor count is **23 before AND after** the process restart — the structure persisted, not just a number.

---

## 3. PROOF 3 — no regression of the rest (full suite on my own run)

```
pnpm run build                 -> exit 0
pnpm test:
  recall.gate.mts              -> RESULT: ALL CHECKS PASSED
  p3p4.gate.mts                -> RESULT: ALL CHECKS PASSED
  p3p4-hardened.gate.mts       -> HARDENED RESULT: ALL CHECKS PASSED
                                   CONFUSION MATRIX (detection): TP=11 FP=0 TN=7 FN=0 | secretLeaks=0 | cleanRecalled=7/7
  p3p4-qa.gate.mts             -> QA REGRESSION RESULT: ALL CHECKS PASSED
  p3p4-verify.driver.mts       -> P3+P4 VERIFY RESULT: ALL CHECKS PASSED   (new this stage)
  => pnpm test exit 0
vitest run                     -> Test Files 1 passed; Tests 6 passed (was 5; VERIFY mirror is the 6th); exit 0
tsc --noEmit                   -> exit 0
```

The recall GATE A/B/C/D, the P3/P4 gate, the hardened adversarial matrix, and the QA regression gate ALL still pass alongside the new VERIFY gate — no regression introduced.

---

## 4. PROOF 4 — durability + determinism across a process restart

Both safety-critical claims are re-asserted in a FRESH process (the native exclusive lock is released between phases, so each reopen is a true restart):

- **Secret-block survives restart:** the `redact-recall` phase is a separate process from `redact-write`. After the restart the refused nodes are still absent (`get()===null`) and still never recalled (`idRecalled=false`, `secretInSnippet=false`). A refused secret stays refused across restart — there is no "write now, leak after reopen" path.
- **Consolidation checkpoint survives restart:** the `consolidate-reopen` phase is a separate process from `consolidate-seed`. The durable `agensState` checkpoint round-trips (run counter 7→8, edges stable 276), and associative recall (23 neighbors) still works. Deterministic: the same inputs produce the same 276-edge complete-graph and the same monotonic counter behavior on every run.

---

## 5. Honesty — PULL/TICK, not push (explicit boundary)

P3's "reactive consolidation" is a **PULL/TICK sweep**, **not** event-driven/push reactivity:

- The `@plures/pluresdb-native@2.0.0-alpha.1` Node binding has **no push/reactive path**. A `put`/write does **NOT** auto-run a procedure. `subscribe()` is an **id-only stub** (returns a subscription id; nothing fires). Procedures are not executable via the binding.
- Therefore consolidation runs as idempotent `execIr` steps on the **single memoized handle**, invoked **opportunistically from the lazy `sync()` path** (forced when the caller forces a sync; otherwise guarded by a 60 s interval read from the durable checkpoint so the hot search path can call it for free). **No background thread, no second handle, no self-firing timer** — any of which would break the native exclusive file lock.
- This gate makes **no** claim of event-driven reactivity. "Reactive" here means "the consolidation sweep is reached as a side effect of the normal write/search tick", which is exactly what was verified.

Nothing in PROOF 1–4 was faked: no recall miss was manufactured (every "never recalled" is a real `manager.search()` returning no such hit/snippet), no block was fabricated (every refusal is a real `store.store()` `refused:1` + `get()===null`), and the absent push path is reported as absent rather than simulated.

---

## 6. What I added / changed (all real, no stubs, no weakened assertions)

**No shipped/source change** — VERIFY only consumes the already-shipped, QA-hardened surface. Added test-only files + wiring:

- `test/p3p4-verify-child.mts` — per-phase worker (`redact-write` / `redact-recall` / `consolidate-seed` / `consolidate-reopen`) driving the shipped manager boundary; each store-touching phase in its own process.
- `test/p3p4-verify.driver.mts` — orchestrates the phases across fresh processes and self-asserts all four proofs (exits non-zero on any breach). The headline safety/value claims are explicit checks.
- `test/recall.gate.test.ts` — added a 6th vitest mirror that spawns the VERIFY driver, asserts exit 0, and pins the secondary-field-never-recalled / no-secret-in-any-snippet / clean-recalled / checkpoint-durable claims.
- `package.json` — `test` chain now includes `test/p3p4-verify.driver.mts`; added `test:p3p4-verify`.

No `node_modules` / `.node` / `dist` committed. No stubs (C-NOSTUB-001). No existing assertion weakened or removed.

---

## 7. Answers to the VERIFY brief

- **(a) End-to-end secret-block verdict incl. the secondary-field case (never recalled?):** **PASS.** All 5 probes refused-or-clean exactly as expected; the secondary-field (`value`) AWS secret behind a benign `content` is refused (`get()===null`, `refused:1`, kind `aws-access-key-id`) and **never recalled** in a fresh process (`idRecalled=false`, `secretInSnippet=false`); no raw secret in any snippet under any query; the clean memory IS recalled.
- **(b) Consolidation durable + idempotent verdict:** **PASS.** 24 nodes → 276 edges (complete same-session graph, bounded), STABLE across 6 sweeps, run counter 2→7 then DURABLE 7→8 across a fresh reopen, edges still 276, associative recall = 23 neighbors before and after restart.
- **(c) Full-suite result on my own run:** **PASS.** build exit 0; `pnpm test` (5 gates incl. the new VERIFY driver) ALL CHECKS PASSED exit 0; `vitest run` 6 passed exit 0; `tsc --noEmit` exit 0.
- **(d) Durability across restart:** **PASS.** Secret-block and consolidation checkpoint both re-asserted in fresh processes after restart.
- **(e) PULL/TICK boundary statement:** **STATED honestly.** P3 is PULL/TICK (opportunistic from `sync()`); the JS binding has no push path (`subscribe()` id-only stub, no procedure execution, no auto-run-on-write). No event-driven reactivity is claimed.

**VERIFY gate: PASS.** Both P3 (PULL/TICK consolidation: bounded, idempotent, durable across restart, observable associative recall) and P4 (.px-governed write redaction: realistic batch end-to-end — every credential field including the secondary-field case refused + never recalled + never leaked in a snippet, clean memory recalled) deliver real consumer-boundary value, proven on my own invocation across fresh processes, with the full regression suite green. EPIC-MEMORY-SUPERIORITY loop closed.
