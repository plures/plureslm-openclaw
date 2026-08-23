import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";

import { createPluresLmSearchManager } from "./memory-capability.js";
import {
  addOrchestrationEvidence,
  createDecisionRequest,
  createOrchestrationTask,
  getDecisionRequest,
  getOrchestrationTask,
  listOrchestrationEvents,
  resolveDecisionRequest,
  TaskInputError,
  transitionOrchestrationTask,
} from "./orchestration-tasks.js";
import { PluresLmStore } from "./pluresdb.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type PluresLmServiceConfig = {
  dbPath: string;
  embeddingModel?: string;
  vectorThreshold?: number;
  maxResults?: number;
  sourceDir?: string;
  compressAboveTokens?: number;
  reactivePx?: boolean;
  reactivePxPolicy?: string;
};

export type PluresLmHttpServiceOptions = {
  host?: string;
  port: number;
  /** Shared secret required for every endpoint other than liveness. */
  token?: string;
  /** Explicit, temporary compatibility escape hatch. Never the default. */
  allowUnauthenticated?: boolean;
};

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasValidBearerToken(req: IncomingMessage, expected: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const suppliedToken = match[1];
  if (!suppliedToken) return false;
  const supplied = Buffer.from(suppliedToken, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

function resolveServiceToken(
  options: Pick<PluresLmHttpServiceOptions, "token" | "allowUnauthenticated">,
): string | undefined {
  if (options.allowUnauthenticated === true) return undefined;
  const configured = options.token?.trim();
  return configured && configured.length > 0
    ? configured
    : randomBytes(32).toString("base64url");
}

function sourceMatchesCorpus(source: "memory" | "sessions" | undefined, corpus: unknown): boolean {
  if (corpus === undefined || corpus === "all") return true;
  if (corpus === "wiki") return false;
  if (corpus === "memory") return source !== "sessions";
  if (corpus === "sessions") return source === "sessions";
  return true;
}

export function createPluresLmMemoryService(config: PluresLmServiceConfig) {
  const storeOptions = {
    ...config,
    embeddingModel: config.embeddingModel ?? "BAAI/bge-small-en-v1.5",
  };
  const store = PluresLmStore.open(storeOptions);
  const shared = createPluresLmSearchManager(storeOptions, store);
  const taskPolicyPath = fileURLToPath(
    new URL("../procedures/orchestration-task-lifecycle.px", import.meta.url),
  );
  let taskPolicy: string;
  try {
    taskPolicy = readFileSync(taskPolicyPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to load orchestration task lifecycle policy at ${taskPolicyPath}. Ensure the package includes procedures/orchestration-task-lifecycle.px.`,
      { cause: error },
    );
  }
  store.pxLoadPolicy(taskPolicy);

  return {
    async health(): Promise<{ ok: true; provider: "plureslm" }> {
      return { ok: true, provider: "plureslm" };
    },

    async status(): Promise<unknown> {
      return shared.manager.status();
    },

    async search(params: Record<string, unknown>): Promise<unknown> {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("query required");
      const maxResults = optionalPositiveInt(params.maxResults) ?? config.maxResults;
      const minScore = typeof params.minScore === "number" && Number.isFinite(params.minScore)
        ? params.minScore
        : undefined;
      const rawResults = await shared.manager.search(query, { maxResults });
      const results = rawResults
        .filter((result) => minScore === undefined || result.score >= minScore)
        .filter((result) => sourceMatchesCorpus(result.source, params.corpus))
        .map((result) => ({
          path: result.path,
          startLine: result.startLine,
          endLine: result.endLine,
          score: result.score,
          vectorScore: result.vectorScore,
          textScore: result.textScore,
          source: result.source,
          citation: result.citation,
          snippet: result.snippet,
        }));
      return { provider: "plureslm", query, count: results.length, results };
    },

    async get(params: Record<string, unknown>): Promise<unknown> {
      const relPath = typeof params.path === "string" ? params.path.trim() : "";
      if (!relPath) throw new Error("path required");
      if (params.corpus === "wiki") {
        throw new Error("wiki corpus is not provided by plureslm");
      }
      const from = optionalPositiveInt(params.from);
      const lines = optionalPositiveInt(params.lines);
      const result = await shared.manager.readFile({ relPath, from, lines });
      return { provider: "plureslm", ...result };
    },

    async sync(params: Record<string, unknown> = {}): Promise<unknown> {
      const reason = typeof params.reason === "string" ? params.reason : "service";
      const force = optionalBool(params.force) ?? false;
      const sessionFiles = optionalStringArray(params.sessionFiles);
      await shared.manager.sync({ reason, force, sessionFiles });
      return { ok: true, provider: "plureslm", synced: true };
    },

    async createTask(params: Record<string, unknown>): Promise<unknown> {
      return { ok: true, provider: "plureslm", task: createOrchestrationTask(store, params) };
    },

    async getTask(id: string): Promise<unknown> {
      return { ok: true, provider: "plureslm", task: getOrchestrationTask(store, id) };
    },

    async transitionTask(id: string, params: Record<string, unknown>): Promise<unknown> {
      return { ok: true, provider: "plureslm", task: transitionOrchestrationTask(store, id, params) };
    },

    async getTaskEvents(id: string): Promise<unknown> {
      return { ok: true, provider: "plureslm", events: listOrchestrationEvents(store, id) };
    },

    async addTaskEvidence(id: string, params: Record<string, unknown>): Promise<unknown> {
      return { ok: true, provider: "plureslm", ...addOrchestrationEvidence(store, id, params) };
    },

    async createDecisionRequest(id: string, params: Record<string, unknown>): Promise<unknown> {
      return { ok: true, provider: "plureslm", ...createDecisionRequest(store, id, params) };
    },

    async getDecisionRequest(id: string): Promise<unknown> {
      return { ok: true, provider: "plureslm", decision: getDecisionRequest(store, id) };
    },

    async resolveDecisionRequest(id: string, params: Record<string, unknown>): Promise<unknown> {
      return { ok: true, provider: "plureslm", ...resolveDecisionRequest(store, id, params) };
    },
  };
}

export type PluresLmMemoryService = ReturnType<typeof createPluresLmMemoryService>;

export function createPluresLmHttpHandler(
  service: PluresLmMemoryService,
  options: Pick<PluresLmHttpServiceOptions, "token" | "allowUnauthenticated">,
) {
  const token = resolveServiceToken(options);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, await service.health());
        return;
      }
      if (token && !hasValidBearerToken(req, token)) {
        jsonResponse(res, 401, { ok: false, provider: "plureslm", error: "unauthorized" });
        return;
      }
      if (method === "GET" && url.pathname === "/status") {
        jsonResponse(res, 200, await service.status());
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/decision-requests/")) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice("/decision-requests/".length));
        } catch {
          jsonResponse(res, 400, { ok: false, provider: "plureslm", error: "invalid decision request id" });
          return;
        }
        const result = await service.getDecisionRequest(id);
        if (!(result as { decision?: unknown }).decision) {
          jsonResponse(res, 404, { ok: false, provider: "plureslm", error: "decision request not found" });
          return;
        }
        jsonResponse(res, 200, result);
        return;
      }
      const taskEventsGet = /^\/tasks\/([^/]+)\/events$/.exec(url.pathname);
      if (method === "GET" && taskEventsGet) {
        let id: string;
        try {
          id = decodeURIComponent(taskEventsGet[1] ?? "");
        } catch {
          jsonResponse(res, 400, { ok: false, provider: "plureslm", error: "invalid task id" });
          return;
        }
        jsonResponse(res, 200, await service.getTaskEvents(id));
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/tasks/")) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice("/tasks/".length));
        } catch {
          jsonResponse(res, 400, { ok: false, provider: "plureslm", error: "invalid task id" });
          return;
        }
        const result = await service.getTask(id);
        if (!(result as { task?: unknown }).task) {
          jsonResponse(res, 404, { ok: false, provider: "plureslm", error: "task not found" });
          return;
        }
        jsonResponse(res, 200, result);
        return;
      }
      if (method !== "POST") {
        jsonResponse(res, 405, { ok: false, provider: "plureslm", error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      if (url.pathname === "/search") {
        jsonResponse(res, 200, await service.search(body));
        return;
      }
      if (url.pathname === "/get") {
        jsonResponse(res, 200, await service.get(body));
        return;
      }
      if (url.pathname === "/sync") {
        jsonResponse(res, 200, await service.sync(body));
        return;
      }
      if (url.pathname === "/tasks") {
        const created = await service.createTask(body);
        const id = (created as { task?: { id?: unknown } }).task?.id;
        jsonResponse(
          res,
          201,
          created,
          typeof id === "string" ? { location: `/tasks/${encodeURIComponent(id)}` } : undefined,
        );
        return;
      }
      const transition = /^\/tasks\/([^/]+)\/transition$/.exec(url.pathname);
      if (transition) {
        jsonResponse(res, 200, await service.transitionTask(decodeURIComponent(transition[1] ?? ""), body));
        return;
      }
      const evidence = /^\/tasks\/([^/]+)\/evidence$/.exec(url.pathname);
      if (evidence) {
        jsonResponse(res, 201, await service.addTaskEvidence(decodeURIComponent(evidence[1] ?? ""), body));
        return;
      }
      const decision = /^\/tasks\/([^/]+)\/decision-requests$/.exec(url.pathname);
      if (decision) {
        jsonResponse(res, 201, await service.createDecisionRequest(decodeURIComponent(decision[1] ?? ""), body));
        return;
      }
      const resolveDecision = /^\/decision-requests\/([^/]+)\/resolve$/.exec(url.pathname);
      if (resolveDecision) {
        jsonResponse(res, 200, await service.resolveDecisionRequest(decodeURIComponent(resolveDecision[1] ?? ""), body));
        return;
      }
      jsonResponse(res, 404, { ok: false, provider: "plureslm", error: "not found" });
    } catch (error) {
      jsonResponse(res, error instanceof TaskInputError ? 400 : 500, {
        ok: false,
        provider: "plureslm",
        error: errorMessage(error),
      });
    }
  };
}

export async function startPluresLmHttpService(
  config: PluresLmServiceConfig,
  options: PluresLmHttpServiceOptions,
): Promise<{ server: Server; url: string; token?: string }> {
  const service = createPluresLmMemoryService(config);
  const host = options.host ?? "127.0.0.1";
  const token = resolveServiceToken(options);
  const server = createServer(createPluresLmHttpHandler(service, {
    token,
    allowUnauthenticated: options.allowUnauthenticated,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, url: `http://${host}:${port}`, token };
}

export function assertJson(value: unknown): Json {
  return value as Json;
}
