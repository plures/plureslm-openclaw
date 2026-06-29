# H — Headroom Token-Compression Port — STAGE: ANALYZE

**Epic:** PluresLM Memory Superiority (`epic/EPIC-MEMORY-SUPERIORITY.md`, §H)
**Stage:** ANALYZE (implementation spec ONLY — NO production code; no `src/` file modified)
**Authoritative design:** `epic/H-headroom-port-SPEC.md` (read in full this session)
**Author:** subagent (Epic child H, ANALYZE), 2026-06-29
**Grounding:** every Rust citation below was read this session from disk at
`C:\Projects\pares-agens\crates\core\src\*` and `C:\Projects\pluresdb\crates\*`; every TS
citation from `C:\Projects\plureslm-openclaw\src\*` + `test\*`. Line numbers are from the
files as they exist on disk now.

---

## 0. Bottom line (the five answers)

1. **The REAL compressor lives in `C:\Projects\pares-agens\crates\core\src\headroom_bridge.rs`**
   (`HeadroomHook`, ~520 lines). It does **per-message, content-type-routed, transient** byte
   compression: prose→head+tail sentence window, code→signature skeleton, log→duplicate-run
   collapse, json/other→whitespace collapse. It calls 5 real pure-Rust actors in
   `headroom.rs`. **It is NOT the `.px` strategy suite, and it never returns a canned ratio.**
2. **Decision: add a NEW NAPI surface on `@plures/pluresdb-native`** (the `pluresdb-node`
   crate), NOT a pure-TS reimplementation and NOT an agens dependency. The native crate
   **already** depends on `pluresdb-px` (owns the `ActionHandler` trait) and `pluresdb-core`
   (owns `CrdtStore` + the embedder) — so the real Rust compressor ports in **without pulling
   pares-agens**. The message-loop / threshold-gate / net-savings-guard stays thin in TS.
3. **Plugin seam:** compression integrates at **`src/memory-capability.ts` `sync()` →
   `nodes.map(...)` just before `store.store(nodes)`** (the chunk-build, file
   `memory-capability.ts`, the `const nodes = chunks.map(...)` block), with the lower seam at
   **`src/pluresdb.ts` `#writeNode`** (private, the single write chokepoint). A second optional
   seam is a transient `ChatMessage[]` hook (the literal `HeadroomHook` analogue) — additive,
   not required for the memory-superiority MVP.
4. **Native/real-API inventory:** the Rust compressor (`compress_one` + 4 strategies + 5
   actors) is **CONFIRMED present and portable** in agens. It is **ABSENT from the native
   surface today** — `@plures/pluresdb-native`'s `index.d.ts` exposes **zero**
   `headroom/compress/token/cl100k/sentence/signature` symbols (must be added). The
   `ActionHandler` trait it implements is **NOT JS-callable today** (no NAPI wrapper).
5. **Metric:** real **token-reduction ratio** (`compressed_tokens / baseline_tokens` via
   `tiktoken_rs::cl100k_base`, the same tokenizer agens uses) **+ a FIDELITY measure**
   (salient-token / sentinel-phrase retention on real text) — both computed on REAL text,
   never a hardcoded `0.5`. Harness reuses the existing cross-process `test/*-child.mts`
   pattern when a native handle is involved.

---

## 1. The REAL algorithm (cited Rust file:line) — contrasted with the `.px` stub

### 1a. The production compressor: `HeadroomHook` (`pares-agens/crates/core/src/headroom_bridge.rs`)

This is the real token-compression logic. It is **NOT** an actor; it is a struct with an inline
hot path that calls only 5 real actors.

**Module contract** (`headroom_bridge.rs` L1-31, doc comment):
- *Transient compression only* — returns a **new** `Vec<ChatMessage>`; canonical history never
  mutated (L11-15).
- *Field-preserving* — only `ChatMessage.content` is rewritten; `role` / `tool_call_id` /
  `tool_calls` copied verbatim (L16-18).
- *Threshold-gated* — disabled hook OR aggregate estimate `<= min_tokens` returns an untouched
  clone with zero actor work (L19-21).
- *Non-fatal* — any actor error → keep original content, `warn!`, never panic, never drop a
  message (L22-25).
