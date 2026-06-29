# H — Headroom Token-Compression Port — STAGE: QA (notes)

**Epic:** PluresLM Memory Superiority (`epic/EPIC-MEMORY-SUPERIORITY.md`, §H)
**Stage:** QA — hardening + adversarial/edge-case coverage of the native compressor
(`@plures/pluresdb-native` = crate `pluresdb-node`), native surface ONLY. The
`plureslm-openclaw/src/` TS seam remains a later stage and was NOT touched.
**Target repo:** `C:\Projects\pluresdb` (crate `pluresdb-node`).\n**Author:** subagent (Epic child H, QA), 2026-06-29.
**Builds on:** TEST gate PASS (commits ca04c76, 514bf62); 16 TEST-stage tests green.

---

## 0. Bottom line

- **`cargo test -p pluresdb-node` → 31 passed / 0 failed / 0 ignored** on my own run
  (16 TEST-stage + **15 new H-QA adversarial tests**). Re-verified on the post-doc-fix tree.
- **Adversarial JS probe vs the REBUILT native (`qa-probe.mjs`) → 209 checks, 0 fail, STATUS=PASS.**
  Real `.node`, real cl100k, real algorithm — exercises every boundary/degenerate/mixed case
  from JS exactly as a consumer would.
- **Net-savings guard under adversarial input: HOLDS UNIVERSALLY.** No input — empty, single
  char, all-whitespace, 20k-char single line, unicode/emoji/CJK, token-dense high-entropy blob,
  mixed prose+code+log, all-unique log — ever grows tokens, under auto-detect OR any of the 5
  forced types. Verified in Rust (`assert_safe` checks all 5 routes + auto) and in JS (209 checks).
- **Idempotency + determinism: VERIFIED.** Same input → byte-identical output (deterministic);
  `compress(compress(x))` never grows tokens and reaches a **fixpoint by pass 3** (pass2 == pass3)
  for prose/code/log — no oscillation, no progressive mangling.
- **Structure integrity (exact counts): VERIFIED PRECISELY.** Crafted inputs with known-exact
  expected counts: code keeps all 4 signatures (bodies dropped), log run-markers are EXACTLY
  `[×7]`/`[×4]` (no off-by-one, no spurious counts, distinct line not marked), prose elision says
  EXACTLY "34 sentences elided" (40 sentences − head 3 − tail 3), marker appears exactly once,
  exact head/tail kept, known middle sentence dropped.
- **Token fidelity vs known cl100k: VERIFIED.** `""`=0, `"hello world"`=2, `"\n"`=1, pangram=9 —
  matches real tiktoken cl100k_base, not an approximation.
- **One REAL defect found + FIXED (documentation defect, consumer-crashing):** the JSDoc example
  for `compressText` showed `compressText(src, { contentType: 'code' })`, which throws a NAPI
  `StringExpected` at runtime — the real signature takes a **bare string** (`'code'`). Fixed
  faithfully in `lib.rs` (source of truth) + rebuilt → regenerated `index.d.ts`/`index.js`.
- **No new stubs. No weakened assertions. No agens/radix dependency** (`cargo tree -p
  pluresdb-node` = zero pares-agens/pares-radix; only tiktoken-rs 0.6 + unicode-segmentation 1.12).

---

## 1. The one defect found — DOC DEFECT (consumer-crashing), disposition = FIXED

**Symptom:** following the published JS example crashes.
```
compressText('x'.repeat(300), { contentType: 'code' })
  -> Error [StringExpected]: Failed to convert JavaScript value
     `Object {"contentType":"code"}` into rust type `String`
```
The real NAPI signature (generated `index.d.ts`) is:
```ts
export declare function compressText(content: string, contentType?: string): string
```
i.e. `contentType` is a **bare optional string** (the natural NAPI mapping of `Option<String>`),
NOT an options object. The docstring in `lib.rs` (and therefore the generated `index.d.ts`/
`index.js`) advertised `{ contentType: 'code' }`. Any consumer copy-pasting the documented form
gets a hard runtime crash. This is a real, reproducible, ship-blocking-for-DX defect — found
only because QA drove the surface from JS the way a caller would (the Rust tests call
`compress_text(x, Some("code"))` directly and never hit it).

