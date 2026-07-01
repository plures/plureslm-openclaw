/**
 * QA adversarial DETECTOR probe (pure, no DB). Enumerates realistic evasions
 * the TEST matrix did not cover and prints, per case, what detectSecret() does.
 * This isolates the detector from the gate's field-coverage; the gate probe is
 * separate (qa-gate-field-probe.mjs).
 *
 * Output is JSON lines: { group, label, expectSecret, detected, kind }.
 * The parent (this same file's tail) prints a compact verdict table.
 */
import { detectSecret } from "../dist/redact.js";

/** @type {Array<{group:string,label:string,expectSecret:boolean,text:string}>} */
const CASES = [
  // --- (3) MULTILINE / FORMAT VARIANTS — must be REFUSED -------------------
  {
    group: "multiline",
    label: "full-PEM-with-base64-body",
    expectSecret: true,
    text:
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEpAIBAAKCAQEA1cExampleBodyLineOneAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n" +
      "bWFueUxpbmVzT2ZCYXNlNjRFbmNvZGVkS2V5TWF0ZXJpYWxHb0hlcmVOb3RSZWFs\n" +
      "AnotherLineOfOpaqueBase64KeyMaterialThatIsLongAndRandomLooking01\n" +
      "-----END RSA PRIVATE KEY-----",
  },
  {
    group: "multiline",
    label: "aws-secret-access-key-40char-assignment",
    expectSecret: true,
    // The 40-char SECRET (not the AKIA id) — the high-value half.
    text: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  {
    group: "multiline",
    label: "connection-string-with-password",
    expectSecret: true,
    text:
      "postgres://app_user:S3cr3tP4ssw0rdOpaqueLongValue99@db.internal:5432/prod?sslmode=require",
  },
  {
    group: "multiline",
    label: "dotenv-blob-many-KEY=secret",
    expectSecret: true,
    text:
      "# .env (prod)\n" +
      "DATABASE_URL=postgres://u:p@h/db\n" +
      "STRIPE_SECRET_KEY=" + "sk" + "_live_" + "EXAMPLExNOTxAxREALxSTRIPExKEYx0000" + "\n" +
      "SESSION_SECRET=8f3a9c2e7b1d5460af83c1e29d74b06a55e1f2c3\n",
  },
  {
    group: "multiline",
    label: "json-value-holding-token",
    expectSecret: true,
    text:
      '{\n  "service": "billing",\n  "auth_token": "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000",\n  "region": "us-east-1"\n}',
  },
  {
    group: "multiline",
    label: "private-key-assignment-opaque",
    expectSecret: true,
    text: 'private_key = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDxOpaqueKeyMaterial99x"',
  },

  // --- (4) CASE / WHITESPACE / OBFUSCATION ---------------------------------
  {
    group: "obfuscation",
    label: "bearer-mixed-case-extra-space",
    expectSecret: true,
    text: "Authorization:   BeArEr    sk-proj-EXAMPLE-NOT-A-REAL-OPENAI-KEY-00000000",
  },
  {
    group: "obfuscation",
    label: "github-token-uppercase-prefix",
    // Real gh tokens are lowercase prefix; uppercase GHP_ is NOT a real token shape.
    expectSecret: false,
    text: "token GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab",
  },
  {
    group: "obfuscation",
    label: "base64-secret-with-newlines-wrapped",
    // A long opaque base64 secret wrapped across lines (PEM-less). Each line is
    // its own token; whether ANY single line trips entropy is the question.
    expectSecret: true,
    text:
      "set secret to\n" +
      "c2VjcmV0LWJhc2U2NC1vcGFxdWUtdmFsdWUtdGhhdC1pcy1sb25n\n" +
      "YW5kLXJhbmRvbS1sb29raW5nLWNvbnRpbnVlZC1vbi1uZXh0LWxpbmU=",
  },
  {
    group: "obfuscation",
    label: "url-encoded-token-in-query",
    // URL-encoded: %2B etc. The token loses its raw base64 class mix.
    expectSecret: true,
    text: "callback https://x/cb?access_token=ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000&state=1",
  },
  {
    group: "obfuscation",
    label: "spaced-out-akia-NOT-a-secret",
    // Spacing breaks the AKIA contiguity — genuinely not a usable key; should NOT flag.
    expectSecret: false,
    text: "the prefix A K I A is how aws keys start, for reference in the docs",
  },

  // --- (5) FALSE-POSITIVE PRESSURE — must STAY clean (NOT refused) ----------
  {
    group: "fp-pressure",
    label: "long-base64-test-fixture",
    expectSecret: false,
    // A long base64 PNG fixture (has the magic prefix) used in real test code.
    text:
      "const FIXTURE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';",
  },
  {
    group: "fp-pressure",
    label: "git-sha-and-sha256-in-prose",
    expectSecret: false,
    text:
      "We bisected between 9e1a7c4f2b8d6e0a3c5f7b9d1e2a4c6f8b0d2e4a and the artifact digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 to find the regression.",
  },
  {
    group: "fp-pressure",
    label: "uuids-in-prose",
    expectSecret: false,
    text:
      "Correlation id 123e4567-e89b-12d3-a456-426614174000 and span 550e8400-e29b-41d4-a716-446655440000 were recorded in the trace.",
  },
  {
    group: "fp-pressure",
    label: "long-english-paragraph",
    expectSecret: false,
    text:
      "The quarterly planning meeting covered roadmap priorities, staffing changes, and the migration timeline. Everyone agreed that documentation needs to improve and that we should invest in automated testing before the next release cycle begins in earnest.",
  },
  {
    group: "fp-pressure",
    label: "markdown-table",
    expectSecret: false,
    text:
      "| Service | Region | Status |\n|---|---|---|\n| billing | us-east-1 | healthy |\n| auth | eu-west-1 | degraded |\n| search | ap-south-1 | healthy |",
  },
  {
    group: "fp-pressure",
    label: "minified-js",
    expectSecret: false,
    text:
      "(function(){var a=function(b){return b*2};var c=[1,2,3].map(a);console.log(c.reduce(function(x,y){return x+y},0));})();",
  },
  {
    group: "fp-pressure",
    label: "stack-trace",
    expectSecret: false,
    text:
      "TypeError: Cannot read properties of undefined (reading 'id')\n    at processNode (/app/src/pluresdb.js:855:21)\n    at Object.store (/app/src/pluresdb.js:893:34)\n    at async sync (/app/src/memory-capability.js:351:12)",
  },
  {
    group: "fp-pressure",
    label: "base64-jpeg-fixture",
    expectSecret: false,
    text: "thumbnail /9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQE which is a jpeg",
  },
];

const rows = CASES.map((c) => {
  const f = detectSecret(c.text);
  const correct = f.has_secret === c.expectSecret;
  return {
    group: c.group,
    label: c.label,
    expectSecret: c.expectSecret,
    detected: f.has_secret,
    kind: f.kind ?? null,
    correct,
  };
});

// Compact verdict: leaks = a true secret NOT detected; FPs = clean flagged.
const leaks = rows.filter((r) => r.expectSecret && !r.detected);
const fps = rows.filter((r) => !r.expectSecret && r.detected);

for (const r of rows) {
  process.stdout.write(JSON.stringify(r) + "\n");
}
process.stdout.write(
  JSON.stringify({
    SUMMARY: true,
    total: rows.length,
    correct: rows.filter((r) => r.correct).length,
    leaks: leaks.map((r) => r.label),
    falsePositives: fps.map((r) => `${r.label}(${r.kind})`),
  }) + "\n",
);
