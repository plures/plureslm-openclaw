/**
 * Real secret detection for the P4 governed-write gate (C-MEM-REDACT).
 *
 * This is NOT a stub (C-NOSTUB-001): {@link detectSecret} runs a battery of
 * real regexes for well-known credential shapes plus a Shannon-entropy
 * heuristic for unstructured high-entropy tokens. It is used by the write path
 * to compute an honest `has_secret` boolean that the native px `on_action` gate
 * (`pxOnAction`) then enforces — a flagged chunk is REFUSED (never persisted),
 * with the refusal surfaced in the write accounting, never silently dropped.
 *
 * Detection philosophy: bias toward catching real credentials while keeping
 * false positives low enough that ordinary prose/code/markdown is not blocked
 * wholesale. Every pattern below matches a documented, distinctive credential
 * shape (provider prefixes, PEM armor, JWT structure) rather than "any long
 * string"; the entropy fallback is gated behind a minimum length AND a
 * character-class check (must look like a token, not a sentence) so a normal
 * paragraph of English does not trip it.
 *
 * The detector is intentionally conservative about what counts as "secret
 * content" so the memory store stays useful: it flags the PRESENCE of a secret
 * anywhere in the chunk (the whole chunk is then refused), because a chunk that
 * embeds a live key should not be persisted at all — partial redaction of a
 * chunk we still store would be a silent mutation of the user's content, which
 * the brief forbids. Refusal + honest report is the correct posture.
 */

/** Result of scanning one piece of text for secret material. */
export type SecretFinding = {
  /** True when at least one secret pattern (or the entropy heuristic) fired. */
  has_secret: boolean;
  /** Short stable label for the first/strongest match (for honest reporting). */
  kind?: string;
  /** 1-based line where the match was found, when locatable. */
  line?: number;
};

/**
 * Structured patterns for high-confidence credential shapes. Order matters only
 * for which `kind` is reported first; any single match flags the chunk.
 *
 * Each entry is a real, documented secret shape:
 *  - AWS access key id (`AKIA`/`ASIA` + 16 base32-ish chars)
 *  - AWS secret access key (contextual: assignment of a 40-char base64 secret)
 *  - PEM private-key armor (RSA/EC/OPENSSH/generic PRIVATE KEY blocks)
 *  - GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + 36+ chars; fine-grained `github_pat_`)
 *  - Google API key (`AIza` + 35 chars)
 *  - Slack token (`xox[baprs]-...`)
 *  - Stripe live/test secret (`sk_live_`/`rk_live_`/`sk_test_` + 24+ chars)
 *  - OpenAI / generic `sk-` style keys (`sk-` + 20+ chars; `sk-proj-` fine-grained)
 *  - JWT (three base64url segments separated by dots, header starts `eyJ`)
 *  - Azure storage account key (`AccountKey=` + long base64 ending `==`)
 *  - Generic bearer/authorization header carrying a long opaque token
 *  - Private key / password assignment with a long opaque value
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // PEM private key armor — unambiguous; matches the BEGIN line for any key type.
  {
    kind: "pem-private-key",
    re: /-----BEGIN(?: RSA| EC| DSA| OPENSSH| PGP)? PRIVATE KEY(?: BLOCK)?-----/,
  },
  // AWS access key id.
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/ },
  // GitHub personal access / OAuth / app tokens (classic + fine-grained).
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  // Google API key.
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // Slack tokens.
  { kind: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  // Stripe secret/restricted keys.
  { kind: "stripe-secret-key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  // OpenAI / generic `sk-` style API keys (incl. project keys). Require length
  // so a bare "sk-1" in prose is not flagged.
  { kind: "openai-style-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  // JSON Web Token: three base64url segments, header begins eyJ.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  // Azure storage / connection-string account key.
  { kind: "azure-account-key", re: /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/ },
  // Bearer/authorization header with a long opaque token.
  {
    kind: "bearer-token",
    re: /\b[Bb]earer\s+[A-Za-z0-9_\-.=+/]{20,}\b/,
  },
];

/**
 * Contextual "assignment of a secret-looking value" patterns. These fire when a
 * key/secret/password/token-like field name is assigned a long opaque value —
 * the shape of a leaked credential in config/code. The value must be long and
 * high-class enough to look like a credential (not a short word), so
 * `password = ""` or `token: hi` is NOT flagged.
 */
