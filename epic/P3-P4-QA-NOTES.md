# P3 + P4 — QA stage notes (EPIC-MEMORY-SUPERIORITY)

**Worktree:** `C:\Projects\plureslm-openclaw-p3p4` · branch `feat/p3p4-reactive-governed`\n**Stage:** QA (adversarially break the safety-critical redaction gate harder than the TEST matrix; harden the detector/gate WITHOUT weakening it; pin honest limitations).
**Scope:** drive ONLY the shipped `store`/`sync`/`recall`/`consolidate` API against the BUILT `dist/` (C-TEST-002). Every "refused" claim proven by `store.get()===null`; every "written"/"clean" claim by `get()!==null` + a real recall; every "no leak" claim by asserting the secret string never appears in any recall snippet. No fabricated blocks, no weakened assertions, no new stubs (C-NOSTUB-001).

---

## 0. Headline

- **One REAL secret-leak defect found AND fixed for real** (non-weakening): a secret hidden in a **secondary content field** (`value`/`body`/`note`/an arbitrary content field) behind a benign `content` was written then recallable. Closed at the gate chokepoint.
- **Detector held against every realistic evasion the TEST matrix did not cover** (multiline/format/obfuscation): **0 secret leaks** across 19 adversarial cases.
- **False-positive pressure stayed low**: all 8 ordinary-content cases (base64 fixtures, git/sha256/UUID in prose, English paragraph, Markdown table, minified JS, stack trace) NOT refused.
- **Consolidation** idempotent + bounded + durable at 40-node scale; chunk-split pinned as an honest, recall-safe limitation.
- **Full suite green on my own run** (build + 4 gates + vitest 5 + tsc).

---

## 1. Suite result (my run)

`pnpm run build` → exit **0**. `pnpm test` (recall.gate + p3p4.gate + p3p4-hardened.gate + **new p3p4-qa.gate**) → **ALL CHECKS PASSED, exit 0**. `vitest run` → **5 passed, exit 0** (was 4; my QA mirror is the 5th). `tsc --noEmit` → exit **0**.

Hardened matrix re-verified post-fix: `CONFUSION MATRIX TP=11 FP=0 TN=7 FN=0 | secretLeaks=0 | cleanRecalled=7/7` — i.e. the fix did NOT weaken detection (same perfect matrix) and the previously-noted clean-decoy writes all pass.

---

## 2. REAL DEFECT (safety-critical, FIXED): secondary-field secret evasion

**Attack #1 (secret placement).** The TEST matrix only ever placed secrets in `content`. I placed a live credential in a DIFFERENT field that the **recall path surfaces** but the **gate did not scan**.

**Recall surface** (`deriveSnippet` / `deriveSnippetFromData` / `normalizeHit` in `pluresdb.ts`/`memory-capability.ts`), priority order:
`content → text → summary → value → body → note → JSON.stringify(WHOLE PAYLOAD)` (the last only as a fallback when no content field exists).

**Gate surface (before fix)** — `#gateWrite`:
```
const text = this.#embeddableText(data) || deriveSnippet(data);  // #embeddableText = content→text→summary
```
Because of the `||` short-circuit, when `content` (or `text`/`summary`) was a benign non-empty string, `deriveSnippet` was **never called**, so a secret in `value`/`body`/`note`/any-other-field was **never inspected**.

**Proof (`test/qa-gate-field-probe.mjs`, pre-fix):** 4/4 cases persisted (`get()!==null`) with the live token in the payload — a real leak:
| case | secret field | benign `content`? | result (pre-fix) |
|---|---|---|---|
| secret-in-value | `value` = GitHub `ghp_…` | yes | **PERSISTED (LEAK)** |
| secret-in-body | `body` = AWS `AKIA…` | yes | **PERSISTED (LEAK)** |
| secret-in-note | `note` = PEM block | yes | **PERSISTED (LEAK)** |
| secret-in-arbitrary | `credential` = `ghp_…` | yes | **PERSISTED (LEAK)** |

> Empirical note on the arbitrary-field case: the *capability's public `search()`* projects to `path`/`score`/`snippet`/`source` and the snippet is content-field-derived, so a secret in a truly arbitrary key (`credential`) does not surface in the *public snippet* — BUT the internal `PluresLmStore` recall (`normalizeHit`) carries the full `data`, and a secret in any recall-priority content field (`value`/`body`/`note`) DOES surface in the snippet. The safe posture is to gate **every content value**, which is what the fix does. (Verified the snippet behavior live before deciding the fix shape.)

