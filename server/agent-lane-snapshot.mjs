import { open, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const AGENT_LANE_SNAPSHOT_VERSION = 7;
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_PARTIAL_JSON_LINE_BYTES = MAX_TAIL_BYTES;
const MAX_SUBAGENT_RECOVERY_BYTES = 2 * 1024 * 1024;
const MAX_SUBAGENT_REGISTRY_LOOKBACK_BYTES = 8 * 1024 * 1024;
const MAX_VISIBLE_SUBAGENTS = 12;
const CONNECTED_SOURCES = new Set(["codex"]);
const CONNECTIONS = new Set(["connected", "not_connected"]);
const TASK_TYPES = new Set(["root_task", "peer_task", "infrastructure_task"]);
const TODO_STATES = new Set(["ready", "claimed", "waiting_user", "blocked", "validating", "completed"]);

class AgentLaneSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentLaneSnapshotError";
    this.code = code;
  }
}

function text(value, fallback = null) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function compact(value, maxLength = 360) {
  const normalized = text(value)
    ?.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/https?:\/\/[^\s/:@]+:[^\s/@]+@/gi, "https://[redacted]@")
    ?.replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ") ?? null;
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function completionSummary(value) {
  const raw = text(value, "") ?? "";
  const payloadMatch = raw.match(/(?:^|\s)Payload:\s*([\s\S]*)$/i);
  if (payloadMatch && !text(payloadMatch[1]) && /Message Type:\s*MESSAGE/i.test(raw)) {
    return "Sub-Agent reported progress.";
  }
  const payload = payloadMatch?.[1] ?? raw;
  return compact(payload, 180);
}

function validateConfigTask(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id);
  const label = text(value.label);
  const owner = text(value.owner);
  const source = text(value.source);
  if (!id || !label || !owner || !source) return null;
  const explicitConnection = text(value.connection);
  const connection = explicitConnection ?? (CONNECTED_SOURCES.has(source) ? "connected" : "not_connected");
  if (!CONNECTIONS.has(connection)) return null;
  const threadId = text(value.threadId);
  if (connection === "connected" && source === "codex" && !threadId) return null;
  return {
    id,
    label,
    owner,
    source,
    connection,
    threadId,
    roleNote: text(value.roleNote),
    taskType: TASK_TYPES.has(value.taskType) ? value.taskType : "peer_task",
    issueIdentifier: text(value.issueIdentifier),
    codexProjectId: text(value.codexProjectId),
    codexProjectKind: text(value.codexProjectKind),
    codexHostId: text(value.codexHostId),
    workspacePath: text(value.workspacePath),
  };
}

function hasProtectedCodexBinding(task) {
  return [
    task?.codexProjectId, task?.codexProjectKind, task?.codexHostId, task?.workspacePath,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function hasExactCodexHostBinding(task) {
  return Boolean(
    typeof task?.codexProjectId === "string"
    && task.codexProjectId.trim()
    && ["local", "remote"].includes(task.codexProjectKind)
    && typeof task.codexHostId === "string"
    && task.codexHostId.trim()
    && ((task.codexProjectKind === "local" && task.codexHostId === "local")
      || (task.codexProjectKind === "remote" && task.codexHostId !== "local"))
    && typeof task.workspacePath === "string"
    && path.isAbsolute(task.workspacePath),
  );
}

function isFullyBoundCodexPeerTask(task) {
  return Boolean(
    task?.source === "codex"
    && task?.taskType === "peer_task"
    && typeof task.threadId === "string"
    && task.threadId.trim()
    && hasExactCodexHostBinding(task),
  );
}

function isConfiguredCodexPeerTask(task) {
  const base = Boolean(
    task?.source === "codex"
    && task?.taskType === "peer_task"
    && typeof task.id === "string" && task.id.trim()
    && typeof task.label === "string" && task.label.trim()
    && typeof task.owner === "string" && task.owner.trim()
    && typeof task.threadId === "string" && task.threadId.trim()
  );
  return base && (!hasProtectedCodexBinding(task) || isFullyBoundCodexPeerTask(task));
}

function validateConfigAdapter(value) {
  const lane = validateConfigTask({ ...value, taskType: "peer_task" });
  return lane?.connection === "not_connected" ? { ...lane, taskType: null } : null;
}

function disabledAdapterContract(providerId) {
  return {
    version: 1,
    providerId,
    state: "disabled",
    reasonCode: "ADAPTER_NOT_CONFIGURED",
    transport: null,
    capabilities: {
      inspect: false,
      dispatch: false,
      wait: false,
      checkpointReceipt: false,
    },
  };
}

function validateTodo(value, taskIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id);
  const title = text(value.title);
  const state = text(value.state);
  const claimedBy = text(value.claimedBy);
  const leaseExpiresAt = text(value.leaseExpiresAt);
  if (!id || !title || !TODO_STATES.has(state)) return null;
  if (claimedBy && !taskIds.has(claimedBy)) return null;
  if (state === "claimed" && (!claimedBy || !leaseExpiresAt)) return null;
  return {
    id,
    title,
    state,
    claimedBy,
    claimedAt: text(value.claimedAt),
    leaseExpiresAt,
    claimStatus: text(value.claimStatus),
    writeScope: Array.isArray(value.writeScope) ? value.writeScope.map((item) => text(item)).filter(Boolean) : [],
    nextAction: compact(value.nextAction, 80),
    evidenceRef: compact(value.evidenceRef, 160),
  };
}

async function readConfig(configPath, projectId, getLaneConfig) {
  let project;
  if (getLaneConfig) {
    project = await getLaneConfig(projectId);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      throw new AgentLaneSnapshotError(
        "AGENT_LANES_CONFIG_UNAVAILABLE",
        "Agent lane configuration is unavailable.",
      );
    }
    project = parsed?.version === 2 ? parsed.projects?.[projectId] : null;
  }
  const rawTasks = Array.isArray(project?.tasks) ? project.tasks : [];
  const tasks = rawTasks.map(validateConfigTask);
  const adapters = Array.isArray(project?.adapters) ? project.adapters.map(validateConfigAdapter) : [];
  const taskIds = tasks.flatMap((lane) => lane ? [lane.id] : []);
  const adapterIds = adapters.flatMap((lane) => lane ? [lane.id] : []);
  const coordinatorLease = project?.coordinatorLease;
  const coordinatorLeaseConfigured = coordinatorLease !== null && coordinatorLease !== undefined;
  const coordinatorLeaseHolder = tasks.find((task) => task?.id === coordinatorLease?.holderTaskId);
  const ownerRootTaskId = text(project?.ownerRootTaskId);
  const ownerRootTask = tasks.find((task) => task?.id === ownerRootTaskId) ?? null;
  const ownerRootValid = !ownerRootTaskId || Boolean(
    ownerRootTask?.source === "codex"
    && ownerRootTask?.taskType === "root_task"
    && ownerRootTask.threadId
    && ownerRootTask.codexHostId
    && ownerRootTask.workspacePath
    && path.isAbsolute(ownerRootTask.workspacePath)
  );
  const coordinatorLeaseBindingComplete = Boolean(
    coordinatorLease?.holderThreadId
    && coordinatorLease?.holderCodexHostId
    && coordinatorLease?.holderWorkspacePath
    && path.isAbsolute(coordinatorLease.holderWorkspacePath)
    && path.isAbsolute(coordinatorLeaseHolder?.workspacePath ?? "")
  );
  const coordinatorLeaseBindingMatches = coordinatorLeaseBindingComplete && Boolean(
    coordinatorLease?.holderThreadId === coordinatorLeaseHolder?.threadId
    && coordinatorLease?.holderCodexHostId === coordinatorLeaseHolder?.codexHostId
    && path.resolve(coordinatorLease?.holderWorkspacePath ?? "")
      === path.resolve(coordinatorLeaseHolder?.workspacePath ?? "")
    && (!ownerRootTaskId || (
      ownerRootValid
      && coordinatorLeaseHolder?.id !== ownerRootTaskId
      && coordinatorLeaseHolder?.source === "codex"
      && coordinatorLeaseHolder?.taskType === "root_task"
    )),
  );
  const coordinatorLeaseReleased = Boolean(
    coordinatorLease?.releasedAt
    && !Number.isNaN(Date.parse(coordinatorLease.releasedAt))
    && !Number.isNaN(Date.parse(coordinatorLease?.acquiredAt ?? ""))
    && Date.parse(coordinatorLease.releasedAt) >= Date.parse(coordinatorLease.acquiredAt),
  );
  const hasCoordinatorLease = Boolean(
    coordinatorLease
    && text(coordinatorLease.id)
    && text(coordinatorLease.holderTaskId)
    && (taskIds.includes(coordinatorLease.holderTaskId) || coordinatorLeaseReleased)
    && text(coordinatorLease.acquiredAt)
    && text(coordinatorLease.expiresAt)
    && !Number.isNaN(Date.parse(coordinatorLease.acquiredAt))
    && !Number.isNaN(Date.parse(coordinatorLease.expiresAt))
    && Date.parse(coordinatorLease.acquiredAt) <= Date.parse(coordinatorLease.expiresAt)
    && (!coordinatorLease.releasedAt
      || (!Number.isNaN(Date.parse(coordinatorLease.releasedAt))
        && Date.parse(coordinatorLease.releasedAt) >= Date.parse(coordinatorLease.acquiredAt)))
  );
  const hasLegacyCoordinator = Boolean(
    text(project?.rootTaskId)
    && tasks.some((task) => task.id === project.rootTaskId && task.taskType === "root_task"),
  );
  const hasOwnerRoot = ownerRootValid;
  const coordinationDomains = Array.isArray(project?.coordinationDomains)
    ? project.coordinationDomains.map((domain) => ({
        id: text(domain?.id),
        label: text(domain?.label),
        writeScope: Array.isArray(domain?.writeScope)
          ? domain.writeScope.map((entry) => text(entry)).filter(Boolean)
          : [],
        eligibleTaskIds: Array.isArray(domain?.eligibleTaskIds)
          ? domain.eligibleTaskIds.map((entry) => text(entry)).filter(Boolean)
          : [],
      }))
    : [];
  const validDomains = coordinationDomains.every((domain) => (
    domain.id
    && domain.label
    && domain.writeScope.length > 0
    && domain.eligibleTaskIds.length > 0
    && domain.eligibleTaskIds.every((taskId) => (
      isConfiguredCodexPeerTask(rawTasks.find((task) => task?.id === taskId))
    ))
  )) && new Set(coordinationDomains.map((domain) => domain.id)).size === coordinationDomains.length;
  const rawDomainLeases = project?.domainCoordinatorLeases ?? {};
  const validDomainLeases = rawDomainLeases && typeof rawDomainLeases === "object"
    && !Array.isArray(rawDomainLeases)
    && Object.entries(rawDomainLeases).every(([domainId, domainLease]) => {
      const domain = coordinationDomains.find((entry) => entry.id === domainId);
      const holder = rawTasks.find((task) => task?.id === domainLease?.holderTaskId);
      return domain
        && text(domainLease?.id)
        && text(domainLease?.holderTaskId)
        && isFullyBoundCodexPeerTask(holder)
        && domain.eligibleTaskIds.includes(domainLease.holderTaskId)
        && text(domainLease?.acquiredAt)
        && text(domainLease?.expiresAt)
        && !Number.isNaN(Date.parse(domainLease.acquiredAt))
        && !Number.isNaN(Date.parse(domainLease.expiresAt))
        && Date.parse(domainLease.acquiredAt) <= Date.parse(domainLease.expiresAt)
        && (!domainLease.releasedAt
          || (!Number.isNaN(Date.parse(domainLease.releasedAt))
            && Date.parse(domainLease.releasedAt) >= Date.parse(domainLease.acquiredAt)));
    });
  if (
    tasks.length === 0
    || tasks.some((lane) => lane === null)
    || adapters.some((lane) => lane === null)
    || new Set([...taskIds, ...adapterIds]).size !== taskIds.length + adapterIds.length
    || (coordinatorLeaseConfigured ? !hasCoordinatorLease : !hasLegacyCoordinator)
    || !hasOwnerRoot
    || !validDomains
    || !validDomainLeases
  ) {
    throw new AgentLaneSnapshotError(
      "AGENT_LANES_NOT_CONFIGURED",
      `Project '${projectId}' has no valid Agent Lane mapping`,
    );
  }
  return {
    rootTaskId: !coordinatorLeaseConfigured && hasLegacyCoordinator ? project.rootTaskId : null,
    ownerRootTaskId: ownerRootTaskId ?? null,
    coordinatorLease: hasCoordinatorLease ? {
      id: coordinatorLease.id,
      holderTaskId: coordinatorLease.holderTaskId,
      bindingValid: coordinatorLeaseBindingMatches,
      acquiredAt: coordinatorLease.acquiredAt,
      expiresAt: coordinatorLease.expiresAt,
      releasedAt: coordinatorLease.releasedAt ?? null,
    } : null,
    coordinationDomains,
    domainCoordinatorLeases: validDomainLeases ? Object.fromEntries(
      Object.entries(rawDomainLeases).map(([domainId, lease]) => {
        const holder = tasks.find((task) => task?.id === lease.holderTaskId);
        const bindingValid = Boolean(
          lease.holderThreadId
          && lease.holderCodexHostId
          && lease.holderWorkspacePath
          && path.isAbsolute(lease.holderWorkspacePath)
          && path.isAbsolute(holder?.workspacePath ?? "")
          && lease.holderThreadId === holder?.threadId
          && lease.holderCodexHostId === holder?.codexHostId
          && path.resolve(lease.holderWorkspacePath) === path.resolve(holder?.workspacePath ?? ""),
        );
        return [domainId, { ...lease, bindingValid }];
      }),
    ) : {},
    tasks,
    adapters,
  };
}

