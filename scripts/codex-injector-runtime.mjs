import { createHash } from "node:crypto";
import path from "node:path";

const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";
const coordinationDeliveries = new Map();
const COORDINATION_DEDUPLICATION_MS = 60_000;
const continuationMonitorRuns = new Map();
const ownerDecisionMonitorRuns = new Map();
const ownerIntentCaptureMonitorRuns = new Map();
const ownerIntentAdoptionMonitorRuns = new Map();
const ownerIntentPlanningMonitorRuns = new Map();
const crossDomainHandoffMonitorRuns = new Map();
const coordinatorLeaseKeepaliveMonitorRuns = new Map();
const coordinatorLeaseRecoveryMonitorRuns = new Map();
const coordinatorProvisioningMonitorRuns = new Map();
const coordinatorShutdownMonitorRuns = new Map();
const coordinatorShutdownIdleObservations = new Map();
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORDINATION_ID_PATTERN = /^[a-z0-9._-]{1,128}$/i;
const RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_DECISION_MARKER = "TASKBOARD_OWNER_DECISION_V1";
const OWNER_INTENT_ADOPTION_MARKER = "Taskboard Owner Intent adoption id:";
const OWNER_INTENT_ROUTE_MARKER = "TASKBOARD_OWNER_INTENT_ROUTE_V1";
const OWNER_INTENT_PLAN_MARKER = "TASKBOARD_OWNER_INTENT_PLAN_V1";
const CROSS_DOMAIN_HANDOFF_MARKER = "Taskboard cross-domain handoff delivery id:";
const SENSITIVE_COORDINATION_TEXT = /-----BEGIN [^-]+-----|\bAKIA[A-Z0-9]{16}\b|https?:\/\/[^\s/:@]+:[^\s/@]+@|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/i;
const SELECTED_MODEL_CAPACITY_ERROR = /selected model is at capacity\.\s*please try a different model\.?/i;

export function createSerializedMonitorTick(run) {
  let inFlight = false;
  return async (...args) => {
    if (inFlight) return false;
    inFlight = true;
    try {
      await run(...args);
      return true;
    } finally {
      inFlight = false;
    }
  };
}

const ACTIVE_COORDINATOR_THREAD_STATUSES = new Set(["active", "running", "busy", "inProgress"]);
const NON_RUNNING_COORDINATOR_THREAD_STATUSES = new Set(["notLoaded", "idle", "archived"]);

export function classifyCoordinatorProvisioningActiveThread({ window, thread, activeThreads }) {
  if (!Array.isArray(activeThreads)) {
    return { eligibility: "uncertain", reason: "active-thread-list-invalid", window };
  }
  if (activeThreads.length > 1) {
    return { eligibility: "uncertain", reason: "duplicate-active-thread", window };
  }
  const listedThread = activeThreads[0] ?? null;
  if (listedThread && listedThread?.id !== window?.threadId) {
    return { eligibility: "uncertain", reason: "active-thread-binding-unconfirmed", window };
  }
  if (thread?.id !== window?.threadId) {
    return listedThread
      ? { eligibility: "uncertain", reason: "active-thread-binding-unconfirmed", window }
      : null;
  }
  if (!Array.isArray(thread.turns)) {
    return { eligibility: "uncertain", reason: "thread-state-unconfirmed", window };
  }
  if (thread.turns.some((turn) => turn?.status === "inProgress")) {
    return { eligibility: "eligible", busy: true, reason: "active-turn", window };
  }
  const exact = thread?.id === window?.threadId
    && typeof thread.cwd === "string"
    && path.resolve(thread.cwd) === path.resolve(window?.workspacePath ?? "");
  if (exact) return { eligibility: "eligible", busy: false, reason: "active-thread", window };
  const status = typeof thread.status === "string"
    ? thread.status
    : thread.status?.type;
  if (ACTIVE_COORDINATOR_THREAD_STATUSES.has(status)) {
    return { eligibility: "uncertain", reason: "thread-status-active", window };
  }
  if (!NON_RUNNING_COORDINATOR_THREAD_STATUSES.has(status)) {
    return { eligibility: "uncertain", reason: "thread-status-unconfirmed", window };
  }
  if (typeof thread.cwd === "string"
    && path.isAbsolute(thread.cwd)
    && typeof window?.workspacePath === "string"
    && path.isAbsolute(window.workspacePath)
    && path.resolve(thread.cwd) !== path.resolve(window.workspacePath)) {
    return {
      eligibility: "stale",
      reason: listedThread
        ? "active-thread-binding-drift"
        : "inactive-thread-binding-drift",
      window,
    };
  }
  return { eligibility: "uncertain", reason: "active-thread-binding-unconfirmed", window };
}

const COORDINATOR_INSPECTION_DIAGNOSTIC_REASONS = new Set([
  "active-thread-binding-drift",
  "active-thread-binding-unconfirmed",
  "active-thread-list-invalid",
  "active-turn",
  "archived",
  "binding-invalid",
  "duplicate-active-thread",
  "duplicate-archived-thread",
  "host-unavailable",
  "inactive-thread-binding-drift",
  "inspection-binding-mismatch",
  "inspection-threw",
  "thread-state-unconfirmed",
  "thread-status-active",
  "thread-status-unconfirmed",
]);

export function coordinatorProvisioningInspectionDiagnosticReason(value) {
  return COORDINATOR_INSPECTION_DIAGNOSTIC_REASONS.has(value) ? value : "unknown";
}

export function coordinatorProvisioningThreadListData(result) {
  if (!Array.isArray(result?.data)) {
    throw new Error("Codex did not return one exact thread list array");
  }
  return result.data;
}

const COORDINATOR_PROVISIONING_THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];
const COORDINATOR_PROVISIONING_MISSING_THREAD_GRACE_MS = 60_000;

export function coordinatorProvisioningThreadListParams(attempt, archived, cursor = null) {
  return {
    cwd: attempt.workspacePath,
    archived,
    limit: 100,
    sourceKinds: [...COORDINATOR_PROVISIONING_THREAD_SOURCE_KINDS],
    ...(cursor ? { cursor } : {}),
  };
}

export function selectCoordinatorProvisioningThread(attempt, threads) {
  const candidates = coordinatorProvisioningThreadListData({ data: threads }).filter((thread) => (
    thread?.threadSource === attempt.threadSource
    && typeof thread.cwd === "string"
    && path.resolve(thread.cwd) === path.resolve(attempt.workspacePath)
  ));
  if (attempt.threadId) {
    const exact = candidates.filter((thread) => thread?.id === attempt.threadId);
    const conflicting = candidates.filter((thread) => thread?.id !== attempt.threadId);
    if (exact.length > 1 || conflicting.length > 0) {
      throw new Error("Codex returned conflicting threads for one Coordinator provisioning attempt");
    }
    return exact[0] ?? null;
  }
  if (candidates.length > 1) {
    throw new Error("Codex returned duplicate threads for one Coordinator provisioning marker");
  }
  return candidates[0] ?? null;
}

export async function findCoordinatorProvisioningThreadAcrossPages({
  attempt, archived = false, listPage, maxPages = 10,
}) {
  let cursor = null;
  const threads = [];
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listPage(coordinatorProvisioningThreadListParams(
      attempt, archived, cursor,
    ));
    threads.push(...coordinatorProvisioningThreadListData(result));
    cursor = typeof result?.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : null;
    if (!cursor) return selectCoordinatorProvisioningThread(attempt, threads);
  }
  throw new Error("Codex thread list pagination was not exhausted");
}

export function selectResidentCoordinatorMonitorProjects({
  lifecycleProjectIds,
  continuationPolicyEntries,
  continuationPolicyPrefix = "taskboard:background-continuation:policy:",
}) {
  const projects = new Map();
  for (const projectId of Array.isArray(lifecycleProjectIds) ? lifecycleProjectIds : []) {
    if (COORDINATION_ID_PATTERN.test(projectId ?? "")) {
      projects.set(projectId, { projectId, continuationEnabled: false });
    }
  }
  for (const [key, value] of Object.entries(continuationPolicyEntries ?? {})) {
    if (!key.startsWith(continuationPolicyPrefix) || value !== "enabled") continue;
    const projectId = key.slice(continuationPolicyPrefix.length);
    if (!COORDINATION_ID_PATTERN.test(projectId)) continue;
    projects.set(projectId, { projectId, continuationEnabled: true });
  }
  return [...projects.values()].sort((left, right) => left.projectId.localeCompare(right.projectId));
}

export async function loadResidentCoordinatorMonitorProjects({
  listLifecycleProjects,
  readContinuationPolicyEntries,
  continuationPolicyPrefix,
}) {
  const lifecycleProjectIds = await listLifecycleProjects();
  let continuationPolicyEntries = {};
  try {
    continuationPolicyEntries = await readContinuationPolicyEntries();
  } catch {}
  return selectResidentCoordinatorMonitorProjects({
    lifecycleProjectIds,
    continuationPolicyEntries,
    continuationPolicyPrefix,
  });
}

function coordinatorProvisioningIdentity(projectId, revision, ownerRootTaskId) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ projectId, revision, ownerRootTaskId }))
    .digest("hex");
  return {
    taskId: `coordinator-${projectId}-${fingerprint.slice(0, 12)}`,
    label: "Taskboard Execution Coordinator",
    idempotencyKey: `coordinator-provision-${fingerprint}`,
    threadSource: `taskboard-coordinator-provision-${fingerprint}`,
  };
}

function coordinatorShutdownIdentity(projectId, lease, lane, ownerLane) {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    projectId,
    leaseId: lease.id,
    holderTaskId: lease.holderTaskId,
    holderThreadId: lane.threadId,
    codexProjectId: lane.codexProjectId,
    codexProjectKind: lane.codexProjectKind,
    codexHostId: lane.codexHostId,
    workspacePath: path.resolve(lane.workspacePath),
    ownerRootTaskId: ownerLane.id,
    ownerRootThreadId: ownerLane.threadId,
    ownerRootCodexProjectId: ownerLane.codexProjectId,
    ownerRootCodexProjectKind: ownerLane.codexProjectKind,
    ownerRootCodexHostId: ownerLane.codexHostId,
    ownerRootWorkspacePath: path.resolve(ownerLane.workspacePath),
  })).digest("hex");
  return {
    idempotencyKey: `coordinator-shutdown-${fingerprint}`,
    fingerprint,
  };
}

async function continueCoordinatorShutdownAttempt(options, attempt) {
  if (!attempt?.id) return { shutdown: false, reason: "attempt-unavailable" };
  if (attempt.status === "completed") {
    return { shutdown: true, reason: "completed", attemptId: attempt.id };
  }
  if (attempt.status === "canceled") {
    return { shutdown: false, reason: "attempt-canceled", attemptId: attempt.id };
  }
  if (attempt.status === "pending") {
    try {
      const released = await options.releaseAttempt({ attemptId: attempt.id });
      attempt = released?.attempt ?? attempt;
    } catch {
      return { shutdown: false, reason: "release-unavailable", attemptId: attempt.id };
    }
  }
  if (attempt.status !== "released") {
    return { shutdown: false, reason: "attempt-state-unavailable", attemptId: attempt.id };
  }
  let archivedThread = null;
  try {
    archivedThread = await options.findArchivedThread(attempt);
  } catch {
    return { shutdown: false, reason: "archive-observation-unavailable", attemptId: attempt.id };
  }
  if (!archivedThread) {
    let thread;
    try {
      thread = (await options.readThread({
        threadId: attempt.holderThreadId,
        codexHostId: attempt.codexHostId,
      }))?.thread;
    } catch {
      return { shutdown: false, reason: "thread-unavailable", attemptId: attempt.id };
    }
    if (thread?.id !== attempt.holderThreadId
      || typeof thread.cwd !== "string"
      || path.resolve(thread.cwd) !== path.resolve(attempt.workspacePath)
      || !Array.isArray(thread.turns)
      || thread.turns.some((turn) => turn?.status === "inProgress")) {
      return { shutdown: false, reason: "thread-busy-or-drifted", attemptId: attempt.id };
    }
    try {
      await options.archiveThread({
        threadId: attempt.holderThreadId,
        codexHostId: attempt.codexHostId,
        workspacePath: attempt.workspacePath,
      });
    } catch {
      return { shutdown: false, reason: "archive-uncertain", attemptId: attempt.id };
    }
  } else if (archivedThread.id !== attempt.holderThreadId
    || typeof archivedThread.cwd !== "string"
    || path.resolve(archivedThread.cwd) !== path.resolve(attempt.workspacePath)) {
    return { shutdown: false, reason: "archived-thread-drifted", attemptId: attempt.id };
  }
  try {
    const completed = await options.completeAttempt({ attemptId: attempt.id });
    return completed?.attempt?.status === "completed"
      ? { shutdown: true, reason: "completed", attemptId: attempt.id }
      : { shutdown: false, reason: "completion-unavailable", attemptId: attempt.id };
  } catch {
    return { shutdown: false, reason: "completion-unavailable", attemptId: attempt.id };
  }
}

