# ADR-0005: Dreaming — self-contained background memory consolidation for PluresLM

- **Status:** Accepted — implemented in feature/dreaming (Reflect/Dream-Diary phase deferred — no LLM-invocation bridge exists in this codebase yet)
- **Date:** 2026-08-04
- **Scope:** `plureslm-openclaw` plugin — a native "Dreaming" capability that is self-contained
  (does not depend on OpenClaw memory-core internals, its cron job, or its `.dreams/` file format)
- **Decision:** Build Dreaming as an extension of the P3 reactive-consolidation sweep
  (`PluresLmStore.consolidate()`) already shipped in this repo, not as a port of memory-core's
  file-based Light/Deep/REM pipeline. Add a `learning_candidates` staging tier (closing GH #62184),
  a `promote-explain`-equivalent transparency tool (closing the "silent noise filter" complaint),
  and loud, queryable status (closing the "Dreaming status: blocked" complaint and satisfying
  GH #61936's ask that dreaming work for external memory-slot plugins).

## 1. Problem statement

ADR-0002 §17-18 (P3 in the hardening backlog) already names the gap plainly: *"no equivalent full
CLI/operator surface for deep status/fix/index/promotion/dreaming... Keep memory-core as the
fallback until these gaps are deliberately accepted or closed."* This ADR closes the *dreaming*
half of that gap.

Three concrete external facts make this urgent rather than aspirational:

1. **GH #61936 ("Allow dreaming with external memory slot plugins")** is an open upstream OpenClaw
   issue confirming Dreaming is hard-wired to `memory-core`'s cron job, `.dreams/` file format, and
   `MEMORY.md` promotion target. When an external plugin (us) owns the memory slot, Dreaming is
   **totally unavailable** — not degraded, absent. This is our exact deployed configuration
   (`plugins.slots.memory = "plureslm"`, ADR-0002 §"Preferred: service client plugin").
2. **GH #62184** identifies a real design gap even within memory-core's own model: promotion is
   binary (durable-in-MEMORY.md or nothing). There is no lightweight staging tier for "the user
   corrected this once" or "this looks like an emerging pattern but isn't proven yet." Users want a
   middle tier between raw daily notes and a promoted durable rule.
3. **Real operator complaints** ("Dreaming status: blocked" with no visible cause; "burns tokens
   without impact" / "nothing got promoted... seems odd because there was signal to find") show
   that memory-core's design, even where it works, fails two usability bars: (a) blocked/paused
   states must be loud, never a silent no-op — this repo's own AGENTS.md hard-earned lesson about
   silent tool/turn failures applies directly; (b) every promotion decision (positive or negative)
   must be explainable on demand, not just visible after the fact in a diary file.

We already have unique leverage memory-core lacks: PluresDB's native graph primitives
(`graph_pagerank`, `graph_clusters`, `auto_link`) plus a durable in-store Agens state/checkpoint
table (`agensStateGet`/`agensStateSet`), already exercised by the shipped P3 `consolidate()` sweep
(`src/pluresdb.ts:1656`). Dreaming should be this consolidation deepened, not a second parallel
subsystem bolted alongside it.

## 2. Creativity Model Applied

**(a) Baseline (explicit, generated first, per skill step 2):** verbatim-clone memory-core's
Light→Deep→REM three-phase design onto pluresLM: stage candidates from recent
recall/interaction traces in `memory/.dreams/` files, score with the same six weighted signals
(Frequency 0.24 / Relevance 0.30 / Query diversity 0.15 / Recency 0.15 / Consolidation 0.10 /
Conceptual richness 0.06), promote passing candidates into a `MEMORY.md`-equivalent file, run a
`0 3 * * *` external cron gated on OpenClaw's heartbeat, write a Dream Diary via a subagent turn,
add a shadow-trial report-only reviewer, expose a `memory promote`/`promote-explain`/`rem-harness`
CLI and a Gateway "Dreams" tab.

**(b) Constraint set `S` (what must hold for any candidate design to count, per skill step 1):**
- Must not depend on memory-core's cron, plugin internals, or `.dreams/`/`MEMORY.md` file format
  (this is the entire reason we're building our own — GH #61936).
- Must degrade loudly: any blocked/paused/skipped state must be positively reported, never a silent
  no-op (ADR-0002's own failure-mode table already treats "silently return an empty recall set" as
  a documented anti-pattern; Dreaming must hold the same bar).
- Must give an explain-why-not-promoted answer for any specific candidate on demand (closes the
  "burns tokens without impact" opacity complaint).
- Must offer a tier between "raw" and "durable promoted" (closes GH #62184), without becoming a
  second unbounded store.
- Must not silently fabricate results if a native op (`execIr`, `graph_pagerank`, embeddings) is
  unavailable — same honest-absence discipline already codified in `P3-P4-reactive-governed-SPEC.md`
  §7 (R6) and this workspace's NO-STUBS gate.
- Opt-in / disabled by default, matching memory-core's own stance.

**(c) Mechanism selection, deliberately named (skill step 3):**
- **Combinatorial:** merge memory-core's phase model (score → threshold → promote) with the
  community-identified missing tier from GH #62184 by inserting a `learning_candidates` staging
  category between raw session chunks and durable promotion — a genuinely new artifact from
  combining two known-but-previously-unassociated ideas (memory-core's phase pipeline + the
  issue's staging-tier request).
- **Exploratory:** searched the scheduling/heartbeat-independence region of the design space
  specifically, because that's the region GH #61936 flags as broken for us: is a cron job even
  necessary given PluresDB's durable Agens state table already lets P3 tick opportunistically off
  the existing lazy-`sync()` seam (`P3-P4-reactive-governed-SPEC.md` §3.2)? Enumerated: (i) a
  plugin-owned dedicated `setInterval`, (ii) hooking OpenClaw's existing heartbeat event (still an
  external dependency, though a looser one than memory-core's specific cron package), (iii) reusing
  the already-shipped lazy-sync-triggered tick with a durable Agens timer row
  (`agensTimerSchedule`/`agensTimerDue`) as the *sole* trigger, requiring zero new host-side wiring.
- **Transformational:** questioned whether "cron-gated batch sweep" is even the right mechanism at
  all, given pluresLM already computes embeddings locally and already recomputes graph salience
  on every consolidation tick. Memory-core's phase design assumes a nightly batch because computing
  embeddings/LLM-scoring in bulk is expensive for its architecture. We do NOT have that constraint at
  the *structural* layer (PageRank/cluster/dedup steps are native `execIr`, already running on every
  eligible tick per P3) — but we DO still have it at the *narrative/LLM* layer (Dream Diary text
  generation is genuinely a discrete, throttleable, costed LLM call). This split matters: it means
  "batch sweep" as ONE monolithic phase is the wrong shape for us, but "batch cadence" for the one
  LLM-touching sub-step is still correct. Re-imposing the real constraint (LLM calls cost tokens and
  should not run on every tick) after temporarily dropping it confirms: structural consolidation
  should run continuously/opportunistically (already true, unchanged from P3); only the narrative
  Dream Diary and any correction-staging *promotion* decision that invokes an LLM judgment should
  remain on a bounded cadence. This is the one place the baseline's monolithic-phase framing was
  wrong for our architecture and is worth deliberately deviating from.

**(d) ≥3 candidates generated and scored (skill step 4-5), N/V/Su against the constraint set `S`:**

| Candidate | Description | N | V | Su | Verdict |
|---|---|---|---|---|---|
| **C1 — Verbatim baseline clone** | Full Light/Deep/REM in `memory/.dreams/` files, external cron, subagent diary, CLI mirroring memory-core 1:1. | Low (≈0, this is the reference point) | **Fails** the "must not depend on memory-core internals" constraint by construction — the file format and cron pattern are literally memory-core's, and re-hosting them doesn't remove the external-cron dependency risk (GH #61936's actual complaint). Also fails "opportunistic tick" — a dedicated `0 3 * * *` cron reintroduces the "blocked if the agent's heartbeat doesn't fire" failure mode the ADR is asked to fix. | n/a (it's the baseline) | **Rejected** — fails `V` twice over. |
| **C2 — Pure in-DB structural sweep, no staging tier, no narrative** | Extend `consolidate()` only: add decay/eviction steps and an explicit promoted-vs-not durable flag per node, backed entirely by `agensState*`/`execIr`. No `learning_candidates` tier, no Dream Diary, no shadow-trial. | Moderate — genuinely self-contained and tick-driven (real delta from baseline), but conceptually narrow. | Passes self-containment and honest-absence constraints. **Fails** the GH #62184 staging-tier requirement (still binary promote/don't) and fails the transparency requirement (no promote-explain equivalent named). | Low — mostly an incremental hardening of what P3 already ships, not a leap. | **Rejected** — satisfies `V` for self-containment but fails two other named constraints (staging tier, explainability) outright. |
| **C3 — Combinatorial: phase model + staging tier + explain, all in-DB, tick-driven, LLM narrative decoupled from structural cadence** | Three logical phases (Light/Deep/REM renamed here to Ingest/Score/Reflect for clarity, running the SAME opportunistic-tick trigger P3 already uses) plus a new `learning_candidates` node category as the staging tier, plus a `dreamExplain(candidateId)` query that returns the actual scored signals and threshold gaps for any candidate, plus status fields that are always queryable (never silently blocked) via `agensStateGet`. Narrative Dream Diary generation is the ONLY LLM-gated, cadence-bound sub-step; all scoring/staging/promotion mechanics are native-tick, not cron-tick. | **High** — genuinely departs from the baseline's file-based, cron-gated, binary-promotion shape while reusing memory-core's proven scoring-signal *concept* (reused, not copied verbatim: signals recomputed from PluresDB's own graph/recency primitives, not English-text heuristics). | Passes every constraint in `S`: self-contained (owns its own Agens timer, no memory-core dependency), loud status (queryable state machine, not silent), explainable (dreamExplain), staging tier (learning_candidates), honest-absence (native ops report unavailable, never fabricate), opt-in/disabled-by-default. | **High** — the LLM/structural cadence split explicitly contradicts the initial expectation (stated in step (c)) that "batch sweep" was one indivisible unit; discovering it should be split IS the surprising, load-bearing delta. | **Selected.** |

**(e) Delta from baseline, stated explicitly and why it's load-bearing (skill step 7):** the
baseline's defining structural choice — one indivisible nightly batch phase gated on an external
cron/heartbeat, writing to files, promoting binary durable-or-nothing — is replaced with: (1) a
tick-driven native sweep with no external cron dependency (closes GH #61936, load-bearing because
that's the literal reason pluresLM needs its own implementation at all), (2) a three-tier
promotion ladder (raw → `learning_candidates` staged → durable) instead of binary (closes GH #62184,
load-bearing because it's a documented gap even memory-core's own users flagged as missing), and
(3) separating the *narrative* LLM-costed sub-step from the *structural* native sub-steps so only
the genuinely expensive part is throttled (load-bearing because it removes the "burns tokens
without impact" complaint at its root — most of Dreaming's work now costs zero tokens per tick).

## 3. Final architecture

### 3.1 Phases (renamed to avoid implying a literal memory-core port; same three-beat shape, different mechanics)

Reuses and extends `PluresLmStore.consolidate()` (`src/pluresdb.ts:1656`) rather than introducing a
parallel pipeline. All three phases run on the SAME single memoized native handle, on the SAME
tick (opportunistic lazy-sync trigger and/or OpenClaw heartbeat — see §3.3), following the P3
lock-safety proof already established in `P3-P4-reactive-governed-SPEC.md` §4 (one handle, one
thread, no push-based self-firing — the pull/tick model is a *hard binding constraint*, not a
stylistic choice, so Dreaming inherits it rather than re-litigating it).

1. **Ingest** (equivalent to memory-core's Light phase): scan recently-written session/short-term
   nodes since the last checkpoint (`agensStateGet("dreaming:ingest:checkpoint")`), dedupe by
   content-hash, and stage each distinct signal as a `learning_candidates` node (see §3.4) with an
   initial `stage: "ingested"` field. **Never writes to durable/promoted storage.** Native
   `execIr` filter + hash dedup; no LLM call.
2. **Score** (equivalent to Deep): run the existing `consolidate()` structural steps
   (`auto_link`, `graph_pagerank`, `graph_clusters`) plus a decay counter over the
   `learning_candidates` set, computing a composite score from PluresDB-native signals recomputed
   from our own store (NOT memory-core's six weights verbatim, since our source is graph-native,
   not access-log-native):
   - **Structural centrality** (from `graph_pagerank`, weight 0.35) — replaces memory-core's
     "Relevance."
   - **Recall frequency** (count of times this node/cluster was returned by `memory_search`,
     tracked via `agensEmit` audit events already used by P4 governance, weight 0.25) — same
     concept as memory-core's "Frequency."
   - **Cluster cohesion** (`graph_clusters` membership size/density, weight 0.15) — new signal
     PluresDB uniquely offers; no memory-core equivalent.
   - **Recency decay** (age-weighted, same shape as memory-core's Recency, weight 0.15).
   - **Correction reinforcement** (see §3.4 — a candidate that originated from an explicit user
     correction gets a fixed reinforcement bonus, weight 0.10) — this is the GH #62184-motivated
     signal, new relative to baseline.
   Candidates crossing `minScore`/`minRecallCount` thresholds (config, §4) advance
   `stage: "staged"` → eligible for promotion; those below threshold stay `stage: "ingested"` and
   are queryable via `dreamExplain` (§3.5) rather than silently dropped.
3. **Reflect** (equivalent to REM): a bounded-cadence, LLM-gated sub-step (own Agens timer row,
   independent interval from Ingest/Score — default daily, configurable) that (a) generates a
   short narrative "Dream Diary" entry summarizing what staged/promoted this cycle and any themes
   detected across clusters, written to an append-only `DREAMS.md`-equivalent file for human
   reading, and (b) optionally runs a shadow-trial verdict (baseline-vs-candidate-aware answer
   comparison, same concept as memory-core's, reused because it's a genuinely good idea) whose
   verdict feeds back into the Score phase's `correction reinforcement` signal on the NEXT tick.
   **Never writes to durable/promoted storage directly** — narrative and shadow-trial output are
   report-only inputs to Score, exactly mirroring memory-core's own "REM never promotes" invariant,
   which we keep because it's correct, not because we're cloning it uncritically.

### 3.2 Storage location and format

All Dreaming state lives **inside the PluresDB store itself** — no `memory/.dreams/` sidecar
directory, no separate SQLite file. This is the direct, load-bearing consequence of the
transformational reasoning in §2(c): a single durable, replicatable, lock-consistent store beats
files spread across the filesystem, and it is what makes "self-contained, no memory-core
dependency" literally true rather than aspirational.

- `learning_candidates` — a node category (parallel to the existing `session`/`memory-chunk`
  categories already used by `consolidate()`), each node carrying `{ stage, score, signals,
  originHash, firstSeenEpoch, lastSeenEpoch, correctionOrigin?: boolean }`.
- `dreaming:ingest:checkpoint`, `dreaming:score:checkpoint`, `dreaming:reflect:checkpoint` —
  durable Agens state keys (`agensStateSet`), one checkpoint per phase, following the exact pattern
  already proven by `CONSOLIDATE_CHECKPOINT_KEY` (`src/pluresdb.ts:166`).
  This deliberately allows Ingest/Score to run on a tight opportunistic cadence while Reflect stays
  on a loose bounded cadence, using the SAME mechanism (independent Agens timer rows via
  `agensTimerSchedule`/`agensTimerDue`) rather than three different scheduling primitives.
- `DREAMS.md`-equivalent — the ONLY filesystem artifact, an append-only human-readable narrative
  log written by the Reflect phase, explicitly documented as non-authoritative (never a promotion
  source, matching memory-core's own invariant).
- Durable promotion target — the existing memory-chunk category already searched by
  `memory_search`/`memory_get`; a `learning_candidates` node that crosses the promotion gate is
  migrated (via the P4 `pxOnAction`-gated write chokepoint, see §3.4) into that category rather
  than into a new file. This means promoted Dreaming output is **immediately and natively
  searchable** through the tools that already exist — no new read path required.

### 3.3 Scheduling mechanism (self-contained; explicit answer to GH #61936)

Dreaming owns its own Agens timer rows (`agensTimerSchedule("dreaming:ingest", ...)`,
`"dreaming:score"`, `"dreaming:reflect"`), each with an independently configured interval. It does
**not** call, import, or depend on any memory-core module, cron package, or OpenClaw-core
scheduler API. Two tick sources drive it, following the same opportunistic model P3 already
proved safe (`P3-P4-reactive-governed-SPEC.md` §3.2, §4):

1. **Primary — piggybacked on the existing lazy `sync()` trigger** that Path B already runs before
   every `memory_search` call. Cheap `agensTimerDue()` check; if Ingest/Score is due, run it AFTER
   returning the current search result (never blocks recall latency), guarded by a process-local
   `sweepInFlight` boolean exactly as P3 already specifies.
2. **Secondary — OpenClaw heartbeat**, if the host process happens to fire one. This is
   opportunistic, not required — because Dreaming is durable-checkpoint-based and idempotent
   (identical invariant to P3), a missed heartbeat or missed search tick simply defers the next
   due timer; there is no scheduling single point of failure and no dependency on any specific
   external cron package. This is the concrete fix for "Dreaming status: blocked" — there is no
   state in which Dreaming is unable to proceed except "no tick has occurred yet," which is
   reported as `nextEligibleAt`, not as an opaque `blocked`.

Because both tick sources are optional and either alone is sufficient, this design answers GH
#61936 directly: an external memory-slot plugin (us) can deliver Dreaming with **zero** dependency
on memory-core's specific scheduler, cron format, or plugin registration path.

### 3.4 Promotion / staging tiers (closing GH #62184)

Three tiers, one node-category state machine, migrated via `stage` field transitions gated by the
already-proven P4 `pxOnAction` chokepoint (`PluresLmStore`'s single write path, per
`P3-P4-reactive-governed-SPEC.md` §5.1):

| Tier | Meaning | Written by | Promotion gate |
|---|---|---|---|
| `ingested` | Raw candidate signal, deduped, not yet scored above any threshold. | Ingest phase | none — freely written, low cost |
| `staged` (this is the **`learning_candidates`** answer to GH #62184) | Crossed the Score-phase threshold OR originated from an explicit user correction (`correctionOrigin: true`, see below) but has not yet accumulated enough independent reinforcement to promote. Visible to `memory_search` only if the caller explicitly opts into a `corpus: "staged"` filter (never surfaced by default — staged material is provisional). | Score phase | `pxOnAction` gate `C-DREAM-STAGE` (new constraint, same declarative `.px` mechanism as `C-MEM-REDACT`): require score above `minScore` OR `correctionOrigin == true`. |
| `promoted` (durable) | Migrated into the existing memory-chunk category; fully searchable by default. | Score phase, on threshold crossing over ≥2 independent ticks (avoids single-signal flukes) | `pxOnAction` gate `C-DREAM-PROMOTE`: require `score >= minPromoteScore AND recallCount >= minRecallCount` (two same-`when:` constraints per the `P3-P4-reactive-governed-SPEC.md` §5.2 compound-predicate caution). |

**Explicit correction-staging concept (the GH #62184 delta):** when a user interaction is an
*explicit correction* — the agent said something wrong and the human corrected it in the same or a
nearby turn — that event is tagged (`correctionOrigin: true`) at ingest time (a lightweight
heuristic: a short user turn immediately following an assistant turn, containing a negation/
correction marker, OR an explicit `/correct`-style user signal if one is later added — this v1
ships the heuristic detector only, not a dedicated UI affordance, see §5 out-of-scope). A
correction-origin candidate is allowed into `staged` on a SINGLE occurrence (bypassing the
normal multi-tick score requirement), because a correction is evidence in itself — but it still
cannot reach `promoted` without the normal `C-DREAM-PROMOTE` reinforcement gate. This gives users
exactly the missing middle tier GH #62184 asks for: a corrected-once or first-sighted lesson is
visibly staged and explainable immediately, without being silently discarded (the pre-Dreaming
state) or over-eagerly treated as a durable rule after one observation (memory-core's binary gap).

### 3.5 Transparency / explainability mechanism (closing the "promote-explain" gap)

A `dreamExplain(query | candidateId)` capability (surfaced as a new plugin tool, e.g.
`memory_dream_explain`, mirroring the existing `memory_search`/`memory_get` tool-factory pattern
in `src/index.ts`) that, given a query string or an explicit candidate node id, returns:

- the current `stage`, all computed signal values (structural centrality, recall frequency,
  cluster cohesion, recency decay, correction reinforcement) and the composite score;
- the exact threshold(s) it is being compared against (`minScore`, `minPromoteScore`,
  `minRecallCount`) and the numeric gap to each;
- which `pxOnAction` constraint (if any) most recently blocked a stage transition, with the
  constraint's own `fix:` message (reusing the existing P4 `ActionBlocked`/constraint-fix
  mechanism verbatim — no new explanation format needs inventing, it already carries a
  human-readable fix hint);
- a plain-language one-line verdict: e.g. "not promoted: recallCount 1/3, needs 2 more retrievals."

This directly answers the "burns tokens without impact... seems odd because there was signal to
find" complaint: any candidate's non-promotion is explainable on demand, in the same terms the
scoring actually used, with zero ambiguity about whether it was silently dropped or deliberately
held back.

### 3.6 Status visibility (closing the "silently blocked" gap)

A `dreamStatus()` capability (tool + a status field folded into the existing plugin `/status`
surface referenced in ADR-0002) reports, always, never silently:

- `enabled: boolean` (config-gated, see §4);
- per-phase: `lastRunEpoch`, `nextEligibleAt` (computed from the Agens timer row — this is the
  literal fix for "Dreaming status: blocked": there is no undefined/opaque blocked state, only a
  concrete future timestamp or an honest `unavailable: <reason>` when a required native op
  (`execIr`/`graph_pagerank`/embedding) is missing);
- counts: `ingestedCount`, `stagedCount`, `promotedToday`, `correctionOriginCount`;
- `reflectLastDiaryAt` and a pointer to the latest `DREAMS.md`-equivalent entry.

Per the honest-absence discipline already established in `P3-P4-reactive-governed-SPEC.md` §7
(R6), if a structural step could not run (native op unavailable), the status reports
`unavailable: "<step> failed: <reason>"` for that step rather than a stale/fabricated success —
the same posture already required of `consolidate()`.

## 4. Config surface sketch

Opt-in, disabled by default (matching memory-core's own stance and this repo's existing plugin
config conventions in ADR-0002's `plugins.entries.plureslm.config`):

```jsonc
{
  "plugins": {
    "entries": {
      "plureslm": {
        "config": {
          "dreaming": {
            "enabled": false,
            "ingest": { "intervalSecs": 300 },
            "score": { "intervalSecs": 900, "minScore": 0.55, "minRecallCount": 2, "minPromoteScore": 0.7 },
            "reflect": {
              "intervalSecs": 86400,
              "diaryModel": null,
              "diaryAllowlist": [],
              "shadowTrial": false
            },
            "correctionDetection": { "enabled": true }
          }
        }
      }
    }
  }
}
```

- `dreaming.enabled` — master switch; when `false`, no Agens timer rows are scheduled and
  `dreamStatus()` reports `enabled: false` (loud, not silent).
- `ingest.intervalSecs` / `score.intervalSecs` — cheap, native-only, safe to run frequently.
- `reflect.intervalSecs` — bounded LLM-cost cadence; default daily, matching memory-core's own
  default cadence for its equivalent narrative phase.
- `reflect.diaryModel` — optional model override for the Dream Diary subagent turn, with an
  explicit trust/allowlist gate (`diaryAllowlist`) mirroring memory-core's own "no silent fallback
  on trust failures, only silent retry on model-unavailable" rule, carried over deliberately
  because it's a good invariant, not baseline-cloning for its own sake.
- `reflect.shadowTrial` — off by default; when enabled, runs the baseline-vs-candidate verdict
  step described in §3.1.
- `correctionDetection.enabled` — toggles the lightweight correction-origin heuristic in §3.4.

## 5. Explicit out-of-scope for v1 (documented deferrals, not stubs)

- **No dedicated user-facing `/correct` UI affordance.** v1 ships only the heuristic
  correction-origin detector (adjacent-turn negation pattern). A first-class explicit correction
  command is real future work, not something faked with a placeholder handler.
- **No Gateway "Dreams" UI tab.** v1 exposes `dreamStatus()`/`dreamExplain()` as plugin tools and
  a `/status` field only; a dedicated graphical tab is deferred, matching this ADR's own
  "documented deferred feature is fine, a fake UI stub is not" stance.
- **No cross-agent/multi-tenant Dreaming isolation guarantees.** Per ADR-0002 §15, data isolation
  across `dbPath`s is still an open P2 hardening item at the store level; Dreaming inherits
  whatever isolation the underlying store already provides and makes no additional claim.
- **No hard-delete eviction of low-score `ingested` candidates.** Per `P3-P4-reactive-governed-SPEC.md`
  §3.1's own stub guard, deletion is a P4-governed action; v1 Dreaming only decays/flags, it does
  not implement an eviction procedure. This is an honest absence, matching the existing
  `consolidate()` posture, not a placeholder.
- **No cross-plugin/upstream OpenClaw core change.** This ADR does not propose modifying
  OpenClaw's memory-slot contract or attempting to make memory-core's own Dreaming implementation
  slot-aware; GH #61936 is answered by pluresLM shipping its own independent implementation, not by
  fixing upstream (out of this repo's control/scope).
- **No compound `pxOnAction` predicate reliance without verification.** Per the same spec's §5.2/R3
  caution, `C-DREAM-PROMOTE`'s two conditions are implemented as two same-`when:` constraints
  rather than assuming AND-conjunction compiles in one `require:`, until that grammar capability is
  explicitly confirmed during implementation.
- **Headroom/token-compression integration is NOT part of this design.** It is a separate,
  independently-tracked epic child (`H` in `EPIC-MEMORY-SUPERIORITY.md`) with its own unresolved
  native-binding question; Dreaming does not depend on it and should not be blocked by it.

## 6. Adjacent efficiency notes (non-Dreaming, one paragraph per task instructions)

Some community reports attribute reduced token burn to structural daily-note habits unrelated to
Dreaming itself: append-only writes instead of risky in-place edits, proactively compacting before
an emergency compaction is forced, and a fixed boot-read-order plus a summary card instead of
re-reading full files every turn. These are worth keeping in mind for this repo's own `DREAMS.md`
-equivalent narrative log (append-only by construction, per §3.2) and are consistent with this
workspace's own `AGENTS.md` "Write It Down" convention, but they are efficiency hygiene for
daily-note tooling generally, not a Dreaming-specific design decision, and are called out here only
so they aren't lost — no further scope is implied.

## 7. Design decisions (resolved 2026-08-07 by kbristol)

All 3 questions below are now RESOLVED - decisions match the recommended defaults, which were already implemented in code prior to this decision being formally recorded. No code changes required as a result of this resolution; this section is updated for the record only.

1. **Reflect-phase LLM model default: `null` (inherit host default model).** DECIDED. Should `reflect.diaryModel` default to `null` (inherit the
   host's default model, per memory-core's own pattern) or should it default to a specific cheap
   model to bound cost more predictably from day one? No strong signal either way from the source
   material; recommend defaulting to `null` (inherit) unless kbristol has a standing cost policy
   for background/subagent turns this should follow.
2. **Staged-tier candidates: opt-in only via `corpus: "staged"` (§3.4), never default-visible to `memory_search`.** DECIDED - matches kbristol's standing "don't surface unverified data by default" posture. Contingent on promotion actually running on a real automated cadence (dreaming-tick cron/heartbeat), not manual-only, so staged items don't silently rot.
3. **Shadow-trial cost policy: `false` by default** (as already configured), with a daily token/run budget cap (not a per-trial cap) once `reflect.shadowTrial` is actually implemented - avoids an open tap while still giving headroom. DECIDED. Note: shadow-trial itself remains genuinely unimplemented in v1 (no LLM chat/completion bridge exists in this codebase yet, only `embeddingModel` - honestly deferred, not stubbed); this cost policy applies once that bridge exists and reflect is built for real.

## PR summary (for when implementation begins — not part of this ADR's change)

**Title:** `docs: propose PluresLM Dreaming design (self-contained, staged promotion, explainable)`

**Changes:** adds this ADR only. No source files modified. No config changed. No new tools
registered. Establishes the design that a subsequent, separately-gated implementation PR must
follow (per this workspace's design-first/no-stubs gate).

**Validation:** documentation-only change; nothing to run.
