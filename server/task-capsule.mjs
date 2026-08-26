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
  if (sources.length !== 1) return { state: "invalid", envelope: null, source: null };

  const source = sources[0];
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

  const gateIds = new Set();
  for (const gate of envelope.gates) {
    if (!gate || !nonEmptyString(gate.id) || gateIds.has(gate.id)
      || !AUTHORIZATION_GATE_KINDS.has(gate.kind)
      || !AUTHORIZATION_GATE_STATES.has(gate.state)
      || !nonEmptyString(gate.scope)) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.state === "authorized" && (!nonEmptyString(gate.evidence) || !nonEmptyString(gate.receipt))) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.state === "approval_required"
      && (!nonEmptyString(gate.approver) || !nonEmptyString(gate.approvalRequest))) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.state === "denied"
      && (!nonEmptyString(gate.approver) || !nonEmptyString(gate.evidence) || !nonEmptyString(gate.receipt))) {
      return { state: "invalid", envelope: null, source: null };
    }
    if (gate.expiresAt !== undefined
      && (!nonEmptyString(gate.expiresAt) || Number.isNaN(new Date(gate.expiresAt).getTime()))) {
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

  const recordsDecision = envelope.gates.some((gate) => (
    gate.state === "authorized" || gate.state === "denied"
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

function nextActionFor(task, comments, latestRun) {
  if (latestRun?.nextAction) {
    return {
      text: latestRun.nextAction,
      source: { type: "agent_run", runId: latestRun.id, runVersion: latestRun.version },
    };
  }
  const checkpoint = [...comments].reverse().find((comment) => (
    isCheckpointOrHandoff(comment) && !isSuperseded(comment)
  ));
  const match = checkpoint?.body.match(
    /^(?:Next executable action|Next action)\s*:\s*(.+)$/im,
  );
  if (match) {
    return {
      text: match[1].trim(),
      source: { type: "checkpoint", commentId: checkpoint.id, commentVersion: checkpoint.version },
    };
  }
  return {
    text: task.title,
    source: { type: "task_title_fallback", explicit: true },
  };
}

function readyWorkFor(task, claim, timestamp, execution, comments, latestRun, authorization, requirementsRevision) {
  const reasonCodes = [];
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
  if (!task.workingLog) reasonCodes.push("WORKING_LOG_MISSING");
  else if (!["planned", "active"].includes(task.workingLog.status)) {
    reasonCodes.push("WORKING_LOG_STATUS_NOT_READY");
  }
  if (task.threadBinding?.workspacePath !== task.developmentContext?.path) {
    reasonCodes.push("ROOT_WORKTREE_MISMATCH");
  }
  const state = claimState(claim, timestamp);
  if (state === "active") reasonCodes.push("ACTIVE_CLAIM");
  if (state === "expired_unresolved") reasonCodes.push("EXPIRED_UNRESOLVED_CLAIM");
  const readyWork = {
    state: reasonCodes.length === 0 ? "ready" : "not_ready",
    eligible: reasonCodes.length === 0,
    reasonCodes,
    nextAction: nextActionFor(task, comments, latestRun),
    safeActions: [],
    deferredActions: [],
    approvalRequest: null,
  };

  if (authorization.state === "absent") return readyWork;
  if (authorization.state === "invalid") {
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_ENVELOPE_INVALID");
    return readyWork;
  }

  const gates = new Map(authorization.envelope.gates.map((gate) => {
    const expired = gate.state === "authorized"
      && gate.expiresAt
      && new Date(gate.expiresAt) <= timestamp;
    if (!expired) return [gate.id, gate];
    return [gate.id, {
      ...gate,
      state: nonEmptyString(gate.approver) && nonEmptyString(gate.approvalRequest)
        ? "approval_required"
        : "forbidden",
      expired: true,
    }];
  }));
  const pendingActions = authorization.envelope.actions
    .filter((action) => action.status === "pending")
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  readyWork.safeActions = pendingActions.filter((action) => gates.get(action.gate).state === "authorized");
  readyWork.deferredActions = pendingActions.filter((action) => gates.get(action.gate).state !== "authorized");

  if (reasonCodes.length > 0) return readyWork;
  if (pendingActions.length === 0) {
    readyWork.state = "not_ready";
    readyWork.eligible = false;
    readyWork.reasonCodes.push("AUTHORIZATION_ACTIONS_EXHAUSTED");
    return readyWork;
  }
  if (readyWork.safeActions.length > 0) {
    readyWork.nextAction = {
      text: readyWork.safeActions[0].text,
      source: { type: "authorization_action", actionId: readyWork.safeActions[0].id },
    };
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
  const legacyRun = latestRun ? null : activeRunFor(task, currentClaim, now);
  const activeRun = currentRun ? durableRunFor(currentRun) : legacyRun;
  const projectedLatestRun = latestRun ? durableRunFor(latestRun) : legacyRun;
  const readyWork = readyWorkFor(
    task,
    currentClaim,
    now,
    execution,
    orderedComments,
    projectedLatestRun,
    authorization,
    requirementsRevision,
  );
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
      authorization,
    },
    run: projectedLatestRun,
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
      status: task.status,
      version: task.version,
      archivedAt: task.archivedAt,
    },
    relations: task.relations,
    comments: orderedComments,
    attachments: orderedAttachments,
    execution,
    worktree: task.developmentContext?.type === "worktree" ? task.developmentContext : null,
    workingLog: task.workingLog,
    authorization,
    activeRun,
    latestRun: projectedLatestRun,
    readyWork,
    resumeToken,
  };
}
