#!/usr/bin/env node

import { startPluresLmHttpService, type PluresLmServiceConfig } from "./service.js";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readNumberArg(name: string): number | undefined {
  const raw = readArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const dbPath = readArg("dbPath") ?? process.env.PLURESLM_DB_PATH;
if (!dbPath) {
  console.error("plureslm-memory-service: --dbPath or PLURESLM_DB_PATH is required");
  process.exit(2);
}

const port = readNumberArg("port") ?? Number(process.env.PLURESLM_SERVICE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("plureslm-memory-service: --port must be an integer 0..65535");
  process.exit(2);
}

const config: PluresLmServiceConfig = {
  dbPath,
  embeddingModel: readArg("embeddingModel") ?? process.env.PLURESLM_EMBEDDING_MODEL,
  vectorThreshold: readNumberArg("vectorThreshold"),
  maxResults: readNumberArg("maxResults"),
  sourceDir: readArg("sourceDir") ?? process.env.PLURESLM_SOURCE_DIR,
  compressAboveTokens: readNumberArg("compressAboveTokens"),
  reactivePx: process.env.PLURESLM_REACTIVE_PX === "1" ? true : undefined,
  reactivePxPolicy: readArg("reactivePxPolicy") ?? process.env.PLURESLM_REACTIVE_PX_POLICY,
};

const { server, url } = await startPluresLmHttpService(config, {
  host: readArg("host") ?? process.env.PLURESLM_SERVICE_HOST ?? "127.0.0.1",
  port,
});

console.log(`plureslm-memory-service listening ${url}`);

function shutdown(signal: NodeJS.Signals): void {
  server.close((error) => {
    if (error) {
      console.error(`plureslm-memory-service failed to stop after ${signal}: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
