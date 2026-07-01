# P3 + P4 — TEST stage notes (EPIC-MEMORY-SUPERIORITY)

**Worktree:** `C:\Projects\plureslm-openclaw-p3p4` · branch `feat/p3p4-reactive-governed`\n**Stage:** TEST (hardening the P3/P4 gates as first-class, repeatable, adversarial tests)
**Scope:** drive ONLY the shipped `store`/`sync`/`recall`/`consolidate` API (C-TEST-002). No fabricated block/recall — every "blocked" claim proven by `store.get()===null` + a real recall MISS; every "written" claim by `get()!==null` + a real recall HIT. No weakened assertions, no new stubs (C-NOSTUB-001).

---

## 1. Suite result (my run)

`pnpm run build` → exit **0**. `pnpm test` (full suite) → exit **0**.

| Runner | Coverage | Result |
|---|---|---|
| `test/recall.gate.mts` | GATE A (compat) / B (seeded recall) / C (sync→reopen→recall) / D | **ALL CHECKS PASSED** |
| `test/p3p4.gate.mts` | original P4 governed-write block + P3 consolidate idempotency | **ALL CHECKS PASSED** |
| `test/p3p4-hardened.gate.mts` | adversarial redaction matrix + fail-closed + idempotency/durability/best-effort | **HARDENED RESULT: ALL CHECKS PASSED** |

`vitest run test/recall.gate.test.ts` → **4 passed** (3 read-path + 1 hardened mirror), exit 0.
`pnpm run check` (tsc --noEmit) → exit 0.

---

## 2. P4 adversarial redaction matrix — confusion matrix

Each shape driven through **BOTH** direct `store()` AND chunk-level `sync()`; absence proven by `get()`; non-recall proven by a real cross-process `search()`.

```
CONFUSION MATRIX (detection): TP=11  FP=0  TN=7  FN=0
MATRIX SUMMARY: TP=11 FP=0 TN=7 FN=0 | secretLeaks=0 | cleanRecalled=7/7
```

**Secret shapes — all 11 detected (has_secret=1), refused (get()===null), AND recall-MISS, via direct store() and sync():**

| # | Shape | detector `kind` | direct refused | sync chunk absent | recall miss |
|---|---|---|---|---|---|
| 1 | AWS `AKIA…` access key | `aws-access-key-id` | ✅ | ✅ | ✅ |
| 2 | PEM `-----BEGIN RSA PRIVATE KEY-----` | `pem-private-key` | ✅ | ✅ | ✅ |
| 3 | GitHub `ghp_…` | `github-token` | ✅ | ✅ | ✅ |
| 4 | GitHub `gho_…` | `github-token` | ✅ | ✅ | ✅ |
| 5 | Google `AIza…` | `google-api-key` | ✅ | ✅ | ✅ |
| 6 | Slack `xoxb-…` | `slack-token` | ✅ | ✅ | ✅ |
| 7 | Stripe `sk_live_…` | `stripe-secret-key` | ✅ | ✅ | ✅ |
| 8 | OpenAI `sk-proj-…` | `openai-style-key` | ✅ | ✅ | ✅ |
| 9 | JWT (3 base64url segments) | `jwt` | ✅ | ✅ | ✅ |
| 10 | Azure `…AccountKey=…` conn string | `azure-account-key` | ✅ | ✅ | ✅ |
| 11 | `password = <opaque>` assignment | `credential-assignment` | ✅ | ✅ | ✅ |

**Clean battery — all 7 written (has_secret=0), NOT refused, recallable, no secret rides along:**

| # | Clean decoy (intentionally tricky) | detected? | written (direct+sync) |
|---|---|---|---|
| 1 | prose containing the words *password / secret / key* | no | ✅ |
| 2 | sha256 hex digest | no | ✅ |
| 3 | 40-hex git commit sha | no | ✅ |
| 4 | base64 **image-ish** blob (1×1 PNG), NOT a credential | no | ✅ |
| 5 | code with `const apiKey = config.apiKey` (no value) | no | ✅ |
| 6 | ordinary runbook prose | no | ✅ |
| 7 | semver `v2.0.0-alpha.1` + UUID trace id | no | ✅ |

**Result: 100% block of every secret shape, 0 false negatives, 0 false positives.**

### Two REAL false positives were found by the matrix — and FIXED (not papered over)