function actionFingerprint(value) {
  const normalized = compact(value)?.toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : null;
}

function nextActionFrom(value) {
  const body = text(value, "") ?? "";
  const match = body.match(/(?:^|\n|[.!?。]\s+)\s*(?:next action|下一步|exact first (?:owner )?action)\s*[:：]\s*(.+)/i);
  return compact(match?.[1], 240);
}

function continuityFor(lane) {
  if (lane.connection === "not_connected") {
    return { state: "adapter_off", reason: "Adapter is intentionally disabled." };
  }
  if (lane.status === "unavailable") {
    return { state: "disconnected", reason: lane.blocker };
  }
  if (lane.freshness === "fresh") return { state: "healthy", reason: null };
  return { state: "attention", reason: `Lane evidence is ${lane.freshness}.` };
}

function todoProjection(todo, projectId, taskLanes, now) {
  const owner = todo.claimedBy ? taskLanes.find((lane) => lane.id === todo.claimedBy) : null;
  const leaseDate = todo.leaseExpiresAt ? new Date(todo.leaseExpiresAt) : null;
  const validLease = leaseDate && !Number.isNaN(leaseDate.getTime());
  const leaseExpired = Boolean(
    todo.claimedBy
    && todo.claimStatus !== "completed"
    && (!validLease || leaseDate <= now),
  );
  const leaseState = !todo.claimedBy
    ? "unclaimed"
    : todo.claimStatus === "completed"
      ? "completed"
      : leaseExpired ? "expired" : "active";
  const route = leaseExpired
    ? "replan_required"
    : ({
        ready: "ready_for_agent",
        claimed: "wait",
        waiting_user: "user_action_required",
        blocked: "blocked",
        validating: "wait",
        completed: "validated_completion",
      })[todo.state];
  const attention = leaseExpired
    ? "needs_coordinator"
    : todo.state === "waiting_user"
      ? "needs_user"
      : todo.state === "ready"
        ? "ready"
        : todo.state === "blocked"
          ? "blocked"
          : todo.state === "completed"
            ? "done"
            : "watch";
  const recoveryActionId = actionFingerprint(`${projectId}:${todo.id}:${todo.claimedBy ?? "unclaimed"}:${todo.leaseExpiresAt ?? "none"}`);
  return {
    ...todo,
    claim: todo.claimedBy ? {
      laneId: todo.claimedBy,
      ownerStableIdentity: owner?.stableIdentity ?? null,
      ownerLabel: owner?.label ?? todo.claimedBy,
      claimedAt: todo.claimedAt,
      leaseExpiresAt: todo.leaseExpiresAt,
      leaseState,
      writeScope: todo.writeScope,
    } : null,
    continuation: { route, attention },
    recovery: {
      mode: "manual_only",
      eligible: leaseState === "expired",
      actionId: recoveryActionId,
      automaticExecution: false,
    },
  };
}

function taskTodoState(task, readyWork, claim, run) {
  if (claim?.status === "active" || run?.state === "active") return "claimed";
  if (run?.state === "blocked") return "blocked";
  if (task.status === "in_review" && (claim?.status === "completed" || run?.state === "completed")) {
    return "validating";
  }
  if (["done", "canceled"].includes(task.status)) return "completed";
  if (task.status === "blocked") return task.labels.includes("waiting-user") ? "waiting_user" : "blocked";
  return readyWork.eligible ? "ready" : "blocked";
}

