/**
 * MCP Px policy-engine gate.
 *
 * Proves Scout can use PluresLM as more than a .px compiler: MCP can insert a
 * structured Praxis constraint, list persisted constraints, check proposed
 * agent actions, and explain a policy denial through the native PluresDB engine.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dbPath = mkdtempSync(join(tmpdir(), "plureslm-mcp-px-"));
const server = join(repoRoot, "scout-mcp", "plureslm-mcp.ps1");

const child = spawn(
  "powershell",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    server,
    "-RepoRoot",
    repoRoot,
    "-DbPath",
    dbPath,
  ],
  { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
);

let stdout = Buffer.alloc(0);
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function send(message) {
  child.stdin.write(frame(message));
}

function frames() {
  const parsed = [];
  let buffer = stdout;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const start = headerEnd + 4;
    const end = start + Number(match[1]);
    if (buffer.length < end) break;
    parsed.push(JSON.parse(buffer.slice(start, end).toString("utf8")));
    buffer = buffer.slice(end);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(id) {
  for (let i = 0; i < 100; i += 1) {
    const found = frames().find((msg) => msg.id === id);
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`timeout waiting for response ${id}; stderr=${stderr}`);
}

function toolText(response) {
  return JSON.parse(response.result.content[0].text);
}

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-px-policy-gate", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await waitFor(1);

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listedTools = await waitFor(2);
  const toolNames = listedTools.result.tools.map((tool) => tool.name);
  for (const required of [
    "px_load_policy",
    "px_insert_constraint",
    "px_list_constraints",
    "px_check_action",
    "px_explain_violation",
  ]) {
    if (!toolNames.includes(required)) {
      throw new Error(`missing MCP tool ${required}`);
    }
  }

  const constraint = {
    id: "C-SCOUT-ACTION-APPROVED",
    description: "Agent actions must be explicitly approved before execution.",
    when: { op: "always" },
    require: { field: "approved", op: "field_eq", value: 1 },
    fix: "Set metadata.approved=1 after approval.",
    evidence: ["mcp-px-policy-gate"],
    severity: "error",
  };

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "px_insert_constraint", arguments: { constraint } },
  });
  const inserted = toolText(await waitFor(3));
  if (inserted.ok !== true) throw new Error("px_insert_constraint did not return ok:true");

  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "px_list_constraints", arguments: { includeRaw: false } },
  });
  const constraints = toolText(await waitFor(4));
  if (!constraints.constraints.some((c) => c.id === constraint.id)) {
    throw new Error("inserted constraint was not listed");
  }

  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "px_check_action",
      arguments: {
        actionType: "agent.execute",
        target: "deploy-plan",
        metadata: { approved: 0 },
      },
    },
  });
  const denied = toolText(await waitFor(5));
  if (denied.decision.allowed !== false) {
    throw new Error("unapproved action was not denied");
  }

  send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "px_check_action",
      arguments: {
        actionType: "agent.execute",
        target: "deploy-plan",
        metadata: { approved: 1 },
      },
    },
  });
  const allowed = toolText(await waitFor(6));
  if (allowed.decision.allowed !== true) {
    throw new Error("approved action was not allowed");
  }

  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "px_explain_violation",
      arguments: {
        actionType: "agent.execute",
        target: "deploy-plan",
        metadata: { approved: 0 },
      },
    },
  });
  const explained = toolText(await waitFor(7));
  if (explained.allowed !== false || !JSON.stringify(explained).includes(constraint.id)) {
    throw new Error("violation explanation did not include the relevant constraint");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools: 5,
        constraints: constraints.count,
        denied: denied.decision.allowed,
        allowed: allowed.decision.allowed,
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  child.kill();
  rmSync(dbPath, { recursive: true, force: true });
}
