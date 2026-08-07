/**
 * PluresLM vs Scout built-in memory comparison gate.
 *
 * This is an evidence/demo gate, not a replacement for the lower-level recall
 * gates. It compares the shipped PluresLM manager with a deliberately small
 * "built-in Scout style" baseline: flat chunks ranked only by lexical overlap,
 * with no vector semantics, no associative graph expansion, and no structural
 * salience. The baseline is intentionally transparent so each PluresLM win is
 * attributable to a specific feature rather than to hidden test machinery.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPluresLmSearchManager } from "../dist/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const P2_CHILD = join(here, "p2-salience-recall-child.mts");
const MODEL = "BAAI/bge-small-en-v1.5";

let failures = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures += 1;
  console.log(
    `  [${cond ? "PASS" : "FAIL"}] ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`,
  );
}

type BaselineDoc = {
  id: string;
  text: string;
};

type BaselineHit = {
  id: string;
  score: number;
  snippet: string;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function baselineSearch(docs: BaselineDoc[], query: string, maxResults = 5): BaselineHit[] {
  const queryTokens = tokens(query);
  return docs
    .map((doc) => {
      const docTokens = tokens(doc.text);
      let overlap = 0;
      for (const token of queryTokens) {
        if (docTokens.has(token)) overlap += 1;
      }
      return {
        id: doc.id,
        score: queryTokens.size === 0 ? 0 : overlap / queryTokens.size,
        snippet: doc.text,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxResults);
}

async function gateSemanticRecall(): Promise<void> {
  console.log("\n=== COMPARISON A: semantic recall beyond lexical built-in memory ===");
  const root = mkdtempSync(join(tmpdir(), "plureslm-compare-semantic-"));
  try {
    const docs: BaselineDoc[] = [
      {
        id: "semantic-only",
        text:
          "SEMANTIC_ONLY: The x509 leaf rotation must finish before expiry for the gateway.",
      },
    ];
    const query = "certificate renewal deadline";
    const builtinHits = baselineSearch(docs, query);
    check("built-in lexical baseline has no keyword hit", builtinHits.length === 0, builtinHits);

    const { store, manager } = createPluresLmSearchManager({
      dbPath: root,
      embeddingModel: MODEL,
      vectorThreshold: 0,
      maxResults: 3,
    });
    const written = store.store([
      {
        id: docs[0]!.id,
        data: {
          content: docs[0]!.text,
          category: "memory",
          type: "memory-chunk",
        },
      },
    ]);
    const pluresHits = await manager.search(query, { maxResults: 3 });
    const semanticHit = pluresHits.find((h) => h.path === "semantic-only");

    check("PluresLM wrote the semantic fixture", written.written >= 1, written);
    check("PluresLM recalls the no-keyword semantic match", Boolean(semanticHit), {
      query,
      hits: pluresHits.map((h) => ({ path: h.path, score: h.score, via: h.vectorScore !== undefined ? "vector" : "text" })),
    });
    check("semantic match comes from vector recall", semanticHit?.vectorScore !== undefined, semanticHit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function gateAssociativeRecall(): Promise<void> {
  console.log("\n=== COMPARISON B: associative graph recall beyond flat built-in memory ===");
  const root = mkdtempSync(join(tmpdir(), "plureslm-compare-graph-"));
  try {
    const alpha = "# alpha\n\nALPHA kraken deployment runbook rollout steps.\n";
    const beta = "# beta\n\nBETA photosynthesis chlorophyll wavelength absorption in leaves.\n";
    const gamma = "# gamma\n\nGAMMA postgres backup schedule and pg_dump retention policy.\n";
    const query = "kraken deployment runbook";
    const alphaPath = join(root, "session-alpha.md");
    const betaPath = join(root, "session-beta.md");
    const gammaPath = join(root, "session-gamma.md");
    writeFileSync(alphaPath, alpha, "utf8");
    writeFileSync(betaPath, beta, "utf8");
    writeFileSync(gammaPath, gamma, "utf8");

    const builtinHits = baselineSearch(
      [
        { id: "mem:session:session-alpha:0", text: alpha },
        { id: "mem:session:session-beta:0", text: beta },
        { id: "mem:session:session-gamma:0", text: gamma },
      ],
      query,
    );
    check(
      "built-in lexical baseline returns the direct alpha only",
      builtinHits.length === 1 && builtinHits[0]?.id === "mem:session:session-alpha:0",
      builtinHits,
    );

    const { manager } = createPluresLmSearchManager({
      dbPath: root,
      embeddingModel: MODEL,
      vectorThreshold: 0.8,
      maxResults: 8,
    });
    await manager.sync({
      reason: "comparison-graph",
      force: false,
      sessionFiles: [alphaPath, betaPath, gammaPath],
    });
    const pluresHits = await manager.search(query, { maxResults: 8 });
    const betaGraphHit = pluresHits.find(
      (h) =>
        h.path === "mem:session:session-beta:0" &&
        h.citation?.startsWith("plureslm:graph:") &&
        h.vectorScore === undefined &&
        h.textScore === undefined,
    );

    check("PluresLM returns the direct alpha seed", pluresHits[0]?.path === "mem:session:session-alpha:0", {
      top: pluresHits[0]?.path,
    });
    check("PluresLM also surfaces the unrelated beta by graph association", Boolean(betaGraphHit), {
      hits: pluresHits.map((h) => ({
        path: h.path,
        score: h.score,
        citation: h.citation,
        via: h.citation?.startsWith("plureslm:graph:") ? "graph" : "direct",
      })),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSalienceChild(dir: string) {
  const res = spawnSync(process.execPath, [TSX_CLI, P2_CHILD, dir, "salient"], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const stdout = (res.stdout ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    parsed = null;
  }
  return { status: res.status, stdout, stderr: (res.stderr ?? "").trim(), parsed };
}

function gateStructuralSalience(): void {
  console.log("\n=== COMPARISON C: structural salience beyond score-only built-in ranking ===");
  const root = mkdtempSync(join(tmpdir(), "plureslm-compare-salience-"));
  try {
    mkdirSync(root, { recursive: true });
    const result = runSalienceChild(root);
    if (result.stderr) console.log("  salience child stderr:", result.stderr);
    check("salience child exits cleanly", result.status === 0, result.parsed?.error ?? result.stdout);
    check("PluresLM produced a non-empty structural salient set", Array.isArray(result.parsed?.topRanked) && result.parsed.topRanked.length > 0, result.parsed?.topRanked);
    const witness = result.parsed?.witness as
      | {
          salientId: string;
          salientRank: number;
          salientScore: number;
          peerId: string;
          peerRank: number;
          peerScore: number;
        }
      | null
      | undefined;
    check("PluresLM has a salience witness", Boolean(witness), witness);
    if (witness) {
      check("salient hit outranks a non-salient peer", witness.salientRank < witness.peerRank, witness);
      check(
        "the peer had equal-or-better raw similarity, so score-only built-in ranking would not make this flip",
        witness.peerScore >= witness.salientScore,
        witness,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  console.log("plureslm-openclaw Scout memory comparison gate");
  await gateSemanticRecall();
  await gateAssociativeRecall();
  gateStructuralSalience();
  console.log(`\n=== SCOUT MEMORY COMPARISON RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
