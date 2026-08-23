import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PluresLmStore } from "../src/pluresdb.js";

const root = await mkdtemp(join(tmpdir(), "plureslm-task-policy-gate-"));
const dbPath = join(root, "store");
const policyPath = fileURLToPath(
  new URL("../procedures/orchestration-task-lifecycle.px", import.meta.url),
);

try {
  const store = PluresLmStore.open({ dbPath, embeddingModel: "BAAI/bge-small-en-v1.5" });
  store.pxLoadPolicy(await readFile(policyPath, "utf8"));

  const allowed = store.pxCheckAction({
    action_type: "orchestration_task_create",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_create", title: "Create a durable task", status: "queued" },
  });
  assert.equal(allowed.allowed, true, "PX policy must admit a queued task with a title");

  const deniedStatus = store.pxCheckAction({
    action_type: "orchestration_task_create",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_create", title: "Create a durable task", status: "blocked" },
  });
  assert.equal(deniedStatus.allowed, false, "PX policy must reject a non-queued initial state");

  const deniedTitle = store.pxCheckAction({
    action_type: "orchestration_task_create",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_create", title: "", status: "queued" },
  });
  assert.equal(deniedTitle.allowed, false, "PX policy must reject an empty task title");
} finally {
  PluresLmStore._resetForTests(dbPath);
  await rm(root, { recursive: true, force: true });
}

console.log("TASK_POLICY_GATE_OK");