The adversarial clean battery initially caught **2 genuine detector false positives** (clean #4 base64 PNG blob and clean #7 UUID), both wrongly flagged `high-entropy-token` and refused. This is exactly what an adversarial gate is for. Fixed in `src/redact.ts` with **precise, non-weakening allow-list carve-outs** in `looksLikeOpaqueSecret`:

- **Canonical UUID** (`8-4-4-4-12` hex, anchored) → structured identifier, not a secret.
- **Base64 with a known binary FILE magic prefix** (PNG `iVBORw0KGgo`, JPEG `/9j/`, GIF `R0lGOD`, PDF `JVBER`, ZIP/Office `UEsDB`, GZIP `H4sI`) → embedded media, not a credential.

**Non-weakening proof:** a bare 56-char base64 secret WITHOUT a magic prefix is **still flagged** `high-entropy-token` (probe in the TEST session), and all 11 real secret shapes still detect. The carve-outs remove false positives without opening any false-negative hole.

---

## 3. P4 FAIL-CLOSED

Induced the genuine "governance could not be installed" precondition via a real test seam (`_forceGovernanceFailedForTests(true)` → `#governanceReady = false`, exactly as a thrown `pxInsertConstraint` would set it — the seam injects the *precondition*, the real `#gateWrite` fail-closed branch makes the decision; documented double at a real seam, C-NOSTUB-001 item 3).

| Assertion | Result |
|---|---|
| governance latch forced CLOSED (`false`) | ✅ |
| fail-closed `store()`: secret REFUSED (`refused>=1`, kind `github-token`) | ✅ |
| fail-closed: clean sibling STILL written (`written>=1`) | ✅ |
| fail-closed: secret node **NOT persisted** (`get()===null`) | ✅ |
| positive path (governance restored): SAME secret STILL refused by native engine | ✅ |
| positive path: secret never persisted either way (`get()===null`) | ✅ |

**A secret never slips through because the safety rule was unavailable — the gate fails CLOSED.**

---

## 4. P3 idempotency + durability + best-effort

```
edges:  run1=3  run2=3  run3=3      (STABLE across all 3 forced sweeps — no duplication)
runs:   2 -> 3 -> 4                 (monotonic +1 each forced sweep)
DURABLE: reopenedFirst=7 > priorLast=6  (run counter survived a FRESH process / reopen of same dbPath)
best-effort: poisoned internal execIr -> consolidate returned {ran:false,reason:"empty"}, did NOT throw out
             store healthy after poison cleared -> next sweep ran:true, edges=3 again
```

| Assertion | Result |
|---|---|
| 3× `consolidate({force})` over same store: **edge count identical** (e1=e2=e3=3) | ✅ |
| pagerank + louvain clusters run without error each sweep | ✅ |
| run counter monotonic (+1 per forced sweep) | ✅ |
| run counter **DURABLE across a fresh process** (reopen same dbPath, counter persisted) | ✅ |
| best-effort: forced internal `execIr` failure does NOT throw out of `consolidate` | ✅ |
| store stays healthy after the injected failure (normal sweep resumes) | ✅ |

**Re-consolidation is idempotent (deterministic `edge::{from}::{to}` ids converge), the run counter is durable cross-process, and a native fault degrades a metric without ever breaking the write/search contract.**

---

## 5. What was added / changed

- **`src/redact.ts`** — real detector fix: `UUID_RE` + `BASE64_FILE_MAGIC_RE` carve-outs in `looksLikeOpaqueSecret` (removes 2 false positives, no false-negative regression).
- **`src/pluresdb.ts`** — two TEST-ONLY seams (documented doubles at real seams, NOT shipped paths): `_forceGovernanceFailedForTests` / `_governanceStateForTests` (fail-closed precondition) and `_poisonExecIrForTests` (best-effort precondition). The block/allow + best-effort decisions remain the real shipped logic.
- **`test/p3p4-hardened-child.mts`** — new cross-process child driving the shipped API across phases `matrix` / `matrix-sync` / `recall` / `failclosed` / `idempotent`.
- **`test/p3p4-hardened.gate.mts`** — new standalone gate runner computing the TP/FP/TN/FN matrix + all assertions; self-fails non-zero on any breach.
- **`test/recall.gate.test.ts`** — vitest mirror: spawns the hardened runner, asserts exit 0 + clean confusion matrix + 0 leaks.
- **`package.json`** — `test` now also runs `test/p3p4-hardened.gate.mts`; added `test:p3p4-hardened`.

No `node_modules` / `.node` committed. Real shipped API only.

---

## 6. Verdict

- **Every secret shape blocked + recall-missed?** YES — 11/11, via direct `store()` and `sync()`, TP=11 / FN=0.
- **Any false positive on clean inputs?** NO (FP=0, TN=7) — after fixing the 2 real detector FPs the matrix caught.
- **3× consolidate keep edges stable?** YES — e1=e2=e3=3 (no duplication).
- **Run counter durable cross-process?** YES — reopened first run = 7 > prior last = 6.
- **Full suite RESULT + exit?** `pnpm test` ALL CHECKS PASSED, exit 0; vitest 4 passed, exit 0; tsc --noEmit exit 0.

**TEST gate: PASS.** Security gate held under the adversarial matrix; the only findings were 2 detector false positives, which were fixed for real (non-weakening) rather than papered over.
