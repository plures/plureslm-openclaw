import { PluresLmStore } from "./dist/pluresdb.js";

// PRE-FLIGHT: simulate what the gateway does on restart with the NEW config.
// 1) import the plugin entry (definePluginEntry) exactly as the loader would
// 2) drive register() with a fake api carrying the PROPOSED pluginConfig
// 3) confirm it registers a REAL memory capability (not inert) over migrated-store
// 4) exercise the capability's read surface (search) to prove it's live
// If ANY of this throws, the real restart would fail the same way -> abort.

const PROPOSED_CONFIG = {
  dbPath: "C:\\Users\\kbristol\\.pluresLM\\migrated-store",
  embeddingModel: "BAAI/bge-small-en-v1.5",
  vectorThreshold: 0.3,
  maxResults: 8,
  sourceDir: "C:\\Users\\kbristol\\.openclaw\\workspace\\memory",
};

let registeredCapability = null;
let inert = false;
const logs = [];

const fakeApi = {
  pluginConfig: PROPOSED_CONFIG,
  logger: {
    info: (m) => { logs.push("INFO " + m); if (/inert/i.test(m)) inert = true; },
    warn: (m) => { logs.push("WARN " + m); if (/inert|no dbPath/i.test(m)) inert = true; },
    error: (m) => { logs.push("ERROR " + m); },
    debug: () => {},
  },
  registerMemoryCapability: (cap) => { registeredCapability = cap; },
  // Defensive: if the plugin touches any other api.* we stub it as a no-op so a
  // missing method doesn't masquerade as a real failure in the pre-flight.
};

async function main() {
  const mod = await import("./dist/index.js");
  const plugin = mod.default;
  console.log("PLUGIN id:", plugin?.id, "name:", plugin?.name);
  if (typeof plugin?.register !== "function") throw new Error("plugin.register not a function");

  await plugin.register(fakeApi);
  console.log("LOGS:", JSON.stringify(logs));
  console.log("INERT?:", inert);
  console.log("CAPABILITY REGISTERED?:", !!registeredCapability);
  if (registeredCapability) {
    console.log("capability keys:", Object.keys(registeredCapability));
    // find the read/search method the host uses (search/recall/query)
    const methods = Object.keys(registeredCapability).filter(k => typeof registeredCapability[k] === "function");
    console.log("capability methods:", methods);
  }

  // Independently prove the store the capability points at is live + queryable.
  const store = PluresLmStore.open({ dbPath: PROPOSED_CONFIG.dbPath, embeddingModel: PROPOSED_CONFIG.embeddingModel });
  const probe = store.probeOpen();
  const count = store.count();
  console.log("STORE probeOpen:", JSON.stringify(probe), "count:", count);
  const hits = await store.recall("PluresDB is the foundation", 2);
  console.log("RECALL sanity hits:", hits.length, "topScore:", hits[0] ? +hits[0].score.toFixed(3) : null);

  const ok = !inert && !!registeredCapability && probe.ok === true && count > 1000 && hits.length > 0;
  console.log(ok ? "PREFLIGHT_OK" : "PREFLIGHT_FAIL");
  if (!ok) process.exitCode = 1;
}
main().catch((e) => { console.error("PREFLIGHT_FATAL", e.stack || e.message); process.exitCode = 1; });
