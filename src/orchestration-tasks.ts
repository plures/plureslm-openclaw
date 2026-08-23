import { randomUUID } from "node:crypto";

import type { PluresLmStore } from "./pluresdb.js";

const TASK_ID_PREFIX = "orch:task:";
const EVENT_ID_PREFIX = "orch:event:";
const EVIDENCE_ID_PREFIX = "orch:evidence:";
const OBSERVATION_ID_PREFIX = "orch:observation:";
const DECISION_ID_PREFIX = "orch:decision:";
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_LABELS = 20;
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_DETAIL_LENGTH = 20_000;
const MAX_OPTIONS = 12;
const DEFAULT_EVENT_PAGE_LIMIT = 50;
const MAX_EVENT_PAGE_LIMIT = 100;

export type OrchestrationTaskStatus =
  | "queued"
  | "ready"
  | "in_progress"
  | "waiting_for_user"
  | "blocked"
  | "done"
  | "cancelled";

export type OrchestrationTask = {
  id: string;
  type: "orchestration-task";
  category: "orchestration";
  title: string;
  description?: string;
  labels: string[];
  priority?: number;
  parentTaskId?: string;
  status: OrchestrationTaskStatus;
  evidenceCount: number;
  decisionRequestId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type OrchestrationEvent = {
  id: string;
  type: "orchestration-event";
  category: "orchestration";
  taskId: string;
  eventType: "task_created" | "task_transitioned" | "evidence_added" | "observation_recorded" | "decision_requested" | "decision_resolved";
  actor: string;
  sequence: number;
  createdAt: string;
  details?: string;
  fromStatus?: OrchestrationTaskStatus;
  toStatus?: OrchestrationTaskStatus;
  evidenceId?: string;
  observationId?: string;
  decisionRequestId?: string;
};

export type OrchestrationEventPage = {
  events: OrchestrationEvent[];
  limit: number;
  nextCursor?: string;
};

export type OrchestrationEvidence = {
  id: string;
  type: "orchestration-evidence";
  category: "orchestration";
  taskId: string;
  kind: string;
  summary: string;
  source: string;
  details?: string;
  createdAt: string;
};

export type OrchestrationObservationKind = "finding" | "tool_result" | "failure" | "progress" | "plan";

export type OrchestrationObservation = {
  id: string;
  type: "orchestration-observation";
  category: "orchestration";
  taskId: string;
  kind: OrchestrationObservationKind;
  summary: string;
  source: string;
  details?: string;
  actor: string;
  createdAt: string;
};

export type OrchestrationDecisionRequest = {
  id: string;
  type: "orchestration-decision-request";
  category: "orchestration";
  taskId: string;
  question: string;
  options: string[];
  status: "open" | "resolved" | "cancelled";
  answer?: string;
  createdAt: string;
  resolvedAt?: string;
};

export class TaskInputError extends Error {}

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

function optionalActor(value: unknown): string {
  return optionalString(value, "actor", 200) ?? "scout";
}

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_EVENT_PAGE_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TaskInputError("limit must be a positive integer");
  }
  return Math.min(value, MAX_EVENT_PAGE_LIMIT);
}

function eventCursor(value: unknown): { sequence: number; createdAt?: string; id: string } | undefined {
  if (value === undefined) return undefined;
  const cursor = requiredString(value, "cursor", 250);
  const match = /^(\d+):(.+):(orch:event:.+)$/.exec(cursor);
  const legacyMatch = /^(\d+):(orch:event:.+)$/.exec(cursor);
  if (!match && !legacyMatch) throw new TaskInputError("cursor must be an event cursor");
  const rawSequence = match?.[1] ?? legacyMatch?.[1];
  const createdAt = match?.[2];
  const id = match?.[3] ?? legacyMatch?.[2];
  if (rawSequence === undefined || id === undefined) throw new TaskInputError("cursor must be an event cursor");
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) throw new TaskInputError("cursor sequence is invalid");
  return { sequence, ...(createdAt === undefined ? {} : { createdAt }), id };
}

function cursorForEvent(event: OrchestrationEvent): string {
  return `${event.sequence}:${event.createdAt}:${event.id}`;
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

function optionsFrom(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((option) => typeof option !== "string")) {
    throw new TaskInputError("options must be an array of strings");
  }
  const options = [...new Set(value.map((option) => option.trim()).filter(Boolean))];
  if (options.length > MAX_OPTIONS) throw new TaskInputError(`options may contain at most ${MAX_OPTIONS} values`);
  if (options.some((option) => option.length > 500)) throw new TaskInputError("options may not exceed 500 characters");
  return options;
}

function priorityFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new TaskInputError("priority must be an integer from 0 to 100");
  }
  return value;
}

function taskStatusFrom(value: unknown): OrchestrationTaskStatus {
  if (
    value === "queued" || value === "ready" || value === "in_progress" || value === "waiting_for_user"
    || value === "blocked" || value === "done" || value === "cancelled"
  ) return value;
  throw new TaskInputError("status must be queued, ready, in_progress, waiting_for_user, blocked, done, or cancelled");
}

function observationKindFrom(value: unknown): OrchestrationObservationKind {
  if (value === "finding" || value === "tool_result" || value === "failure" || value === "progress" || value === "plan") {
    return value;
  }
  throw new TaskInputError("kind must be finding, tool_result, failure, progress, or plan");
}

function taskFromRecord(record: Record<string, unknown> | null): OrchestrationTask | null {
  if (!record || record.type !== "orchestration-task" || record.category !== "orchestration") return null;
  try {
    const id = requiredString(record.id, "task id", 200);
    if (!id.startsWith(TASK_ID_PREFIX)) return null;
    const description = optionalString(record.description, "description", MAX_DESCRIPTION_LENGTH);
    const priority = priorityFrom(record.priority);
    const parentTaskId = optionalString(record.parentTaskId, "parentTaskId", 200);
    const decisionRequestId = optionalString(record.decisionRequestId, "decisionRequestId", 200);
    const evidenceCount = typeof record.evidenceCount === "number" && Number.isInteger(record.evidenceCount)
      ? record.evidenceCount
      : 0;
    const revision = typeof record.revision === "number" && Number.isInteger(record.revision) ? record.revision : 0;
    return {
      id,
      type: "orchestration-task",
      category: "orchestration",
      title: requiredString(record.title, "task title", MAX_TITLE_LENGTH),
      ...(description ? { description } : {}),
      labels: labelsFrom(record.labels),
      ...(priority === undefined ? {} : { priority }),
      ...(parentTaskId ? { parentTaskId } : {}),
      status: taskStatusFrom(record.status),
      evidenceCount,
      ...(decisionRequestId ? { decisionRequestId } : {}),
      revision,
      createdAt: requiredString(record.createdAt, "createdAt", 100),
      updatedAt: requiredString(record.updatedAt, "updatedAt", 100),
    };
  } catch {
    return null;
  }
}

function requireTask(store: PluresLmStore, id: string): OrchestrationTask {
  if (!id.startsWith(TASK_ID_PREFIX)) throw new TaskInputError(`taskId must begin with ${TASK_ID_PREFIX}`);
  const task = taskFromRecord(store.get(id));
  if (!task) throw new TaskInputError("task not found");
  return task;
}

function requireAdmission(
  store: PluresLmStore,
  actionType: string,
  target: string,
  metadata: Record<string, unknown>,
): void {
  const decision = store.pxCheckAction({
    action_type: actionType,
    target,
    session_type: "main",
    metadata: { action_type: actionType, has_secret: 0, ...metadata },
  });
  if (!decision.allowed) {
    throw new TaskInputError(`orchestration admission rejected: ${decision.error ?? "policy violation"}`);
  }
}

function persist(store: PluresLmStore, id: string, value: Record<string, unknown>, label: string): void {
  if (!store.put(id, value)) throw new Error(`${label} was not persisted by the governed store`);
}

function recordEvent(
  store: PluresLmStore,
  event: Omit<OrchestrationEvent, "id" | "type" | "category" | "createdAt">,
): OrchestrationEvent {
  const persisted: OrchestrationEvent = {
    id: `${EVENT_ID_PREFIX}${randomUUID()}`,
    type: "orchestration-event",
    category: "orchestration",
    createdAt: new Date().toISOString(),
    ...event,
  };
  persist(store, persisted.id, persisted, "orchestration event");
  return persisted;
}

