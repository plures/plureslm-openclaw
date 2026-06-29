# H — Headroom Token-Compression Port — DESIGN SPIKE / PORT ANALYSIS

**Epic:** PluresLM Memory Superiority (`epic/EPIC-MEMORY-SUPERIORITY.md`, §H)
**Status:** DESIGN ONLY — no production code in this spec. Path B files untouched.
**Author:** subagent (Epic child H), 2026-06-29
**Grounding:** all claims cite real source in `C:\Projects\pares-agens` and
`C:\Projects\plureslm-openclaw` read this session. Line ranges are from the files as they
exist on disk now.

---

## TL;DR (the four answers the task demanded)

1. **Real compression strategies Headroom implements (grounded):** the *production*
   compressor is `HeadroomHook` (`headroom_bridge.rs`), which does **per-message,
   content-type-routed, transient** compression:
   - **prose / error → extractive head+tail sentence window** (keep first 3 + last 3
     sentences, elide the middle) — `compress_prose`, bridge L≈232-272.
   - **code → AST-signature skeleton** (replace bodies with extracted fn/type signatures,
     language-detected) — `compress_code`, bridge L≈281-321.
   - **log → consecutive-duplicate-line run-collapse** (`line [×N]`) — `compress_log`,
     bridge L≈336-372 (pure Rust, no actor).
   - **json / other → whitespace collapse** (runs of whitespace → single space) —
     `compress_whitespace` / `collapse_whitespace`, bridge L≈381-383 + tail helper.
   - Token accounting: **`tiktoken_rs::cl100k_base`** for the *real* count actor
     (`count_tokens`, `headroom.rs` L≈97-103), and a **`chars/4` heuristic** for the cheap
     pre-gate (`count_text_tokens`, bridge L≈64-72). Content classification is heuristic
     (`detect_content_type`, `headroom.rs` L≈68-86). Content hashing is **SHA-256**
     (`compute_content_hash`, L≈89-95).
