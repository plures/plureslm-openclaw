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

  const allowedReady = store.pxCheckAction({
    action_type: "orchestration_task_transition",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_transition", from_status: "queued", to_status: "ready", evidence_count: 0 },
  });
  assert.equal(allowedReady.allowed, true, "PX policy must admit queued to ready");

  const deniedSkip = store.pxCheckAction({
    action_type: "orchestration_task_transition",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_transition", from_status: "queued", to_status: "in_progress", evidence_count: 0 },
  });
  assert.equal(deniedSkip.allowed, false, "PX policy must reject an invalid lifecycle jump");

  const deniedUnevidencedDone = store.pxCheckAction({
    action_type: "orchestration_task_transition",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_transition", from_status: "in_progress", to_status: "done", evidence_count: 0 },
  });
  assert.equal(deniedUnevidencedDone.allowed, false, "PX policy must reject completion without evidence");

  const allowedEvidencedDone = store.pxCheckAction({
    action_type: "orchestration_task_transition",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: { action_type: "orchestration_task_transition", from_status: "in_progress", to_status: "done", evidence_count: 1 },
  });
  assert.equal(allowedEvidencedDone.allowed, true, "PX policy must admit evidence-backed completion");

  const allowedDecisionPause = store.pxCheckAction({
    action_type: "orchestration_decision_request_create",
    target: "orch:task:policy-gate",
    session_type: "main",
    metadata: {
      action_type: "orchestration_decision_request_create",
      question: "Which route should the agent take?",
      from_status: "in_progress",
      to_status: "waiting_for_user",
    },
  });
  assert.equal(allowedDecisionPause.allowed, true, "PX policy must admit a decision pause from in-progress");

  const allowedDecisionRelease = store.pxCheckAction({
    action_type: "orchestration_decision_request_resolve",
    target: "orch:decision:policy-gate",
    session_type: "main",
    metadata: {
      action_type: "orchestration_decision_request_resolve",
      answer: "safe",
      from_status: "waiting_for_user",
      to_status: "ready",
    },
  });
  assert.equal(allowedDecisionRelease.allowed, true, "PX policy must release a resolved decision to ready");
} finally {
  PluresLmStore._resetForTests(dbPath);
  await rm(root, { recursive: true, force: true });
}

console.log("TASK_POLICY_GATE_OK");
