import { createHash } from "node:crypto";

const CAPSULE_VERSION = "TaskCapsuleV1";
const AUTHORIZATION_MARKER = "Task Authorization Envelope V1";
const AUTHORIZATION_GATE_KINDS = new Set([
  "inspect",
  "edit",
  "test",
  "commit",
  "push",
  "pr",
  "merge",
  "deploy",
  "secret",
  "live_call",
  "dependency_install",
  "destructive",
  "financial",
  "shared_runtime",
]);
const AUTHORIZATION_GATE_STATES = new Set(["authorized", "approval_required", "denied", "forbidden"]);
const AUTHORIZATION_ACTION_STATES = new Set(["pending", "completed"]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasDuplicateJsonKeys(source) {
  let index = 0;
  let duplicate = false;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const string = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      } else index += 1;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = () => {
    whitespace();
    if (source[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') throw new Error("Expected JSON object key");
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        if (source[index] !== ":") throw new Error("Expected JSON colon");
        index += 1;
        value();
        whitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") throw new Error("Expected JSON comma");
        index += 1;
      }
      throw new Error("Unterminated JSON object");
    }
    if (source[index] === "[") {
      index += 1;
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        value();
        whitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") throw new Error("Expected JSON array comma");
        index += 1;
      }
      throw new Error("Unterminated JSON array");
    }
    if (source[index] === '"') {
      string();
      return;
    }
    const start = index;
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
    if (index === start) throw new Error("Expected JSON value");
  };
  try {
    value();
    whitespace();
    return duplicate || index !== source.length;
  } catch {
    return true;
  }
}

function authorizationFor(task, comments) {
  const markerLinePattern = /(?:^|\n)Task Authorization Envelope V1[ \t]*(?:\n|$)/g;
  const envelopePattern = /(?:^|\n)Task Authorization Envelope V1\s*```json\s*([\s\S]*?)\s*```/g;
  const sources = comments.flatMap((comment) => (
    [...comment.body.matchAll(markerLinePattern)].map(() => comment)
  ));
  if (sources.length === 0) return { state: "absent", envelope: null, source: null };
  if (new Set(sources.map((comment) => comment.id)).size !== sources.length) {
    return { state: "invalid", envelope: null, source: null };
  }

  const source = sources.at(-1);
  const matches = [...source.body.matchAll(envelopePattern)];
  if (matches.length !== 1 || hasDuplicateJsonKeys(matches[0][1])) {
    return { state: "invalid", envelope: null, source: null };
  }
  const match = matches[0];

  let envelope;
  try {
    envelope = JSON.parse(match[1]);
  } catch {
    return { state: "invalid", envelope: null, source: null };
  }
  if (!envelope || !Array.isArray(envelope.gates) || !Array.isArray(envelope.actions)) {
    return { state: "invalid", envelope: null, source: null };
  }
  const priorSourceIds = sources.slice(0, -1).map((comment) => comment.id);
  const supersedesCommentIds = envelope.supersedesCommentIds;
  if (priorSourceIds.length === 0) {
    if (supersedesCommentIds !== undefined
      && (!Array.isArray(supersedesCommentIds) || supersedesCommentIds.length !== 0)) {
      return { state: "invalid", envelope: null, source: null };
    }
  } else if (
    !Array.isArray(supersedesCommentIds)
    || supersedesCommentIds.length !== priorSourceIds.length
    || new Set(supersedesCommentIds).size !== supersedesCommentIds.length
    || supersedesCommentIds.some((id) => !nonEmptyString(id))
    || priorSourceIds.some((id) => !supersedesCommentIds.includes(id))
  ) {
    return { state: "invalid", envelope: null, source: null };
  }

  const gateIds = new Set();
  for (const gate of envelope.gates) {
    if (!gate || !nonEmptyString(gate.id) || gateIds.has(gate.id)
      || !AUTHORIZATION_GATE_KINDS.has(gate.kind)
      || !AUTHORIZATION_GATE_STATES.has(gate.state)
      || !nonEmptyString(gate.scope)) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.state === "approval_required"
      && (!nonEmptyString(gate.approver) || !nonEmptyString(gate.approvalRequest))) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (["authorized", "denied", "forbidden"].includes(gate.state)
      && (
        !nonEmptyString(gate.approver)
        || !nonEmptyString(gate.approvalRequest)
        || !nonEmptyString(gate.evidence)
        || !nonEmptyString(gate.receipt)
      )) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.expiresAt !== undefined
      && (!nonEmptyString(gate.expiresAt) || Number.isNaN(new Date(gate.expiresAt).getTime()))) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.state === "authorized"
      && gate.expiresAt !== undefined
      && typeof gate.renewable !== "boolean") {
      return { state: "invalid", envelope: null, source: null };
    }
    gateIds.add(gate.id);
  }

  const actionIds = new Set();
  for (const action of envelope.actions) {
    if (!action || !nonEmptyString(action.id) || actionIds.has(action.id)
      || !Number.isInteger(action.order)
      || !nonEmptyString(action.text)
      || !nonEmptyString(action.target)
      || !AUTHORIZATION_ACTION_STATES.has(action.status)
      || !nonEmptyString(action.gate)
      || !gateIds.has(action.gate)) {
      return { state: "invalid", envelope: null, source: null };
    }
    actionIds.add(action.id);
  }

  const recordsDecision = priorSourceIds.length > 0 || envelope.gates.some((gate) => (
    gate.state === "authorized" || gate.state === "denied" || gate.state === "forbidden"
  ));
  if (recordsDecision && (
    source.authorType !== "user"
    || !nonEmptyString(source.authorId)
    || !task.threadBinding?.threadId
    || source.threadId !== task.threadBinding.threadId
  )) {
    return { state: "invalid", envelope: null, source: null };
  }

  return {
    state: "valid",
    envelope,
    source: { commentId: source.id, commentVersion: source.version },
  };
}

