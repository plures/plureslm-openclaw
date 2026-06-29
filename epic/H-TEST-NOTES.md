# H — Headroom Token-Compression Port — STAGE: TEST (notes)

**Epic:** PluresLM Memory Superiority (`epic/EPIC-MEMORY-SUPERIORITY.md`, §H)
**Stage:** TEST — native Rust surface ONLY (the `plureslm-openclaw/src/` TS seam is a
later stage and was deliberately NOT touched here, per task scope).
**Target repo:** `C:\Projects\pluresdb` (crate `pluresdb-node` = `@plures/pluresdb-native`).\n**Authoritative spec:** `epic/H-ANALYZE.md`; implement notes: `epic/H-IMPLEMENT-NOTES.md`.
**Author:** subagent (Epic child H, TEST), 2026-06-29.
**Implement gate that this builds on:** PASS (commit ca04c76).

---

## 0. Bottom line

`cargo test -p pluresdb-node` → **16 passed / 0 failed / 0 ignored** (my own run; re-verified).
Release native rebuilt (`napi build --platform --release`, exit 0) and a node probe against
the rebuilt `.node` confirms the JS surface still reduces real cl100k tokens on every
content type.

**Detector verdict on the orchestrator's catch: FIXED (faithful superset).** The
repeated/level-prefixed log sample that previously returned `prose` now returns `log`,
both in a Rust unit test and through the rebuilt JS `detectContentType`. Two genuinely
ambiguous residual cases are pinned as **documented limitations** (not hidden): bare
repeated lines with no level/timestamp, and `[<timestamp>]`-prefixed logs. Both share the
exact gap in the real pares-agens detector, and in both the compressor is still correct +
lossless when the caller pins the type.

No assertions were weakened to pass. No stubs. Real algorithm + real tiktoken cl100k only.

---

## 1. Tests added (`crates/pluresdb-node/src/headroom.rs`, `#[cfg(test)] mod tests`)

The pre-existing 7 implement-stage tests were replaced/expanded to **16** real tests:

| Test | Asserts |
|---|---|
| `whitespace_collapse_shrinks` | collapse_whitespace unit behavior |
| `token_count_is_real_cl100k` | `count_tokens("hello world")==2`, `""==0` (real tiktoken) |
| `prose_keeps_head_tail_elides_middle_and_drops_tokens` | first 3 + last 3 sentinels survive, a middle sentence is gone, elision marker present, **real cl100k tokens drop** |
| `code_keeps_signatures_drops_bodies_and_drops_tokens` | every signature (`alpha`/`beta`/`struct Foo`/`impl Foo`/`total`) kept, bulky body lines pruned, header present, **tokens drop** |
| `log_collapses_runs_preserves_distinct_and_drops_tokens` | exact `[×30]`/`[×12]` run markers, distinct `INFO` line preserved + NOT marked, **tokens drop** |
| `log_singletons_pass_through_unmarked` | `beta [×2]` marked; `alpha`/`gamma` singletons unmarked (marker boundary) |
| `json_whitespace_squeeze_does_not_grow_tokens` | padded JSON shrinks in bytes, **tokens never grow**, keys preserved |
| `net_savings_guard_short_input_unchanged` | sub-floor input returned verbatim |
| `net_savings_guard_incompressible_never_grows` | ~399-char structureless blob returned **UNCHANGED** (byte+token), the contract |
| `net_savings_guard_holds_across_all_autodetected_types` | auto-detect path never grows json/prose |
| `detector_classifies_canonical_samples` | json/prose/code/error canonical samples classify correctly |
| `detector_repeated_level_prefixed_log_is_log_not_prose` | **ORCHESTRATOR CATCH**: line-leading `ERROR` log → `log`; auto-detect routes it to run-collapse + saves tokens |
| `detector_bracketed_and_warn_prefixed_logs_detect_as_log` | `[ERROR]`/`WARN:` prefixed → `log` |
| `detector_level_prefix_does_not_false_positive_on_prose` | `ERRORS`/`INFORMATION`/`WARNING` prose does NOT trip log detection |
| `detect_repeated_bare_lines_is_documented_limitation` | bare repeated lines → `prose` (pinned); explicit `Some("log")` still run-collapses + saves |
| `detect_bracketed_timestamp_log_is_documented_limitation` | `[<ts>]` log → `json` (pinned); explicit `Some("log")` still run-collapses + saves |

Ratio helper uses **real `count_tokens` (cl100k)** — no hardcoded ratio anywhere.