2. **Chosen home: (c) BOTH — but staged, and *one* engine, two call-sites.** A single
   compression engine, invoked (i) by the pluresLM plugin to compress memory **payloads
   before write/recall**, and (ii) as an OpenClaw **context-compression hook** on the
   transient `ChatMessage[]` before a model call. One-line why: the engine is identical
   (`text → smaller text`, content-type routed); only the *seam* differs (a memory node's
   `content` field vs a chat message's `content` field), so building two engines would
   duplicate logic and violate the "extract once" rule (AGENTS.md / ADR-0010).
3. **Rust↔TS boundary decision: port the compressor as a NAPI surface on
   `@plures/pluresdb-native` (a `Headroom`/`compress*` export), NOT a second crate and NOT
   an in-process call back into `pares-agens`.** Confirmed (grep, this session): the native
   `index.d.ts` currently exposes **zero** headroom/tiktoken/compress/token symbols — so this
   is net-new surface to add, co-located with the `PluresDatabase` the plugin already loads.
   Rationale: the plugin already resolves and loads exactly one native addon
   (`src/pluresdb.ts`); adding a compression export there means **no new dependency, no second
   `.node`, no agens dependency edge** (radix/pluresLM must never depend on agens — confirmed
   by `headroom_agent_e2e.rs` header).
4. **Single biggest port risk: the agens `.px` strategy layer is ~160 placeholder stubs, and
   the *production* `HeadroomHook` does NOT use them** — so "port Headroom" must port the
   **bridge's real per-message logic**, not the impressive-looking `router.px`/`pipeline.px`/
   `scorer.px`/`fitter.px` strategy suite, whose `HeadroomActionHandler` actors mostly return
   canned JSON (`headroom.rs` L≈186-540+). Porting the `.px` suite as-is would import a stub
   farm and trip **C-NOSTUB-001**. (Detail in §"Stubs-to-avoid".)

---

## 1. What Headroom does (cited)

Headroom is two cooperating pieces in `pares-agens`:

### 1a. `HeadroomActionHandler` — the `.px` ActionHandler (`crates/core/src/headroom.rs`, ~880 lines)

Implements `pluresdb_px::px::executor::ActionHandler` (`call(name, params) -> Result<Value>`).
Its own doc-comment (L11-16) states it implements **9 real side-effect actors** and that
*"All other ~160 actions return sensible stubs so the px executor never stalls."*

The **9 real actors** (verified, L56-185):

| # | Actor | What it really does | Real dep | Cite |
|---|-------|---------------------|----------|------|
| 1 | `detect_content_type` | heuristic: json (brace/bracket prefix), log, code, error, prose + confidence | pure Rust heuristics | L68-86 |
| 2 | `compute_content_hash` | `sha256:<hex>` of content | `sha2::Sha256` | L89-95 |
| 3 | `count_tokens` | exact token count | **`tiktoken_rs::cl100k_base`** (`encode_with_special_tokens`) | L97-103 |
| 4 | `compute_embedding` | 384-dim embedding **(feature-gated)** | `pluresdb::FastEmbedder` (`embeddings` feature); **returns 384 zeros without the feature** | L105-110 + L681-716 |
| 5 | `cosine_similarity` | dot / (‖a‖·‖b‖) | pure math | L112-124 |
| 6 | `split_sentences` | unicode sentence-boundary split | `unicode_segmentation::split_sentence_bounds` | L126-135 |
| 7 | `extract_ast_signatures` | heuristic per-language signature lines (no tree-sitter) | pure Rust heuristics | L137-143 + L604-668 |
| 8 | `pluresdb_read` (+aliases) | `CrdtStore::get` | `pluresdb::CrdtStore` | L145-152 |
| 9 | `pluresdb_write` (+aliases) | `CrdtStore::put` | `pluresdb::CrdtStore` | L154-162 |

Plus genuinely-real `pluresdb_query` (prefix scan, L165-174), `delete_from_pluresdb`
(L177-181), and a handful of real-ish helpers that hash/scan (`compute_prefix_hash`,
`count_ccr_entries`, `generate_ccr_ref`). The tokenizer is **cached in a `OnceLock`**
(`BPE`, L29-39) because `cl100k_base()` allocates ~100 MB of BPE tables.

The **~160 stub actors** (L186-540+) are the bulk of the file: `route_json`, `route_code`,
`execute_prose_compression`, `score_block`, `assign_severity`, `fit_to_budget`,
`align_cache_prefix`, `summarize_body`, `select_top_sentences`, `group_by_pattern`,
`store_for_retrieval`, … — each returns a fixed JSON literal
(`Ok(json!({"compressed":true,"ratio":0.5}))`, `Ok(json!([]))`, `Ok(json!({"score":0.7}))`,
etc.). They exist so the standalone `.px` strategy procedures *execute green* in
`headroom_e2e.rs`, **not** because they compute anything.

### 1b. `HeadroomHook` — the production compressor (`crates/core/src/headroom_bridge.rs`, ~520 lines)

This is the piece that actually shrinks payloads in production. Its design contract
(module doc, L1-48) is precise and is the real porting target:

- **Transient compression only** (L compress_messages): returns a **new** `Vec<ChatMessage>`;
  canonical history is never mutated. Applied to a throwaway clone immediately before the
  model call.
- **Field-preserving:** only `ChatMessage.content` is rewritten; `role`, `tool_call_id`,
  `tool_calls` copied verbatim (L compress_messages loop).
- **Threshold-gated:** disabled hook, or aggregate `chars/4` estimate `<= min_tokens`
  (default **500**, `DEFAULT_MIN_TOKENS` L≈51), returns an exact clone with zero work.
- **Non-fatal:** any actor error → keep original content, `warn!`, never panic, never drop a
  message. `compress_messages` does not return `Result`.
- **Net-savings safety net:** if compression *grew* tokens, it returns the originals
  (L≈198-214).
- **Per-message floor:** messages `< 200` chars (`PER_MESSAGE_MIN_CHARS`, L≈56) are left
  untouched (`compress_one`, L≈219-247).
- **Observability:** writes `headroom:input:<request_id>` and `headroom:output:<request_id>`
  serialized message slices through the handler's `pluresdb_write` actor (best-effort,
  L write_observability).

**Crucial:** `HeadroomHook` calls **only 5 of the real actors** — `detect_content_type`,
`split_sentences`, `extract_ast_signatures`, `detect_language`, and `pluresdb_write/read`.
Everything else in its hot path (head/tail windowing, run-collapse, whitespace collapse) is
**inline pure Rust in the bridge**. It never touches the ~160 stub actors and never calls
`compute_embedding` (module doc L24-26 "It never calls `compute_embedding`").