function allAttachments(comments, attachments) {
  return [
    ...attachments,
    ...comments.flatMap((comment) => comment.attachments),
  ].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));
}

function inboxFor(receipts) {
  const ordered = [...receipts].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  ));
  return {
    pendingCount: ordered.filter((receipt) => receipt.status === "queued").length,
    latestReceipt: ordered[0] ?? null,
  };
}

function handoffsFor(events) {
  const ordered = [...events].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
      || right.eventId.localeCompare(left.eventId)
  ));
  return {
    pendingAcknowledgementCount: ordered.filter((event) => (
      event.envelope.requiresAck === true && event.acknowledgements.length === 0
    )).length,
    latestEvent: ordered[0] ?? null,
  };
}

function conversationFor(task) {
  const scope = task.labels?.includes("project-inbox")
    ? { type: "project", projectId: task.projectId }
    : {
        type: "work_item",
        projectId: task.projectId,
        taskId: task.id,
        identifier: task.identifier,
      };
  const windows = new Map();
  for (const reference of task.conversationRefs ?? []) {
    if (!nonEmptyString(reference.threadId)) continue;
    const confirmed = !reference.legacyLocal
      && [
        reference.codexProjectId,
        reference.codexProjectKind,
        reference.codexHostId,
        reference.workspacePath,
      ].every(nonEmptyString);
    const candidate = {
      threadId: reference.threadId,
      bindingState: reference.legacyLocal
        ? "legacy_local"
        : confirmed ? "confirmed" : "incomplete",
      codexProjectId: reference.codexProjectId ?? null,
      codexProjectKind: reference.codexProjectKind ?? null,
      codexHostId: reference.codexHostId ?? null,
      workspacePath: reference.workspacePath ?? null,
      latestSource: { type: reference.source, id: reference.sourceId },
      updatedAt: reference.updatedAt,
    };
    const current = windows.get(reference.threadId);
    const bindingRank = { legacy_local: 0, incomplete: 1, confirmed: 2 };
    if (current
      && (bindingRank[current.bindingState] > bindingRank[candidate.bindingState]
        || (bindingRank[current.bindingState] === bindingRank[candidate.bindingState]
          && current.updatedAt > candidate.updatedAt))) continue;
    windows.set(reference.threadId, candidate);
  }
  return {
    scope,
    talkingWindows: [...windows.values()].sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId)
    )),
  };
}

function hasFullThreadBinding(task) {
  return task.threadBinding !== null;
}

