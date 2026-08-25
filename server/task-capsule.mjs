import { createHash } from "node:crypto";

const CAPSULE_VERSION = "TaskCapsuleV1";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function readyWorkFor(task, claim, timestamp, execution, comments, latestRun) {
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
  return {
    state: reasonCodes.length === 0 ? "ready" : "not_ready",
    eligible: reasonCodes.length === 0,
    reasonCodes,
    nextAction: nextActionFor(task, comments, latestRun),
  };
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
  const legacyRun = latestRun ? null : activeRunFor(task, currentClaim, now);
  const activeRun = currentRun ? durableRunFor(currentRun) : legacyRun;
  const projectedLatestRun = latestRun ? durableRunFor(latestRun) : legacyRun;
  const readyWork = readyWorkFor(task, currentClaim, now, execution, orderedComments, projectedLatestRun);
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
    },
    run: projectedLatestRun,
    legacyClaim: latestRun ? null : claimEvidence(currentClaim),
    threadBinding: execution.threadBinding,
  });
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
    activeRun,
    latestRun: projectedLatestRun,
    readyWork,
    resumeToken,
  };
}
