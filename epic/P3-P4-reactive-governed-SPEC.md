# P3 + P4 — Reactive In-DB Consolidation & Constraint-Governed Writes (combined spike spec)

**Epic:** PluresLM Memory Superiority · **Children:** P3 (reactive consolidation), P4 (governed writes)
**Status:** DESIGN SPIKE — no production code. Does **not** modify Path B files.
**Date:** 2026-06-29 · **Author:** subagent (orchestrated)
**Why combined:** P3 and P4 both sit on the *same `.px`/agens runtime surface* of the
PluresDB handle (`px*` constraint methods + `agens*` reactive tables). Speccing them together
keeps the lock/lifecycle reality and the action-seam reality consistent across both.

**Grounding sources (read directly, signatures verified):**
- `node_modules/@plures/pluresdb-native/index.d.ts` (369 lines, 12 815 B) — **byte-identical**
  to the source crate `C:\Projects\pluresdb\crates\pluresdb-node\index.d.ts` (`Compare-Object`
  returned zero diffs), so the binding is in sync with source.
- `C:\Projects\pluresdb\crates\pluresdb-px\src\db\procedures.rs` — `evaluate` (l.97),
  `on_action` (l.142), `compile_nl` (l.213), `Violation` (l.34), `ActionBlocked` (l.47).
- `C:\Projects\pluresdb\crates\pluresdb-px\src\px\executor.rs` — `trait ActionHandler` (l.33),
  procedure-call dispatch (`execute_call` l.208).
- `C:\Projects\pares-agens\crates\core\src\headroom.rs` — `HeadroomActionHandler`,
  `impl ActionHandler` (l.59), `use pluresdb_px::px::executor::{ActionHandler, ExecutionError}`.
- Path B (read/write path being built on): `src/pluresdb.ts`, `src/memory-capability.ts`.

---

## 1. Native API — CONFIRMED present vs NAMED-but-ABSENT

The gap analysis names primitives as if they are **push / in-process reactive**
(`agensTimer`, `agensStateWatch`, `subscribe` -> "a write causes reactive procedure execution").
**The actual binding is PULL / tick-loop, not push.** Every design below is rebuilt around the
real surface. Where the gap analysis named an API that does not exist under that name, it is
flagged **ABSENT**.

### 1a. CONFIRMED present (exact signatures from index.d.ts)

