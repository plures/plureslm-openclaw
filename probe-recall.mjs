import { PluresLmStore } from "./dist/pluresdb.js";

const dbPath = "C:\\Users\\kbristol\\.pluresLM\\migrated-store";
const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });
console.log("count:", store.count());
console.log("hasEmbedder:", store.hasEmbedder && store.hasEmbedder());

async function tryCall(name, fn) {
  try {
    const r = await fn();
    return r;
  } catch (e) {
    return "THREW: " + e.message;
  }
}

async function main() {
  for (const q of ["PluresDB is the foundation", "ADO authentication Entra token", "no stubs hard gate"]) {
    const res = await tryCall("recall", () => store.recall(q, 3));
    let shaped = res;
    if (Array.isArray(res)) {
      shaped = res.map(r => ({
        id: String(r.id || "").slice(0, 10),
        score: r.score ?? r.similarity ?? r.distance,
        text: String(r.content || r.text || r.body || "").slice(0, 100),
      }));
    }
    console.log(`\nRECALL "${q}":`, JSON.stringify(shaped, null, 2));
  }
}
main().then(() => console.log("\nDONE")).catch(e => console.log("FATAL:", e.message));