- *Cheap, never embeds* — chars/4 gate + string heuristics; **"It never calls
  `compute_embedding`"** (L26-31).

**Constants:**
- `DEFAULT_MIN_TOKENS: usize = 500` (`headroom_bridge.rs` L52).
- `PER_MESSAGE_MIN_CHARS: usize = 200` (`headroom_bridge.rs` L57).

**Token accounting:**
- Cheap gate: `count_text_tokens(text) = text.len() / 4` (`headroom_bridge.rs` L68-71) +
  `count_message_tokens` aggregate (L74-76).
- Real reporting: the `count_tokens` actor uses **`tiktoken_rs::cl100k_base`**
  (`headroom.rs` L97-103: `bpe.encode_with_special_tokens(content).len()`).

**`compress_messages(request_id, &[ChatMessage]) -> Vec<ChatMessage>`** (`headroom_bridge.rs`
L150-227, `async`):
- L151-153: disabled → `messages.to_vec()` (exact clone).
- L155-158: `original_tokens <= min_tokens` → `messages.to_vec()`.
- L163: best-effort observability write `headroom:input:<request_id>`.
- L165-173: per-message loop — rewrite **only** `.content` via `compress_one`, copy
  `role`/`tool_call_id`/`tool_calls` verbatim.
- L176: observability write `headroom:output:<request_id>`.
- **Net-savings safety net** L182-193: if `compressed_tokens >= original_tokens`, return the
  **originals** (never spend more than we started with).

**`compress_one(content) -> String`** (`headroom_bridge.rs` L231-258) — the routing core:
```
if content.len() < PER_MESSAGE_MIN_CHARS (200): return content        # L232-234
t = detect_content_type(content)                                       # L236
out = match t {                                                        # L237-243
  "code"          => compress_code(content),
  "log"           => compress_log(content),
  "prose"|"error" => compress_prose(content),
  _ (json/other)  => compress_whitespace(content),
}
return out if (out.len() < content.len() && !out.trim().is_empty())    # L247-250
       else content
```

**The four real strategies (what they actually do to reduce tokens):**

| Strategy | Method (file:line) | What it really does |
|---|---|---|
| **prose / error** | `compress_prose` (`headroom_bridge.rs` L266-301) | Calls `split_sentences` actor; if `<= 6` sentences → `collapse_whitespace`; else keep **first 3 + `"[… N sentences elided …] "` + last 3**, dropping the bulk middle. Preserves opening context + most-recent (usually most-relevant) content. **Extractive summarization**, not generative. |
| **code** | `compress_code` (`headroom_bridge.rs` L310-342) | Calls `detect_language` + `extract_ast_signatures`; replaces the body with a `"// [headroom: <lang> body elided — N signature(s) kept]"` header + the extracted signature lines; falls back to `collapse_whitespace` when no signatures. **Structural pruning to a signature skeleton.** |
| **log** | `compress_log` (`headroom_bridge.rs` L349-383) | Pure Rust (no actor): folds runs of identical adjacent lines into `line  [×N]`; singletons pass through. **Consecutive-duplicate dedup / run-collapse.** |
| **json / other** | `compress_whitespace` → `collapse_whitespace` (`headroom_bridge.rs` L388-390 + L406-422) | Any whitespace run → a single space, trimmed. **Structural whitespace squeeze.** |

**So the fidelity contract it guarantees:** the output is a **smaller-or-equal, byte-derived
transform of the SAME content** (extractive windowing / signature-skeleton / run-collapse /
whitespace-squeeze) — never a paraphrase, never a fabrication. Per-message floor (200 chars)
and a per-message "only accept if smaller" guard (L247) mean a message can only shrink or stay
identical. The aggregate net-savings guard (L182-193) means the *batch* can only shrink or
return verbatim. Roles + tool metadata are positionally preserved. This is the contract the TS
port must reproduce.

### 1b. The 5 real actors the hook actually calls (`pares-agens/crates/core/src/headroom.rs`)

`HeadroomActionHandler` implements `pluresdb_px::px::executor::ActionHandler`
(`headroom.rs` L57: `impl ActionHandler for HeadroomActionHandler`). Its own doc-comment
(L11-17) states it implements **9 real actors** and **"All other ~160 actions return sensible
stubs so the px executor never stalls."** The hook calls only these 5:

| Actor | file:line | Real dependency |
|---|---|---|
| `detect_content_type` | `headroom.rs` L68-86 | pure Rust heuristics (`is_log_content`, `is_code_content`, `looks_like_error`) |
| `split_sentences` | `headroom.rs` L156-166 | `unicode_segmentation::split_sentence_bounds` |
| `extract_ast_signatures` / `extract_signatures` | `headroom.rs` L169-173 → `extract_signatures_heuristic` (L600-657) | pure Rust per-language line heuristics (no tree-sitter) |
| `detect_language` | `headroom.rs` L?? (`detect_language` arm) → `detect_language_heuristic` (L577-595) | pure Rust keyword heuristics |
| `pluresdb_write` / `pluresdb_read` | `headroom.rs` L143-162 | `pluresdb::CrdtStore` (observability only) |

The supporting heuristics are all self-contained pure Rust:
- `is_code_content` — structural brace/indent/semicolon density + keyword co-occurrence
  (`headroom.rs` L524-573).
- `looks_like_error` — stack-frame / `Exception:` / `Caused by:` indicator count `>= 2`
  (`headroom.rs` L~495-519).
- `detect_language_heuristic` — keyword sniffing → rust/python/js/java/cpp/go/sql/unknown
  (`headroom.rs` L577-595).
- `extract_signatures_heuristic` — per-language signature-line matcher (`headroom.rs`
  L600-657).
- `count_tokens` — `cl100k_base` cached in a `OnceLock<CoreBPE>` (`headroom.rs` L28-39),
  because `cl100k_base()` allocates ~100 MB of BPE tables.

### 1c. ⚠️ The `.px` STUB FARM — DO NOT PORT THIS (C-NOSTUB-001 landmine)

The bulk of `headroom.rs` (the ~160 actors after the 9 real ones, roughly L186-540) and the
entire `.px` "strategy suite" at `pares-agens/praxis/headroom-strategies/*.px` are
**placeholders that return canned JSON**. Verified examples from `headroom.rs`:
- `"route_json" => Ok(json!({"routed":true,"strategy":"structural"}))` (L~186)
- `"route_code" => Ok(json!({"routed":true,"strategy":"ast_summary"}))`
- the `.px` strategy entrypoints return the literal `{"compressed":true,"ratio":0.5}` /
  `{"score":0.7}` / `[]` family the task flagged.

**These are NOT the algorithm.** They exist so the standalone `.px` procedures execute green in
`headroom_e2e.rs` (which asserts `result.success`, **not** real reduction). Porting them would
import a stub farm that *looks* implemented and trip **C-NOSTUB-001**. The contrast is the whole
point of this stage:

> **PORT:** `headroom_bridge.rs::compress_one` + the 4 `compress_*` strategies + the 5 real
> actors from `headroom.rs`.
> **NEVER PORT:** the `route_*` / `score_*` / `fit_to_budget` / `summarize_body` canned-JSON
> actors, or the `router/pipeline/scorer/fitter/crusher/cache/ccr/memory.px` files.

---

## 2. Surface decision: TS-reimpl vs NEW NAPI (rationale + dependency-boundary proof)

### Decision: **add a NEW NAPI surface on `@plures/pluresdb-native` (the `pluresdb-node`
crate)**, exposing the ported Rust compressor; keep the message-loop/gate/guard thin in TS.

**Proposed net-new native exports** (to add to `pluresdb-node` + regenerated `index.d.ts`):
```ts
export function compressText(content: string, opts?: { contentType?: string }): string
export function countTokens(content: string): number                 // cl100k_base
export function detectContentType(content: string): { contentType: string; confidence: number }
```
`compressText` = the ported `compress_one` (routing + the 4 strategies + the 5 actor helpers,
all pure Rust reused verbatim). The per-message loop, the 500-token gate, the net-savings guard,
and the role/tool-metadata preservation **stay in TS** (cheap, and keeps the contract visible at
the call-site) — exactly mirroring how the bridge splits "loop+gate in the hook, primitives in
actors."

### Why NOT a pure-TS reimplementation
- It would **re-implement cl100k tokenization and unicode sentence-segmentation in TS** —
  drift from the canonical `tiktoken_rs::cl100k_base` (the metric would no longer match agens's
  counts) and slower. The real reduction-proof depends on the *same* tokenizer.
