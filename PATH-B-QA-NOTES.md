# Path B — QA stage notes (TASK-2026-06-29-PATHB)

Stage: **QA** · Host: Windows (`kbristol-DevBox`, pwsh 7, node v26) · Date: 2026-06-29
Native: `@plures/pluresdb-native@2.0.0-alpha.1` (`file:../pluresdb/crates/pluresdb-node`,
only binary present = `pluresdb-node.win32-x64-msvc.node`, 33.9 MB).

QA goes BEYOND the TEST gate: it confirms the native loader **read + write** on
Windows against a real store dir through the SHIPPED path, and **root-causes the
one real finding** from TEST (vector index = 0 entries for freshly `put` nodes).
Read-only except for throwaway temp store dirs + two QA probe scripts + this file.
**No production code was changed** (no bug in the plugin — see verdict).

---

## 1. THE CRITICAL QA QUESTION — vector index 0 for fresh `put` nodes

### VERDICT: **(a) embed-on-put gap — and it is a NATIVE-ALPHA LIMITATION, not a plugin bug.**

The plugin calls `db.put(id, data)` exactly as `@plures/pluresdb-native`'s own
`index.d.ts` documents:

> *"Every subsequent call to `put` will automatically embed any text content
> found in the node data."* (newWithEmbeddings docstring)

In `2.0.0-alpha.1` that contract is **NOT honored**: `put()` stores the node but
does **not** create/persist an embedding, so there is no vector to index and a
purely semantic query of a just-written node returns 0. The embedder itself is
fully functional, and the index/search machinery works perfectly when an
embedding is actually stored (proven by the `putWithEmbedding` control). So the
defect is squarely in the native `put()` auto-embed path, not in how the plugin
calls it.

### Probe (`test/qa-vector-probe.mts`) — concrete numbers

Two legs, each its own process (the native holds a per-process exclusive lock,
so the reopen leg runs only after the writer process has exited):

**in-proc leg** (open `newWithEmbeddings` → put → build → search):

| Signal | Value | Reading |
|---|---|---|
| `embeddingDimension()` | **384** | embedder configured |
| `embed(["hello world"]).length` | **384** (== dim) | **embedder WORKS** |
| `put("qa:vec:1", {content,…})` → `get(id)` keys | `[category, content, source, type]`, **vectorLen: null** | **no embedding stored on the node** |
| `getWithMetadata(id)` keys | `[clock, data, id, timestamp]`, **vectorLen: null** | no vector in metadata either |
| `buildVectorIndex()` after put | **0** | nothing to hydrate/index |
| `vectorSearch(embed(sentence)[0], 5, 0.0)` | **0 hits** | semantic recall of the put node fails |
| **CONTROL** `putWithEmbedding("qa:vec:ctrl", data, vec)` then `vectorSearch` | **1 hit** (top `qa:vec:ctrl`) | an EXPLICIT embedding IS indexed + searchable |
| `search("disaster recovery plan", 5)` (text) | **2 hits**, top `qa:vec:1` | text recall works |

**reopen leg** (FRESH handle on the SAME dir, after writer exited):

| Signal | Value | Reading |
|---|---|---|
| `stats().totalNodes` | 12 | store durable across processes |
| `get("qa:vec:1")` keys | `[category, content, source, type]`, **vectorLen: null** | **still no vector after reopen** |
| `buildVectorIndex()` | **0** | (note: returns 0 even though the ctrl vector below is searchable — see caveat) |
| `vectorSearch(embed(sentence)[0], 5, 0.0)` | **1 hit**, top **`qa:vec:ctrl`** | only the EXPLICIT-embedding node comes back; the put node does NOT |

### Why this is (a) and not (b) or (c)

- **Rules out (b) index-timing/rebuild-ordering / reopen-needed:** the put node's
  vector is absent on `get()`/`getWithMetadata()` *both* in-proc and after a fresh
  reopen, and `vectorSearch` for it returns 0 in *both* legs. Reopening does not
  conjure a vector that was never stored. Ordering is not the issue — the data
  isn't there to order.