async function runCoordinatorShutdownMonitorOnceUnlocked(options) {
  const { policy } = options;
  const existing = (await options.getAttempt({ projectId: policy.projectId }))?.attempt ?? null;
  if (existing && existing.status !== "completed" && existing.status !== "canceled") {
    coordinatorShutdownIdleObservations.delete(policy.projectId);
    return continueCoordinatorShutdownAttempt(options, existing);
  }
  const [snapshot, windows] = await Promise.all([
    options.readSnapshot(policy.projectId),
    options.readWindows(policy.projectId),
  ]);
  const coordination = snapshot?.coordination;
  const lease = coordination?.lease;
  const holderTaskId = lease?.holderTaskId;
  const lane = Array.isArray(snapshot?.taskLanes)
    ? snapshot.taskLanes.find((candidate) => candidate?.id === holderTaskId) ?? null
    : null;
  const ownerRootTaskId = coordination?.ownerRootTaskId;
  const ownerLane = Array.isArray(snapshot?.taskLanes)
    ? snapshot.taskLanes.find((candidate) => candidate?.id === ownerRootTaskId) ?? null
    : null;
  const ownerWindow = Array.isArray(windows?.windows)
    ? windows.windows.find((window) => window?.taskId === ownerRootTaskId) ?? null
    : null;
  const holderWindow = Array.isArray(windows?.windows)
    ? windows.windows.find((window) => window?.taskId === holderTaskId) ?? null
    : null;
  const exact = snapshot?.projectId === policy.projectId
    && windows?.projectId === policy.projectId
    && RESUME_TOKEN_PATTERN.test(windows?.revision ?? "")
    && coordination?.assignment === "lease"
    && coordination?.durableWorkPending === false
    && lease?.status === "active"
    && lease?.bindingValid === true
    && !lease.releasedAt
    && COORDINATION_ID_PATTERN.test(lease?.id ?? "")
    && COORDINATION_ID_PATTERN.test(holderTaskId ?? "")
    && holderTaskId !== ownerRootTaskId
    && THREAD_ID_PATTERN.test(lane?.threadId ?? "")
    && COORDINATION_ID_PATTERN.test(lane?.codexHostId ?? "")
    && typeof lane?.workspacePath === "string"
    && path.isAbsolute(lane.workspacePath)
    && holderWindow?.role === "coordinator"
    && holderWindow.threadId === lane.threadId
    && holderWindow.codexProjectId === lane.codexProjectId
    && holderWindow.codexProjectKind === lane.codexProjectKind
    && holderWindow.codexHostId === lane.codexHostId
    && path.resolve(holderWindow.workspacePath ?? "") === path.resolve(lane.workspacePath)
    && ownerWindow?.role === "owner_root"
    && THREAD_ID_PATTERN.test(ownerLane?.threadId ?? "")
    && COORDINATION_ID_PATTERN.test(ownerLane?.codexHostId ?? "")
    && typeof ownerLane?.workspacePath === "string"
    && path.isAbsolute(ownerLane.workspacePath)
    && ownerWindow.threadId === ownerLane.threadId
    && ownerWindow.codexProjectId === ownerLane.codexProjectId
    && ownerWindow.codexProjectKind === ownerLane.codexProjectKind
    && ownerWindow.codexHostId === ownerLane.codexHostId
    && path.resolve(ownerWindow.workspacePath ?? "") === path.resolve(ownerLane.workspacePath)
    && coordination?.ownerRootRoute?.rootThreadId === ownerLane.threadId
    && coordination.ownerRootRoute.codexHostId === ownerLane.codexHostId
    && path.resolve(coordination.ownerRootRoute.rootWorkspacePath ?? "")
      === path.resolve(ownerLane.workspacePath);
  if (!exact) {
    coordinatorShutdownIdleObservations.delete(policy.projectId);
    return { shutdown: false, reason: "not-idle-or-binding-drift" };
  }
  let thread;
  try {
    thread = (await options.readThread({
      threadId: lane.threadId,
      codexHostId: lane.codexHostId,
    }))?.thread;
  } catch {
    coordinatorShutdownIdleObservations.delete(policy.projectId);
    return { shutdown: false, reason: "thread-unavailable" };
  }
  if (thread?.id !== lane.threadId
    || typeof thread.cwd !== "string"
    || path.resolve(thread.cwd) !== path.resolve(lane.workspacePath)
    || !Array.isArray(thread.turns)
    || thread.turns.some((turn) => turn?.status === "inProgress")) {
    coordinatorShutdownIdleObservations.delete(policy.projectId);
    return { shutdown: false, reason: "thread-busy-or-drifted" };
  }
  const identity = coordinatorShutdownIdentity(policy.projectId, lease, lane, ownerLane);
  const observedAt = options.now();
  const observation = coordinatorShutdownIdleObservations.get(policy.projectId);
  if (!observation || observation.fingerprint !== identity.fingerprint) {
    coordinatorShutdownIdleObservations.set(policy.projectId, {
      fingerprint: identity.fingerprint,
      firstObservedAt: observedAt,
    });
    return { shutdown: false, reason: "idle-grace" };
  }
  if (observedAt - observation.firstObservedAt < policy.idleGraceMs) {
    return { shutdown: false, reason: "idle-grace" };
  }
  let attempt;
  try {
    attempt = (await options.requestAttempt({
      projectId: policy.projectId,
      idempotencyKey: identity.idempotencyKey,
      expectedRevision: windows.revision,
      expectedLeaseId: lease.id,
      holderTaskId,
      holderThreadId: lane.threadId,
      ownerRootTaskId,
      ownerRootThreadId: ownerLane.threadId,
      ownerRootCodexProjectId: ownerLane.codexProjectId,
      ownerRootCodexProjectKind: ownerLane.codexProjectKind,
      ownerRootCodexHostId: ownerLane.codexHostId,
      ownerRootWorkspacePath: ownerLane.workspacePath,
      codexProjectId: lane.codexProjectId,
      codexProjectKind: lane.codexProjectKind,
      codexHostId: lane.codexHostId,
      workspacePath: lane.workspacePath,
    }))?.attempt ?? null;
  } catch {
    return { shutdown: false, reason: "attempt-unavailable" };
  }
  coordinatorShutdownIdleObservations.delete(policy.projectId);
  return continueCoordinatorShutdownAttempt(options, attempt);
}

export async function runCoordinatorShutdownMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { shutdown: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy.projectId ?? "")
    || !Number.isSafeInteger(policy.idleGraceMs)
    || policy.idleGraceMs < 1
    || policy.idleGraceMs > 60 * 60_000
    || typeof options?.now !== "function"
    || typeof options?.readSnapshot !== "function"
    || typeof options?.readWindows !== "function"
    || typeof options?.readThread !== "function"
    || typeof options?.getAttempt !== "function"
    || typeof options?.requestAttempt !== "function"
    || typeof options?.releaseAttempt !== "function"
    || typeof options?.findArchivedThread !== "function"
    || typeof options?.archiveThread !== "function"
    || typeof options?.completeAttempt !== "function") {
    return { shutdown: false, reason: "invalid-monitor" };
  }
  const current = coordinatorShutdownMonitorRuns.get(policy.projectId);
  if (current) return current;
  const run = runCoordinatorShutdownMonitorOnceUnlocked(options);
  coordinatorShutdownMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (coordinatorShutdownMonitorRuns.get(policy.projectId) === run) {
      coordinatorShutdownMonitorRuns.delete(policy.projectId);
    }
  }
}

async function runCoordinatorProvisioningMonitorOnceUnlocked(options) {
  const { policy } = options;
  let snapshot;
  let windows;
  if (typeof options.readPreflight === "function") {
    const preflight = await options.readPreflight();
    windows = preflight;
    const ownerRootTaskId = preflight?.ownerRootTaskId;
    const ownerWindow = Array.isArray(preflight?.windows)
      ? preflight.windows.find((window) => window?.taskId === ownerRootTaskId) ?? null
      : null;
    const lease = preflight?.coordinatorLease ?? null;
    snapshot = {
      projectId: preflight?.projectId,
      coordination: {
        assignment: lease && !lease.releasedAt ? "lease" : "unassigned",
        durableWorkPending: preflight?.durableWorkPending,
        ownerRootTaskId,
        ownerRootRoute: ownerWindow ? {
          rootTaskId: ownerRootTaskId,
          rootThreadId: ownerWindow.threadId,
          codexHostId: ownerWindow.codexHostId,
          rootWorkspacePath: ownerWindow.workspacePath,
        } : null,
        lease: lease ? {
          ...lease,
          status: lease.releasedAt ? "expired" : "active",
          bindingValid: false,
        } : null,
        shutdownAttempt: preflight?.shutdownAttempt ?? null,
        ownerRootValid: preflight?.ownerRootValid === true,
      },
      taskLanes: ownerWindow ? [{ id: ownerRootTaskId, ...ownerWindow }] : [],
    };
  } else {
    [snapshot, windows] = await Promise.all([
      options.readSnapshot(),
      options.readWindows(),
    ]);
  }
  if (snapshot?.projectId !== policy.projectId
    || windows?.projectId !== policy.projectId
    || !RESUME_TOKEN_PATTERN.test(windows?.revision ?? "")) {
    return { provisioned: false, reason: "invalid-project-state" };
  }
  if (snapshot?.coordination?.durableWorkPending !== true) {
    return { provisioned: false, reason: "no-eligible-work" };
  }
  if (snapshot?.coordination?.shutdownAttempt) {
    return { provisioned: false, reason: "coordinator-shutdown-in-progress" };
  }
  const ownerRootTaskId = snapshot?.coordination?.ownerRootTaskId;
  const ownerRoute = snapshot?.coordination?.ownerRootRoute;
  const ownerLane = Array.isArray(snapshot?.taskLanes)
    ? snapshot.taskLanes.find((lane) => lane?.id === ownerRootTaskId) ?? null
    : null;
  const ownerWindow = Array.isArray(windows?.windows)
    ? windows.windows.find((window) => window?.taskId === ownerRootTaskId) ?? null
    : null;
  const ownerBindingValid = COORDINATION_ID_PATTERN.test(ownerRootTaskId ?? "")
    && snapshot?.coordination?.ownerRootValid !== false
    && windows.ownerRootTaskId === ownerRootTaskId
    && ownerRoute?.rootTaskId === ownerRootTaskId
    && THREAD_ID_PATTERN.test(ownerRoute?.rootThreadId ?? "")
    && ownerRoute.rootThreadId === ownerLane?.threadId
    && ownerRoute.rootThreadId === ownerWindow?.threadId
    && ownerWindow?.role === "owner_root"
    && ownerLane?.codexProjectId === ownerWindow?.codexProjectId
    && ownerLane?.codexProjectKind === ownerWindow?.codexProjectKind
    && ownerLane?.codexHostId === ownerRoute?.codexHostId
    && ownerLane?.codexHostId === ownerWindow?.codexHostId
    && path.isAbsolute(ownerRoute?.rootWorkspacePath ?? "")
    && path.resolve(ownerRoute.rootWorkspacePath) === path.resolve(ownerLane?.workspacePath ?? "")
    && path.resolve(ownerRoute.rootWorkspacePath) === path.resolve(ownerWindow?.workspacePath ?? "");
  if (!ownerBindingValid) return { provisioned: false, reason: "owner-root-invalid" };
  if (snapshot?.coordination?.assignment !== "unassigned") {
    return { provisioned: false, reason: "coordinator-assigned" };
  }
  const lease = snapshot?.coordination?.lease;
  if (lease?.status === "active") return { provisioned: false, reason: "coordinator-active" };
  if (lease?.status === "expired" && lease.bindingValid === true && !lease.releasedAt) {
    return { provisioned: false, reason: "same-holder-recoverable" };
  }
  const coordinatorWindows = windows.windows.filter((window) => window?.role === "coordinator");
  const retireCoordinatorWindows = [];
  for (const window of coordinatorWindows) {
    if (typeof options.inspectCoordinatorWindow !== "function") {
      return { provisioned: false, reason: "coordinator-window-exists" };
    }
    let inspection;
    try {
      inspection = await options.inspectCoordinatorWindow(window);
    } catch {
      return {
        provisioned: false,
        reason: "window-inspection-unavailable",
        inspectionReason: "inspection-threw",
      };
    }
    if (inspection?.eligibility === "eligible" || inspection?.busy === true) {
      return { provisioned: false, reason: "coordinator-window-exists" };
    }
    if (inspection?.eligibility !== "stale") {
      return {
        provisioned: false,
        reason: "window-inspection-unavailable",
        inspectionReason: coordinatorProvisioningInspectionDiagnosticReason(inspection?.reason),
      };
    }
    if (inspection?.window?.taskId !== window.taskId
      || inspection.window.label !== window.label
      || inspection.window.role !== "coordinator"
      || inspection.window.threadId !== window.threadId
      || inspection.window.codexProjectId !== window.codexProjectId
      || inspection.window.codexProjectKind !== window.codexProjectKind
      || inspection.window.codexHostId !== window.codexHostId
      || path.resolve(inspection.window.workspacePath ?? "")
        !== path.resolve(window.workspacePath ?? "")) {
      return {
        provisioned: false,
        reason: "window-inspection-unavailable",
        inspectionReason: "inspection-binding-mismatch",
      };
    }
    retireCoordinatorWindows.push(window);
  }

  const identity = coordinatorProvisioningIdentity(
    policy.projectId, windows.revision, ownerRootTaskId,
  );
  let result = typeof options.getAttempt === "function"
    ? await options.getAttempt({
        projectId: policy.projectId,
        idempotencyKey: identity.idempotencyKey,
      })
    : null;
  let attempt = result?.attempt ?? null;
  let recoveredActiveAttempt = false;
  if (!attempt && typeof options.getAttempt === "function") {
    result = await options.getAttempt({ projectId: policy.projectId });
    attempt = result?.attempt ?? null;
    recoveredActiveAttempt = Boolean(attempt);
  }
  if (!attempt) {
    let selectedModel = {
      model: policy.model,
      reasoningEffort: policy.reasoningEffort,
    };
    if ((!selectedModel.model || !selectedModel.reasoningEffort)
      && typeof options.readDefaultModel === "function") {
      selectedModel = await options.readDefaultModel({
        codexHostId: ownerLane.codexHostId,
        workspacePath: ownerRoute.rootWorkspacePath,
      });
    }
    if (typeof selectedModel?.model !== "string" || !selectedModel.model
      || typeof selectedModel?.reasoningEffort !== "string" || !selectedModel.reasoningEffort) {
      return { provisioned: false, reason: "model-policy-unavailable" };
    }
    result = await options.requestAttempt({
      ...identity,
      model: selectedModel.model,
      reasoningEffort: selectedModel.reasoningEffort,
      projectId: policy.projectId,
      expectedRevision: windows.revision,
      ownerRootTaskId,
      ownerRootThreadId: ownerRoute.rootThreadId,
      codexProjectId: ownerLane.codexProjectId,
      codexProjectKind: ownerLane.codexProjectKind,
      codexHostId: ownerLane.codexHostId,
      workspacePath: ownerRoute.rootWorkspacePath,
      retireCoordinatorWindows,
    });
    attempt = result?.attempt ?? null;
  }
  if (!attempt?.id) return { provisioned: false, reason: "attempt-unavailable" };
  const stableAttemptBindingMismatch = attempt.projectId !== policy.projectId
    || attempt.label !== "Taskboard Execution Coordinator"
    || attempt.ownerRootTaskId !== ownerRootTaskId
    || attempt.ownerRootThreadId !== ownerRoute.rootThreadId
    || attempt.codexProjectId !== ownerLane.codexProjectId
    || attempt.codexProjectKind !== ownerLane.codexProjectKind
    || attempt.codexHostId !== ownerLane.codexHostId
    || path.resolve(attempt.workspacePath ?? "") !== path.resolve(ownerRoute.rootWorkspacePath)
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.reasoningEffort !== "string" || !attempt.reasoningEffort
    || (typeof policy.model === "string" && policy.model && attempt.model !== policy.model)
    || (typeof policy.reasoningEffort === "string" && policy.reasoningEffort
      && attempt.reasoningEffort !== policy.reasoningEffort);
  const safeRecoveredRevisionDrift = recoveredActiveAttempt
    && retireCoordinatorWindows.length === 0
    && !stableAttemptBindingMismatch
    && attempt.expectedRevision !== windows.revision;
  if (safeRecoveredRevisionDrift && typeof options.rebindAttempt === "function") {
    result = await options.rebindAttempt({
      attemptId: attempt.id,
      expectedRevision: windows.revision,
    });
    attempt = result?.attempt ?? attempt;
  }
  if (stableAttemptBindingMismatch
    || attempt.projectId !== policy.projectId
    || (!recoveredActiveAttempt && attempt.idempotencyKey !== identity.idempotencyKey)
    || (!recoveredActiveAttempt && attempt.taskId !== identity.taskId)
    || (!recoveredActiveAttempt && attempt.threadSource !== identity.threadSource)
    || (retireCoordinatorWindows.length === 0 && attempt.expectedRevision !== windows.revision)
    || attempt.ownerRootTaskId !== ownerRootTaskId
    || attempt.ownerRootThreadId !== ownerRoute.rootThreadId
    || attempt.codexProjectId !== ownerLane.codexProjectId
    || attempt.codexProjectKind !== ownerLane.codexProjectKind
    || attempt.codexHostId !== ownerLane.codexHostId
    || path.resolve(attempt.workspacePath ?? "") !== path.resolve(ownerRoute.rootWorkspacePath)
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.reasoningEffort !== "string" || !attempt.reasoningEffort) {
    return { provisioned: false, reason: "attempt-binding-mismatch", attemptId: attempt.id };
  }
  if (["completed", "canceled", "expired"].includes(attempt.status)) {
    return { provisioned: attempt.status === "completed", reason: `attempt-${attempt.status}`, attemptId: attempt.id };
  }

  let thread = await options.findThread(attempt);
  if (!thread && attempt.status === "started") {
    if (typeof options.findArchivedThread === "function") {
      await options.findArchivedThread(attempt);
    }
    if (typeof options.observeMissingAttempt !== "function") {
      return { provisioned: false, reason: "started-thread-missing", attemptId: attempt.id };
    }
    const observed = await options.observeMissingAttempt({ attemptId: attempt.id });
    attempt = observed?.attempt ?? attempt;
    const missingSince = Date.parse(attempt.missingSince ?? "");
    const currentTime = typeof options.now === "function" ? options.now() : Date.now();
    if (!Number.isFinite(missingSince)
      || currentTime - missingSince < COORDINATOR_PROVISIONING_MISSING_THREAD_GRACE_MS
      || typeof options.resetMissingAttempt !== "function") {
      return { provisioned: false, reason: "started-thread-missing", attemptId: attempt.id };
    }
    const reset = await options.resetMissingAttempt({ attemptId: attempt.id });
    const resetAttempt = reset?.attempt ?? null;
    if (resetAttempt?.id !== attempt.id
      || resetAttempt.status !== "pending"
      || resetAttempt.threadId !== null) {
      return { provisioned: false, reason: "attempt-binding-mismatch", attemptId: attempt.id };
    }
    return { provisioned: false, reason: "missing-thread-reset", attemptId: attempt.id };
  }
  if (!thread && attempt.status === "starting") {
    return { provisioned: false, reason: "thread-start-uncertain", attemptId: attempt.id };
  }
  if (!thread) {
    result = await options.markStarting({ attemptId: attempt.id });
    attempt = result?.attempt ?? attempt;
    try {
      const started = await options.startThread({
        codexHostId: attempt.codexHostId,
        cwd: attempt.workspacePath,
        runtimeWorkspaceRoots: [attempt.workspacePath],
        model: attempt.model,
        config: { model_reasoning_effort: attempt.reasoningEffort },
        approvalPolicy: "never",
        sandbox: "workspace-write",
        threadSource: attempt.threadSource,
      });
      thread = started?.thread ?? null;
    } catch (error) {
      if (isSelectedModelCapacityError(error) && typeof options.resetAttempt === "function") {
        await options.resetAttempt({ attemptId: attempt.id });
        return { provisioned: false, reason: "model-capacity", attemptId: attempt.id };
      }
      return { provisioned: false, reason: "thread-start-uncertain", attemptId: attempt.id };
    }
  }
  if (!THREAD_ID_PATTERN.test(thread?.id ?? "")
    || thread.threadSource !== attempt.threadSource
    || path.resolve(thread?.cwd ?? "") !== path.resolve(attempt.workspacePath)) {
    return { provisioned: false, reason: "thread-binding-mismatch", attemptId: attempt.id };
  }
  if (attempt.status === "started" && attempt.missingSince) {
    if (typeof options.clearMissingAttempt !== "function") {
      return { provisioned: false, reason: "started-thread-missing", attemptId: attempt.id };
    }
    const cleared = await options.clearMissingAttempt({ attemptId: attempt.id });
    attempt = cleared?.attempt ?? attempt;
    if (attempt.missingSince) {
      return { provisioned: false, reason: "attempt-binding-mismatch", attemptId: attempt.id };
    }
  }
  if (attempt.threadId !== thread.id || attempt.status !== "started") {
    result = await options.attachThread({ attemptId: attempt.id, threadId: thread.id });
    attempt = result?.attempt ?? attempt;
  }
  const delivery = await options.deliverInstruction({
    attempt,
    threadId: thread.id,
    projectId: policy.projectId,
  });
  return {
    provisioned: true,
    reason: delivery?.delivery === "observed" ? "thread-observed" : "thread-started",
    attemptId: attempt.id,
  };
}

export async function runCoordinatorProvisioningMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { provisioned: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || (typeof options?.readPreflight !== "function"
      && (typeof options?.readSnapshot !== "function" || typeof options?.readWindows !== "function"))
    || typeof options?.requestAttempt !== "function"
    || typeof options?.findThread !== "function"
    || typeof options?.markStarting !== "function"
    || typeof options?.startThread !== "function"
    || typeof options?.attachThread !== "function"
    || typeof options?.deliverInstruction !== "function") {
    return { provisioned: false, reason: "invalid-monitor" };
  }
  const existing = coordinatorProvisioningMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runCoordinatorProvisioningMonitorOnceUnlocked(options);
  coordinatorProvisioningMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (coordinatorProvisioningMonitorRuns.get(policy.projectId) === run) {
      coordinatorProvisioningMonitorRuns.delete(policy.projectId);
    }
  }
}

function projectScopedCoordinationKey(projectId) {
  if (!COORDINATION_ID_PATTERN.test(projectId ?? "")) {
    throw new Error("Owner Intent capture requires an exact Taskboard project id");
  }
  const prefix = projectId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 48);
  const digest = createHash("sha256").update(projectId).digest("hex").slice(0, 8);
  return `${prefix}-${digest}`;
}

export function classifyOwnerIntentPlanHttpFailure(status, errorCode = null) {
  if (status === 400
    || (status === 409 && errorCode === "OWNER_DECISION_CLASSIFICATION_REQUIRED")) {
    return "invalid-plan";
  }
  if (status === 409) return "stale-plan";
  return null;
}

function isSelectedModelCapacityError(error) {
  return SELECTED_MODEL_CAPACITY_ERROR.test(
    typeof error?.message === "string" ? error.message : String(error ?? ""),
  );
}

function collectStringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStringValues(entry, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectStringValues(entry, output));
  }
  return output;
}

function normalizedMessageRole(value) {
  const role = typeof value?.role === "string" ? value.role.toLowerCase() : "";
  const type = typeof value?.type === "string"
    ? value.type.toLowerCase().replaceAll(/[^a-z]/g, "")
    : "";
  if (role === "user" || type.includes("usermessage")) return "user";
  if (role === "assistant" || role === "agent"
    || type.includes("assistantmessage") || type.includes("agentmessage")) return "assistant";
  return null;
}

function collectTextContent(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectTextContent(entry, output));
  else if (value && typeof value === "object") {
    if (typeof value.text === "string") output.push(value.text);
    else if (typeof value.message === "string") output.push(value.message);
    else if (value.content !== undefined) collectTextContent(value.content, output);
    else if (value.input !== undefined) collectTextContent(value.input, output);
  }
  return output;
}