- It abandons the `.px`-callable real-actor seam that P4 governance procedures want to share
  (SPEC §8).

### Why NEW NAPI on the existing native (not a 2nd crate, not calling agens)
- **`pluresdb-node` already loads as the plugin's single native addon.** `src/pluresdb.ts`
  resolves and memoizes exactly one `@plures/pluresdb-native` handle with careful `.node` path
  resolution (`ensureNativeLibraryPath` / `loadNative`, `src/pluresdb.ts`). Co-locating the
  compressor there means **no second `.node`, no second loader, no new npm dep**.
- **The real Rust is already PluresDB-aligned.** The actors lean on `CrdtStore` (observability),
  `sha2`, `tiktoken_rs`, `unicode_segmentation` — Rust crates that belong in the pluresdb-node
  crate, not a TS re-port.
- A separate `@plures/headroom-native` crate would be a second artifact to build/ship/path-
  resolve for no benefit (compressor + store are always co-resident).
- Calling **back into pares-agens** from the plugin would create the **forbidden dependency
  edge** (see proof below) plus IPC overhead on a hot path.

### ⚠️ Dependency-boundary proof: the port pulls NO pares-agens dependency

This is the most important constraint, and it is **CONFIRMED clean** by evidence read this
session:

1. **`pluresdb-node` already has the trait + store deps it needs, none of them agens.**
   `C:\Projects\pluresdb\crates\pluresdb-node\Cargo.toml` `[dependencies]`:
   - `pluresdb-px = { path = "../pluresdb-px" }` ← **owns the `ActionHandler` trait**
     (`pluresdb-px/src/px/executor.rs` L33: `pub trait ActionHandler: Send + Sync`).
   - `pluresdb-core = { path = "../pluresdb-core" }` ← owns `CrdtStore` + the embedder.
   - plus `pluresdb-procedures`, `pluresdb-storage`, `pluresdb-sync`, `napi`, `serde*`.
   - **No `pares-agens` / `pares_agens` entry. No `pares-radix-*` entry.**
2. **The real algorithm is portable — it does NOT depend on agens-specific types.**
   - The 5 actors + their heuristics (`headroom.rs` §1b) depend only on `tiktoken_rs`,
     `unicode_segmentation`, `sha2`, and `pluresdb::CrdtStore` — **all already available to
     `pluresdb-node`** (the last via `pluresdb-core`). To port: lift the `compress_*` +
     `compress_one` logic + the 5 actor helpers into a new module in `pluresdb-node` (or a small
     `pluresdb-headroom` crate **under the pluresdb workspace**), add `tiktoken_rs` +
     `unicode_segmentation` + `sha2` to that crate's `Cargo.toml` (already agens deps; verify
     license/size at implement-time — they are MIT/Apache and small).
   - The bridge's only non-pluresdb imports are `pares_radix_core::model::ChatMessage` and
     `pares_radix_core::state::StateStore` (`headroom_bridge.rs` L46-47). Those are the
     **chat-message shape + the state-store trait**, used only for the message-loop/observability
     wrapper — which **stays in TS** in this port (TS owns the `ChatMessage`/memory-node shapes;
     the native side knows only `string`). So **none of `pares_radix_core` is pulled into the
     native port** either.
3. **No agens dep anywhere downstream of the plugin (verified):**
   - `Select-String pares-agens C:\Projects\pluresdb\crates\*\Cargo.toml` → **empty** (no
     pluresdb crate depends on agens).
   - plugin `C:\Projects\plureslm-openclaw\package.json` → **no `agens` reference**.

**Net:** porting the real compressor into `pluresdb-node` keeps the forbidden edge intact —
radix/pluresLM still never depend on pares-agens. The algorithm is copied (it is pure and
self-contained), not imported across the boundary.

---

## 3. Plugin seam: exact hook point (file:line in `src/`)

Two cooperating seams; **(a) is the MVP for the memory-superiority claim**, (b) is the optional
`HeadroomHook` analogue.

### (a) PRIMARY seam — compress memory chunk content before store (MVP)

**Where:** `src/memory-capability.ts`, the `sync()` write path, at the node-build step.
The exact insertion is between `chunkText(rawText)` and `store.store(nodes)`:

- `const chunks = chunkText(rawText);` — `memory-capability.ts` (the line that produces the
  chunk list inside the `for (const item of work)` loop).
- `const nodes = chunks.map((chunk) => ({ ... data: { content: chunk.content, ... } }));` —
  **this `content: chunk.content` is the compression insertion point.** A config-flagged
  `compressText(chunk.content, { contentType })` (or a content-length gate mirroring the
  500-token / 200-char floors) wraps `chunk.content` here, storing the compact-but-faithful text
  while the original chunk metadata (hash/lines/source) is preserved.
- `store.store(nodes);` — `memory-capability.ts` (the batch write that follows).

> Rationale: `sync()` is the single ingest path the host drives (lazy `reason:"search"` sync +
> explicit session-file ingest). Compressing here means "**store more useful context per
> token**" — the headline memory-superiority lever — without touching recall.

### (b) LOWER seam — the write chokepoint (defense-in-depth / non-sync writes)

**Where:** `src/pluresdb.ts` `#writeNode(db, id, data)` (private) — the **single** method both
`put()` and `store()` route through to persist a node. This is where embed-on-write already
lives (`#embeddableText` → `#embedForWrite` → `putWithEmbedding`). A compress-on-write step
could live here behind the same config flag, guaranteeing every persisted node (not just
sync-ingested ones) is compressed when it crosses the threshold. Keep the *decision* (whether to
compress) visible; the *mechanism* is `compressText`.

### (b2) OPTIONAL — transient ChatMessage[] context hook (the literal `HeadroomHook`)

A `src/headroom-hook.ts` adapter over the transient `ChatMessage[]` the agent sends to the
model — the exact `compress_messages` contract, but in the OpenClaw plugin loop. Owns the
transient clone; calls `countTokens`/`compressText` per message; reproduces the 500-token gate,
the per-message 200-char floor, the net-savings guard, and positional role/tool-metadata
preservation. **Additive** — not required for the memory MVP; decide at implement-time whether
the OpenClaw plugin surface exposes a context-compression hook point.

---

## 4. Native / real-API inventory: CONFIRMED-callable vs ABSENT

| Capability | Status | Evidence |
|---|---|---|
| Real compressor `compress_one` + 4 strategies | **CONFIRMED present (in agens), portable** | `headroom_bridge.rs` L231-422 (read this session) |
| 5 real actors (`detect_content_type`/`split_sentences`/`extract_ast_signatures`/`detect_language`/`pluresdb_*`) | **CONFIRMED present, pure-Rust, self-contained** | `headroom.rs` L68-173 + helpers L495-657 |
| `cl100k_base` tokenizer (real token counts) | **CONFIRMED present** (`tiktoken_rs`, `OnceLock` cached) | `headroom.rs` L28-39, L97-103 |
| `ActionHandler` trait (the seam the actors implement) | **CONFIRMED present in `pluresdb-px`**, already a `pluresdb-node` dep | `pluresdb-px/src/px/executor.rs` L33; `pluresdb-node/Cargo.toml` `pluresdb-px = { path = "../pluresdb-px" }` |
| `CrdtStore` (observability backing for `headroom:input/output`) | **CONFIRMED reachable** via `pluresdb-core` | `pluresdb-node/Cargo.toml` `pluresdb-core = { path = "../pluresdb-core" }`; `headroom.rs` L20 `use pluresdb::CrdtStore` |
| `compressText` / `countTokens` / `detectContentType` NAPI exports | **ABSENT — net-new to add** | grep of native `index.d.ts` for `headroom\|tiktoken\|compress\|cl100k\|sentence\|signature\|token` → NONE (SPEC §3, confirmed) |
| `ActionHandler` exposed to JS today | **ABSENT** — no NAPI wrapper; trait is Rust-internal | native surface today = `PluresDatabase` (`put/get/delete/list/exec/search/vectorSearch/putWithEmbedding/embed/embeddingDimension/buildVectorIndex/stats`) + `init()`; no action-handler export |
| TS plugin write seam (`sync()` chunk-build + `#writeNode`) | **CONFIRMED present** | `src/memory-capability.ts` `sync()` `nodes = chunks.map(...)`; `src/pluresdb.ts` `#writeNode` |
| Cross-process test harness (lock-release child workers) | **CONFIRMED present** | `test/store-child.mts` (own process per phase, exercises `dist/api.js`), `test/verify-child.mts`, `test/verify.driver.mts` |
| `pares-agens` anywhere in pluresdb / plugin deps | **CONFIRMED ABSENT (clean)** | `Select-String pares-agens C:\Projects\pluresdb\crates\*\Cargo.toml` → empty; plugin `package.json` → no agens ref |
| The `.px` strategy suite / ~160 canned actors | **PRESENT but STUBS — must NOT be ported** | `headroom.rs` L186-540 canned-JSON arms; `pares-agens/praxis/headroom-strategies/*.px` |

