import { PluresLmStore } from "./dist/pluresdb.js";
const dbPath = "C:\\Users\\kbristol\\.pluresLM\\migrated-store";
const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });

const id = "c1e70d7c12"; // top hit from "PluresDB is the foundation"
async function main() {
  // get() may need full id; recall returned truncated. Re-recall to get full id.
  const hits = await store.recall("PluresDB is the foundation", 1);
  console.log("full hit object keys:", Object.keys(hits[0] || {}));
  console.log("full hit object:", JSON.stringify(hits[0], null, 2).slice(0, 800));
  const fullId = hits[0]?.id;
  console.log("\nfullId:", fullId);
  try {
    const node = store.get(fullId);
    console.log("\nget() keys:", node ? Object.keys(node) : node);
    console.log("get() object:", JSON.stringify(node, null, 2).slice(0, 1200));
  } catch (e) {
    console.log("get() threw:", e.message);
  }
}
main().then(() => console.log("\nDONE")).catch(e => console.log("FATAL:", e.message));
