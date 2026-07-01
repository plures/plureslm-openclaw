/**
 * QA GATE FIELD-COVERAGE probe (real store(), real native gate).
 *
 * ATTACK #1 (secret placement): a secret hidden NOT in the primary `content`
 * field but in a SECONDARY content-bearing field that the RECALL path surfaces.
 *
 * Recall surfaces (deriveSnippet / deriveSnippetFromData / normalizeHit):
 *   content -> text -> summary -> value -> body -> note -> JSON.stringify(WHOLE PAYLOAD)
 * The gate (#gateWrite) inspects:
 *   #embeddableText(content->text->summary)  ||  deriveSnippet(...)
 * Because of `||`, when content/text/summary is a benign non-empty string,
 * deriveSnippet is NEVER called, so a secret in value/body/note/<any other
 * field> is NEVER inspected — yet a recall can surface it. That is a LEAK.
 *
 * For each case we store via the real store() chokepoint and check get():
 *   persisted=true on a case that carries a real secret in a recallable field
 *   == the gate let a secret through == a real defect.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluresLmStore } from "../dist/api.js";

const dir = process.argv[2] || mkdtempSync(join(tmpdir(), "qa-gatefield-"));
const MODEL = "BAAI/bge-small-en-v1.5";
const store = PluresLmStore.open({ dbPath: dir, embeddingModel: MODEL });

const GHP = "ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx0000000000";
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7examplekeymaterialnotreal0000\n-----END RSA PRIVATE KEY-----";

/**
 * Each case: a node payload that a RECALL would surface (via a content-bearing
 * field or whole-payload JSON), with a real secret placed in a SECONDARY field.
 * expectRefused=true => a correct gate refuses it (get()===null).
 * @type {Array<{label:string,data:Record<string,unknown>,expectRefused:boolean,leakField:string}>}
 */
const CASES = [
  // Benign `content`, real GH token in `value` (recall priority #4).
  {
    label: "secret-in-value-benign-content",
    leakField: "value",
    expectRefused: true,
    data: { content: "deployment notes for the billing service", value: `token ${GHP}`, category: "session", type: "memory-chunk", hash: "h-v1" },
  },
  // Benign `content`, real AKIA in `body` (recall priority #5).
  {
    label: "secret-in-body-benign-content",
    leakField: "body",
    expectRefused: true,
    data: { content: "release runbook overview", body: `aws_access_key_id = ${AKIA}`, category: "session", type: "memory-chunk", hash: "h-b1" },
  },
  // Benign `content`, PEM in `note` (recall priority #6).
  {
    label: "secret-in-note-benign-content",
    leakField: "note",
    expectRefused: true,
    data: { content: "server provisioning summary", note: PEM, category: "session", type: "memory-chunk", hash: "h-n1" },
  },
  // Benign `content`, secret in an ARBITRARY field surfaced only by whole-payload
  // JSON.stringify (recall's final fallback). e.g. `credential`.
  {
    label: "secret-in-arbitrary-field-json-fallback",
    leakField: "credential",
    expectRefused: true,
    data: { content: "integration config doc", credential: `ghp_EXAMPLExNOTxAxREALxGITHUBxTOKENx8888888888`, category: "session", type: "memory-chunk", hash: "h-c1" },
  },
  // No content/text/summary at all -> deriveSnippet IS used; secret in `value`.
  // (This is the case the gate's `|| deriveSnippet` DOES cover — control.)
  {
    label: "secret-in-value-NO-primary-control",
    leakField: "value",
    expectRefused: true,
    data: { value: `token ${GHP}`, category: "session", type: "memory-chunk", hash: "h-vctl1" },
  },
  // CONTROL: benign secondary field, benign content -> must WRITE (not refused).
  {
    label: "clean-secondary-and-primary-control",
    leakField: "(none)",
    expectRefused: false,
    data: { content: "ordinary deployment notes", value: "see the wiki for details", category: "session", type: "memory-chunk", hash: "h-clean1" },
  },
];

const out = [];
for (const c of CASES) {
  const id = `mem:gatefield:${c.label}`;
  const res = store.store([{ id, data: c.data }]);
  const persisted = Boolean(store.get(id));
  // A LEAK = a case that SHOULD be refused but persisted (secret written).
  const leak = c.expectRefused && persisted;
  out.push({
    label: c.label,
    leakField: c.leakField,
    expectRefused: c.expectRefused,
    written: res.written,
    refused: res.refused,
    refusedKind: res.refusedDetail?.[0]?.kind ?? null,
    persisted,
    LEAK: leak,
  });
}

for (const r of out) process.stdout.write(JSON.stringify(r) + "\n");
const leaks = out.filter((r) => r.LEAK);
process.stdout.write(
  JSON.stringify({ SUMMARY: true, dir, total: out.length, leaks: leaks.map((r) => `${r.label}[${r.leakField}]`) }) + "\n",
);
process.exit(leaks.length > 0 ? 7 : 0);
