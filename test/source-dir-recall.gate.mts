/**
 * Gate: configured sourceDir is ingested by the lazy search path.
 *
 * This protects the live OpenClaw pluresLM mode where memory_search is invoked
 * directly as a tool; no human/manual force-sync step is allowed. The first
 * manager.search() must use the shipped sync/write path to ingest configured
 * memory docs, then exact readFile() must retrieve the returned node by id.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMemoryCapability } from "../dist/api.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${status}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const SENTINEL = "plureslm source-dir lazy search sentinel orchid cobalt recall";
const QUERY = "orchid cobalt recall";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "plureslm-source-dir-gate-"));
  const dbPath = join(root, "store");
  const sourceDir = join(root, "memory");
  try {
    writeFileSync(join(root, "placeholder.txt"), "root stays writable\n", "utf8");
    // mkdir via writeFileSync parent is not automatic.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "source-note.md"),
      `# Source Note\n\nThe ${SENTINEL} must be found without a manual force sync.\n`,
      "utf8",
    );

    const capability = buildMemoryCapability({
      dbPath,
      sourceDir,
      embeddingModel: "BAAI/bge-small-en-v1.5",
      vectorThreshold: 0,
      maxResults: 5,
    });
    const got = await capability.runtime!.getMemorySearchManager({ cfg: {} as never, agentId: "gate" });
    check("manager available", Boolean(got.manager) && !got.error, got.error ?? null);
    if (!got.manager) return;

    const before = got.manager.status().chunks ?? 0;
    const hits = await got.manager.search(QUERY, { maxResults: 5 });
    const after = got.manager.status().chunks ?? 0;
    console.log("  hits:", JSON.stringify(hits.map((h) => ({ path: h.path, score: h.score, snippet: h.snippet.slice(0, 90) }))));

    check("lazy search ingested at least one sourceDir chunk", after > before, { before, after });
    check("search returns non-empty hits", hits.length > 0, { count: hits.length });
    const hit = hits.find((h) => h.snippet.includes(SENTINEL));
    check("search hit contains sentinel", Boolean(hit), hits[0]?.snippet);
    check("hit is tagged as memory source", hit?.source === "memory", hit?.source);

    if (hit) {
      const read = await got.manager.readFile({ relPath: hit.path, from: hit.startLine, lines: 3 });
      check("readFile exact id returns sentinel text", read.text.includes(SENTINEL), read);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`source-dir recall gate failed: ${failures}`);
    process.exit(1);
  }
  console.log("source-dir recall gate passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