function readyWorkForTodo(capsule) {
  const readyWork = capsule?.readyWork;
  const action = (item) => ({
    id: text(item?.id),
    text: compact(item?.text, 120),
    standingAuthority: item?.standingAuthority === true,
  });
  const request = readyWork?.approvalRequest;
  return {
    state: readyWork?.state === "ready" ? "ready" : "not_ready",
    eligible: readyWork?.eligible === true,
    reasonCodes: Array.isArray(readyWork?.reasonCodes)
      ? readyWork.reasonCodes.filter((reason) => typeof reason === "string")
      : ["TASK_CAPSULE_UNAVAILABLE"],
    nextAction: compact(readyWork?.nextAction?.text, 80),
    safeActions: Array.isArray(readyWork?.safeActions)
      ? readyWork.safeActions.map(action).filter((item) => item.id && item.text)
      : [],
    deferredActions: Array.isArray(readyWork?.deferredActions)
      ? readyWork.deferredActions.map(action).filter((item) => item.id && item.text)
      : [],
    approvalRequest: request?.actionId && request?.message && request?.expectedResumeToken
      ? {
        requestId: text(request.requestId),
        actionId: text(request.actionId),
        gateId: text(request.gateId),
        gateKind: text(request.gateKind),
        approver: text(request.approver),
        message: compact(request.message, 240),
        scope: compact(request.scope, 160),
        target: compact(request.target, 160),
        requestedAt: text(request.requestedAt),
        expectedResumeToken: text(request.expectedResumeToken),
      }
      : null,
    resumeToken: text(capsule?.resumeToken),
  };
}

function dispatchTargetFor(capsule, domainCoordinator = undefined) {
  const binding = capsule?.execution?.threadBinding;
  const worktree = capsule?.executionTarget ?? capsule?.worktree;
  if (domainCoordinator !== undefined) {
    if (
      !domainCoordinator
      || !domainCoordinator.threadId
      || !domainCoordinator.codexHostId
      || !domainCoordinator.workspacePath
      || worktree?.type !== "worktree"
      || !worktree.path
    ) return null;
    return {
      rootThreadId: domainCoordinator.threadId,
      codexHostId: domainCoordinator.codexHostId,
      rootWorkspacePath: domainCoordinator.workspacePath,
      worktreePath: worktree.path,
    };
  }
  if (
    !binding?.threadId
    || !binding?.codexHostId
    || !binding?.workspacePath
    || worktree?.type !== "worktree"
    || !worktree.path
  ) return null;
  return {
    rootThreadId: binding.threadId,
    codexHostId: binding.codexHostId,
    rootWorkspacePath: binding.workspacePath,
    worktreePath: worktree.path,
  };
}

function workingLogFor(capsule) {
  const workingLog = capsule?.workingLog;
  if (!workingLog?.path || !workingLog?.status || !workingLog?.updatedAt) return null;
  return {
    path: workingLog.path,
    status: workingLog.status,
    updatedAt: workingLog.updatedAt,
  };
}

function runForTodo(capsule) {
  const run = capsule?.activeRun;
  if (!run?.id || !["active", "blocked"].includes(run.state)) return null;
  return {
    id: run.id,
    state: run.state,
    durable: run.role === "sub_agent",
    agentPath: text(run.agentPath),
    agentThreadId: text(run.agentThreadId),
    startedAt: text(run.startedAt ?? run.claimedAt),
    updatedAt: text(run.updatedAt ?? run.claimedAt),
    finishedAt: text(run.finishedAt ?? run.completedAt),
    writeScope: Array.isArray(run.writeScope) ? run.writeScope.map((item) => text(item)).filter(Boolean) : [],
    nextAction: compact(run.nextAction, 80),
  };
}

async function taskTodoProjection(
  task, projectId, taskLanes, getClaim, getAdmission, listComments, generatedAt, capsule,
  domainAssignment, domainRoute, globalCoordinator, globalArbitrationRequired,
) {
  const storedClaim = getClaim ? await getClaim(task.id) : null;
  const claim = ["in_progress", "in_review"].includes(task.status) ? storedClaim : null;
  const readyWork = readyWorkForTodo(capsule);
  const run = runForTodo(capsule);
  const admission = getAdmission ? await getAdmission(task.id) : null;
  const owner = claim?.agentPath
    ? taskLanes.find((lane) => lane.threadId === claim.agentThreadId || lane.id === claim.agentPath.replace(/^\/root\//, ""))
    : null;
  const comments = Array.isArray(capsule?.comments)
    ? capsule.comments
    : listComments ? await listComments(task.id) : [];
  const latest = comments.at(-1) ?? null;
  return {
    ...todoProjection({
    id: task.identifier,
    title: task.title,
    priority: task.priority,
    state: taskTodoState(task, readyWork, claim, run),
    claimedBy: claim?.agentPath ?? null,
    claimedThreadId: claim?.agentThreadId ?? null,
    claimedAt: claim?.claimedAt ?? null,
    leaseExpiresAt: claim?.leaseExpiresAt ?? null,
    claimStatus: claim?.status ?? null,
    writeScope: run?.writeScope?.length ? run.writeScope : claim?.writeScope?.length ? claim.writeScope : task.labels,
    nextAction: readyWork.nextAction ?? nextActionFrom(latest?.body) ?? compact(task.title, 80),
    evidenceRef: latest ? `comment:${latest.id}` : `task:${task.identifier}`,
    }, projectId, taskLanes, generatedAt),
    taskId: task.id,
    dispatchTarget: domainAssignment
      ? dispatchTargetFor(capsule, domainRoute?.active ? domainRoute.holder : null)
      : globalCoordinator
        ? dispatchTargetFor(capsule, globalCoordinator)
        : globalArbitrationRequired && readyWork.eligible && readyWork.safeActions.length > 0
          ? null
          : dispatchTargetFor(capsule),
    domainAssignment: domainAssignment ? {
      domainId: domainAssignment.domainId,
      status: domainRoute?.active ? "active" : "needs_coordinator",
      coordinatorTaskId: domainRoute?.active ? domainRoute.holder.id : null,
      leaseId: domainRoute?.lease?.id ?? null,
    } : null,
    workflow: capsule?.workflow ?? { profile: "formal", workingLogRequired: true },
    workingLog: workingLogFor(capsule),
    run,
    admission: admission ? {
      receiptId: admission.id,
      attemptId: admission.admissionAttemptId,
      state: admission.admissionState,
      rootThreadId: admission.rootThreadId,
      resumeToken: admission.resumeToken,
      safeActionId: admission.safeActionId,
      agentName: admission.admissionAgentName,
      agentPath: admission.admissionAgentPath,
      writeScope: admission.admissionWriteScope,
      deadlineAt: admission.admissionDeadlineAt,
      uncertainAt: admission.admissionUncertainAt,
      recoveredAgentThreadId: admission.admissionRecoveredAgentThreadId,
      deferredReason: admission.admissionDeferredReason,
      retryCount: admission.admissionRetryCount,
      retryAfter: admission.admissionRetryAfter,
      rootHostId: admission.rootHostId,
      rootWorkspacePath: admission.rootWorkspacePath,
      globalCoordinatorLeaseId: admission.globalCoordinatorLeaseId,
      globalCoordinatorTaskId: admission.globalCoordinatorTaskId,
      globalCoordinatorThreadId: admission.globalCoordinatorThreadId,
      coordinationDomainId: admission.coordinationDomainId,
      domainCoordinatorLeaseId: admission.domainCoordinatorLeaseId,
      domainCoordinatorTaskId: admission.domainCoordinatorTaskId,
      domainCoordinatorThreadId: admission.domainCoordinatorThreadId,
    } : null,
    readyWork,
    dependencyClearances: capsule?.dependencyClearances ?? [],
    inbox: capsule?.inbox ?? { pendingCount: 0, latestReceipt: null },
    handoffs: capsule?.handoffs ?? { pendingAcknowledgementCount: 0, latestEvent: null },
  };
}

async function workItemFor(taskLane, getTask, listComments) {
  if (!taskLane.issueIdentifier || !getTask) return null;
  const task = await getTask(taskLane.issueIdentifier);
  if (!task) return null;
  const comments = listComments ? await listComments(task.id) : [];
  const latest = comments.at(-1) ?? null;
  return {
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    commentCount: comments.length,
    latestWorkingLog: compact(latest?.body),
    latestWorkingLogAt: text(latest?.createdAt),
    latestWorkingLogThreadId: text(latest?.threadId),
    relations: task.relations ?? null,
    nextAction: nextActionFrom(latest?.body),
  };
}

async function findSessionFile(directory, threadId, readSessionDirectory = readdir) {
  let entries;
  try {
    entries = await readSessionDirectory(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findSessionFile(target, threadId, readSessionDirectory);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return target;
    }
  }
  return null;
}

async function readByteRange(filename, start, end) {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        start + total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

function splitCompleteJsonLines(buffer, { discardLeadingPartial = false, startOffset = 0 } = {}) {
  let cursor = 0;
  if (discardLeadingPartial) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        records: [],
        trailing: Buffer.alloc(0),
        trailingOffset: startOffset + buffer.length,
        discardingLeadingPartial: true,
      };
    }
    cursor = firstNewline + 1;
  }
  const records = [];
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) break;
    if (newline > cursor) {
      records.push({
        line: buffer.subarray(cursor, newline).toString("utf8"),
        endOffset: startOffset + newline + 1,
      });
    }
    cursor = newline + 1;
  }
  return {
    records,
    trailing: buffer.subarray(cursor),
    trailingOffset: startOffset + cursor,
    discardingLeadingPartial: false,
  };
}