function executionFor(task) {
  if (hasFullThreadBinding(task)) {
    return {
      rootRoute: { state: "ready", source: "task" },
      threadBinding: task.threadBinding,
      legacyLocalThreadId: null,
    };
  }
  return {
    rootRoute: {
      state: "not_ready",
      source: "task",
      reasonCodes: [task.legacyLocalThreadId ? "LEGACY_THREAD_BINDING_ONLY" : "ROOT_THREAD_BINDING_MISSING"],
    },
    threadBinding: null,
    legacyLocalThreadId: task.legacyLocalThreadId,
  };
}

function relationEvidence(task) {
  const relation = (item) => ({
    id: item.id,
    identifier: item.identifier,
    version: item.version,
    externalKey: item.externalKey,
    projectId: item.projectId,
    title: item.title,
    status: item.status,
    priority: item.priority,
    labels: item.labels ?? [],
    startDate: item.startDate ?? null,
    dueDate: item.dueDate ?? null,
    assignee: {
      type: item.assignee.type,
      id: item.assignee.id,
      name: item.assignee.name,
      avatarUrl: item.assignee.avatarUrl,
    },
    archivedAt: item.archivedAt,
  });
  const sort = (left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1
      : left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
  );
  const relations = (items) => items.map(relation).sort(sort);
  return {
    parent: task.relations.parent ? relation(task.relations.parent) : null,
    subIssues: relations(task.relations.subIssues),
    blockedBy: relations(task.relations.blockedBy),
    blocks: relations(task.relations.blocks),
    related: relations(task.relations.related),
  };
}

function planningFor(task) {
  const labels = task.labels ?? [];
  const role = labels.includes("feature")
    ? "feature"
    : labels.includes("workstream") ? "workstream" : null;
  if (!role) return null;

  const parent = task.relations.parent;
  const children = task.relations.subIssues ?? [];
  const childWorkstreams = children.filter((child) => (
    (child.labels ?? []).includes("workstream")
  ));
  const completed = children.filter((child) => child.status === "done").length;
  const active = children.filter((child) => (
    child.status === "in_progress" || child.status === "in_review"
  )).length;
  const blocked = children.filter((child) => child.status === "blocked").length;
  const totalChildren = children.length;
  const state = totalChildren === 0
    ? "empty"
    : completed === totalChildren ? "complete"
      : blocked > 0 ? "blocked"
        : active > 0 ? "active" : "planned";

  return {
    role,
    milestone: {
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
    },
    parentFeature: parent && (parent.labels ?? []).includes("feature")
      ? parent.identifier
      : null,
    childWorkstreams: childWorkstreams.map((child) => child.identifier).sort(),
    rollup: role === "feature" ? {
      totalChildren,
      workstreams: childWorkstreams.length,
      unclassifiedChildren: totalChildren - childWorkstreams.length,
      completed,
      active,
      blocked,
      remaining: totalChildren - completed,
      state,
    } : null,
  };
}

function claimEvidence(claim) {
  if (!claim) return null;
  return {
    taskId: claim.taskId,
    projectId: claim.projectId,
    agentPath: claim.agentPath,
    agentThreadId: claim.agentThreadId,
    status: claim.status,
    claimedAt: claim.claimedAt,
    leaseExpiresAt: claim.leaseExpiresAt,
    writeScope: [...claim.writeScope].sort(),
    completedAt: claim.completedAt,
  };
}

function claimState(claim, timestamp) {
  if (claim?.status !== "active") return null;
  const expiresAt = claim.leaseExpiresAt ? new Date(claim.leaseExpiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= timestamp) {
    return "expired_unresolved";
  }
  return "active";
}

function activeRunFor(task, claim, timestamp) {
  if (!claim) return null;
  return {
    id: `${task.id}:${claim.claimedAt}`,
    state: claimState(claim, timestamp) ?? claim.status,
    taskId: claim.taskId,
    projectId: claim.projectId,
    agentPath: claim.agentPath,
    agentThreadId: claim.agentThreadId,
    claimedAt: claim.claimedAt,
    leaseExpiresAt: claim.leaseExpiresAt,
    writeScope: claim.writeScope,
    completedAt: claim.completedAt,
  };
}

function durableRunFor(run) {
  if (!run) return null;
  return {
    id: run.id,
    state: run.status,
    taskId: run.taskId,
    projectId: run.projectId,
    role: run.role,
    status: run.status,
    version: run.version,
    rootThreadId: run.rootThreadId,
    agentPath: run.agentPath,
    agentThreadId: run.agentThreadId,
    worktree: run.worktree,
    writeScope: [...run.writeScope].sort(),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    nextAction: run.nextAction,
  };
}

