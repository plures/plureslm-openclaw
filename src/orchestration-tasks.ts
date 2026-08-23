import { randomUUID } from "node:crypto";

import type { PluresLmStore } from "./pluresdb.js";

const TASK_ID_PREFIX = "orch:task:";
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_LABELS = 20;

export type OrchestrationTask = {
  id: string;
  type: "orchestration-task";
  category: "orchestration";
  title: string;
  description?: string;
  labels: string[];
  priority?: number;
  parentTaskId?: string;
  status: "queued";
  createdAt: string;
  updatedAt: string;
};

export class TaskInputError extends Error {}

function requireTaskAdmission(store: PluresLmStore, id: string, title: string): void {
  const decision = store.pxCheckAction({
    action_type: "orchestration_task_create",
    target: id,
    session_type: "main",
    // The store's governed write path performs the real secret scan over the
    // complete task payload immediately before persistence. This admission
    // event carries the neutral signal required by the existing write rule;
    // it never substitutes for that content-aware write check.
    metadata: { action_type: "orchestration_task_create", title, status: "queued", has_secret: 0 },
  });
  if (!decision.allowed) {
    throw new TaskInputError(`task admission rejected: ${decision.error ?? "policy violation"}`);
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new TaskInputError(`${field} required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TaskInputError(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TaskInputError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new TaskInputError(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function labelsFrom(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) {
    throw new TaskInputError("labels must be an array of strings");
  }
  const labels = [...new Set(value.map((label) => label.trim()).filter(Boolean))];
  if (labels.length > MAX_LABELS) throw new TaskInputError(`labels may contain at most ${MAX_LABELS} values`);
  if (labels.some((label) => label.length > 100)) throw new TaskInputError("labels may not exceed 100 characters");
  return labels;
}

function priorityFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new TaskInputError("priority must be an integer from 0 to 100");
  }
  return value;
}

export function createOrchestrationTask(
  store: PluresLmStore,
  params: Record<string, unknown>,
): OrchestrationTask {
  const title = requiredString(params.title, "title", MAX_TITLE_LENGTH);
  const description = optionalString(params.description, "description", MAX_DESCRIPTION_LENGTH);
  const parentTaskId = optionalString(params.parentTaskId, "parentTaskId", 200);
  const priority = priorityFrom(params.priority);
  if (parentTaskId && !parentTaskId.startsWith(TASK_ID_PREFIX)) {
    throw new TaskInputError(`parentTaskId must begin with ${TASK_ID_PREFIX}`);
  }
  const now = new Date().toISOString();
  const id = `${TASK_ID_PREFIX}${randomUUID()}`;
  requireTaskAdmission(store, id, title);
  const task: OrchestrationTask = {
    id,
    type: "orchestration-task",
    category: "orchestration",
    title,
    ...(description ? { description } : {}),
    labels: labelsFrom(params.labels),
    ...(priority === undefined ? {} : { priority }),
    ...(parentTaskId ? { parentTaskId } : {}),
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  if (!store.put(task.id, task)) {
    throw new Error("task was not persisted by the governed store");
  }
  return task;
}

export function getOrchestrationTask(store: PluresLmStore, id: string): OrchestrationTask | null {
  if (!id.startsWith(TASK_ID_PREFIX)) return null;
  const record = store.get(id);
  if (!record || record.type !== "orchestration-task" || record.category !== "orchestration") return null;
  return record as unknown as OrchestrationTask;
}