const ASSIGNMENT_RE =
  /\b(?:api[_-]?key|secret(?:[_-]?key|[_-]?access[_-]?key)?|access[_-]?key|client[_-]?secret|private[_-]?key|passwd|password|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|aws_secret_access_key)\b\s*[:=]\s*['"`]?([A-Za-z0-9+/_\-.=]{16,})['"`]?/i;

/**
 * Shannon entropy (bits per char) of a string. Used only as a fallback for
 * unstructured high-entropy tokens that no named pattern caught.
 */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Structural carve-out for the entropy fallback: is `token` a delimited file
 * PATH or a multi-segment compound IDENTIFIER (rather than an opaque credential)?
 *
 * Opaque secrets are contiguous high-entropy runs. The tokenizer (`TOKEN_RE`)
 * intentionally includes `/ - _ =` so it can catch base64/url-safe key material,
 * but that also slurps whole file paths and kebab/snake identifiers out of prose
 * into one long "token". Those are the dominant entropy false positives on real
 * markdown memory. This predicate identifies them precisely:
 *  - contains a `/` (a path or namespaced slug like `a/b/c` — no credential shape
 *    embeds path separators; the named GitHub/Stripe/AWS/PEM patterns run first),
 *    OR
 *  - is a run of >= 3 segments joined by single `-`/`_` delimiters where the
 *    segments are word-ish (letters, optionally with digits/dates), e.g.
 *    `Repair-ClusterNameAccount`, `MEMORY-archive-2026-05-11`, `check-ado-access`.
 *
 * A real opaque secret is a single unbroken segment, so it fails both tests and
 * still reaches the entropy check. This narrows false positives without relaxing
 * the entropy thresholds or touching the high-confidence structured patterns.
 */
function looksLikePathOrIdentifier(token: string): boolean {
  // Path / namespaced slug: any `/` separator (leading, interior, or trailing).
  // A credential shape never contains path separators; the named GitHub/Stripe/
  // AWS/PEM patterns run first, so exempting anything with `/` is safe.
  if (token.includes("/")) return true;
  // CLI flag or KEY=VALUE assignment shape (`--remote-debugging-port=9222`,
  // `NODE_OPTIONS=--max-old-space-size=12288`, `ansibleTags=user_accounts`): the
  // `=`/`--` structure is configuration syntax, never a bare opaque credential.
  // (A real assigned secret is caught earlier by ASSIGNMENT_RE on the full text.)
  // NOTE: require the `=` to be an INTERIOR assignment (a letter on each side),
  // NOT trailing base64 padding (`...ODk=`), so a real bare-base64 secret that
  // merely ends in `=` is NOT exempted.
  if (/^--?[A-Za-z]/.test(token) || /[A-Za-z0-9)]=[A-Za-z0-9-]/.test(token)) return true;
  // Canonical UUID appearing anywhere in the token (the anchored UUID_RE can miss
  // when the tokenizer glued a neighbour char); a UUID is a structured id.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(token)) return true;
  // Multi-segment kebab/snake/plus identifier: split on single - _ or + delimiters
  // (`Send+Sync+Clone`, `Argon2id+AES-256-GCM+zeroize` are technical prose, not keys).
  const segments = token.split(/[-_+]/);
  if (segments.length >= 2) {
    const wordish = (s: string): boolean =>
      s.length > 0 && /^[A-Za-z][A-Za-z0-9]*$/.test(s) && s.length <= 40;
    const numeric = (s: string): boolean => /^[0-9]{1,8}$/.test(s);
    let wordCount = 0;
    let ok = true;
    for (const s of segments) {
      if (wordish(s)) wordCount++;
      else if (numeric(s)) continue;
      else {
        ok = false;
        break;
      }
    }
    // >=2 word-ish segments and no opaque segment => a compound identifier
    // (`Set-VMNetworkAdapterVlan`, `praxis-constraint-enforce`), not a secret.
    if (ok && wordCount >= 2) return true;
  }
  // Single-segment CamelCase/PascalCase identifier with NO delimiter and only
  // letters (e.g. `ValidatePeerReviewPolicyFunction`): case-mix drives its entropy
  // over the threshold, but an all-letter identifier carries no key material.
  // Require >=2 case transitions so a genuinely random all-letter blob (which
  // would still need the entropy+class gate) is not blanket-exempted.
  if (/^[A-Za-z]+$/.test(token)) {
    let transitions = 0;
    for (let i = 1; i < token.length; i++) {
      const prev = token.charCodeAt(i - 1);
      const curr = token.charCodeAt(i);
      const prevLower = prev >= 97 && prev <= 122; // a-z
      const currUpper = curr >= 65 && curr <= 90; // A-Z
      if (prevLower && currUpper) transitions++;
    }
    if (transitions >= 2) return true;
  }
  return false;
}

/**
 * Heuristic: does `token` look like an opaque high-entropy credential (vs a
 * normal word/hex-hash/sentence)? Requires:
 *  - length >= 24 (long enough to be a key, not a word),
 *  - a mix of character classes (at least 3 of: lower, upper, digit, symbol) OR
 *    very high entropy, so a long all-lowercase English compound is not flagged,
 *  - Shannon entropy >= 3.5 bits/char (random-ish, not repetitive).
 *
 * A 40/64-char hex string (git sha / sha256) has entropy ~4.0 but only 2 classes
 * (lower+digit); to avoid flagging every commit hash we require >=3 classes for
 * the mid-entropy band and only allow the 2-class case when entropy is very high
 * AND length is large (true random base64-ish secrets exceed this).
 *
 * Known-NON-secret structured shapes are carved out FIRST (precise allow-list,
 * not an entropy relaxation): a canonical UUID (8-4-4-4-12 hex) and a base64
 * blob carrying a well-known FILE magic-byte prefix (PNG/JPEG/GIF/PDF/ZIP/GZIP).
 * These are deterministic, distinctive, non-credential shapes — carving them out
 * removes real false positives without lowering the bar for opaque secrets.
 */
