import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// What .md files does the source index know about (by path)?
const src = new DatabaseSync("C:\\Users\\kbristol\\.openclaw\\memory\\main.sqlite", { readOnly: true });
const rows = src.prepare("SELECT DISTINCT path FROM chunks").all();
src.close();
const indexed = new Set(rows.map(r => (r.path || "").replace(/\//g, "\\").toLowerCase()));
console.log("distinct indexed paths:", indexed.size);

// Enumerate MEMORY.md + memory/*.md on disk
const ws = "C:\\Users\\kbristol\\.openclaw\\workspace";
const candidates = [];
const memDir = join(ws, "memory");
candidates.push(join(ws, "MEMORY.md"));
for (const f of readdirSync(memDir)) {
  if (f.toLowerCase().endsWith(".md")) candidates.push(join(memDir, f));
}

const missing = [];
for (const p of candidates) {
  let sz = 0;
  try { sz = statSync(p).size; } catch { continue; }
  // match by suffix since index paths may be relative
  const lc = p.toLowerCase();
  const inIndex = [...indexed].some(ip => lc.endsWith(ip) || ip.endsWith(lc) || ip.endsWith(p.split("\\").slice(-2).join("\\").toLowerCase()));
  if (!inIndex) missing.push({ path: p, size: sz });
}
console.log("candidates on disk:", candidates.length);
console.log("MISSING from index:");
for (const m of missing) console.log(`  ${m.path}  (${m.size}b)`);
console.log("MISSING_COUNT:", missing.length);