**Disposition: FIXED (faithful, minimal).** I corrected the **example** to match the real
signature and added an explicit warning, rather than changing the signature to an options object
(which would be a larger, less-faithful API change and is unnecessary — the bare string is the
correct, working contract). New docstring in `lib.rs`:
```js
const compact = compressText(longChunk);          // auto-detect
const code    = compressText(src, 'code');        // pin route (bare string)
```
plus: *"`contentType` is an OPTIONAL bare string … It is a plain string argument, NOT an options
object — passing `{ contentType: 'code' }` throws a NAPI `StringExpected` error."* Rebuilt the
native (`napi build --platform --release`, exit 0, 1m08s) so `index.d.ts`/`index.js` regenerated
with the corrected example. Verified the broken `compressText(src, { contentType: 'code' })` code
example is gone (the only remaining mention of `{ contentType: 'code' }` is the new warning that
it throws). **No behavior change** — the algorithm/guard were already correct; this was a docs
↔ signature mismatch only.

No other defect found. Zero panics, zero token-growth, zero structure corruption, zero
non-determinism across the entire adversarial matrix.

---

## 2. Adversarial cases probed + result (every case)

Driven from JS against the rebuilt `.node` (`qa-probe.mjs`, 209 checks) AND pinned as Rust
cargo tests in `headroom.rs` (`#[cfg(test)]`, 15 new `qa_*` tests). Each compress case asserts
the full safety contract: **no panic, returns a string, count_tokens finite & sane on input and
output, output tokens ≤ input tokens (net-savings guard), detector returns a known label.**

### 2.1 Boundary / degenerate inputs — ALL SAFE
| Case | Result |
|---|---|
| empty string `""` | safe; returned verbatim (sub-floor); `countTokens=0` |
| single char `"x"`, single CJK `"中"`, single emoji `"🚀"` | safe; returned verbatim (sub-floor); no codepoint-slice panic |
| single line (no terminator) | safe; no growth |
| all-whitespace (`"   \t  \n …"`) | safe; no growth |
| only-newlines (`"\n\n…"`) | safe; `countTokens("\n")=1`; no growth |
| **extremely long single line** (`"word "×4000`, ~20k chars, no sentence break) | safe; **no false elision** (≤6 "sentences" → whitespace-collapse path); no growth, auto + prose |
| **unicode / emoji / CJK** (`×40`, mixed multi-byte) | safe; **no byte-boundary panic**; output valid UTF-8; no growth |
| **token-dense high-entropy blob** (`"a1B2c3D4e5F6g7H8"×200`, 3200 chars) | safe; **guard returns it ≤ original under all 6 routes** — never a larger rewrite |
| empty + tiny (`"x\nx\nx\n"`) forced through each of the 5 types | safe under every forced type |
| 20k single line forced as prose / code / log | safe; no growth |