function consumeCompleteTrailingJson(records, trailing, endOffset) {
  if (trailing.length === 0) return { records, trailing };
  const line = trailing.toString("utf8");
  try {
    JSON.parse(line);
    return {
      records: [...records, { line, endOffset }],
      trailing: Buffer.alloc(0),
    };
  } catch {
    return { records, trailing: Buffer.from(trailing) };
  }
}

function eventSignal(entry) {
  if (entry?.type === "turn_context") return { status: "running", action: null };
  if (entry?.type !== "event_msg") return null;
  const payload = entry.payload;
  if (payload?.type === "task_complete") {
    return {
      status: "idle",
      action: compact(payload.last_agent_message),
      evidence: extractEvidence(payload.last_agent_message),
    };
  }
  if (payload?.type === "agent_message") {
    return {
      status: payload.phase === "final_answer" ? "idle" : "running",
      action: compact(payload.message),
      evidence: extractEvidence(payload.message),
    };
  }
  if (payload?.type === "user_message") return { status: "running", action: null };
  return null;
}

function extractEvidence(value) {
  const content = text(value, "") ?? "";
  const sha = content.match(
    /\b(?:commit|sha)(?:\s+(?:hash|id))?\s*(?::|=|is)?\s*`?([0-9a-f]{40})`?/i,
  )?.[1]?.toLowerCase() ?? null;
  const branch = content.match(/\b(?:branch|head)\s*(?::|=|is)?\s*`?([a-z0-9][a-z0-9._/-]{2,})`?/i)?.[1] ?? null;
  const checks = [...new Set(content.match(/\b\d+\/\d+\s*(?:PASS|passed)?\b/gi) ?? [])].slice(0, 4);
  if (/TypeScript(?:\s+(?:clean|PASS|passed))?/i.test(content)) checks.push("TypeScript");
  const blocker = content.split(/(?<=[.!?。])\s+/).find((sentence) => (
    /\b(?:blocker|gate|first next action|target)\b/i.test(sentence)
  ));
  return { branch, sha, checks, blocker: compact(blocker, 240) };
}

function freshness(lastActivityAt, now) {
  if (!lastActivityAt) return "unknown";
  const age = now.getTime() - new Date(lastActivityAt).getTime();
  if (!Number.isFinite(age)) return "unknown";
  if (age <= 15 * 60_000) return "fresh";
  if (age <= 60 * 60_000) return "aging";
  return "stale";
}

const CODEX_TASK_SIGNAL_TYPES = ["turn_context", "event_msg", "task_complete", "agent_message", "user_message"];
const CODEX_TASK_SIGNAL_TYPE_PATTERNS = new Map(CODEX_TASK_SIGNAL_TYPES.map((value) => [
  value,
  new RegExp(`"type"\\s*:\\s*"${value}"`),
]));

function codexTaskSignalLine(line) {
  const hasType = (value) => line.includes(`"type":"${value}"`)
    || CODEX_TASK_SIGNAL_TYPE_PATTERNS.get(value).test(line);
  return hasType("turn_context") || (
    hasType("event_msg")
    && ["task_complete", "agent_message", "user_message"].some(hasType)
  );
}

function unavailableCodexTask(taskLane) {
  return {
    ...taskLane,
    status: "unavailable",
    freshness: "unknown",
    lastActivityAt: null,
    lastActualAction: null,
    branch: null,
    sha: null,
    checks: [],
    blocker: "Configured Codex task session was not found.",
    provenance: { kind: "codex-local-session", threadId: taskLane.threadId },
  };
}

