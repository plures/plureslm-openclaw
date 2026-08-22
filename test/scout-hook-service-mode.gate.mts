import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startPluresLmHttpService } from "../src/service.js";

function runHook(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`hook exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
    child.stdin.end(JSON.stringify({ prompt: "remember RELEASE_HOOK_SERVICE_MEMORY" }));
  });
}

const root = await mkdtemp(join(tmpdir(), "plureslm-scout-hook-service-gate-"));
const dbPath = join(root, "store");
const sourceDir = join(root, "memory");
const token = "scout-hook-service-mode-token";
await mkdir(sourceDir, { recursive: true });
await writeFile(join(sourceDir, "memory.md"), "RELEASE_HOOK_SERVICE_MEMORY\n", "utf8");

const { server, url } = await startPluresLmHttpService(
  { dbPath, sourceDir, embeddingModel: "BAAI/bge-small-en-v1.5", maxResults: 5 },
  { port: 0, token },
);

try {
  const sync = await fetch(`${url}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(sync.status, 200);
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = await runHook(join(repoRoot, "scout-hooks", "hooks", "plureslm-autorecall.mjs"), {
    ...process.env,
    PLURESLM_SCOUT_SERVICE_URL: url,
    PLURESLM_SCOUT_SERVICE_TOKEN: token,
    PLURESLM_DB_PATH: join(root, "must-not-open-directly"),
    PLURESLM_AUTORECALL_MODE: "always",
  });
  const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.match(parsed.hookSpecificOutput?.additionalContext ?? "", /RELEASE_HOOK_SERVICE_MEMORY/);
  assert.match(parsed.hookSpecificOutput?.additionalContext ?? "", new RegExp(`service:${url}`));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log("SCOUT_HOOK_SERVICE_MODE_GATE_OK");