- **Rules out (c) expected-by-design "indexes only pre-existing on load":** the
  `putWithEmbedding` control node — written in the SAME session, the SAME way,
  just WITH an explicit vector — IS indexed and returned by `vectorSearch` (1 hit),
  including across the reopen. So the native happily vector-serves freshly-written
  nodes *when they carry an embedding*. The only missing step is `put()` producing
  that embedding. That is a gap, not a design.
- **Confirms (a):** embedder works (`embed()` → 384-dim), but `put()` does not
  embed-on-write → no vector → `buildVectorIndex()=0` → `vectorSearch()=0` for the
  put node, while text recall and the explicit-embedding path both work.

### Caveat on `buildVectorIndex()`'s return value
`buildVectorIndex()` returned **0 in the reopen leg even though a
`putWithEmbedding` vector was present and `vectorSearch` returned it (1 hit)**.
So the integer return of `buildVectorIndex()` is an **unreliable signal** in this
alpha (it does not equal the number of searchable vectors). QA judged vector
availability by `vectorSearch` hit count, not by `buildVectorIndex()`'s return.

### Impact (stated loudly, per the brief)
**Semantic (vector) recall of memory written through the shipped `sync()` does
NOT work in this native alpha.** Synced session/memory content is recallable
**by text/substring/phrase only**. Any P1 work that depends on *semantic* recall
of freshly-synced nodes (vector similarity over just-written memory, graph/vector
features) is **blocked on the native** until one of the fixes below lands. The
write→recall *contract* (GATE C) still holds — but only via text — and that
distinction must not be papered over.

### Recommended fix (for verify / P1 — NOT applied here)
The native `.node` is a local `file:` source-crate dependency, so two clean paths
exist (design call, deferred — not a stub, an honest deferral):
1. **Preferred — fix the native `put()` auto-embed** in the source crate so it
   honors its own documented contract (then the plugin needs zero changes).
2. **Plugin-side workaround if the native fix is slow** — have `PluresLmStore`
   compute the embedding (`db.embed([text])` already works) and write via
   `db.putWithEmbedding(id, data, vec)` instead of `db.put(id, data)`. The probe
   proves this makes vector recall work end-to-end. This is the smallest change
   that unblocks semantic recall without touching the native, and it is a real
   implementation (not a stub) — but it is a P1 design decision, so QA did **not**
   apply it unilaterally.

---

## 2. Real-store-dir read + write (cross-process) — **PASS** (text recall)

`test/qa-store-probe.mts`, SHIPPED path
(`dist/api.js → buildMemoryCapability → getMemorySearchManager → manager.sync()/search()`),
two processes, fresh temp dir (a real store dir):

```
write leg: before=10  after1=11  delta1=1  progress1=1   (sync wrote 1 node)
read  leg (separate process): totalNodes=11  provider=plureslm  backend=builtin
           vectorAvailable=true  semanticAvailable=true  vectorDims=384
           sentinelRecalled=true  via=text  id=mem:session:qa-session:0
           source=sessions  score=1
```

- A real session file with sentinel `QASTORE5150…` was ingested via `sync()` in
  one process (`delta=1`), then a **separate** process (lock released) recalled it
  → durable across the process/lock boundary. **Re-confirms the exclusive-lock
  cross-process contract beyond the gate's fixtures.**
- **Vector recall there:** the store *reports* vector capability
  (`vectorAvailable=true`, `vectorDims=384`) because the embedder is live, but the
  sentinel is **recalled via text, not vector** — exactly consistent with the
  (a) embed-on-put gap above. Honest disclosure: this is text recall, not vector.

---

## 3. `#isDirty` idempotency — **PASS** (proven)

Same driver, write leg syncs the SAME unchanged file twice:

```
delta1 = after1 - before = 11 - 10 = 1   (1st sync: chunk written)
delta2 = after2 - after1 = 11 - 11 = 0   (2nd sync of unchanged file: NO new node)
progress2 = 1                            (file WAS processed; produced 0 writes)
```