---

## 2. Compression strategies (the real, portable algorithm)

This is the algorithm to port (from `compress_one` + the four `compress_*` methods):

```
compress_one(content):
  if len(content) < 200: return content            # per-message floor
  t = detect_content_type(content)                  # json|log|code|error|prose
  out = match t:
    code         -> compress_code(content)          # signature skeleton
    log          -> compress_log(content)           # dup-run collapse
    prose|error  -> compress_prose(content)         # head+tail sentence window
    _ (json/oth) -> collapse_whitespace(content)    # whitespace runs -> 1 space
  return out if (len(out) < len(content) and out non-blank) else content
```

- **prose / error — extractive head+tail window:** split into sentences; if `<= 6` sentences
  just whitespace-collapse; else keep first 3 + `"[… N sentences elided …] "` + last 3.
  Preserves opening context + most-recent (usually most-relevant) content, drops the bulk
  middle. (bridge `compress_prose`.)
- **code — AST signature skeleton:** detect language, extract signature lines, emit
  `"// [headroom: <lang> body elided — N signature(s) kept]"` + the signatures; fall back to
  whitespace-collapse if no signatures. (bridge `compress_code`.)
- **log — consecutive duplicate run-collapse:** fold runs of identical adjacent lines into
  `line  [×N]`; singletons pass through. (bridge `compress_log`.)
- **json / other — whitespace collapse:** any whitespace run → a single space, trimmed.
  (bridge `collapse_whitespace`.)
- **token counting:** real reporting via **cl100k_base** (`count_tokens` actor); the *gate*
  uses **chars/4** so the hot path never pays for tokenization on a sub-threshold payload.

**Strategy NOT to port (yet):** the `.px` strategy suite (`router/pipeline/scorer/fitter/
crusher/cache/ccr/memory/code/prose/log` + `types/config` — 13 files at
`pares-agens/praxis/headroom-strategies/`). It is the *aspirational* design (budget fitting,
relevance scoring, CCR reference compression, cache-prefix alignment) but it is **backed by
stubs today** (see §Stubs-to-avoid). It is a future P-track, not the H port.

---

## 3. API contract

### `HeadroomHook` (the production seam — what the port must reproduce)

```
in_memory_hook(min_tokens) -> HeadroomHook                 # enabled
in_memory_hook_disabled()  -> HeadroomHook                 # passthrough
count_message_tokens(&[ChatMessage]) -> usize              # chars/4 aggregate

hook.compress_messages(request_id: &str, &[ChatMessage]) -> Vec<ChatMessage>
  # async in agens; pure CPU in practice. Contract:
  #  - len(out) == len(in); roles + tool_call_id + tool_calls preserved positionally
  #  - only .content may shrink
  #  - disabled OR aggregate chars/4 <= min_tokens  => exact clone
  #  - never grows net tokens (safety net); never panics; never drops a message
```

This contract is asserted verbatim by `headroom_agent_e2e.rs`
(`seam_compresses_over_threshold_payload`, `seam_does_not_mutate_caller_input`,
`seam_disabled_hook_is_passthrough`, `seam_below_threshold_is_passthrough`,
`seam_preserves_tool_metadata`). **The TS port must mirror these five tests.**

### `HeadroomActionHandler` (the `.px` action seam)

```
ActionHandler::call(name: &str, params: &Value) -> Result<Value, ExecutionError>
```

Real, portable actions worth exposing as a stable surface:
`detect_content_type`, `compute_content_hash`, `count_tokens`, `split_sentences`,
`extract_ast_signatures`, `detect_language`, `cosine_similarity`. These are the
`.px`-callable primitives that P4 governance procedures can reuse (see §P4 overlap). The
~160 stubs are **not** part of the contract and must not be ported as satisfied actions.

### Native (`@plures/pluresdb-native`) — what exists today (grounded, this session)

`index.d.ts` exports `class PluresDatabase` (L4) with: `put` (L29), `get` (L31),
`delete` (L35), `list` (L37), `exec` (L51), `search` (L53), `vectorSearch` (L60),
`putWithEmbedding` (L67), `embed` (L79), `embeddingDimension` (L81), `buildVectorIndex`
(L256), `stats` (L258); plus `function init()` (L370). **grep for
`headroom|tiktoken|compress|collapse|summar|cl100k|sentence|signature|token` → NONE.** So
the compression surface is entirely net-new to add here.