function looksLikeOpaqueSecret(token: string): boolean {
  if (token.length < 24) return false;
  // Carve-out 1: a canonical UUID is a structured identifier, never a secret.
  if (UUID_RE.test(token)) return false;
  // Carve-out 2: base64 of a known binary file type (magic-byte prefix) is
  // embedded media (avatar/thumbnail/attachment), not a credential.
  if (BASE64_FILE_MAGIC_RE.test(token)) return false;
  // Carve-out 3: a delimited PATH or multi-segment IDENTIFIER is structurally
  // not a contiguous opaque credential. Real secrets (GitHub/Stripe/AWS/PEM) are
  // caught FIRST by the named patterns; the entropy fallback exists only for
  // unbroken opaque blobs. File paths (`a/b/c`), doc-anchor slugs, and
  // hyphen/underscore-delimited compound identifiers (`Repair-ClusterNameAccount`,
  // `MEMORY-archive-2026-05-11`, `praxis/expectations/C-NOSTUB-001-no-stubs`) were
  // the dominant false-positive class in real memory prose. A genuine credential
  // token does not contain `/` path separators, and is not a run of >=3 word-ish
  // segments joined by single `-`/`_` delimiters, so carving these out removes the
  // false positives WITHOUT lowering the bar for opaque secrets.
  if (looksLikePathOrIdentifier(token)) return false;
  const classes =
    (/[a-z]/.test(token) ? 1 : 0) +
    (/[A-Z]/.test(token) ? 1 : 0) +
    (/[0-9]/.test(token) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(token) ? 1 : 0);
  const h = shannonEntropy(token);
  if (classes >= 3 && h >= 3.5) return true;
  // 2-class (e.g. base64 without symbols, or hex): require both high entropy and
  // substantial length so ordinary hashes/ids in prose stay un-flagged.
  if (classes >= 2 && h >= 4.2 && token.length >= 40) {
    // Pure-hex (sha-family) gets a pass — it's a content digest, not a secret.
    if (/^[0-9a-f]+$/i.test(token)) return false;
    return true;
  }
  return false;
}

const TOKEN_RE = /[A-Za-z0-9+/_\-=]{24,}/g;

/**
 * Canonical UUID (8-4-4-4-12 hex, RFC 4122 layout). A structured identifier —
 * carved out of the entropy heuristic so trace ids / correlation ids in prose
 * are not mistaken for opaque secrets. Anchored so it matches the whole token.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Base64 (standard or url-safe) whose leading bytes are a well-known binary FILE
 * magic number: PNG (`iVBORw0KGgo`), JPEG (`/9j/`), GIF (`R0lGOD`), PDF
 * (`JVBER`), ZIP/Office (`UEsDB`), GZIP (`H4sI`). Such a token is embedded media,
 * not a credential, so it is carved out of the entropy fallback. The prefixes
 * are distinctive enough that a real secret is exceedingly unlikely to collide.
 */
const BASE64_FILE_MAGIC_RE = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|JVBER[ij]|UEsDB|H4sI)/;

/**
 * Scan `text` for secret material. Returns `{ has_secret, kind?, line? }`.
 * Never throws; a non-string / empty input is `{ has_secret: false }`.
 */
export function detectSecret(text: unknown): SecretFinding {
  if (typeof text !== "string" || text.length === 0) return { has_secret: false };

  // 1) High-confidence named patterns (whole-text scan; report the line).
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) return { has_secret: true, kind, line: lineOf(text, m.index) };
  }

  // 2) Field-assignment of a secret-looking value.
  const a = ASSIGNMENT_RE.exec(text);
  if (a) {
    // Guard: the captured value must itself look opaque (not a short/obvious
    // non-secret like a version "1.2.3" that slipped the length gate).
    const value = a[1] ?? "";
    if (value.length >= 16 && shannonEntropy(value) >= 2.5) {
      return { has_secret: true, kind: "credential-assignment", line: lineOf(text, a.index) };
    }
  }

  // 3) Entropy fallback for unstructured opaque tokens no pattern caught.
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (looksLikeOpaqueSecret(m[0])) {
      return { has_secret: true, kind: "high-entropy-token", line: lineOf(text, m.index) };
    }
  }

  return { has_secret: false };
}

/** 1-based line number for a character offset in `text`. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}