---

## 2. The detector defect — verdict: FIXED (one case) + DOCUMENTED LIMITATION (two cases)

### What the orchestrator caught
`detectContentType("<repeated identical ERROR log lines>")` returned `"prose"`, not `"log"`.

### Root cause (reproduced before touching anything)
Probed the boundary on the original build:
```
spaced-ERROR (" ERROR " mid-line) => log     ✓
iso-ts (ISO-8601 line start)      => log     ✓
leading-ERROR (line STARTS "ERROR ") => prose ✗  <-- orchestrator's case
bare-repeat (no level/timestamp)  => prose   ✗
```
The real pares-agens `is_log_content` (`pares-agens/crates/core/src/headroom.rs` L470-490,
read on disk) only matches a level token **space-delimited mid-line** (`t.contains(" ERROR ")`
on the *trimmed* line). A line that literally *begins* with `ERROR ` trims to
`ERROR worker crashed`, does not contain `" ERROR "`, and falls through to `prose`. **This is
a real heuristic gap in pares-agens itself — the port did not drop anything; it faithfully
inherited the gap.** (Verified: the port's `is_log_content` matched the agens source
condition-for-condition before my change.)

### Fix (faithful strict superset — `headroom.rs`)
1. **`is_level_prefixed(trimmed)`** added to `is_log_content`: a line that *starts* with a
   bare level token (`ERROR `/`WARN `/`INFO `/`DEBUG `/`TRACE ` followed by space/`:`/tab) or a
   bracketed form (`[ERROR]` …) counts toward the log-line tally. This matches everything the
   real detector matched (strict superset) and resolves the orchestrator's case. The trailing
   space/`:`/bracket guard means it never fires on identifiers like `ERRORS`/`INFORMATION`
   (pinned by `detector_level_prefix_does_not_false_positive_on_prose`).
2. **`starts_like_bracketed_log(trimmed)`** carve-out in `detect_content_type`: a `[ERROR]`/
   `[WARN]`/`[INFO]`/`[DEBUG]`/`[TRACE]`-prefixed line is *never* valid JSON-array syntax, so
   it is excluded from the `{`/`[`→json short-circuit and allowed to reach the log branch.
   This cannot reclassify any real JSON (a JSON array never opens with an uppercase level
   word in brackets).

### Why it's a superset, not a rewrite
The real detector keyed on those exact level words; it merely required them mid-line. We add
the line-leading + bracketed positions of the **same** tokens. Every input the real detector
classified as log still classifies as log; only previously-missed definitive logs are now
caught. The detector's character (heuristic, false-positive-averse) is unchanged.

### Residual limitations — pinned, NOT hidden
- **Bare repeated lines** (no level token, no timestamp), e.g. `Connection refused to host`
  ×N → stays `prose`. Genuinely indistinguishable from repeated prose; any heuristic
  aggressive enough to catch it would mis-classify real prose. pares-agens has the same gap.
- **`[<timestamp>]`-prefixed logs**, e.g. `[2026-06-29T12:00:00Z] ERROR …` → stays `json`
  (the `[` wins). Unlike `[LEVEL]`, a `[<timestamp>]` prefix is a *plausible* JSON-array
  opener, so redirecting it would risk reclassifying real JSON arrays — too dangerous to
  "fix". pares-agens has the same gap.

Both limitations are pinned by tests asserting the current behavior **and** proving that with
an explicit `Some("log")` the compressor still run-collapses and saves real tokens — i.e. the
limitation is detection-only and never a compression failure. (Confirmed by the orchestrator's
own note: compression worked when the type was passed explicitly.)

---

## 3. Fidelity spot-check vs the REAL pares-agens source (cited lines)

Compared the ported `compress_*` against `pares-agens/crates/core/src/headroom_bridge.rs`
and `headroom.rs` (both read on disk this stage):

- **prose** — `compress_prose` (`headroom_bridge.rs` L266-301): `≤6` sentences → whitespace
  collapse; else **head=3 + `[… N sentences elided …]` + tail=3**. Port matches: same head/tail
  counts, same marker shape; `split_sentences` uses `unicode_segmentation::split_sentence_bounds`
  exactly as the agens `split_sentences` actor (`headroom.rs` L156-166). Test asserts first 3 +
  last 3 retained, a middle sentence elided.