---

## 4. Where it lives (decision + rationale)

**Decision: (c) BOTH call-sites, ONE engine, ported as a native surface on
`@plures/pluresdb-native`, consumed by the pluresLM TS plugin.**

Two seams, identical engine:

- **(a) Memory-write/recall compression (plugin-invoked).** In `src/pluresdb.ts`'s write path
  (`#writeNode` / `store`), before persisting a node, optionally compress the node's
  embeddable/`content` text when it exceeds a threshold — storing a compact, still-faithful
  memory while preserving the original where retention rules require it. At recall, oversized
  snippets can be compressed before they re-enter a prompt. This is the memory-superiority
  angle: **store more useful context per token.**
- **(b) OpenClaw context-compression hook.** A hook over the transient `ChatMessage[]` the
  agent sends to the model — exactly the `HeadroomHook` seam, but in the OpenClaw plugin loop
  rather than agens's `run_model_loop`. The plugin owns the transient clone; the engine is the
  same `compress_one` routed by content type.

**Why one engine:** both seams are `text → smaller text`, content-type-routed, with the same
per-message floor, the same net-savings guard, and the same five-way routing. Building two is
duplication (AGENTS.md "extract first, then fix once"; praxis ADR-0010). One engine, two thin
adapters (a memory-node adapter and a chat-message adapter).

**Why native (not stay-in-agens, not new crate):**
- **No agens dependency edge.** radix/pluresLM must never depend on agens
  (`headroom_agent_e2e.rs` header: *"radix never depends on agens"*). Calling back into
  `pares-agens` from the plugin would create exactly that forbidden edge.
- **Native is already loaded once.** `src/pluresdb.ts` already resolves and memoizes a single
  `@plures/pluresdb-native` addon with careful `.node` path resolution. Co-locating the
  compressor there means **no second native artifact, no second loader, no new npm dep**.
- **It's already PluresDB-native + `.px`-aligned.** The real actors lean on `CrdtStore`,
  `sha2`, `tiktoken_rs`, `unicode_segmentation` — all Rust crates that belong in the
  pluresdb-node crate, not a TS reimplementation. (A pure-TS reimport of cl100k tokenization
  + unicode sentence segmentation would be a *re-port*, slower and drift-prone.)

**Rejected alternatives:**
- *Pure-TS port in the plugin.* Rejected: re-implements tiktoken + unicode segmentation in TS
  (drift from cl100k, perf), and abandons the `.px` actor seam P4 wants to share.
- *Separate `@plures/headroom-native` crate/package.* Rejected: a second `.node` to build,
  ship, and path-resolve in `src/pluresdb.ts` for no benefit — the compressor and the store
  share `CrdtStore`/embedder and are always co-resident.
- *Call agens via a binding.* Rejected: forbidden dependency edge + process/IPC overhead on a
  hot per-turn path.

---

## 5. Rust↔TS boundary

**Port target:** add a compression surface to the `pluresdb-node` crate, exposed through
`@plures/pluresdb-native`'s NAPI `index.d.ts`. Two shapes, pick per ergonomics during
implement-stage:

- **Stateless functions (preferred for the chat-message seam):**
  ```ts
  // NEW native exports (proposed):
  export function compressText(content: string, opts?: { contentType?: string }): string
  export function countTokens(content: string): number              // cl100k
  export function detectContentType(content: string): { contentType: string; confidence: number }
  ```
  `compressText` is the ported `compress_one` (routing + the four strategies, pure Rust,
  reusing the existing heuristics from `headroom.rs`). The **message-level loop, threshold
  gate, net-savings guard, and field preservation stay in TS** (they're cheap and keep the
  contract visible at the call-site), calling `countTokens`/`compressText` per message. This
  mirrors how the bridge already splits "loop+gate in the hook, primitives in actors."
- **Optional handle methods (for the memory seam, if it wants observability via the same
  store):** `PluresDatabase.compressNode(id, opts)` could compress-on-write using the same
  engine and write `headroom:input/output` keys through the existing CRDT store. Decide at
  implement-time; the stateless functions are the MVP.