function isCheckpointOrHandoff(comment) {
  return /^(?:#{1,6}\s*)?Agent (?:Checkpoint|Handoff)\b/im.test(comment.body);
}

function isSuperseded(comment) {
  return /^(?:#{1,6}\s*)?(?:Status|Checkpoint status)\s*:\s*superseded\b/im.test(comment.body)
    || /^(?:#{1,6}\s*)?Superseded\s*:\s*(?:true|yes)\b/im.test(comment.body);
}

function workflowFor(task) {
  const profile = task.workflowProfile === "vibe" ? "vibe" : "formal";
  return { profile, workingLogRequired: profile === "formal" };
}

function frontierFor(task, comments, coordinationEvents, activeRun, latestRun, authorization, pendingActions) {
  const candidates = [];
  const add = (candidate) => {
    if (!candidate.text || !candidate.observedAt || Number.isNaN(Date.parse(candidate.observedAt))) return;
    candidates.push(candidate);
  };
  const seenRunIds = new Set();
  for (const run of [activeRun, latestRun]) {
    if (!run?.id || seenRunIds.has(run.id) || !run.nextAction) continue;
    seenRunIds.add(run.id);
    add({
      text: run.nextAction,
      source: { type: "agent_run", runId: run.id, runVersion: run.version },
      observedAt: run.updatedAt,
      tieRank: ["active", "blocked"].includes(run.status) ? 30 : 20,
    });
  }
  const handoffCommentIds = new Set(coordinationEvents.map((event) => event.commentId).filter(Boolean));
  for (const comment of comments) {
    if (handoffCommentIds.has(comment.id) || !isCheckpointOrHandoff(comment) || isSuperseded(comment)) continue;
    const match = comment.body.match(/^(?:Next executable action|Next action)\s*:\s*(.+)$/im);
    if (!match) continue;
    add({
      text: match[1].trim(),
      source: { type: "checkpoint", commentId: comment.id, commentVersion: comment.version },
      observedAt: comment.updatedAt,
      tieRank: 40,
    });
  }
  for (const event of coordinationEvents) {
    add({
      text: event.envelope?.nextAction,
      source: { type: "structured_handoff", eventId: event.eventId },
      observedAt: event.createdAt,
      tieRank: 50,
    });
  }
  const authorizationComment = authorization.source
    ? comments.find((comment) => comment.id === authorization.source.commentId)
    : null;
  const authorizationAction = pendingActions[0];
  if (authorizationAction && authorizationComment) {
    add({
      text: authorizationAction.text,
      source: { type: "authorization_action", actionId: authorizationAction.id },
      observedAt: authorizationComment.updatedAt,
      tieRank: 60,
    });
  }
  if (candidates.length === 0) {
    return {
      text: task.title,
      source: { type: "task_title_fallback", explicit: true },
      observedAt: task.updatedAt ?? null,
    };
  }
  candidates.sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
      || right.tieRank - left.tieRank
      || JSON.stringify(left.source).localeCompare(JSON.stringify(right.source))
  ));
  const { tieRank: _tieRank, ...frontier } = candidates[0];
  return frontier;
}

const STRUCTURAL_NEXT_ACTIONS = new Map([
  [
    "PROJECT_INBOX_NON_DISPATCHABLE",
    "项目 Inbox 仅用于接收和协调，不可派发执行；请选择一个明确的 Feature 或 Task 继续。",
  ],
  [
    "LEGACY_THREAD_BINDING_ONLY",
    "将 legacy Root thread 迁移为带 host、project 和 workspace 的确认绑定，然后重新生成 Capsule。",
  ],
  [
    "AUTHORIZATION_ENVELOPE_INVALID",
    "修复无效的 Task Authorization Envelope V1；在验证通过前不要派发工作或请求 Owner 授权。",
  ],
]);

function structuralNextActionFor(reasonCode) {
  const text = STRUCTURAL_NEXT_ACTIONS.get(reasonCode);
  if (!text) return null;
  return {
    text,
    source: { type: "structural_blocker", reasonCode },
  };
}

function readyWorkFor(
  task,
  claim,
  timestamp,
  execution,
  comments,
  coordinationEvents,
  activeRun,
  latestRun,
  authorization,
  requirementsRevision,
) {
  const reasonCodes = [];
  const workflow = workflowFor(task);
  if (task.labels.includes("project-inbox")) {
    reasonCodes.push("PROJECT_INBOX_NON_DISPATCHABLE");
  }
  if (task.archivedAt !== null) reasonCodes.push("TASK_ARCHIVED");
  if (task.status === "backlog") reasonCodes.push("BACKLOG_NOT_ELIGIBLE");
  else if (task.status !== "todo") reasonCodes.push("TASK_STATUS_NOT_TODO");
  if (task.relations.blockedBy.some((blockedBy) => blockedBy.status !== "done")) {
    reasonCodes.push("BLOCKED_BY_INCOMPLETE");
  }
  if (execution.rootRoute.state !== "ready") {
    reasonCodes.push(...execution.rootRoute.reasonCodes);
  }
  if (task.developmentContext?.type !== "worktree" || !task.developmentContext.path) {
    reasonCodes.push("WORKTREE_MISSING");
  }
  if (task.developmentContext?.type !== "worktree" || !task.developmentContext.branch) {
    reasonCodes.push("WORKTREE_BRANCH_MISSING");
  }
  if (workflow.workingLogRequired && !task.workingLog) reasonCodes.push("WORKING_LOG_MISSING");
  else if (workflow.workingLogRequired && !["planned", "active"].includes(task.workingLog.status)) {
    reasonCodes.push("WORKING_LOG_STATUS_NOT_READY");
  }
  const state = claimState(claim, timestamp);
  if (state === "active") reasonCodes.push("ACTIVE_CLAIM");
  if (state === "expired_unresolved") reasonCodes.push("EXPIRED_UNRESOLVED_CLAIM");
  const pendingActions = authorization.state === "valid"
    ? authorization.envelope.actions
      .filter((action) => action.status === "pending")
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    : [];
  const currentFrontier = frontierFor(
    task,
    comments,
    coordinationEvents,
    activeRun,
    latestRun,
    authorization,
    pendingActions,
  );
  const readyWork = {
    state: reasonCodes.length === 0 ? "ready" : "not_ready",
    eligible: reasonCodes.length === 0,
    reasonCodes,
    nextAction: { text: currentFrontier.text, source: currentFrontier.source },
    safeActions: [],
    deferredActions: [],
    approvalRequest: null,
  };

  const structuralReasonCode = reasonCodes.find((reasonCode) => (
    STRUCTURAL_NEXT_ACTIONS.has(reasonCode)
  ));
  if (structuralReasonCode) {
    readyWork.nextAction = structuralNextActionFor(structuralReasonCode);
  }

  if (reasonCodes.includes("PROJECT_INBOX_NON_DISPATCHABLE")) return readyWork;

  if (authorization.state === "absent") return readyWork;
  if (authorization.state === "invalid") {
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_ENVELOPE_INVALID");
    if (readyWork.nextAction.source.type !== "structural_blocker") {
      readyWork.nextAction = structuralNextActionFor("AUTHORIZATION_ENVELOPE_INVALID");
    }
    return readyWork;
  }

  const gates = new Map(authorization.envelope.gates.map((gate) => {
    const expired = gate.state === "authorized"
      && gate.expiresAt
      && new Date(gate.expiresAt) <= timestamp;
    if (!expired) return [gate.id, gate];
    return [gate.id, {
      ...gate,
      state: gate.renewable ? "approval_required" : "forbidden",
      expired: true,
    }];
  }));
  readyWork.safeActions = pendingActions.filter((action) => gates.get(action.gate).state === "authorized");
  readyWork.deferredActions = pendingActions.filter((action) => gates.get(action.gate).state !== "authorized");

  if (reasonCodes.length > 0) return readyWork;
  if (pendingActions.length === 0) {
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_ACTIONS_EXHAUSTED");
    return readyWork;
  }
  const frontierActionId = currentFrontier.source.type === "authorization_action"
    ? currentFrontier.source.actionId
    : null;
  if (frontierActionId !== pendingActions[0].id) {
    readyWork.safeActions = [];
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_ACTION_SUPERSEDED");
    return readyWork;
  }
  if (readyWork.safeActions.length > 0) {
    return readyWork;
  }

  const approvalAction = readyWork.deferredActions.find((action) => (
    gates.get(action.gate).state === "approval_required"
  ));
  if (approvalAction) {
    const gate = gates.get(approvalAction.gate);
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_REQUIRED");
    readyWork.approvalRequest = {
      actionId: approvalAction.id,
      gateId: gate.id,
      approver: gate.approver,
      message: gate.approvalRequest,
      scope: gate.scope,
      target: approvalAction.target,
      expectedResumeToken: null,
    };
  } else if (readyWork.deferredActions.length > 0) {
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push(readyWork.deferredActions.some((action) => (
      gates.get(action.gate).state === "denied"
    )) ? "AUTHORIZATION_DENIED" : "AUTHORIZATION_FORBIDDEN");
  }
  return readyWork;
}

export function createTaskCapsule({
  task,
  comments,
  attachments,
  inboxReceipts = [],
  coordinationEvents = [],
  currentClaim,
  currentRun = null,
  latestRun = null,
  now = new Date(),
}) {
  const orderedComments = [...comments].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));
  const orderedAttachments = allAttachments(orderedComments, attachments);
  const requirementsRevision = hash({
    task: [task.id, task.version],
    comments: orderedComments.map((comment) => [comment.id, comment.version]),
    attachments: orderedAttachments.map((attachment) => [attachment.id, attachment.changeRevision ?? 0]),
  });
  const execution = executionFor(task);
  const authorization = authorizationFor(task, orderedComments);
  const handoffs = handoffsFor(coordinationEvents);
  const legacyRun = latestRun ? null : activeRunFor(task, currentClaim, now);
  const activeRun = currentRun ? durableRunFor(currentRun) : legacyRun;
  const projectedLatestRun = latestRun ? durableRunFor(latestRun) : legacyRun;
  const readyWork = readyWorkFor(
    task,
    currentClaim,
    now,
    execution,
    orderedComments,
    coordinationEvents,
    activeRun,
    projectedLatestRun,
    authorization,
    requirementsRevision,
  );
  const workflow = workflowFor(task);
  const currentFrontier = {
    ...readyWork.nextAction,
    observedAt: readyWork.nextAction.source.type === "structural_blocker"
      ? (task.updatedAt ?? now.toISOString())
      : frontierFor(
          task,
          orderedComments,
          coordinationEvents,
          activeRun,
          projectedLatestRun,
          authorization,
          authorization.state === "valid"
            ? authorization.envelope.actions
              .filter((action) => action.status === "pending")
              .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
            : [],
        ).observedAt,
  };
  const resumeToken = hash({
    requirementsRevision,
    relations: relationEvidence(task),
    readyEvidence: {
      state: readyWork.state,
      eligible: readyWork.eligible,
      reasonCodes: readyWork.reasonCodes,
      nextAction: readyWork.nextAction,
      worktree: task.developmentContext,
      workingLog: task.workingLog,
      workflow,
      authorization,
    },
    run: projectedLatestRun,
    handoffs,
    legacyClaim: latestRun ? null : claimEvidence(currentClaim),
    threadBinding: execution.threadBinding,
  });
  if (readyWork.approvalRequest) {
    readyWork.approvalRequest.expectedResumeToken = resumeToken;
  }
  return {
    capsuleVersion: CAPSULE_VERSION,
    requirementsRevision,
    task: {
      id: task.id,
      identifier: task.identifier,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      labels: task.labels ?? [],
      workflowProfile: workflow.profile,
      status: task.status,
      version: task.version,
      archivedAt: task.archivedAt,
    },
    relations: task.relations,
    comments: orderedComments,
    attachments: orderedAttachments,
    inbox: inboxFor(inboxReceipts),
    handoffs,
    conversation: conversationFor(task),
    planning: planningFor(task),
    execution,
    executionTarget: task.developmentContext?.type === "worktree" ? task.developmentContext : null,
    worktree: task.developmentContext?.type === "worktree" ? task.developmentContext : null,
    workingLog: task.workingLog,
    workflow,
    authorization,
    activeRun,
    latestRun: projectedLatestRun,
    readyWork,
    currentFrontier,
    resumeToken,
  };
}
