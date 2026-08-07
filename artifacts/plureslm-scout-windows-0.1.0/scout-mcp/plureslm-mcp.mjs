#!/usr/bin/env node
/**
 * PluresLM Scout MCP server.
 *
 * Dependency-free stdio MCP/JSON-RPC server that exposes the built PluresLM
 * store to Scout without depending on OpenClaw's plugin memory capability seam.
 * It imports dist/pluresdb.js, so run `pnpm build` before starting.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
const DEFAULT_MAX_RESULTS = 8;
const CHUNK_MAX_CHARS = 2000;
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text", ".mdx"]);

function numberValue(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function readConfig() {
  const repoRoot = resolve(
    argValue("repo-root") ??
      process.env.PLURESLM_REPO_ROOT ??
      resolve(new URL(".", import.meta.url).pathname, ".."),
  );
  return {
    repoRoot,
    dbPath: argValue("db-path") ?? process.env.PLURESLM_DB_PATH,
    sourceDir: argValue("source-dir") ?? process.env.PLURESLM_SOURCE_DIR,
    embeddingModel:
      argValue("embedding-model") ??
      process.env.PLURESLM_EMBEDDING_MODEL ??
      DEFAULT_EMBEDDING_MODEL,
    vectorThreshold: numberValue(
      argValue("vector-threshold") ?? process.env.PLURESLM_VECTOR_THRESHOLD,
    ),
    maxResults: numberValue(
      argValue("max-results") ?? process.env.PLURESLM_MAX_RESULTS,
      DEFAULT_MAX_RESULTS,
    ),
    compressAboveTokens: numberValue(
      argValue("compress-above-tokens") ?? process.env.PLURESLM_COMPRESS_ABOVE_TOKENS,
    ),
    reactivePx: booleanValue(argValue("reactive-px") ?? process.env.PLURESLM_REACTIVE_PX),
    reactivePxPolicy:
      argValue("reactive-px-policy") ?? process.env.PLURESLM_REACTIVE_PX_POLICY,
    pxNapiModule: argValue("px-napi-module") ?? process.env.PLURESLM_PX_NAPI_MODULE,
  };
}

const config = readConfig();
let storePromise = null;
let nativeStatusPromise = null;
let prewarmStarted = false;

async function getStore() {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    if (!config.dbPath) {
      throw new Error("PLURESLM_DB_PATH or --db-path is required.");
    }
    const modulePath = resolve(config.repoRoot, "dist", "pluresdb.js");
    if (!existsSync(modulePath)) {
      throw new Error(`Built PluresLM runtime not found: ${modulePath}. Run pnpm build.`);
    }
    const { PluresLmStore } = await import(pathToFileURL(modulePath).href);
    return PluresLmStore.open({
      dbPath: config.dbPath,
      embeddingModel: config.embeddingModel,
      vectorThreshold: config.vectorThreshold,
      maxResults: config.maxResults,
      compressAboveTokens: config.compressAboveTokens,
      reactivePx: config.reactivePx,
      reactivePxPolicy: config.reactivePxPolicy,
    });
  })();
  return storePromise;
}

async function getNativeStatus() {
  if (nativeStatusPromise) return nativeStatusPromise;
  nativeStatusPromise = (async () => {
    const store = await getStore();
    const status = store.status();
    return {
      provider: "plureslm",
      dbPath: status.dbPath,
      embeddingModel: status.embeddingModel,
      embeddingDimension: status.embeddingDimension,
      totalNodes: status.totalNodes,
      typeCounts: status.typeCounts,
      vectorAvailable: store.probeVector(),
      embeddingAvailable: store.hasEmbedder(),
    };
  })();
  return nativeStatusPromise;
}

function quickStatus() {
  const modulePath = resolve(config.repoRoot, "dist", "pluresdb.js");
  const runtimeAvailable = existsSync(modulePath);
  return {
    provider: "plureslm",
    dbPath: config.dbPath,
    embeddingModel: config.embeddingModel,
    runtimeAvailable,
    runtimePath: modulePath,
    status: runtimeAvailable && !!config.dbPath ? "ready" : "configuration-error",
    detail:
      "MCP server is reachable. Native PluresDB status is available via plures_native_status.",
  };
}

function prewarmStore() {
  if (prewarmStarted) return;
  prewarmStarted = true;
  const timer = setTimeout(() => {
    void getStore().catch(() => {
      // Explicit tool calls surface load/configuration errors.
    });
  }, 5000);
  timer.unref?.();
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    isError,
  };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function slugify(value) {
  return value
    .replace(/[\\/\s]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function chunkText(raw) {
  const lines = raw.split(/\r?\n/);
  const chunks = [];
  let buf = [];
  let bufStartLine = 1;
  let cursorLine = 0;
  let pendingParagraph = [];
  let paragraphStartLine = 1;
  let bufChars = 0;

  const flush = (endLine) => {
    const content = buf.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        content,
        chunkIndex: chunks.length,
        startLine: bufStartLine,
        endLine,
        hash: sha256(content),
      });
    }
    buf = [];
  };

  const closeParagraph = (paraEndLine) => {
    if (pendingParagraph.length === 0) return;
    const paraText = pendingParagraph.join("\n");
    const paraChars = paraText.length;
    if (bufChars > 0 && bufChars + paraChars > CHUNK_MAX_CHARS) {
      flush(paragraphStartLine - 1);
      bufStartLine = paragraphStartLine;
      bufChars = 0;
    }
    if (buf.length === 0) bufStartLine = paragraphStartLine;
    if (buf.length > 0) buf.push("");
    buf.push(...pendingParagraph);
    bufChars += paraChars + (bufChars > 0 ? 1 : 0);
    pendingParagraph = [];
    if (paraChars >= CHUNK_MAX_CHARS) {
      flush(paraEndLine);
      bufChars = 0;
    }
  };

  for (const line of lines) {
    cursorLine += 1;
    if (line.trim().length === 0) {
      closeParagraph(cursorLine - 1);
      continue;
    }
    if (pendingParagraph.length === 0) paragraphStartLine = cursorLine;
    pendingParagraph.push(line);
  }
  closeParagraph(cursorLine);
  flush(cursorLine);
  return chunks;
}

function listTextFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTextFiles(full));
    } else if (entry.isFile() && TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function buildNodes(filePath, kind, idStem, nowIso, syncEpoch) {
  let rawText;
  let stat;
  try {
    rawText = readFileSync(filePath, "utf8");
    const st = statSync(filePath);
    stat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
  const source = kind === "session" ? "sessions" : "memory";
  const idPrefix = kind === "session" ? "mem:session" : "mem:memory";
  return chunkText(rawText).map((chunk) => ({
    id: `${idPrefix}:${idStem}:${chunk.chunkIndex}`,
    data: {
      content: chunk.content,
      category: kind,
      type: "memory-chunk",
      source,
      path: filePath,
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      timestamp: nowIso,
      syncEpoch,
    },
  }));
}

function contentFromData(data) {
  if (!data || typeof data !== "object") return "";
  for (const key of ["content", "text", "summary", "value", "body", "note"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return JSON.stringify(data, null, 2);
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function stringField(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizePxAction(args = {}) {
  const explicit = args.context;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return explicit;
  }
  const actionType = stringField(args.actionType ?? args.action_type);
  if (!actionType.trim()) {
    throw new Error("actionType is required.");
  }
  return {
    action_type: actionType,
    target: stringField(args.target, undefined),
    session_type: stringField(args.sessionType ?? args.session_type, "main"),
    metadata:
      args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
        ? args.metadata
        : {},
  };
}

function summarizeConstraints(constraints) {
  return constraints.map((node) => {
    const constraint =
      node.data && typeof node.data.constraint === "object" ? node.data.constraint : node.data;
    return {
      id:
        typeof constraint.id === "string"
          ? constraint.id
          : typeof node.id === "string"
            ? node.id
            : undefined,
      description:
        typeof constraint.description === "string" ? constraint.description : undefined,
      severity: typeof constraint.severity === "string" ? constraint.severity : undefined,
      fix: typeof constraint.fix === "string" ? constraint.fix : undefined,
      timestamp: node.timestamp,
      constraint,
    };
  });
}

async function loadPxNapi() {
  if (!config.pxNapiModule) {
    throw new Error(
      "Praxis px-napi is not configured. Set PLURESLM_PX_NAPI_MODULE or --px-napi-module to a built px-napi module path/package.",
    );
  }
  return import(config.pxNapiModule);
}

const tools = [
  {
    name: "plures_status",
    description: "Report fast PluresLM MCP server status without loading the embedding model.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "plures_native_status",
    description: "Report full PluresLM native backend status, including vector and embedding availability.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "plures_recall",
    description: "Recall memories from PluresDB using vector search, text fallback, and optional graph expansion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1 },
        includeGraph: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "plures_read",
    description: "Read one PluresLM memory node by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "plures_sync",
    description: "Ingest session transcript files and, when force is true, the configured source directory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionFiles: { type: "array", items: { type: "string" }, default: [] },
        sourceDir: { type: "string" },
        force: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "px_validate",
    description: "Validate Praxis .px source using configured px-napi.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { type: "string" } },
    },
  },
  {
    name: "px_compile",
    description: "Compile Praxis .px source to AST/IR using configured px-napi.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { type: "string" } },
    },
  },
  {
    name: "px_load_policy",
    description: "Load Praxis .px policy source into the native PluresDB policy engine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: { type: "string" } },
    },
  },
  {
    name: "px_insert_constraint",
    description: "Insert or update one structured Praxis constraint in PluresDB.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["constraint"],
      properties: { constraint: { type: "object" } },
    },
  },
  {
    name: "px_list_constraints",
    description: "List persisted Praxis constraints available to the native policy engine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        severity: { type: "string" },
        includeRaw: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "px_check_action",
    description: "Evaluate a proposed memory, plan, or agent action through the native Praxis policy engine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actionType: { type: "string" },
        target: { type: "string" },
        sessionType: { type: "string" },
        metadata: { type: "object" },
        context: { type: "object" },
      },
    },
  },
  {
    name: "px_explain_violation",
    description: "Evaluate a proposed action and return matching policy context and remediation hints.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actionType: { type: "string" },
        target: { type: "string" },
        sessionType: { type: "string" },
        metadata: { type: "object" },
        context: { type: "object" },
      },
    },
  },
];

async function callTool(name, args = {}) {
  if (name === "plures_status") {
    return textResult(quickStatus());
  }

  if (name === "plures_native_status") {
    return textResult(await getNativeStatus());
  }

  if (name === "plures_recall") {
    const store = await getStore();
    const query = String(args.query ?? "");
    if (!query.trim()) return textResult({ error: "query is required" }, true);
    const hits = store.recall(query, numberValue(args.maxResults, config.maxResults));
    const results = hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      via: hit.via,
      snippet: hit.snippet,
      category: hit.category,
      timestamp: hit.timestamp,
    }));
    if (args.includeGraph !== false) {
      const seen = new Set(results.map((r) => r.id));
      for (const seed of hits.slice(0, 3)) {
        for (const neighbor of store.neighbors(seed.id, 1)) {
          if (seen.has(neighbor.id)) continue;
          seen.add(neighbor.id);
          results.push({
            id: neighbor.id,
            score: seed.score,
            via: "graph",
            snippet: contentFromData(neighbor.data),
            category:
              typeof neighbor.data.category === "string"
                ? neighbor.data.category
                : undefined,
            timestamp:
              typeof neighbor.data.timestamp === "string"
                ? neighbor.data.timestamp
                : undefined,
          });
        }
      }
    }
    return textResult({ query, results });
  }

  if (name === "plures_read") {
    const store = await getStore();
    const id = String(args.id ?? "");
    if (!id.trim()) return textResult({ error: "id is required" }, true);
    const data = store.get(id);
    return textResult({ id, found: !!data, text: contentFromData(data), data });
  }

  if (name === "plures_sync") {
    const store = await getStore();
    const work = [];
    for (const filePath of Array.isArray(args.sessionFiles) ? args.sessionFiles : []) {
      work.push({
        path: filePath,
        kind: "session",
        idStem: slugify(basename(filePath, extname(filePath))),
      });
    }
    const root = args.sourceDir ?? config.sourceDir;
    if (args.force === true && root) {
      for (const filePath of listTextFiles(root)) {
        let rel = filePath;
        try {
          rel = relative(root, filePath) || basename(filePath);
        } catch {
          rel = basename(filePath);
        }
        work.push({ path: filePath, kind: "memory", idStem: slugify(rel) });
      }
    }

    const nowIso = new Date().toISOString();
    const syncEpoch = Date.now();
    const totals = {
      filesConsidered: work.length,
      unreadable: [],
      written: 0,
      skipped: 0,
      refused: 0,
      refusedDetail: [],
      compressed: 0,
      tokensSaved: 0,
    };

    for (const item of work) {
      const nodes = buildNodes(item.path, item.kind, item.idStem, nowIso, syncEpoch);
      if (!nodes) {
        totals.unreadable.push(item.path);
        continue;
      }
      const result = store.store(nodes);
      totals.written += result.written;
      totals.skipped += result.skipped;
      totals.refused += result.refused;
      totals.refusedDetail.push(...result.refusedDetail);
      totals.compressed += result.compressed;
      totals.tokensSaved += result.tokensSaved;
    }

    if (totals.written > 0) store.linkRecent(syncEpoch);
    totals.consolidation = store.consolidate({ force: args.force === true });
    return textResult(totals);
  }

  if (name === "px_validate" || name === "px_compile") {
    try {
      const px = await loadPxNapi();
      const source = String(args.source ?? "");
      const fn =
        name === "px_validate"
          ? px.validate ?? px.parse ?? px.compile
          : px.compile ?? px.parse;
      if (typeof fn !== "function") {
        return textResult(
          {
            ok: false,
            error: `Configured px-napi module does not expose a ${name === "px_validate" ? "validate/parse/compile" : "compile/parse"} function.`,
            exports: Object.keys(px),
          },
          true,
        );
      }

      const result = await fn(source);
      return textResult({ ok: true, result });
    } catch (error) {
      return textResult(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }

  if (name === "px_load_policy") {
    const store = await getStore();
    const source = String(args.source ?? "");
    if (!source.trim()) return textResult({ ok: false, error: "source is required" }, true);
    const result = store.pxLoadPolicy(source);
    return textResult({ ok: true, result });
  }

  if (name === "px_insert_constraint") {
    const store = await getStore();
    const constraint = objectValue(args.constraint, "constraint");
    const result = store.pxInsertConstraint(constraint);
    return textResult({ ok: true, result });
  }

  if (name === "px_list_constraints") {
    const store = await getStore();
    const severity = typeof args.severity === "string" ? args.severity : undefined;
    let constraints = summarizeConstraints(store.pxListConstraints());
    if (severity) constraints = constraints.filter((c) => c.severity === severity);
    if (args.includeRaw !== true) {
      constraints = constraints.map(({ constraint, ...rest }) => rest);
    }
    return textResult({ ok: true, count: constraints.length, constraints });
  }

  if (name === "px_check_action") {
    const store = await getStore();
    const context = normalizePxAction(args);
    const decision = store.pxCheckAction(context);
    return textResult({ ok: true, context, decision });
  }

  if (name === "px_explain_violation") {
    const store = await getStore();
    const context = normalizePxAction(args);
    const decision = store.pxCheckAction(context);
    const constraints = summarizeConstraints(store.pxListConstraints());
    const message = decision.allowed
      ? "Action is allowed by the current Praxis policy set."
      : decision.error;
    const matchingHints = decision.allowed
      ? []
      : constraints.filter((c) => {
          const haystack = JSON.stringify(c).toLowerCase();
          const needle = String(decision.error).toLowerCase();
          const id = String(c.id ?? "").toLowerCase();
          return (id.length > 0 && needle.includes(id)) || haystack.includes(String(context.action_type).toLowerCase());
        });
    return textResult({
      ok: true,
      context,
      allowed: decision.allowed,
      message,
      decision,
      relevantConstraints: matchingHints.length > 0 ? matchingHints : constraints.slice(0, 8),
    });
  }

  return textResult({ error: `Unknown tool: ${name}` }, true);
}

function encodeMessage(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function send(message) {
  process.stdout.write(encodeMessage(message));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "plureslm-scout", version: "0.1.0" },
      });
      return;
    }
    if (method === "notifications/initialized") {
      prewarmStore();
      return;
    }
    if (method === "ping") {
      respond(id, {});
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools });
      return;
    }
    if (method === "tools/call") {
      respond(id, await callTool(params?.name, params?.arguments ?? {}));
      return;
    }
    if (id !== undefined) respondError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (id !== undefined) {
      respondError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
}

let buffer = Buffer.alloc(0);

function pump() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    try {
      void handle(JSON.parse(body));
    } catch {
      // Ignore malformed messages; MCP clients will time out rather than crash us.
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  pump();
});

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
