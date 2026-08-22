#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

function readFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
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

const explicitToken = (readArg("token") ?? process.env.PLURESLM_SERVICE_TOKEN)?.trim() || undefined;
const allowUnauthenticated =
  readFlag("no-auth") || process.env.PLURESLM_SERVICE_ALLOW_UNAUTHENTICATED === "1";
const { server, url, token } = await startPluresLmHttpService(config, {
  host: readArg("host") ?? process.env.PLURESLM_SERVICE_HOST ?? "127.0.0.1",
  port,
  token: explicitToken,
  allowUnauthenticated,
});

console.log(`plureslm-memory-service listening ${url}`);
if (token && !explicitToken) {
  const tokenFile =
    readArg("token-file") ??
    process.env.PLURESLM_SERVICE_TOKEN_FILE ??
    join(dbPath, ".plureslm-service-token");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  console.log(`plureslm-memory-service token-file ${tokenFile}`);
}

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
