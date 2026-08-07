import { PluresLmStore } from "./dist/pluresdb.js";

const targets = [
  "C:\\Users\\kbristol\\.pluresLM\\migrated-store",
  "C:\\Users\\kbristol\\.openclaw\\pluresLM-store",
];

for (const dbPath of targets) {
  console.log("\n===== PROBE dbPath:", dbPath, "=====");
  try {
    const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });
    const open = store.probeOpen();
    console.log("probeOpen:", JSON.stringify(open));
    if (open.ok) {
      let c = null, st = null, sample = null;
      try { c = store.count(); } catch (e) { c = "count() threw: " + e.message; }
      try { st = store.status(); } catch (e) { st = "status() threw: " + e.message; }
      try {
        const r = store.list ? store.list({ limit: 5 }) : null;
        sample = Array.isArray(r)
          ? r.slice(0, 5).map(x => (x && (x.id || x.content))
              ? String(x.id || "").slice(0, 12) + ":" + String(x.content || x.text || "").slice(0, 60)
              : JSON.stringify(x).slice(0, 80))
          : r;
      } catch (e) { sample = "list() threw: " + e.message; }
      console.log("count:", JSON.stringify(c));
      console.log("status:", JSON.stringify(st));
      console.log("sample:", JSON.stringify(sample, null, 2));
    }
    console.log("RESULT:", open.ok ? "STORE_OPENS_OK" : "STORE_OPEN_FAILED");
  } catch (e) {
    console.log("EXCEPTION:", e && e.message ? e.message : String(e));
    console.log("RESULT: PROBE_EXCEPTION");
  }
}