function taskWith(
  task: OrchestrationTask,
  change: Partial<Pick<OrchestrationTask, "status" | "evidenceCount" | "decisionRequestId">>,
): OrchestrationTask {
  return {
    ...task,
    ...change,
    revision: task.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function createOrchestrationTask(store: PluresLmStore, params: Record<string, unknown>): OrchestrationTask {
  const title = requiredString(params.title, "title", MAX_TITLE_LENGTH);
  const description = optionalString(params.description, "description", MAX_DESCRIPTION_LENGTH);
  const parentTaskId = optionalString(params.parentTaskId, "parentTaskId", 200);
  const priority = priorityFrom(params.priority);
  const actor = optionalActor(params.actor);
  if (parentTaskId && !parentTaskId.startsWith(TASK_ID_PREFIX)) {
    throw new TaskInputError(`parentTaskId must begin with ${TASK_ID_PREFIX}`);
  }
  const now = new Date().toISOString();
  const id = `${TASK_ID_PREFIX}${randomUUID()}`;
  requireAdmission(store, "orchestration_task_create", id, { title, status: "queued" });
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
    evidenceCount: 0,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  persist(store, task.id, task, "orchestration task");
  recordEvent(store, { taskId: task.id, eventType: "task_created", actor, sequence: task.revision });
  return task;
}

export function getOrchestrationTask(store: PluresLmStore, id: string): OrchestrationTask | null {
  if (!id.startsWith(TASK_ID_PREFIX)) return null;
  return taskFromRecord(store.get(id));
}

export function transitionOrchestrationTask(
  store: PluresLmStore,
  id: string,
  params: Record<string, unknown>,
): OrchestrationTask {
  const task = requireTask(store, id);
  const status = taskStatusFrom(params.status);
  const actor = optionalActor(params.actor);
  const details = optionalString(params.details, "details", MAX_DETAIL_LENGTH);
  requireAdmission(store, "orchestration_task_transition", task.id, {
    from_status: task.status,
    to_status: status,
    evidence_count: task.evidenceCount,
  });
  const updated = taskWith(task, { status });
  persist(store, updated.id, updated, "orchestration task transition");
  recordEvent(store, {
    taskId: updated.id,
    eventType: "task_transitioned",
    actor,
    sequence: updated.revision,
    fromStatus: task.status,
    toStatus: status,
    ...(details ? { details } : {}),
  });
  return updated;
}

export function addOrchestrationEvidence(
  store: PluresLmStore,
  id: string,
  params: Record<string, unknown>,
): { task: OrchestrationTask; evidence: OrchestrationEvidence } {
  const task = requireTask(store, id);
  const kind = requiredString(params.kind, "kind", 100);
  const summary = requiredString(params.summary, "summary", MAX_SUMMARY_LENGTH);
  const source = optionalString(params.source, "source", 500) ?? "scout";
  const details = optionalString(params.details, "details", MAX_DETAIL_LENGTH);
  const actor = optionalActor(params.actor);
  requireAdmission(store, "orchestration_evidence_add", task.id, { kind, summary, task_status: task.status });
  const evidence: OrchestrationEvidence = {
    id: `${EVIDENCE_ID_PREFIX}${randomUUID()}`,
    type: "orchestration-evidence",
    category: "orchestration",
    taskId: task.id,
    kind,
    summary,
    source,
    ...(details ? { details } : {}),
    createdAt: new Date().toISOString(),
  };
  persist(store, evidence.id, evidence, "orchestration evidence");
  const updated = taskWith(task, { evidenceCount: task.evidenceCount + 1 });
  persist(store, updated.id, updated, "orchestration evidence count");
  recordEvent(store, {
    taskId: updated.id,
    eventType: "evidence_added",
    actor,
    sequence: updated.revision,
    evidenceId: evidence.id,
    details: summary,
  });
  return { task: updated, evidence };
}

function observationFromRecord(record: Record<string, unknown> | null): OrchestrationObservation | null {
  if (!record || record.type !== "orchestration-observation" || record.category !== "orchestration") return null;
  try {
    const id = requiredString(record.id, "observation id", 200);
    if (!id.startsWith(OBSERVATION_ID_PREFIX)) return null;
    const details = optionalString(record.details, "details", MAX_DETAIL_LENGTH);
    return {
      id,
      type: "orchestration-observation",
      category: "orchestration",
      taskId: requiredString(record.taskId, "taskId", 200),
      kind: observationKindFrom(record.kind),
      summary: requiredString(record.summary, "summary", MAX_SUMMARY_LENGTH),
      source: requiredString(record.source, "source", 500),
      ...(details ? { details } : {}),
      actor: requiredString(record.actor, "actor", 200),
      createdAt: requiredString(record.createdAt, "createdAt", 100),
    };
  } catch {
    return null;
  }
}

export function getOrchestrationObservation(store: PluresLmStore, id: string): OrchestrationObservation | null {
  if (!id.startsWith(OBSERVATION_ID_PREFIX)) return null;
  return observationFromRecord(store.get(id));
}

export function recordOrchestrationObservation(
  store: PluresLmStore,
  id: string,
  params: Record<string, unknown>,
): { task: OrchestrationTask; observation: OrchestrationObservation } {
  const task = requireTask(store, id);
  const kind = observationKindFrom(params.kind);
  const summary = requiredString(params.summary, "summary", MAX_SUMMARY_LENGTH);
  const source = optionalString(params.source, "source", 500) ?? "scout";
  const details = optionalString(params.details, "details", MAX_DETAIL_LENGTH);
  const actor = optionalActor(params.actor);
  requireAdmission(store, "orchestration_observation_record", task.id, {
    observation_kind: kind,
    summary,
    source,
    task_status: task.status,
  });
  const observation: OrchestrationObservation = {
    id: `${OBSERVATION_ID_PREFIX}${randomUUID()}`,
    type: "orchestration-observation",
    category: "orchestration",
    taskId: task.id,
    kind,
    summary,
    source,
    ...(details ? { details } : {}),
    actor,
    createdAt: new Date().toISOString(),
  };
  persist(store, observation.id, observation, "orchestration observation");
  recordEvent(store, {
    taskId: task.id,
    eventType: "observation_recorded",
    actor,
    sequence: task.revision,
    observationId: observation.id,
    details: summary,
  });
  return { task, observation };
}

export function createDecisionRequest(
  store: PluresLmStore,
  id: string,
  params: Record<string, unknown>,
): { task: OrchestrationTask; decision: OrchestrationDecisionRequest } {
  const task = requireTask(store, id);
  const question = requiredString(params.question, "question", MAX_SUMMARY_LENGTH);
  const options = optionsFrom(params.options);
  const actor = optionalActor(params.actor);
  requireAdmission(store, "orchestration_decision_request_create", task.id, {
    question,
    from_status: task.status,
    to_status: "waiting_for_user",
  });
  const decision: OrchestrationDecisionRequest = {
    id: `${DECISION_ID_PREFIX}${randomUUID()}`,
    type: "orchestration-decision-request",
    category: "orchestration",
    taskId: task.id,
    question,
    options,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  persist(store, decision.id, decision, "orchestration decision request");
  const updated = taskWith(task, { status: "waiting_for_user", decisionRequestId: decision.id });
  persist(store, updated.id, updated, "orchestration decision wait state");
  recordEvent(store, {
    taskId: updated.id,
    eventType: "decision_requested",
    actor,
    sequence: updated.revision,
    fromStatus: task.status,
    toStatus: updated.status,
    decisionRequestId: decision.id,
    details: question,
  });
  return { task: updated, decision };
}

function decisionFromRecord(record: Record<string, unknown> | null): OrchestrationDecisionRequest | null {
  if (!record || record.type !== "orchestration-decision-request" || record.category !== "orchestration") return null;
  try {
    const id = requiredString(record.id, "decision id", 200);
    if (!id.startsWith(DECISION_ID_PREFIX)) return null;
    const status = record.status;
    if (status !== "open" && status !== "resolved" && status !== "cancelled") return null;
    const answer = optionalString(record.answer, "answer", MAX_SUMMARY_LENGTH);
    const resolvedAt = optionalString(record.resolvedAt, "resolvedAt", 100);
    return {
      id,
      type: "orchestration-decision-request",
      category: "orchestration",
      taskId: requiredString(record.taskId, "taskId", 200),
      question: requiredString(record.question, "question", MAX_SUMMARY_LENGTH),
      options: optionsFrom(record.options),
      status,
      ...(answer ? { answer } : {}),
      createdAt: requiredString(record.createdAt, "createdAt", 100),
      ...(resolvedAt ? { resolvedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function getDecisionRequest(store: PluresLmStore, id: string): OrchestrationDecisionRequest | null {
  if (!id.startsWith(DECISION_ID_PREFIX)) return null;
  return decisionFromRecord(store.get(id));
}

export function resolveDecisionRequest(
  store: PluresLmStore,
  id: string,
  params: Record<string, unknown>,
): { task: OrchestrationTask; decision: OrchestrationDecisionRequest } {
  const decision = getDecisionRequest(store, id);
  if (!decision) throw new TaskInputError("decision request not found");
  if (decision.status !== "open") throw new TaskInputError("decision request is not open");
  const task = requireTask(store, decision.taskId);
  if (task.decisionRequestId !== decision.id) throw new TaskInputError("decision request is not active for this task");
  const answer = requiredString(params.answer, "answer", MAX_SUMMARY_LENGTH);
  const actor = optionalActor(params.actor);
  if (decision.options.length > 0 && !decision.options.includes(answer)) {
    throw new TaskInputError("answer must be one of the decision request options");
  }
  requireAdmission(store, "orchestration_decision_request_resolve", decision.id, {
    answer,
    from_status: task.status,
    to_status: "ready",
  });
  const resolved: OrchestrationDecisionRequest = {
    ...decision,
    status: "resolved",
    answer,
    resolvedAt: new Date().toISOString(),
  };
  persist(store, resolved.id, resolved, "orchestration decision resolution");
  const updated = taskWith(task, { status: "ready", decisionRequestId: undefined });
  persist(store, updated.id, updated, "orchestration decision release state");
  recordEvent(store, {
    taskId: updated.id,
    eventType: "decision_resolved",
    actor,
    sequence: updated.revision,
    fromStatus: task.status,
    toStatus: updated.status,
    decisionRequestId: resolved.id,
    details: answer,
  });
  return { task: updated, decision: resolved };
}

function eventFromRecord(record: Record<string, unknown>): OrchestrationEvent | null {
  if (record.type !== "orchestration-event" || record.category !== "orchestration") return null;
  const eventType = record.eventType;
  if (eventType !== "task_created" && eventType !== "task_transitioned" && eventType !== "evidence_added" && eventType !== "observation_recorded" && eventType !== "decision_requested" && eventType !== "decision_resolved") return null;
  try {
    const details = optionalString(record.details, "details", MAX_DETAIL_LENGTH);
    const evidenceId = optionalString(record.evidenceId, "evidenceId", 200);
    const observationId = optionalString(record.observationId, "observationId", 200);
    const decisionRequestId = optionalString(record.decisionRequestId, "decisionRequestId", 200);
    return {
      id: requiredString(record.id, "event id", 200),
      type: "orchestration-event",
      category: "orchestration",
      taskId: requiredString(record.taskId, "taskId", 200),
      eventType,
      actor: requiredString(record.actor, "actor", 200),
      sequence: typeof record.sequence === "number" ? record.sequence : 0,
      createdAt: requiredString(record.createdAt, "createdAt", 100),
      ...(details ? { details } : {}),
      ...(record.fromStatus ? { fromStatus: taskStatusFrom(record.fromStatus) } : {}),
      ...(record.toStatus ? { toStatus: taskStatusFrom(record.toStatus) } : {}),
      ...(evidenceId ? { evidenceId } : {}),
      ...(observationId ? { observationId } : {}),
      ...(decisionRequestId ? { decisionRequestId } : {}),
    };
  } catch {
    return null;
  }
}

export function listOrchestrationEvents(
  store: PluresLmStore,
  taskId: string,
  params: { limit?: number; cursor?: string } = {},
): OrchestrationEventPage {
  requireTask(store, taskId);
  const limit = pageLimit(params.limit);
  const cursor = eventCursor(params.cursor);
  const raw = store.execIr([{
    op: "filter",
    predicate: { field: "taskId", cmp: "==", value: taskId },
  }]) as { nodes?: Array<{ data?: unknown }> };
  const events = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .flatMap((node) => node.data && typeof node.data === "object" ? [eventFromRecord(node.data as Record<string, unknown>)] : [])
    .filter((event): event is OrchestrationEvent => event !== null);
  const sorted = events.sort((a, b) =>
    a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  const pagePlusOne = sorted
    .filter((event) =>
      !cursor
      || event.sequence > cursor.sequence
      || (event.sequence === cursor.sequence && (
        cursor.createdAt === undefined
          ? event.id > cursor.id
          : event.createdAt > cursor.createdAt
            || (event.createdAt === cursor.createdAt && event.id > cursor.id)
      ))
    )
    .slice(0, limit + 1);
  const page = pagePlusOne.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page,
    limit,
    ...(pagePlusOne.length > limit && last ? { nextCursor: cursorForEvent(last) } : {}),
  };
}