function turnTextsForRole(turn, role) {
  const output = [];
  if (role === "user" && turn?.input !== undefined) collectTextContent(turn.input, output);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (normalizedMessageRole(value) === role) {
      collectTextContent(value.content ?? value.text ?? value.message ?? value.input, output);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(turn?.items ?? turn?.messages ?? turn?.output);
  return output;
}

function deliveryMarker(deliveryId) {
  return `Taskboard Owner decision delivery id: ${deliveryId}`;
}

function coordinationDeliveryMarker(deliveryId, admissionAttemptId) {
  return `Taskboard coordination delivery id: ${deliveryId}:${admissionAttemptId}`;
}

function findDeliveryTurn(turns, deliveryId) {
  const marker = deliveryMarker(deliveryId);
  return turns.find((turn) => collectStringValues(turn).some((text) => text.includes(marker))) ?? null;
}

function ownerIntentAdoptionMarker(adoptionId) {
  return `${OWNER_INTENT_ADOPTION_MARKER} ${adoptionId}`;
}

function findOwnerIntentAdoptionTurn(turns, adoptionId) {
  const marker = ownerIntentAdoptionMarker(adoptionId);
  return turns.find((turn) => collectStringValues(turn).some((text) => text.includes(marker))) ?? null;
}

function crossDomainHandoffMarker(deliveryId) {
  return `${CROSS_DOMAIN_HANDOFF_MARKER} ${deliveryId}`;
}

function findCrossDomainHandoffTurn(turns, deliveryId) {
  const marker = crossDomainHandoffMarker(deliveryId);
  return turns.find((turn) => collectStringValues(turn).some((value) => value.includes(marker))) ?? null;
}

function ownerIntentCaptureRoute(snapshot) {
  const ownerRootTaskId = snapshot?.coordination?.ownerRootTaskId;
  const lane = Array.isArray(snapshot?.taskLanes)
    ? snapshot.taskLanes.find((candidate) => candidate?.id === ownerRootTaskId)
    : null;
  if (!COORDINATION_ID_PATTERN.test(ownerRootTaskId ?? "")
    || lane?.taskType !== "root_task"
    || !THREAD_ID_PATTERN.test(lane?.threadId ?? "")
    || !COORDINATION_ID_PATTERN.test(lane?.codexHostId ?? "")
    || typeof lane?.workspacePath !== "string"
    || !path.isAbsolute(lane.workspacePath)) return null;
  return {
    ownerRootTaskId,
    ownerRootThreadId: lane.threadId,
    codexHostId: lane.codexHostId,
    ownerRootWorkspacePath: lane.workspacePath,
  };
}

export function selectLaunchCoordinatorRoute(snapshots) {
  if (!Array.isArray(snapshots)) return null;
  const routes = [];
  for (const snapshot of snapshots) {
    const projectId = snapshot?.projectId;
    const coordinatorTaskId = snapshot?.coordination?.coordinatorTaskId;
    const ownerRootTaskId = snapshot?.coordination?.ownerRootTaskId;
    if (!COORDINATION_ID_PATTERN.test(projectId ?? "")
      || !COORDINATION_ID_PATTERN.test(coordinatorTaskId ?? "")
      || coordinatorTaskId === ownerRootTaskId) continue;
    const lane = Array.isArray(snapshot?.taskLanes)
      ? snapshot.taskLanes.find((candidate) => candidate?.id === coordinatorTaskId)
      : null;
    if (lane?.taskType !== "root_task"
      || !THREAD_ID_PATTERN.test(lane?.threadId ?? "")
      || !COORDINATION_ID_PATTERN.test(lane?.codexHostId ?? "")
      || typeof lane?.workspacePath !== "string"
      || !path.isAbsolute(lane.workspacePath)) continue;
    routes.push({
      projectId,
      taskId: coordinatorTaskId,
      threadId: lane.threadId,
      codexHostId: lane.codexHostId,
      workspacePath: lane.workspacePath,
    });
  }
  const uniqueRoutes = new Map(routes.map((route) => [
    [route.threadId, route.codexHostId, path.resolve(route.workspacePath)].join("\0"),
    route,
  ]));
  return uniqueRoutes.size === 1 ? uniqueRoutes.values().next().value : null;
}

export function coordinatorThreadSelectionConfirmed({
  expectedThreadId,
  activeThreadId,
  routeThreadId,
}) {
  if (!THREAD_ID_PATTERN.test(expectedThreadId ?? "")) return false;
  if (THREAD_ID_PATTERN.test(activeThreadId ?? "")) {
    return activeThreadId === expectedThreadId;
  }
  return routeThreadId === expectedThreadId;
}

function isCodexControlEnvelope(value) {
  const input = value.trim();
  return /^(?:<\/?(?:heartbeat|environment_context|codex_delegation|app-context|skills_instructions|permissions\s+instructions|collaboration_mode|apps_instructions|plugins_instructions|multi_agent_mode)\b|#\s*AGENTS\.md\s+instructions\b|<INSTRUCTIONS>(?:\s|$)|Message Type:\s*|taskctl\s+issue\s+bootstrap\b)/i.test(input);
}

function ownerIntentRouteFromAssistantTexts(texts) {
  const markerLines = texts.flatMap((value) => value.split(/\r?\n/))
    .map((value) => value.trim())
    .filter((value) => value.includes(OWNER_INTENT_ROUTE_MARKER));
  if (markerLines.length !== 1) return { valid: false };
  const finalLine = texts.at(-1)?.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (markerLines[0] !== finalLine) return { valid: false };
  const match = markerLines[0].match(/^<!--\s*TASKBOARD_OWNER_INTENT_ROUTE_V1\s+(\{.*\})\s*-->$/);
  if (!match) return { valid: false };
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return { valid: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
  const allowedKeys = new Set(["kind", "targetIntentId", "constraints"]);
  const valueKeys = Object.keys(value);
  if (valueKeys.length !== allowedKeys.size
    || valueKeys.some((key) => !allowedKeys.has(key))) return { valid: false };
  if (!["append", "supersede", "clarify", "cancel"].includes(value.kind)) return { valid: false };
  const targetIntentId = value.targetIntentId;
  if ((value.kind === "append" && targetIntentId !== null)
    || (value.kind !== "append" && !COORDINATION_ID_PATTERN.test(targetIntentId ?? ""))) {
    return { valid: false };
  }
  const constraints = value.constraints;
  if (!Array.isArray(constraints)
    || constraints.length > 32
    || constraints.some((constraint) => (
      typeof constraint !== "string"
      || !constraint.trim()
      || constraint.length > 2_000
      || SENSITIVE_COORDINATION_TEXT.test(constraint)
    ))) return { valid: false };
  return { valid: true, kind: value.kind, targetIntentId, constraints };
}

export async function observeTaskboardOwnerIntentCapture(request, rpc) {
  const route = request?.route;
  const projectScope = projectScopedCoordinationKey(request?.projectId);
  const capturedOwnerTurnIds = new Set(Array.isArray(request?.capturedOwnerTurnIds)
    ? request.capturedOwnerTurnIds
    : []);
  const threadResult = await rpc("thread/read", {
    threadId: route.ownerRootThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== route.ownerRootThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(route.ownerRootWorkspacePath)) {
    throw new Error("Owner Intent capture must match the exact configured Owner Root thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const eligible = [];
  let latestObservedOwnerTurnIndex = -1;
  for (const [index, turn] of turns.entries()) {
    if (!THREAD_ID_PATTERN.test(turn?.id ?? "")
      || turn.status !== "completed"
      || capturedOwnerTurnIds.has(turn.id)) continue;
    const userTexts = turnTextsForRole(turn, "user")
      .map((value) => value.trim())
      .filter((value, position, values) => value && values.indexOf(value) === position);
    const assistantTexts = turnTextsForRole(turn, "assistant")
      .map((value) => value.trim())
      .filter(Boolean);
    if (userTexts.length === 0 || assistantTexts.length === 0) continue;
    if (userTexts.some(isCodexControlEnvelope)) continue;
    if (userTexts.some((value) => (
      value.includes("Taskboard Owner decision delivery id:")
      || value.includes(OWNER_INTENT_ADOPTION_MARKER)
      || value.includes(OWNER_INTENT_PLAN_MARKER)
    ))) continue;
    if (assistantTexts.some((value) => value.includes(OWNER_DECISION_MARKER))) continue;
    latestObservedOwnerTurnIndex = index;
    const goal = userTexts.join("\n\n");
    if (goal.length > 20_000 || SENSITIVE_COORDINATION_TEXT.test(goal)) continue;
    const routeIntent = ownerIntentRouteFromAssistantTexts(assistantTexts);
    if (!routeIntent.valid) continue;
    eligible.push({ index, capture: {
      intentId: `owner-intent-${projectScope}-${turn.id}`,
      deliveryId: `owner-turn-${projectScope}-${turn.id}`,
      kind: routeIntent.kind,
      goal,
      constraints: routeIntent.constraints,
      targetIntentId: routeIntent.targetIntentId,
      ownerRootTaskId: route.ownerRootTaskId,
      ownerRootThreadId: route.ownerRootThreadId,
      ownerTurnId: turn.id,
      rootCaptureTurnId: turn.id,
      evidence: routeIntent.kind === "append"
        ? "Protected host observed one completed Owner Root turn."
        : "Protected host observed one completed Owner Root turn with an exact assistant route marker.",
    } });
  }
  const latestCapturedIndex = turns.reduce((latest, turn, index) => (
    capturedOwnerTurnIds.has(turn?.id) ? index : latest
  ), -1);
  if (latestCapturedIndex >= 0) {
    return eligible.find((candidate) => candidate.index > latestCapturedIndex)?.capture ?? null;
  }
  const latestEligible = eligible.at(-1);
  return latestEligible?.index === latestObservedOwnerTurnIndex ? latestEligible.capture : null;
}

export async function runOwnerIntentCaptureMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { captured: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || typeof options?.readSnapshot !== "function"
    || typeof options?.listIntents !== "function"
    || typeof options?.observeCapture !== "function"
    || typeof options?.recordCapture !== "function") {
    return { captured: false, reason: "invalid-monitor" };
  }
  const existing = ownerIntentCaptureMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = (async () => {
    const snapshot = await options.readSnapshot(policy.projectId);
    if (snapshot?.projectId !== policy.projectId) {
      return { captured: false, reason: "invalid-snapshot" };
    }
    const route = ownerIntentCaptureRoute(snapshot);
    if (!route) return { captured: false, reason: "owner-root-unavailable" };
    const intents = await options.listIntents(policy.projectId);
    if (!Array.isArray(intents)) return { captured: false, reason: "invalid-intent-frontier" };
    const capture = await options.observeCapture({
      projectId: policy.projectId,
      route,
      capturedOwnerTurnIds: intents.map((intent) => intent?.ownerTurnId).filter(Boolean),
    });
    if (!capture) return { captured: false, reason: "no-owner-turn" };
    if (!["append", "supersede", "clarify", "cancel"].includes(capture.kind)
      || (capture.kind === "append" && capture.targetIntentId !== null)
      || (capture.kind !== "append" && !intents.some((intent) => (
        intent?.intentId === capture.targetIntentId
      )))) {
      return { captured: false, reason: "owner-intent-target-unavailable" };
    }
    const result = await options.recordCapture(capture, policy.projectId);
    if (result?.applied !== true && result?.applied !== false) {
      return { captured: false, reason: "capture-not-recorded" };
    }
    if (result.applied === false && typeof result.reason === "string") {
      return { captured: false, reason: result.reason };
    }
    return result.applied === true
      ? { captured: true, intentId: capture.intentId, ownerTurnId: capture.ownerTurnId }
      : { captured: false, reason: "already-captured" };
  })();
  ownerIntentCaptureMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (ownerIntentCaptureMonitorRuns.get(policy.projectId) === run) {
      ownerIntentCaptureMonitorRuns.delete(policy.projectId);
    }
  }
}

function hasOwnerIntentPlanDependencyCycle(items) {
  if (!Array.isArray(items) || items.some((item) => (
    !item || typeof item !== "object" || Array.isArray(item)
    || typeof item.outcomeKey !== "string"
    || !Array.isArray(item.blockedByOutcomeKeys)
  ))) return false;
  const dependencies = new Map(items.map((item) => [item.outcomeKey, item.blockedByOutcomeKeys]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const currentDependencies = dependencies.get(key);
    for (const dependency of Array.isArray(currentDependencies) ? currentDependencies : []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

function parseOwnerIntentPlanMarker(text, intentId) {
  const markerIndex = text.indexOf(OWNER_INTENT_PLAN_MARKER);
  if (markerIndex < 0) return null;
  const payloadText = text.slice(markerIndex + OWNER_INTENT_PLAN_MARKER.length).trim().split(/\r?\n/, 1)[0];
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const itemOutcomeKeys = Array.isArray(payload?.items)
    ? payload.items.map((item) => item?.outcomeKey)
    : [];
  const uniqueOutcomeKeys = new Set(itemOutcomeKeys);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).some((key) => ![
      "intentId", "adoptionId", "coordinatorEpoch", "revisionId", "classification",
      "summary", "parentTaskId", "items",
    ].includes(key))
    || payload.intentId !== intentId
    || typeof payload.adoptionId !== "string"
    || typeof payload.coordinatorEpoch !== "string"
    || typeof payload.revisionId !== "string"
    || !COORDINATION_ID_PATTERN.test(payload.revisionId)
    || !["bounded_delivery", "new_product_scope", "financial_decision", "metric_policy", "missing_authority"].includes(payload.classification)
    || typeof payload.summary !== "string"
    || !payload.summary.trim()
    || payload.summary.length > 4_000
    || !Array.isArray(payload.items)
    || payload.items.length > 16
    || payload.parentTaskId !== null
    || (payload.classification !== "bounded_delivery" && payload.items.length > 0)
    || uniqueOutcomeKeys.size !== itemOutcomeKeys.length
    || (Array.isArray(payload.items) && hasOwnerIntentPlanDependencyCycle(payload.items))
    || SENSITIVE_COORDINATION_TEXT.test(payload.summary)
    || payload.items.some((item) => (
      !item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => ![
        "outcomeKey", "title", "description", "priority", "blockedByOutcomeKeys",
      ].includes(key))
      || typeof item.outcomeKey !== "string"
      || !COORDINATION_ID_PATTERN.test(item.outcomeKey)
      || typeof item.title !== "string" || !item.title.trim() || item.title.length > 240
      || typeof item.description !== "string" || item.description.length > 20_000
      || !["none", "urgent", "high", "medium", "low"].includes(item.priority)
      || !Array.isArray(item.blockedByOutcomeKeys)
      || item.blockedByOutcomeKeys.length > 16
      || item.blockedByOutcomeKeys.some((key) => !COORDINATION_ID_PATTERN.test(key ?? ""))
      || item.blockedByOutcomeKeys.some((key) => !uniqueOutcomeKeys.has(key))
      || item.blockedByOutcomeKeys.includes(item.outcomeKey)
      || SENSITIVE_COORDINATION_TEXT.test(item.title)
      || SENSITIVE_COORDINATION_TEXT.test(item.description)
    ))) return null;
  return payload;
}

function parseOwnerDecisionMarker(text, requestId) {
  const markerIndex = text.indexOf(OWNER_DECISION_MARKER);
  if (markerIndex < 0) return null;
  const payloadText = text.slice(markerIndex + OWNER_DECISION_MARKER.length).trim().split(/\r?\n/, 1)[0];
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).some((key) => !["requestId", "outcome", "evidence"].includes(key))
    || payload.requestId !== requestId
    || !["authorized", "denied"].includes(payload.outcome)
    || typeof payload.evidence !== "string"
    || !payload.evidence.trim()
    || payload.evidence.length > 4_096) return null;
  return { outcome: payload.outcome, evidence: payload.evidence.trim() };
}

function parseHostRequest(payload, parseAutomationRequest) {
  if (typeof payload !== "string" || payload.length > 4_194_304) {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  const id = (
    request
    && typeof request.id === "string"
    && /^[a-z0-9-]{1,80}$/i.test(request.id)
  ) ? request.id : null;
  if (!id) return { id: null, request: null, error: HOST_REQUEST_ERROR };
  if (request.action === "ensure") return { id, request, error: null };
  if (
    request.action === "load-frame"
    && typeof request.frameName === "string"
    && /^codex-taskboard-[a-f0-9-]{36,80}$/i.test(request.frameName)
    && typeof request.frameCapability === "string"
    && /^[a-f0-9-]{36,80}$/i.test(request.frameCapability)
  ) return { id, request, error: null };
  if (request.action === "open-external" && typeof request.url === "string") {
    try {
      const url = new URL(request.url);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.href.length <= 2_048) {
        return { id, request: { ...request, url: url.href }, error: null };
      }
    } catch {}
  }
  if (
    request.action === "open-attachment"
    && typeof request.attachmentId === "string"
    && /^[a-f0-9-]{36}$/i.test(request.attachmentId)
    && typeof request.filename === "string"
    && request.filename.length > 0
    && request.filename.length <= 240
    && request.filename !== "."
    && request.filename !== ".."
    && !/[\u0000-\u001f\u007f/\\]/.test(request.filename)
  ) return { id, request, error: null };
  if (request.action === "automation") {
    const parsed = parseAutomationRequest(request);
    return parsed
      ? { id, request: parsed, error: null }
      : {
          id,
          request: null,
          error: HOST_REQUEST_ERROR,
          diagnosticCode: AUTOMATION_SCHEMA_DIAGNOSTIC,
        };
  }
  if (
    request.action === "start-task-conversation"
    && typeof request.taskId === "string"
    && request.taskId.length > 0
    && request.taskId.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(request.taskId)
    && typeof request.previousThreadId === "string"
    && request.previousThreadId.length <= 240
    && typeof request.codexHostId === "string"
    && request.codexHostId.length > 0
    && request.codexHostId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.codexHostId)
    && typeof request.projectless === "boolean"
    && (
      request.projectless
      || (
        typeof request.targetRoot === "string"
        && request.targetRoot.length > 0
        && request.targetRoot.length <= 4_096
      )
    )
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 4_000_000
    && typeof request.title === "string"
    && request.title.length > 0
    && request.title.length <= 240
  ) {
    return { id, request, error: null };
  }
  if (
    request.action === "coordinate-agent-todo"
    && typeof request.rootThreadId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.rootThreadId)
    && typeof request.codexHostId === "string"
    && request.codexHostId.length > 0
    && request.codexHostId.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(request.codexHostId)
    && typeof request.projectId === "string"
    && /^[a-z0-9._-]{1,128}$/i.test(request.projectId)
    && typeof request.todoId === "string"
    && /^[a-z0-9._-]{1,128}$/i.test(request.todoId)
    && typeof request.safeActionId === "string"
    && /^[a-z0-9._-]{1,128}$/i.test(request.safeActionId)
    && typeof request.expectedResumeToken === "string"
    && /^[a-f0-9]{64}$/.test(request.expectedResumeToken)
    && typeof request.rootWorkspacePath === "string"
    && request.rootWorkspacePath.length > 0
    && request.rootWorkspacePath.length <= 4_096
    && path.isAbsolute(request.rootWorkspacePath)
    && typeof request.targetRoot === "string"
    && request.targetRoot.length > 0
    && request.targetRoot.length <= 4_096
    && path.isAbsolute(request.targetRoot)
  ) return { id, request, error: null };
  return { id, request: null, error: HOST_REQUEST_ERROR };
}

export async function deliverTaskboardCoordination(request, rpc, validateExecutionTarget) {
  if (typeof validateExecutionTarget !== "function") {
    throw new Error("Execution worktree validator is required");
  }
  const observedAt = Date.now();
  for (const [key, entry] of coordinationDeliveries) {
    if (entry.expiresAt <= observedAt) coordinationDeliveries.delete(key);
  }
  const rootWorkspacePath = path.resolve(request.rootWorkspacePath);
  const targetRoot = path.resolve(request.targetRoot);
  const deliveryKey = `${request.codexHostId}:${request.projectId}:${request.todoId}:${request.safeActionId}:${request.expectedResumeToken}:${request.deliveryReceipt?.id}:${request.deliveryReceipt?.admissionAttemptId}:${request.rootThreadId}:${rootWorkspacePath}:${targetRoot}`;
  const existing = coordinationDeliveries.get(deliveryKey);
  if (existing) return existing.promise;
  const delivery = deliverTaskboardCoordinationOnce(request, rpc, validateExecutionTarget);
  const entry = { promise: delivery, expiresAt: observedAt + COORDINATION_DEDUPLICATION_MS };
  coordinationDeliveries.set(deliveryKey, entry);
  delivery.catch(() => {
    if (coordinationDeliveries.get(deliveryKey) === entry) coordinationDeliveries.delete(deliveryKey);
  });
  return delivery;
}

export async function deliverTaskboardOwnerDecision(request, rpc, { readOnly = false } = {}) {
  const threadResult = await rpc("thread/read", {
    threadId: request.route.rootThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== request.route.rootThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(request.route.rootWorkspacePath)) {
    throw new Error("Owner decision delivery must match the exact confirmed Root thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const observedDelivery = findDeliveryTurn(turns, request.deliveryReceipt.id);
  if (observedDelivery?.id) {
    return { delivery: "observed", turnId: observedDelivery.id };
  }
  if (readOnly) return null;
  const instruction = [
    `taskctl issue bootstrap ${request.identifier} --json`,
    `Owner decision request id: ${request.requestId}`,
    `Expected Capsule resumeToken: ${request.expectedResumeToken}`,
    `Coordinator epoch: ${request.coordinatorEpoch}`,
    deliveryMarker(request.deliveryReceipt.id),
    `Ask the Owner exactly this one question in this Root window: ${request.message}`,
    "Do not approve it yourself and do not send the Owner to Taskboard comments. Child agents must only checkpoint or hand off to Root.",
    `After the Owner answers, bootstrap the issue again. If the request id and token are still exact, answer the Owner normally and include exactly one machine-readable line: ${OWNER_DECISION_MARKER} {"requestId":"${request.requestId}","outcome":"authorized","evidence":"brief actual Owner answer"}. Use outcome "denied" when the Owner denies it. Do not emit this marker before an actual Owner reply.`,
  ].join("\n");
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) {
    await rpc("turn/steer", {
      threadId: request.route.rootThreadId,
      expectedTurnId: activeTurn.id,
      input: [{ type: "text", text: instruction }],
    });
    return { delivery: "steered", turnId: activeTurn.id };
  }
  await rpc("thread/resume", { threadId: request.route.rootThreadId });
  const started = await rpc("turn/start", {
    threadId: request.route.rootThreadId,
    input: [{ type: "text", text: instruction }],
  });
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a valid Root turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id };
}

export async function observeTaskboardOwnerDecision(request, receipt, rpc) {
  const threadResult = await rpc("thread/read", {
    threadId: request.route.rootThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== request.route.rootThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(request.route.rootWorkspacePath)) {
    throw new Error("Owner decision observation must match the exact confirmed Root thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const deliveryIndex = turns.findIndex((turn) => (
    turn?.id === receipt.deliveryTurnId
    || collectStringValues(turn).some((text) => text.includes(deliveryMarker(receipt.id)))
  ));
  if (deliveryIndex < 0) return null;
  let ownerTurn = null;
  for (let index = deliveryIndex + 1; index < turns.length; index += 1) {
    const turn = turns[index];
    const userTexts = turnTextsForRole(turn, "user").filter((text) => (
      !text.includes(deliveryMarker(receipt.id)) && !text.includes(OWNER_DECISION_MARKER)
    ));
    if (userTexts.some((text) => text.trim())) ownerTurn = turn;
    const marker = turnTextsForRole(turn, "assistant")
      .map((text) => parseOwnerDecisionMarker(text, request.requestId))
      .find(Boolean);
    if (marker && ownerTurn?.id && turn?.id) {
      return {
        ...marker,
        ownerTurnId: ownerTurn.id,
        rootDecisionTurnId: turn.id,
        rootThreadId: request.route.rootThreadId,
      };
    }
  }
  return null;
}

export async function deliverTaskboardOwnerIntent(request, rpc, { readOnly = false } = {}) {
  const route = request.route;
  const threadResult = await rpc("thread/read", {
    threadId: route.coordinatorThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== route.coordinatorThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(route.coordinatorWorkspacePath)) {
    throw new Error("Owner Intent adoption must match the exact confirmed Coordinator thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const observed = findOwnerIntentAdoptionTurn(turns, request.adoptionReceipt.id);
  if (observed?.id) return { delivery: "observed", turnId: observed.id };
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) return { delivery: "queued", reason: "coordinator-busy" };
  if (readOnly) return null;
  const exampleItems = request.kind === "cancel" ? [] : [{
    outcomeKey: "stable-outcome",
    title: "bounded Todo",
    description: "acceptance and boundary",
    priority: "high",
    blockedByOutcomeKeys: [],
  }];
  const instruction = [
    `taskctl issue bootstrap ${request.route.coordinatorTaskId} --json`,
    ownerIntentAdoptionMarker(request.adoptionReceipt.id),
    `Owner Intent id: ${request.intentId}`,
    `Owner Intent kind: ${request.kind}`,
    `Target Owner Intent id: ${request.targetIntentId ?? "none"}`,
    `Coordinator epoch: ${request.coordinatorEpoch}`,
    `Owner goal: ${request.goal}`,
    ...(request.constraints ?? []).map((constraint) => `Owner constraint: ${constraint}`),
    "Adopt this queued Owner Intent only at this safe boundary. Recompute the plan and Taskboard Todos without widening product, Git, deployment, financial, deletion, or external-side-effect authority. A cancel intent must produce an empty items array and must never create replacement work.",
    "Preserve the current execution result and one-writer ownership. Never send the Owner to Taskboard comments.",
    `After duplicate-work checks, put exactly one machine-readable line in the final answer only: ${OWNER_INTENT_PLAN_MARKER} ${JSON.stringify({ intentId: request.intentId, adoptionId: request.adoptionReceipt.id, coordinatorEpoch: request.coordinatorEpoch, revisionId: `plan-${projectScopedCoordinationKey(request.projectId)}-bounded-id`, classification: "bounded_delivery", summary: "brief plan", parentTaskId: null, items: exampleItems })}. Never emit it in commentary. Use classification new_product_scope, financial_decision, metric_policy, or missing_authority with an empty items array when a new Owner decision or authority is required.`,
  ].join("\n");
  await rpc("thread/resume", { threadId: route.coordinatorThreadId });
  const started = await rpc("turn/start", {
    threadId: route.coordinatorThreadId,
    input: [{ type: "text", text: instruction }],
  });
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a valid Coordinator turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id };
}

export async function runOwnerIntentAdoptionMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { delivered: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || typeof options?.readSnapshot !== "function"
    || typeof options?.claimAdoption !== "function"
    || typeof options?.confirmAdoption !== "function"
    || typeof options?.deliver !== "function") {
    return { delivered: false, reason: "invalid-monitor" };
  }
  const existing = ownerIntentAdoptionMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runOwnerIntentAdoptionMonitorOnceUnlocked(options);
  ownerIntentAdoptionMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (ownerIntentAdoptionMonitorRuns.get(policy.projectId) === run) {
      ownerIntentAdoptionMonitorRuns.delete(policy.projectId);
    }
  }
}

export async function observeTaskboardOwnerIntentPlan(request, rpc) {
  const route = request.route;
  const threadResult = await rpc("thread/read", {
    threadId: route.coordinatorThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== route.coordinatorThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(route.coordinatorWorkspacePath)) {
    throw new Error("Owner Intent plan observation must match the exact Coordinator thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const deliveryTurn = turns.find((turn) => (
    turn?.id === request.adoptionReceipt.deliveryTurnId
    || collectStringValues(turn).some((text) => text.includes(ownerIntentAdoptionMarker(request.adoptionReceipt.id)))
  ));
  if (!deliveryTurn || deliveryTurn.status === "inProgress") return null;
  if (deliveryTurn.status !== "completed") {
    const reason = deliveryTurn.status === "failed"
      ? "delivery-turn-failed"
      : deliveryTurn.status === "interrupted"
        ? "delivery-turn-interrupted"
        : "delivery-turn-invalid-status";
    return { invalid: true, reason };
  }
  const finalAssistantText = turnTextsForRole(deliveryTurn, "assistant").at(-1);
  const marker = finalAssistantText
    ? parseOwnerIntentPlanMarker(finalAssistantText, request.intentId)
    : null;
  if (!marker
    || marker.adoptionId !== request.adoptionReceipt.id
    || marker.coordinatorEpoch !== request.adoptionReceipt.coordinatorEpoch) {
    return { invalid: true, reason: "missing-or-malformed-plan" };
  }
  return marker;
}

export async function runOwnerIntentPlanningMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { applied: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || typeof options?.readSnapshot !== "function"
    || typeof options?.observePlan !== "function"
    || typeof options?.applyPlan !== "function") {
    return { applied: false, reason: "invalid-monitor" };
  }
  const existing = ownerIntentPlanningMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = (async () => {
    const snapshot = await options.readSnapshot(policy.projectId);
    const request = snapshot?.coordination?.pendingOwnerIntentPlan;
    if (snapshot?.projectId !== policy.projectId || !request) {
      return { applied: false, reason: "no-plan-pending" };
    }
    const plan = await options.observePlan(request);
    if (!plan) return { applied: false, reason: "awaiting-plan" };
    if (plan.invalid === true) {
      if (typeof options.scheduleRetry !== "function") {
        return { applied: false, reason: "plan-retry-unavailable" };
      }
      const retry = await options.scheduleRetry(request, {
        reason: plan.reason,
        revisionId: null,
      });
      return {
        applied: false,
        reason: retry?.exhausted === true ? "plan-retry-exhausted" : "plan-retry-scheduled",
      };
    }
    const result = await options.applyPlan(request, plan);
    if (result?.reason === "invalid-plan") {
      if (typeof options.scheduleRetry !== "function") {
        return { applied: false, reason: "plan-retry-unavailable" };
      }
      const retry = await options.scheduleRetry(request, {
        reason: "server-invalid-plan",
        revisionId: plan.revisionId,
      });
      return {
        applied: false,
        reason: retry?.exhausted === true ? "plan-retry-exhausted" : "plan-retry-scheduled",
      };
    }
    if (typeof result?.applied !== "boolean") {
      return { applied: false, reason: "plan-not-recorded" };
    }
    return { applied: result.applied, intentId: request.intentId, revisionId: plan.revisionId };
  })();
  ownerIntentPlanningMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (ownerIntentPlanningMonitorRuns.get(policy.projectId) === run) {
      ownerIntentPlanningMonitorRuns.delete(policy.projectId);
    }
  }
}

export async function runTaskboardProjectMonitorSequence(monitors) {
  const results = [];
  for (const monitor of monitors) {
    if (typeof monitor !== "function") continue;
    try {
      results.push({ ok: true, result: await monitor() });
    } catch (error) {
      results.push({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
  projectId,
  listHandshakes,
  readThread,
  confirmIdentity,
}) {
  if (!COORDINATION_ID_PATTERN.test(projectId ?? "")) {
    return { confirmed: 0, skipped: 0, failed: 0, reason: "invalid-project" };
  }
  const response = await listHandshakes(projectId);
  const handshakes = Array.isArray(response?.handshakes) ? response.handshakes : [];
  let confirmed = 0;
  let skipped = 0;
  let failed = 0;
  for (const handshake of handshakes) {
    const expected = handshake?.expectedHostBinding;
    if (handshake?.role !== "coordinator"
      || handshake?.registration?.projectId !== projectId
      || handshake.registration.role !== "coordinator"
      || handshake.registration.threadId !== handshake.threadId
      || !THREAD_ID_PATTERN.test(handshake?.threadId ?? "")
      || typeof expected?.codexProjectId !== "string"
      || !expected.codexProjectId
      || !["local", "remote"].includes(expected.codexProjectKind)
      || !COORDINATION_ID_PATTERN.test(expected.codexHostId ?? "")
      || typeof expected?.workspacePath !== "string"
      || !path.isAbsolute(expected.workspacePath)) {
      skipped += 1;
      continue;
    }
    try {
      const result = await readThread({
        threadId: handshake.threadId,
        codexHostId: expected.codexHostId,
      });
      const thread = result?.thread;
      if (thread?.id !== handshake.threadId
        || typeof thread?.cwd !== "string"
        || path.resolve(thread.cwd) !== path.resolve(expected.workspacePath)) {
        skipped += 1;
        continue;
      }
      await confirmIdentity(handshake.id, handshake.registration, {
        threadId: handshake.threadId,
        codexProjectId: expected.codexProjectId,
        codexProjectKind: expected.codexProjectKind,
        codexHostId: expected.codexHostId,
        workspacePath: path.resolve(expected.workspacePath),
      });
      confirmed += 1;
    } catch {
      failed += 1;
    }
  }
  return { confirmed, skipped, failed };
}

async function runCoordinatorLeaseKeepaliveMonitorOnceUnlocked({
  policy,
  readSnapshot,
  readThread,
  renewLease,
  now = Date.now,
}) {
  const snapshot = await readSnapshot(policy.projectId);
  if (snapshot?.projectId !== policy.projectId
    || !snapshot.coordination
    || !Array.isArray(snapshot.coordination.domainCoordinators)
    || !Array.isArray(snapshot.taskLanes)) {
    return { renewed: 0, failed: 0, skipped: 0, reason: "invalid-snapshot" };
  }
  const candidates = [];
  if (snapshot.coordination.lease) {
    candidates.push({
      scope: "global",
      holderTaskId: snapshot.coordination.coordinatorTaskId,
      lease: snapshot.coordination.lease,
    });
  }
  for (const coordinator of snapshot.coordination.domainCoordinators) {
    if (!coordinator?.lease) continue;
    candidates.push({
      scope: "domain",
      domainId: coordinator.domainId,
      holderTaskId: coordinator.coordinatorTaskId,
      lease: coordinator.lease,
    });
  }
  const observedAt = now();
  const results = await Promise.all(candidates.map(async (candidate) => {
    const expiresAt = Date.parse(candidate.lease?.expiresAt ?? "");
    if (candidate.lease?.status !== "active"
      || !COORDINATION_ID_PATTERN.test(candidate.lease?.id ?? "")
      || !COORDINATION_ID_PATTERN.test(candidate.holderTaskId ?? "")
      || !Number.isFinite(expiresAt)
      || expiresAt <= observedAt
      || expiresAt - observedAt > policy.renewWindowMs
      || (candidate.scope === "domain"
        && !COORDINATION_ID_PATTERN.test(candidate.domainId ?? ""))) {
      return "skipped";
    }
    const lane = snapshot.taskLanes.find((entry) => entry?.id === candidate.holderTaskId);
    const route = {
      threadId: lane?.threadId,
      codexHostId: lane?.codexHostId,
      workspacePath: lane?.workspacePath,
    };
    if (!THREAD_ID_PATTERN.test(route.threadId ?? "")
      || !COORDINATION_ID_PATTERN.test(route.codexHostId ?? "")
      || typeof route.workspacePath !== "string"
      || !path.isAbsolute(route.workspacePath)) {
      return "skipped";
    }
    try {
      const threadResult = await readThread(route);
      const thread = threadResult?.thread;
      if (thread?.id !== route.threadId
        || path.resolve(thread.cwd ?? "") !== path.resolve(route.workspacePath)
        || !Array.isArray(thread.turns)
        || thread.turns.some((turn) => turn?.status === "inProgress")) {
        return "skipped";
      }
      const renewed = await renewLease({
        scope: candidate.scope,
        projectId: policy.projectId,
        ...(candidate.domainId ? { domainId: candidate.domainId } : {}),
        holderTaskId: candidate.holderTaskId,
        holderThreadId: route.threadId,
        codexHostId: route.codexHostId,
        workspacePath: route.workspacePath,
        expectedLeaseId: candidate.lease.id,
        leaseDurationSeconds: policy.leaseDurationSeconds,
      });
      return renewed?.lease?.id === candidate.lease.id
        && renewed.lease.status === "active"
        ? "renewed"
        : "failed";
    } catch {
      return "failed";
    }
  }));
  return {
    renewed: results.filter((result) => result === "renewed").length,
    failed: results.filter((result) => result === "failed").length,
    skipped: results.filter((result) => result === "skipped").length,
  };
}

export async function runCoordinatorLeaseKeepaliveMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { renewed: 0, failed: 0, skipped: 0, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || !Number.isSafeInteger(policy.renewWindowMs)
    || policy.renewWindowMs < 1
    || policy.renewWindowMs > 15 * 60_000
    || !Number.isSafeInteger(policy.leaseDurationSeconds)
    || policy.leaseDurationSeconds < 30
    || policy.leaseDurationSeconds > 3600
    || typeof options?.readSnapshot !== "function"
    || typeof options?.readThread !== "function"
    || typeof options?.renewLease !== "function") {
    return { renewed: 0, failed: 0, skipped: 0, reason: "invalid-monitor" };
  }
  const existing = coordinatorLeaseKeepaliveMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runCoordinatorLeaseKeepaliveMonitorOnceUnlocked(options);
  coordinatorLeaseKeepaliveMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (coordinatorLeaseKeepaliveMonitorRuns.get(policy.projectId) === run) {
      coordinatorLeaseKeepaliveMonitorRuns.delete(policy.projectId);
    }
  }
}

async function runCoordinatorLeaseRecoveryMonitorOnceUnlocked({
  policy,
  readSnapshot,
  readThread,
  recoverLease,
}) {
  const snapshot = await readSnapshot(policy.projectId);
  if (snapshot?.projectId !== policy.projectId
    || !snapshot.coordination
    || !Array.isArray(snapshot.coordination.domainCoordinators)
    || !Array.isArray(snapshot.taskLanes)) {
    return { recovered: 0, failed: 0, skipped: 0, reason: "invalid-snapshot" };
  }
  const candidates = [];
  if (snapshot.coordination.lease) {
    candidates.push({
      scope: "global",
      holderTaskId: snapshot.coordination.lease.holderTaskId,
      lease: snapshot.coordination.lease,
    });
  }
  for (const coordinator of snapshot.coordination.domainCoordinators) {
    if (!coordinator?.lease) continue;
    candidates.push({
      scope: "domain",
      domainId: coordinator.domainId,
      holderTaskId: coordinator.lease.holderTaskId,
      lease: coordinator.lease,
    });
  }
  const results = await Promise.all(candidates.map(async (candidate) => {
    if (candidate.lease?.status !== "expired"
      || candidate.lease?.bindingValid !== true
      || candidate.lease?.releasedAt
      || !COORDINATION_ID_PATTERN.test(candidate.lease?.id ?? "")
      || !COORDINATION_ID_PATTERN.test(candidate.holderTaskId ?? "")
      || (candidate.scope === "domain"
        && !COORDINATION_ID_PATTERN.test(candidate.domainId ?? ""))) {
      return "skipped";
    }
    const lane = snapshot.taskLanes.find((entry) => entry?.id === candidate.holderTaskId);
    const route = {
      threadId: lane?.threadId,
      codexHostId: lane?.codexHostId,
      workspacePath: lane?.workspacePath,
    };
    if (!THREAD_ID_PATTERN.test(route.threadId ?? "")
      || !COORDINATION_ID_PATTERN.test(route.codexHostId ?? "")
      || typeof route.workspacePath !== "string"
      || !path.isAbsolute(route.workspacePath)) {
      return "skipped";
    }
    try {
      const threadResult = await readThread(route);
      const thread = threadResult?.thread;
      if (thread?.id !== route.threadId
        || path.resolve(thread.cwd ?? "") !== path.resolve(route.workspacePath)
        || !Array.isArray(thread.turns)
        || thread.turns.some((turn) => turn?.status === "inProgress")) {
        return "skipped";
      }
      const recovered = await recoverLease({
        scope: candidate.scope,
        projectId: policy.projectId,
        ...(candidate.domainId ? { domainId: candidate.domainId } : {}),
        holderTaskId: candidate.holderTaskId,
        holderThreadId: route.threadId,
        codexHostId: route.codexHostId,
        workspacePath: route.workspacePath,
        expectedLeaseId: candidate.lease.id,
        leaseDurationSeconds: policy.leaseDurationSeconds,
      });
      return COORDINATION_ID_PATTERN.test(recovered?.lease?.id ?? "")
        && recovered.lease.id !== candidate.lease.id
        && recovered.lease.status === "active"
        ? "recovered"
        : "failed";
    } catch {
      return "failed";
    }
  }));
  return {
    recovered: results.filter((result) => result === "recovered").length,
    failed: results.filter((result) => result === "failed").length,
    skipped: results.filter((result) => result === "skipped").length,
  };
}

export async function runCoordinatorLeaseRecoveryMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { recovered: 0, failed: 0, skipped: 0, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || !Number.isSafeInteger(policy.leaseDurationSeconds)
    || policy.leaseDurationSeconds < 30
    || policy.leaseDurationSeconds > 3600
    || typeof options?.readSnapshot !== "function"
    || typeof options?.readThread !== "function"
    || typeof options?.recoverLease !== "function") {
    return { recovered: 0, failed: 0, skipped: 0, reason: "invalid-monitor" };
  }
  const existing = coordinatorLeaseRecoveryMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runCoordinatorLeaseRecoveryMonitorOnceUnlocked(options);
  coordinatorLeaseRecoveryMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (coordinatorLeaseRecoveryMonitorRuns.get(policy.projectId) === run) {
      coordinatorLeaseRecoveryMonitorRuns.delete(policy.projectId);
    }
  }
}