The second sync added **0** nodes: `#isDirty` hash-compares the incoming chunk
against the stored node and **skips** it (skipped == chunk count → no re-embed, no
write). The lazy `reason:"search"` sync the host fires before every search is
therefore idempotent and cheap, as designed.

---

## 4. Linux loader smoke — **honest ABSENT (not a stub)**

Bounded filesystem check: the only native binary present anywhere is
`pluresdb-node.win32-x64-msvc.node`. There is **no Linux `.node`** in
`node_modules/@plures/pluresdb-native` (no per-triple package, no sibling) nor in
the `file:` source crate `C:\Projects\pluresdb\crates\pluresdb-node`. Loading the\naddon on the `arca-e2e-node*` docker nix images would fail on a missing binding
(`Cannot find native binding`), which is a packaging fact, not a loader bug, and
would burn time for zero signal.

**Linux native binary is not present in this install; the loader code path is
platform-generic** (the shim's `bindingFileName()` already maps
`linux-x64-gnu` / `linux-arm64-gnu`, and the source-crate fallback walk is
OS-neutral) **but is UNVERIFIED on Linux this pass.** Verifying it requires a
Linux-built `.node` (cross-compile / CI artifact), which is out of scope for QA.

---

## QA-found defect (for follow-up)

**DEF-PATHB-1 — native alpha `put()` does not auto-embed (semantic recall of
synced memory is degraded to text-only).**
- **Severity:** real limitation, **not** a blocker for the write→recall contract
  (text recall works), **but a blocker for semantic/vector recall of synced
  memory** and therefore for any P1 vector/graph feature over freshly-written
  nodes.
- **Locus:** `@plures/pluresdb-native@2.0.0-alpha.1` `PluresDatabase.put()`
  auto-embed path (NOT the plugin; the plugin calls `put` per the documented
  contract).
- **Evidence:** `test/qa-vector-probe.mts` (numbers above): embedder works
  (384-dim), `put` stores no vector, `vectorSearch` of the put node = 0 in-proc
  and after reopen, while `putWithEmbedding` control = 1 hit and text search = 2
  hits.
- **Fix options:** (1) fix native `put()` auto-embed (preferred, zero plugin
  change); or (2) plugin writes via `putWithEmbedding(id, data, db.embed([text])[0])`
  — proven to restore vector recall. **Deferred to verify/P1 as a design call;
  not applied in QA.**

No new stubs were introduced (C-NOSTUB-001 respected). The deferred fix is an
honest deferral with a concrete, tested plan — not a placeholder.

---

## Files added (QA only — no `src/` changes)

- `test/qa-vector-probe.mts` — standalone vector root-cause probe (embed/get/
  getWithMetadata/buildVectorIndex/vectorSearch + putWithEmbedding control +
  cross-process reopen leg).
- `test/qa-store-probe.mts` — shipped-path real-store-dir write→recall
  (cross-process) + double-sync idempotency driver.

## How to reproduce

```
# vector root-cause (verdict a, with numbers):
npx tsx test/qa-vector-probe.mts

# real-store-dir cross-process write+recall + idempotency:
npx tsx test/qa-store-probe.mts
```
(Both set/inherit `NAPI_RS_NATIVE_LIBRARY_PATH` to the win32 source-crate
`.node` so they run standalone; the shipped loader shim finds it on its own via
the source-crate walk during the canonical `pnpm test` gate.)

---

# DEF-PATHB-1 FIX (implement-fix stage, 2026-06-29)

Stage: **implement-fix** (Path B) · applies the QA-proven option (2) plugin-side
fix · host: Windows (`kbristol-DevBox`, pwsh 7, node v26) · native unchanged
(`@plures/pluresdb-native@2.0.0-alpha.1`).

## What changed (the ONLY file touched: `src/pluresdb.ts` write path)

The write path now **embeds text explicitly and persists the vector via
`putWithEmbedding`** instead of relying on the native alpha's non-functional
`put` auto-embed. Read path, `sync()` logic in `memory-capability.ts`, the node
schema/ids, and `seedStoreForTests` were **NOT** touched.