**The fix (chokepoint, non-weakening)** — `src/pluresdb.ts`:
- New `#gateScanText(data)`: recursively collects **every content-bearing string value** in the payload (into nested objects/arrays), each on its own line, and feeds that to `detectSecret`.
- It **excludes** `STRUCTURAL_NONCONTENT_KEYS` (`hash`, `category`, `type`, `kind`, `source`, `path`, `file`, `id`, `mtimeMs`, `size`, `chunkIndex`, `startLine`, `endLine`, `timestamp`, `createdAt`, `updatedAt`, `_edge`, `superseded_by`, `structural_rank`, `pagerank_score`, `decay`) — these are ids/hashes/line-numbers/sizes/graph fields, never user content, never a recall snippet.
- It deliberately joins discrete string **VALUES** with `\n` — it does NOT feed `JSON.stringify(object)` to the detector (see §2.1).
- `#gateWrite` now does `const text = this.#gateScanText(data);` (no `||` short-circuit).
- `RECALL_CONTENT_FIELDS` is now a shared constant that `deriveSnippet` also references, so gate + recall priority can never drift (ADR-0010 "fix once at the chokepoint").

**Post-fix proof (`qa-gate-field-probe.mjs`):** all 5 secret-bearing cases REFUSED with correct `kind` (github-token / aws-access-key-id / pem-private-key / github-token via the arbitrary field / github-token no-primary control), `get()===null`, **0 leaks**; the fully-clean control still WRITES.

### 2.1 Iteration honesty (an over-correction I caught and fixed)

My **first** fix fed `JSON.stringify(WHOLE PAYLOAD)` to the detector as a catch-all. Re-running the hardened gate immediately FAILED 6 checks: `JSON.stringify` glues field values to keys + punctuation + the synthetic `hash` value (`…lives.","category":"session","hash":"h-prose-with-secret-words-1"}`), and that manufactured run trips the entropy heuristic as a false `high-entropy-token` — over-blocking 5 wholly clean matrix decoys. I root-caused it (the `hash` value `h-foo-bar-1` is a 24+ char mixed-class token) and corrected to scan discrete content **values** with the structural-key denylist. **The detector was never weakened; only the gate's INPUT surface changed.** This is logged here rather than hidden because "QA changes that quietly weaken or over-correct" is exactly what this stage exists to prevent.

---

## 3. Detector adversarial sweep — evasions the TEST matrix did NOT cover

`test/qa-detector-probe.mjs` — 19 cases, pure `detectSecret` (no DB). **Result: 0 secret leaks (every real secret CAUGHT).**

**Multiline / format variants — all REFUSED:**
- full PEM **with** a multi-line base64 body → `pem-private-key`
- AWS **secret**-access-key (40-char, NOT the AKIA id) in `aws_secret_access_key = …` → `credential-assignment`
- connection string embedding a password (`postgres://u:S3cr3t…@h/db`) → `high-entropy-token`
- `.env` blob with several `KEY=secret` lines (`STRIPE_SECRET_KEY=sk_live_…`) → `stripe-secret-key`
- JSON value holding a token (`"auth_token":"ghp_…"`) → `github-token`
- private-key assignment with opaque base64 → `credential-assignment`

**Case / whitespace / obfuscation:**
- bearer with mixed case + extra spaces (`Authorization:   BeArEr    sk-proj-…`) → CAUGHT (`openai-style-key`)
- base64 secret wrapped across newlines → CAUGHT (`high-entropy-token`)
- URL-encoded token in a query string (`?access_token=ghp_…`) → CAUGHT (`github-token`)
- spaced-out `A K I A` reference (not a usable key) → correctly NOT flagged

**FP-pressure (must STAY clean) — all 8 NOT flagged:**
long base64 **PNG** fixture, long base64 **JPEG** fixture, git SHA + sha256 digest in prose, two UUIDs in prose, a long English paragraph, a Markdown table, minified JS, a multi-frame stack trace.

**The one non-clean note:** `GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab` (UPPERCASE `GHP_` prefix — not a real GitHub token shape, which is lowercase `ghp_`) is flagged `high-entropy-token`. I labeled it `expectSecret:false`; the detector flags it. **This is a CORRECT conservative catch**, not a false positive worth fixing: it is a 40-char opaque mixed-class token, and refusing a credential-shaped string is the safe behavior. "Fixing" it would mean carving out a credential-shaped token = **weakening** the detector. Left as-is **by design**; my test expectation was the thing that was wrong, not the detector.

---

## 4. Chunk-boundary (attack #2) — full-in-one always caught; split pinned honestly

`test/qa-chunk-and-scale.mjs` (chunk section), real `sync()` path:

- **(A) full secret in ONE oversized chunk** → chunk0 **REFUSED** (`get()===null`), the clean trailing chunk1 **WRITTEN**, and searching the file's sentinel **never** returns the token in any snippet. The safety-critical "the whole secret is in one chunk" case is **always** caught.
- **(B) secret SPLIT across a paragraph boundary** (each half shorter than the credential's min length, e.g. `ghp_ABCDEFGHIJKLMNOPQR` = 22 chars < the 36 the `ghp_` rule needs): each half is genuinely clean per-chunk, so both halves write — **BUT recall NEVER reassembles them into one contiguous usable token** (`B_fullSecretInAnySnippet=false`).

**Pinned limitation (honest, recall-safe):** an adversary who deliberately splits a credential across a chunk boundary evades per-chunk detection — but the **same boundary that hides it from the detector also prevents recall from ever returning it as one usable secret**, so it is not an exfiltration path through this memory surface. This is recorded as an **asserted contract** in `p3p4-qa.gate.mts` (`QA-3 PINNED: split secret NEVER reassembled in any snippet`), not papered over. A cross-chunk reassembly detector is out of scope for this gate (it would require buffering content across chunk writes, which the single-pass `sync()` chunker does not do); flagged here as the known hard case.

---

## 5. Consolidation at scale (attack #6) — idempotent + bounded + durable

`test/qa-chunk-and-scale.mjs` (scale section): 40 same-session nodes via `sync()`, then 6× `consolidate({force:true})`:

- **edge count STABLE = 780 across all 6 sweeps** → idempotent (no duplication, no growth on re-run). 780 = 40×39/2 = the **complete** same-session graph (every same-session/same-category pair linked by `auto_link(category,temporal)`); deterministic and **bounded** — NOT a runaway "N² of everything" explosion (asserted `edges ≤ N(N-1)/2`).
- **run counter monotonic 2→3→4→5→6→7** across the sweeps.
- **checkpoint DURABLE across a fresh reopen** (new `PluresLmStore.open` on the same dbPath → next run = prior last + 1).
- **best-effort preserved**: the hardened gate's `idempotent` phase already proves a poisoned internal `execIr` makes `consolidate` return a degraded `{ran:false}` and **never throws out of `sync()`** (re-verified green this run).
- finalTotal 840 (40 chunks + 780 edges + checkpoint/meta nodes).

---

## 6. What I added / changed (all real, no stubs, no weakened assertions)

**Shipped change (the only one):** `src/pluresdb.ts`
- `#gateScanText(data)` — gate now scans the full recall-exposable content surface (every content value, structural keys excluded). The single shipped behavioral change; strictly broadens secret coverage, no FP increase.
- `RECALL_CONTENT_FIELDS` + `STRUCTURAL_NONCONTENT_KEYS` shared constants; `deriveSnippet` repointed at `RECALL_CONTENT_FIELDS` so gate + recall priority cannot drift.
- No change to `redact.ts` (detector unchanged → provably non-weakening), no change to the native gate path, no new TEST-ONLY seam (the existing test-only seams stayed test-only).

**Tests (committed):**
- `test/p3p4-qa.gate.mts` — 28 self-asserting checks (QA-1 secondary-field leak closed + never recalled; QA-2 non-weakening: clean id-shaped-hash node still writes/recalls + every secret shape still flags; QA-3 chunk-boundary contract; QA-4 consolidate-at-scale idempotency/bound/durability). Exits non-zero on any breach. Drives only the shipped API.
- vitest mirror in `test/recall.gate.test.ts` (spawns the runner, asserts exit 0 + pins the three safety claims) → the 5th vitest test.
- `package.json`: `test` chain now includes `p3p4-qa.gate.mts`; added `test:p3p4-qa`.
- Adversarial probes kept as reusable tools: `test/qa-detector-probe.mjs`, `test/qa-gate-field-probe.mjs`, `test/qa-chunk-and-scale.mjs`.

No `node_modules`/`.node`/`dist` committed. No stubs (C-NOSTUB-001). No existing assertion weakened or removed.

---

## 7. Answers to the QA brief

- **Did ANY secret evade the gate?** Yes — ONE real evasion (a secret in a secondary content field `value`/`body`/`note`/arbitrary behind a benign `content`). It was **FIXED for real** at the gate chokepoint (`#gateScanText`) and proven closed (4/4 now refused + never recalled) and **non-weakening** (detector matrix unchanged `TP=11 FP=0 TN=7 FN=0`; clean payloads still write; all secret shapes still flag). No remaining un-fixed/un-pinned secret leak on my run.
- **Did the FP rate stay low?** Yes. 8/8 ordinary-content cases not refused: base64 PNG/JPEG fixtures, git SHA, sha256 digest, UUIDs in prose, English paragraph, Markdown table, minified JS, stack trace. The one flagged non-clean case (`GHP_` uppercase) is a correct conservative catch, deliberately NOT carved out (carving it would weaken detection).
- **Consolidation-at-scale verdict?** PASS — 40 nodes, 6 sweeps, edges stable at 780 (complete same-session graph, bounded), runs monotonic, durable across reopen, best-effort under poison.
- **Full suite result on my own run?** Build exit 0; `pnpm test` (4 gates) ALL CHECKS PASSED exit 0; `vitest run` 5 passed exit 0; `tsc --noEmit` exit 0.

**QA gate: PASS.** A real, safety-critical secret-leak defect was found, fixed for real, and pinned with a regression gate; the detector was hardened-verified (not changed) against realistic evasions without weakening; false positives stayed low; consolidation is idempotent+bounded+durable at scale.