- **code** — `compress_code` (`headroom_bridge.rs` L310-342) + `extract_signatures_heuristic`
  (`headroom.rs` L600-657): header `// [headroom: <lang> body elided — N signature(s) kept]`
  then the signature lines. Port's `extract_signatures_heuristic` matches the agens function
  branch-for-branch (rust/python/js/java-cpp-c/generic); `detect_language_heuristic`
  (`headroom.rs` L577-595) matches. Test asserts all sigs kept, bodies dropped.
- **log** — `compress_log` (`headroom_bridge.rs` L349-383): consecutive-dup run-collapse with
  marker `line` + `"  [×N]"` for runs>1, singletons verbatim. Port reproduces the exact
  `flush` logic and marker bytes (`  [×{run}]`). Test asserts `[×30]`/`[×12]` + distinct line.
- **json/other** — `collapse_whitespace` (`headroom_bridge.rs` L406-422): whitespace runs →
  single space, trimmed. Port is byte-identical. Test asserts no token growth + key retention.
- **detector heuristics** — `detect_content_type` (`headroom.rs` L68-86), `is_log_content`
  (L470-490), `is_code_content` (L524-573), `looks_like_error` (L492-520): all read on disk;
  port matched them condition-for-condition **before** the H-TEST superset addition; the only
  delta now is the documented `is_level_prefixed` / `starts_like_bracketed_log` superset.
- **net-savings guard** — `compress_one` (`headroom_bridge.rs` L231-258): accept rewrite only
  if `out.len() < content.len() && !out.trim().is_empty()`, else original verbatim; sub-floor
  (`< PER_MESSAGE_MIN_CHARS = 200`) passes through. Port matches; pinned by two guard tests.

No fidelity drift found beyond the intentional, documented detector superset.

---

## 4. Per-type real measured ratios (rebuilt `.node`, node probe, cl100k)

Probe: `crates/pluresdb-node/headroom-test-probe.mjs` (loads rebuilt `index.js`, calls the
3 NAPI fns; ratios = real `countTokens` compressed/baseline, never hardcoded):

| Type | detect | tokens (base→comp) | ratio | strategy evidence |
|---|---|---|---|---|
| prose | prose | 641 → 104 | **0.162** | head+tail kept, middle elided |
| code  | code  | 144 → 77  | **0.535** | every signature kept, bodies dropped |
| log   | log   | 742 → 59  | **0.080** | `[×30]` + `[×12]` run markers, distinct INFO preserved |
| json  | json  | 94  → 76  | **0.809** | whitespace squeeze (allowed to stay ≥, never grows) |

**Net-savings guard (auto-detect):** `short` 4→4 `unchanged=true`; `tight` 320→320
`unchanged=true`. Neither grows. ✅

**Detector accuracy (rebuilt JS):**
`ORCHESTRATOR repeated-level-prefixed log => log` (**fixed**), `bracketed-LEVEL log => log`,
`WARN-prefixed log => log`, `spaced-level log => log`, `prose-canonical => prose`,
`code-canonical => code`, `json-array => json`. Pinned limitations:
`bare repeated lines => prose`, `bracketed-timestamp log => json`.

(Code ratio 0.535 here vs 0.367 in the implement-notes probe because this fixture is a smaller,
denser code sample — both are real measured cl100k deltas on real code, not a fixed number.)

---

## 5. cargo test result

```
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.44s
```
Green on my own run. First run surfaced 2 REAL failures (a sub-floor JSON fixture that tripped
my own `>= PER_MESSAGE_MIN_CHARS` sanity guard, and the `[ERROR]`→json ordering gap); both were
fixed for real (bigger fixture + the `starts_like_bracketed_log` carve-out), not by weakening
assertions.

---

## 6. No-stub / no-agens-dep status (unchanged, re-confirmed)

- Only `tiktoken-rs = "0.6"` + `unicode-segmentation = "1"` crate-local deps (neither is
  pares-agens). The `.px` ~160-actor stub farm was NOT ported (implement stage).
- No `todo!()`/`unimplemented!()`/canned ratio introduced this stage. The added detector
  helpers are real string logic; the metric is a measured cl100k delta.

---

## 7. Gate status

TEST (native surface scope): **PASS** — 16/16 real tests green on my own run; per-type real
cl100k reduction demonstrated on the rebuilt `.node`; net-savings guard holds (incompressible
returned unchanged); detector defect FIXED for the orchestrator's case with two honestly
documented + pinned residual limitations; fidelity spot-checked against cited pares-agens
source lines. No fake-pass, no weakened assertions, no stubs.