Three small private helpers + a re-route:

- `#embeddableText(data)` — picks the embeddable string using the SAME field
  priority the read path derives on: `content` → `text` → `summary` (in practice
  `sync()` always writes `content`). Empty string when none present.
- `#embedForWrite(db, text)` — `db.embed([text])[0]`, returns the vector ONLY if
  it is a non-empty row whose length matches `db.embeddingDimension()` (when the
  native reports a concrete dim). Returns `null` on empty text, embed failure, or
  shape mismatch. Never throws, never fabricates.
- `#writeNode(db, id, data)` — if `#embedderAvailable === true` and a vector is
  produced, `db.putWithEmbedding(id, data, vec)`; otherwise honest text-only
  `db.put(id, data)` (degraded/no-embedder/empty-text/embed-fail).
- `put()` and `store()` now call `#writeNode` **after** the existing `#isDirty`
  skip check (dirty FIRST, then embed+put only the dirty nodes — unchanged nodes
  are never embedded, so the lazy pre-search sync stays cheap). `store()` still
  calls `buildVectorIndex()` once best-effort after the batch; its return value
  is NOT relied upon (the alpha returns 0 even when putWithEmbedding vectors are
  searchable — see QA caveat above).

Degraded path (`#embedderAvailable === false`) is byte-for-byte the old behavior
(plain `put`, text-only) — the honest degraded write, unchanged.

## Before → After (verbatim vector-recall hit counts, synced node)

| Signal (synced node, queried by vector) | BEFORE (QA) | AFTER (fix) |
|---|---|---|
| `db.vectorSearch(embed(query)[0], 5, 0.0)` hit count for a node written via shipped `sync()` | **0** | **1** |
| sentinel node present in vector hits | **no** | **yes** (`mem:session:vecfix-session:0`) |
| sentinel vector score | n/a (absent) | **0.7957** |
| shipped `manager.search()` recall path for the synced sentinel | `via:text` | **`via:vector`** (score 0.7957) |
| GATE C shipped-path sentinel recall | `via:text` | **`via:vector`** (score 0.8565) |

The `putWithEmbedding` control in the original QA already returned 1 hit; the fix
makes the **default shipped write path** behave like that control. Semantic recall
of freshly-synced memory now genuinely works (not text-only).

## Verification (real probes, bounded output)

- **Canonical gate** `pnpm run build` (exit 0) + `pnpm test`: **GATE A / B / C all
  PASS** (`=== RESULT: ALL CHECKS PASSED ===`). Notably GATE C's cross-process
  read leg now recalls the just-synced sentinel **`via:vector`** (score 0.8565)
  where pre-fix it was `via:text` — same shipped `sync()` path, no assertion
  weakened (GATE C already permitted vector-or-text; it now takes the vector
  branch).
- **Dedicated probe** `test/qa-vector-after-fix.mts` (throwaway), two processes:
  write leg `sync()`s a sentinel through the SHIPPED capability (`delta:1`); a
  SEPARATE process (lock released) calls `db.vectorSearch(db.embed([query])[0],
  5, 0.0)` DIRECTLY (the same low-level call as the QA control) →
  `vectorHitCount:1`, top id `mem:session:vecfix-session:0`,
  `sentinelInVector:true`, score `0.7957`; the shipped `manager.search()` leg
  reports the same sentinel `via:vector`. Driver prints `VECFIX_RESULT: PASS`.
  Query (`"where is the disaster recovery rehearsal held"`) shares no long
  verbatim phrase with the node, so the hit is a genuine semantic match.

```
# DEF-PATHB-1 fix verification (vector recall through shipped sync()):
npx tsx test/qa-vector-after-fix.mts        # -> VECFIX_RESULT: PASS
```

NO STUBS (C-NOSTUB-001): the fix is a real implementation; the text-only
fallback is honest degraded behavior (only when no embedder / no text), not a
faked vector. No fabricated results.