export async function deliverTaskboardCrossDomainHandoff(request, rpc, { readOnly = false } = {}) {
  const route = request.route;
  const threadResult = await rpc("thread/read", {
    threadId: route.targetThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== route.targetThreadId
    || path.resolve(threadResult.thread.cwd ?? "") !== path.resolve(route.targetWorkspacePath)) {
    throw new Error("Cross-domain handoff delivery must match the exact target Coordinator thread and workspace");
  }
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const observed = findCrossDomainHandoffTurn(turns, request.deliveryReceipt.id);
  if (observed?.id) return { delivery: "observed", turnId: observed.id };
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) return { delivery: "queued", reason: "coordinator-busy" };
  if (readOnly) return null;
  const instruction = [
    `taskctl issue bootstrap ${request.targetIdentifier} --json`,
    crossDomainHandoffMarker(request.deliveryReceipt.id),
    `Completed dependency source: ${request.sourceIdentifier}`,
    `Target Todo: ${request.targetIdentifier}`,
    `Exact dependency frontier: ${request.fingerprint}`,
    "This is a delivery invitation, not dependency acceptance. Re-bootstrap and inspect the current handoff before acting.",
    `Run: taskctl dependency-handoff status ${request.projectId} ${request.targetIdentifier} --json`,
    `If the exact frontier and your coordinator lease are still current, run: taskctl dependency-handoff accept ${request.projectId} ${request.targetIdentifier} --source ${request.sourceIdentifier} --idempotency-key handoff-delivery-${request.deliveryReceipt.id} --holder-task ${request.targetHolderTaskId} --holder-thread-id ${route.targetThreadId} --expected-lease-id ${request.expectedTargetDomainLeaseId} --json`,
    "Do not widen product or write scope. If anything drifted, leave it unaccepted so Taskboard can route the new frontier.",
  ].join("\n");
  await rpc("thread/resume", { threadId: route.targetThreadId });
  const started = await rpc("turn/start", {
    threadId: route.targetThreadId,
    input: [{ type: "text", text: instruction }],
  });
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a valid cross-domain handoff turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id };
}

