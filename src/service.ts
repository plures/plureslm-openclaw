import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createPluresLmSearchManager } from "./memory-capability.js";

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
};

function jsonResponse(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
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

function sourceMatchesCorpus(source: "memory" | "sessions" | undefined, corpus: unknown): boolean {
  if (corpus === undefined || corpus === "all") return true;
  if (corpus === "wiki") return false;
  if (corpus === "memory") return source !== "sessions";
  if (corpus === "sessions") return source === "sessions";
  return true;
}

export function createPluresLmMemoryService(config: PluresLmServiceConfig) {
  const shared = createPluresLmSearchManager({
    ...config,
    embeddingModel: config.embeddingModel ?? "BAAI/bge-small-en-v1.5",
  });

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
  };
}

export type PluresLmMemoryService = ReturnType<typeof createPluresLmMemoryService>;

export function createPluresLmHttpHandler(service: PluresLmMemoryService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, await service.health());
        return;
      }
      if (method === "GET" && url.pathname === "/status") {
        jsonResponse(res, 200, await service.status());
        return;
      }
      if (method !== "POST") {
        jsonResponse(res, 405, { ok: false, error: "method not allowed" });
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
      jsonResponse(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: errorMessage(error) });
    }
  };
}

export async function startPluresLmHttpService(
  config: PluresLmServiceConfig,
  options: PluresLmHttpServiceOptions,
): Promise<{ server: Server; url: string }> {
  const service = createPluresLmMemoryService(config);
  const host = options.host ?? "127.0.0.1";
  const server = createServer(createPluresLmHttpHandler(service));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, url: `http://${host}:${port}` };
}

export function assertJson(value: unknown): Json {
  return value as Json;
}
