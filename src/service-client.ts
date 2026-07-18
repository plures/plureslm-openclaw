type JsonBody = Record<string, unknown>;

type ServiceSearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
};

type ServiceReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

type ServiceStatus = {
  backend: "builtin";
  provider: "plureslm";
  model?: string;
  chunks?: number;
  files?: number;
  dbPath?: string;
  sources?: Array<"memory" | "sessions">;
  vector?: {
    enabled: boolean;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    dims?: number;
  };
};

export type PluresLmServiceClientConfig = {
  serviceUrl: string;
};

function normalizeServiceUrl(serviceUrl: string): string {
  const trimmed = serviceUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("serviceUrl required");
  return trimmed;
}

async function requestJson(
  baseUrl: string,
  path: string,
  body?: JsonBody,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`plureslm service returned non-json ${response.status}: ${text}`, { cause: error });
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as Record<string, unknown>).error)
      : text;
    throw new Error(`plureslm service HTTP ${response.status}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plureslm service response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function readBool(value: unknown): boolean {
  return value === true;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSearchResult(value: unknown): ServiceSearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const startLine = optionalNumber(record.startLine);
  const endLine = optionalNumber(record.endLine);
  const score = optionalNumber(record.score);
  const snippet = typeof record.snippet === "string" ? record.snippet : undefined;
  const source = record.source === "sessions" ? "sessions" : "memory";
  if (!path || startLine === undefined || endLine === undefined || score === undefined || snippet === undefined) {
    return null;
  }
  return {
    path,
    startLine,
    endLine,
    score,
    vectorScore: optionalNumber(record.vectorScore),
    textScore: optionalNumber(record.textScore),
    source,
    citation: typeof record.citation === "string" ? record.citation : undefined,
    snippet,
  };
}

function parseReadResult(value: Record<string, unknown>): ServiceReadResult {
  const text = typeof value.text === "string" ? value.text : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!path) throw new Error("plureslm service read response missing path");
  return {
    text,
    path,
    truncated: typeof value.truncated === "boolean" ? value.truncated : undefined,
    from: optionalNumber(value.from),
    lines: optionalNumber(value.lines),
    nextFrom: optionalNumber(value.nextFrom),
  };
}

function parseStatus(value: Record<string, unknown>): ServiceStatus {
  const vector = value.vector && typeof value.vector === "object" && !Array.isArray(value.vector)
    ? value.vector as Record<string, unknown>
    : undefined;
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((source): source is "memory" | "sessions" => source === "memory" || source === "sessions")
    : undefined;
  return {
    backend: "builtin",
    provider: "plureslm",
    model: typeof value.model === "string" ? value.model : undefined,
    chunks: optionalNumber(value.chunks),
    files: optionalNumber(value.files),
    dbPath: typeof value.dbPath === "string" ? value.dbPath : undefined,
    sources,
    vector: vector ? {
      enabled: typeof vector.enabled === "boolean" ? vector.enabled : false,
      storeAvailable: typeof vector.storeAvailable === "boolean" ? vector.storeAvailable : undefined,
      semanticAvailable: typeof vector.semanticAvailable === "boolean" ? vector.semanticAvailable : undefined,
      available: typeof vector.available === "boolean" ? vector.available : undefined,
      dims: optionalNumber(vector.dims),
    } : undefined,
  };
}

export function createPluresLmServiceSearchManager(config: PluresLmServiceClientConfig) {
  const baseUrl = normalizeServiceUrl(config.serviceUrl);
  let cachedStatus: ServiceStatus = { backend: "builtin", provider: "plureslm" };

  async function fetchStatus(): Promise<ServiceStatus> {
    cachedStatus = parseStatus(await requestJson(baseUrl, "/status"));
    return cachedStatus;
  }

  function status(): ServiceStatus {
    return cachedStatus;
  }

  async function search(
    query: string,
    opts?: { maxResults?: number },
  ): Promise<ServiceSearchResult[]> {
    const result = await requestJson(baseUrl, "/search", {
      query,
      maxResults: opts?.maxResults,
    });
    const results = Array.isArray(result.results) ? result.results : [];
    return results.map(parseSearchResult).filter((item): item is ServiceSearchResult => item !== null);
  }

  async function readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<ServiceReadResult> {
    const result = await requestJson(baseUrl, "/get", {
      path: params.relPath,
      from: params.from,
      lines: params.lines,
    });
    return parseReadResult(result);
  }

  async function sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void> {
    await requestJson(baseUrl, "/sync", {
      reason: params?.reason,
      force: params?.force,
      sessionFiles: params?.sessionFiles,
    });
    params?.progress?.({ completed: 1, total: 1, label: params?.reason ?? "service" });
  }

  async function probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    try {
      const value = await fetchStatus();
      const embedding = value && typeof value === "object"
        ? (value as Record<string, unknown>).embedding
        : undefined;
      if (embedding && typeof embedding === "object") {
        return { ok: readBool((embedding as Record<string, unknown>).available) };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function probeVectorAvailability(): Promise<boolean> {
    const value = await fetchStatus();
    const vector = value && typeof value === "object"
      ? (value as Record<string, unknown>).vector
      : undefined;
    if (vector && typeof vector === "object") {
      return readBool((vector as Record<string, unknown>).available);
    }
    return true;
  }

  return {
    manager: {
      search,
      readFile,
      status,
      probeEmbeddingAvailability,
      probeVectorAvailability,
      sync,
    },
  };
}