async function runCrossDomainHandoffMonitorOnceUnlocked({
  policy,
  readSnapshot,
  claimDelivery,
  confirmDelivery,
  deliver,
}) {
  const snapshot = await readSnapshot(policy.projectId);
  const request = snapshot?.coordination?.pendingCrossDomainHandoff;
  const route = request?.route;
  if (snapshot?.projectId !== policy.projectId
    || !request
    || request.projectId !== policy.projectId
    || !COORDINATION_ID_PATTERN.test(request.sourceIdentifier ?? "")
    || !COORDINATION_ID_PATTERN.test(request.targetIdentifier ?? "")
    || !RESUME_TOKEN_PATTERN.test(request.fingerprint ?? "")
    || !THREAD_ID_PATTERN.test(route?.targetThreadId ?? "")
    || !COORDINATION_ID_PATTERN.test(route?.codexHostId ?? "")
    || typeof route?.targetWorkspacePath !== "string"
    || !path.isAbsolute(route.targetWorkspacePath)) {
    return { delivered: false, reason: request ? "invalid-request" : "no-request" };
  }
  const claim = await claimDelivery(request);
  if (!claim?.receipt || typeof claim.receipt.id !== "string") {
    return { delivered: false, reason: claim?.reason ?? "reservation-rejected" };
  }
  if (claim.reason === "already-delivered") {
    return { delivered: false, reason: "already-delivered" };
  }
  const delivery = await deliver(
    { ...request, deliveryReceipt: claim.receipt },
    { readOnly: claim.claimed !== true },
  );
  if (delivery?.reason === "coordinator-busy" || !delivery?.turnId) {
    return { delivered: false, reason: delivery?.reason ?? "reserved" };
  }
  const confirmation = await confirmDelivery({
    deliveryId: claim.receipt.id,
    deliveryTurnId: delivery.turnId,
  });
  if (confirmation?.confirmed !== true) {
    return { delivered: false, reason: "delivery-not-confirmed" };
  }
  return {
    delivered: claim.claimed === true,
    sourceTaskId: request.sourceTaskId,
    targetTaskId: request.targetTaskId,
    delivery: delivery.delivery,
  };
}

export async function runCrossDomainHandoffMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { delivered: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || typeof options?.readSnapshot !== "function"
    || typeof options?.claimDelivery !== "function"
    || typeof options?.confirmDelivery !== "function"
    || typeof options?.deliver !== "function") {
    return { delivered: false, reason: "invalid-monitor" };
  }
  const existing = crossDomainHandoffMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runCrossDomainHandoffMonitorOnceUnlocked(options);
  crossDomainHandoffMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (crossDomainHandoffMonitorRuns.get(policy.projectId) === run) {
      crossDomainHandoffMonitorRuns.delete(policy.projectId);
    }
  }
}

async function runOwnerIntentAdoptionMonitorOnceUnlocked({
  policy,
  readSnapshot,
  claimAdoption,
  confirmAdoption,
  deliver,
}) {
  const snapshot = await readSnapshot(policy.projectId);
  const request = snapshot?.coordination?.pendingOwnerIntent;
  const route = request?.route;
  if (snapshot?.projectId !== policy.projectId
    || !request
    || !COORDINATION_ID_PATTERN.test(request.intentId ?? "")
    || !["append", "supersede", "clarify", "cancel"].includes(request.kind)
    || (request.kind === "append" && request.targetIntentId !== null)
    || (request.kind !== "append" && !COORDINATION_ID_PATTERN.test(request.targetIntentId ?? ""))
    || typeof request.goal !== "string"
    || !request.goal.trim()
    || typeof request.coordinatorEpoch !== "string"
    || !request.coordinatorEpoch
    || !COORDINATION_ID_PATTERN.test(route?.coordinatorTaskId ?? "")
    || !THREAD_ID_PATTERN.test(route?.coordinatorThreadId ?? "")
    || typeof route?.coordinatorWorkspacePath !== "string"
    || !path.isAbsolute(route.coordinatorWorkspacePath)) {
    return { delivered: false, reason: request ? "invalid-request" : "no-request" };
  }
  const claim = await claimAdoption(request);
  const claimedIntent = claim?.executionIntent;
  if (!claim?.receipt
    || typeof claim.receipt.id !== "string"
    || claimedIntent?.intentId !== request.intentId
    || claimedIntent.kind !== request.kind
    || claimedIntent.targetIntentId !== request.targetIntentId
    || !Number.isInteger(claimedIntent.version)
    || claimedIntent.version < 1
    || typeof claimedIntent.goal !== "string"
    || !claimedIntent.goal.trim()
    || !Array.isArray(claimedIntent.constraints)
    || claimedIntent.constraints.some((item) => typeof item !== "string")) {
    return { delivered: false, reason: claim?.reason ?? "reservation-rejected" };
  }
  const delivery = await deliver(
    {
      ...request,
      projectId: policy.projectId,
      version: claimedIntent.version,
      kind: claimedIntent.kind,
      targetIntentId: claimedIntent.targetIntentId,
      goal: claimedIntent.goal,
      constraints: claimedIntent.constraints,
      adoptionReceipt: claim.receipt,
    },
    { readOnly: claim.claimed !== true },
  );
  if (delivery?.reason === "coordinator-busy" || !delivery?.turnId) {
    return { delivered: false, reason: delivery?.reason ?? "reserved" };
  }
  const confirmation = await confirmAdoption({
    adoptionId: claim.receipt.id,
    deliveryTurnId: delivery.turnId,
  }, request.intentId);
  if (confirmation?.confirmed !== true && confirmation?.reason !== "already-adopted") {
    return { delivered: false, reason: "adoption-not-confirmed" };
  }
  return {
    delivered: claim.claimed === true,
    intentId: request.intentId,
    delivery: delivery.delivery,
    adopted: true,
  };
}

export async function runOwnerDecisionMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { delivered: false, reason: "disabled" };
  if (!COORDINATION_ID_PATTERN.test(policy?.projectId ?? "")
    || typeof options?.readSnapshot !== "function"
    || typeof options?.claimDelivery !== "function"
    || typeof options?.confirmDelivery !== "function"
    || typeof options?.deliver !== "function"
    || typeof options?.observeDecision !== "function"
    || typeof options?.recordDecision !== "function") {
    return { delivered: false, reason: "invalid-monitor" };
  }
  const existing = ownerDecisionMonitorRuns.get(policy.projectId);
  if (existing) return existing;
  const run = runOwnerDecisionMonitorOnceUnlocked(options);
  ownerDecisionMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (ownerDecisionMonitorRuns.get(policy.projectId) === run) {
      ownerDecisionMonitorRuns.delete(policy.projectId);
    }
  }
}