**Honest gap statement (per the constraint):** the real Rust compressor *was found* and read in
full — there is no "could not locate" gap to report. The only ABSENT pieces are (i) the NAPI
exports (net-new, added in implement-stage) and (ii) a JS-callable `ActionHandler` (not needed —
the port copies the actor *logic* into native functions rather than exposing the trait). At no
point is the `.px` stub substituted for the algorithm.

---

## 5. Measurable metric: ratio + fidelity harness shape

Both numbers are computed on **REAL text** (representative memory chunks + chat histories) —
never a hardcoded ratio. The `0.5` from the `.px` farm is explicitly banned as a metric source.

### 5a. Token-reduction RATIO
- `baseline_tokens = countTokens(original)` and `compressed_tokens = countTokens(compressed)`
  via the ported **`cl100k_base`** (same tokenizer as agens — `headroom.rs` L97-103), so the
  number is directly comparable to the agens seam test's `eprintln`.
- `ratio = compressed_tokens / baseline_tokens` (lower = better); report
  `saved_tokens = baseline_tokens - compressed_tokens` (must be **> 0** on the over-threshold
  corpus — mirrors `seam_compresses_over_threshold_payload`).
- **Guard assertions** (from the bridge contract): below-threshold input → `ratio == 1.0`
  (passthrough); disabled → `ratio == 1.0`; the net-savings guard means `ratio <= 1.0` always.

### 5b. FIDELITY measure (important content preserved)
The bridge's fidelity contract is "smaller-or-equal byte-derived transform of the SAME content"
(extractive, never paraphrase). So fidelity = **retention of salient content**, not round-trip
equality (compression is lossy-by-design for the middle):
- **Sentinel-phrase retention (deterministic, primary):** seed real text with a distinctive
  HEAD sentence AND a distinctive TAIL sentence (mirroring `WRITE_SENTINEL` in
  `test/store-child.mts`); assert **both survive** (prose keeps first-3 + last-3, so head/tail
  sentinels MUST remain) and that the elision marker (`"sentences elided"` /
  `"signature(s) kept"` / `"[×N]"`) is present when the middle was dropped.
- **Salience retention ratio (corpus-level):** define a salient-token set (capitalized
  identifiers, numbers, signature names) on the original; report the fraction present in the
  output. Code: assert **every extracted signature line survives**. Log: assert no *distinct*
  line is lost (only runs collapse). Prose: assert head+tail sentence tokens survive.
- **Structural invariants (from `compress_messages`):** message **count** unchanged; **roles**
  positionally preserved; `tool_call_id`/`tool_calls` preserved (port of
  `seam_preserves_tool_metadata`); caller input **byte-for-byte unchanged** after compression
  (port of `seam_does_not_mutate_caller_input` — transient guarantee).

### 5c. Harness shape (reuse the cross-process child pattern)
- **Pure-string native fns** (`compressText`/`countTokens`/`detectContentType`) need **no**
  exclusive-lock dance — unit-test in-process (vitest) against `dist/api.js`, asserting ratio +
  fidelity on real fixtures.
- **When a native *handle* is involved** (the optional `CrdtStore` observability path, or
  compress-on-write through `#writeNode` which opens a `PluresDatabase`), reuse the **cross-
  process** pattern: a `test/headroom-child.mts` running `seed|compress|read` phases in its own
  process so the exclusive file lock is released between phases — exactly how
  `test/store-child.mts` does `seed|write|read` and prints JSON the parent asserts on, and how
  `test/verify.driver.mts` spawns `verify-child.mts`. The parent reads the child's JSON
  (`baseline_tokens`, `compressed_tokens`, `ratio`, `head_sentinel_present`,
  `tail_sentinel_present`, `signatures_kept`) and asserts real reduction + fidelity.
