import { PluresLmStore } from "./dist/pluresdb.js";

const dbPath = "C:\\Users\\kbristol\\.pluresLM\\migrated-store";
const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });

console.log("methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(m => m !== "constructor"));
console.log("count:", store.count());

// Try a semantic search for something we KNOW is in memory
async function main() {
  for (const q of ["PluresDB foundation", "ADO Entra token", "no stubs policy"]) {
    try {
      const res = store.search ? await store.search(q, { limit: 3 }) : "no search()";
      const shaped = Array.isArray(res)
        ? res.map(r => ({
            id: String(r.id || "").slice(0, 10),
            score: r.score,
            text: String(r.content || r.text || "").slice(0, 90),
          }))
        : res;
      console.log(`\nSEARCH "${q}":`, JSON.stringify(shaped, null, 2));
    } catch (e) {
      console.log(`\nSEARCH "${q}" threw:`, e.message);
    }
  }
}
main().then(() => console.log("\nDONE")).catch(e => console.log("FATAL:", e.message));