async function runOwnerDecisionMonitorOnceUnlocked({
  policy,
  readSnapshot,
  claimDelivery,
  confirmDelivery,
  deliver,
  observeDecision,
  recordDecision,
}) {
  const snapshot = await readSnapshot(policy.projectId);
  const request = snapshot?.coordination?.ownerDecisionRequest;
  if (snapshot?.projectId !== policy.projectId
    || !request
    || !RESUME_TOKEN_PATTERN.test(request.requestId ?? "")
    || !RESUME_TOKEN_PATTERN.test(request.expectedResumeToken ?? "")
    || !COORDINATION_ID_PATTERN.test(request.identifier ?? "")
    || !COORDINATION_ID_PATTERN.test(request.actionId ?? "")
    || typeof request.message !== "string"
    || !request.message.trim()
    || typeof request.coordinatorEpoch !== "string"
    || !request.coordinatorEpoch
    || !THREAD_ID_PATTERN.test(request.route?.rootThreadId ?? "")
    || typeof request.route?.rootWorkspacePath !== "string"
    || !path.isAbsolute(request.route.rootWorkspacePath)) {
    return { delivered: false, reason: request ? "invalid-request" : "no-request" };
  }
  const claim = await claimDelivery(request);
  if (!claim?.receipt || typeof claim.receipt.id !== "string") {
    if (claim?.claimed !== true && !["reserved", "already-delivered"].includes(claim?.reason)) {
      return { delivered: false, reason: claim?.reason ?? "reservation-rejected" };
    }
    return { delivered: false, reason: "invalid-reservation" };
  }
  let deliveryResult = null;
  let deliveryReceipt = claim.receipt;
  if (claim.claimed === true) {
    deliveryResult = await deliver({ ...request, deliveryReceipt });
  } else if (claim.reason === "reserved") {
    deliveryResult = await deliver({ ...request, deliveryReceipt }, { readOnly: true });
    if (!deliveryResult?.turnId) return { delivered: false, reason: "reserved" };
  } else if (claim.reason !== "already-delivered") {
    return { delivered: false, reason: claim.reason ?? "reservation-rejected" };
  }
  if (deliveryResult) {
    const confirmation = await confirmDelivery({
      deliveryId: deliveryReceipt.id,
      deliveryTurnId: deliveryResult.turnId,
    });
    if (confirmation?.confirmed !== true) {
      return { delivered: false, reason: "delivery-not-confirmed" };
    }
    deliveryReceipt = { ...deliveryReceipt, deliveryTurnId: deliveryResult.turnId };
  }
  const decision = await observeDecision(request, deliveryReceipt);
  if (decision) {
    const recorded = await recordDecision({
      taskId: request.identifier,
      requestId: request.requestId,
      expectedResumeToken: request.expectedResumeToken,
      deliveryId: deliveryReceipt.id,
      ...decision,
    });
    if (recorded?.applied !== true && recorded?.applied !== false) {
      return { delivered: false, reason: "decision-not-recorded" };
    }
    return {
      delivered: claim.claimed === true,
      requestId: request.requestId,
      delivery: deliveryResult?.delivery ?? null,
      decisionRecorded: true,
    };
  }
  return {
    delivered: claim.claimed === true,
    requestId: request.requestId,
    delivery: deliveryResult?.delivery ?? null,
    awaitingOwner: true,
  };
}

export async function runTaskboardContinuationMonitorOnce(options) {
  const policy = options?.policy;
  if (policy?.enabled !== true) return { delivered: false, reason: "disabled" };
  if (!policy || !COORDINATION_ID_PATTERN.test(policy.projectId ?? "")) {
    return { delivered: false, reason: "invalid-policy" };
  }
  const existing = continuationMonitorRuns.get(policy.projectId);
  if (existing) return existing;

  const run = runTaskboardContinuationMonitorOnceUnlocked(options);
  continuationMonitorRuns.set(policy.projectId, run);
  try {
    return await run;
  } finally {
    if (continuationMonitorRuns.get(policy.projectId) === run) {
      continuationMonitorRuns.delete(policy.projectId);
    }
  }
}

function continuationCapacity(snapshot, target, policy, observedAtMs) {
  if (policy.maxActiveAgents === undefined) return { available: true };
  if (!Number.isSafeInteger(policy.maxActiveAgents)
    || policy.maxActiveAgents < 1
    || policy.maxActiveAgents > 64
    || !Number.isSafeInteger(policy.capacityObservationMaxAgeMs)
    || policy.capacityObservationMaxAgeMs < 1
    || policy.capacityObservationMaxAgeMs > 15 * 60_000) {
    return { available: false, reason: "invalid-capacity-policy" };
  }
  const tree = Array.isArray(snapshot.windowSubagentTrees)
    ? snapshot.windowSubagentTrees.find((candidate) => (
        candidate?.rootThreadId === target.rootThreadId
      ))
    : null;
  const active = tree?.summary?.active;
  const capacityObservedAt = Date.parse(tree?.capacityObservation?.observedAt ?? "");
  if (tree?.observed !== true
    || tree?.capacityObservation?.source !== "list_agents"
    || !Number.isSafeInteger(active)
    || active < 0
    || !Number.isFinite(capacityObservedAt)) {
    return { available: false, reason: "capacity-unobserved" };
  }
  if (capacityObservedAt > observedAtMs
    || observedAtMs - capacityObservedAt > policy.capacityObservationMaxAgeMs) {
    return { available: false, reason: "capacity-observation-stale" };
  }
  const childSlotLimit = Math.max(0, policy.maxActiveAgents - 1);
  return active < childSlotLimit
    ? { available: true }
    : { available: false, reason: "waiting-capacity" };
}

function durableModelCapacityRetry(snapshot, candidate, target, readyWork, safeAction, observedAtMs) {
  const admission = candidate?.admission;
  if (admission?.state !== "deferred" || admission?.deferredReason !== "model_capacity") {
    return null;
  }
  const retryAfter = Date.parse(admission.retryAfter ?? "");
  const validMarker = typeof admission.receiptId === "string" && admission.receiptId
    && typeof admission.attemptId === "string" && admission.attemptId
    && Number.isSafeInteger(admission.retryCount)
    && admission.retryCount > 0
    && Number.isFinite(retryAfter);
  if (!validMarker
    || admission.rootThreadId !== target.rootThreadId
    || admission.resumeToken !== readyWork.resumeToken
    || admission.safeActionId !== safeAction.id) {
    return null;
  }
  const exactRootRoute = admission.rootHostId === target.codexHostId
    && typeof admission.rootWorkspacePath === "string"
    && path.isAbsolute(admission.rootWorkspacePath)
    && path.resolve(admission.rootWorkspacePath) === path.resolve(target.rootWorkspacePath);
  const assignment = candidate.domainAssignment;
  const exactCoordinatorEpoch = assignment
    ? assignment.status === "active"
      && admission.coordinationDomainId === assignment.domainId
      && admission.domainCoordinatorLeaseId === assignment.leaseId
      && admission.domainCoordinatorTaskId === assignment.coordinatorTaskId
      && admission.domainCoordinatorThreadId === target.rootThreadId
    : snapshot?.coordination?.lease?.status === "active"
      ? admission.coordinationDomainId == null
        && admission.globalCoordinatorLeaseId === snapshot.coordination.lease.id
        && admission.globalCoordinatorTaskId === snapshot.coordination.coordinatorTaskId
        && admission.globalCoordinatorThreadId === target.rootThreadId
      : admission.coordinationDomainId == null
        && admission.globalCoordinatorLeaseId == null
        && admission.globalCoordinatorTaskId == null
        && admission.globalCoordinatorThreadId == null;
  if (!exactRootRoute || !exactCoordinatorEpoch) return { staleRoute: true, due: false };
  return { staleRoute: false, due: retryAfter <= observedAtMs };
}

async function runTaskboardContinuationMonitorOnceUnlocked({
  policy,
  readSnapshot,
  claimReceipt,
  confirmDelivery,
  deliver,
  completeDelivery,
  deferAdmission,
  markAdmissionUncertain,
  claimAdmissionProbe,
  reconcileAdmission,
  deliverAdmissionRecovery,
  now = Date.now,
}) {
  if (
    typeof readSnapshot !== "function"
    || typeof claimReceipt !== "function"
    || typeof confirmDelivery !== "function"
    || typeof deliver !== "function"
    || typeof completeDelivery !== "function"
  ) return { delivered: false, reason: "invalid-monitor" };

  const snapshot = await readSnapshot(policy.projectId);
  if (snapshot?.projectId !== policy.projectId || !Array.isArray(snapshot.todos)) {
    return { delivered: false, reason: "invalid-snapshot" };
  }
  const recoveryTodo = snapshot.todos.find((candidate) => {
    const admission = candidate?.admission;
    return COORDINATION_ID_PATTERN.test(candidate?.id ?? "")
      && COORDINATION_ID_PATTERN.test(candidate?.taskId ?? "")
      && ["awaiting_admission", "prepared", "admission_uncertain", "recovery_confirmed"].includes(admission?.state)
      && typeof admission?.receiptId === "string" && admission.receiptId
      && typeof admission?.attemptId === "string" && admission.attemptId
      && THREAD_ID_PATTERN.test(admission?.rootThreadId ?? "")
      && candidate?.dispatchTarget?.rootThreadId === admission.rootThreadId
      && typeof candidate.dispatchTarget.codexHostId === "string" && candidate.dispatchTarget.codexHostId
      && RESUME_TOKEN_PATTERN.test(admission?.resumeToken ?? "")
      && COORDINATION_ID_PATTERN.test(admission?.safeActionId ?? "");
  });
  if (recoveryTodo) {
    const admission = recoveryTodo.admission;
    const recovery = {
      projectId: policy.projectId,
      todoId: recoveryTodo.id,
      taskId: recoveryTodo.taskId,
      rootThreadId: admission.rootThreadId,
      codexHostId: recoveryTodo.dispatchTarget.codexHostId,
      rootWorkspacePath: recoveryTodo.dispatchTarget.rootWorkspacePath,
      expectedResumeToken: admission.resumeToken,
      safeActionId: admission.safeActionId,
      admissionReceiptId: admission.receiptId,
      admissionAttemptId: admission.attemptId,
      admission,
    };
    if (["awaiting_admission", "prepared"].includes(admission.state)) {
      const deadlineAt = Date.parse(admission.deadlineAt ?? "");
      if (!Number.isFinite(deadlineAt) || deadlineAt > now()) {
        return { delivered: false, reason: "awaiting-admission" };
      }
    }
    if (typeof markAdmissionUncertain !== "function"
      || typeof claimAdmissionProbe !== "function"
      || typeof reconcileAdmission !== "function"
      || typeof deliverAdmissionRecovery !== "function") {
      return { delivered: false, reason: "invalid-recovery-monitor" };
    }
    if (["awaiting_admission", "prepared"].includes(admission.state)) {
      const uncertain = await markAdmissionUncertain(recovery);
      if (uncertain?.receipt?.admissionState !== "admission_uncertain") {
        return { delivered: false, reason: "admission-transition-unavailable" };
      }
      recovery.admission = {
        ...admission,
        state: uncertain.receipt.admissionState,
        uncertainAt: uncertain.receipt.admissionUncertainAt,
      };
    }
    if (recovery.admission.state === "admission_uncertain") {
      const probe = await claimAdmissionProbe(recovery);
      if (typeof probe?.receipt?.admissionProbeId !== "string"
        || !probe.receipt.admissionProbeId
        || typeof probe.receipt.admissionProbeRequestedAt !== "string") {
        return { delivered: false, reason: "admission-probe-unavailable" };
      }
      recovery.admissionProbeId = probe.receipt.admissionProbeId;
      recovery.admissionProbeRequestedAt = probe.receipt.admissionProbeRequestedAt;
      await deliverAdmissionRecovery({ ...recovery, mode: "probe" });
      const reconciled = await reconcileAdmission(recovery);
      if (reconciled?.outcome === "absent") {
        return { delivered: false, reason: "admission-deferred" };
      }
      if (reconciled?.outcome !== "present") {
        return { delivered: false, reason: "admission-unresolved" };
      }
      recovery.admission = {
        ...recovery.admission,
        state: reconciled.receipt.admissionState,
        agentName: reconciled.receipt.admissionAgentName,
        agentPath: reconciled.receipt.admissionAgentPath,
        writeScope: reconciled.receipt.admissionWriteScope,
        recoveredAgentThreadId: reconciled.receipt.admissionRecoveredAgentThreadId,
      };
    }
    const delivery = await deliverAdmissionRecovery({ ...recovery, mode: "claim" });
    return {
      delivered: delivery?.delivery === "started" || delivery?.delivery === "steered",
      todoId: recoveryTodo.id,
      reason: "admission-recovery-instructed",
    };
  }
  let capacityReason = null;
  const capacityObservedAt = now();
  const todo = snapshot.todos.find((candidate) => {
    const target = candidate?.dispatchTarget;
    const readyWork = candidate?.readyWork;
    const safeAction = readyWork?.safeActions?.[0];
    const eligible = (
      COORDINATION_ID_PATTERN.test(candidate?.id ?? "")
      && COORDINATION_ID_PATTERN.test(candidate?.taskId ?? "")
      && candidate?.run == null
      && readyWork?.eligible === true
      && Array.isArray(readyWork.safeActions)
      && COORDINATION_ID_PATTERN.test(safeAction?.id ?? "")
      && RESUME_TOKEN_PATTERN.test(readyWork?.resumeToken ?? "")
      && THREAD_ID_PATTERN.test(target?.rootThreadId ?? "")
      && typeof target?.codexHostId === "string"
      && target.codexHostId.length > 0
      && target.codexHostId.length <= 240
      && !/[\u0000-\u001f\u007f]/.test(target.codexHostId)
      && typeof target?.rootWorkspacePath === "string"
      && path.isAbsolute(target.rootWorkspacePath)
      && typeof target?.worktreePath === "string"
      && path.isAbsolute(target.worktreePath)
    );
    if (!eligible) return false;
    const modelRetry = durableModelCapacityRetry(
      snapshot,
      candidate,
      target,
      readyWork,
      safeAction,
      capacityObservedAt,
    );
    if (modelRetry?.staleRoute) {
      capacityReason ??= "stale-model-capacity-retry";
      return false;
    }
    if (modelRetry && !modelRetry.due) {
      capacityReason ??= "model-capacity-backoff";
      return false;
    }
    const capacity = continuationCapacity(snapshot, target, policy, capacityObservedAt);
    if (!capacity.available) {
      if (modelRetry?.due
        && ["capacity-unobserved", "capacity-observation-stale"].includes(capacity.reason)) {
        return true;
      }
      capacityReason ??= capacity.reason;
      return false;
    }
    return true;
  });
  if (!todo) return { delivered: false, reason: capacityReason ?? "no-eligible-work" };

  const safeAction = todo.readyWork.safeActions[0];
  const authorization = {
    todoId: todo.id,
    taskId: todo.taskId,
    rootThreadId: todo.dispatchTarget.rootThreadId,
    safeActionId: safeAction.id,
    expectedResumeToken: todo.readyWork.resumeToken,
  };
  const reservation = await claimReceipt(authorization);
  if (reservation?.completed === true) {
    return { delivered: false, reason: "already-delivered" };
  }
  if (reservation?.available !== true || !reservation.receipt?.id) {
    return { delivered: false, reason: "reservation-unavailable" };
  }
  const recoveryRoute = reservation.recovering === true ? reservation.recoveryRoute : null;
  const dispatch = recoveryRoute ?? todo.dispatchTarget;
  if (recoveryRoute && (
    recoveryRoute.rootThreadId !== reservation.receipt.rootThreadId
    || typeof recoveryRoute.codexHostId !== "string" || !recoveryRoute.codexHostId
    || typeof recoveryRoute.rootWorkspacePath !== "string" || !path.isAbsolute(recoveryRoute.rootWorkspacePath)
    || typeof recoveryRoute.worktreePath !== "string" || !path.isAbsolute(recoveryRoute.worktreePath)
  )) return { delivered: false, reason: "invalid-recovery-route" };
  if (recoveryRoute) {
    authorization.rootThreadId = reservation.receipt.rootThreadId;
    authorization.expectedResumeToken = reservation.receipt.resumeToken;
  }
  authorization.deliveryReceipt = reservation.receipt;
  authorization.recoveryLeaseId = reservation.recoveryLeaseId
    ?? reservation.receipt.reservationLeaseId;
  const executionIdentity = recoveryRoute
    ? reservation.executionIdentity
    : await confirmDelivery(authorization);
  const standingAuthority = safeAction.standingAuthority === true;
  if (!executionIdentity
    || typeof executionIdentity.worktreePath !== "string"
    || path.resolve(executionIdentity.worktreePath) !== path.resolve(dispatch.worktreePath)
    || typeof executionIdentity.branch !== "string"
    || !executionIdentity.branch
    || (standingAuthority && (
      typeof executionIdentity.repository !== "string"
      || !/^(?:github\.com|gitlab\.com)\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(executionIdentity.repository)
    ))) {
    return { delivered: false, reason: "delivery-unavailable" };
  }
  let delivery;
  try {
    delivery = await deliver({
      projectId: policy.projectId,
      todoId: todo.id,
      rootThreadId: dispatch.rootThreadId,
      codexHostId: dispatch.codexHostId,
      rootWorkspacePath: path.resolve(dispatch.rootWorkspacePath),
      targetRoot: path.resolve(dispatch.worktreePath),
      safeActionId: safeAction.id,
      expectedResumeToken: authorization.expectedResumeToken,
      deliveryReceipt: reservation.receipt,
      observeOnly: reservation.observeOnly === true,
      executionIdentity: { ...executionIdentity, standingAuthority },
    });
  } catch (error) {
    if (!isSelectedModelCapacityError(error) || typeof deferAdmission !== "function") throw error;
    const deferred = await deferAdmission({
      ...authorization,
      admissionReceiptId: reservation.receipt.id,
      admissionAttemptId: reservation.receipt.admissionAttemptId,
    });
    if (deferred?.receipt?.admissionState !== "deferred") {
      throw new Error("Taskboard did not durably defer the model-capacity admission attempt");
    }
    return {
      delivered: false,
      todoId: todo.id,
      actionId: safeAction.id,
      reason: "model-capacity-deferred",
    };
  }
  if (reservation.observeOnly === true && delivery?.delivery !== "observed") {
    return { delivered: false, reason: "manual-recovery-required" };
  }
  const completion = await completeDelivery(authorization, delivery);
  if (completion?.completed !== true && completion?.awaitingAdmission !== true) {
    throw new Error("Taskboard did not record the Root coordination delivery");
  }
  return { delivered: true, todoId: todo.id, actionId: safeAction.id };
}