**Boundary rules:**
- **IO at the boundary, pure logic inside** (C-DEV-001 / C-PLURES-004): the Rust compressor is
  pure `str → String`; persistence/observability is the only IO and stays optional.
- **No async needed across the boundary:** the bridge is `async` only to fit agens's loop;
  the actual work is synchronous CPU. The NAPI fns are sync (NAPI threadsafe not required).
- **Tokenizer init cost:** the `cl100k_base` `OnceLock` (~100 MB) must live as a process
  singleton in the native module (same pattern as `headroom.rs` L29-39) so repeated
  `countTokens` calls don't reallocate.
- **The TS adapters** (`memory-capability.ts` / a new `headroom-hook.ts`) own the
  `ChatMessage`/memory-node shapes; the native side knows only strings.

---

## 6. Port stages (analyze → implement → test → qa → verify)

Gated dev-lifecycle, each stage a subagent, no stage skips its gate (AGENTS.md / pares-radix
lifecycle). **This whole track waits on the P0 write-path verify gate** before *implementation*
(EPIC orchestration), but the design (this spec) is done now.

1. **analyze** — confirm the native crate build surface for adding NAPI fns; confirm
   `tiktoken_rs` + `unicode_segmentation` + `sha2` are acceptable deps in `pluresdb-node`'s
   `Cargo.toml` (they are already agens deps; check license/size). Decide stateless-fn vs
   handle-method shape. Output: a short ADR in the plugin's `praxis/decisions/`.
