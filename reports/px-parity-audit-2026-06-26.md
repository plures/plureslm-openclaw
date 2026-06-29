# px / Praxis Parity Audit — "what else is different?"

**Date:** 2026-06-26
**Trigger:** Stage B blocker — `pxCompileNl` on the `pluresdb-native` Node binding stubs. kbristol: *"There should not have been a difference between the two to fix in the first place. This makes me suspicious about what else might be different. Can we have a comprehensive and holistic strategic fix?"*

**Verdict:** His instinct is correct. The stub is not a one-off — it is one visible symptom of a **forked, mid-extraction Praxis layer that currently exists in FOUR places**, none of which is the single canonical `praxis` package the Foundation doc says should exist.

---

## The root cause (evidence-backed)

The `.px` compiler/engine is **mid-extraction** (Foundation doc, TS→Rust→NAPI table: *"Praxis — Stage 2/3 Porting — .px compiler being extracted — praxis-native (in progress)"*). Because nobody finished the extraction, the logic got copied/re-implemented per consumer. Result: **four divergent px surfaces.**

| # | Location | What it is | Quality | Who uses it |
|---|----------|-----------|---------|-------------|
| 1 | `pluresdb/crates/pluresdb-px/src/px/` (`parse` + `grammar.pest`, 21.7KB) | **Real pest grammar parser** → `PxDocument` | ✅ real | nobody on the Node binding |
| 2 | `pluresdb/crates/pluresdb-px/src/db/procedures.rs::compile_nl` | **Toy keyword matcher** (`if lower.contains("write_")` … else `Condition::Always`) | ❌ stub | **the Node binding's `pxCompileNl`** |
| 3 | `pares-radix/crates/radix-core::px_adapter` → `pares_radix_praxis::px::parse` + `compiler::compile` | **Real parser+compiler** → procedures | ✅ real | the running bot (praxisbot) |
| 4 | `C:\Projects\praxis` (standalone repo: own `parse`/`compile` NAPI in `lib.rs`) | Another real-ish parser/compiler + its own grammar | ✅ real (separate) | the `@plures/praxis` npm target |

**The trap we caught:** the Node binding (`pluresdb-node`) wires `pxCompileNl` → **(2) the toy matcher**, not **(1) the real parser that lives in the very same crate two modules over.** So `amount <= 100` compiled to `op: always` (always pass). A $500 trade sailed through. It *looked* wired; it enforced nothing. That's a C-NOSTUB-001 fake.

This is why "there shouldn't have been a difference": the real parser already exists in pluresdb-px. The binding just never called it. And the reason there are *two* in that crate at all is the unfinished extraction.

---

## The full divergence list (the "what else is different" answer)

Beyond `compile_nl`, auditing the Node binding (`pluresdb-node`, 18 px/agens methods) against the real engines:

1. **Authoring path is stubbed (the headline).** `pxCompileNl` / `pxApplyCorrection` / `pxUndoCorrection` all route through `compile_nl` (the toy matcher). Anything outside its ~5 hardcoded keywords (`write_`, `delete_`, `resource_owner`, `privilege_level`, `risk_score`) silently becomes a pass-through. **Structured/`.px` constraint insert is not exposed at all.**
2. **No `.px`-source ingestion on the binding.** pares-radix can load a real `.px` *file* (`load_px_directory`/`load_px_procedures`); the Node binding has **no** equivalent. You cannot hand it a `.px` and get real constraints/procedures.
3. **Two stores, not one.** The binding's praxis store is a separate in-memory `PraxisStore` (`px_default_store()`), **distinct from the `CrdtStore`** the rest of the binding wraps. So constraints authored via the binding are **not** PluresDB nodes — they don't persist, replicate, or participate in reactive triggers. This violates C-PLURES-003/004 (all state through PluresDB). The evaluator works; the *substrate* is wrong.
4. **Procedures vs constraints asymmetry.** The real loaders compile `.px` into **procedures** (reactive, with action handlers). The binding's px surface only deals with **constraints** (evaluate/on_action). The procedure/reactive half of `.px` is absent from the binding entirely.
5. **Grammar drift risk.** There are at least two real `.pest`/parser implementations (pluresdb-px `grammar.pest` 21.7KB, and the standalone `C:\Projects\praxis`). Same language name, independently maintained grammars = guaranteed semantic drift over time. We don't yet know they accept the same `.px`.\n
---

## The holistic fix (one canonical Praxis, finish the extraction)

Foundation doc is unambiguous about the target end-state:
- **`praxis`** owns *".px language (grammar, compiler, executor), constraint engine, NativeFunctionRegistry."*
- **`pluresdb`** owns *"CRDT store, reactive procedures, embeddings"* and explicitly **NOT** application logic.
- Apps (`pares-radix`, etc.) **consume** both; **`pluresdb` must never depend on `pares-radix`.**

So the holistic fix is **not** "add one method." It is **"collapse 4 px implementations to 1 canonical engine, then expose that one engine — real parser, real store-backed insert — through every binding."**

**Phase 0 — Decide the canonical home (the only thing needing your call).**
Two viable canonical homes:
- **(A) `praxis` repo is canonical** (matches Foundation literally). pluresdb-px becomes a thin re-export/dep of `praxis`; pares-radix drops its private copy and depends on `praxis`. Cleanest long-term, biggest move.
- **(B) `pluresdb-px` is canonical** (it already has the real grammar + is already the dep of the Node binding). `praxis` repo and pares-radix's `crates/praxis` converge onto it. Smaller move, but slightly bends the Foundation's "praxis is its own pillar" framing — would need a Foundation doc update to bless pluresdb-px as the praxis engine's home.

**Phase 1 — Kill the stub at the source.** Replace `pluresdb-px::procedures::compile_nl`'s body so it calls the **real parser** (`pluresdb-px::px::parse`) for any structured/`.px`-ish input, falling back to NL heuristics only for genuine free-text. No consumer changes needed; the stub just stops lying. (This alone unblocks Stage B honestly.)

**Phase 2 — Expose real authoring on the Node binding.** Add `pxLoadPxSource(text)` / `pxInsertConstraint(structured)` to `pluresdb-node`, backed by the canonical parser, writing constraints **as PluresDB nodes in the CrdtStore** (fix divergence #3), not the side `PraxisStore`. Mirror the procedure-loading path too (fix #4).

**Phase 3 — One grammar.** Diff the two `.pest` grammars; make the non-canonical one a re-export. Add a conformance test corpus (`.px` files that MUST parse identically) wired into CI so they can never drift again (this is a C-DRIFT-001 obligation — automate the equivalence, don't document a "keep in sync" note).

**Phase 4 — Cross-platform QA gate (already mandated).** Prove the unified engine on Linux-in-Docker + Windows before the plureslm-openclaw migration. Same gate kbristol already set.

**Net effect:** the plugin stays a pure consumer, `.px`-first becomes actually true, constraints become real PluresDB nodes, and the "four px engines" problem that produced this bug can't recur because there's one engine behind one grammar with a CI conformance gate.

---

## Recommendation

**Phase 1 immediately** (un-stubs Stage B honestly, zero consumer churn, qualifies under the "fix genuine bugs/optimizations in PluresDB" exception you already granted).
Then **Phase 0 decision (A vs B)** is the one thing that's genuinely your call, because it touches repo boundaries and possibly the Foundation doc. My vote: **A** (praxis canonical) as the destination, but land **Phase 1 in pluresdb-px first** regardless of A/B since both paths need the stub dead.
