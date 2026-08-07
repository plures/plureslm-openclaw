import { DatabaseSync } from "node:sqlite";
import { PluresLmStore } from "./dist/pluresdb.js";

const src = new DatabaseSync("C:\\Users\\kbristol\\.openclaw\\memory\\main.sqlite", { readOnly: true });
const ids = src.prepare("SELECT id FROM chunks ORDER BY id").all().map(r => r.id);
src.close();

// distinct check on source
const distinct = new Set(ids);
console.log(`source rows=${ids.length} distinctIds=${distinct.size} dupCount=${ids.length - distinct.size}`);

const store = PluresLmStore.open({ dbPath: "C:\\Users\\kbristol\\.pluresLM\\migrated-store", embeddingModel: "BAAI/bge-small-en-v1.5" });
console.log("store.count():", store.count());

let present = 0, missing = 0, emptyContent = 0;
const missingSample = [];
for (const id of distinct) {
  let node = null;
  try { node = store.get(id); } catch { node = null; }
  if (node && (node.content ?? "").length > 0) { present += 1; }
  else if (node) { present += 1; emptyContent += 1; }
  else { missing += 1; if (missingSample.length < 5) missingSample.push(id.slice(0,12)); }
}
console.log(JSON.stringify({ distinctSource: distinct.size, presentInTarget: present, missingFromTarget: missing, presentButEmptyContent: emptyContent, missingSample }, null, 2));
console.log(missing === 0 ? "RESULT: STRICT_SUPERSET_OK (every source chunk present in target)" : `RESULT: MISSING ${missing} CHUNKS`);