### 2.2 Mixed / adversarial content — ALL SAFE
| Case | Result |
|---|---|
| **prose with embedded ```rust fence** | safe; no growth; no corruption |
| **log with interleaved prose lines** | safe; no growth |
| **JSON with escaped `\n` in string values** | safe; whitespace-squeeze only; **keys preserved** (`"note"`,`"tags"`); **escaped `\n` NOT expanded** into real newlines (`line one\nline two` retained literally) |
| **"log" where EVERY line is unique** (40 distinct lines, no runs) | safe; **does NOT claim a collapse** — zero `[×N]` markers emitted; **lossless** (all 40 distinct events survive) |
| **prose with exactly 1 / 2 / 3 sentences** (head+tail window boundary, ≤6 → whitespace-collapse) | safe; **no elision marker inserted**; **each unique marker appears EXACTLY once** — never duplicated, never dropped |

### 2.3 Idempotency / determinism — VERIFIED (prose, code, log)
- **Determinism:** `compress(x) == compress(x)` byte-identical on a second call, all 3 types.
- **Idempotency:** `compress(compress(x))` (pass 2) **never grows tokens**; pass 2 == pass 3
  (**fixpoint reached by pass 3**) — the transform stabilizes, no oscillation or progressive
  mangling beyond the guard.

### 2.4 Structure integrity (exact counts) — VERIFIED PRECISELY
- **CODE** (crafted, 4 known signatures): `sig_alpha`, `sig_beta`, `SigGamma`, `sig_method_delta`
  ALL present in output; body lines (`body_alpha = a`, `body_beta = b`) ALL gone. No signature dropped.
- **LOG** (crafted: run of EXACTLY 7, then EXACTLY 4, then 1 distinct): output contains
  EXACTLY `[×7]` and `[×4]`; the distinct `INFO` line is present and **not** marked; **no
  off-by-one / spurious counts** (`[×6]`,`[×8]`,`[×3]`,`[×5]` all absent). `N` matches real run length.
- **PROSE** (40 distinct sentences): elision marker says EXACTLY `"34 sentences elided"`
  (40 − head 3 − tail 3 = 34); marker appears EXACTLY once; head `tokenZ 0/1/2.` and tail
  `tokenZ 37/38/39.` all present; middle `tokenZ 20.` absent. Elided-count reflects the real
  elided-sentence count.

### 2.5 Token-count fidelity (known cl100k) — VERIFIED
`countTokens("")=0`, `countTokens("hello world")=2`, `countTokens("\n")=1`,
`countTokens("The quick brown fox jumps over the lazy dog")=9`. Matches real tiktoken
cl100k_base (these are the canonical reference counts), confirming it is the REAL tokenizer,
not an approximation.

---

## 3. Net-savings-guard-under-adversarial-input verdict

**HOLDS UNIVERSALLY — no adversarial input grows tokens, under any route.** The Rust
`assert_safe` helper checks `count_tokens(out) <= count_tokens(input)` for the auto-detect path
**and** all 5 forced types on every boundary/degenerate/mixed input; the JS probe re-checks the
same from the consumer surface (209 checks). The token-dense high-entropy blob — the worst case
for a guard, since every strategy would otherwise emit a same-or-larger rewrite — is explicitly
returned ≤ original under all 6 routes (the `compress_one` "only accept if strictly smaller AND
non-empty, else original verbatim" contract). **Zero violations.**

## 4. Idempotency / determinism verdict

**PASS.** Deterministic (byte-identical on repeat) and idempotent (pass-2 never grows; fixpoint
by pass 3) for prose, code, and log. No nondeterminism from hashing/iteration order; no
oscillation between passes.

## 5. Exact-count structure-integrity results

**PASS, asserted precisely** (see §2.4): code = all 4 signatures kept / bodies dropped; log =
exact `[×7]` + `[×4]`, distinct line unmarked, no spurious counts; prose = exact "34 sentences
elided", marker once, exact head/tail kept, known middle dropped.

---

## 6. cargo test result

```
test result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.94s
```
Green on my own run (re-run on the post-doc-fix tree). 16 TEST-stage + 15 new H-QA adversarial
tests. No assertion weakened; the doc defect was fixed for real (corrected example + warning +
native rebuild), not hidden.

New tests added (`crates/pluresdb-node/src/headroom.rs`, `#[cfg(test)] mod tests`):
`qa_boundary_empty_and_tiny_inputs_are_safe`,
`qa_boundary_extremely_long_single_line_no_sentence_breaks_is_safe`,
`qa_boundary_unicode_emoji_cjk_is_safe_and_byte_boundary_clean`,
`qa_boundary_token_dense_blob_never_grows`,
`qa_mixed_prose_with_embedded_code_fence_is_safe`,
`qa_mixed_log_with_interleaved_prose_lines_is_safe`,
`qa_mixed_json_with_escaped_newlines_is_safe_and_keeps_keys`,
`qa_mixed_all_unique_log_lines_does_not_claim_collapse`,
`qa_mixed_prose_boundary_1_2_3_sentences_no_dup_no_drop`,
`qa_determinism_same_input_same_output`,
`qa_idempotency_second_pass_never_grows_and_reaches_fixpoint`,
`qa_structure_code_every_signature_present_bodies_dropped`,
`qa_structure_log_run_counts_are_exactly_accurate`,
`qa_structure_prose_elision_count_matches_real_elided_count`,
`qa_token_count_matches_known_cl100k_values`.

JS probe: `crates/pluresdb-node/qa-probe.mjs` (loads rebuilt `index.js`, 209 checks, STATUS=PASS).

---

## 7. Dependency boundary (QA gate) — CLEAN

`cargo tree -p pluresdb-node` → **zero `pares-agens`, zero `pares-radix`** in the dependency
tree. The real-algorithm deps `tiktoken-rs v0.6.0` + `unicode-segmentation v1.12.0` are present
(neither is agens). The forbidden edge (radix/pluresLM must NEVER depend on pares-agens) stays
intact. No new stubs introduced this stage (the QA tests are real assertions on real output;
the only code change is a docstring correction).

---

## 8. Gate status

QA (native surface scope): **PASS** — 31/31 real cargo tests green on my own run + 209/209
adversarial JS checks against the rebuilt `.node`; net-savings guard holds under every
adversarial input and route; idempotency + determinism verified (fixpoint by pass 3); exact-count
structure integrity verified precisely (code sigs / log `[×N]` / prose elision count); token
fidelity matches real cl100k; one real consumer-crashing doc defect found and FIXED faithfully
(bare-string example + warning + native rebuild); dependency boundary clean (no agens/radix);
no new stubs, no weakened assertions, no silent mangling.
