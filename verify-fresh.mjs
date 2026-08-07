import { PluresLmStore } from "./dist/pluresdb.js";
const store = PluresLmStore.open({ dbPath: "C:\\Users\\kbristol\\.pluresLM\\migrated-store", embeddingModel: "BAAI/bge-small-en-v1.5" });
console.log("count:", store.count());
async function main() {
  // Queries targeting content unique to the 4 freshly-ingested files
  for (const q of ["pluresLM-maintenance cron isolated lane tooling gap", "pending work ledger", "worktask fork ruling"]) {
    const hits = await store.recall(q, 3);
    const shaped = hits.map(h => ({ score: +h.score.toFixed(3), origin: h.data?.origin, path: (h.data?.path||"").split("\\").pop(), snip: String(h.snippet||"").slice(0,70).replace(/\n/g," ") }));
    console.log(`\nRECALL "${q}":`, JSON.stringify(shaped, null, 2));
  }
}
main().then(()=>console.log("\nDONE")).catch(e=>console.log("FATAL:",e.message));