| Method (JS) | Signature | Semantics (from the binding's own doc-comments) |
|---|---|---|
| `subscribe` | `subscribe(): string` | Returns a **subscription ID string only**. Doc: *"Full async subscription support requires additional async infrastructure."* **No callback parameter. No push delivery.** |
| `agensTimerSchedule` | `agensTimerSchedule(name, intervalSecs, payload): string` | Writes a recurring-timer **row** into the Agens timer table; returns the timer node id. Does **not** start an in-process timer thread. |
| `agensTimerDue` | `agensTimerDue(): Array<any>` | Returns timers whose `next_fire_at <= now`. Doc: *"Call this in a tick loop to process due timers."* **Caller must poll.** |
| `agensTimerReschedule` | `agensTimerReschedule(timerId): boolean` | Advances a timer's `next_fire_at` by one interval. Caller calls this after handling a due timer. |
| `agensTimerList` | `agensTimerList(): Array<any>` | `[{ id, name, intervalSecs, nextFireAt, payload }]`. |
| `agensTimerCancel` | `agensTimerCancel(timerId): boolean` | Deletes a timer row. |
| `agensStateGet` | `agensStateGet(key): any` | Read a reactive-state value (or `null`). |
| `agensStateSet` | `agensStateSet(key, value): void` | Write a reactive-state value; **auto-emits a `state_change` event** into the event log. |
| `agensStateWatch` | `agensStateWatch(sinceIso): Array<any>` | Returns `[{ key, value }]` for entries **updated since `sinceIso`**. A **PULL diff by timestamp**, not a callback watcher. |
| `agensEmit` | `agensEmit(event): string` | Append an event (`event_type` in message/timer/state_change/model_response/tool_result/praxis_*) to the in-DB event log; returns node id. |
| `agensEmitPraxis` | `agensEmitPraxis(event): string` | Idempotent emit (same `id` converges); for `praxis_*` lifecycle events. |
| `agensListEvents` | `agensListEvents(sinceIso): Array<any>` | Poll events after `sinceIso`, oldest-first. **Doc warns: O(n) over total store size — avoid high-frequency polling; advance `since_iso`.** |
| `pxEvaluate` | `pxEvaluate(ctx): any` | Evaluate `ctx` against persisted constraints; returns a JSON array of `Violation` (`{constraint, message}`). **Never throws** on violations (dry-run friendly). |
| `pxOnAction` | `pxOnAction(ctx): any` | Pre-action gate. Returns `{ violations: [...] }` (warning-severity only) when permitted; **THROWS** carrying `ActionBlocked` when any **error-severity** constraint fires. `ctx = { action_type, target, session_type, metadata }`. |
| `pxCompileNl` | `pxCompileNl(text, id): any` | Compile an NL rule -> `Constraint` and **persist** it (survives restart). |
| `pxLoadPxSource` | `pxLoadPxSource(text): any` | Parse `.px` via the **canonical** `pluresdb_px::px::parse` grammar; persist every `constraint` block (`require:` compiled via `compile_nl`, `severity:` honored). Returns `{ constraints:[ids], procedures:[names] }`. **Procedures reported but NOT persisted/executed by this call.** |
| `pxInsertConstraint` | `pxInsertConstraint(constraint): any` | Insert one constraint; accepts a full `Constraint` object **or** `{ id, text }` (text compiled via `compile_nl`). Persists. |
| `pxApplyCorrection` / `pxUndoCorrection` | `(text,id)->json` / `(id)->json\|null` | Reversible corrections (constraint add/remove). The "reversible governance" story. |
| `pxQueryGaps` | `pxQueryGaps(): any` | Evidence records with `Unknown` result (read from the seeded/default store — **not** persisted CRDT nodes). |
| `execDsl` / `execIr` | `execDsl(query): any` / `execIr(steps): any` | Run a procedure DSL string / JSON-IR step list -> `{ nodes, aggregate?, mutated? }`. How P1/P2 graph procedures run; **also how P3's sweep body runs** (sec 3). |
| `put` / `putWithEmbedding` / `get` / `delete` / `search` / `vectorSearch` / `stats` / `buildVectorIndex` | (as Path B uses) | The write/read primitives P0 already wired. |

### 1b. NAMED-but-ABSENT (do NOT design around these — they do not exist)

| Named in gap analysis / epic | Reality |
|---|---|
| **`agensTimer`** (bare) | **ABSENT.** No method named `agensTimer`. Only `agensTimerSchedule/Due/List/Cancel/Reschedule` exist, and they are a **pull tick-loop**, not a self-firing timer. |
| **`agensStateWatch` as a callback watcher** | **PARTIALLY ABSENT.** `agensStateWatch(sinceIso)` exists but is a **timestamp-diff pull**, not a registered change-callback. There is no `onStateChange(cb)`. |
| **`subscribe()` as in-process push** ("a write causes reactive procedure execution") | **ABSENT as described.** `subscribe()` returns a string id and explicitly notes async push is **not** implemented. **C-PLURES-004's "a write causes reactive procedure execution — not an external loop" is NOT achievable through the Node binding today.** A write does NOT auto-run a procedure in-process. |
| **In-process procedure registration / `AgensRuntime` exposed to JS / `on_action` callback** | **ABSENT.** `index.d.ts` exposes **no** procedure-registration, no `ActionHandler` binding, no `AgensRuntime` object. `on_action`/`evaluate` are reachable **only** as the synchronous `pxOnAction`/`pxEvaluate` *caller-invoked* methods. The doc mention of *"handlers registered in Rust"* (l.263) and `AgensRuntime::poll_events` (l.303) are **internal Rust** details, not a JS surface. |
| **`pxLoadPxSource` executing procedures** | **ABSENT.** It parses+persists **constraints**; procedures are *reported by name only*, not run. Procedure execution is `execDsl`/`execIr` (steps) — there is **no** binding that runs a named `.px` `procedure { ... }` block with `call`/`emit`/`loop` control flow (that needs the Rust `executor`, unexposed). |

> **Headline honesty for kbristol:** the epic's framing that PluresDB gives *push-based*,
> *write-triggered* in-DB reactivity is **not** what the Node binding delivers. The binding gives
> **durable reactive *state*** (timer rows, state table, event log, persisted constraints) that an
> **external tick must drive**. The win is still real (schedule/checkpoint/governance state lives
> *inside* the CRDT store, is replicatable, survives restart — memory-core spreads it across
> files+sqlite), but it is **"in-DB reactive state, externally ticked"**, not **"in-process
> reactive execution."** Designing P3 around a self-firing timer or a write-triggered procedure
> would be designing around a fictional API.

---

## 2. P3 — what the gap analysis assumed vs what we can actually build

**Assumed (epic/gap):** replace external cron with an `agensTimer` that *fires* the consolidation
procedure from inside the DB; optionally a `subscribe()` write-trigger so consolidation is
event-driven. "The store consolidates itself reactively from inside PluresDB."

**Reality:** the binding cannot self-fire and cannot push. So P3's honest shape is:

- **Move the *schedule and checkpoint state* into the DB** (`agensTimerSchedule` + `agensStateGet/Set`)
  so consolidation cadence + progress are **durable, replicatable CRDT state** rather than a cron
  line in `openclaw.json` + `memory/.dreams/` files. **This is the real, deliverable P3 win.**
- **Keep a thin external tick** that calls `agensTimerDue()` and runs the sweep body. The tick can
  be (a) the existing OpenClaw heartbeat, or (b) a piggyback on the lazy `reason:"search"` `sync()`
  the host already fires before every search (Path B already runs on that seam). **The cron
  *dependency* is removed; a *tick source* is still required** — but it is opportunistic, not a
  dedicated `0 3 * * *` job that blocks if absent.

This is a genuine improvement over memory-core's "external cron + best-effort subagent that
*blocks if no heartbeat*": our schedule/checkpoint survive in the store, the sweep is idempotent
and re-entrant, and **any** tick (search, heartbeat, manual) advances it — no single point of
scheduling failure.

---

## 3. P3 — reactive sweep design (`.px`-first, native only triggers it)

### 3.1 The sweep body is a procedure expressed as `execIr` steps (NOT a self-firing `.px` block)

Because named `.px` `procedure { call/loop/emit }` blocks are **not executable via the binding**
(sec 1b), the sweep body is expressed as the **procedure-step IR** that `execIr` *can* run
(`Filter/Sort/Limit/Project/Mutate/Aggregate/GraphNeighbors/GraphPagerank/GraphClusters/AutoLink/Merge`).
The **`.px`-first** principle is honored at the *design/spec* layer: the sweep is authored as a
declarative procedure (below, in `.px`-style pseudo-DSL for reviewability), and the runtime
**only triggers it** by feeding the compiled IR to `execIr`. The native does the data work; the
plugin holds no imperative consolidation logic beyond "tick -> run these steps."

**Authored intent (`.px`-style, the reviewable source of truth):**

```px
# memory.consolidate — structural dedup/promote/decay sweep.
# Triggered by an external tick when an agens timer is due; the body is pure
# procedure steps run via execIr. No imperative plugin logic.
procedure memory.consolidate {
  # (a) DEDUP: cluster near-identical memory chunks, keep the centroid, mark
  #     the rest superseded (Mutate sets superseded_by; never hard-delete here —
  #     deletion is a P4-governed action, see sec 5).
  filter(type == "memory-chunk")
    |> graph_clusters(min_similarity: 0.92)
    |> mutate(set: { superseded_by: "$cluster_centroid" }, where: "not_centroid")

  # (b) PROMOTE signal: structural importance via PageRank over the AutoLink graph
  #     (P1 builds the edges; P2 consumes this score). Writes an evidence field,
  #     does NOT itself promote — promotion is a P4-governed write (sec 5).
  filter(type == "memory-chunk")
    |> graph_pagerank()
    |> mutate(set: { structural_rank: "$pagerank" })

  # (c) DECAY: age out low-rank, unreferenced chunks by raising a decay counter
  #     (Mutate a decay field; actual eviction is governed, sec 5).
  filter(type == "memory-chunk" && structural_rank < 0.01 && last_seen < "$cutoff")
    |> mutate(set: { decay: "$decay + 1" })
}
```

**How it actually runs (plugin glue, no imperative consolidation logic):**

```
on tick (heartbeat OR lazy sync OR manual):
  due = db.agensTimerDue()                       // pull due timers
  for t in due where t.name == "memory.consolidate":
     last = db.agensStateGet("consolidate:checkpoint")   // durable checkpoint
     db.execIr(DEDUP_STEPS)                       // step (a) — native does the work
     db.execIr(PAGERANK_STEPS)                    // step (b)
     db.execIr(DECAY_STEPS)                       // step (c)
     db.agensStateSet("consolidate:checkpoint", { at: nowIso, swept: N })
     db.agensTimerReschedule(t.id)                // advance next_fire_at
     db.agensEmit({ event_type: "timer", id: "consolidate:"+nowIso }) // audit trail
```

> **Stub guard (C-NOSTUB-001):** steps (a)/(b)/(c) MUST run real `execIr` procedures over real
> nodes. If `execIr`/`GraphClusters`/`GraphPagerank` is unavailable at runtime, the sweep must
> **no-op honestly and report "consolidation unavailable"**, NOT fabricate a checkpoint or claim
> work it didn't do. (Same posture Path B took for the embedder in DEF-PATHB-1.)

### 3.2 What triggers it

- **Primary trigger:** the lazy `reason:"search"` `sync()` Path B already runs before each search.
  Add a cheap `agensTimerDue()` check there; if `memory.consolidate` is due, run the sweep *after*
  serving the current search (never block recall on consolidation). Consolidation becomes
  **opportunistic and free** of a dedicated scheduler.
- **Secondary trigger:** the OpenClaw heartbeat (already periodic) calls the same tick. Either
  trigger advancing the timer is fine — the checkpoint makes it idempotent.
- **NOT a trigger:** a write does not auto-run the sweep (sec 1b: no push). "Event-driven on write"
  from the gap analysis is **not deliverable**; the closest honest equivalent is "the next
  search/heartbeat after a write picks it up," which the lazy-sync trigger gives.

### 3.3 Why this is still superior to memory-core's cron+heartbeat

- Schedule + checkpoint are **durable CRDT state** in the one store (replicatable, survives
  restart, no `memory/.dreams/` sidecar files).
- **No single scheduling SPOF:** memory-core's nightly cron *blocks if no heartbeat*; ours advances
  on *any* tick (search, heartbeat, manual), and a missed tick just defers — the timer row +
  checkpoint guarantee at-least-once eventual execution without double-work.
- The structural passes (dedup via clusters, rank via PageRank) need **no LLM turn** — only the
  optional narrative diary does. memory-core's deep phase needs a subagent LLM turn.

---

## 4. P3 — exclusive-lock & lifecycle reality

**The single-handle exclusive file lock (Path B's hard constraint) is COMPATIBLE with the sweep —
*because there is no second thread.***

- Path B memoizes **one** `PluresDatabase` handle per `dbPath` (process-local singleton;
  `pluresdb.ts` `PluresLmStore.#instances`). The native holds an **exclusive file lock** per
  `dbPath` — a second handle would deadlock/throw.
- The sweep design adds **NO new handle and NO background thread.** `agensTimerDue()`,
  `execIr(...)`, `agensStateSet(...)`, `agensTimerReschedule(...)` are all **synchronous calls on
  the SAME memoized handle**, invoked from the SAME single-threaded event-loop tick (the lazy
  `sync()` or heartbeat). The lock is never contended.
- **This is only safe *because* the binding is pull/tick (sec 1).** Had `agensTimer` self-fired on
  a native background thread (the fictional API), it would either need its **own** handle (lock
  violation) or concurrent access to the single handle (data race). The pull model sidesteps both:
  reactivity is durable *state*, execution is *cooperative* on the one owning thread.
- **Re-entrancy:** the lazy-sync trigger fires inside a `search()` path. The sweep must run **after**
  the search result is returned (defer to `queueMicrotask`/next tick), so a long `execIr` never
  stalls recall latency, and two overlapping ticks can't double-run (guard with a process-local
  `sweepInFlight` boolean + the durable checkpoint timestamp).
- **Operator note:** because everything is one handle/one thread, a crashed/blocked sweep cannot
  corrupt the lock — worst case the checkpoint isn't advanced and the next tick retries. Strictly
  safer than memory-core's multi-file `.dreams/` + sqlite + `MEMORY.md` spread.

---

## 5. P4 — action seam + constraints (`.px`-first)

### 5.1 How `pxOnAction` + `pxInsertConstraint`/`pxLoadPxSource` + `pxCompileNl` compose

The seam is a **caller-invoked synchronous pre-write gate** (confirmed against
`procedures.rs::on_action` l.142 and `index.d.ts::pxOnAction`):

1. **Declare** the rule once (idempotent, persisted, survives restart) via either:
   - `pxLoadPxSource('constraint <id>: require: <pred> severity: error')` — preferred, `.px`-first,
     loads many at once through the canonical grammar; or
   - `pxInsertConstraint({ id, text })` / `pxCompileNl(text, id)` for a single rule.
   - **`compile_nl` (procedures.rs l.213) is the REAL structured-predicate compiler** — CONFIRMED.
     It parses `field <op> value` via the canonical `.px` expression grammar into an enforcing
     `Condition` AST (e.g. `amount <= 100` genuinely blocks `amount = 500`), with a narrow
     documented NL keyword fallback and an **honest `UNPARSED_MARKER`** for text it cannot compile
     (it enforces nothing **and announces that** — never a fake pass-through; C-NOSTUB-001
     compliant). It is **not** a stub.
2. **Gate** every memory write: *before* `put`/`putWithEmbedding`/promotion, the write path calls
   `pxOnAction(ctx)` with `ctx = { action_type, target, session_type, metadata }`.
   - Permitted -> returns `{ violations }` (warnings only, may be empty) -> proceed to `put`.
   - Blocked -> `pxOnAction` **throws** (`ActionBlocked` with the violating constraints) -> the
     write path **must not `put`** and must surface the block honestly ("write refused by
     constraint X"), reversible because the constraint can be `pxUndoCorrection`'d.
3. **Audit/reverse:** every constraint is a CRDT node; `pxApplyCorrection`/`pxUndoCorrection` give
   reversible, explainable governance. `pxEvaluate` (non-throwing) gives a *dry-run* "what would
   block?" report — a real **shadow mode** (mirrors memory-core's report-only trial, but ours is a
   *real* gate the moment it is promoted from `pxEvaluate` to `pxOnAction`).

> **Key seam fact:** `pxOnAction` is **NOT** triggered by a `put`. It does **not** auto-fire on
> writes (sec 1b — no push). The memory write path must **explicitly call `pxOnAction` first**,
> then `put`. P4 is a *disciplined caller-side gate*, not a DB-internal trigger. This is the real
> before-promotion gate memory-core lacks — but its enforcement depends on the plugin **always**
> routing writes through the gate (so the gate call belongs in the one chokepoint:
> `PluresLmStore.put`/`store` in `pluresdb.ts`, where every memory mutation already funnels).

### 5.2 Action shapes memory writes present, and the constraints that guard them

Map each memory mutation to an `AgentContext` shape, then guard with declarative constraints.
The write path already builds rich payloads in `memory-capability.ts::sync` (`content, category,
type, source, path, hash, size, ...`); P4 lifts the governing-relevant fields into `metadata`:

| Memory action | `action_type` | `target` | key `metadata` fields | Guarding constraints (`.px`) |
|---|---|---|---|---|
| Ingest a chunk (`sync` put) | `memory_write` | node id (`mem:...`) | `source`, `category`, `size`, `has_secret` | **`C-MEM-REDACT`** (block if `has_secret == 1`), `C-MEM-SIZE` (block oversize) |
| Promote chunk -> long-term | `memory_promote` | node id | `structural_rank`, `confidence`, `source` | `C-MEM-PROMO` (require `structural_rank >= 0.2`) |
| Redact / overwrite content | `memory_redact` | node id | `reason`, `actor` | `C-MEM-REDACT-OWNER` (require a non-empty `actor`) |
| Decay/evict (hard delete) | `memory_evict` | node id | `decay`, `structural_rank`, `pinned` | `C-MEM-PIN` (block evict if `pinned == 1`), `C-MEM-EVICT` (require `decay >= 5`) |

**`.px` constraint source (declarative, auditable, the P4 deliverable artifact):**

```px
# memory-governance.px — loaded once at plugin init via pxLoadPxSource.
# Each block compiles to a real enforcing Condition (compile_nl) and persists
# as a CRDT node; severity:error means pxOnAction THROWS and the write is refused.

constraint C-MEM-REDACT:
  when:    action_type == "memory_write"
  require: has_secret == 0
  severity: error
  fix: "Redact secret material before writing it to long-term memory."

constraint C-MEM-PROMO:
  when:    action_type == "memory_promote"
  require: structural_rank >= 0.2
  severity: error
  fix: "Only promote structurally-central memories (PageRank-backed)."

constraint C-MEM-PIN:
  when:    action_type == "memory_evict"
  require: pinned == 0
  severity: error
  fix: "Pinned memories are never auto-evicted; unpin explicitly first."
```

> **Honesty note on the grammar:** the structured-predicate path supports `field <op> value`
> comparisons (`==`, `<=`, `>=`, `<`, `>`). A *compound* `require` (two predicates AND-ed, e.g.
> `structural_rank >= 0.2 AND confidence >= 0.6`) must be verified against the canonical grammar
> before relying on it — if conjunction is not supported in a single `require:`, express it as
> **two constraints** with the same `when:` (both must pass), which is equivalent and definitely
> supported. Do **not** assume compound predicates compile; confirm against
> `parse_structured_predicate` in `procedures.rs` during P4 implementation.

### 5.3 Single most valuable rule to enforce FIRST

**`C-MEM-REDACT` — block writing a chunk flagged `has_secret == 1`.** Rationale: it is the only
rule whose *absence* is a **data-exfiltration / leakage** risk (AGENTS.md: "Don't exfiltrate
private data. Ever."), it is dead-simple to express (`has_secret == 0`, a single comparison the
grammar definitely supports), it exercises the entire seam end-to-end (declare -> gate -> throw ->
honest refusal), and memory-core has **no** equivalent pre-write secret gate. The `has_secret`
signal can start coarse (regex for key/token/password patterns in the chunk, computed in `sync`)
and tighten later; the *gate* is the durable, auditable, reversible part. Ship this one rule, prove
the seam, then layer `C-MEM-PROMO`/`C-MEM-PIN` on the identical mechanism.

---

## 6. P4 <-> Headroom overlap (so they do not reinvent each other)

**They use DIFFERENT `.px` seams. This is the critical finding — they are NOT the same handler.**

| | P4 governed writes | Headroom |
|---|---|---|
| `.px` seam | **Constraint evaluation** — `on_action`/`evaluate` (`procedures.rs`), exposed to JS as `pxOnAction`/`pxEvaluate`. | **Procedure-call dispatch** — `trait ActionHandler` in `px/executor.rs` (l.33); `HeadroomActionHandler` `impl ActionHandler` (l.59). A `.px` procedure's `call <action>(...)` is routed to a registered handler. |
| What it does | **Decides yes/no** on an action (declarative invariants block writes). | **Performs** a side-effecting action (token counting, compression) when a procedure calls it. |
| Node-binding reachability | **Reachable** — `pxOnAction`/`pxEvaluate`/`px*` are all in `index.d.ts`. | **NOT reachable from the Node binding today** — `index.d.ts` exposes **no** `ActionHandler`, no procedure-registration, no executor entry point. `HeadroomActionHandler` is a **Rust-side** impl used by pares-agens's Rust executor, not callable from JS via `@plures/pluresdb-native`. |
| Direction of control | Caller -> `pxOnAction` -> verdict (synchronous gate). | Procedure (run by the Rust executor) -> `call` -> `ActionHandler::handle` (side effect). |

**Implications for the epic:**

1. **No code overlap to share at the seam level.** P4 cannot "reuse `HeadroomActionHandler`" and
   Headroom cannot "reuse the `pxOnAction` gate" — they are different traits/entry points. The
   overlap is **conceptual** ("both are `.px`-governed"), not implementational.
2. **Headroom needs a Node-binding decision the gap analysis glossed over.** Because the
   `ActionHandler`/executor path is **unexposed in `@plures/pluresdb-native`**, porting Headroom
   into the *pluresLM plugin* (option (a): "a capability the plugin invokes for memory-write
   compression") would require **either** (i) a new native binding that exposes the procedure
   executor + handler registration (net-new native work — flag this in the H-headroom spike),
   **or** (ii) reimplementing Headroom's token-counting/compression in TS as a plain plugin module
   that the write path calls directly (no `.px` executor involved). The pares-agens Rust
   `HeadroomActionHandler` is reusable **only** inside a Rust host that drives the executor — i.e.
   option (b) "standalone OpenClaw context-compression hook" if that hook runs Rust, not the JS
   plugin path.
3. **Where they genuinely align:** both should be **declared/loaded as `.px`** and both should
   write **observability into the same agens state/event tables** (Headroom already uses a PluresDB
   `StateStore` per `headroom_bridge.rs`; P4 uses `agensStateSet`/`agensEmit`). So the *governance
   surface* (where rules live, where audit lands) is shared even though the *enforcement seam* is
   not. Keep both writing audit to the one CRDT store -> a single replayable governance log.
4. **Recommendation:** P4 proceeds **independently** on the confirmed `pxOnAction` seam now; the
   Headroom port's seam question (native executor binding vs TS reimpl) is owned by the
   **H-headroom spike**, which must NOT assume the `ActionHandler` path is callable from JS.
   Cross-reference this section from `epic/H-headroom-port-SPEC.md` so the two specs stay
   consistent.

---

## 7. Risks / stubs-to-avoid

- **R1 (the big one) — designing around a fictional reactive API.** The gap analysis's
  "write-triggered in-DB reactive procedure execution" (push) does **not** exist in the binding
  (sec 1b). Building P3 as if `agensTimer`/`subscribe` self-fire would produce a **stub that looks
  reactive but never runs** (the worst kind per the NO-STUBS gate — invisible until production).
  Mitigation: P3 is explicitly "durable reactive state + opportunistic external tick." Every claim
  of "reactive" in shipped docs/PRs must say "externally ticked," not "self-firing."
- **R2 — `execIr` running named `.px` procedures.** `pxLoadPxSource` does **not** execute
  procedures (sec 1b). The sweep body MUST be authored as IR steps for `execIr`, not as a named
  `procedure {}` block that nothing runs. A `procedure {}` block loaded and never executed is a
  silent stub. Mitigation: keep the `.px` procedure as the *reviewable spec*; ship the compiled IR;
  add a test that the IR actually mutates nodes (build-the-binary/run-the-binary, not a parse check).
- **R3 — compound `require:` predicates may not compile.** `C-MEM-PROMO`'s ideal
  `structural_rank >= 0.2 AND confidence >= 0.6` assumes conjunction in one `require:`; that is
  **unconfirmed** (sec 5.2). Mitigation: split into two same-`when:` constraints, or verify
  `parse_structured_predicate` supports `&&`/`AND` before relying on it. Never assume; confirm.
- **R4 — `pxOnAction` bypass.** The gate only works if **every** memory mutation routes through it.
  If any future write path calls `db.put` directly (skipping `PluresLmStore.put`), governance is
  silently bypassed. Mitigation: make `pxOnAction` the first line of the single `#writeNode`
  chokepoint in `pluresdb.ts`; add a constraint/test that asserts no other module imports the raw
  native `put`. (Mirror ADR-0010's "fix once at the chokepoint" discipline.)
- **R5 — `agensListEvents`/state-watch O(n) polling.** The binding's own doc warns event/state
  polling is O(total store size). A tick that calls `agensListEvents` every search on a large store
  is a perf foot-gun. Mitigation: the sweep uses `agensTimerDue()` (bounded to timer rows) +
  `agensStateGet(checkpoint)` (single key), NOT `agensListEvents` on the hot path; reserve event
  polling for low-frequency audit/diary passes and always advance `since_iso`.
- **R6 — embedder/`execIr` unavailability faked as success.** Same class as DEF-PATHB-1. If a
  structural step can't run, report "unavailable" and skip — never write a checkpoint claiming a
  sweep that didn't happen, never fabricate a `structural_rank`. Honest absence over hollow shell.
- **R7 — Headroom assumed JS-callable.** (sec 6.) Do NOT spec the Headroom port as "plugin invokes
  `HeadroomActionHandler`" — that handler is not in the Node binding. Decide TS-reimpl vs new
  native binding explicitly in the H spike.

---

## 8. Implementation gating (per epic orchestration + AGENTS.md)

- **Design now (this spec): done.** No production code; Path B files untouched.
- **Implement after P0 verify-green**, gated dev-lifecycle each (analyze->implement->test->qa->verify):
  - **P4 first within this pair** (smaller, self-contained, immediate safety value): land
    `C-MEM-REDACT` + the `pxOnAction` chokepoint, prove block-on-secret end-to-end on the binary.
  - **P3 second**: timer-row + checkpoint + `execIr` sweep wired to the lazy-sync/heartbeat tick;
    depends on P1's `AutoLink` edges existing for the PageRank/cluster steps to be meaningful (so
    P3's *full* value trails P1, but the dedup-by-content + decay-counter portions can land before
    P1 graph edges).
- **memory-core stays the fallback** throughout (augment-then-replace); neither P3 nor P4 disables
  it until proven.
