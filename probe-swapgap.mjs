import { PluresLmStore } from "./dist/pluresdb.js";

const dbPath = "C:\\Users\\kbristol\\.pluresLM\\migrated-store";
const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });
console.log("COUNT:", store.count());

async function recall(q, k = 3) {
  try {
    const res = await store.recall(q, k);
    if (Array.isArray(res)) {
      return res.map(r => ({
        id: String(r.id || "").slice(0, 12),
        score: Number((r.score ?? r.similarity ?? r.distance ?? 0)).toFixed(3),
        origin: r.origin || (r.data && r.data.origin) || "",
        snippet: String(r.snippet || r.content || r.text || "").slice(0, 90),
      }));
    }
    return res;
  } catch (e) {
    return "THREW: " + e.message;
  }
}

const queries = [
  "swap applied slots.memory plureslm restart migrated-store",
  "SWAP-DIFF v2 plugins.slots.memory handoff exclusive slot",
  "memory-core disabled by default not active owner post-swap verification",
];

const main = async () => {
  for (const q of queries) {
    console.log(`\nQ: ${q}`);
    console.log(JSON.stringify(await recall(q, 3), null, 1));
  }
  console.log("\nDONE");
};
main().catch(e => console.log("FATAL:", e.message));