async function readCodexTask(
  taskLane,
  resolveSessionFile,
  forgetSessionFile,
  now,
  sessionStates,
  statSessionFile,
  readSessionByteRange,
) {
  const sessionFile = await resolveSessionFile(taskLane.threadId);
  if (!sessionFile) return unavailableCodexTask(taskLane);
  try {
    return await readCodexTaskFromSession(
      taskLane,
      sessionFile,
      now,
      sessionStates,
      statSessionFile,
      readSessionByteRange,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    forgetSessionFile(taskLane.threadId);
    sessionStates.delete(sessionFile);
    return unavailableCodexTask(taskLane);
  }
}

async function readCodexTaskFromSession(
  taskLane,
  sessionFile,
  now,
  sessionStates,
  statSessionFile,
  readSessionByteRange,
) {
  const details = await statSessionFile(sessionFile);
  const cached = sessionStates.get(sessionFile);
  if (cached?.dev === details.dev
    && cached.ino === details.ino
    && cached.observedSize === details.size
    && cached.mtimeMs === details.mtimeMs) {
    return {
      ...taskLane,
      status: cached.observation.status,
      lastActivityAt: cached.observation.lastActivityAt,
      lastActualAction: cached.observation.lastActualAction,
      ...cached.observation.evidence,
      freshness: freshness(cached.observation.lastActivityAt, now),
      provenance: { kind: "codex-local-session", threadId: taskLane.threadId },
    };
  }
  const canAdvance = cached?.dev === details.dev
    && cached.ino === details.ino
    && cached.observedSize < details.size
    && details.size - cached.observedSize <= MAX_TAIL_BYTES;
  const start = canAdvance ? cached.observedSize : Math.max(0, details.size - MAX_TAIL_BYTES);
  const added = await readSessionByteRange(sessionFile, start, details.size);
  const capturedSize = start + added.length;
  let discardingOversizedLine = canAdvance && cached.discardingOversizedLine === true;
  let input = canAdvance ? Buffer.concat([cached.trailing, added]) : added;
  let inputStart = canAdvance ? start - cached.trailing.length : start;
  if (discardingOversizedLine) {
    const newline = added.indexOf(0x0a);
    if (newline < 0) {
      input = Buffer.alloc(0);
      inputStart = capturedSize;
    } else {
      input = added.subarray(newline + 1);
      inputStart = start + newline + 1;
      discardingOversizedLine = false;
    }
  }
  const split = splitCompleteJsonLines(input, {
    discardLeadingPartial: !canAdvance && start > 0,
    startOffset: inputStart,
  });
  discardingOversizedLine ||= split.discardingLeadingPartial === true;
  const complete = split.trailing.length > MAX_PARTIAL_JSON_LINE_BYTES
    ? { records: split.records, trailing: Buffer.alloc(0) }
    : consumeCompleteTrailingJson(split.records, split.trailing, capturedSize);
  if (split.trailing.length > MAX_PARTIAL_JSON_LINE_BYTES) discardingOversizedLine = true;
  const lines = complete.records.map((record) => record.line);
  let status = canAdvance ? cached.observation.status : "idle";
  let lastActualAction = canAdvance ? cached.observation.lastActualAction : null;
  let lastActivityAt = canAdvance ? cached.observation.lastActivityAt : null;
  let evidence = canAdvance
    ? cached.observation.evidence
    : { branch: null, sha: null, checks: [], blocker: null };
  for (const line of lines) {
    if (!codexTaskSignalLine(line)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {}
    if (!entry) continue;
    const signal = eventSignal(entry);
    if (!signal) continue;
    status = signal.status;
    if (signal.action) {
      lastActualAction = signal.action;
      evidence = signal.evidence;
    }
    if (typeof entry.timestamp === "string") lastActivityAt = entry.timestamp;
  }
  const observation = {
    status,
    lastActivityAt,
    lastActualAction,
    evidence,
  };
  sessionStates.set(sessionFile, {
    dev: details.dev,
    ino: details.ino,
    observedSize: capturedSize,
    mtimeMs: details.mtimeMs,
    trailing: complete.trailing,
    discardingOversizedLine,
    observation,
  });
  return {
    ...taskLane,
    status: observation.status,
    lastActivityAt: observation.lastActivityAt,
    lastActualAction: observation.lastActualAction,
    ...observation.evidence,
    freshness: freshness(lastActivityAt, now),
    provenance: { kind: "codex-local-session", threadId: taskLane.threadId },
  };
}

function subagentAction(payload) {
  if (payload?.type !== "agent_message" || typeof payload.author !== "string" || !payload.author.startsWith("/root/")) {
    return null;
  }
  const body = Array.isArray(payload.content)
    ? payload.content.map((item) => text(item?.text)).filter(Boolean).join("\n")
    : "";
  return {
    agentPath: payload.author,
    action: compact(body),
    completed: /Message Type:\s*FINAL_ANSWER/i.test(body),
  };
}

function normalizedListAgentStatus(value) {
  if (value === "running") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1
    || !["completed", "failed", "interrupted", "blocked"].includes(entries[0][0])
    || typeof entries[0][1] !== "string") return null;
  return entries[0][0];
}

function applySubagentLine(state, line, { registryOnly = false } = {}) {
  const registryOutput = line.includes('"type":"function_call_output"');
  if (registryOutput && ![...state.pendingListAgentCalls].some((callId) => line.includes(callId))) {
    return;
  }
  if (!line.includes("sub_agent_activity")
    && !line.includes('"author":"/root/')
    && !line.includes('"name":"list_agents"')
    && !registryOutput) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const at = text(entry.timestamp);
  if (entry.type === "response_item"
    && entry.payload?.type === "function_call"
    && entry.payload.name === "list_agents"
    && entry.payload.namespace === "collaboration"
    && typeof entry.payload.call_id === "string"
    && entry.payload.call_id) {
    state.pendingListAgentCalls.add(entry.payload.call_id);
    return;
  }
  if (registryOnly && entry.payload?.type !== "function_call_output") return;
  if (entry.type === "event_msg" && entry.payload?.type === "sub_agent_activity") {
    const agentPath = text(entry.payload.agent_path);
    if (!agentPath || agentPath === "/root") return;
    const current = state.agents.get(agentPath) ?? {
      agentPath,
      agentThreadId: null,
      lifecycleStatus: "idle",
      startedAt: null,
      lastActivityAt: null,
      lastActualAction: null,
    };
    current.agentThreadId = text(entry.payload.agent_thread_id, current.agentThreadId);
    current.lastActivityAt = at ?? current.lastActivityAt;
    if (entry.payload.kind === "started" || entry.payload.kind === "interacted") {
      current.lifecycleStatus = "running";
      current.startedAt = at ?? current.startedAt;
      current.lastActualAction = null;
      if (state.activeRegistry) {
        state.activeRegistry.add(agentPath);
        state.registryObservedAt = at ?? state.registryObservedAt;
      }
    } else if (entry.payload.kind === "interrupted") {
      current.lifecycleStatus = "interrupted";
      if (state.activeRegistry) {
        state.activeRegistry.delete(agentPath);
        state.registryObservedAt = at ?? state.registryObservedAt;
      }
    }
    state.agents.set(agentPath, current);
    state.eventAgents.set(agentPath, { ...current });
    return;
  }
  if (entry.type === "response_item") {
    const action = subagentAction(entry.payload);
    if (action) {
      const current = state.agents.get(action.agentPath) ?? {
        agentPath: action.agentPath,
        agentThreadId: null,
        lifecycleStatus: "idle",
        startedAt: null,
        lastActivityAt: null,
        lastActualAction: null,
      };
      current.lastActivityAt = at ?? current.lastActivityAt;
      current.lastActualAction = action.action ?? current.lastActualAction;
      if (action.completed) {
        current.lifecycleStatus = "completed";
        if (state.activeRegistry) {
          state.activeRegistry.delete(action.agentPath);
          state.registryObservedAt = at ?? state.registryObservedAt;
        }
      }
      state.agents.set(action.agentPath, current);
      state.eventAgents.set(action.agentPath, { ...current });
      return;
    }
    if (entry.payload?.type === "function_call_output" && typeof entry.payload.output === "string") {
      if (!state.pendingListAgentCalls.delete(entry.payload.call_id)) return;
      state.activeRegistry = null;
      state.registryAgents = null;
      state.registrySnapshotObservedAt = null;
      state.registryObservedAt = null;
      state.recoveryComplete = false;
      const previousAgents = state.agents;
      let normalizedRegistry = null;
      try {
        const output = JSON.parse(entry.payload.output);
        if (Array.isArray(output?.agents)) {
          const candidateRegistry = output.agents.map((agent) => {
            if (!agent || typeof agent !== "object" || Array.isArray(agent)
              || typeof agent.agent_name !== "string"
              || !/^\/root(?:\/[a-z0-9_]+)*$/i.test(agent.agent_name)
              || (agent.agent_id !== undefined && typeof agent.agent_id !== "string")
              || (agent.agent_thread_id !== undefined && typeof agent.agent_thread_id !== "string")) return null;
            const status = normalizedListAgentStatus(agent.agent_status);
            if (!status) return null;
            return { ...agent, normalizedStatus: status };
          });
          if (!candidateRegistry.some((agent) => agent === null)) {
            normalizedRegistry = candidateRegistry;
          }
        }
      } catch {}
      if (normalizedRegistry) {
        const registryAgents = normalizedRegistry
          .filter((agent) => agent.agent_name !== "/root")
          .map((agent) => ({
            agentPath: agent.agent_name,
            agentThreadId: typeof agent.agent_id === "string" && agent.agent_id
              ? agent.agent_id
              : typeof agent.agent_thread_id === "string" && agent.agent_thread_id
                ? agent.agent_thread_id
                : previousAgents.get(agent.agent_name)?.agentThreadId ?? null,
            status: agent.normalizedStatus,
          }));
        state.agents = new Map();
        state.registryAgents = registryAgents;
        state.activeRegistry = new Set(normalizedRegistry
          .filter((agent) => agent.normalizedStatus === "running" && agent.agent_name !== "/root")
          .map((agent) => agent.agent_name));
        for (const agent of state.registryAgents) {
          const current = previousAgents.get(agent.agentPath) ?? {
            agentPath: agent.agentPath,
            agentThreadId: null,
            lifecycleStatus: "idle",
            startedAt: null,
            lastActivityAt: null,
            lastActualAction: null,
          };
          current.agentThreadId = agent.agentThreadId ?? current.agentThreadId;
          current.lifecycleStatus = agent.status === "running"
            ? "running"
            : agent.status === "completed"
              ? "completed"
              : agent.status === "interrupted" ? "interrupted" : "idle";
          current.lastActivityAt = current.lastActivityAt ?? at;
          state.agents.set(agent.agentPath, current);
        }
        state.registryObservedAt = at;
        state.registrySnapshotObservedAt = at;
        state.recoveryComplete = true;
        return;
      }
      state.agents = new Map(
        [...state.eventAgents].map(([agentPath, agent]) => [agentPath, { ...agent }]),
      );
    }
  }
}

async function scanSubagents(
  filename,
  cached = null,
  statSessionFile = stat,
  readSessionByteRange = readByteRange,
) {
  const details = await statSessionFile(filename);
  const previousSize = cached?.observedSize ?? cached?.offset ?? 0;
  const reset = !cached
    || cached.dev !== details.dev
    || cached.ino !== details.ino
    || details.size < previousSize
    || details.size - previousSize > MAX_SUBAGENT_RECOVERY_BYTES + MAX_SUBAGENT_REGISTRY_LOOKBACK_BYTES
    || details.size === previousSize && cached.mtimeMs !== details.mtimeMs;
  const state = reset ? {
    offset: 0,
    observedSize: 0,
    dev: details.dev,
    ino: details.ino,
    mtimeMs: details.mtimeMs,
    trailing: Buffer.alloc(0),
    agents: new Map(),
    eventAgents: new Map(),
    activeRegistry: null,
    registryAgents: null,
    registrySnapshotObservedAt: null,
    registryObservedAt: null,
    pendingListAgentCalls: new Set(),
    recoveryComplete: details.size <= MAX_SUBAGENT_RECOVERY_BYTES,
  } : cached;
  state.pendingListAgentCalls ??= new Set();
  state.eventAgents ??= new Map();
  state.registryAgents ??= null;
  state.registrySnapshotObservedAt ??= null;
  state.recoveryComplete ??= false;
  state.trailing = Buffer.isBuffer(state.trailing) ? state.trailing : Buffer.alloc(0);
  state.discardingOversizedLine ??= false;
  const invalidateRegistryObservation = () => {
    state.activeRegistry = null;
    state.registryAgents = null;
    state.registrySnapshotObservedAt = null;
    state.registryObservedAt = null;
    state.recoveryComplete = false;
  };
  const hasNewBytes = details.size > previousSize;
  if (reset || hasNewBytes) {
    const start = reset
      ? Math.max(0, details.size - MAX_SUBAGENT_RECOVERY_BYTES - MAX_SUBAGENT_REGISTRY_LOOKBACK_BYTES)
      : previousSize;
    const added = await readSessionByteRange(filename, start, details.size);
    const capturedSize = start + added.length;
    let discardingOversizedLine = !reset && state.discardingOversizedLine === true;
    let input = reset ? added : Buffer.concat([state.trailing, added]);
    let inputStart = reset ? start : start - state.trailing.length;
    if (discardingOversizedLine) {
      const newline = added.indexOf(0x0a);
      if (newline < 0) {
        input = Buffer.alloc(0);
        inputStart = capturedSize;
      } else {
        input = added.subarray(newline + 1);
        inputStart = start + newline + 1;
        discardingOversizedLine = false;
      }
    }
    const split = splitCompleteJsonLines(input, {
      discardLeadingPartial: reset && start > 0,
      startOffset: inputStart,
    });
    discardingOversizedLine ||= split.discardingLeadingPartial === true;
    const complete = split.trailing.length > MAX_PARTIAL_JSON_LINE_BYTES
      ? { records: split.records, trailing: Buffer.alloc(0) }
      : consumeCompleteTrailingJson(split.records, split.trailing, capturedSize);
    if (split.trailing.length > MAX_PARTIAL_JSON_LINE_BYTES) discardingOversizedLine = true;
    const recoveryStart = Math.max(0, capturedSize - MAX_SUBAGENT_RECOVERY_BYTES);
    for (const record of complete.records) {
      applySubagentLine(state, record.line, {
        registryOnly: reset && record.endOffset <= recoveryStart,
      });
    }
    state.trailing = complete.trailing;
    state.discardingOversizedLine = discardingOversizedLine;
    if (state.discardingOversizedLine && state.pendingListAgentCalls.size > 0) {
      invalidateRegistryObservation();
    } else if (state.trailing.length > 0) {
      const partial = state.trailing.toString("utf8");
      const pendingRegistryOutput = partial.includes('"type":"function_call_output"')
        && [...state.pendingListAgentCalls].some((callId) => partial.includes(callId));
      if (pendingRegistryOutput) invalidateRegistryObservation();
    }
    state.observedSize = capturedSize;
    state.offset = capturedSize - state.trailing.length;
    state.dev = details.dev;
    state.ino = details.ino;
    state.mtimeMs = details.mtimeMs;
  }
  if (state.activeRegistry) {
    for (const agent of state.agents.values()) {
      if (state.activeRegistry.has(agent.agentPath)) agent.lifecycleStatus = "running";
      else if (agent.lifecycleStatus === "running") agent.lifecycleStatus = "idle";
    }
  }
  return state;
}

export function createAgentLaneSnapshotProvider({
  configPath,
  sessionsDirectory,
  now = () => new Date(),
  getLaneConfig = null,
  listTasks = null,
  getClaim = null,
  getAdmission = null,
  getTaskCapsule = null,
  recordProgress = null,
  recordCompletion = null,
  getTask = null,
  listComments = null,
  getPendingOwnerIntent = null,
  getPendingOwnerIntentPlan = null,
  getCoordinatorDurableWork = null,
  getCoordinatorDurableWorkReason = null,
  getCoordinatorShutdownAttempt = null,
  getTaskDomainAssignment = null,
  getCurrentHostIdentity = null,
  readSessionDirectory = readdir,
  statSessionFile = stat,
  readSessionByteRange = readByteRange,
}) {
  const sessionFilePromises = new Map();
  const taskSessionStates = new Map();
  const subagentStates = new Map();
  const allSubagentsByProject = new Map();
  const projectSnapshotInFlight = new Map();
  const resolveSessionFile = (threadId) => {
    let pending = sessionFilePromises.get(threadId);
    if (!pending) {
      pending = findSessionFile(sessionsDirectory, threadId, readSessionDirectory).then((filename) => {
        if (!filename) sessionFilePromises.delete(threadId);
        return filename;
      });
      sessionFilePromises.set(threadId, pending);
    }
    return pending;
  };
  const forgetSessionFile = (threadId) => {
    sessionFilePromises.delete(threadId);
  };
  const provider = {
    async getProjectSnapshot(projectId) {
      const configured = await readConfig(configPath, projectId, getLaneConfig);
      const currentHostMatches = (holderTaskId) => {
        const holder = configured.tasks.find((task) => task?.id === holderTaskId) ?? null;
        const currentHostIdentity = typeof getCurrentHostIdentity === "function"
          ? getCurrentHostIdentity(holder?.threadId ?? null)
          : null;
        if (!currentHostIdentity || currentHostIdentity.threadId !== holder?.threadId) return true;
        return path.isAbsolute(currentHostIdentity.workspacePath ?? "")
          && path.isAbsolute(holder.workspacePath ?? "")
          && currentHostIdentity.codexHostId === holder.codexHostId
          && path.resolve(currentHostIdentity.workspacePath ?? "") === path.resolve(holder.workspacePath ?? "")
          && (!holder.codexProjectId || currentHostIdentity.codexProjectId === holder.codexProjectId)
          && (!holder.codexProjectKind || currentHostIdentity.codexProjectKind === holder.codexProjectKind);
      };
      if (configured.coordinatorLease && !currentHostMatches(configured.coordinatorLease.holderTaskId)) {
        configured.coordinatorLease.bindingValid = false;
      }
      for (const lease of Object.values(configured.domainCoordinatorLeases ?? {})) {
        if (!currentHostMatches(lease.holderTaskId)) lease.bindingValid = false;
      }
      const generatedAt = now();
      const observedTasks = await Promise.all(configured.tasks.map((taskLane) => (
        taskLane.connection === "connected" && taskLane.source === "codex"
          ? readCodexTask(
            taskLane,
            resolveSessionFile,
            forgetSessionFile,
            generatedAt,
            taskSessionStates,
            statSessionFile,
            readSessionByteRange,
          )
          : {
              ...taskLane,
              status: "unavailable",
              freshness: "unknown",
              lastActivityAt: null,
              lastActualAction: null,
              branch: null,
              sha: null,
              checks: [],
              blocker: "Lane adapter is not connected in this phase.",
              provenance: { kind: "not-connected", threadId: null },
            }
      )));
      const taskLanes = [];
      for (const taskLane of observedTasks) {
        const workItem = await workItemFor(taskLane, getTask, listComments);
        const actionId = actionFingerprint(taskLane.lastActualAction);
        const duplicate = actionId
          ? taskLanes.find((candidate) => candidate.provenance.threadId === taskLane.provenance.threadId && candidate.actionId === actionId)
          : null;
        taskLanes.push({
          ...taskLane,
          stableIdentity: `${projectId}:task:${taskLane.id}`,
          actionId,
          duplicateOfLaneId: duplicate?.id ?? null,
          continuity: continuityFor(taskLane),
          workItem,
          nextAction: workItem?.nextAction ?? null,
        });
      }
      const adapters = configured.adapters.map((adapter) => ({
        ...adapter,
        status: "unavailable",
        freshness: "unknown",
        lastActivityAt: null,
        lastActualAction: null,
        branch: null,
        sha: null,
        checks: [],
        blocker: "Adapter is intentionally disabled in this phase.",
        stableIdentity: `${projectId}:adapter:${adapter.id}`,
        actionId: null,
        duplicateOfLaneId: null,
        continuity: { state: "adapter_off", reason: "Adapter is intentionally disabled." },
        adapterContract: disabledAdapterContract(adapter.source),
        workItem: null,
        nextAction: null,
        provenance: { kind: "not-connected", threadId: null },
      }));
      const lease = configured.coordinatorLease ? {
        id: configured.coordinatorLease.id,
        holderTaskId: configured.coordinatorLease.holderTaskId,
        bindingValid: configured.coordinatorLease.bindingValid === true,
        status: configured.coordinatorLease.bindingValid === true
          && !configured.coordinatorLease.releasedAt
          && Date.parse(configured.coordinatorLease.acquiredAt) <= generatedAt.getTime()
          && generatedAt.getTime() < Date.parse(configured.coordinatorLease.expiresAt)
          ? "active"
          : "expired",
        acquiredAt: configured.coordinatorLease.acquiredAt,
        expiresAt: configured.coordinatorLease.expiresAt,
        releasedAt: configured.coordinatorLease.releasedAt,
      } : null;
      const coordinatorTaskId = lease
        ? lease.status === "active" ? configured.coordinatorLease.holderTaskId : null
        : configured.rootTaskId;
      const allSubagentsByWindow = new Map();
      const windowSubagentTrees = [];
      for (const windowTask of configured.tasks.filter((task) => task.source === "codex")) {
        let sessionFile = await resolveSessionFile(windowTask.threadId);
        let allSubagents = [];
        let capacityObservation = null;
        let registryObservation = null;
        let recoveryComplete = false;
        if (sessionFile) {
          try {
            const state = await scanSubagents(
              sessionFile,
              subagentStates.get(sessionFile),
              statSessionFile,
              readSessionByteRange,
            );
            subagentStates.set(sessionFile, state);
            recoveryComplete = state.recoveryComplete === true;
            capacityObservation = state.registryObservedAt ? {
              source: "list_agents",
              observedAt: state.registryObservedAt,
            } : null;
            registryObservation = state.registrySnapshotObservedAt && Array.isArray(state.registryAgents) ? {
              source: "list_agents",
              observedAt: state.registrySnapshotObservedAt,
              complete: true,
              agents: state.registryAgents.map((agent) => ({ ...agent })),
            } : null;
            allSubagents = [...state.agents.values()].map((agent) => ({
              ...agent,
              label: agent.agentPath.split("/").at(-1),
              parentTaskId: windowTask.id,
              stableIdentity: `${projectId}:subagent:${agent.agentThreadId ?? agent.agentPath}`,
              provenance: { kind: "codex-collaboration-event", threadId: windowTask.threadId },
            })).sort((left, right) => (
              (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "")
            ));
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            forgetSessionFile(windowTask.threadId);
            subagentStates.delete(sessionFile);
            sessionFile = null;
          }
        }
        allSubagentsByWindow.set(windowTask.id, allSubagents);
        const subagents = allSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
        windowSubagentTrees.push({
          windowTaskId: windowTask.id,
          rootThreadId: windowTask.threadId,
          stableIdentity: `${projectId}:window:${windowTask.id}`,
          observed: Boolean(sessionFile),
          subagents,
          capacityObservation,
          registryObservation,
          summary: {
            observed: allSubagents.length,
            active: allSubagents.filter((agent) => agent.lifecycleStatus === "running").length,
            shown: subagents.length,
            complete: recoveryComplete,
          },
        });
      }
      const allRootSubagents = allSubagentsByWindow.get(coordinatorTaskId) ?? [];
      const rootSubagentTree = windowSubagentTrees.find((tree) => tree.windowTaskId === coordinatorTaskId);
      allSubagentsByProject.set(projectId, [...allSubagentsByWindow.values()].flat());
      const rootSubagents = allRootSubagents.slice(0, MAX_VISIBLE_SUBAGENTS);
      const observedSubagentCount = allRootSubagents.length;
      const currentCoordinator = taskLanes.find((lane) => lane.id === coordinatorTaskId) ?? null;
      const globalArbitrationCoordinator = lease?.status === "active"
        && currentCoordinator?.threadId
        && currentCoordinator.codexHostId
        && currentCoordinator.workspacePath
        ? currentCoordinator
        : null;
      const projectTasks = listTasks ? await listTasks(projectId) : [];
      const todoEntries = await Promise.all(projectTasks
        .filter((task) => task.archivedAt === null)
        .map(async (task) => {
          const capsule = getTaskCapsule ? await getTaskCapsule(task.id) : null;
          const domainAssignment = getTaskDomainAssignment ? await getTaskDomainAssignment(task.id) : null;
          const assignedDomain = domainAssignment
            ? configured.coordinationDomains.find((domain) => domain.id === domainAssignment.domainId)
            : null;
          const assignedLease = assignedDomain
            ? configured.domainCoordinatorLeases[assignedDomain.id] ?? null
            : null;
          const assignedHolder = assignedLease
            ? taskLanes.find((lane) => lane.id === assignedLease.holderTaskId) ?? null
            : null;
          const domainRoute = assignedDomain && assignedLease && assignedHolder
            ? {
                active: assignedLease.bindingValid === true
                  && !assignedLease.releasedAt
                  && Date.parse(assignedLease.acquiredAt) <= generatedAt.getTime()
                  && generatedAt.getTime() < Date.parse(assignedLease.expiresAt),
                lease: assignedLease,
                holder: assignedHolder,
              }
            : null;
          return {
            task,
            capsule,
            todo: await taskTodoProjection(
              task, projectId, taskLanes, getClaim, getAdmission, listComments, generatedAt, capsule,
              domainAssignment, domainRoute, globalArbitrationCoordinator,
              configured.rootTaskId === null,
            ),
          };
        }));
      const todos = todoEntries
        .filter(({ task, capsule }) => (
          capsule?.readyWork?.eligible === true
          || capsule?.readyWork?.ownerDecisionRequest !== null && capsule?.readyWork?.ownerDecisionRequest !== undefined
          || capsule?.activeRun !== null && capsule?.activeRun !== undefined
          || capsule?.latestRun !== null && capsule?.latestRun !== undefined
          || task.labels.includes("agent-todo")
        ))
        .map(({ todo }) => todo);
      const domainCoordinators = configured.coordinationDomains.map((domain) => {
        const domainLease = configured.domainCoordinatorLeases[domain.id] ?? null;
        const active = domainLease?.bindingValid === true
          && !domainLease.releasedAt
          && Date.parse(domainLease.acquiredAt) <= generatedAt.getTime()
          && generatedAt.getTime() < Date.parse(domainLease.expiresAt);
        const domainCoordinatorTaskId = active ? domainLease.holderTaskId : null;
        const domainCoordinator = taskLanes.find((lane) => lane.id === domainCoordinatorTaskId) ?? null;
        const durableWorkTaskIds = todos
          .filter((todo) => (
            todo.domainAssignment?.domainId === domain.id
            && todo.state !== "completed"
          ))
          .map((todo) => todo.id);
        return {
          domainId: domain.id,
          label: domain.label,
          writeScope: domain.writeScope,
          eligibleTaskIds: domain.eligibleTaskIds,
          coordinatorTaskId: domainCoordinatorTaskId,
          coordinatorStableIdentity: domainCoordinator?.stableIdentity ?? null,
          assignment: active ? "lease" : "unassigned",
          replaceable: true,
          durableWorkPending: durableWorkTaskIds.length > 0,
          durableWorkTaskIds,
          lease: domainLease ? {
            id: domainLease.id,
            holderTaskId: domainLease.holderTaskId,
            bindingValid: domainLease.bindingValid === true,
            status: active ? "active" : "expired",
            acquiredAt: domainLease.acquiredAt,
            expiresAt: domainLease.expiresAt,
            releasedAt: domainLease.releasedAt ?? null,
          } : null,
        };
      });
      const ownerRootTaskId = configured.ownerRootTaskId ?? coordinatorTaskId;
      const currentOwnerRoot = taskLanes.find((lane) => lane.id === ownerRootTaskId) ?? null;
      const coordinatorEpoch = lease
        ? lease.status === "active" ? `lease:${lease.id}` : null
        : `configured:${coordinatorTaskId}`;
      const decisionPriority = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
      const explicitOwnerRoute = configured.ownerRootTaskId && currentOwnerRoot?.threadId
        && currentOwnerRoot.codexHostId && currentOwnerRoot.workspacePath
        ? {
            rootTaskId: ownerRootTaskId,
            rootThreadId: currentOwnerRoot.threadId,
            codexHostId: currentOwnerRoot.codexHostId,
            rootWorkspacePath: currentOwnerRoot.workspacePath,
          }
        : null;
      const ownerDecisionRequest = coordinatorEpoch && currentOwnerRoot?.threadId
        ? todos
          .filter((todo) => (
            todo.readyWork?.approvalRequest?.requestId
            && todo.readyWork.safeActions.length === 0
            && todo.readyWork.reasonCodes.length === 1
            && todo.readyWork.reasonCodes[0] === "AUTHORIZATION_REQUIRED"
            && (explicitOwnerRoute || todo.dispatchTarget?.rootThreadId === currentCoordinator?.threadId)
          ))
          .sort((left, right) => (
            (decisionPriority[left.priority] ?? 9) - (decisionPriority[right.priority] ?? 9)
            || (left.readyWork.approvalRequest.requestedAt ?? "").localeCompare(right.readyWork.approvalRequest.requestedAt ?? "")
            || left.id.localeCompare(right.id)
            || left.readyWork.approvalRequest.actionId.localeCompare(right.readyWork.approvalRequest.actionId)
          ))
          .map((todo) => ({
            ...todo.readyWork.approvalRequest,
            taskId: todo.taskId,
            identifier: todo.id,
            priority: todo.priority,
            coordinatorEpoch,
            route: explicitOwnerRoute ?? {
              rootTaskId: coordinatorTaskId,
              rootThreadId: currentCoordinator.threadId,
              codexHostId: todo.dispatchTarget.codexHostId,
              rootWorkspacePath: todo.dispatchTarget.rootWorkspacePath,
            },
          }))[0] ?? null
        : null;
      const pendingIntent = getPendingOwnerIntent
        ? await getPendingOwnerIntent(projectId)
        : null;
      const pendingOwnerIntent = pendingIntent
        && coordinatorEpoch
        && currentCoordinator?.threadId
        && currentCoordinator.codexHostId
        && currentCoordinator.workspacePath
        ? {
            ...pendingIntent,
            projectId,
            goal: compact(pendingIntent.goal, 360),
            constraints: Array.isArray(pendingIntent.constraints)
              ? pendingIntent.constraints.map((item) => compact(item, 240)).filter(Boolean)
              : [],
            coordinatorEpoch,
            route: {
              coordinatorTaskId,
              coordinatorThreadId: currentCoordinator.threadId,
              codexHostId: currentCoordinator.codexHostId,
              coordinatorWorkspacePath: currentCoordinator.workspacePath,
            },
          }
        : null;
      const pendingPlanIntent = getPendingOwnerIntentPlan
        ? await getPendingOwnerIntentPlan(projectId)
        : null;
      const pendingOwnerIntentPlan = pendingPlanIntent
        && coordinatorEpoch
        && currentCoordinator?.threadId
        && currentCoordinator.codexHostId
        && currentCoordinator.workspacePath
        && pendingPlanIntent.adoptionReceipt?.coordinatorEpoch === coordinatorEpoch
        ? {
            ...pendingPlanIntent,
            projectId,
            goal: compact(pendingPlanIntent.goal, 360),
            constraints: Array.isArray(pendingPlanIntent.constraints)
              ? pendingPlanIntent.constraints.map((item) => compact(item, 240)).filter(Boolean)
              : [],
            route: {
              coordinatorTaskId,
              coordinatorThreadId: currentCoordinator.threadId,
              codexHostId: currentCoordinator.codexHostId,
              coordinatorWorkspacePath: currentCoordinator.workspacePath,
            },
          }
        : null;
      const pendingCrossDomainHandoff = todos
        .flatMap((todo) => (todo.dependencyClearances ?? []).map((clearance) => ({ todo, clearance })))
        .filter(({ todo, clearance }) => (
          clearance.status === "awaiting_handoff"
          && clearance.sourceStatus === "done"
          && clearance.targetReady === true
          && clearance.delivery?.state !== "delivered"
          && clearance.targetHolderThreadId === todo.dispatchTarget?.rootThreadId
          && todo.dispatchTarget?.codexHostId
          && todo.dispatchTarget?.rootWorkspacePath
        ))
        .sort((left, right) => (
          (decisionPriority[left.todo.priority] ?? 9) - (decisionPriority[right.todo.priority] ?? 9)
          || left.clearance.edgeCreatedAt.localeCompare(right.clearance.edgeCreatedAt)
          || left.clearance.sourceTaskId.localeCompare(right.clearance.sourceTaskId)
          || left.clearance.targetTaskId.localeCompare(right.clearance.targetTaskId)
        ))
        .map(({ todo, clearance }) => ({
          projectId,
          sourceTaskId: clearance.sourceTaskId,
          sourceIdentifier: clearance.sourceIdentifier,
          targetTaskId: clearance.targetTaskId,
          targetIdentifier: todo.id,
          fingerprint: clearance.fingerprint,
          sourceDomainId: clearance.sourceDomainId,
          targetDomainId: clearance.targetDomainId,
          expectedTargetDomainLeaseId: clearance.targetDomainLeaseId,
          targetHolderTaskId: clearance.targetHolderTaskId,
          route: {
            targetThreadId: clearance.targetHolderThreadId,
            codexHostId: todo.dispatchTarget.codexHostId,
            targetWorkspacePath: todo.dispatchTarget.rootWorkspacePath,
          },
        }))[0] ?? null;
      const durableWorkReason = typeof getCoordinatorDurableWorkReason === "function"
        ? await getCoordinatorDurableWorkReason(projectId)
        : null;
      const durableWorkPending = typeof getCoordinatorDurableWorkReason === "function"
        ? durableWorkReason !== null
        : typeof getCoordinatorDurableWork === "function"
          ? await getCoordinatorDurableWork(projectId)
          : true;
      const shutdownAttempt = typeof getCoordinatorShutdownAttempt === "function"
        ? await getCoordinatorShutdownAttempt(projectId)
        : null;
      return {
        version: AGENT_LANE_SNAPSHOT_VERSION,
        projectId,
        generatedAt: generatedAt.toISOString(),
        readOnly: true,
        automaticRecoveryEnabled: false,
        coordination: {
          model: lease
            ? "peer_windows_with_coordinator_lease"
            : "peer_windows_with_configured_coordinator",
          coordinatorTaskId,
          coordinatorStableIdentity: currentCoordinator?.stableIdentity ?? null,
          ownerRootTaskId,
          ownerRootStableIdentity: currentOwnerRoot?.stableIdentity ?? null,
          ownerRootRoute: explicitOwnerRoute,
          assignment: lease ? lease.status === "active" ? "lease" : "unassigned" : "configured",
          replaceable: Boolean(lease),
          scope: "project",
          ...(lease ? { lease } : {}),
          crossWindowProtocol: "task_capsule_claim_checkpoint_receipt",
          subagentAuthority: "window_root",
          stateAuthority: "self_learning_checkpoint",
          workAuthority: "todo_claim_lease",
          runtimeOwnership: "single_writer",
          domainCoordinators,
          pendingOwnerIntent,
          pendingOwnerIntentPlan,
          ownerDecisionRequest,
          pendingCrossDomainHandoff,
          durableWorkPending,
          ...(typeof getCoordinatorDurableWorkReason === "function"
            ? { durableWorkReason }
            : {}),
          shutdownAttempt,
        },
        todos,
        attentionQueue: todos
          .filter((todo) => todo.continuation.attention !== "done")
          .sort((left, right) => {
            const rank = { needs_user: 0, needs_coordinator: 1, blocked: 2, ready: 3, watch: 4 };
            return (rank[left.continuation.attention] ?? 9) - (rank[right.continuation.attention] ?? 9);
          })
          .map((todo) => todo.id),
        taskLanes,
        windowSubagentTrees,
        rootSubagents,
        adapters,
        subagentSummary: {
          observed: observedSubagentCount,
          active: rootSubagents.filter((agent) => agent.lifecycleStatus === "running").length,
          shown: rootSubagents.length,
          complete: rootSubagentTree?.summary.complete === true,
        },
      };
    },
    async reconcileProject(projectId) {
      if (!recordProgress && !recordCompletion) return { applied: 0 };
      const snapshot = await this.getProjectSnapshot(projectId);
      let applied = 0;
      const projectSubagents = allSubagentsByProject.get(projectId) ?? snapshot.rootSubagents;
      for (const agent of projectSubagents) {
        if (!agent.lastActualAction) continue;
        const claimedTodo = snapshot.todos.find((todo) => (
          todo.claimedBy === agent.agentPath
          && todo.claimedThreadId === agent.agentThreadId
          && todo.claim?.leaseState === "active"
        ));
        const claimedAtMs = Date.parse(claimedTodo?.claimedAt ?? "");
        const startedAtMs = Date.parse(agent.startedAt ?? "");
        const lastActivityAtMs = Date.parse(agent.lastActivityAt ?? "");
        if (
          agent.agentThreadId !== claimedTodo?.claimedThreadId
          || !Number.isFinite(claimedAtMs)
          || !Number.isFinite(startedAtMs)
          || startedAtMs <= claimedAtMs
          || !Number.isFinite(lastActivityAtMs)
          || lastActivityAtMs < startedAtMs
        ) {
          continue;
        }
        const event = {
          eventId: createHash("sha256").update([
            projectId,
            agent.agentThreadId ?? agent.agentPath,
            agent.lastActivityAt ?? "unknown-time",
            agent.lifecycleStatus,
            agent.lastActualAction,
          ].join(":")).digest("hex"),
          projectId,
          agentPath: agent.agentPath,
          agentThreadId: agent.agentThreadId,
          summary: completionSummary(agent.lastActualAction),
        };
        const result = agent.lifecycleStatus === "completed"
          ? await recordCompletion?.(event)
          : await recordProgress?.(event);
        if (result?.applied) applied += 1;
      }
      return { applied };
    },
  };
  const buildProjectSnapshot = provider.getProjectSnapshot.bind(provider);
  provider.getProjectSnapshot = async (projectId) => {
    const active = projectSnapshotInFlight.get(projectId);
    if (active) return active;
    const pending = buildProjectSnapshot(projectId);
    projectSnapshotInFlight.set(projectId, pending);
    try {
      return await pending;
    } finally {
      if (projectSnapshotInFlight.get(projectId) === pending) {
        projectSnapshotInFlight.delete(projectId);
      }
    }
  };
  return provider;
}
