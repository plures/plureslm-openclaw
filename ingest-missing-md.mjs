import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { PluresLmStore } from "./dist/pluresdb.js";

const FILES = [
  "C:\\Users\\kbristol\\.openclaw\\workspace\\memory\\2026-06-30.md",
  "C:\\Users\\kbristol\\.openclaw\\workspace\\memory\\2026-07-01.md",
  "C:\\Users\\kbristol\\.openclaw\\workspace\\memory\\BACKLOG-2026-06-29.md",
  "C:\\Users\\kbristol\\.openclaw\\workspace\\memory\\PENDING-WORK-LEDGER-2026-06-29.md",
];

const TARGET = "C:\\Users\\kbristol\\.pluresLM\\migrated-store";
const APPLY = process.env.APPLY === "1";

// Deterministic chunker: split on markdown headings (## / ###) and cap blocks
// at ~40 lines so chunks stay embeddable. Mirrors the builtin index's heading-
// aware chunking closely enough for retrieval; line ranges preserved.
function chunkFile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = [];
  let startLine = 1;
  const MAX = 40;
  const flush = (endLine) => {
    const body = cur.join("\n").trim();
    if (body.length > 0) chunks.push({ startLine, endLine, text: body });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const isHeading = /^#{1,6}\s/.test(ln) || /^---\s*$/.test(ln);
    if ((isHeading && cur.length > 0) || cur.length >= MAX) {
      flush(i); // previous chunk ends at line i (0-based -> line i = 1-based i)
      startLine = i + 1;
    }
    cur.push(ln);
  }
  flush(lines.length);
  return chunks;
}

async function main() {
  const store = PluresLmStore.open({ dbPath: TARGET, embeddingModel: "BAAI/bge-small-en-v1.5" });
  const before = store.count();
  console.log("store.count() before:", before);

  const nodes = [];
  for (const path of FILES) {
    let sz = 0;
    try { sz = statSync(path).size; } catch { console.log("MISSING FILE:", path); continue; }
    const chunks = chunkFile(path);
    console.log(`${path}  (${sz}b) -> ${chunks.length} chunk(s)`);
    for (const c of chunks) {
      // Stable id: sha256(path + lineRange + text-hash) so re-runs are idempotent.
      const textHash = createHash("sha256").update(c.text).digest("hex");
      const id = createHash("sha256").update(`${path}#${c.startLine}-${c.endLine}#${textHash}`).digest("hex");
      nodes.push({
        id,
        data: {
          content: c.text,
          category: "memory-chunk",
          path,
          source: "workspace-md",
          start_line: c.startLine,
          end_line: c.endLine,
          hash: textHash,
          updated_at: Math.floor(statSync(path).mtimeMs),
          origin: "fresh-ingest-2026-07-02",
        },
      });
    }
  }
  console.log("TOTAL new chunk nodes:", nodes.length);

  if (!APPLY) {
    console.log("\nDRY-RUN (set APPLY=1 to write). Sample:");
    for (const n of nodes.slice(0, 3)) {
      console.log(`  id=${n.id.slice(0,12)} lines=${n.data.start_line}-${n.data.end_line} :: ${n.data.content.slice(0,70).replace(/\n/g," ")}`);
    }
    return;
  }

  const res = store.store(nodes);
  console.log("store() result:", JSON.stringify({ written: res.written, skipped: res.skipped, refused: res.refused, errors: res.errors }));
  if (res.refused > 0 && Array.isArray(res.refusedDetail)) {
    for (const r of res.refusedDetail.slice(0, 10)) console.log(`  REFUSED id=${String(r.id).slice(0,12)} reason=${r.reason} kind=${r.kind||"?"}`);
  }
  const after = store.count();
  console.log("store.count() after:", after, `(+${after - before})`);
  console.log("INGEST_DONE");
}
main().then(() => {}).catch(e => { console.error("INGEST_FATAL", e.stack || e.message); process.exitCode = 1; });