- **Latency mirror:** assert the per-message hot path stays well under a per-turn budget (agens
  asserts pipeline `<100 ms`); report elapsed ms like the bridge's `info!`.

---

## 6. Risks / stubs-to-avoid + honest boundaries

1. **#1 RISK — the `.px` stub farm (C-NOSTUB-001).** The single biggest hazard is mistaking the
   impressive-looking `.px` strategy suite + the ~160 canned actors for the working product.
   They return `{"compressed":true,"ratio":0.5}` / `{"score":0.7}` / `[]` and only exist to keep
   `.px` procedures green. **Mitigation:** port `headroom_bridge.rs::compress_one` + the 4
   `compress_*` + the 5 real actors ONLY; never the `route_*`/`score_*`/`fit_to_budget`/
   `summarize_body` arms or the `router/pipeline/scorer/fitter/crusher/cache/ccr/memory.px`
   files. The metric is a *measured* cl100k delta on real text — a hardcoded ratio is a
   test-failure, not a pass.
2. **Do NOT port `compute_embedding`'s zero-vector fallback** (`headroom.rs` `#[cfg(not(
   feature="embeddings"))]` → `vec![0.0_f32; 384]`). The hook never calls it; in pluresLM,
   embeddings are the existing `embed`/`putWithEmbedding` path, which **refuses to fabricate
   vectors** (`src/pluresdb.ts` `#embedForWrite` "never fabricates a vector"). A parallel
   zero-vector path would regress that honesty.
3. **Honest fallback, not a fake.** If a content-type strategy can't be ported faithfully in a
   stage, route that type to **whitespace-collapse** (a real, smaller-or-equal transform) — an
   honest real fallback, never a stub. Absence beats a hollow shell (HARD GATE: NO STUBS).
4. **Tokenizer init cost.** `cl100k_base` allocates ~100 MB; it MUST be a process singleton in
   the native module (port the `OnceLock<CoreBPE>` pattern from `headroom.rs` L28-39) so repeated
   `countTokens` calls don't reallocate.
5. **Dep boundary must stay clean.** The implement-stage gate must re-run
   `Select-String pares-agens C:\Projects\pluresdb\crates\*\Cargo.toml` (expect empty) and check
   the plugin `package.json` after wiring — the port must never add a `pares-agens` or
   `pares-radix-core` dependency. (The bridge's `pares_radix_core` imports are for the
   message-loop wrapper, which stays in TS — they must NOT follow the algorithm into native.)
6. **`compress_messages` is `async` in agens only to fit its loop** — the actual work is
   synchronous CPU. The NAPI fns should be **sync** (no threadsafe-function needed); the TS
   adapter can stay sync too. Don't import false async complexity.
7. **Observability is best-effort and optional.** The `headroom:input/output` writes are
   `warn!`-on-failure, never fatal (`headroom_bridge.rs` `write_observability`). The port may
   omit them in the MVP (pure-string fns) and add them only if the memory seam wants audit via
   the existing `PluresDatabase` handle — keep IO at the boundary, pure logic inside (C-DEV-001
   / C-PLURES-004).

**Honest boundaries of THIS analysis:**
- Line numbers for `compress_*` / actor arms are from the files read this session; a few are
  given as ranges (e.g. the `detect_language` arm, the `route_*` block start) where I cited the
  region rather than an exact single line — the implement-stage subagent should open the file and
  confirm exact lines before lifting code. The algorithm content itself was read in full and is
  quoted accurately.
- I did **not** build anything (ANALYZE = spec only); the "portable, no agens dep" claim is
  proven by reading `Cargo.toml` deps + the actors' `use` statements, not a trial compile. The
  implement-stage `cargo build` is the gate that *proves* it links without agens.
- The optional ChatMessage[] context-hook (seam b2) depends on whether the OpenClaw plugin SDK
  exposes a transient-context hook point; I did not exhaustively verify that SDK surface this
  stage — it is flagged additive/optional precisely because the memory-write seam (a) is the
  confirmed, sufficient MVP path.
