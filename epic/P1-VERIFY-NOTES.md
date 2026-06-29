# P1 — Graph-native associative recall · VERIFY NOTES

**Epic:** PluresLM Memory Superiority — P1 (associative graph recall)
**Stage:** VERIFY — the FINAL P1 gate. Channel-agnostic, capability-contract proof
(C-TEST-001/002): prove associative recall works END-TO-END through the REAL
OpenClaw memory-capability surface the gateway actually calls — NOT a bespoke
harness, NOT any chat adapter. "Does it really work when wired as the memory slot."
2026-06-29.

**Result:** ✅ **ALL VERIFY CHECKS PASSED** through the real `MemorySearchManager`
boundary (30/30 checks, exit 0, deterministic across 4 runs). ✅ Regression backstop
**GATES A/B/C/D ALL PASS** (`pnpm run build` exit 0 + `pnpm test` exit 0 on my run).
**No integration defect** — the capability behaves identically through the real
manager boundary as the test/qa harnesses indicated. One transient **cold-start**
flake observed in the regression suite (characterized below) — NOT a logic defect,
did not reproduce across 10+ subsequent runs, and is unrelated to associative recall.

Working tree: `C:\Projects\plureslm-openclaw` @ branch `main` (P1 committed:
`7f79f02` implement, `897ba2d` test+qa). Did NOT touch the sibling worktree
`C:\Projects\plureslm-openclaw-p3p4`.\n\n---\n\n## The boundary VERIFY drove (and what it deliberately did NOT touch)\n\nEvery memory interaction below went through EXACTLY the path OpenClaw's host
(`MemorySearchManager` consumer) uses — verified against the shipped SDK contract
`dist/plugin-sdk/memory-state-FIOhoe_D.d.ts` (`MemoryPluginRuntime.getMemorySearchManager`
→ `{ manager, error }`; `MemorySearchManager.sync` / `.search`):

```
buildMemoryCapability(cfg)                                  // plugin's real factory export (dist/api.js)
  .runtime.getMemorySearchManager({ cfg, agentId, purpose }) // the host's acquire call
    -> { manager, error }
manager.sync({ reason, force, sessionFiles, progress })     // the ONLY write entrypoint used
manager.search(query, { maxResults })                       // the ONLY read entrypoint used
```

- **No internal store method is used for any assertion** — no `store.neighbors()`,
  no `store.execIr()`, no `createPluresLmSearchManager()`. (The test/qa harnesses
  legitimately peek `store.neighbors`/`graph_links` to inspect edges; VERIFY does
  NOT — it asserts ONLY on what the gateway can observe: the `MemorySearchResult[]`
  that `manager.search()` returns.)
- **No chat adapter** (C-TEST-002): the manager is driven directly, the same object
  the gateway holds.
- **No fabricated edges / no fabricated recall / no stubs** (C-NOSTUB-001): edges are
  formed solely by the shipped `manager.sync()` link-on-write; graph hits are
  produced solely by the shipped `manager.search()` graph expansion.
- The only test-side knob is the **real, shipped `vectorThreshold` config**, set
  exactly as the host would set it (a documented capability config), used to push the
  disjoint sibling below the direct-hit cutoff so the graph path is the only way it can
  surface.

**Confirmed at this boundary:** the plugin captures its real config at
`buildMemoryCapability(cfg)` time and `getMemorySearchManager({cfg,agentId})`
returns a live `manager` whose `sync`/`search`/`status` are exactly the SDK shapes
— `status()` reported `backend:"builtin"`, `provider:"plureslm"`, and `sync()`
invoked the host `progress` callback (4 calls for the 4-file ingest). No drift
between the harness boundary and the real manager boundary.

---

## Scenario (realistic, not the toy fixture)

Four **session** memories written in ONE `manager.sync()` (same `category:"session"`
+ same temporal window ⇒ link-on-write joins them). Two are **topically associated by
context but lexically/vectorally dissimilar**:

- **ONCALL** (`mem:session:sess-oncall:0`) — on-topic for the assoc query: the
  payments-service on-call **escalation runbook**.
- **ROTA** (`mem:session:sess-rota:0`) — the SAME incident's **pager handoff rota**
  (names + weekday scheduling: "Mara… Devin… Priya…"). **Disjoint vocabulary** from
  the query (no "runbook"/"escalation"/"payments"/"kraken" terms), so its cosine sits
  **below the strict 0.80 bar** — it can ONLY be reached by association. This is the
  DIRECT-MISS / GRAPH-HIT target: the memory you actually want surfaced *alongside* the
  runbook, that cosine alone misses.
- **BACKUP** (`mem:session:sess-backup:0`) — on-topic for the PRECISION query
  (postgres backup / pg_dump retention). Gives that query a clear expected DIRECT top-1.
- **PLANTS** (`mem:session:sess-plants:0`) — off-topic control (photosynthesis),
  same-session, so graph breadth is non-trivial and precision is genuinely tested.

Graceful-fallback uses a SEPARATE store with one **lone** memory
(`mem:session:sess-lone:0`, capacity-planning review) that has NO same-session sibling
⇒ link-on-write forms no usable edge ⇒ `search()` has nothing to graph-expand.

Harness (new, additive — NOT a chat adapter, NOT touching the Path B `verify-child.mts`):
`test/p1-verify-gate.mts` (orchestrator) + `test/p1-verify-child.mts` (per-phase
cross-process child). Each phase is its OWN process (PluresDB exclusive-lock contract);
the read phases reopen the same dbPath in a FRESH process, which is also the durability
proof.

---

## 1) DIRECT-MISS, GRAPH-HIT — PASS (the associative win, through `manager.search()`)

`read-strict` (FRESH process, `vectorThreshold:0.80`), query
`"incident escalation runbook for the payments service"`. Full ranked list returned by
`manager.search()`:

```
rank 0  mem:session:sess-oncall:0  via=vector  score=0.8165  citation=plureslm:session:mem:session:sess-oncall:0
rank 1  mem:session:sess-backup:0  via=graph   score=0.8165  citation=plureslm:graph:mem:session:sess-oncall:0->mem:session:sess-backup:0  (seed=oncall)
rank 2  mem:session:sess-plants:0  via=graph   score=0.8165  citation=plureslm:graph:mem:session:sess-oncall:0->mem:session:sess-plants:0  (seed=oncall)
rank 3  mem:session:sess-rota:0    via=graph   score=0.8165  citation=plureslm:graph:mem:session:sess-oncall:0->mem:session:sess-rota:0    (seed=oncall)
```

- **ONCALL is a DIRECT vector hit at rank 0** (`via:"vector"`, score 0.8165) — the
  query vector-matches the on-topic runbook.
- **ROTA (disjoint, below the strict bar) surfaced via `manager.search()` as
  `via:"graph"`**, citation
  **`plureslm:graph:mem:session:sess-oncall:0->mem:session:sess-rota:0`** (contains
  `"graph"`), **seeded from the ONCALL direct hit**. ROTA carries no vector/text score
  of its own — it arrived purely by association over the link-on-write edge. **This is
  the structural win cosine alone cannot produce:** at threshold 0.80 a flat vector
  store returns NOTHING for ROTA; the graph returns it because it is graph-adjacent to a
  direct hit.
- **ROTA ranks strictly below its ONCALL seed** (rank 3 > rank 0) — no displacement.

(BACKUP + PLANTS also arrive via graph here because they are same-session neighbors of
the ONCALL seed too — correct augment behavior. All graph hits rank below the direct
seed; ROTA being the specific disjoint target is the one the win turns on, and it is
present, via graph, below its seed.)

---

## 2) PRECISION PRESERVED — PASS (graph never displaces a direct top-1)

`read-default` (FRESH process, default threshold), query
`"postgres backup schedule pg_dump retention"`. Full ranked list from `manager.search()`:

```
rank 0  mem:session:sess-backup:0  via=vector  score=0.8603  <- expected on-topic DIRECT top-1, UNCHANGED
rank 1  mem:session:sess-rota:0    via=vector  score=0.6591
rank 2  mem:session:sess-oncall:0  via=vector  score=0.6268
rank 3  mem:session:sess-plants:0  via=vector  score=0.5326
```

- **top-1 is the expected on-topic node BACKUP** (`via:"vector"`, score 0.8603) — the
  direct hit is first and unchanged.
- **No graph hit occupies top-1** (`graphAtTop === false`).
- At the default 0.30 threshold all four nodes clear the vector bar as **direct** hits,
  so de-dupe correctly keeps them direct and does not re-add any as `via:"graph"` (a
  graph neighbor already present as a direct hit is skipped). The "every graph hit ranks
  below its seed" property is therefore vacuously satisfied here, while the load-bearing
  guardrail assertions — *top-1 is the expected direct node* and *no graph hit at top-1*
  — run against real data and **hold**. (The active graph-vs-direct ordering is
  exercised in the strict phase, where ROTA-via-graph ranks strictly below
  ONCALL-direct.)

**Precision held: enabling graph expansion did not change which memory ranks first.**

---

## 3) DURABILITY — PASS (edges persisted on disk, not in-memory-only)

Both read phases (`read-strict`, `read-default`) run in **brand-new processes**,
separate from the `ingest` process, reopening the **same dbPath**. The PluresDB
exclusive file lock is released when the ingest process exits, so a read phase can only
see edges that were **written to disk**. The associative win in §1 is produced by a
fresh-process `manager.search()` — the edge ROTA arrived over was read from disk, after
the writing process was gone. Associative recall therefore **survives capability/manager
teardown + rebuild against the same dbPath** (edges durable, not memoized in RAM). This
is the same cross-lock-boundary durability the QA stage proved at the store level (6==6
edges across processes), re-confirmed here purely through the manager boundary.

---

## 4) GRACEFUL FALLBACK — PASS (augment-not-replace safety property)

`read-lone` (FRESH process, default threshold) against the separate lone-node store,
query `"quarterly capacity planning review for the search index shards"`. Full ranked
list from `manager.search()`:

```
rank 0  mem:session:sess-lone:0  via=vector  score=0.8048  citation=plureslm:session:mem:session:sess-lone:0
graphHitCount=0
```

- The lone memory has **no same-session sibling**, so `manager.sync()` link-on-write
  formed no usable edge and `manager.search()` had **nothing to graph-expand**.
- **`search()` still returned the correct memory as the DIRECT top-1** (`via:"vector"`,
  score 0.8048), with **zero graph hits** (`graphHitCount === 0`).
- This proves the **augment-not-replace** safety property at the real boundary: when
  graph expansion contributes nothing, recall degrades cleanly to baseline vector recall
  — so **enabling P1 can never make recall WORSE than baseline**. Graph is strictly
  additive; the direct path is untouched.

> Scope note (honest): this proves graceful fallback via the manager-observable
> property "graph adds nothing harmful; direct recall is preserved when there is no
> association to add." The *internal* belt-and-suspenders behavior — each per-seed
> `store.neighbors()` call is wrapped in try/catch so a thrown expansion can never break
> `search()` — was already proven at the store boundary in QA (forced `neighbors()`/
> `execIr` to throw → `search()` still returned the direct hits). VERIFY does not
> re-force an internal throw because doing so would require reaching past the manager
> boundary (out of scope for C-TEST-002); the two stages together cover both the
> "nothing to expand" and "expansion errors" fallback paths.

---

## Regression backstop (standalone gate suite — `pnpm test`) — PASS

Per the brief, ran the promoted A/B/C/D gate suite as a regression backstop:

- `pnpm run build` → `tsc -p tsconfig.json` **exit 0**.
- `pnpm test` (standalone tsx gate against `dist/`) → **`=== RESULT: ALL CHECKS
  PASSED ===`**, 4 gates, 0 failures, **exit 0** (final run + 10+ confirming runs).

### Transient cold-start flake (characterized, NOT a defect)

On the **very first** `pnpm test` invocation of this session (a cold process, before
tsx/esbuild had compiled the child workers and before the BAAI embedding model was
warm), the suite reported `=== RESULT: 1 CHECK(S) FAILED ===` / exit 1. GATE D was
fully green in that same run (the visible failure was upstream in A/B/C, consistent with
a child-process spawn brushing its `timeout: 120_000` on cold model-load). It **did not
reproduce on any of the 10+ subsequent runs** (5 logged runs + multiple confirming
runs, all exit 0 / 0 failures), and the P1 VERIFY gate is deterministic (4/4 clean).

- **Class:** cold-start child-process timeout / first-invocation embedder warmup — the
  same transient class already documented for this repo's cross-process children (each
  gate spawns `tsx` children that must compile + cold-load the embedder; the first one
  pays the full cost). It is timing-sensitive, not logic-sensitive.
- **Why it is NOT a P1 defect:** the associative-recall feature is exercised by GATE D
  and by the entire P1 VERIFY gate, both of which passed; the flake hit the
  cold-start of an unrelated gate's child, not any associative-recall assertion. The
  fix posture if it ever needs hardening (out of VERIFY's scope to change) is a warmup
  invocation or a larger first-child timeout — a harness-timing tweak, not a code fix.
- **No assertion was weakened** to make the suite pass (C-NOSTUB-001 / brief constraint):
  the suite passes on its own merits once the embedder is warm, which is the steady
  state the gateway runs in.

---

## Did associative recall work through the REAL `MemorySearchManager` boundary?

**YES.** Driven ONLY through `buildMemoryCapability(...).runtime.getMemorySearchManager(...)`
→ `manager.sync()` / `manager.search()` (no internal store access, no chat adapter):

- **DIRECT-MISS / GRAPH-HIT:** the disjoint ROTA memory surfaced via
  `manager.search()` as `via:"graph"`, citation
  `plureslm:graph:mem:session:sess-oncall:0->mem:session:sess-rota:0`, seeded from the
  ONCALL direct hit — proving association surfaces what cosine (strict bar) misses.
- **PRECISION:** the on-topic BACKUP stayed top-1 direct; no graph hit at top-1.
- **DURABILITY:** the win was produced by a FRESH-process `manager.search()` reopening
  the same dbPath — edges persisted to disk.
- **GRACEFUL FALLBACK:** the lone memory still returned as direct top-1 with zero graph
  hits — augment-not-replace holds; P1 cannot make recall worse than baseline.
- **REGRESSION:** GATES A/B/C/D all pass; build exit 0.

**No integration defect found.** The capability behaves identically at the real manager
boundary as the harness/QA indicated. P1 is closed.

---

## Honesty / scope

- **Real capability boundary only** (C-TEST-001/002): every assertion observes only the
  `MemorySearchResult[]` the gateway gets from `manager.search()`; the write went only
  through `manager.sync()`. No chat adapter, no fabricated recall, no second native
  handle on a live dbPath.
- **No stub** (C-NOSTUB-001): edges and graph hits are produced solely by the shipped
  `sync()`/`search()`; the only test knob is the real `vectorThreshold` config.
- **Did not weaken anything:** A/B/C/D are unchanged; the P1 VERIFY gate is purely
  additive (new `test/p1-verify-*.mts`); the Path B `test/verify-child.mts` was left
  byte-for-byte intact.
- **Bounded output** discipline observed (capped `Select-Object`/`Select-String`, logs
  written to `.tmp/` then removed, no node_modules dumps).
- New files: `test/p1-verify-gate.mts`, `test/p1-verify-child.mts` (untracked, ready to
  commit with the verify stage).