async function deliverTaskboardCoordinationOnce(request, rpc, validateExecutionTarget) {
  const threadResult = await rpc("thread/read", {
    threadId: request.rootThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== request.rootThreadId) {
    throw new Error("Codex did not confirm the configured Root task");
  }
  const rootCwd = typeof threadResult.thread.cwd === "string" ? path.resolve(threadResult.thread.cwd) : null;
  const rootWorkspacePath = path.resolve(request.rootWorkspacePath);
  const targetRoot = path.resolve(request.targetRoot);
  if (!rootCwd || rootWorkspacePath !== rootCwd) {
    throw new Error("Configured Root cwd must exactly match the coordination workspace");
  }
  const instruction = [
    `taskctl issue bootstrap ${request.todoId} --json`,
    `Project: ${request.projectId}`,
    `Todo: ${request.todoId}`,
    `Exact Root thread id: ${request.rootThreadId}`,
    `Expected Capsule resumeToken: ${request.expectedResumeToken}`,
    `Authorized safe action id: ${request.safeActionId}`,
    `Admission receipt id: ${request.deliveryReceipt.id}`,
    `Admission attempt id: ${request.deliveryReceipt.admissionAttemptId}`,
    `Exact execution worktree: ${targetRoot}`,
    ...(request.executionIdentity ? [
      `Verified execution repository: ${request.executionIdentity.repository ?? "not-required"}`,
      `Verified execution branch: ${request.executionIdentity.branch}`,
    ] : []),
    "Before editing or testing, verify the exact execution worktree is a Git worktree and use it for all repository commands. The Root coordination cwd may be different and must not be treated as the execution worktree.",
    "Read the returned Task Capsule and require all of: its resumeToken exactly matches the expected token; readyWork.eligible is true; readyWork.safeActions[0].id exactly matches the authorized safe action id. If any check fails, stop and report the mismatch; do not claim, spawn, or dispatch work.",
    "Execute only readyWork.safeActions[0]. Never execute any readyWork.deferredActions. Coordinate that one bounded action as Root: finish any current safe boundary, choose the smallest explicit bounded write scope from current source evidence, then run taskctl issue admission-prepare with the exact Root thread, Capsule token, safe action, receipt, attempt, and --write-scope. If preparation returns rerouted=true, do not spawn or claim: Taskboard durably assigned the Todo to the unique containing domain and will deliver a fresh fenced attempt there. Otherwise, only after preparation succeeds, spawn exactly one smallest useful Sub-Agent using the returned exact admissionAgentName. Claim the Todo with that exact Sub-Agent path and thread identity, a future lease, the exact prepared write scope, the exact Root thread above (--root-thread-id), and both exact admission ids above (--admission-receipt-id and --admission-attempt-id). The Root delivery turn is not admission; only that exact durable claim admits the child. If platform capacity rejects the spawn, use issue admission-defer with the exact receipt and attempt ids instead of claiming or blindly retrying. Collect the admitted Sub-Agent result back into Root.",
    "Preserve one writer. Do not start Claude or Pi. Do not broaden permissions, deploy, merge, push, install dependencies, use secrets, mutate shared runtimes, or perform financial actions unless separately authorized.",
  ].join("\n");
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const deliveryId = request.deliveryReceipt?.id;
  if (typeof deliveryId !== "string" || !deliveryId) {
    throw new Error("Taskboard coordination requires a durable delivery receipt");
  }
  const observed = turns.find((turn) => collectStringValues(turn)
    .some((text) => text.includes(coordinationDeliveryMarker(
      deliveryId,
      request.deliveryReceipt?.admissionAttemptId,
    ))));
  if (observed?.id) return { delivery: "observed", turnId: observed.id };
  if (request.observeOnly === true) return { delivery: "not-observed", turnId: null };
  await validateExecutionTarget(targetRoot, request.executionIdentity);
  const durableInstruction = `${coordinationDeliveryMarker(
    deliveryId,
    request.deliveryReceipt?.admissionAttemptId,
  )}\n${instruction}`;
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) {
    await rpc("turn/steer", {
      threadId: request.rootThreadId,
      expectedTurnId: activeTurn.id,
      input: [{ type: "text", text: durableInstruction }],
    });
    return { delivery: "steered", turnId: activeTurn.id };
  }
  await rpc("thread/resume", { threadId: request.rootThreadId });
  const started = await rpc("turn/start", {
    threadId: request.rootThreadId,
    input: [{ type: "text", text: durableInstruction }],
  });
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a valid Root turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id };
}

export async function deliverTaskboardAdmissionRecovery(request, rpc) {
  const threadResult = await rpc("thread/read", {
    threadId: request.rootThreadId,
    includeTurns: true,
  });
  if (threadResult?.thread?.id !== request.rootThreadId) {
    throw new Error("Codex did not confirm the admission recovery Root");
  }
  const marker = `Taskboard admission recovery ${request.mode} id: ${request.admissionReceiptId}:${request.admissionAttemptId}${request.mode === "probe" ? `:${request.admissionProbeId}` : ""}`;
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
  const observed = turns.find((turn) => collectStringValues(turn).some((value) => value.includes(marker)));
  if (observed?.id) return { delivery: "observed", turnId: observed.id };
  const instruction = request.mode === "probe"
    ? [
        marker,
        "Admission outcome is uncertain after its durable deadline. Do not spawn, claim, defer, edit, or test.",
        "Invoke collaboration.list_agents exactly once for this Root and then stop at the next safe boundary. Taskboard will reconcile only from that fresh call-linked registry observation.",
      ].join("\n")
    : [
        marker,
        `Existing deterministic child: ${request.admission.agentPath}`,
        `Existing child thread id: ${request.admission.recoveredAgentThreadId}`,
        `Prepared write scope: ${(request.admission.writeScope ?? []).join(",")}`,
        `Admission receipt id: ${request.admissionReceiptId}`,
        `Admission attempt id: ${request.admissionAttemptId}`,
        "Do not spawn another agent. Send one follow-up to that exact existing child instructing it to bootstrap the Todo and claim with its exact path/thread, the exact prepared write scope, this Root thread, and both exact admission ids. If any identity differs, stop without mutation.",
      ].join("\n");
  const activeTurn = [...turns].reverse().find((turn) => turn?.status === "inProgress");
  if (activeTurn?.id) {
    await rpc("turn/steer", {
      threadId: request.rootThreadId,
      expectedTurnId: activeTurn.id,
      input: [{ type: "text", text: instruction }],
    });
    return { delivery: "steered", turnId: activeTurn.id };
  }
  await rpc("thread/resume", { threadId: request.rootThreadId });
  const started = await rpc("turn/start", {
    threadId: request.rootThreadId,
    input: [{ type: "text", text: instruction }],
  });
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a valid admission recovery turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id };
}

export async function handleHostBindingPayload(params, handlers) {
  if (
    typeof handlers.isAuthorizedContext === "function"
    && !handlers.isAuthorizedContext(params.executionContextId)
  ) {
    return { responded: false, accepted: false };
  }

  const parsed = parseHostRequest(params.payload, handlers.parseAutomationRequest);
  if (!parsed.request) {
    if (!parsed.id) return { responded: false, accepted: false };
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.id,
      ok: false,
      error: parsed.error,
      ...(parsed.diagnosticCode ? { diagnosticCode: parsed.diagnosticCode } : {}),
    });
    return { responded: true, accepted: false };
  }

  try {
    let result;
    if (parsed.request.action === "ensure") {
      result = await handlers.ensure();
    } else if (parsed.request.action === "load-frame") {
      result = await handlers.loadFrame(parsed.request);
    } else if (parsed.request.action === "open-external") {
      result = await handlers.openExternal(parsed.request);
    } else if (parsed.request.action === "open-attachment") {
      result = await handlers.openAttachment(parsed.request);
    } else if (parsed.request.action === "automation") {
      result = await handlers.runAutomation(parsed.request, params.executionContextId);
    } else if (parsed.request.action === "coordinate-agent-todo") {
      result = await handlers.coordinateAgentTodo(parsed.request, params.executionContextId);
    } else {
      result = await handlers.startConversation(parsed.request, params.executionContextId);
    }
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: true,
      ...result,
    });
  } catch (error) {
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: false,
      error: error.message,
      ...(typeof error?.threadId === "string" ? { threadId: error.threadId } : {}),
      ...(error?.uncertain === true ? { uncertain: true } : {}),
    });
  }
  return { responded: true, accepted: true };
}

export async function reconcileInjectionRuntime({
  currentStatus,
  source,
  sourceHash,
  removeRegisteredSource,
  registerCurrentSource,
  evaluateCurrentSource,
  publishRegistration,
  reopen,
}) {
  if (currentStatus.scriptIdentifier) {
    try {
      await removeRegisteredSource(currentStatus.scriptIdentifier);
    } catch {}
  }
  const scriptIdentifier = await registerCurrentSource(source);
  await evaluateCurrentSource(source);
  await publishRegistration(scriptIdentifier);
  const replaced = currentStatus.sourceHash !== sourceHash;
  const shouldRemainOpen = currentStatus.pageVisible === true;
  if (replaced && shouldRemainOpen) await reopen();
  return { replaced, scriptIdentifier, shouldRemainOpen };
}

export function createOpenGenerationRouteResolver(resolveRoute) {
  let resolvedGeneration = -1;
  let resolvedRoute = null;
  const inFlight = new Map();

  return async function resolveOpenGenerationRoute(generation) {
    if (generation === resolvedGeneration) return resolvedRoute;
    const pending = inFlight.get(generation);
    if (pending) return pending;
    const resolution = (async () => {
      const route = await resolveRoute();
      if (generation >= resolvedGeneration) {
        resolvedGeneration = generation;
        resolvedRoute = route;
      }
      return route;
    })().finally(() => {
      if (inFlight.get(generation) === resolution) inFlight.delete(generation);
    });
    inFlight.set(generation, resolution);
    return resolution;
  };
}

export function findResidentInjectorPids({
  processList,
  currentPid,
  injectorPath,
  projectRoot,
  port,
  defaultPort,
  cwdForPid,
}) {
  const absoluteScript = new RegExp(
    `(?:^|\\s)${escapeRegExp(injectorPath)}(?=\\s|$)`,
  );
  const relativeScript = /(?:^|\s)(?:\.\/)?scripts\/codex-injector\.mjs(?=\s|$)/;
  const residents = [];

  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === currentPid || !/(?:^|\s)--watch(?=\s|$)/.test(command)) continue;
    const scriptMatches = absoluteScript.test(command)
      || (relativeScript.test(command) && cwdForPid(pid) === projectRoot);
    if (!scriptMatches || commandPort(command, defaultPort) !== port) continue;
    residents.push(pid);
  }
  return residents;
}

export async function restartResidentInjector(port, handlers) {
  const previousPids = handlers.findResidents(port);
  if (previousPids.length === 0) return { previousPids: [], pid: null, restarted: false };

  for (const pid of previousPids) await handlers.stopResident(pid);
  const startupToken = handlers.createStartupToken();
  const started = handlers.startResident(port, startupToken);
  await handlers.waitUntilReady(port, started.pid, startupToken);
  return {
    previousPids,
    pid: started.pid,
    restarted: true,
  };
}

function commandPort(command, defaultPort) {
  const match = command.match(/(?:^|\s)--port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
  return match ? Number(match[1] ?? match[2]) : defaultPort;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