2. **implement** — port `compress_one` + the four `compress_*` strategies + `detect_content_type`
   + `detect_language` + `extract_signatures_heuristic` + `count_tokens` into the
   `pluresdb-node` crate as **real** Rust (reused verbatim from `headroom.rs`/`headroom_bridge.rs`
   — it's pure and self-contained). Expose `compressText`/`countTokens`/`detectContentType`
   via NAPI; regenerate `index.d.ts`. In TS, add a `headroom-hook.ts` (chat-message seam) and
   wire optional compress-on-write into `src/pluresdb.ts`'s `#writeNode` behind a config flag.
   **No stubs** — if a strategy can't be ported faithfully this turn, leave it absent and route
   that content-type to whitespace-collapse (an honest, real fallback), never a fake.
3. **test (pre-push gate)** — port the five `headroom_agent_e2e.rs` seam assertions to TS
   (vitest) against the new hook; port the real-actor unit assertions
   (`e2e_token_counting`, `e2e_detect_*`, `e2e_sentence_splitting`, `e2e_extract_signatures`,
   `e2e_hash_deterministic`) as native/TS tests. Rust side: `cargo test` + `cargo clippy
   -D warnings`. **Build the binary, run the binary** — exercise `compressText` from Node, not
   just `cargo test`.
4. **qa** — measure real reduction on representative memory payloads + chat histories (assert
   *strictly fewer* cl100k tokens, like the seam test prints), confirm transient/no-mutation,
   confirm tool-metadata preservation, confirm net-savings guard. Latency budget mirror:
   compression hot path stays well under a per-turn budget (agens asserts pipeline `<100 ms`).
5. **verify (closes the loop)** — run the plugin end-to-end in OpenClaw: a large context turn
   gets compressed before the model call (observability keys present, token count down), and a
   large memory write stores a compact-but-faithful node. Verify on the real target, not in a
   unit fixture (C-TEST-002 channel-agnostic verification; EPIC "verify-closes-loop").

**Reusable as-is vs needs re-port:**

| Piece | Disposition |
|-------|-------------|
| `compress_one` + 4 `compress_*` strategies (bridge) | **Reuse verbatim** (pure Rust, self-contained) — move into pluresdb-node |
| `detect_content_type`, `detect_language`, `extract_signatures_heuristic`, `count_tokens` (headroom.rs real actors) | **Reuse verbatim** |
| `cl100k_base` `OnceLock` tokenizer cache | **Reuse pattern** (process singleton in native) |
| Threshold gate + net-savings guard + per-message loop + field preservation (hook) | **Re-port to TS** (thin, keeps contract at call-site) — small, ~the hook minus the actors |
| Observability (`headroom:input/output` via CRDT) | **Re-port optional** — reuse existing `PluresDatabase` handle in TS, or a native handle method |
| `.px` strategy suite (router/pipeline/scorer/fitter/crusher/cache/ccr/memory) + ~160 actors | **DO NOT port now** (stub farm; future P-track) |
| `compute_embedding` actor | **DO NOT port** — the hook never calls it; embeddings already handled by the existing `embed`/`putWithEmbedding` native path |

---

## 7. e2e test contract (mirror `headroom_e2e.rs` + `headroom_agent_e2e.rs`)

The port is "done" only when these pass against the **real** ported engine (no fixtures
standing in for compression — C-TEST-002, and the explicit anti-stub note in
`headroom_agent_e2e.rs`: *"real reduction, not a `success:true` stub"*).

**Seam tests (TS/vitest, from `headroom_agent_e2e.rs`):**
1. `seam_compresses_over_threshold_payload` — build a multi-thousand-cl100k-token message
   (verbose prose + a big code block); after `compress`, assert **strictly fewer tokens**,
   message **count** unchanged, **roles** preserved positionally (`system`,`user`).
2. `seam_does_not_mutate_caller_input` — the caller's canonical `Vec`/array is byte-for-byte
   unchanged after compression (transient); the full uncompressed middle marker still present.
3. `seam_disabled_hook_is_passthrough` — disabled engine returns exact token-equal output.
4. `seam_below_threshold_is_passthrough` — tiny payload under the 500 gate passes through
   verbatim.
5. `seam_preserves_tool_metadata` — a `tool` message with `tool_call_id` keeps role +
   `tool_call_id` through compression.

**Real-actor primitive tests (native + TS, from `headroom_e2e.rs`):**
- `detectContentType`: json (`[{"id":1}]`→json conf>0.8), code (`fn main(){…}`→code),
   log (timestamped ERROR/WARN lines→log), prose (plain sentence→prose).
- `countTokens`: `""`→0; `"Hello world test tokens here."`→3..20.
- `splitSentences`: `"First. Second. Third."`→>=3.
- `extractSignatures`: 2 rust fns→>=2 signatures.
- `computeContentHash`: deterministic, `sha256:`-prefixed, differs on different input.

**Reduction-proof QA (from the seam test's eprintln):** print and assert
`baseline_tokens -> compressed_tokens` with a positive saved-token delta on a representative
corpus — the headline metric for the memory-superiority claim.

**Latency:** mirror `e2e_pipeline_latency_under_100ms` — the per-message compression hot path
stays comfortably under a per-turn budget.

---

## 8. P4 overlap (constraint-governed writes share the `.px` action seam)

P4 (`pxOnAction` constraint-governed writes) and Headroom are **both `.px` ActionHandlers** —
the EPIC §H/§P4 explicitly notes Headroom "slots into P4's governance direction" and "Aligns
directly with the Headroom port (also `.px`)." Specify the shared seam so they **compose, not
duplicate**:

- **Shared primitive actors.** P4 promotion/redaction/retention `.px` rules frequently need
   exactly Headroom's real primitives: `count_tokens` (budget/size gates), `compute_content_hash`
   (dedup/identity), `detect_content_type` (route a redaction rule), `split_sentences`
   (extractive retention). **Expose these once** (the native `countTokens`/`detectContentType`/
   etc. + the `.px`-callable real actors) and let P4 procedures call the same actions Headroom
   uses. Do NOT let P4 grow its own token-counter or hasher.
- **Compression as a governed action.** "Compress this memory before persisting" is itself a
   write-time policy. The clean composition: P4's `pxOnAction` is the **decision** ("this node
   exceeds budget / matches a compress-on-write rule → invoke compress"), and Headroom's
   `compressText` is the **mechanism**. P4 governs *whether/when*; Headroom performs *how*. The
   memory-write seam in §4(a) is precisely where a P4 rule would fire a compress action.
- **One observability namespace.** Headroom writes `headroom:input/output:<id>` through the
   CRDT store; P4 audit writes should sit alongside (e.g. `governance:…`) using the same store
   handle, so a governed-compress is auditable end-to-end without a second IO path.
- **Boundary discipline (shared):** both keep pure logic in `.px`/Rust and IO at the boundary
   (C-DEV-001/C-PLURES-004). Neither embeds policy in webhook/TS glue.

**Net:** Headroom contributes the *mechanism* (compression + the token/hash/classify
primitives); P4 contributes the *policy* (when to compress/redact/retain). Shared seam = the
set of real `.px` actions + the native `compress*`/`countTokens` exports, declared once.

---

## 9. Stubs-to-avoid (C-NOSTUB-001 flags)

The **single biggest hazard** of this port is mistaking the agens `.px` strategy suite for the
working product. Concrete avoidances:

1. **Do NOT port the ~160 placeholder actors** in `headroom.rs` (L186-540+) as if they were
   real. They return canned JSON (`{"compressed":true,"ratio":0.5}`, `[]`, `{"score":0.7}`,
   `{"summary":"// ..."}`). Porting them would import a stub farm that *looks* implemented and
   trips C-NOSTUB-001. They only exist to keep the standalone `.px` procedures from stalling in
   `headroom_e2e.rs` — which assert `result.success`, **not** real reduction.
2. **Do NOT port the `.px` strategy files** (`router/pipeline/scorer/fitter/crusher/cache/ccr/
   memory/code/prose/log.px`) as the H deliverable. Their `success:true` e2e is a
   stub-satisfying contract, not a compression contract. (They are a legitimate *future*
   design — budget fitting, relevance scoring, CCR — but as a separate, honestly-built track.)
3. **Do NOT carry over `compute_embedding`'s zero-vector fallback** (`headroom.rs` L709-715,
   384 zeros when the `embeddings` feature is off). In the pluresLM world, embeddings are the
   existing `embed`/`putWithEmbedding` native path (and pluresLM already refuses to fabricate
   vectors — `src/pluresdb.ts` "never a fabricated vector"). The Headroom port must not
   introduce a parallel zero-vector path.
4. **Honest fallback, not a fake:** if a content-type strategy can't be ported faithfully in a
   given stage, route that type to **whitespace-collapse** (a real, smaller-or-equal transform)
   and say so — never emit a `success:true`/canned-ratio placeholder. Absence/real-fallback is
   honest; a hollow shell is the banned form.
5. **`extract_ast_signatures` is heuristic, not tree-sitter** (headroom.rs comment L≈607-610
   "replace with real tree-sitter when grammar crates are available"). That is acceptable and
   *real* (it genuinely extracts signature lines) — but label it honestly as heuristic in the
   port; do not claim AST-grade parsing.
6. **Test against real behavior, not fixtures** (C-TEST-002): the reduction tests must run the
   actual ported compressor and assert *strictly fewer cl100k tokens*, exactly as
   `headroom_agent_e2e.rs` does. A test that asserts a canned `success:true` is itself a stub.

---

## Appendix — file map (read this session)

- `pares-agens/crates/core/src/headroom.rs` (~880 lines) — `HeadroomActionHandler`, 9 real
   actors + ~160 stub actors + heuristic helpers.
- `pares-agens/crates/core/src/headroom_bridge.rs` (~520 lines) — `HeadroomHook`, the
   production per-message compressor (the real port target).
- `pares-agens/crates/agens-plugin/src/headroom/mod.rs` — public surface re-export
   (`in_memory_hook`, `count_message_tokens`, `HeadroomActionHandler`, `HeadroomHook`).
- `pares-agens/crates/agens-plugin/tests/headroom_e2e.rs` — `.px` + real-actor e2e (the
   `success:true` strategy contract + real primitive assertions).
- `pares-agens/crates/agens-plugin/tests/headroom_agent_e2e.rs` — the **seam** e2e (real
   reduction, transient, field-preserving) — the contract the TS port mirrors.
- `pares-agens/praxis/headroom-strategies/*.px` (13 files) — the aspirational strategy suite
   (stub-backed today).
- `plureslm-openclaw/src/pluresdb.ts` — the TS↔native handle (`@plures/pluresdb-native`
   loader, `put`/`putWithEmbedding`/`embed`/`vectorSearch`/`search`/`stats`/`buildVectorIndex`).
- `plureslm-openclaw/node_modules/@plures/pluresdb-native/index.d.ts` — native surface;
   **grep confirms zero** headroom/tiktoken/compress/token symbols today.
- `plureslm-openclaw/epic/EPIC-MEMORY-SUPERIORITY.md` — Epic scope (§H, §P4, hard rules).

*End of spec. Design only — no production code; Path B files untouched.*