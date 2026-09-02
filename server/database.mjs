import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_LABEL_NAMES, JIRA_PROJECT_ID } from "../shared/domain.mjs";
import { createTaskCapsule } from "./task-capsule.mjs";
import { normalizeRepository, normalizeStandingActions } from "./standing-authority.mjs";

const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const OWNER_DECISION_DELIVERY_TTL_MS = 30_000;
const OWNER_DECISION_RESPONSE_TTL_MS = 24 * 60 * 60 * 1_000;
const OWNER_INTENT_ADOPTION_TTL_MS = 30_000;
const OWNER_INTENT_PLAN_RETRY_LIMIT = 3;
const CROSS_DOMAIN_HANDOFF_DELIVERY_TTL_MS = 30_000;
const TASK_SAFE_ACTION_RESERVATION_TTL_MS = 30_000;
const TASK_SAFE_ACTION_ADMISSION_TTL_MS = 60_000;
const DATABASE_STATEMENT_CACHE_MAX = 512;
const MODEL_CAPACITY_RETRY_BASE_MS = 15_000;
const MODEL_CAPACITY_RETRY_MAX_MS = 5 * 60_000;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function agentLaneConfigRevision(configJson) {
  return createHash("sha256").update(configJson).digest("hex");
}

function isFullyBoundCodexPeerTask(task) {
  return Boolean(
    task?.source === "codex"
    && task?.taskType === "peer_task"
    && typeof task.threadId === "string"
    && task.threadId.trim()
    && typeof task.codexHostId === "string"
    && task.codexHostId.trim()
    && typeof task.workspacePath === "string"
    && path.isAbsolute(task.workspacePath),
  );
}

function coordinationWindowReceiptFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    role: row.role,
    taskId: row.task_id,
    threadId: row.thread_id,
    configRevision: row.config_revision,
    createdAt: row.created_at,
  };
}

function coordinationDomainReceiptFromRow(row) {
  return {
    id: row.id, projectId: row.project_id, domainId: row.domain_id,
    idempotencyKey: row.idempotency_key, action: row.action,
    configRevision: row.config_revision, createdAt: row.created_at,
  };
}

function coordinationWindowConfiguration(projectId, row) {
  const config = JSON.parse(row.config_json);
  return {
    projectId,
    revision: agentLaneConfigRevision(row.config_json),
    ownerRootTaskId: config.ownerRootTaskId ?? null,
    coordinatorLease: config.coordinatorLease ?? null,
    windows: (Array.isArray(config.tasks) ? config.tasks : [])
      .filter((task) => task?.source === "codex" && task?.taskType === "root_task")
      .map((task) => ({
        taskId: task.id,
        label: task.label,
        role: task.id === config.ownerRootTaskId ? "owner_root" : "coordinator",
        threadId: task.threadId ?? null,
        codexHostId: task.codexHostId ?? null,
        workspacePath: task.workspacePath ?? null,
      })),
  };
}

function modelCapacityRetryDelay(retryCount) {
  return Math.min(
    MODEL_CAPACITY_RETRY_MAX_MS,
    MODEL_CAPACITY_RETRY_BASE_MS * (2 ** Math.min(Math.max(0, retryCount - 1), 10)),
  );
}

function deterministicAdmissionAgentName(task, admissionAttemptId) {
  const taskPart = task.identifier.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const attemptPart = admissionAttemptId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  return `${taskPart || "task"}_admission_${attemptPart}`;
}

function normalizeWorkingLog(workingLog, developmentContext) {
  if (!workingLog) return null;
  if (developmentContext?.type !== "worktree" || !developmentContext.path) {
    throw new ApiError(400, "INVALID_WORKING_LOG", "A Working Log requires a task worktree");
  }
  if (typeof workingLog.path !== "string" || !path.isAbsolute(workingLog.path)) {
    throw new ApiError(400, "INVALID_WORKING_LOG", "Working Log path must be absolute");
  }
  if (!["planned", "active", "blocked", "complete"].includes(workingLog.status)) {
    throw new ApiError(400, "INVALID_WORKING_LOG", "Working Log status is invalid");
  }
  const worktreePath = path.resolve(developmentContext.path);
  const workingLogPath = path.resolve(workingLog.path);
  const relative = path.relative(worktreePath, workingLogPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiError(400, "INVALID_WORKING_LOG", "Working Log path must be inside the task worktree");
  }
  return { path: workingLogPath, status: workingLog.status };
}

function normalizeAgentWriteScope(writeScope, worktreePath) {
  const pathApi = path.win32.isAbsolute(worktreePath) && !path.posix.isAbsolute(worktreePath)
    ? path.win32
    : path.posix;
  return [...new Set(writeScope.map((item) => {
    const raw = item.trim();
    if (
      path.posix.isAbsolute(raw)
      || path.win32.isAbsolute(raw)
      || raw.split(/[\\/]+/).includes("..")
    ) {
      throw new ApiError(
        400,
        "INVALID_AGENT_WRITE_SCOPE",
        "Agent write scope entries must be relative paths inside the task worktree",
      );
    }
    const normalized = pathApi.normalize(raw.replace(/[\\/]+/g, pathApi.sep));
    if (
      normalized === "."
      || normalized === ".."
      || normalized.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(normalized)
    ) {
      throw new ApiError(
        400,
        "INVALID_AGENT_WRITE_SCOPE",
        "Agent write scope entries must be relative paths inside the task worktree",
      );
    }
    const resolved = pathApi.resolve(worktreePath, normalized);
    const relative = pathApi.relative(worktreePath, resolved);
    if (
      !relative
      || relative === ".."
      || relative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(relative)
    ) {
      throw new ApiError(
        400,
        "INVALID_AGENT_WRITE_SCOPE",
        "Agent write scope entries must be relative paths inside the task worktree",
      );
    }
    return relative;
  }))];
}

function normalizeCoordinationDomains(config) {
  if (config.coordinationDomains === undefined) return [];
  if (!Array.isArray(config.coordinationDomains) || config.coordinationDomains.length > 32) {
    throw new ApiError(400, "INVALID_COORDINATION_DOMAINS", "Coordination domains must be an array of at most 32 entries");
  }
  const domains = config.coordinationDomains.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(400, "INVALID_COORDINATION_DOMAIN", "Each coordination domain must be an object");
    }
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || !label || label.length > 80) {
      throw new ApiError(400, "INVALID_COORDINATION_DOMAIN", "Coordination domain id or label is invalid");
    }
    if (!Array.isArray(value.writeScope) || value.writeScope.length === 0 || value.writeScope.length > 32) {
      throw new ApiError(400, "INVALID_COORDINATION_DOMAIN_SCOPE", "Coordination domain writeScope must contain 1 to 32 paths");
    }
    const writeScope = [...new Set(value.writeScope.map((entry) => {
      const raw = typeof entry === "string" ? entry.trim().replaceAll("\\", "/") : "";
      if (!raw || raw.length > 240 || path.posix.isAbsolute(raw) || raw.split("/").includes("..")) {
        throw new ApiError(400, "INVALID_COORDINATION_DOMAIN_SCOPE", "Coordination domain scopes must be relative paths");
      }
      const normalized = path.posix.normalize(raw).replace(/\/$/, "");
      if (!normalized || normalized === "." || normalized.startsWith("../")) {
        throw new ApiError(400, "INVALID_COORDINATION_DOMAIN_SCOPE", "Coordination domain scopes must be relative paths");
      }
      return normalized;
    }))];
    if (!Array.isArray(value.eligibleTaskIds) || value.eligibleTaskIds.length === 0 || value.eligibleTaskIds.length > 32) {
      throw new ApiError(400, "INVALID_COORDINATION_DOMAIN_HOLDERS", "Coordination domain eligibleTaskIds must contain 1 to 32 configured peer ids");
    }
    const eligibleTaskIds = [...new Set(value.eligibleTaskIds.map((entry) => (
      typeof entry === "string" ? entry.trim() : ""
    )))];
    if (eligibleTaskIds.some((entry) => !entry || entry.length > 256)) {
      throw new ApiError(400, "INVALID_COORDINATION_DOMAIN_HOLDERS", "Coordination domain holder ids are invalid");
    }
    return { id, label, writeScope, eligibleTaskIds };
  });
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    throw new ApiError(400, "DUPLICATE_COORDINATION_DOMAIN", "Coordination domain ids must be unique");
  }
  for (let leftIndex = 0; leftIndex < domains.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < domains.length; rightIndex += 1) {
      for (const leftScope of domains[leftIndex].writeScope) {
        for (const rightScope of domains[rightIndex].writeScope) {
          const comparableLeftScope = leftScope.toLocaleLowerCase("en-US");
          const comparableRightScope = rightScope.toLocaleLowerCase("en-US");
          if (
            comparableLeftScope === comparableRightScope
            || comparableLeftScope.startsWith(`${comparableRightScope}/`)
            || comparableRightScope.startsWith(`${comparableLeftScope}/`)
          ) {
            throw new ApiError(409, "COORDINATION_DOMAIN_SCOPE_OVERLAP", "Coordination domain write scopes must not overlap");
          }
        }
      }
    }
  }
  const configuredPeerTaskIds = new Set((Array.isArray(config.tasks) ? config.tasks : [])
    .filter(isFullyBoundCodexPeerTask)
    .map((task) => task.id));
  if (domains.some((domain) => domain.eligibleTaskIds.some((taskId) => !configuredPeerTaskIds.has(taskId)))) {
    throw new ApiError(409, "COORDINATION_DOMAIN_BINDING_MISMATCH", "Coordination domain holders must be configured peer windows");
  }
  return domains;
}

function sameCoordinationDomainPolicy(left, right) {
  if (!left || !right) return false;
  const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(sorted(left.writeScope)) === JSON.stringify(sorted(right.writeScope))
    && JSON.stringify(sorted(left.eligibleTaskIds)) === JSON.stringify(sorted(right.eligibleTaskIds));
}

function sameCoordinationDomainConfiguration(left, right) {
  if (!left || !right) return left === right;
  return left.id === right.id
    && left.label === right.label
    && sameCoordinationDomainPolicy(left, right);
}

export function defaultIsPathCaseSensitive(worktreePath, {
  lstat = lstatSync,
  readdir = readdirSync,
} = {}) {
  const pathApi = path.win32.isAbsolute(worktreePath) && !path.posix.isAbsolute(worktreePath)
    ? path.win32
    : path.posix;
  let existingPath = pathApi.resolve(worktreePath);
  let existingStat;
  while (true) {
    try {
      existingStat = lstat(existingPath);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return true;
      const parent = pathApi.dirname(existingPath);
      if (parent === existingPath) return true;
      existingPath = parent;
    }
  }
  if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) return true;

  let directoryEntries;
  try {
    directoryEntries = readdir(existingPath, { withFileTypes: true });
  } catch {
    return true;
  }
  const probeEntry = directoryEntries.find((entry) => /[A-Za-z]/.test(entry.name));
  if (!probeEntry) return true;

  const alternateName = probeEntry.name.replace(/[A-Za-z]/, (character) => (
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
  ));
  if (alternateName === probeEntry.name) return true;
  if (directoryEntries.some((entry) => entry.name === alternateName)) return true;
  try {
    const actual = lstat(pathApi.join(existingPath, probeEntry.name));
    const alternate = lstat(pathApi.join(existingPath, alternateName));
    return actual.dev !== alternate.dev || actual.ino !== alternate.ino;
  } catch {
    return true;
  }
}

function scopeIsContainedBy(writeScope, domainScope, caseSensitive) {
  const comparable = (value) => {
    const normalized = value.replaceAll("\\", "/");
    return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
  };
  const candidate = comparable(writeScope);
  return domainScope.some((entry) => {
    const boundary = comparable(entry);
    return candidate === boundary || candidate.startsWith(`${boundary}/`);
  });
}

function agentTaskDomainAssignmentFromRow(row) {
  return row ? {
    taskId: row.task_id,
    projectId: row.project_id,
    domainId: row.domain_id,
    assignedByLeaseId: row.assigned_by_lease_id,
    assignedByTaskId: row.assigned_by_task_id,
    assignedByThreadId: row.assigned_by_thread_id,
    assignedAt: row.assigned_at,
    updatedAt: row.updated_at,
  } : null;
}

function sameThreadBinding(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.threadId === right.threadId
    && left.codexProjectId === right.codexProjectId
    && left.codexProjectKind === right.codexProjectKind
    && left.codexHostId === right.codexHostId
    && left.workspacePath === right.workspacePath;
}

function sameDevelopmentContext(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.type === right.type
    && left.path === right.path
    && left.branch === right.branch
    && left.repository === right.repository
    && left.repositoryVerifiedAt === right.repositoryVerifiedAt;
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? {
      type: "worktree",
      path: row.worktree_path,
      branch: row.worktree_branch,
      ...(row.worktree_repository ? { repository: row.worktree_repository } : {}),
      ...(row.worktree_repository_verified_at
        ? { repositoryVerifiedAt: row.worktree_repository_verified_at }
        : {}),
    }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    workflowProfile: row.workflow_profile ?? "formal",
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    developmentContext,
    workingLog: row.working_log_path && row.working_log_status && row.working_log_updated_at
      ? {
        path: row.working_log_path,
        status: row.working_log_status,
        updatedAt: row.working_log_updated_at,
      }
      : null,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    source: row.external_source === "jira" ? "jira" : "local",
    externalOrigin: row.external_origin ?? null,
    externalKey: row.external_key ?? null,
    externalUrl: row.external_url ?? null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function standingAuthorityFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    repository: row.repository,
    actions: JSON.parse(row.actions_json),
    sourceTaskId: row.source_task_id,
    sourceThreadId: row.source_thread_id,
    evidence: row.evidence,
    receipt: row.receipt,
    recordedBy: { type: row.recorded_by_type, id: row.recorded_by_id, name: row.recorded_by_name },
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationEvidence: row.revocation_evidence,
    revocationReceipt: row.revocation_receipt,
    revokedBy: row.revoked_by_type ? {
      type: row.revoked_by_type, id: row.revoked_by_id, name: row.revoked_by_name,
    } : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ownerDecisionReceiptFromRow(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    taskId: row.task_id,
    projectId: row.project_id,
    actionId: row.action_id,
    gateId: row.gate_id,
    expectedResumeToken: row.expected_resume_token,
    outcome: row.outcome,
    rootTaskId: row.root_task_id,
    rootThreadId: row.root_thread_id,
    coordinatorEpoch: row.coordinator_epoch,
    ownerTurnId: row.owner_turn_id,
    rootDecisionTurnId: row.root_decision_turn_id,
    evidence: row.evidence,
    receipt: row.receipt,
    decidedAt: row.decided_at,
    deliveryId: row.delivery_id,
    authorizationCommentId: row.authorization_comment_id,
    authorizationCommentVersion: row.authorization_comment_version,
    recordedBy: {
      type: row.recorded_by_type,
      id: row.recorded_by_id,
      name: row.recorded_by_name,
    },
    createdAt: row.created_at,
  };
}

function projectOwnerIntentFromRow(row) {
  return {
    id: row.id,
    intentId: row.id,
    deliveryId: row.delivery_id,
    projectId: row.project_id,
    kind: row.kind,
    goal: row.goal,
    constraints: JSON.parse(row.constraints_json),
    targetIntentId: row.target_intent_id,
    ownerRootTaskId: row.owner_root_task_id,
    ownerRootThreadId: row.owner_root_thread_id,
    sourceThreadBinding: {
      threadId: row.owner_root_thread_id,
      codexProjectId: row.source_codex_project_id,
      codexProjectKind: row.source_codex_project_kind,
      codexHostId: row.source_codex_host_id,
      workspacePath: row.source_workspace_path,
    },
    ownerTurnId: row.owner_turn_id,
    rootCaptureTurnId: row.root_capture_turn_id,
    evidence: row.evidence,
    status: row.status,
    planRetryCount: row.plan_retry_count ?? 0,
    planRetryAfter: row.plan_retry_after ?? null,
    executionDisposition: "current_execution_continues",
    recordedBy: {
      type: row.recorded_by_type,
      id: row.recorded_by_id,
      name: row.recorded_by_name,
    },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ownerIntentExecutionFromRow(row) {
  return {
    intentId: row.id,
    version: row.version,
    kind: row.kind,
    targetIntentId: row.target_intent_id,
    goal: row.goal,
    constraints: JSON.parse(row.constraints_json),
  };
}

function ownerIntentAdoptionFromRow(row) {
  return {
    id: row.id,
    intentId: row.intent_id,
    projectId: row.project_id,
    coordinatorTaskId: row.coordinator_task_id,
    coordinatorThreadId: row.coordinator_thread_id,
    coordinatorEpoch: row.coordinator_epoch,
    state: row.state,
    reservationExpiresAt: row.reservation_expires_at,
    claimedAt: row.claimed_at,
    deliveryTurnId: row.delivery_turn_id,
    adoptedAt: row.adopted_at,
  };
}

function ownerIntentPlanRevisionFromRow(row, items = []) {
  return {
    id: row.id,
    projectId: row.project_id,
    intentId: row.intent_id,
    intentVersion: row.intent_version,
    adoptionId: row.adoption_id,
    coordinatorTaskId: row.coordinator_task_id,
    coordinatorThreadId: row.coordinator_thread_id,
    coordinatorEpoch: row.coordinator_epoch,
    classification: row.classification,
    status: row.status,
    summary: row.summary,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    version: row.version,
    externalKey: row.external_key ?? null,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    startDate: row.start_date,
    dueDate: row.due_date,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function taskAgentRunFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    role: row.role,
    status: row.status,
    version: row.version,
    rootThreadId: row.root_thread_id,
    agentPath: row.agent_path,
    agentThreadId: row.agent_thread_id,
    worktree: {
      path: row.worktree_path,
      branch: row.worktree_branch,
    },
    writeScope: JSON.parse(row.write_scope_json ?? "[]"),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    nextAction: row.next_action,
  };
}

function commentFromRow(row) {
  const comment = {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(comment, "changeRevision", { value: row.change_revision });
  return comment;
}

function taskInboxDeliveryReceiptFromRow(row) {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    taskId: row.task_id,
    projectId: row.project_id,
    commentId: row.comment_id,
    sourceThreadId: row.source_thread_id,
    status: "queued",
    executionDisposition: "current_execution_continues",
    createdAt: row.created_at,
  };
}

function coordinationAcknowledgementFromRow(row) {
  return {
    id: row.id,
    acknowledgementId: row.acknowledgement_id,
    eventId: row.event_id,
    senderThreadId: row.sender_thread_id,
    senderAgentPath: row.sender_agent_path,
    createdAt: row.created_at,
  };
}

function coordinationEventFromRow(row, acknowledgements = []) {
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    projectId: row.project_id,
    commentId: row.comment_id,
    envelope: JSON.parse(row.envelope_json),
    acknowledgements,
    createdAt: row.created_at,
  };
}

function coordinationCommentBody(envelope) {
  const evidence = envelope.evidenceRefs.length > 0
    ? envelope.evidenceRefs.map((reference) => `- ${reference}`).join("\n")
    : "- none";
  return [
    "Agent Handoff",
    "",
    `Summary: ${envelope.summary}`,
    `Blocker: ${envelope.blocker ?? "none"}`,
    `Next action: ${envelope.nextAction}`,
    "Evidence:",
    evidence,
    `Event: ${envelope.eventId}`,
  ].join("\n");
}

function attachmentFromRow(row) {
  const attachment = {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
  Object.defineProperty(attachment, "changeRevision", { value: row.change_revision });
  return attachment;
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    source: row.id === JIRA_PROJECT_ID ? "jira" : "local",
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
  };
}

function projectReadmeFromRow(row, projectId) {
  return {
    projectId: row.project_id ?? projectId,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    latestTodo: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = [...project.name.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "")]
    .slice(0, 3)
    .join("");
  return namePrefix || idPrefix.slice(0, 3);
}

function activationWorkflowProfileCandidate(row) {
  return {
    taskId: row.task_id,
    identifier: row.identifier,
    projectId: row.project_id,
    taskVersion: row.task_version,
    suggestedProfile: row.suggested_profile,
    observedLabels: JSON.parse(row.observed_labels),
    status: row.status,
    detectedAt: row.detected_at,
    appliedAt: row.applied_at,
  };
}

export class TaskboardDatabase {
  constructor(filename, {
    admissionTtlMs = TASK_SAFE_ACTION_ADMISSION_TTL_MS,
    isPathCaseSensitive = defaultIsPathCaseSensitive,
    statementCacheMax = DATABASE_STATEMENT_CACHE_MAX,
  } = {}) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.statementCache = new Map();
    this.statementCacheMax = Number.isSafeInteger(statementCacheMax) && statementCacheMax > 0
      ? statementCacheMax
      : DATABASE_STATEMENT_CACHE_MAX;
    this.admissionTtlMs = Number.isSafeInteger(admissionTtlMs) && admissionTtlMs > 0
      ? admissionTtlMs
      : TASK_SAFE_ACTION_ADMISSION_TTL_MS;
    this.isPathCaseSensitive = typeof isPathCaseSensitive === "function"
      ? isPathCaseSensitive
      : defaultIsPathCaseSensitive;
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    // Migration may change schemas after preparing introspection statements.
    // Runtime statements are cached from a clean post-migration boundary.
    this.statementCache.clear();
    this.interruptAbandonedAiChatRuns();
  }

  #prepare(sql) {
    let statement = this.statementCache.get(sql);
    if (statement) {
      this.statementCache.delete(sql);
      this.statementCache.set(sql, statement);
      return statement;
    }
    statement = this.database.prepare(sql);
    if (this.statementCache.size >= this.statementCacheMax) {
      const oldestSql = this.statementCache.keys().next().value;
      this.statementCache.delete(oldestSql);
    }
    this.statementCache.set(sql, statement);
    return statement;
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        workflow_profile TEXT NOT NULL DEFAULT 'formal' CHECK (workflow_profile IN ('formal', 'vibe')),
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        worktree_repository TEXT,
        worktree_repository_verified_at TEXT,
        working_log_path TEXT,
        working_log_status TEXT CHECK (working_log_status IN ('planned', 'active', 'blocked', 'complete')),
        working_log_updated_at TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        plan_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (plan_retry_count >= 0),
        plan_retry_after TEXT,
        plan_last_failure_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_activation_workflow_profile_candidates (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        task_version INTEGER NOT NULL CHECK (task_version > 0),
        suggested_profile TEXT NOT NULL CHECK (suggested_profile = 'vibe'),
        observed_labels TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
        detected_at TEXT NOT NULL,
        applied_at TEXT,
        applied_by_type TEXT,
        applied_by_id TEXT,
        applied_by_name TEXT,
        task_version_after INTEGER
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS project_standing_authorities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repository TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        source_task_id TEXT NOT NULL REFERENCES tasks(id),
        source_thread_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        receipt TEXT NOT NULL UNIQUE,
        recorded_by_type TEXT NOT NULL CHECK (recorded_by_type IN ('user', 'agent')),
        recorded_by_id TEXT NOT NULL,
        recorded_by_name TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        revocation_evidence TEXT,
        revocation_receipt TEXT UNIQUE,
        revoked_by_type TEXT CHECK (revoked_by_type IS NULL OR revoked_by_type IN ('user', 'agent')),
        revoked_by_id TEXT,
        revoked_by_name TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS standing_authorities_project_repository
        ON project_standing_authorities(project_id, repository, revoked_at, expires_at);

      CREATE TABLE IF NOT EXISTS owner_decision_deliveries (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        expected_resume_token TEXT NOT NULL,
        coordinator_epoch TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        root_thread_id TEXT NOT NULL,
        codex_host_id TEXT NOT NULL,
        root_workspace_path TEXT NOT NULL,
        route_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'delivered')),
        reservation_expires_at TEXT NOT NULL,
        decision_expires_at TEXT,
        claimed_at TEXT NOT NULL,
        delivered_at TEXT,
        delivery_turn_id TEXT
      );

      CREATE INDEX IF NOT EXISTS owner_decision_deliveries_request
        ON owner_decision_deliveries(project_id, request_id, claimed_at DESC);

      CREATE TABLE IF NOT EXISTS task_owner_decision_receipts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        expected_resume_token TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('authorized', 'denied')),
        root_task_id TEXT NOT NULL,
        root_thread_id TEXT NOT NULL,
        coordinator_epoch TEXT NOT NULL,
        owner_turn_id TEXT NOT NULL,
        root_decision_turn_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        receipt TEXT NOT NULL UNIQUE,
        decided_at TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE REFERENCES owner_decision_deliveries(id),
        authorization_comment_id TEXT NOT NULL REFERENCES comments(id),
        authorization_comment_version INTEGER NOT NULL CHECK (authorization_comment_version > 0),
        recorded_by_type TEXT NOT NULL CHECK (recorded_by_type = 'agent'),
        recorded_by_id TEXT NOT NULL,
        recorded_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS owner_decisions_task_created
        ON task_owner_decision_receipts(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS owner_decisions_project_created
        ON task_owner_decision_receipts(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_lane_projects (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_coordinator_lease_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL,
        holder_task_id TEXT NOT NULL,
        holder_thread_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('acquired', 'renewed', 'released')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_coordinator_lease_receipts_project_created
        ON agent_coordinator_lease_receipts(project_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS agent_coordination_window_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner_root', 'coordinator')),
        task_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        config_revision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS agent_coordination_window_receipts_project_created
        ON agent_coordination_window_receipts(project_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS agent_coordination_domain_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('configured', 'removed')),
        config_revision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS agent_domain_coordinator_lease_receipts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        holder_task_id TEXT NOT NULL,
        holder_thread_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('acquired', 'renewed', 'released')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_domain_coordinator_receipts_project_created
        ON agent_domain_coordinator_lease_receipts(project_id, domain_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS agent_task_domain_assignments (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL,
        assigned_by_lease_id TEXT NOT NULL,
        assigned_by_task_id TEXT NOT NULL,
        assigned_by_thread_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_task_domain_assignments_project_domain
        ON agent_task_domain_assignments(project_id, domain_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_task_domain_provenance (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL,
        assigned_by_lease_id TEXT NOT NULL,
        assigned_by_task_id TEXT NOT NULL,
        assigned_by_thread_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cleared_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cross_domain_dependency_clearances (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_task_version INTEGER NOT NULL,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_version INTEGER NOT NULL,
        edge_created_at TEXT NOT NULL,
        source_domain_id TEXT NOT NULL,
        source_assigned_by_lease_id TEXT NOT NULL,
        source_assigned_by_task_id TEXT NOT NULL,
        source_assigned_by_thread_id TEXT NOT NULL,
        source_assignment_updated_at TEXT NOT NULL,
        target_domain_id TEXT NOT NULL,
        target_assigned_by_lease_id TEXT NOT NULL,
        target_assigned_by_task_id TEXT NOT NULL,
        target_assigned_by_thread_id TEXT NOT NULL,
        target_assignment_updated_at TEXT NOT NULL,
        target_domain_lease_id TEXT NOT NULL,
        target_holder_task_id TEXT NOT NULL,
        target_holder_thread_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS cross_domain_dependency_clearances_target
        ON cross_domain_dependency_clearances(target_task_id, source_task_id, accepted_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS cross_domain_handoff_deliveries (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_holder_thread_id TEXT NOT NULL,
        target_codex_host_id TEXT NOT NULL,
        target_workspace_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'delivered')),
        reservation_expires_at TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        delivered_at TEXT,
        delivery_turn_id TEXT
      );

      CREATE INDEX IF NOT EXISTS cross_domain_handoff_deliveries_target
        ON cross_domain_handoff_deliveries(target_task_id, source_task_id, claimed_at DESC);

      CREATE TABLE IF NOT EXISTS task_inbox_delivery_receipts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        source_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, delivery_id)
      );

      CREATE INDEX IF NOT EXISTS task_inbox_delivery_receipts_task_created
        ON task_inbox_delivery_receipts(task_id, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS project_owner_intents (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('append', 'supersede', 'clarify', 'cancel')),
        goal TEXT NOT NULL,
        constraints_json TEXT NOT NULL DEFAULT '[]',
        target_intent_id TEXT REFERENCES project_owner_intents(id),
        owner_root_task_id TEXT NOT NULL,
        owner_root_thread_id TEXT NOT NULL,
        source_codex_project_id TEXT NOT NULL,
        source_codex_project_kind TEXT NOT NULL CHECK (source_codex_project_kind IN ('local', 'remote')),
        source_codex_host_id TEXT NOT NULL,
        source_workspace_path TEXT NOT NULL,
        owner_turn_id TEXT NOT NULL,
        root_capture_turn_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (
          status IN ('queued', 'adopted', 'superseded', 'needs_decision', 'canceled')
        ),
        recorded_by_type TEXT NOT NULL CHECK (recorded_by_type = 'agent'),
        recorded_by_id TEXT NOT NULL,
        recorded_by_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, owner_root_thread_id, owner_turn_id),
        UNIQUE(project_id, root_capture_turn_id)
      );

      CREATE INDEX IF NOT EXISTS project_owner_intents_project_status_created
        ON project_owner_intents(project_id, status, created_at, id);

      CREATE TABLE IF NOT EXISTS owner_intent_adoptions (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE REFERENCES project_owner_intents(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        coordinator_task_id TEXT NOT NULL,
        coordinator_thread_id TEXT NOT NULL,
        coordinator_epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'adopted')),
        reservation_expires_at TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        delivery_turn_id TEXT,
        adopted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS owner_intent_adoptions_project_state
        ON owner_intent_adoptions(project_id, state, claimed_at, id);

      CREATE TABLE IF NOT EXISTS owner_intent_plan_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        intent_id TEXT NOT NULL UNIQUE REFERENCES project_owner_intents(id) ON DELETE CASCADE,
        intent_version INTEGER NOT NULL CHECK (intent_version > 0),
        adoption_id TEXT NOT NULL UNIQUE REFERENCES owner_intent_adoptions(id) ON DELETE CASCADE,
        coordinator_task_id TEXT NOT NULL,
        coordinator_thread_id TEXT NOT NULL,
        coordinator_epoch TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN (
          'bounded_delivery', 'new_product_scope', 'financial_decision',
          'metric_policy', 'missing_authority'
        )),
        status TEXT NOT NULL CHECK (status IN ('applied', 'needs_decision')),
        summary TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owner_intent_plan_items (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES owner_intent_plan_revisions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        intent_id TEXT NOT NULL REFERENCES project_owner_intents(id) ON DELETE CASCADE,
        outcome_key TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        disposition TEXT NOT NULL CHECK (disposition IN (
          'created', 'reused', 'updated', 'preserved_active', 'canceled'
        )),
        created_at TEXT NOT NULL,
        UNIQUE(revision_id, outcome_key),
        UNIQUE(revision_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS owner_intent_plan_dependencies (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES owner_intent_plan_revisions(id) ON DELETE CASCADE,
        intent_id TEXT NOT NULL REFERENCES project_owner_intents(id) ON DELETE CASCADE,
        owns_relation INTEGER NOT NULL CHECK (owns_relation IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS owner_intent_plan_dependencies_target
        ON owner_intent_plan_dependencies(project_id, target_task_id);

      CREATE INDEX IF NOT EXISTS owner_intent_plan_revisions_project_created
        ON owner_intent_plan_revisions(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_safe_action_receipts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        resume_token TEXT NOT NULL,
        safe_action_id TEXT NOT NULL,
        root_thread_id TEXT NOT NULL,
        global_coordinator_lease_id TEXT,
        global_coordinator_task_id TEXT,
        global_coordinator_thread_id TEXT,
        coordination_domain_id TEXT,
        domain_coordinator_lease_id TEXT,
        domain_coordinator_task_id TEXT,
        domain_coordinator_thread_id TEXT,
        root_host_id TEXT,
        root_workspace_path TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        claimed_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'delivering', 'delivered', 'legacy')),
        reservation_lease_id TEXT,
        lease_expires_at TEXT,
        recovery_lease_id TEXT,
        recovery_lease_expires_at TEXT,
        delivered_at TEXT,
        delivery_turn_id TEXT,
        admission_attempt_id TEXT,
        admission_state TEXT NOT NULL DEFAULT 'none',
        admission_agent_name TEXT,
        admission_agent_path TEXT,
        admission_write_scope_json TEXT,
        admission_prepared_at TEXT,
        admission_deadline_at TEXT,
        admission_uncertain_at TEXT,
        admission_registry_observed_at TEXT,
        admission_recovered_agent_thread_id TEXT,
        admission_probe_id TEXT,
        admission_probe_requested_at TEXT,
        admission_deferred_reason TEXT,
        admission_retry_count INTEGER NOT NULL DEFAULT 0,
        admission_retry_after TEXT,
        admitted_run_id TEXT,
        admitted_agent_thread_id TEXT,
        admitted_at TEXT,
        UNIQUE(task_id, resume_token)
      );

      CREATE TABLE IF NOT EXISTS agent_task_claims (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_path TEXT NOT NULL,
        agent_thread_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT,
        write_scope_json TEXT NOT NULL DEFAULT '[]',
        completed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS agent_task_claims_one_active_thread
        ON agent_task_claims(project_id, agent_thread_id)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS task_agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('sub_agent')),
        status TEXT NOT NULL CHECK (status IN (
          'active', 'blocked', 'completed', 'failed', 'interrupted', 'expired'
        )),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        root_thread_id TEXT NOT NULL,
        agent_path TEXT NOT NULL,
        agent_thread_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        worktree_branch TEXT NOT NULL,
        write_scope_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        next_action TEXT
      );

      CREATE INDEX IF NOT EXISTS task_agent_runs_task_updated
        ON task_agent_runs(task_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS agent_event_receipts (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        envelope_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_event_acknowledgements (
        id TEXT PRIMARY KEY,
        acknowledgement_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES agent_event_receipts(event_id) ON DELETE CASCADE,
        sender_thread_id TEXT NOT NULL,
        sender_agent_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, acknowledgement_id)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS comment_attachment_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      );

      CREATE TABLE IF NOT EXISTS project_readmes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_readme_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

    `);

    const projectColumns = this.#prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const ownerDecisionDeliveryColumns = this.#prepare(
      "PRAGMA table_info(owner_decision_deliveries)",
    ).all();
    if (!ownerDecisionDeliveryColumns.some((column) => column.name === "decision_expires_at")) {
      this.database.exec("ALTER TABLE owner_decision_deliveries ADD COLUMN decision_expires_at TEXT");
    }

    const ownerIntentColumns = this.#prepare(
      "PRAGMA table_info(project_owner_intents)",
    ).all();
    if (!ownerIntentColumns.some((column) => column.name === "plan_retry_count")) {
      this.database.exec("ALTER TABLE project_owner_intents ADD COLUMN plan_retry_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!ownerIntentColumns.some((column) => column.name === "plan_retry_after")) {
      this.database.exec("ALTER TABLE project_owner_intents ADD COLUMN plan_retry_after TEXT");
    }
    if (!ownerIntentColumns.some((column) => column.name === "plan_last_failure_key")) {
      this.database.exec("ALTER TABLE project_owner_intents ADD COLUMN plan_last_failure_key TEXT");
    }

    const crossDomainHandoffDeliveryColumns = this.#prepare(
      "PRAGMA table_info(cross_domain_handoff_deliveries)",
    ).all();
    if (!crossDomainHandoffDeliveryColumns.some((column) => column.name === "target_codex_host_id")) {
      this.database.exec("ALTER TABLE cross_domain_handoff_deliveries ADD COLUMN target_codex_host_id TEXT");
    }
    if (!crossDomainHandoffDeliveryColumns.some((column) => column.name === "target_workspace_path")) {
      this.database.exec("ALTER TABLE cross_domain_handoff_deliveries ADD COLUMN target_workspace_path TEXT");
    }

    const safeActionReceiptColumns = this.#prepare(
      "PRAGMA table_info(task_safe_action_receipts)",
    ).all();
    const hadSafeActionReceiptStatus = safeActionReceiptColumns.some((column) => column.name === "status");
    if (!hadSafeActionReceiptStatus) {
      this.database.exec("ALTER TABLE task_safe_action_receipts ADD COLUMN status TEXT NOT NULL DEFAULT 'reserved'");
    }
    if (!safeActionReceiptColumns.some((column) => column.name === "reservation_lease_id")) {
      this.database.exec("ALTER TABLE task_safe_action_receipts ADD COLUMN reservation_lease_id TEXT");
    }
    if (!safeActionReceiptColumns.some((column) => column.name === "lease_expires_at")) {
      this.database.exec("ALTER TABLE task_safe_action_receipts ADD COLUMN lease_expires_at TEXT");
    }
    if (!safeActionReceiptColumns.some((column) => column.name === "delivered_at")) {
      this.database.exec("ALTER TABLE task_safe_action_receipts ADD COLUMN delivered_at TEXT");
    }
    if (!safeActionReceiptColumns.some((column) => column.name === "delivery_turn_id")) {
      this.database.exec("ALTER TABLE task_safe_action_receipts ADD COLUMN delivery_turn_id TEXT");
    }
    for (const [column, type] of [
      ["root_host_id", "TEXT"],
      ["global_coordinator_lease_id", "TEXT"],
      ["global_coordinator_task_id", "TEXT"],
      ["global_coordinator_thread_id", "TEXT"],
      ["coordination_domain_id", "TEXT"],
      ["domain_coordinator_lease_id", "TEXT"],
      ["domain_coordinator_task_id", "TEXT"],
      ["domain_coordinator_thread_id", "TEXT"],
      ["root_workspace_path", "TEXT"],
      ["worktree_path", "TEXT"],
      ["worktree_branch", "TEXT"],
      ["recovery_lease_id", "TEXT"],
      ["recovery_lease_expires_at", "TEXT"],
      ["admission_attempt_id", "TEXT"],
      ["admission_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["admission_agent_name", "TEXT"],
      ["admission_agent_path", "TEXT"],
      ["admission_write_scope_json", "TEXT"],
      ["admission_prepared_at", "TEXT"],
      ["admission_deadline_at", "TEXT"],
      ["admission_uncertain_at", "TEXT"],
      ["admission_registry_observed_at", "TEXT"],
      ["admission_recovered_agent_thread_id", "TEXT"],
      ["admission_probe_id", "TEXT"],
      ["admission_probe_requested_at", "TEXT"],
      ["admission_deferred_reason", "TEXT"],
      ["admission_retry_count", "INTEGER NOT NULL DEFAULT 0"],
      ["admission_retry_after", "TEXT"],
      ["admitted_run_id", "TEXT"],
      ["admitted_agent_thread_id", "TEXT"],
      ["admitted_at", "TEXT"],
    ]) {
      if (!safeActionReceiptColumns.some((entry) => entry.name === column)) {
        this.database.exec(`ALTER TABLE task_safe_action_receipts ADD COLUMN ${column} ${type}`);
      }
    }
    if (!hadSafeActionReceiptStatus) {
      this.database.exec("UPDATE task_safe_action_receipts SET status = 'legacy'");
    }

    const agentClaimColumns = this.#prepare("PRAGMA table_info(agent_task_claims)").all();
    if (!agentClaimColumns.some((column) => column.name === "lease_expires_at")) {
      this.database.exec("ALTER TABLE agent_task_claims ADD COLUMN lease_expires_at TEXT");
    }
    if (!agentClaimColumns.some((column) => column.name === "write_scope_json")) {
      this.database.exec("ALTER TABLE agent_task_claims ADD COLUMN write_scope_json TEXT NOT NULL DEFAULT '[]'");
    }

    const agentEventReceiptColumns = this.#prepare("PRAGMA table_info(agent_event_receipts)").all();
    if (!agentEventReceiptColumns.some((column) => column.name === "idempotency_key")) {
      this.database.exec("ALTER TABLE agent_event_receipts ADD COLUMN idempotency_key TEXT");
    }
    if (!agentEventReceiptColumns.some((column) => column.name === "envelope_json")) {
      this.database.exec("ALTER TABLE agent_event_receipts ADD COLUMN envelope_json TEXT");
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_event_receipts_task_idempotency
      ON agent_event_receipts(task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    const taskAgentRunColumns = this.#prepare("PRAGMA table_info(task_agent_runs)").all();
    if (!taskAgentRunColumns.some((column) => column.name === "project_id")) {
      this.database.exec("ALTER TABLE task_agent_runs ADD COLUMN project_id TEXT");
      this.database.exec(`
        UPDATE task_agent_runs
        SET project_id = (
          SELECT tasks.project_id FROM tasks WHERE tasks.id = task_agent_runs.task_id
        )
        WHERE project_id IS NULL
      `);
    }
    this.database.exec("DROP INDEX IF EXISTS task_agent_runs_one_active_per_task");
    const taskAgentRunMigrationTimestamp = now();
    this.#prepare(`
      UPDATE task_agent_runs
      SET status = 'interrupted', version = version + 1, updated_at = ?, finished_at = ?
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY EXISTS (
              SELECT 1 FROM agent_task_claims AS claims
              WHERE claims.task_id = task_agent_runs.task_id
                AND claims.project_id = task_agent_runs.project_id
                AND claims.status = 'active'
                AND claims.agent_path = task_agent_runs.agent_path
                AND claims.agent_thread_id = task_agent_runs.agent_thread_id
            ) DESC, updated_at DESC, id DESC
          ) AS open_run_rank
          FROM task_agent_runs
          WHERE status IN ('active', 'blocked')
        ) WHERE open_run_rank > 1
      )
    `).run(taskAgentRunMigrationTimestamp, taskAgentRunMigrationTimestamp);
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS task_agent_runs_one_open_per_task
      ON task_agent_runs(task_id)
      WHERE status IN ('active', 'blocked')
    `);

    const taskColumns = this.#prepare("PRAGMA table_info(tasks)").all();
    const hasWorkflowId = taskColumns.some((column) => column.name === "workflow_id");
    if (hasWorkflowId) {
      this.database.exec("ALTER TABLE tasks DROP COLUMN workflow_id");
    }
    this.database.exec("DROP TABLE IF EXISTS workflow_workspaces");
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!taskColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.#prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "worktree_repository")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_repository TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "worktree_repository_verified_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_repository_verified_at TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "working_log_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN working_log_path TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_profile")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_profile TEXT NOT NULL DEFAULT 'formal' CHECK (workflow_profile IN ('formal', 'vibe'))");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const detectedAt = now();
      const insertCandidate = this.#prepare(`
        INSERT OR IGNORE INTO task_activation_workflow_profile_candidates (
          task_id, task_version, suggested_profile, observed_labels, detected_at
        ) VALUES (?, ?, 'vibe', ?, ?)
      `);
      for (const task of this.#prepare(`
        SELECT id, version, labels FROM tasks WHERE workflow_profile = 'formal'
      `).all()) {
        const labels = JSON.parse(task.labels);
        if (labels.includes("vibe-coding") && labels.includes("no-working-log")) {
          insertCandidate.run(task.id, task.version, JSON.stringify(labels), detectedAt);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!migratedTaskColumns.some((column) => column.name === "working_log_status")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN working_log_status TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "working_log_updated_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN working_log_updated_at TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_source")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_origin")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_origin TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_key")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_key TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_url TEXT");
    }
    this.database.exec(`
      DROP INDEX IF EXISTS tasks_external_source_id;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id
      ON tasks(external_source, external_origin, external_id)
      WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS tasks_owner_intent_outcome
      ON tasks(project_id, external_key)
      WHERE external_origin = 'owner_intent_plan';
    `);
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.#prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!projectColumns.some((column) => column.name === "labels")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE projects
          ADD COLUMN labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}'
        `);
        const labelsByProject = new Map(
          this.#prepare("SELECT id FROM projects").all().map((project) => (
            [project.id, [...DEFAULT_LABEL_NAMES]]
          )),
        );
        for (const task of this.#prepare(`
          SELECT project_id, labels
          FROM tasks
          ORDER BY created_at, id
        `).all()) {
          const projectLabels = labelsByProject.get(task.project_id);
          if (!projectLabels) continue;
          for (const label of JSON.parse(task.labels)) {
            if (!projectLabels.includes(label)) projectLabels.push(label);
          }
        }
        const updateProjectLabels = this.#prepare(`
          UPDATE projects SET labels = ? WHERE id = ?
        `);
        for (const [projectId, labels] of labelsByProject) {
          updateProjectLabels.run(JSON.stringify(labels), projectId);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    const taskRelationColumns = this.#prepare("PRAGMA table_info(task_relations)").all();
    if (!taskRelationColumns.some((column) => column.name === "origin")) {
      this.database.exec(`
        ALTER TABLE task_relations
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual', 'mention'))
      `);
    }

    const commentColumns = this.#prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!commentColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      }
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    if (!commentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.#prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks AS migrated_task
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = migrated_task.id
          ORDER BY
            CASE WHEN comments.id IS NOT NULL THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.#prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    if (!attachmentColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('inline', 'attachment'))");
      this.database.exec(`
        UPDATE attachments
        SET kind = 'inline'
        WHERE content_type LIKE 'image/%'
          AND (
            (
              comment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE tasks.id = attachments.task_id
                  AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
            OR (
              comment_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM comments
                WHERE comments.id = attachments.comment_id
                  AND instr(comments.body, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
          )
      `);
    }
    if (!attachmentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS comments_task_change_revision ON comments(task_id, change_revision)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_task_change_revision ON attachments(task_id, change_revision) WHERE comment_id IS NULL");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_change_revision ON attachments(comment_id, change_revision) WHERE comment_id IS NOT NULL");
    const maxChangeRevision = this.#prepare(`
      SELECT MAX(change_revision) AS value
      FROM (
        SELECT change_revision FROM comments
        UNION ALL
        SELECT change_revision FROM attachments
      )
    `).get().value ?? 0;
    this.#prepare(`
      INSERT INTO comment_attachment_revision (id, value)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value = MAX(value, excluded.value)
    `).run(maxChangeRevision);

    const timestamp = now();
    this.#prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.#prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
  }

  close() {
    this.statementCache.clear();
    this.database.close();
  }

  #migrateTaskStatuses() {
    const tasksSql = this.#prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          workflow_profile TEXT NOT NULL DEFAULT 'formal' CHECK (workflow_profile IN ('formal', 'vibe')),
          sort_order REAL NOT NULL,
          thread_id TEXT,
          thread_codex_project_id TEXT,
          thread_codex_project_kind TEXT,
          thread_codex_host_id TEXT,
          thread_workspace_path TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels, workflow_profile,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels, 'formal',
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.#prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects() {
    return this.#prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.#prepare(`
        INSERT INTO projects (
          id, name, workspace_path, labels, next_task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.name,
        input.workspacePath,
        DEFAULT_PROJECT_LABELS_JSON,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    const timestamp = now();
    this.#prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES (?, ?, NULL, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(JIRA_PROJECT_ID, name, timestamp, timestamp);
    return this.#prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY projects.id
    `).get(JIRA_PROJECT_ID);
  }

  syncJiraTasks(issues, { archiveMissing = true, projectName, legacyIdentity = null } = {}) {
    const timestamp = now();
    const seenTaskIds = new Set();
    const projectLabels = JSON.stringify([
      ...new Set(issues.flatMap((issue) => issue.labels)),
    ]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#prepare(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `).run(JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      const findExisting = this.#prepare(`
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      `);
      const migrateLegacyIdentity = this.#prepare(`
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      `);
      if (legacyIdentity) {
        const legacyTasks = this.#prepare(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        `).all(JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          migrateLegacyIdentity.run(
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }
      const insertTask = this.#prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels, workflow_profile,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          'formal', ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          NULL, 1, ?, ?
        )
      `);
      const updateTask = this.#prepare(`
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          archived_at = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ?
      `);

      for (const issue of issues) {
        const existing = findExisting.get(issue.externalOrigin, issue.externalId);
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        if (!existing) {
          insertTask.run(
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            issue.status,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.createdAt,
            issue.updatedAt,
          );
          continue;
        }

        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== issue.status
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.archived_at !== null;
        if (!changed) continue;
        updateTask.run(
          issue.identifier,
          issue.title,
          issue.description,
          issue.status,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          issue.updatedAt,
          existing.id,
        );
      }

      if (archiveMissing) {
        const existingTasks = this.#prepare(`
          SELECT id FROM tasks
          WHERE project_id = ? AND external_source = 'jira' AND archived_at IS NULL
        `).all(JIRA_PROJECT_ID);
        const archiveTask = this.#prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `);
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id)) {
            archiveTask.run(timestamp, timestamp, task.id);
          }
        }
      }
      this.#prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(timestamp, JIRA_PROJECT_ID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = this.#prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `).run(id, id);
    if (result.changes !== 1) {
      const issueCount = Number(this.#prepare(`
        SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
      `).get(id).issue_count);
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    return project;
  }

  getProject(id) {
    const row = this.#prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  addProjectLabel(projectId, label) {
    const project = this.#prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const labels = JSON.parse(project.labels);
    if (!labels.includes(label)) {
      this.#prepare(`
        UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...labels, label]), now(), projectId);
    }
    return this.getProject(projectId);
  }

  deleteProjectLabel(projectId, label) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.#prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = now();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        this.#prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const updateTask = this.#prepare(`
        UPDATE tasks
        SET labels = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const task of this.#prepare(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `).all(projectId)) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          updateTask.run(
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(projectId);
  }

  getProjectSummary(projectId) {
    const row = this.#prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.#prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.#prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.#prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getProjectReadme(projectId) {
    if (!this.#prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.#prepare(`
      SELECT project_id, content, version, created_at, updated_at
      FROM project_readmes
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? projectReadmeFromRow(row, projectId)
      : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
  }

  saveProjectReadme(projectId, content, expectedVersion) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.#prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).get(projectId);
      if (expectedVersion !== undefined) {
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
            expectedVersion,
            actualVersion,
          });
        }
      }
      if (current) {
        const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
        const params = expectedVersion !== undefined
          ? [content, timestamp, projectId, expectedVersion]
          : [content, timestamp, projectId];
        this.#prepare(`
          UPDATE project_readmes
          SET content = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?${versionCondition}
        `).run(...params);
      } else {
        this.#prepare(`
          INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(projectId, content, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProjectReadme(projectId);
  }

  createProjectReadmeAttachment(projectId, input) {
    if (!this.#prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    this.#prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      projectId,
      input.filename,
      input.contentType,
      input.size,
      now(),
    );
    return this.getProjectReadmeAttachment(input.id);
  }

  getProjectReadmeAttachment(id) {
    const row = this.#prepare(`
      SELECT * FROM project_readme_attachments WHERE id = ?
    `).get(id);
    return row ? projectReadmeAttachmentFromRow(row) : null;
  }

  listAiChatThreads() {
    const rows = this.#prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.#prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.#prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.#prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.#prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.#prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.#prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.#prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.#prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.#prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.#prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.#prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.#prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.#prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.#prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.#prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.#prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getActivationReadiness() {
    const workflowProfileCandidates = this.#prepare(`
      SELECT
        candidate.*,
        tasks.identifier,
        tasks.project_id
      FROM task_activation_workflow_profile_candidates AS candidate
      JOIN tasks ON tasks.id = candidate.task_id
      ORDER BY candidate.detected_at, tasks.identifier
    `).all().map(activationWorkflowProfileCandidate);
    const legacyRootBindings = this.#prepare(`
      SELECT id, identifier, project_id, version, thread_id
      FROM tasks
      WHERE thread_id IS NOT NULL
        AND (
          thread_codex_project_id IS NULL
          OR thread_codex_project_kind IS NULL
          OR thread_codex_host_id IS NULL
          OR thread_workspace_path IS NULL
        )
      ORDER BY project_id, identifier
    `).all().map((row) => ({
      taskId: row.id,
      identifier: row.identifier,
      projectId: row.project_id,
      taskVersion: row.version,
      legacyLocalThreadId: row.thread_id,
      repairAction: "coordinator repair-binding",
    }));
    return { workflowProfileCandidates, legacyRootBindings };
  }

  applyActivationWorkflowProfile(id, version, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const candidate = this.#prepare(`
        SELECT * FROM task_activation_workflow_profile_candidates WHERE task_id = ?
      `).get(task.id);
      if (!candidate) {
        throw new ApiError(
          409,
          "ACTIVATION_CANDIDATE_MISSING",
          "Workflow profile activation requires a recorded legacy migration candidate",
        );
      }
      if (candidate.status === "applied") {
        if (candidate.task_version !== version) {
          throw new ApiError(409, "VERSION_CONFLICT", "Activation replay must use the original candidate version");
        }
        this.database.exec("COMMIT");
        return {
          applied: false,
          task: this.getTask(task.id),
          receipt: {
            ...activationWorkflowProfileCandidate({
              ...candidate,
              identifier: task.identifier,
              project_id: task.projectId,
            }),
            taskVersionBefore: candidate.task_version,
            taskVersionAfter: candidate.task_version_after,
            appliedBy: {
              type: candidate.applied_by_type,
              id: candidate.applied_by_id,
              name: candidate.applied_by_name,
            },
          },
        };
      }
      this.#requireVersion(task, version);
      if (candidate.task_version !== version || task.workflowProfile !== "formal") {
        throw new ApiError(409, "ACTIVATION_CANDIDATE_STALE", "Legacy workflow profile candidate is stale");
      }
      const labels = task.labels;
      if (!labels.includes("vibe-coding") || !labels.includes("no-working-log")) {
        throw new ApiError(409, "ACTIVATION_CANDIDATE_STALE", "Legacy workflow profile labels changed");
      }
      const timestamp = now();
      const nextVersion = version + 1;
      this.#prepare(`
        UPDATE tasks
        SET workflow_profile = 'vibe', version = ?, updated_at = ?
        WHERE id = ? AND version = ? AND workflow_profile = 'formal'
      `).run(nextVersion, timestamp, task.id, version);
      this.#prepare(`
        UPDATE task_activation_workflow_profile_candidates
        SET status = 'applied', applied_at = ?, applied_by_type = ?, applied_by_id = ?,
          applied_by_name = ?, task_version_after = ?
        WHERE task_id = ? AND status = 'pending'
      `).run(timestamp, actor.type, actor.id, actor.name, nextVersion, task.id);
      this.#recordTaskActivity(task.id, actor, [{
        field: "workflowProfile",
        before: "formal",
        after: "vibe",
      }], timestamp);
      const appliedCandidate = this.#prepare(`
        SELECT * FROM task_activation_workflow_profile_candidates WHERE task_id = ?
      `).get(task.id);
      this.database.exec("COMMIT");
      return {
        applied: true,
        task: this.getTask(task.id),
        receipt: {
          ...activationWorkflowProfileCandidate({
            ...appliedCandidate,
            identifier: task.identifier,
            project_id: task.projectId,
          }),
          taskVersionBefore: appliedCandidate.task_version,
          taskVersionAfter: appliedCandidate.task_version_after,
          appliedBy: { type: actor.type, id: actor.id, name: actor.name },
        },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.#prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return rows.map((row) => attachTaskActivity(
      this.#taskWithRelations(row),
      commentsByTask.get(row.id) ?? [],
      activitiesByTask.get(row.id) ?? [],
      previewImagesByTask.get(row.id) ?? null,
    ));
  }

  getAgentLaneProject(projectId) {
    const row = this.#prepare(
      "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
    ).get(projectId);
    if (!row) return null;
    const config = JSON.parse(row.config_json);
    const coordinatorLease = config.coordinatorLease ?? null;
    const coordinatorReleasedAt = coordinatorLease?.releasedAt
      ?? this.#coordinatorLeaseReleasedAt(projectId, coordinatorLease);
    const domainCoordinatorLeases = Object.fromEntries(
      Object.entries(config.domainCoordinatorLeases ?? {}).map(([domainId, lease]) => {
        const releasedAt = lease?.releasedAt
          ?? this.#domainCoordinatorLeaseReleasedAt(projectId, domainId, lease);
        return [domainId, releasedAt ? { ...lease, releasedAt } : lease];
      }),
    );
    return {
      ...config,
      coordinatorLease: coordinatorLease && coordinatorReleasedAt
        ? { ...coordinatorLease, releasedAt: coordinatorReleasedAt }
        : coordinatorLease,
      ...(config.domainCoordinatorLeases === undefined ? {} : { domainCoordinatorLeases }),
    };
  }

  getAgentLaneCoordinationWindows(projectId) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.#prepare(
      "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
    ).get(projectId);
    if (!row) {
      throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
    }
    return coordinationWindowConfiguration(projectId, row);
  }

  getAgentLaneCoordinationDomains(projectId) {
    const row = this.#prepare(
      "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
    ).get(projectId);
    if (!row) {
      throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
    }
    const config = JSON.parse(row.config_json);
    return {
      projectId,
      revision: agentLaneConfigRevision(row.config_json),
      domains: normalizeCoordinationDomains(config),
    };
  }

  configureAgentLaneCoordinationDomain(projectId, domainId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const fingerprint = createHash("sha256").update(JSON.stringify({
        domainId, domain: input.domain,
        holderTaskId: input.holderTaskId, holderThreadId: input.holderThreadId,
        expectedCoordinatorLeaseId: input.expectedCoordinatorLeaseId,
      })).digest("hex");
      const existingReceiptRow = this.#prepare(`
        SELECT * FROM agent_coordination_domain_receipts
        WHERE project_id = ? AND idempotency_key = ?
      `).get(projectId, input.idempotencyKey);
      if (existingReceiptRow) {
        if (existingReceiptRow.fingerprint !== fingerprint) {
          throw new ApiError(409, "COORDINATION_DOMAIN_IDEMPOTENCY_CONFLICT", "The idempotency key is bound to another domain configuration");
        }
        this.database.exec("COMMIT");
        return {
          applied: false,
          receipt: coordinationDomainReceiptFromRow(existingReceiptRow),
          configuration: this.getAgentLaneCoordinationDomains(projectId),
        };
      }
      const revision = agentLaneConfigRevision(row.config_json);
      if (revision !== input.expectedRevision) {
        throw new ApiError(409, "COORDINATION_DOMAIN_REVISION_CONFLICT", "Coordination domains changed since they were read", { actualRevision: revision });
      }
      const config = JSON.parse(row.config_json);
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId, config, config.coordinatorLease ?? null,
      );
      if (!activeCoordinator
        || config.coordinatorLease.id !== input.expectedCoordinatorLeaseId
        || config.coordinatorLease.holderTaskId !== input.holderTaskId
        || activeCoordinator.holder.threadId !== input.holderThreadId) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_MISMATCH", "Domain configuration requires the exact active Global Coordinator lease");
      }
      const currentDomains = normalizeCoordinationDomains(config);
      const currentDomain = currentDomains.find((domain) => domain.id === domainId) ?? null;
      const nextDomains = input.domain === null
        ? currentDomains.filter((domain) => domain.id !== domainId)
        : [...currentDomains.filter((domain) => domain.id !== domainId), { ...input.domain, id: domainId }];
      const nextConfigCandidate = { ...config, coordinationDomains: nextDomains };
      const normalizedDomains = normalizeCoordinationDomains(nextConfigCandidate);
      const nextDomain = normalizedDomains.find((domain) => domain.id === domainId) ?? null;
      const creates = !currentDomain && nextDomain;
      const domainChanges = currentDomain && nextDomain
        && !sameCoordinationDomainConfiguration(currentDomain, nextDomain);
      const removes = currentDomain && !nextDomain;
      if (creates || domainChanges || removes) {
        const assigned = this.#prepare(`
          SELECT 1 FROM agent_task_domain_assignments WHERE project_id = ? AND domain_id = ? LIMIT 1
        `).get(projectId, domainId);
        if (assigned) {
          throw new ApiError(409, "ASSIGNED_COORDINATION_DOMAIN_CHANGE", "Clear every assigned Todo before configuring or removing its coordination domain policy");
        }
        if (this.#coordinatorLeaseWindowReserved(
          projectId, config.domainCoordinatorLeases?.[domainId] ?? null, Date.now(), domainId,
        )) {
          throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_RESERVED", "Release or expire the Domain Coordinator lease before changing its domain policy");
        }
      }
      const same = sameCoordinationDomainConfiguration(currentDomain, nextDomain);
      const leases = { ...(config.domainCoordinatorLeases ?? {}) };
      if ((creates || domainChanges || removes) && Object.hasOwn(leases, domainId)) delete leases[domainId];
      const nextConfig = {
        ...config,
        coordinationDomains: normalizedDomains,
        ...(Object.keys(leases).length > 0 ? { domainCoordinatorLeases: leases } : { domainCoordinatorLeases: {} }),
      };
      const configJson = same ? row.config_json : JSON.stringify(nextConfig);
      const configRevision = agentLaneConfigRevision(configJson);
      const timestamp = now();
      if (!same) {
        this.#prepare("UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?")
          .run(configJson, timestamp, projectId);
      }
      const receiptRow = {
        id: randomUUID(), project_id: projectId, domain_id: domainId,
        idempotency_key: input.idempotencyKey, fingerprint,
        action: input.domain === null ? "removed" : "configured",
        config_revision: configRevision, created_at: timestamp,
      };
      this.#prepare(`
        INSERT INTO agent_coordination_domain_receipts (
          id, project_id, domain_id, idempotency_key, fingerprint, action, config_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...Object.values(receiptRow));
      this.database.exec("COMMIT");
      return {
        applied: !same,
        receipt: coordinationDomainReceiptFromRow(receiptRow),
        configuration: this.getAgentLaneCoordinationDomains(projectId),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  registerAgentLaneCoordinationWindow(projectId, input, threadBinding) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getProject(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const binding = {
        threadId: threadBinding.threadId,
        codexProjectId: threadBinding.codexProjectId,
        codexProjectKind: threadBinding.codexProjectKind,
        codexHostId: threadBinding.codexHostId,
        workspacePath: path.resolve(threadBinding.workspacePath),
      };
      const fingerprint = createHash("sha256").update(JSON.stringify({
        role: input.role,
        taskId: input.taskId,
        label: input.label,
        binding,
      })).digest("hex");
      const existingReceiptRow = this.#prepare(`
        SELECT * FROM agent_coordination_window_receipts
        WHERE project_id = ? AND idempotency_key = ?
      `).get(projectId, input.idempotencyKey);
      if (existingReceiptRow) {
        if (existingReceiptRow.fingerprint !== fingerprint) {
          throw new ApiError(
            409,
            "COORDINATION_WINDOW_IDEMPOTENCY_CONFLICT",
            "The idempotency key is bound to a different coordination window registration",
          );
        }
        this.database.exec("COMMIT");
        return {
          applied: false,
          receipt: coordinationWindowReceiptFromRow(existingReceiptRow),
          configuration: coordinationWindowConfiguration(projectId, row),
        };
      }

      const revision = agentLaneConfigRevision(row.config_json);
      if (revision !== input.expectedRevision) {
        throw new ApiError(
          409,
          "COORDINATION_WINDOW_REVISION_CONFLICT",
          "Agent Lane coordination windows changed since they were read",
          { actualRevision: revision },
        );
      }
      this.#assertNoActiveOwnerDecisionDelivery(projectId);
      const config = JSON.parse(row.config_json);
      const tasks = Array.isArray(config.tasks) ? config.tasks : [];
      const existingTask = tasks.find((task) => task?.id === input.taskId) ?? null;
      if (existingTask && (existingTask.source !== "codex" || existingTask.taskType !== "root_task")) {
        throw new ApiError(
          409,
          "COORDINATION_WINDOW_TASK_CONFLICT",
          "The requested task id belongs to a non-coordination Agent Lane",
        );
      }
      if ((Array.isArray(config.adapters) ? config.adapters : []).some(
        (adapter) => adapter?.id === input.taskId,
      )) {
        throw new ApiError(
          409,
          "COORDINATION_WINDOW_TASK_CONFLICT",
          "The requested task id belongs to a configured Agent Lane adapter",
        );
      }
      const duplicateBinding = tasks.find((task) => (
        task?.id !== input.taskId
        && task?.source === "codex"
        && task?.threadId === binding.threadId
      ));
      if (duplicateBinding) {
        throw new ApiError(
          409,
          "COORDINATION_WINDOW_BINDING_CONFLICT",
          "The protected Codex thread is already registered under another Agent Lane task id",
        );
      }
      const activeGlobalLeaseWindow = this.#coordinatorLeaseWindowActive(
        projectId,
        config.coordinatorLease ?? null,
      );
      const reservedGlobalLeaseWindow = this.#coordinatorLeaseWindowReserved(
        projectId,
        config.coordinatorLease ?? null,
      );
      const reservedGlobalLeaseHolder = reservedGlobalLeaseWindow
        ? tasks.find((task) => task?.id === reservedGlobalLeaseWindow.holderTaskId) ?? null
        : null;
      if (
        input.role === "owner_root"
        && reservedGlobalLeaseWindow
        && (
          reservedGlobalLeaseWindow.holderTaskId === input.taskId
          || reservedGlobalLeaseHolder?.source !== "codex"
          || reservedGlobalLeaseHolder?.taskType !== "root_task"
        )
      ) {
        throw new ApiError(
          409,
          "OWNER_ROOT_COORDINATOR_CONFLICT",
          "The Owner-facing Root requires a distinct fully-bound Codex Root Global Coordinator",
        );
      }
      if (input.role === "coordinator" && config.ownerRootTaskId === input.taskId) {
        throw new ApiError(
          409,
          "OWNER_ROOT_COORDINATOR_CONFLICT",
          "A Global Coordinator candidate cannot replace the configured Owner-facing Root",
        );
      }
      if (activeGlobalLeaseWindow?.holderTaskId === input.taskId && (
        existingTask?.threadId !== binding.threadId
        || existingTask?.codexHostId !== binding.codexHostId
        || path.resolve(existingTask?.workspacePath ?? "") !== binding.workspacePath
      )) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_ACTIVE",
          "Release the active Global Coordinator lease before changing its protected window binding",
        );
      }
      for (const [domainId, lease] of Object.entries(config.domainCoordinatorLeases ?? {})) {
        const activeDomainLeaseWindow = this.#coordinatorLeaseWindowActive(
          projectId,
          lease,
          Date.now(),
          domainId,
        );
        if (activeDomainLeaseWindow?.holderTaskId !== input.taskId) continue;
        if (
          existingTask?.threadId === binding.threadId
          && existingTask?.codexHostId === binding.codexHostId
          && path.resolve(existingTask?.workspacePath ?? "") === binding.workspacePath
        ) continue;
        throw new ApiError(
          409,
          "DOMAIN_COORDINATOR_LEASE_ACTIVE",
          `Release the active '${domainId}' Domain Coordinator lease before changing its protected window binding`,
        );
      }

      const task = {
        ...(existingTask ?? {}),
        id: input.taskId,
        label: input.label,
        owner: input.role === "owner_root" ? "Codex Owner Root" : "Codex Global Coordinator",
        source: "codex",
        connection: "connected",
        threadId: binding.threadId,
        taskType: "root_task",
        codexProjectId: binding.codexProjectId,
        codexProjectKind: binding.codexProjectKind,
        codexHostId: binding.codexHostId,
        workspacePath: binding.workspacePath,
      };
      const nextTasks = existingTask
        ? tasks.map((candidate) => candidate?.id === input.taskId ? task : candidate)
        : [...tasks, task];
      const nextConfig = {
        ...config,
        tasks: nextTasks,
        ...(input.role === "owner_root" ? { ownerRootTaskId: input.taskId } : {}),
      };
      const configJson = JSON.stringify(nextConfig);
      const configRevision = agentLaneConfigRevision(configJson);
      const timestamp = now();
      this.#prepare(`
        UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
      `).run(configJson, timestamp, projectId);
      const receiptRow = {
        id: randomUUID(),
        project_id: projectId,
        idempotency_key: input.idempotencyKey,
        fingerprint,
        role: input.role,
        task_id: input.taskId,
        thread_id: binding.threadId,
        config_revision: configRevision,
        created_at: timestamp,
      };
      this.#prepare(`
        INSERT INTO agent_coordination_window_receipts (
          id, project_id, idempotency_key, fingerprint, role,
          task_id, thread_id, config_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...Object.values(receiptRow));
      this.database.exec("COMMIT");
      return {
        applied: true,
        receipt: coordinationWindowReceiptFromRow(receiptRow),
        configuration: coordinationWindowConfiguration(projectId, { config_json: configJson }),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #exactActiveCoordinatorLease(projectId, config, lease, timestamp = Date.now(), domainId = null) {
    const releasedAt = domainId
      ? this.#domainCoordinatorLeaseReleasedAt(projectId, domainId, lease)
      : this.#coordinatorLeaseReleasedAt(projectId, lease);
    if (!lease || lease.releasedAt || releasedAt) return null;
    const acquiredAt = Date.parse(lease.acquiredAt);
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(acquiredAt)
      || !Number.isFinite(expiresAt)
      || acquiredAt >= expiresAt
      || timestamp < acquiredAt
      || timestamp >= expiresAt) return null;
    const holder = Array.isArray(config?.tasks)
      ? config.tasks.find((candidate) => candidate?.id === lease.holderTaskId) ?? null
      : null;
    if (!holder?.threadId
      || !holder.codexHostId
      || typeof holder.workspacePath !== "string"
      || !path.isAbsolute(holder.workspacePath)
      || lease.holderThreadId !== holder.threadId
      || lease.holderCodexHostId !== holder.codexHostId
      || typeof lease.holderWorkspacePath !== "string"
      || !path.isAbsolute(lease.holderWorkspacePath)
      || path.resolve(lease.holderWorkspacePath) !== path.resolve(holder.workspacePath)) return null;
    const ownerRootTaskId = typeof config?.ownerRootTaskId === "string"
      ? config.ownerRootTaskId.trim()
      : "";
    if (!domainId && ownerRootTaskId) {
      const ownerRoot = Array.isArray(config?.tasks)
        ? config.tasks.find((candidate) => candidate?.id === ownerRootTaskId) ?? null
        : null;
      if (!ownerRoot
        || ownerRoot.source !== "codex"
        || ownerRoot.taskType !== "root_task"
        || !ownerRoot.threadId
        || !ownerRoot.codexHostId
        || typeof ownerRoot.workspacePath !== "string"
        || !path.isAbsolute(ownerRoot.workspacePath)
        || holder.id === ownerRootTaskId
        || holder.source !== "codex"
        || holder.taskType !== "root_task") return null;
    }
    if (domainId) {
      const domain = normalizeCoordinationDomains(config ?? {})
        .find((candidate) => candidate.id === domainId);
      if (!domain?.eligibleTaskIds.includes(lease.holderTaskId)) return null;
    }
    return { lease, holder };
  }

  #coordinatorLeaseWindowActive(projectId, lease, timestamp = Date.now(), domainId = null) {
    const reserved = this.#coordinatorLeaseWindowReserved(projectId, lease, timestamp, domainId);
    if (!reserved || timestamp < Date.parse(reserved.acquiredAt)) return null;
    return reserved;
  }

  #coordinatorLeaseWindowReserved(projectId, lease, timestamp = Date.now(), domainId = null) {
    const releasedAt = domainId
      ? this.#domainCoordinatorLeaseReleasedAt(projectId, domainId, lease)
      : this.#coordinatorLeaseReleasedAt(projectId, lease);
    if (!lease || lease.releasedAt || releasedAt) return null;
    const acquiredAt = Date.parse(lease.acquiredAt);
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(acquiredAt)
      || !Number.isFinite(expiresAt)
      || acquiredAt >= expiresAt
      || timestamp >= expiresAt) return null;
    return lease;
  }

  getAgentTaskDomainAssignment(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return agentTaskDomainAssignmentFromRow(this.#prepare(`
      SELECT * FROM agent_task_domain_assignments WHERE task_id = ?
    `).get(task.id));
  }

  getAgentTaskDomainProvenance(taskId) {
    const assignment = this.getAgentTaskDomainAssignment(taskId);
    if (assignment) return assignment;
    const task = this.getTask(taskId);
    if (!task) return null;
    const provenance = agentTaskDomainAssignmentFromRow(this.#prepare(`
      SELECT * FROM agent_task_domain_provenance WHERE task_id = ?
    `).get(task.id));
    if (provenance && provenance.projectId !== task.projectId) {
      throw new ApiError(409, "DOMAIN_PROVENANCE_PROJECT_MISMATCH", "Cleared domain provenance must stay in its original project");
    }
    return provenance;
  }

  getAgentTaskDomainRoute(taskId, timestamp = new Date()) {
    const assignment = this.getAgentTaskDomainAssignment(taskId);
    if (!assignment) return null;
    const config = this.getAgentLaneProject(assignment.projectId);
    const domain = normalizeCoordinationDomains(config ?? {}).find((candidate) => candidate.id === assignment.domainId);
    const lease = domain ? config?.domainCoordinatorLeases?.[domain.id] ?? null : null;
    const activeLease = domain
      ? this.#exactActiveCoordinatorLease(
          assignment.projectId,
          config,
          lease,
          timestamp.getTime(),
          domain.id,
        )
      : null;
    return {
      domainId: assignment.domainId,
      leaseId: lease?.id ?? null,
      holderTaskId: lease?.holderTaskId ?? null,
      holderThreadId: activeLease?.holder.threadId ?? null,
      status: activeLease ? "active" : "needs_coordinator",
    };
  }

  #getAgentTaskDomainDeliveryRoute(taskId) {
    const route = this.getAgentTaskDomainRoute(taskId);
    if (!route) return null;
    const task = this.getTask(taskId);
    const config = task ? this.getAgentLaneProject(task.projectId) : null;
    const holder = route.status === "active" && Array.isArray(config?.tasks)
      ? config.tasks.find((candidate) => candidate?.id === route.holderTaskId) ?? null
      : null;
    return {
      ...route,
      codexHostId: holder?.codexHostId ?? null,
      workspacePath: holder?.workspacePath ?? null,
    };
  }

  setAgentTaskDomain(projectId, taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      if (task.projectId !== projectId) {
        throw new ApiError(409, "DOMAIN_TODO_PROJECT_MISMATCH", "Domain Todo assignment must stay inside one project");
      }
      this.#requireVersion(task, input.taskVersion);
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      const config = JSON.parse(row.config_json);
      const coordinatorLease = config.coordinatorLease ?? null;
      const timestamp = now();
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        coordinatorLease,
        Date.parse(timestamp),
      );
      if (!activeCoordinator
        || coordinatorLease.id !== input.expectedCoordinatorLeaseId
        || coordinatorLease.holderTaskId !== input.holderTaskId) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_MISMATCH", "Domain Todo assignment requires the exact active Global Coordinator lease");
      }
      const holder = activeCoordinator.holder;
      if (!holder || holder.threadId !== input.holderThreadId) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_BINDING_MISMATCH", "Domain Todo assignment must match the active Global Coordinator thread");
      }
      const existing = this.getAgentTaskDomainAssignment(task.id);
      if (input.domainId === null) {
        const activeClaim = this.#prepare(`
          SELECT 1 FROM agent_task_claims WHERE task_id = ? AND status = 'active' LIMIT 1
        `).get(task.id);
        if (activeClaim || this.getOpenTaskAgentRun(task.id)) {
          throw new ApiError(409, "DOMAIN_TODO_ACTIVE", "An active Todo claim or run cannot be reassigned");
        }
        const activeAdmission = this.#prepare(`
          SELECT 1 FROM task_safe_action_receipts
          WHERE task_id = ? AND status = 'delivering'
            AND admission_state IN ('awaiting_admission', 'prepared', 'admission_uncertain', 'recovery_confirmed')
          LIMIT 1
        `).get(task.id);
        if (activeAdmission) {
          throw new ApiError(409, "DOMAIN_TODO_ADMISSION_ACTIVE", "A non-terminal admission must finish before clearing its domain assignment");
        }
        if (["in_review", "done"].includes(task.status)) {
          const outboundDependency = this.#prepare(`
            SELECT 1 FROM task_relations
            WHERE relation_type = 'blocks' AND source_task_id = ? LIMIT 1
          `).get(task.id);
          if (outboundDependency) {
            throw new ApiError(409, "DOMAIN_TODO_OUTBOUND_DEPENDENCY", "Remove every durable outbound dependency before clearing completed source-domain provenance");
          }
        }
        if (!existing) {
          this.database.exec("COMMIT");
          return { assignment: null, task };
        }
        this.#prepare(`
          INSERT INTO agent_task_domain_provenance (
            task_id, project_id, domain_id, assigned_by_lease_id, assigned_by_task_id,
            assigned_by_thread_id, assigned_at, updated_at, cleared_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            project_id = excluded.project_id,
            domain_id = excluded.domain_id,
            assigned_by_lease_id = excluded.assigned_by_lease_id,
            assigned_by_task_id = excluded.assigned_by_task_id,
            assigned_by_thread_id = excluded.assigned_by_thread_id,
            assigned_at = excluded.assigned_at,
            updated_at = excluded.updated_at,
            cleared_at = excluded.cleared_at
        `).run(
          existing.taskId, existing.projectId, existing.domainId, existing.assignedByLeaseId,
          existing.assignedByTaskId, existing.assignedByThreadId, existing.assignedAt,
          existing.updatedAt, timestamp,
        );
        this.#prepare("DELETE FROM agent_task_domain_assignments WHERE task_id = ?").run(task.id);
        this.#prepare(`
          UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
        `).run(timestamp, task.id, task.version);
        this.database.exec("COMMIT");
        return { assignment: null, task: this.getTask(task.id) };
      }
      if (task.status !== "todo" || !task.labels.includes("agent-todo")) {
        throw new ApiError(409, "DOMAIN_TODO_NOT_READY", "Only an unclaimed Agent Todo can be assigned to a domain");
      }
      if (this.getAgentTaskClaim(task.id) || this.getOpenTaskAgentRun(task.id)) {
        throw new ApiError(409, "DOMAIN_TODO_ACTIVE", "An active Todo claim or run cannot be reassigned");
      }
      const domain = normalizeCoordinationDomains(config).find((candidate) => candidate.id === input.domainId);
      if (!domain) throw new ApiError(404, "COORDINATION_DOMAIN_NOT_FOUND", `Coordination domain '${input.domainId}' does not exist`);
      if (existing?.domainId === domain.id) {
        this.database.exec("COMMIT");
        return { assignment: existing, task };
      }
      this.#prepare(`
        INSERT INTO agent_task_domain_assignments (
          task_id, project_id, domain_id, assigned_by_lease_id, assigned_by_task_id,
          assigned_by_thread_id, assigned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          domain_id = excluded.domain_id,
          assigned_by_lease_id = excluded.assigned_by_lease_id,
          assigned_by_task_id = excluded.assigned_by_task_id,
          assigned_by_thread_id = excluded.assigned_by_thread_id,
          updated_at = excluded.updated_at
      `).run(
        task.id, projectId, domain.id, coordinatorLease.id, input.holderTaskId,
        input.holderThreadId, existing?.assignedAt ?? timestamp, timestamp,
      );
      this.#prepare(`
        UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
      `).run(timestamp, task.id, task.version);
      this.database.exec("COMMIT");
      return { assignment: this.getAgentTaskDomainAssignment(task.id), task: this.getTask(task.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listCrossDomainDependencyClearances(targetTaskId) {
    const target = this.getTask(targetTaskId);
    if (!target) return [];
    const targetAssignment = this.getAgentTaskDomainAssignment(target.id);
    if (!targetAssignment) return [];
    const route = this.getAgentTaskDomainRoute(target.id);
    const dependencies = this.#prepare(`
      SELECT task_relations.created_at AS edge_created_at, tasks.id AS source_task_id
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY task_relations.created_at, tasks.id
    `).all(target.id);
    return dependencies.flatMap((dependency) => {
      const source = this.getTask(dependency.source_task_id);
      const sourceAssignment = this.getAgentTaskDomainProvenance(source.id);
      if (!sourceAssignment || sourceAssignment.domainId === targetAssignment.domainId) return [];
      const binding = {
        projectId: target.projectId,
        sourceTaskId: source.id,
        sourceTaskVersion: source.version,
        targetTaskId: target.id,
        targetTaskVersion: target.version,
        edgeCreatedAt: dependency.edge_created_at,
        sourceDomainId: sourceAssignment.domainId,
        sourceAssignedByLeaseId: sourceAssignment.assignedByLeaseId,
        sourceAssignedByTaskId: sourceAssignment.assignedByTaskId,
        sourceAssignedByThreadId: sourceAssignment.assignedByThreadId,
        sourceAssignmentUpdatedAt: sourceAssignment.updatedAt,
        targetDomainId: targetAssignment.domainId,
        targetAssignedByLeaseId: targetAssignment.assignedByLeaseId,
        targetAssignedByTaskId: targetAssignment.assignedByTaskId,
        targetAssignedByThreadId: targetAssignment.assignedByThreadId,
        targetAssignmentUpdatedAt: targetAssignment.updatedAt,
        targetDomainLeaseId: route?.leaseId ?? null,
        targetHolderTaskId: route?.holderTaskId ?? null,
        targetHolderThreadId: route?.holderThreadId ?? null,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
      const receipt = this.#prepare(`
        SELECT * FROM cross_domain_dependency_clearances
        WHERE target_task_id = ? AND source_task_id = ?
        ORDER BY accepted_at DESC, id DESC LIMIT 1
      `).get(target.id, source.id);
      const accepted = source.status === "done"
        && route?.status === "active"
        && receipt?.fingerprint === fingerprint;
      const targetReady = target.status === "todo"
        && target.labels.includes("agent-todo")
        && !this.getAgentTaskClaim(target.id)
        && !this.getOpenTaskAgentRun(target.id);
      const delivery = this.#prepare(`
        SELECT id, state, reservation_expires_at, delivered_at, delivery_turn_id
        FROM cross_domain_handoff_deliveries WHERE fingerprint = ?
      `).get(fingerprint);
      return [{
        ...binding,
        fingerprint,
        sourceIdentifier: source.identifier,
        sourceStatus: source.status,
        targetReady,
        status: accepted ? "accepted" : "awaiting_handoff",
        clearanceId: accepted ? receipt.id : null,
        acceptedAt: accepted ? receipt.accepted_at : null,
        delivery: delivery ? {
          id: delivery.id,
          state: delivery.state,
          reservationExpiresAt: delivery.reservation_expires_at,
          deliveredAt: delivery.delivered_at,
          deliveryTurnId: delivery.delivery_turn_id,
        } : null,
      }];
    });
  }

  claimCrossDomainHandoffDelivery(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const frontier = this.listCrossDomainDependencyClearances(input.targetTaskId)
        .find((item) => item.sourceTaskId === input.sourceTaskId);
      if (!frontier
        || frontier.projectId !== projectId
        || frontier.status !== "awaiting_handoff"
        || frontier.sourceStatus !== "done"
        || frontier.targetReady !== true
        || frontier.fingerprint !== input.fingerprint
        || frontier.targetDomainLeaseId !== input.expectedTargetDomainLeaseId
        || frontier.targetHolderTaskId !== input.targetHolderTaskId
        || frontier.targetHolderThreadId !== input.route.targetThreadId) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Cross-domain handoff frontier or target coordinator route changed before delivery");
      }
      const route = this.#getAgentTaskDomainDeliveryRoute(frontier.targetTaskId);
      if (route?.status !== "active"
        || route.codexHostId !== input.route.codexHostId
        || path.resolve(route.workspacePath ?? "") !== path.resolve(input.route.targetWorkspacePath)) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Cross-domain handoff host or workspace route changed before delivery");
      }
      const existing = this.#prepare(`
        SELECT * FROM cross_domain_handoff_deliveries WHERE fingerprint = ?
      `).get(frontier.fingerprint);
      if (existing?.state === "delivered") {
        this.database.exec("COMMIT");
        return {
          claimed: false,
          reason: "already-delivered",
          receipt: { id: existing.id, deliveryTurnId: existing.delivery_turn_id },
        };
      }
      if (existing && Date.parse(existing.reservation_expires_at) > Date.now()) {
        this.database.exec("COMMIT");
        return {
          claimed: false,
          reason: "reserved",
          receipt: { id: existing.id, reservationExpiresAt: existing.reservation_expires_at },
        };
      }
      const timestamp = now();
      const reservationExpiresAt = new Date(Date.now() + CROSS_DOMAIN_HANDOFF_DELIVERY_TTL_MS).toISOString();
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.#prepare(`
          UPDATE cross_domain_handoff_deliveries SET
            target_holder_thread_id = ?, target_codex_host_id = ?, target_workspace_path = ?,
            state = 'reserved', reservation_expires_at = ?,
            claimed_at = ?, delivered_at = NULL, delivery_turn_id = NULL
          WHERE id = ?
        `).run(
          frontier.targetHolderThreadId, route.codexHostId, route.workspacePath,
          reservationExpiresAt, timestamp, id,
        );
      } else {
        this.#prepare(`
          INSERT INTO cross_domain_handoff_deliveries (
            id, fingerprint, project_id, source_task_id, target_task_id,
            target_holder_thread_id, target_codex_host_id, target_workspace_path,
            state, reservation_expires_at, claimed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
        `).run(
          id, frontier.fingerprint, projectId, frontier.sourceTaskId, frontier.targetTaskId,
          frontier.targetHolderThreadId, route.codexHostId, route.workspacePath,
          reservationExpiresAt, timestamp,
        );
      }
      this.database.exec("COMMIT");
      return { claimed: true, receipt: { id, reservationExpiresAt } };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  confirmCrossDomainHandoffDelivery(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(`
        SELECT * FROM cross_domain_handoff_deliveries WHERE id = ? AND project_id = ?
      `).get(input.deliveryId, projectId);
      if (!row) throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_MISMATCH", "Cross-domain handoff delivery does not exist");
      if (row.state !== "delivered" && Date.parse(row.reservation_expires_at) <= Date.now()) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_EXPIRED", "Cross-domain handoff reservation expired before confirmation");
      }
      const frontier = this.listCrossDomainDependencyClearances(row.target_task_id)
        .find((item) => item.sourceTaskId === row.source_task_id);
      if (!frontier
        || frontier.projectId !== projectId
        || frontier.status !== "awaiting_handoff"
        || frontier.sourceStatus !== "done"
        || frontier.targetReady !== true
        || frontier.fingerprint !== row.fingerprint
        || frontier.targetHolderThreadId !== row.target_holder_thread_id) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Cross-domain handoff frontier or target coordinator route changed before confirmation");
      }
      const route = this.#getAgentTaskDomainDeliveryRoute(frontier.targetTaskId);
      if (route?.status !== "active"
        || route.codexHostId !== row.target_codex_host_id
        || path.resolve(route.workspacePath ?? "") !== path.resolve(row.target_workspace_path ?? "")) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Cross-domain handoff host or workspace route changed before confirmation");
      }
      if (row.state === "delivered") {
        if (row.delivery_turn_id !== input.deliveryTurnId) {
          throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_CONFLICT", "Cross-domain handoff delivery is already bound to another turn");
        }
        this.database.exec("COMMIT");
        return { confirmed: true, reused: true, deliveryId: row.id };
      }
      const timestamp = now();
      this.#prepare(`
        UPDATE cross_domain_handoff_deliveries
        SET state = 'delivered', delivered_at = ?, delivery_turn_id = ?
        WHERE id = ? AND state = 'reserved'
      `).run(timestamp, input.deliveryTurnId, row.id);
      this.database.exec("COMMIT");
      return { confirmed: true, reused: false, deliveryId: row.id };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  acceptCrossDomainDependencyClearance(targetTaskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const target = this.#requireTask(targetTaskId);
      const source = this.#requireTask(input.sourceTaskId);
      if (source.projectId !== target.projectId) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_PROJECT_MISMATCH", "Dependency clearance must stay inside one project");
      }
      const edge = this.#prepare(`
        SELECT created_at FROM task_relations
        WHERE relation_type = 'blocks' AND source_task_id = ? AND target_task_id = ?
      `).get(source.id, target.id);
      if (!edge) throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_EDGE_MISSING", "The exact blocks edge no longer exists");
      if (source.status !== "done") {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_SOURCE_INCOMPLETE", "The dependency source must be done before clearance");
      }
      if (
        target.status !== "todo"
        || !target.labels.includes("agent-todo")
        || this.getAgentTaskClaim(target.id)
        || this.getOpenTaskAgentRun(target.id)
      ) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_TARGET_NOT_READY", "Clearance requires an unclaimed Agent Todo target");
      }
      const sourceAssignment = this.getAgentTaskDomainProvenance(source.id);
      const targetAssignment = this.getAgentTaskDomainAssignment(target.id);
      if (!sourceAssignment || !targetAssignment || sourceAssignment.domainId === targetAssignment.domainId) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_NOT_REQUIRED", "The dependency is not currently cross-domain");
      }
      const route = this.getAgentTaskDomainRoute(target.id);
      if (
        route?.status !== "active"
        || route.leaseId !== input.expectedTargetDomainLeaseId
        || route.holderTaskId !== input.holderTaskId
        || route.holderThreadId !== input.holderThreadId
      ) {
        throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_ROUTE_MISMATCH", "Clearance requires the exact current target-domain coordinator route");
      }
      const binding = {
        projectId: target.projectId,
        sourceTaskId: source.id,
        sourceTaskVersion: source.version,
        targetTaskId: target.id,
        targetTaskVersion: target.version,
        edgeCreatedAt: edge.created_at,
        sourceDomainId: sourceAssignment.domainId,
        sourceAssignedByLeaseId: sourceAssignment.assignedByLeaseId,
        sourceAssignedByTaskId: sourceAssignment.assignedByTaskId,
        sourceAssignedByThreadId: sourceAssignment.assignedByThreadId,
        sourceAssignmentUpdatedAt: sourceAssignment.updatedAt,
        targetDomainId: targetAssignment.domainId,
        targetAssignedByLeaseId: targetAssignment.assignedByLeaseId,
        targetAssignedByTaskId: targetAssignment.assignedByTaskId,
        targetAssignedByThreadId: targetAssignment.assignedByThreadId,
        targetAssignmentUpdatedAt: targetAssignment.updatedAt,
        targetDomainLeaseId: route.leaseId,
        targetHolderTaskId: route.holderTaskId,
        targetHolderThreadId: route.holderThreadId,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
      const existing = this.#prepare(`
        SELECT * FROM cross_domain_dependency_clearances
        WHERE project_id = ? AND idempotency_key = ?
      `).get(target.projectId, input.idempotencyKey);
      if (existing) {
        if (
          existing.source_task_id !== source.id
          || existing.target_task_id !== target.id
          || existing.fingerprint !== fingerprint
        ) {
          throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_IDEMPOTENCY_CONFLICT", "The idempotency key is bound to a different dependency frontier");
        }
        this.database.exec("COMMIT");
        return { applied: false, clearance: this.listCrossDomainDependencyClearances(target.id).find((item) => item.sourceTaskId === source.id) };
      }
      const id = randomUUID();
      const timestamp = now();
      this.#prepare(`
        INSERT INTO cross_domain_dependency_clearances (
          id, idempotency_key, fingerprint, project_id,
          source_task_id, source_task_version, target_task_id, target_task_version,
          edge_created_at, source_domain_id, source_assigned_by_lease_id,
          source_assigned_by_task_id, source_assigned_by_thread_id, source_assignment_updated_at,
          target_domain_id, target_assigned_by_lease_id,
          target_assigned_by_task_id, target_assigned_by_thread_id, target_assignment_updated_at, target_domain_lease_id,
          target_holder_task_id, target_holder_thread_id, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.idempotencyKey, fingerprint, target.projectId,
        source.id, source.version, target.id, target.version,
        edge.created_at, sourceAssignment.domainId, sourceAssignment.assignedByLeaseId,
        sourceAssignment.assignedByTaskId, sourceAssignment.assignedByThreadId, sourceAssignment.updatedAt,
        targetAssignment.domainId, targetAssignment.assignedByLeaseId,
        targetAssignment.assignedByTaskId, targetAssignment.assignedByThreadId, targetAssignment.updatedAt, route.leaseId,
        route.holderTaskId, route.holderThreadId, timestamp,
      );
      this.database.exec("COMMIT");
      return { applied: true, clearance: this.listCrossDomainDependencyClearances(target.id).find((item) => item.sourceTaskId === source.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listAgentLaneProjectIds() {
    return this.#prepare("SELECT project_id FROM agent_lane_projects ORDER BY project_id")
      .all().map((row) => row.project_id);
  }

  upsertAgentLaneProject(projectId, config) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    this.#assertNoActiveOwnerDecisionDelivery(projectId);
    const timestamp = now();
    const coordinationDomains = normalizeCoordinationDomains(config);
    const normalizedConfig = config.coordinationDomains === undefined
      ? config
      : { ...config, coordinationDomains };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      const assignedDomainIds = this.#prepare(`
        SELECT DISTINCT domain_id FROM agent_task_domain_assignments WHERE project_id = ?
      `).all(projectId).map((row) => row.domain_id);
      if (currentRow && assignedDomainIds.length > 0) {
        const currentDomains = normalizeCoordinationDomains(JSON.parse(currentRow.config_json));
        for (const domainId of assignedDomainIds) {
          const currentDomain = currentDomains.find((domain) => domain.id === domainId);
          const nextDomain = coordinationDomains.find((domain) => domain.id === domainId);
          if (!sameCoordinationDomainPolicy(currentDomain, nextDomain)) {
            throw new ApiError(
              409,
              "ASSIGNED_COORDINATION_DOMAIN_CHANGE",
              "Clear every assigned Todo before changing or removing its coordination domain policy",
            );
          }
        }
      }
      this.#prepare(`
        INSERT INTO agent_lane_projects (project_id, config_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `).run(projectId, JSON.stringify(normalizedConfig), timestamp);
      this.database.exec("COMMIT");
      return this.getAgentLaneProject(projectId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimAgentLaneDomainCoordinator(projectId, domainId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const config = JSON.parse(row.config_json);
      const domain = normalizeCoordinationDomains(config).find((entry) => entry.id === domainId);
      if (!domain) throw new ApiError(404, "COORDINATION_DOMAIN_NOT_FOUND", `Coordination domain '${domainId}' does not exist`);
      const holder = Array.isArray(config.tasks)
        ? config.tasks.find((task) => task?.id === input.holderTaskId)
        : null;
      if (!isFullyBoundCodexPeerTask(holder)
        || holder.threadId !== input.holderThreadId
        || !domain.eligibleTaskIds.includes(input.holderTaskId)) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Domain coordinator must match one eligible configured peer window");
      }
      if (!holder.codexHostId
        || typeof holder.workspacePath !== "string"
        || !path.isAbsolute(holder.workspacePath)) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Domain coordinator requires a complete configured window binding");
      }
      const leases = config.domainCoordinatorLeases ?? {};
      const existing = leases[domainId] ?? null;
      if ((existing?.id ?? null) !== input.expectedLeaseId) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_CONFLICT", "Domain coordinator lease changed since it was read", {
          actualLeaseId: existing?.id ?? null,
        });
      }
      const timestamp = now();
      const observedAt = Date.parse(timestamp);
      const releasedAt = existing?.releasedAt
        ?? this.#domainCoordinatorLeaseReleasedAt(projectId, domainId, existing);
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        existing,
        observedAt,
        domainId,
      );
      const active = Boolean(activeCoordinator);
      const naturallyExpired = existing
        && Number.isFinite(Date.parse(existing.acquiredAt))
        && Number.isFinite(Date.parse(existing.expiresAt))
        && Date.parse(existing.acquiredAt) < Date.parse(existing.expiresAt)
        && Date.parse(existing.expiresAt) <= observedAt;
      if (existing
        && !active
        && !releasedAt
        && Date.parse(existing.expiresAt) > observedAt) {
        throw new ApiError(
          409,
          "DOMAIN_COORDINATOR_BINDING_MISMATCH",
          "Unexpired domain coordinator lease is not exact-active on its persisted window binding",
        );
      }
      if (active && existing.holderTaskId !== input.holderTaskId) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_ACTIVE", "Another peer window holds the active domain coordinator lease");
      }
      if (active && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderThreadId !== holder.threadId
        || existing.holderCodexHostId !== holder.codexHostId
        || path.resolve(existing.holderWorkspacePath) !== path.resolve(holder.workspacePath)
      )) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Active domain coordinator lease has no current exact window binding");
      }
      if (input.renewOnly === true && !active) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_NOT_ACTIVE", "Domain coordinator lease is not active");
      }
      if (input.renewOnly === true && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderThreadId !== input.holderThreadId
        || existing.holderCodexHostId !== input.holderCodexHostId
        || path.resolve(existing.holderWorkspacePath) !== input.holderWorkspacePath
        || holder.threadId !== input.holderThreadId
        || holder.codexHostId !== input.holderCodexHostId
        || path.resolve(holder.workspacePath ?? "") !== input.holderWorkspacePath
      )) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Domain coordinator renewal must match the exact configured window binding");
      }
      if (input.recoverOnly === true && (
        !existing
        || active
        || releasedAt
        || !naturallyExpired
      )) {
        throw new ApiError(
          409,
          "DOMAIN_COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE",
          "Domain coordinator recovery requires a naturally expired lease",
        );
      }
      if (input.recoverOnly === true && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderTaskId !== input.holderTaskId
        || existing.holderThreadId !== input.holderThreadId
        || existing.holderCodexHostId !== input.holderCodexHostId
        || path.resolve(existing.holderWorkspacePath) !== input.holderWorkspacePath
        || holder.threadId !== input.holderThreadId
        || holder.codexHostId !== input.holderCodexHostId
        || path.resolve(holder.workspacePath ?? "") !== input.holderWorkspacePath
      )) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Domain coordinator recovery must match the exact expired window binding");
      }
      const lease = {
        id: active ? existing.id : randomUUID(),
        domainId,
        holderTaskId: input.holderTaskId,
        holderThreadId: holder.threadId,
        holderCodexHostId: holder.codexHostId ?? null,
        holderWorkspacePath: holder.workspacePath ? path.resolve(holder.workspacePath) : null,
        acquiredAt: active ? existing.acquiredAt : timestamp,
        expiresAt: new Date(Date.parse(timestamp) + input.leaseDurationSeconds * 1000).toISOString(),
        writeScope: domain.writeScope,
      };
      this.#prepare(`
        UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
      `).run(JSON.stringify({
        ...config,
        coordinationDomains: normalizeCoordinationDomains(config),
        domainCoordinatorLeases: { ...leases, [domainId]: lease },
      }), timestamp, projectId);
      const receipt = this.#insertDomainCoordinatorLeaseReceipt({
        projectId, domainId, leaseId: lease.id,
        holderTaskId: input.holderTaskId, holderThreadId: input.holderThreadId,
        action: active ? "renewed" : "acquired",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { lease: { ...lease, status: "active" }, receipt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseAgentLaneDomainCoordinator(projectId, domainId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      const config = JSON.parse(row.config_json);
      const domain = normalizeCoordinationDomains(config).find((entry) => entry.id === domainId);
      if (!domain) throw new ApiError(404, "COORDINATION_DOMAIN_NOT_FOUND", `Coordination domain '${domainId}' does not exist`);
      const holder = Array.isArray(config.tasks)
        ? config.tasks.find((task) => task?.id === input.holderTaskId)
        : null;
      if (!holder || holder.threadId !== input.holderThreadId || !domain.eligibleTaskIds.includes(input.holderTaskId)) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_MISMATCH", "Domain coordinator must match one eligible configured peer window");
      }
      const leases = config.domainCoordinatorLeases ?? {};
      const existing = leases[domainId] ?? null;
      if ((existing?.id ?? null) !== input.expectedLeaseId) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_CONFLICT", "Domain coordinator lease changed since it was read", {
          actualLeaseId: existing?.id ?? null,
        });
      }
      const timestamp = now();
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        existing,
        Date.parse(timestamp),
        domainId,
      );
      if (!activeCoordinator) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_NOT_ACTIVE", "Domain coordinator lease is not active");
      }
      if (existing.holderTaskId !== input.holderTaskId) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_ACTIVE", "Another peer window holds the active domain coordinator lease");
      }
      const lease = { ...existing, expiresAt: timestamp, releasedAt: timestamp };
      this.#prepare(`
        UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
      `).run(JSON.stringify({ ...config, domainCoordinatorLeases: { ...leases, [domainId]: lease } }), timestamp, projectId);
      const receipt = this.#insertDomainCoordinatorLeaseReceipt({
        projectId, domainId, leaseId: lease.id,
        holderTaskId: input.holderTaskId, holderThreadId: input.holderThreadId,
        action: "released", createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { lease: { ...lease, status: "expired" }, receipt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimAgentLaneCoordinator(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const config = JSON.parse(row.config_json);
      const holder = Array.isArray(config.tasks)
        ? config.tasks.find((task) => task?.id === input.holderTaskId)
        : null;
      if (config.ownerRootTaskId && input.holderTaskId === config.ownerRootTaskId) {
        throw new ApiError(
          409,
          "OWNER_ROOT_COORDINATOR_CONFLICT",
          "The Owner-facing Root cannot hold the Global Coordinator lease",
        );
      }
      if (!holder
        || holder.threadId !== input.holderThreadId
        || (config.ownerRootTaskId && (
          holder.source !== "codex" || holder.taskType !== "root_task"
        ))) {
        throw new ApiError(
          409,
          "COORDINATOR_BINDING_MISMATCH",
          "Coordinator lease holder must match one configured peer window",
        );
      }
      if (!holder.codexHostId
        || typeof holder.workspacePath !== "string"
        || !path.isAbsolute(holder.workspacePath)) {
        throw new ApiError(
          409,
          "COORDINATOR_BINDING_MISMATCH",
          "Coordinator requires a complete configured window binding",
        );
      }

      const existing = config.coordinatorLease ?? null;
      if ((existing?.id ?? null) !== input.expectedLeaseId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_CONFLICT",
          "Coordinator lease changed since it was read",
          { actualLeaseId: existing?.id ?? null },
        );
      }
      const timestamp = now();
      const observedAt = Date.parse(timestamp);
      const releasedAt = existing?.releasedAt
        ?? this.#coordinatorLeaseReleasedAt(projectId, existing);
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        existing,
        observedAt,
      );
      const active = Boolean(activeCoordinator);
      const naturallyExpired = existing
        && Number.isFinite(Date.parse(existing.acquiredAt))
        && Number.isFinite(Date.parse(existing.expiresAt))
        && Date.parse(existing.acquiredAt) < Date.parse(existing.expiresAt)
        && Date.parse(existing.expiresAt) <= observedAt;
      if (existing
        && !active
        && !releasedAt
        && Date.parse(existing.expiresAt) > observedAt) {
        throw new ApiError(
          409,
          "COORDINATOR_BINDING_MISMATCH",
          "Unexpired coordinator lease is not exact-active on its persisted window binding",
        );
      }
      if (active && existing.holderTaskId !== input.holderTaskId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_ACTIVE",
          "Another peer window holds the active coordinator lease",
        );
      }
      if (active && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderThreadId !== holder.threadId
        || existing.holderCodexHostId !== holder.codexHostId
        || path.resolve(existing.holderWorkspacePath) !== path.resolve(holder.workspacePath)
      )) {
        throw new ApiError(409, "COORDINATOR_BINDING_MISMATCH", "Active coordinator lease has no current exact window binding");
      }
      if (input.renewOnly === true && !active) {
        throw new ApiError(409, "COORDINATOR_LEASE_NOT_ACTIVE", "Coordinator lease is not active");
      }
      if (input.renewOnly === true && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderThreadId !== input.holderThreadId
        || existing.holderCodexHostId !== input.holderCodexHostId
        || path.resolve(existing.holderWorkspacePath) !== input.holderWorkspacePath
        || holder.threadId !== input.holderThreadId
        || holder.codexHostId !== input.holderCodexHostId
        || path.resolve(holder.workspacePath ?? "") !== input.holderWorkspacePath
      )) {
        throw new ApiError(409, "COORDINATOR_BINDING_MISMATCH", "Coordinator renewal must match the exact configured window binding");
      }
      if (input.recoverOnly === true && (
        !existing
        || active
        || releasedAt
        || !naturallyExpired
      )) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE",
          "Coordinator recovery requires a naturally expired lease",
        );
      }
      if (input.recoverOnly === true && (
        !existing.holderThreadId
        || !existing.holderCodexHostId
        || !existing.holderWorkspacePath
        || !path.isAbsolute(existing.holderWorkspacePath)
        || existing.holderTaskId !== input.holderTaskId
        || existing.holderThreadId !== input.holderThreadId
        || existing.holderCodexHostId !== input.holderCodexHostId
        || path.resolve(existing.holderWorkspacePath) !== input.holderWorkspacePath
        || holder.threadId !== input.holderThreadId
        || holder.codexHostId !== input.holderCodexHostId
        || path.resolve(holder.workspacePath ?? "") !== input.holderWorkspacePath
      )) {
        throw new ApiError(409, "COORDINATOR_BINDING_MISMATCH", "Coordinator recovery must match the exact expired window binding");
      }
      if (!active) this.#assertNoActiveOwnerDecisionDelivery(projectId);

      const requestedExpiresAt = new Date(
        Date.parse(timestamp) + input.leaseDurationSeconds * 1000,
      ).toISOString();
      const ownerDecisionProtectionExpiresAt = active
        ? this.#activeOwnerDecisionProtectionExpiresAt(projectId)
        : null;
      const expiresAt = ownerDecisionProtectionExpiresAt
        && Date.parse(ownerDecisionProtectionExpiresAt) >= Date.parse(requestedExpiresAt)
        ? new Date(Date.parse(ownerDecisionProtectionExpiresAt) + 5_000).toISOString()
        : requestedExpiresAt;
      const lease = {
        id: active ? existing.id : randomUUID(),
        holderTaskId: input.holderTaskId,
        holderThreadId: holder.threadId,
        holderCodexHostId: holder.codexHostId ?? null,
        holderWorkspacePath: holder.workspacePath ? path.resolve(holder.workspacePath) : null,
        acquiredAt: active ? existing.acquiredAt : timestamp,
        expiresAt,
      };
      const nextConfig = { ...config, coordinatorLease: lease };
      if (!this.#exactActiveCoordinatorLease(projectId, nextConfig, lease, observedAt)) {
        throw new ApiError(
          409,
          config.ownerRootTaskId
            ? "OWNER_ROOT_BINDING_MISMATCH"
            : "COORDINATOR_BINDING_MISMATCH",
          config.ownerRootTaskId
            ? "Global Coordinator acquisition requires a fully-bound distinct Owner Root and Codex Root holder"
            : "Global Coordinator acquisition requires an exact configured window binding",
        );
      }
      this.#prepare(`
        UPDATE agent_lane_projects
        SET config_json = ?, updated_at = ?
        WHERE project_id = ?
      `).run(JSON.stringify(nextConfig), timestamp, projectId);
      const receipt = this.#insertCoordinatorLeaseReceipt({
        projectId,
        leaseId: lease.id,
        holderTaskId: input.holderTaskId,
        holderThreadId: input.holderThreadId,
        action: active ? "renewed" : "acquired",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { lease: { ...lease, status: "active" }, receipt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseAgentLaneCoordinator(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!row) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const config = JSON.parse(row.config_json);
      const holder = Array.isArray(config.tasks)
        ? config.tasks.find((task) => task?.id === input.holderTaskId)
        : null;
      if (!holder || holder.threadId !== input.holderThreadId) {
        throw new ApiError(
          409,
          "COORDINATOR_BINDING_MISMATCH",
          "Coordinator lease holder must match one configured peer window",
        );
      }

      const existing = config.coordinatorLease ?? null;
      if ((existing?.id ?? null) !== input.expectedLeaseId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_CONFLICT",
          "Coordinator lease changed since it was read",
          { actualLeaseId: existing?.id ?? null },
        );
      }
      const timestamp = now();
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        existing,
        Date.parse(timestamp),
      );
      if (!activeCoordinator) {
        throw new ApiError(409, "COORDINATOR_LEASE_NOT_ACTIVE", "Coordinator lease is not active");
      }
      if (existing.holderTaskId !== input.holderTaskId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_ACTIVE",
          "Another peer window holds the active coordinator lease",
        );
      }
      this.#assertNoActiveOwnerDecisionDelivery(projectId);

      const lease = { ...existing, expiresAt: timestamp, releasedAt: timestamp };
      this.#prepare(`
        UPDATE agent_lane_projects
        SET config_json = ?, updated_at = ?
        WHERE project_id = ?
      `).run(JSON.stringify({ ...config, coordinatorLease: lease }), timestamp, projectId);
      const receipt = this.#insertCoordinatorLeaseReceipt({
        projectId,
        leaseId: lease.id,
        holderTaskId: input.holderTaskId,
        holderThreadId: input.holderThreadId,
        action: "released",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { lease: { ...lease, status: "expired" }, receipt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  repairLegacyTaskRootBinding(projectId, input, threadBinding, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const laneRow = this.#prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = ?",
      ).get(projectId);
      if (!laneRow) {
        throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
      }
      const config = JSON.parse(laneRow.config_json);
      const holder = Array.isArray(config.tasks)
        ? config.tasks.find((task) => task?.id === input.holderTaskId)
        : null;
      if (!holder || holder.threadId !== input.holderThreadId) {
        throw new ApiError(
          409,
          "COORDINATOR_BINDING_MISMATCH",
          "Binding repair holder must match one configured peer window",
        );
      }
      const lease = config.coordinatorLease ?? null;
      if ((lease?.id ?? null) !== input.expectedLeaseId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_CONFLICT",
          "Coordinator lease changed since it was read",
          { actualLeaseId: lease?.id ?? null },
        );
      }
      const timestamp = now();
      const activeCoordinator = this.#exactActiveCoordinatorLease(
        projectId,
        config,
        lease,
        Date.parse(timestamp),
      );
      if (!activeCoordinator) {
        throw new ApiError(409, "COORDINATOR_LEASE_NOT_ACTIVE", "Coordinator lease is not active");
      }
      if (lease.holderTaskId !== input.holderTaskId) {
        throw new ApiError(
          409,
          "COORDINATOR_LEASE_ACTIVE",
          "Another peer window holds the active coordinator lease",
        );
      }
      if (threadBinding.threadId !== input.holderThreadId
        || threadBinding.codexHostId !== activeCoordinator.holder.codexHostId
        || path.resolve(threadBinding.workspacePath) !== path.resolve(activeCoordinator.holder.workspacePath)) {
        throw new ApiError(409, "COORDINATOR_BINDING_MISMATCH", "Host identity does not match the coordinator thread");
      }

      const task = this.#requireTask(input.taskId);
      if (task.projectId !== projectId) {
        throw new ApiError(409, "TASK_PROJECT_MISMATCH", "Binding repair target belongs to another project");
      }
      this.#requireVersion(task, input.taskVersion);
      if (task.threadBinding) {
        throw new ApiError(409, "ROOT_BINDING_ALREADY_DURABLE", "Task already has a durable Root binding");
      }
      this.#assertNoOpenTaskAgentRunRebinding(task, {}, threadBinding);

      const activityId = randomUUID();
      const previousThreadId = task.legacyLocalThreadId;
      const storedBinding = storedThreadBinding(threadBinding, threadBinding.threadId);
      const updated = this.#prepare(`
        UPDATE tasks SET
          thread_id = ?,
          thread_codex_project_id = ?,
          thread_codex_project_kind = ?,
          thread_codex_host_id = ?,
          thread_workspace_path = ?,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...storedBinding, timestamp, task.id, input.taskVersion);
      if (updated.changes !== 1) this.#throwMissingOrConflict(task.id, input.taskVersion);
      const changes = [
        { field: "threadBinding", before: null, after: threadBinding },
        { field: "legacyLocalThreadId", before: previousThreadId, after: null },
        { field: "coordinatorLeaseId", before: null, after: lease.id },
      ];
      this.#prepare(`
        INSERT INTO task_activities (
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activityId,
        task.id,
        actor.type,
        actor.id,
        actor.name,
        actor.avatarUrl,
        JSON.stringify(changes),
        timestamp,
      );
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        receipt: {
          id: activityId,
          taskId: task.id,
          projectId,
          leaseId: lease.id,
          holderTaskId: input.holderTaskId,
          holderThreadId: input.holderThreadId,
          previousThreadId,
          threadBinding,
          createdAt: timestamp,
        },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listAgentLaneCoordinatorReceipts(projectId, limit = 50) {
    if (!this.getAgentLaneProject(projectId)) {
      throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
    }
    return this.#prepare(`
      SELECT id, project_id, lease_id, holder_task_id, holder_thread_id, action, created_at
      FROM agent_coordinator_lease_receipts
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectId, limit).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      leaseId: row.lease_id,
      holderTaskId: row.holder_task_id,
      holderThreadId: row.holder_thread_id,
      action: row.action,
      createdAt: row.created_at,
    }));
  }

  #insertCoordinatorLeaseReceipt(input) {
    const receipt = { id: randomUUID(), ...input };
    this.#prepare(`
      INSERT INTO agent_coordinator_lease_receipts (
        id, project_id, lease_id, holder_task_id, holder_thread_id, action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id,
      receipt.projectId,
      receipt.leaseId,
      receipt.holderTaskId,
      receipt.holderThreadId,
      receipt.action,
      receipt.createdAt,
    );
    return receipt;
  }

  #coordinatorLeaseReleasedAt(projectId, lease) {
    if (!lease?.id || !lease?.holderTaskId || !lease?.holderThreadId) return null;
    return this.#prepare(`
      SELECT created_at FROM agent_coordinator_lease_receipts
      WHERE project_id = ? AND lease_id = ?
        AND holder_task_id = ? AND holder_thread_id = ? AND action = 'released'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(
      projectId, lease.id, lease.holderTaskId, lease.holderThreadId,
    )?.created_at ?? null;
  }

  listAgentLaneDomainCoordinatorReceipts(projectId, domainId, limit = 50) {
    const config = this.getAgentLaneProject(projectId);
    if (!config) {
      throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
    }
    if (!normalizeCoordinationDomains(config).some((domain) => domain.id === domainId)) {
      throw new ApiError(404, "COORDINATION_DOMAIN_NOT_FOUND", `Coordination domain '${domainId}' does not exist`);
    }
    return this.#prepare(`
      SELECT id, project_id, domain_id, lease_id, holder_task_id, holder_thread_id, action, created_at
      FROM agent_domain_coordinator_lease_receipts
      WHERE project_id = ? AND domain_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectId, domainId, limit).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      domainId: row.domain_id,
      leaseId: row.lease_id,
      holderTaskId: row.holder_task_id,
      holderThreadId: row.holder_thread_id,
      action: row.action,
      createdAt: row.created_at,
    }));
  }

  #insertDomainCoordinatorLeaseReceipt(input) {
    const receipt = { id: randomUUID(), ...input };
    this.#prepare(`
      INSERT INTO agent_domain_coordinator_lease_receipts (
        id, project_id, domain_id, lease_id, holder_task_id, holder_thread_id, action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.id, receipt.projectId, receipt.domainId, receipt.leaseId,
      receipt.holderTaskId, receipt.holderThreadId, receipt.action, receipt.createdAt,
    );
    return receipt;
  }

  #domainCoordinatorLeaseReleasedAt(projectId, domainId, lease) {
    if (!lease?.id || !lease?.holderTaskId || !lease?.holderThreadId) return null;
    return this.#prepare(`
      SELECT created_at FROM agent_domain_coordinator_lease_receipts
      WHERE project_id = ? AND domain_id = ? AND lease_id = ?
        AND holder_task_id = ? AND holder_thread_id = ? AND action = 'released'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(
      projectId, domainId, lease.id, lease.holderTaskId, lease.holderThreadId,
    )?.created_at ?? null;
  }

  #assertNoActiveOwnerDecisionDelivery(projectId) {
    const active = this.#prepare(`
      SELECT delivery.id FROM owner_decision_deliveries AS delivery
      WHERE delivery.project_id = ? AND (
        (delivery.state = 'reserved' AND delivery.reservation_expires_at > ?)
        OR (
          delivery.state = 'delivered'
          AND COALESCE(
            delivery.decision_expires_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', delivery.delivered_at, '+24 hours')
          ) > ?
          AND NOT EXISTS (
            SELECT 1 FROM task_owner_decision_receipts AS receipt
            WHERE receipt.delivery_id = delivery.id
          )
        )
      )
      LIMIT 1
    `).get(projectId, now(), now());
    if (active) {
      throw new ApiError(
        409,
        "OWNER_DECISION_DELIVERY_ACTIVE",
        "Coordinator route cannot change while an Owner decision delivery is active or awaiting a response",
      );
    }
  }

  #activeOwnerDecisionProtectionExpiresAt(projectId) {
    const row = this.#prepare(`
      SELECT MAX(
        CASE
          WHEN delivery.state = 'reserved' THEN delivery.reservation_expires_at
          ELSE COALESCE(
            delivery.decision_expires_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', delivery.delivered_at, '+24 hours')
          )
        END
      ) AS protected_until
      FROM owner_decision_deliveries AS delivery
      WHERE delivery.project_id = ?
        AND (
          (delivery.state = 'reserved' AND delivery.reservation_expires_at > ?)
          OR (
            delivery.state = 'delivered'
            AND COALESCE(
              delivery.decision_expires_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', delivery.delivered_at, '+24 hours')
            ) > ?
            AND NOT EXISTS (
              SELECT 1 FROM task_owner_decision_receipts AS receipt
              WHERE receipt.delivery_id = delivery.id
            )
          )
        )
    `).get(projectId, now(), now());
    return row?.protected_until ?? null;
  }

  getAgentTaskClaim(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const row = this.#prepare(
      "SELECT * FROM agent_task_claims WHERE task_id = ?",
    ).get(task.id);
    return row ? {
      taskId: row.task_id,
      projectId: row.project_id,
      agentPath: row.agent_path,
      agentThreadId: row.agent_thread_id,
      status: row.status,
      claimedAt: row.claimed_at,
      leaseExpiresAt: row.lease_expires_at,
      recoveryLeaseId: row.recovery_lease_id,
      recoveryLeaseExpiresAt: row.recovery_lease_expires_at,
      writeScope: JSON.parse(row.write_scope_json ?? "[]"),
      completedAt: row.completed_at,
    } : null;
  }

  getTaskAgentRun(id) {
    const row = this.#prepare("SELECT * FROM task_agent_runs WHERE id = ?").get(id);
    return row ? taskAgentRunFromRow(row) : null;
  }

  getActiveTaskAgentRun(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.#taskAgentRunForTask(task.id, ["active"]);
  }

  getOpenTaskAgentRun(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.#taskAgentRunForTask(task.id, ["active", "blocked"]);
  }

  getLatestTaskAgentRun(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.#taskAgentRunForTask(task.id);
  }

  claimAgentTask(id, version, {
    agentPath, agentThreadId = null, rootThreadId = null, leaseExpiresAt, writeScope,
    admissionReceiptId = null, admissionAttemptId = null,
  }) {
    if (!agentThreadId) {
      throw new ApiError(400, "AGENT_THREAD_REQUIRED", "A durable Sub-Agent claim requires its thread id");
    }
    const leaseDate = typeof leaseExpiresAt === "string" ? new Date(leaseExpiresAt) : null;
    if (!leaseDate || Number.isNaN(leaseDate.getTime()) || leaseDate <= new Date()) {
      throw new ApiError(400, "INVALID_AGENT_LEASE", "A durable Sub-Agent claim requires a future lease expiry");
    }
    if (
      !Array.isArray(writeScope)
      || writeScope.length === 0
      || writeScope.length > 32
      || writeScope.some((item) => typeof item !== "string" || !item.trim() || item.length > 240)
    ) {
      throw new ApiError(400, "INVALID_AGENT_WRITE_SCOPE", "A durable Sub-Agent claim requires a bounded non-empty write scope");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      const rootRun = this.#rootAgentRunBinding(current, rootThreadId);
      const claimCapsule = this.getTaskCapsule(current.id);
      if (claimCapsule.readyWork.reasonCodes.some((reasonCode) => (
        reasonCode === "BLOCKED_BY_INCOMPLETE" || reasonCode === "CROSS_DOMAIN_HANDOFF_REQUIRED"
      ))) {
        throw new ApiError(409, "TASK_DEPENDENCY_NOT_READY", "Task dependencies are not ready at the durable claim frontier");
      }
      const currentClaim = this.getAgentTaskClaim(current.id);
      const currentOpenRun = current.status === "in_progress" && currentClaim?.status === "active"
        ? this.getOpenTaskAgentRun(current.id)
        : null;
      const awaitingReceipt = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE task_id = ? AND status = 'delivering'
          AND admission_state IN ('awaiting_admission', 'prepared', 'admission_uncertain', 'recovery_confirmed')
        ORDER BY claimed_at DESC, id DESC LIMIT 1
      `).get(current.id);
      if ((admissionReceiptId === null) !== (admissionAttemptId === null)) {
        throw new ApiError(400, "INVALID_ADMISSION_BINDING", "Admission receipt and attempt ids must be supplied together");
      }
      if (admissionReceiptId === null && currentOpenRun) {
        const admittedReceipt = this.#prepare(`
          SELECT * FROM task_safe_action_receipts
          WHERE task_id = ? AND status = 'delivered' AND admission_state = 'admitted'
            AND admitted_run_id = ? AND admitted_agent_thread_id = ?
          ORDER BY admitted_at DESC, id DESC LIMIT 1
        `).get(current.id, currentOpenRun.id, currentClaim.agentThreadId);
        if (admittedReceipt) {
          admissionReceiptId = admittedReceipt.id;
          admissionAttemptId = admittedReceipt.admission_attempt_id;
        }
      }
      if (awaitingReceipt && admissionReceiptId === null) {
        throw new ApiError(409, "ADMISSION_BINDING_REQUIRED", "This Todo has a current awaiting admission attempt and requires its exact receipt and attempt ids");
      }
      let admissionReceipt = null;
      if (admissionReceiptId !== null) {
        admissionReceipt = this.#prepare(`
          SELECT * FROM task_safe_action_receipts WHERE id = ?
        `).get(admissionReceiptId);
        const awaitingAdmission = admissionReceipt?.status === "delivering"
          && ["awaiting_admission", "prepared", "recovery_confirmed"].includes(admissionReceipt?.admission_state);
        const admittedReplay = admissionReceipt?.status === "delivered"
          && admissionReceipt?.admission_state === "admitted"
          && admissionReceipt?.admitted_agent_thread_id === agentThreadId;
        if (!admissionReceipt
          || admissionReceipt.task_id !== current.id
          || admissionReceipt.root_thread_id !== rootRun.rootThreadId
          || admissionReceipt.admission_attempt_id !== admissionAttemptId
          || (!awaitingAdmission && !admittedReplay)) {
          throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Agent claim does not match the current awaiting admission attempt");
        }
        this.#assertTaskSafeActionCoordinatorEpoch(admissionReceipt, rootRun);
        if (awaitingAdmission) {
          if (claimCapsule.resumeToken !== admissionReceipt.resume_token
            || claimCapsule.readyWork.eligible !== true
            || claimCapsule.readyWork.safeActions[0]?.id !== admissionReceipt.safe_action_id) {
            throw new ApiError(409, "ADMISSION_FRONTIER_CHANGED", "Task Capsule changed after this admission attempt was delivered");
          }
          if (!["prepared", "recovery_confirmed"].includes(admissionReceipt.admission_state)) {
            throw new ApiError(409, "ADMISSION_NOT_PREPARED", "Admission must persist its deterministic child identity and write scope before claim");
          }
        }
      }
      const normalizedWriteScope = normalizeAgentWriteScope(writeScope, rootRun.worktreePath);
      if (["prepared", "recovery_confirmed", "admitted"].includes(admissionReceipt?.admission_state)) {
        if (agentPath !== admissionReceipt.admission_agent_path) {
          throw new ApiError(409, "ADMISSION_AGENT_MISMATCH", "Agent claim does not match the prepared deterministic child path");
        }
        if (JSON.stringify(normalizedWriteScope) !== admissionReceipt.admission_write_scope_json) {
          throw new ApiError(409, "ADMISSION_WRITE_SCOPE_MISMATCH", "Agent claim does not match the prepared write scope");
        }
        if (admissionReceipt.admission_state === "recovery_confirmed"
          && agentThreadId !== admissionReceipt.admission_recovered_agent_thread_id) {
          throw new ApiError(409, "ADMISSION_AGENT_MISMATCH", "Recovered claim does not match the observed durable child thread");
        }
      }
      if (rootRun.domainWriteScope && normalizedWriteScope.some((entry) => !scopeIsContainedBy(
        entry,
        rootRun.domainWriteScope,
        this.isPathCaseSensitive(rootRun.worktreePath),
      ))) {
        throw new ApiError(409, "DOMAIN_WRITE_SCOPE_VIOLATION", "Agent write scope must stay inside the assigned coordination domain");
      }
      if (rootRun.domainLeaseExpiresAt && leaseDate > new Date(rootRun.domainLeaseExpiresAt)) {
        throw new ApiError(409, "DOMAIN_LEASE_BOUNDARY", "Agent claim lease cannot outlive the active domain coordinator lease");
      }
      if (current.status === "in_progress" && currentClaim?.status === "active") {
        if (new Date(currentClaim.leaseExpiresAt) <= new Date()) {
          throw new ApiError(409, "CLAIM_EXPIRED", "The existing claim lease expired and requires coordinator review");
        }
        if (currentClaim.agentPath !== agentPath || currentClaim.agentThreadId !== agentThreadId) {
          throw new ApiError(409, "CLAIM_CONFLICT", "The task is already claimed by another Sub-Agent");
        }
        const timestamp = now();
        this.#prepare(`
          UPDATE agent_task_claims SET lease_expires_at = ?, write_scope_json = ?
          WHERE task_id = ? AND status = 'active'
        `).run(leaseExpiresAt, JSON.stringify(normalizedWriteScope), current.id);
        const openRun = currentOpenRun;
        if (openRun && (
          openRun.agentPath !== agentPath || openRun.agentThreadId !== agentThreadId
        )) {
          throw new ApiError(409, "RUN_CONFLICT", "The task has a durable run owned by another Sub-Agent");
        }
        if (openRun) {
          this.#assertTaskAgentRunBinding(openRun, current, rootRun);
          this.#prepare(`
            UPDATE task_agent_runs
            SET status = 'active', version = version + 1, updated_at = ?,
              write_scope_json = ?, finished_at = NULL
            WHERE id = ?
          `).run(timestamp, JSON.stringify(normalizedWriteScope), openRun.id);
        } else {
          this.#createTaskAgentRun(current, rootRun, agentPath, agentThreadId, normalizedWriteScope, timestamp);
        }
        this.database.exec("COMMIT");
        return {
          task: this.getTask(current.id),
          claim: this.getAgentTaskClaim(current.id),
          run: this.getActiveTaskAgentRun(current.id),
        };
      }
      if (current.status !== "todo") {
        throw new ApiError(409, "TASK_NOT_READY", "Only a To-Do task can be claimed");
      }
      if (this.getOpenTaskAgentRun(current.id)) {
        throw new ApiError(409, "RUN_CONFLICT", "The task has an unresolved durable Agent Run");
      }
      const existing = this.#prepare(`
        SELECT task_id FROM agent_task_claims
        WHERE project_id = ? AND agent_thread_id = ? AND status = 'active' AND task_id <> ?
      `).get(current.projectId, agentThreadId, current.id);
      if (existing) {
        throw new ApiError(
          409,
          "AGENT_ALREADY_CLAIMED",
          "This Sub-Agent thread already has an active task claim",
        );
      }
      const timestamp = now();
      const result = this.#prepare(`
        UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.#prepare(`
        INSERT INTO agent_task_claims (
          task_id, project_id, agent_path, agent_thread_id, status, claimed_at,
          lease_expires_at, write_scope_json, completed_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
        ON CONFLICT(task_id) DO UPDATE SET
          agent_path = excluded.agent_path,
          agent_thread_id = excluded.agent_thread_id,
          status = 'active', claimed_at = excluded.claimed_at,
          lease_expires_at = excluded.lease_expires_at,
          write_scope_json = excluded.write_scope_json, completed_at = NULL
      `).run(current.id, current.projectId, agentPath, agentThreadId, timestamp, leaseExpiresAt, JSON.stringify(normalizedWriteScope));
      this.#createTaskAgentRun(current, rootRun, agentPath, agentThreadId, normalizedWriteScope, timestamp);
      const admittedRun = this.getActiveTaskAgentRun(current.id);
      if (admissionReceipt) {
        const admitted = this.#prepare(`
          UPDATE task_safe_action_receipts
          SET status = 'delivered', admission_state = 'admitted', admitted_run_id = ?,
            admitted_agent_thread_id = ?, admitted_at = ?, delivered_at = ?
          WHERE id = ? AND status = 'delivering'
            AND admission_state IN ('prepared', 'recovery_confirmed')
            AND admission_attempt_id = ?
        `).run(
          admittedRun.id,
          agentThreadId,
          timestamp,
          timestamp,
          admissionReceipt.id,
          admissionAttemptId,
        );
        if (admitted.changes !== 1) {
          throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission attempt changed before the Agent claim was persisted");
        }
      }
      this.database.exec("COMMIT");
      return {
        task: this.getTask(current.id),
        claim: this.getAgentTaskClaim(current.id),
        run: this.getActiveTaskAgentRun(current.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  checkpointTaskAgentRun(id, version, { agentThreadId, status, summary, nextAction }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTaskAgentRun(id);
      this.#assertAgentRunThread(current, agentThreadId);
      if (current.status === status && current.summary === summary && current.nextAction === nextAction) {
        this.database.exec("COMMIT");
        return { applied: false, run: current, task: this.getTask(current.taskId) };
      }
      if (!["active", "blocked"].includes(current.status)) {
        throw new ApiError(409, "RUN_FINISHED", "A finished Agent Run cannot be checkpointed");
      }
      this.#requireAgentRunVersion(current, version);
      const timestamp = now();
      this.#prepare(`
        UPDATE task_agent_runs
        SET status = ?, version = version + 1, updated_at = ?, summary = ?, next_action = ?
        WHERE id = ? AND version = ?
      `).run(status, timestamp, summary, nextAction, current.id, version);
      this.database.exec("COMMIT");
      return { applied: true, run: this.getTaskAgentRun(current.id), task: this.getTask(current.taskId) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishTaskAgentRun(id, version, { agentThreadId, status, summary, nextAction }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTaskAgentRun(id);
      this.#assertAgentRunThread(current, agentThreadId);
      if (current.status === status && current.summary === summary && current.nextAction === nextAction) {
        this.database.exec("COMMIT");
        return { applied: false, run: current, task: this.getTask(current.taskId) };
      }
      if (!["active", "blocked"].includes(current.status)) {
        throw new ApiError(409, "RUN_FINISHED", "An Agent Run can only be finished once");
      }
      this.#requireAgentRunVersion(current, version);
      const task = this.#requireTask(current.taskId);
      const timestamp = now();
      this.#prepare(`
        UPDATE task_agent_runs
        SET status = ?, version = version + 1, updated_at = ?, finished_at = ?, summary = ?, next_action = ?
        WHERE id = ? AND version = ?
      `).run(status, timestamp, timestamp, summary, nextAction, current.id, version);
      this.#prepare(`
        UPDATE agent_task_claims
        SET status = ?, completed_at = ?
        WHERE task_id = ? AND status = 'active' AND agent_thread_id = ?
      `).run(status === "completed" ? "completed" : "interrupted", timestamp, task.id, agentThreadId);
      if (status === "completed") {
        const result = this.#prepare(`
          UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'in_progress'
        `).run(timestamp, task.id);
        if (result.changes !== 1) {
          throw new ApiError(409, "TASK_NOT_IN_PROGRESS", "Only an in-progress task can be completed by an Agent Run");
        }
      }
      this.database.exec("COMMIT");
      return { applied: true, run: this.getTaskAgentRun(current.id), task: this.getTask(task.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordAgentTaskProgress(taskId, { eventId, agentThreadId, summary, actor }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(taskId);
      if (current.status !== "in_progress") {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "task_not_in_progress" };
      }
      const claim = this.getAgentTaskClaim(current.id);
      if (!claim || claim.status !== "active") {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "no_active_claim" };
      }
      if (!claim.leaseExpiresAt || new Date(claim.leaseExpiresAt) <= new Date()) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "claim_expired" };
      }
      if (!agentThreadId || claim.projectId !== current.projectId || claim.agentThreadId !== agentThreadId) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "claim_mismatch" };
      }
      if (this.#prepare("SELECT 1 FROM agent_event_receipts WHERE event_id = ?").get(eventId)) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "duplicate" };
      }
      const timestamp = now();
      const commentId = randomUUID();
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, author_type, author_id, author_name,
          author_avatar_url, version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        commentId, current.id, `Sub-Agent 进展：${summary}`, agentThreadId,
        actor.type, actor.id, actor.name, actor.avatarUrl, timestamp, timestamp, changeRevision,
      );
      this.#prepare(`
        INSERT INTO agent_event_receipts (event_id, project_id, task_id, comment_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(eventId, current.projectId, current.id, commentId, timestamp);
      this.database.exec("COMMIT");
      return { applied: true, comment: this.listComments(current.id).at(-1), task: this.getTask(current.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeAgentTask(taskId, { eventId, agentThreadId, summary, actor }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(taskId);
      if (current.status !== "in_progress") {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "task_not_in_progress" };
      }
      const claim = this.getAgentTaskClaim(current.id);
      if (!claim || claim.status !== "active") {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "no_active_claim" };
      }
      if (!claim.leaseExpiresAt || new Date(claim.leaseExpiresAt) <= new Date()) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "claim_expired" };
      }
      if (!agentThreadId || claim.projectId !== current.projectId || claim.agentThreadId !== agentThreadId) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "claim_mismatch" };
      }
      const timestamp = now();
      const commentId = randomUUID();
      if (this.#prepare("SELECT 1 FROM agent_event_receipts WHERE event_id = ?").get(eventId)) {
        this.database.exec("ROLLBACK");
        return { applied: false, reason: "duplicate" };
      }
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, author_type, author_id, author_name,
          author_avatar_url, version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        commentId, current.id, `Sub-Agent 完成：${summary}`, agentThreadId,
        actor.type, actor.id, actor.name, actor.avatarUrl, timestamp, timestamp, changeRevision,
      );
      this.#prepare(`
        INSERT INTO agent_event_receipts (event_id, project_id, task_id, comment_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(eventId, current.projectId, current.id, commentId, timestamp);
      const transitioned = this.#prepare(`
        UPDATE agent_task_claims SET status = 'completed', completed_at = ?
        WHERE task_id = ? AND status = 'active' AND agent_thread_id = ?
      `).run(timestamp, current.id, agentThreadId);
      if (transitioned.changes !== 1) throw new ApiError(409, "CLAIM_CONFLICT", "Agent claim changed during completion");
      this.#prepare(`
        UPDATE task_agent_runs
        SET status = 'completed', version = version + 1, updated_at = ?, finished_at = ?, summary = ?
        WHERE task_id = ? AND status IN ('active', 'blocked') AND agent_thread_id = ?
      `).run(timestamp, timestamp, summary, current.id, agentThreadId);
      this.#prepare(`
        UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, current.id);
      this.database.exec("COMMIT");
      return { applied: true, comment: this.listComments(current.id).at(-1), task: this.getTask(current.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTask(id) {
    const row = this.#prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    return attachTaskActivity(task, comments, activities, previewImage);
  }

  recordTaskWorktreeRepository(taskId, {
    worktreePath,
    expectedBranch,
    repository,
    verifiedAt,
  }) {
    const task = this.#requireTask(taskId);
    if (task.developmentContext?.type !== "worktree"
      || task.developmentContext.path !== worktreePath
      || task.developmentContext.branch !== expectedBranch) {
      throw new ApiError(409, "WORKTREE_CHANGED", "Task worktree or branch changed during repository verification");
    }
    const result = this.#prepare(`
      UPDATE tasks
      SET worktree_repository = ?, worktree_repository_verified_at = ?
      WHERE id = ? AND worktree_path = ? AND worktree_branch = ?
    `).run(repository, verifiedAt, task.id, worktreePath, expectedBranch);
    if (result.changes !== 1) {
      throw new ApiError(409, "WORKTREE_CHANGED", "Task worktree or branch changed during repository verification");
    }
    return this.getTask(task.id);
  }

  listProjectStandingAuthorities(projectId) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.#prepare(`
      SELECT * FROM project_standing_authorities
      WHERE project_id = ?
      ORDER BY created_at, id
    `).all(projectId).map(standingAuthorityFromRow);
  }

  grantProjectStandingAuthority(projectId, input, actor) {
    const repository = normalizeRepository(input.repository);
    const actions = normalizeStandingActions(input.actions);
    if (!repository || !actions) {
      throw new ApiError(400, "INVALID_STANDING_AUTHORITY", "Standing authority scope is invalid");
    }
    const grantedAt = Date.parse(input.grantedAt);
    const expiresAt = input.expiresAt === null ? null : Date.parse(input.expiresAt);
    if (Number.isNaN(grantedAt)
      || grantedAt > Date.now() + 5 * 60 * 1_000
      || (expiresAt !== null && (Number.isNaN(expiresAt) || expiresAt <= grantedAt))) {
      throw new ApiError(400, "INVALID_STANDING_AUTHORITY", "Standing authority time bounds are invalid");
    }
    const sourceTask = this.getTask(input.sourceTaskId);
    if (!sourceTask || sourceTask.projectId !== projectId) {
      throw new ApiError(409, "STANDING_AUTHORITY_SOURCE_MISMATCH", "Source task must belong to the authority project");
    }
    if (!sourceTask.threadBinding || sourceTask.threadBinding.threadId !== input.sourceThreadId) {
      throw new ApiError(409, "STANDING_AUTHORITY_ROOT_MISMATCH", "Source thread must be the task's confirmed Root");
    }
    const existing = this.#prepare(`
      SELECT * FROM project_standing_authorities WHERE receipt = ?
    `).get(input.receipt);
    if (existing) {
      const authority = standingAuthorityFromRow(existing);
      if (authority.projectId === projectId
        && authority.repository === repository
        && JSON.stringify(authority.actions) === JSON.stringify(actions)
        && authority.sourceTaskId === sourceTask.id
        && authority.sourceThreadId === input.sourceThreadId
        && authority.evidence === input.evidence
        && authority.grantedAt === input.grantedAt
        && authority.expiresAt === input.expiresAt) {
        return { created: false, authority };
      }
      throw new ApiError(409, "STANDING_AUTHORITY_RECEIPT_CONFLICT", "Receipt is already bound to a different grant");
    }
    const id = randomUUID();
    const timestamp = now();
    this.#prepare(`
      INSERT INTO project_standing_authorities (
        id, project_id, repository, actions_json, source_task_id, source_thread_id,
        evidence, receipt, recorded_by_type, recorded_by_id, recorded_by_name,
        granted_at, expires_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id, projectId, repository, JSON.stringify(actions), sourceTask.id, input.sourceThreadId,
      input.evidence, input.receipt, actor.type, actor.id, actor.name,
      input.grantedAt, input.expiresAt, timestamp, timestamp,
    );
    return { created: true, authority: standingAuthorityFromRow(this.#prepare(`
      SELECT * FROM project_standing_authorities WHERE id = ?
    `).get(id)) };
  }

  revokeProjectStandingAuthority(projectId, authorityId, input, actor) {
    const row = this.#prepare(`
      SELECT * FROM project_standing_authorities WHERE id = ? AND project_id = ?
    `).get(authorityId, projectId);
    if (!row) throw new ApiError(404, "STANDING_AUTHORITY_NOT_FOUND", "Standing authority does not exist");
    const receiptOwner = this.#prepare(`
      SELECT * FROM project_standing_authorities WHERE revocation_receipt = ?
    `).get(input.receipt);
    if (receiptOwner) {
      const authority = standingAuthorityFromRow(receiptOwner);
      if (authority.id === authorityId && authority.revocationEvidence === input.evidence) {
        return { changed: false, authority };
      }
      throw new ApiError(409, "STANDING_AUTHORITY_RECEIPT_CONFLICT", "Receipt is already bound to a different revocation");
    }
    if (row.revoked_at !== null) {
      throw new ApiError(409, "STANDING_AUTHORITY_ALREADY_REVOKED", "Standing authority is already revoked");
    }
    const timestamp = now();
    this.#prepare(`
      UPDATE project_standing_authorities SET
        revoked_at = ?, revocation_evidence = ?, revocation_receipt = ?,
        revoked_by_type = ?, revoked_by_id = ?, revoked_by_name = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(timestamp, input.evidence, input.receipt, actor.type, actor.id, actor.name, timestamp, authorityId);
    return { changed: true, authority: standingAuthorityFromRow(this.#prepare(`
      SELECT * FROM project_standing_authorities WHERE id = ?
    `).get(authorityId)) };
  }

  listTaskOwnerDecisionReceipts(taskId) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM task_owner_decision_receipts
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(ownerDecisionReceiptFromRow);
  }

  claimOwnerDecisionDelivery(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(input.taskId);
      if (task.projectId !== projectId) {
        throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision task is not in this project");
      }
      const capsule = this.getTaskCapsule(task.id);
      const request = capsule.readyWork.ownerDecisionRequest;
      if (!request
        || request.requestId !== input.requestId
        || request.expectedResumeToken !== input.expectedResumeToken
        || request.actionId !== input.actionId) {
        throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision request is no longer current");
      }
      const route = this.#currentOwnerDecisionRoute(projectId);
      if (route.coordinatorEpoch !== input.coordinatorEpoch
        || route.rootTaskId !== input.route.rootTaskId
        || route.rootThreadId !== input.route.rootThreadId
        || route.codexHostId !== input.route.codexHostId
        || path.resolve(route.rootWorkspacePath) !== path.resolve(input.route.rootWorkspacePath)) {
        throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision coordinator route changed before delivery");
      }
      const routeKey = createHash("sha256").update(JSON.stringify([
        task.id,
        input.requestId,
        input.expectedResumeToken,
        input.coordinatorEpoch,
        input.route.rootTaskId,
        input.route.rootThreadId,
        input.route.codexHostId,
        input.route.rootWorkspacePath,
      ])).digest("hex");
      const existing = this.#prepare(`
        SELECT * FROM owner_decision_deliveries WHERE route_key = ?
      `).get(routeKey);
      const observedAt = now();
      if (existing?.state === "delivered") {
        if (!existing.decision_expires_at) {
          const decisionExpiresAt = new Date(Date.now() + OWNER_DECISION_RESPONSE_TTL_MS).toISOString();
          this.#extendCoordinatorLeaseForOwnerDecision(projectId, route, decisionExpiresAt);
          this.#prepare(`
            UPDATE owner_decision_deliveries
            SET decision_expires_at = ?
            WHERE id = ? AND decision_expires_at IS NULL
          `).run(decisionExpiresAt, existing.id);
        }
        this.database.exec("COMMIT");
        return {
          claimed: false,
          reason: "already-delivered",
          receipt: { id: existing.id, deliveryTurnId: existing.delivery_turn_id },
        };
      }
      if (existing && Date.parse(existing.reservation_expires_at) > Date.now()) {
        this.database.exec("COMMIT");
        return {
          claimed: false,
          reason: "reserved",
          receipt: { id: existing.id, reservationExpiresAt: existing.reservation_expires_at },
        };
      }
      const reservationExpiresAt = new Date(Date.now() + OWNER_DECISION_DELIVERY_TTL_MS).toISOString();
      this.#extendCoordinatorLeaseForOwnerDecision(projectId, route, reservationExpiresAt);
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.#prepare(`
          UPDATE owner_decision_deliveries SET
            state = 'reserved', reservation_expires_at = ?, claimed_at = ?,
            delivered_at = NULL, delivery_turn_id = NULL
          WHERE id = ?
        `).run(reservationExpiresAt, observedAt, id);
      } else {
        this.#prepare(`
          INSERT INTO owner_decision_deliveries (
            id, request_id, task_id, project_id, expected_resume_token, coordinator_epoch,
            root_task_id, root_thread_id, codex_host_id, root_workspace_path, route_key,
            state, reservation_expires_at, claimed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
        `).run(
          id, input.requestId, task.id, projectId, input.expectedResumeToken,
          input.coordinatorEpoch, input.route.rootTaskId, input.route.rootThreadId,
          input.route.codexHostId, input.route.rootWorkspacePath, routeKey,
          reservationExpiresAt, observedAt,
        );
      }
      this.database.exec("COMMIT");
      return {
        claimed: true,
        receipt: { id, reservationExpiresAt },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  confirmOwnerDecisionDelivery(projectId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(`
        SELECT * FROM owner_decision_deliveries WHERE id = ? AND project_id = ?
      `).get(input.deliveryId, projectId);
      if (!row) throw new ApiError(409, "OWNER_DECISION_DELIVERY_MISMATCH", "Owner decision delivery does not exist");
      if (row.state === "delivered") {
        if (row.delivery_turn_id !== input.deliveryTurnId) {
          throw new ApiError(409, "OWNER_DECISION_DELIVERY_CONFLICT", "Owner decision delivery is already bound to another Root turn");
        }
        if (!row.decision_expires_at) {
          const route = this.#currentOwnerDecisionRoute(projectId);
          if (route.coordinatorEpoch !== row.coordinator_epoch
            || route.rootTaskId !== row.root_task_id
            || route.rootThreadId !== row.root_thread_id
            || route.codexHostId !== row.codex_host_id
            || path.resolve(route.rootWorkspacePath) !== path.resolve(row.root_workspace_path)) {
            throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision Root route changed before confirmation replay");
          }
          const decisionExpiresAt = new Date(Date.now() + OWNER_DECISION_RESPONSE_TTL_MS).toISOString();
          this.#extendCoordinatorLeaseForOwnerDecision(projectId, route, decisionExpiresAt);
          this.#prepare(`
            UPDATE owner_decision_deliveries SET decision_expires_at = ? WHERE id = ?
          `).run(decisionExpiresAt, row.id);
        }
        this.database.exec("COMMIT");
        return { confirmed: true, reused: true, deliveryId: row.id };
      }
      if (Date.parse(row.reservation_expires_at) <= Date.now()) {
        throw new ApiError(409, "OWNER_DECISION_DELIVERY_EXPIRED", "Owner decision delivery reservation expired before confirmation");
      }
      const route = this.#currentOwnerDecisionRoute(projectId);
      if (route.coordinatorEpoch !== row.coordinator_epoch
        || route.rootTaskId !== row.root_task_id
        || route.rootThreadId !== row.root_thread_id
        || route.codexHostId !== row.codex_host_id
        || path.resolve(route.rootWorkspacePath) !== path.resolve(row.root_workspace_path)) {
        throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision coordinator route changed before confirmation");
      }
      const timestamp = now();
      const decisionExpiresAt = new Date(Date.now() + OWNER_DECISION_RESPONSE_TTL_MS).toISOString();
      this.#extendCoordinatorLeaseForOwnerDecision(projectId, route, decisionExpiresAt);
      this.#prepare(`
        UPDATE owner_decision_deliveries
        SET state = 'delivered', delivered_at = ?, delivery_turn_id = ?, decision_expires_at = ?
        WHERE id = ? AND state = 'reserved'
      `).run(timestamp, input.deliveryTurnId, decisionExpiresAt, row.id);
      this.database.exec("COMMIT");
      return { confirmed: true, reused: false, deliveryId: row.id };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #currentOwnerDecisionRoute(projectId) {
    const config = this.getAgentLaneProject(projectId);
    if (!config) throw new ApiError(409, "OWNER_DECISION_ROUTE_NOT_READY", "Project has no Agent Lane coordinator");
    const lease = config.coordinatorLease ?? null;
    let coordinatorTaskId;
    let coordinatorEpoch;
    if (lease) {
      const activeCoordinator = this.#exactActiveCoordinatorLease(projectId, config, lease);
      if (!activeCoordinator) {
        throw new ApiError(409, "OWNER_DECISION_ROUTE_NOT_READY", "Coordinator lease is not active");
      }
      coordinatorTaskId = lease.holderTaskId;
      coordinatorEpoch = `lease:${lease.id}`;
    } else {
      coordinatorTaskId = config.rootTaskId;
      coordinatorEpoch = `configured:${coordinatorTaskId}`;
    }
    const rootTaskId = config.ownerRootTaskId ?? coordinatorTaskId;
    const rootLane = Array.isArray(config.tasks)
      ? config.tasks.find((candidate) => candidate.id === rootTaskId)
      : null;
    if (!rootLane?.threadId
      || !rootLane.codexHostId
      || typeof rootLane.workspacePath !== "string"
      || !path.isAbsolute(rootLane.workspacePath)) {
      throw new ApiError(409, "OWNER_DECISION_ROUTE_NOT_READY", "Owner Root has no confirmed thread route");
    }
    return {
      coordinatorTaskId,
      rootTaskId,
      rootThreadId: rootLane.threadId,
      codexHostId: rootLane.codexHostId,
      rootWorkspacePath: path.resolve(rootLane.workspacePath),
      coordinatorEpoch,
    };
  }

  #extendCoordinatorLeaseForOwnerDecision(projectId, route, protectedUntil) {
    if (!route.coordinatorEpoch.startsWith("lease:")) return;
    const config = this.getAgentLaneProject(projectId);
    const lease = config?.coordinatorLease ?? null;
    const activeCoordinator = this.#exactActiveCoordinatorLease(projectId, config, lease);
    if (!activeCoordinator
      || `lease:${lease.id}` !== route.coordinatorEpoch
      || lease.holderTaskId !== route.coordinatorTaskId) {
      throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Coordinator lease changed before delivery reservation");
    }
    const leaseProtectedUntil = new Date(Date.parse(protectedUntil) + 5_000).toISOString();
    if (Date.parse(lease.expiresAt) >= Date.parse(leaseProtectedUntil)) return;
    const timestamp = now();
    const extendedLease = { ...lease, expiresAt: leaseProtectedUntil };
    this.#prepare(`
      UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
    `).run(JSON.stringify({ ...config, coordinatorLease: extendedLease }), timestamp, projectId);
    this.#insertCoordinatorLeaseReceipt({
      projectId,
      leaseId: lease.id,
      holderTaskId: lease.holderTaskId,
      holderThreadId: lease.holderThreadId,
      action: "renewed",
      createdAt: timestamp,
    });
  }

  recordTaskOwnerDecision(taskId, input, actor) {
    if (actor.type !== "agent") {
      throw new ApiError(403, "OWNER_DECISION_ROOT_REQUIRED", "Only the confirmed Codex Root may attest an Owner decision");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const delivery = this.#prepare(`
        SELECT * FROM owner_decision_deliveries WHERE id = ?
      `).get(input.deliveryId);
      if (!delivery
        || delivery.state !== "delivered"
        || delivery.task_id !== task.id
        || delivery.request_id !== input.requestId
        || delivery.expected_resume_token !== input.expectedResumeToken
        || delivery.root_thread_id !== input.rootThreadId) {
        throw new ApiError(409, "OWNER_DECISION_DELIVERY_REQUIRED", "Decision requires a host-observed exact Root delivery and Owner turn");
      }
      const existingRow = this.#prepare(`
        SELECT * FROM task_owner_decision_receipts WHERE request_id = ? OR receipt = ?
      `).get(input.requestId, input.receipt);
      if (existingRow) {
        const existing = ownerDecisionReceiptFromRow(existingRow);
        if (existing.requestId === input.requestId
          && existing.taskId === task.id
          && existing.expectedResumeToken === input.expectedResumeToken
          && existing.outcome === input.outcome
          && existing.deliveryId === input.deliveryId
          && existing.rootThreadId === delivery.root_thread_id
          && existing.coordinatorEpoch === delivery.coordinator_epoch
          && existing.ownerTurnId === input.ownerTurnId
          && existing.rootDecisionTurnId === input.rootDecisionTurnId
          && existing.evidence === input.evidence
          && existing.receipt === input.receipt
          && existing.decidedAt === input.decidedAt) {
          this.database.exec("COMMIT");
          return { applied: false, receipt: existing, capsule: this.getTaskCapsule(task.id) };
        }
        throw new ApiError(409, "OWNER_DECISION_CONFLICT", "Decision request or receipt is already bound to different evidence");
      }
      if (!delivery.decision_expires_at || Date.parse(delivery.decision_expires_at) <= Date.now()) {
        throw new ApiError(409, "OWNER_DECISION_DELIVERY_EXPIRED", "Owner decision response window has expired");
      }
      const currentRoute = this.#currentOwnerDecisionRoute(task.projectId);
      if (currentRoute.rootTaskId !== delivery.root_task_id
        || currentRoute.rootThreadId !== delivery.root_thread_id
        || currentRoute.codexHostId !== delivery.codex_host_id
        || path.resolve(currentRoute.rootWorkspacePath) !== path.resolve(delivery.root_workspace_path)
        || currentRoute.coordinatorEpoch !== delivery.coordinator_epoch) {
        throw new ApiError(409, "OWNER_DECISION_ROOT_MISMATCH", "Decision delivery no longer matches the active Root route");
      }
      const capsule = this.getTaskCapsule(task.id);
      const request = capsule.readyWork.ownerDecisionRequest;
      if (!request
        || request.requestId !== input.requestId
        || request.expectedResumeToken !== input.expectedResumeToken) {
        throw new ApiError(409, "OWNER_DECISION_STALE", "Owner decision request is no longer current");
      }
      const decidedAt = Date.parse(input.decidedAt);
      if (Number.isNaN(decidedAt) || decidedAt > Date.now() + 5 * 60 * 1_000) {
        throw new ApiError(400, "INVALID_OWNER_DECISION", "Decision time is invalid");
      }
      const id = randomUUID();
      const timestamp = now();
      this.#prepare(`
        INSERT INTO task_owner_decision_receipts (
          id, request_id, task_id, project_id, action_id, gate_id, expected_resume_token,
          outcome, root_task_id, root_thread_id, coordinator_epoch, owner_turn_id, root_decision_turn_id,
          evidence, receipt, decided_at, delivery_id, authorization_comment_id, authorization_comment_version,
          recorded_by_type, recorded_by_id, recorded_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, request.requestId, task.id, task.projectId, request.actionId, request.gateId,
        request.expectedResumeToken, input.outcome, currentRoute.rootTaskId, currentRoute.rootThreadId,
        currentRoute.coordinatorEpoch, input.ownerTurnId, input.rootDecisionTurnId,
        input.evidence, input.receipt, input.decidedAt,
        input.deliveryId,
        capsule.authorization.source.commentId, capsule.authorization.source.commentVersion,
        actor.type, actor.id, actor.name, timestamp,
      );
      const recorded = ownerDecisionReceiptFromRow(this.#prepare(`
        SELECT * FROM task_owner_decision_receipts WHERE id = ?
      `).get(id));
      this.database.exec("COMMIT");
      return { applied: true, receipt: recorded, capsule: this.getTaskCapsule(task.id) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskCapsule(id) {
    const task = this.getTask(id);
    if (!task) return null;
    const domainAssignment = this.getAgentTaskDomainAssignment(task.id);
    const laneConfig = domainAssignment ? null : this.getAgentLaneProject(task.projectId);
    const globalLease = laneConfig?.coordinatorLease ?? null;
    const activeGlobalCoordinator = globalLease
      ? this.#exactActiveCoordinatorLease(task.projectId, laneConfig, globalLease)
      : null;
    const globalCoordinatorFrontier = activeGlobalCoordinator ? {
      leaseId: globalLease.id,
      taskId: globalLease.holderTaskId,
      threadId: globalLease.holderThreadId,
      codexHostId: globalLease.holderCodexHostId,
      workspacePath: globalLease.holderWorkspacePath,
    } : null;
    return createTaskCapsule({
      task,
      comments: this.listComments(task.id),
      attachments: this.listAttachments(task.id),
      inboxReceipts: this.listTaskInboxDeliveryReceipts(task.id),
      coordinationEvents: this.listTaskCoordinationEvents(task.id),
      currentClaim: this.getAgentTaskClaim(task.id),
      currentRun: this.getOpenTaskAgentRun(task.id),
      latestRun: this.getLatestTaskAgentRun(task.id),
      standingAuthorities: this.listProjectStandingAuthorities(task.projectId),
      ownerDecisionReceipts: this.listTaskOwnerDecisionReceipts(task.id),
      domainAssignment,
      domainRoute: domainAssignment ? this.getAgentTaskDomainRoute(task.id) : null,
      globalCoordinatorFrontier,
      dependencyClearances: this.listCrossDomainDependencyClearances(task.id),
    });
  }

  claimTaskSafeAction(id, {
    rootThreadId, expectedResumeToken, safeActionId, reservationLeaseId,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const capsule = this.getTaskCapsule(task.id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      if (capsule.resumeToken !== expectedResumeToken) {
        throw new ApiError(409, "RESUME_TOKEN_MISMATCH", "Task Capsule changed before bootstrap claim");
      }
      if (capsule.readyWork.eligible !== true || capsule.readyWork.safeActions.length === 0) {
        throw new ApiError(409, "SAFE_ACTION_NOT_READY", "Task Capsule has no eligible safe action");
      }
      if (capsule.readyWork.safeActions[0].id !== safeActionId) {
        throw new ApiError(409, "SAFE_ACTION_MISMATCH", "Bootstrap claim must match the first authorized safe action");
      }

      const durableDelivery = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE task_id = ? AND safe_action_id = ? AND status IN ('delivering', 'delivered', 'legacy')
        ORDER BY claimed_at DESC, id DESC
        LIMIT 1
      `).get(task.id, safeActionId);
      if (durableDelivery) {
        if (durableDelivery.status === "delivering") {
          if (!this.#taskSafeActionCoordinatorEpochMatches(durableDelivery, rootRun)) {
            this.database.exec("COMMIT");
            return {
              receipt: this.#taskSafeActionReceipt(durableDelivery), reused: true,
              available: false, completed: false, recovering: false,
              coordinatorLeaseChanged: true,
            };
          }
          if (["awaiting_admission", "prepared", "admission_uncertain", "recovery_confirmed"].includes(durableDelivery.admission_state)) {
            this.database.exec("COMMIT");
            return {
              receipt: this.#taskSafeActionReceipt(durableDelivery), reused: true,
            available: false, completed: false, recovering: false, awaitingAdmission: true,
            };
          }
          const observedAt = Date.now();
          const recoveryLeaseExpired = !durableDelivery.recovery_lease_expires_at
            || Date.parse(durableDelivery.recovery_lease_expires_at) <= observedAt;
          if (durableDelivery.recovery_lease_id !== reservationLeaseId && !recoveryLeaseExpired) {
            this.database.exec("COMMIT");
            return {
              receipt: this.#taskSafeActionReceipt(durableDelivery), reused: true,
              available: false, completed: false, recovering: true,
            };
          }
          const recoveryLeaseExpiresAt = new Date(
            observedAt + TASK_SAFE_ACTION_RESERVATION_TTL_MS,
          ).toISOString();
          this.#prepare(`
            UPDATE task_safe_action_receipts
            SET recovery_lease_id = ?, recovery_lease_expires_at = ?
            WHERE id = ? AND status = 'delivering'
          `).run(reservationLeaseId, recoveryLeaseExpiresAt, durableDelivery.id);
          const recovering = this.#prepare(`
            SELECT * FROM task_safe_action_receipts WHERE id = ?
          `).get(durableDelivery.id);
          const observeOnly = recovering.root_thread_id !== rootRun.rootThreadId
            || !this.#taskSafeActionCoordinatorEpochMatches(recovering, rootRun)
            || recovering.resume_token !== expectedResumeToken;
          this.database.exec("COMMIT");
          return {
            receipt: this.#taskSafeActionReceipt(recovering), reused: true,
            available: true, completed: false, recovering: true,
            recoveryLeaseId: reservationLeaseId,
            observeOnly,
            recoveryRoute: {
              rootThreadId: recovering.root_thread_id,
              codexHostId: recovering.root_host_id,
              rootWorkspacePath: recovering.root_workspace_path,
              worktreePath: recovering.worktree_path,
              branch: recovering.worktree_branch,
            },
          };
        }
        this.database.exec("COMMIT");
        return {
          receipt: this.#taskSafeActionReceipt(durableDelivery), reused: true,
          available: false,
          completed: durableDelivery.status === "delivered",
          recovering: false,
          manualRecoveryRequired: durableDelivery.status === "legacy",
        };
      }

      const existing = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE task_id = ? AND resume_token = ?
      `).get(task.id, expectedResumeToken);
      if (existing) {
        if (existing.safe_action_id !== safeActionId || existing.root_thread_id !== rootThreadId) {
          throw new ApiError(409, "SAFE_ACTION_RECEIPT_BINDING_MISMATCH", "Bootstrap receipt belongs to another Root route");
        }
        if (!this.#taskSafeActionCoordinatorEpochMatches(existing, rootRun)) {
          this.database.exec("COMMIT");
          return {
            receipt: this.#taskSafeActionReceipt(existing), reused: true,
            available: false, completed: false, coordinatorLeaseChanged: true,
          };
        }
        if (existing.status === "delivered") {
          this.database.exec("COMMIT");
          return {
            receipt: this.#taskSafeActionReceipt(existing), reused: true,
            available: false, completed: true,
          };
        }
        const observedAt = Date.now();
        const leaseExpired = !existing.lease_expires_at
          || Date.parse(existing.lease_expires_at) <= observedAt;
        if (existing.reservation_lease_id !== reservationLeaseId && !leaseExpired) {
          this.database.exec("COMMIT");
          return {
            receipt: this.#taskSafeActionReceipt(existing), reused: true,
            available: false, completed: false,
          };
        }
        const leaseExpiresAt = new Date(observedAt + TASK_SAFE_ACTION_RESERVATION_TTL_MS).toISOString();
        const admissionAttemptId = existing.admission_state === "deferred"
          ? randomUUID()
          : existing.admission_attempt_id ?? randomUUID();
        const admissionAgentName = deterministicAdmissionAgentName(task, admissionAttemptId);
        this.#prepare(`
          UPDATE task_safe_action_receipts
          SET reservation_lease_id = ?, lease_expires_at = ?, admission_attempt_id = ?,
            admission_state = 'reserved', recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL, delivery_turn_id = NULL,
            admission_deferred_reason = NULL, admission_retry_after = NULL,
            admission_agent_name = ?, admission_agent_path = ?,
            admission_write_scope_json = NULL, admission_prepared_at = NULL,
            admission_deadline_at = NULL, admission_uncertain_at = NULL,
            admission_registry_observed_at = NULL, admission_recovered_agent_thread_id = NULL,
            admission_probe_id = NULL, admission_probe_requested_at = NULL,
            global_coordinator_lease_id = ?, global_coordinator_task_id = ?,
            global_coordinator_thread_id = ?, coordination_domain_id = ?,
            domain_coordinator_lease_id = ?, domain_coordinator_task_id = ?,
            domain_coordinator_thread_id = ?
          WHERE id = ? AND status = 'reserved'
        `).run(
          reservationLeaseId,
          leaseExpiresAt,
          admissionAttemptId,
          admissionAgentName,
          `/root/${admissionAgentName}`,
          rootRun.globalCoordinatorLeaseId ?? null,
          rootRun.globalCoordinatorTaskId ?? null,
          rootRun.globalCoordinatorLeaseId ? rootRun.rootThreadId : null,
          rootRun.domainId ?? null,
          rootRun.domainCoordinatorLeaseId ?? null,
          rootRun.domainCoordinatorTaskId ?? null,
          rootRun.domainCoordinatorLeaseId ? rootRun.rootThreadId : null,
          existing.id,
        );
        const resumed = this.#prepare(`SELECT * FROM task_safe_action_receipts WHERE id = ?`).get(existing.id);
        this.database.exec("COMMIT");
        return {
          receipt: this.#taskSafeActionReceipt(resumed), reused: true,
          available: true, completed: false, reclaimed: leaseExpired,
        };
      }

      const receipt = {
        id: randomUUID(),
        taskId: task.id,
        projectId: task.projectId,
        resumeToken: expectedResumeToken,
        safeActionId,
        rootThreadId,
        globalCoordinatorLeaseId: rootRun.globalCoordinatorLeaseId ?? null,
        globalCoordinatorTaskId: rootRun.globalCoordinatorTaskId ?? null,
        globalCoordinatorThreadId: rootRun.globalCoordinatorLeaseId ? rootRun.rootThreadId : null,
        coordinationDomainId: rootRun.domainId ?? null,
        domainCoordinatorLeaseId: rootRun.domainCoordinatorLeaseId ?? null,
        domainCoordinatorTaskId: rootRun.domainCoordinatorTaskId ?? null,
        domainCoordinatorThreadId: rootRun.domainCoordinatorLeaseId ? rootRun.rootThreadId : null,
        rootHostId: rootRun.rootHostId,
        rootWorkspacePath: rootRun.rootWorkspacePath,
        worktreePath: rootRun.worktreePath,
        worktreeBranch: rootRun.worktreeBranch,
        claimedAt: now(),
        status: "reserved",
        reservationLeaseId,
        leaseExpiresAt: new Date(Date.now() + TASK_SAFE_ACTION_RESERVATION_TTL_MS).toISOString(),
        admissionAttemptId: randomUUID(),
        admissionState: "reserved",
      };
      receipt.admissionAgentName = deterministicAdmissionAgentName(task, receipt.admissionAttemptId);
      receipt.admissionAgentPath = `/root/${receipt.admissionAgentName}`;
      this.#prepare(`
        INSERT INTO task_safe_action_receipts (
          id, task_id, project_id, resume_token, safe_action_id, root_thread_id,
          global_coordinator_lease_id, global_coordinator_task_id, global_coordinator_thread_id,
          coordination_domain_id, domain_coordinator_lease_id,
          domain_coordinator_task_id, domain_coordinator_thread_id,
          root_host_id, root_workspace_path, worktree_path, worktree_branch, claimed_at,
          status, reservation_lease_id, lease_expires_at, admission_attempt_id, admission_state,
          admission_agent_name, admission_agent_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id,
        receipt.taskId,
        receipt.projectId,
        receipt.resumeToken,
        receipt.safeActionId,
        receipt.rootThreadId,
        receipt.globalCoordinatorLeaseId,
        receipt.globalCoordinatorTaskId,
        receipt.globalCoordinatorThreadId,
        receipt.coordinationDomainId,
        receipt.domainCoordinatorLeaseId,
        receipt.domainCoordinatorTaskId,
        receipt.domainCoordinatorThreadId,
        receipt.rootHostId,
        receipt.rootWorkspacePath,
        receipt.worktreePath,
        receipt.worktreeBranch,
        receipt.claimedAt,
        receipt.status,
        receipt.reservationLeaseId,
        receipt.leaseExpiresAt,
        receipt.admissionAttemptId,
        receipt.admissionState,
        receipt.admissionAgentName,
        receipt.admissionAgentPath,
      );
      this.database.exec("COMMIT");
      return { receipt, reused: false, available: true, completed: false, reclaimed: false };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskSafeActionAdmission(id) {
    const task = this.getTask(id);
    if (!task) return null;
    const row = this.#prepare(`
      SELECT * FROM task_safe_action_receipts
      WHERE task_id = ? AND (
        (
          status = 'delivering'
          AND admission_state IN ('awaiting_admission', 'prepared', 'admission_uncertain', 'recovery_confirmed')
        )
        OR (status = 'reserved' AND admission_state = 'deferred')
      )
      ORDER BY claimed_at DESC, id DESC LIMIT 1
    `).get(task.id);
    if (!row) return null;
    if (row.status === "reserved" && row.admission_state === "deferred") {
      const capsule = this.getTaskCapsule(task.id);
      if (row.resume_token !== capsule.resumeToken
        || row.safe_action_id !== capsule.readyWork.safeActions[0]?.id) {
        return null;
      }
      let rootRun;
      try {
        rootRun = this.#rootAgentRunBinding(task, row.root_thread_id);
      } catch {
        return null;
      }
      if (!this.#taskSafeActionCoordinatorEpochMatches(row, rootRun)) return null;
    }
    return this.#taskSafeActionReceipt(row);
  }

  confirmTaskSafeActionDelivery(id, {
    rootThreadId, expectedResumeToken, safeActionId, reservationLeaseId,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const capsule = this.getTaskCapsule(task.id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      if (capsule.resumeToken !== expectedResumeToken) {
        throw new ApiError(409, "RESUME_TOKEN_MISMATCH", "Task Capsule changed before bootstrap delivery");
      }
      if (capsule.readyWork.eligible !== true || capsule.readyWork.safeActions[0]?.id !== safeActionId) {
        throw new ApiError(409, "SAFE_ACTION_MISMATCH", "Bootstrap delivery must match the current first safe action");
      }
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE task_id = ? AND resume_token = ? AND safe_action_id = ? AND root_thread_id = ?
          AND status = 'reserved' AND reservation_lease_id = ? AND lease_expires_at > ?
      `).get(task.id, expectedResumeToken, safeActionId, rootThreadId, reservationLeaseId, now());
      if (!row) {
        throw new ApiError(409, "SAFE_ACTION_RECEIPT_MISSING", "Bootstrap delivery requires an existing reservation receipt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      this.#prepare(`
        UPDATE task_safe_action_receipts
        SET status = 'delivering', admission_state = 'awaiting_admission',
          recovery_lease_id = ?, recovery_lease_expires_at = ?, admission_deadline_at = ?
        WHERE id = ? AND status = 'reserved'
      `).run(
        reservationLeaseId,
        new Date(Date.now() + TASK_SAFE_ACTION_RESERVATION_TTL_MS).toISOString(),
        new Date(Date.now() + this.admissionTtlMs).toISOString(),
        row.id,
      );
      const delivering = this.#prepare(`SELECT * FROM task_safe_action_receipts WHERE id = ?`).get(row.id);
      this.database.exec("COMMIT");
      return { confirmed: true, receipt: this.#taskSafeActionReceipt(delivering) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeTaskSafeActionDelivery(id, {
    rootThreadId, expectedResumeToken, safeActionId, reservationLeaseId, recoveryLeaseId, deliveryTurnId,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE task_id = ? AND resume_token = ? AND safe_action_id = ? AND root_thread_id = ?
      `).get(task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row) {
        throw new ApiError(409, "SAFE_ACTION_RECEIPT_MISSING", "Bootstrap completion requires an existing reservation receipt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      if (row.status === "delivered") {
        if (row.delivery_turn_id === null && row.admission_state === "admitted") {
          const recorded = this.#prepare(`
            UPDATE task_safe_action_receipts SET delivery_turn_id = ?
            WHERE id = ? AND status = 'delivered' AND admission_state = 'admitted'
              AND delivery_turn_id IS NULL AND reservation_lease_id = ?
          `).run(deliveryTurnId, row.id, reservationLeaseId);
          if (recorded.changes !== 1) {
            throw new ApiError(409, "SAFE_ACTION_DELIVERY_MISMATCH", "Bootstrap admission was finalized by another Root delivery");
          }
          const recordedRow = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
          this.database.exec("COMMIT");
          return { completed: true, reused: false, receipt: this.#taskSafeActionReceipt(recordedRow) };
        }
        if (row.delivery_turn_id !== deliveryTurnId) {
          throw new ApiError(409, "SAFE_ACTION_DELIVERY_MISMATCH", "Bootstrap receipt was completed by another Root delivery");
        }
        this.database.exec("COMMIT");
        return { completed: true, reused: true, receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status === "delivering"
        && ["awaiting_admission", "prepared", "admission_uncertain", "recovery_confirmed"].includes(row.admission_state)
        && row.delivery_turn_id === deliveryTurnId) {
        this.database.exec("COMMIT");
        return {
          completed: false, awaitingAdmission: true, reused: true,
          receipt: this.#taskSafeActionReceipt(row),
        };
      }
      if (row.reservation_lease_id !== reservationLeaseId) {
        throw new ApiError(409, "SAFE_ACTION_RESERVATION_REPLACED", "Bootstrap reservation lease was replaced before completion");
      }
      if (row.recovery_lease_id !== recoveryLeaseId
        || !row.recovery_lease_expires_at
        || Date.parse(row.recovery_lease_expires_at) <= Date.now()) {
        throw new ApiError(409, "SAFE_ACTION_RECOVERY_LEASE_REQUIRED", "Bootstrap completion requires the active recovery lease");
      }
      this.#prepare(`
        UPDATE task_safe_action_receipts
        SET delivery_turn_id = ?
        WHERE id = ? AND status = 'delivering' AND reservation_lease_id = ? AND recovery_lease_id = ?
      `).run(deliveryTurnId, row.id, reservationLeaseId, recoveryLeaseId);
      if (this.#prepare("SELECT changes() AS count").get().count !== 1) {
        throw new ApiError(409, "SAFE_ACTION_DELIVERY_NOT_CONFIRMED", "Bootstrap delivery was not confirmed before completion");
      }
      const completed = this.#prepare(`SELECT * FROM task_safe_action_receipts WHERE id = ?`).get(row.id);
      this.database.exec("COMMIT");
      return {
        completed: false, awaitingAdmission: true, reused: false,
        receipt: this.#taskSafeActionReceipt(completed),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  prepareTaskSafeActionAdmission(id, {
    rootThreadId, expectedResumeToken, safeActionId, admissionReceiptId, admissionAttemptId, writeScope,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE id = ? AND task_id = ? AND resume_token = ? AND safe_action_id = ?
          AND root_thread_id = ?
      `).get(admissionReceiptId, task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row || row.admission_attempt_id !== admissionAttemptId) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission preparation does not match the current attempt");
      }
      const normalizedWriteScope = normalizeAgentWriteScope(writeScope, row.worktree_path);
      const writeScopeJson = JSON.stringify(normalizedWriteScope);
      const existingAssignment = this.getAgentTaskDomainAssignment(task.id);
      if (
        row.status === "reserved"
        && row.admission_state === "deferred"
        && existingAssignment
        && existingAssignment.assignedByThreadId === row.root_thread_id
        && existingAssignment.assignedByLeaseId === row.global_coordinator_lease_id
        && existingAssignment.assignedByTaskId === row.global_coordinator_task_id
      ) {
        this.#assertCurrentGlobalCoordinatorReceiptEpoch(row, task.projectId);
        if (row.admission_write_scope_json !== writeScopeJson) {
          throw new ApiError(409, "ADMISSION_WRITE_SCOPE_MISMATCH", "Global arbitration was already routed with another write scope");
        }
        this.database.exec("COMMIT");
        return {
          applied: false,
          rerouted: true,
          assignment: existingAssignment,
          receipt: this.#taskSafeActionReceipt(row),
        };
      }
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const caseSensitiveWorktree = this.isPathCaseSensitive(rootRun.worktreePath);
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      const capsule = this.getTaskCapsule(task.id);
      if (capsule.resumeToken !== expectedResumeToken
        || capsule.readyWork.eligible !== true
        || capsule.readyWork.safeActions[0]?.id !== safeActionId) {
        throw new ApiError(409, "ADMISSION_FRONTIER_CHANGED", "Task Capsule changed before admission preparation");
      }
      if (rootRun.domainWriteScope && normalizedWriteScope.some((entry) => !scopeIsContainedBy(
        entry,
        rootRun.domainWriteScope,
        caseSensitiveWorktree,
      ))) {
        throw new ApiError(409, "DOMAIN_WRITE_SCOPE_VIOLATION", "Prepared write scope must stay inside the assigned coordination domain");
      }
      if (row.status === "delivering" && row.admission_state === "prepared") {
        if (row.admission_write_scope_json !== writeScopeJson) {
          throw new ApiError(409, "ADMISSION_WRITE_SCOPE_MISMATCH", "Admission was already prepared with another write scope");
        }
        this.database.exec("COMMIT");
        return { applied: false, receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status !== "delivering" || row.admission_state !== "awaiting_admission") {
        throw new ApiError(409, "ADMISSION_NOT_AWAITING", "Only the current awaiting admission attempt can be prepared");
      }
      const timestamp = now();
      if (rootRun.globalCoordinatorLeaseId) {
        const safeAction = capsule.readyWork.safeActions[0];
        const gateKind = capsule.authorization.envelope?.gates
          ?.find((gate) => gate.id === safeAction.gate)?.kind ?? null;
        const config = this.getAgentLaneProject(task.projectId);
        const matchingDomains = gateKind === "shared_runtime"
          ? []
          : normalizeCoordinationDomains(config ?? {}).filter((domain) => (
              normalizedWriteScope.every((entry) => scopeIsContainedBy(
                entry,
                domain.writeScope,
                caseSensitiveWorktree,
              ))
            ));
        if (matchingDomains.length === 1) {
          const domain = matchingDomains[0];
          this.#prepare(`
            INSERT INTO agent_task_domain_assignments (
              task_id, project_id, domain_id, assigned_by_lease_id, assigned_by_task_id,
              assigned_by_thread_id, assigned_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            task.id, task.projectId, domain.id, rootRun.globalCoordinatorLeaseId,
            rootRun.globalCoordinatorTaskId, rootRun.rootThreadId, timestamp, timestamp,
          );
          const taskUpdate = this.#prepare(`
            UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?
          `).run(timestamp, task.id, task.version);
          const receiptUpdate = this.#prepare(`
            UPDATE task_safe_action_receipts
            SET status = 'reserved', admission_state = 'deferred', reservation_lease_id = NULL,
              lease_expires_at = NULL, recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
              admission_deferred_reason = 'domain_reroute', admission_retry_after = NULL,
              admission_write_scope_json = ?
            WHERE id = ? AND status = 'delivering' AND admission_state = 'awaiting_admission'
              AND admission_attempt_id = ?
          `).run(writeScopeJson, row.id, admissionAttemptId);
          if (taskUpdate.changes !== 1 || receiptUpdate.changes !== 1) {
            throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Global arbitration frontier changed before domain routing");
          }
          const assignment = this.getAgentTaskDomainAssignment(task.id);
          const deferred = this.#prepare(
            "SELECT * FROM task_safe_action_receipts WHERE id = ?",
          ).get(row.id);
          this.database.exec("COMMIT");
          return {
            applied: true,
            rerouted: true,
            assignment,
            receipt: this.#taskSafeActionReceipt(deferred),
          };
        }
      }
      const agentName = row.admission_agent_name ?? deterministicAdmissionAgentName(task, admissionAttemptId);
      const agentPath = row.admission_agent_path ?? `/root/${agentName}`;
      const deadlineAt = new Date(Date.parse(timestamp) + this.admissionTtlMs).toISOString();
      const updated = this.#prepare(`
        UPDATE task_safe_action_receipts
        SET admission_state = 'prepared', admission_agent_name = ?, admission_agent_path = ?,
          admission_write_scope_json = ?, admission_prepared_at = ?, admission_deadline_at = ?
        WHERE id = ? AND status = 'delivering' AND admission_state = 'awaiting_admission'
          AND admission_attempt_id = ?
      `).run(agentName, agentPath, writeScopeJson, timestamp, deadlineAt, row.id, admissionAttemptId);
      if (updated.changes !== 1) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission attempt changed before preparation was persisted");
      }
      const prepared = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return { applied: true, receipt: this.#taskSafeActionReceipt(prepared) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markTaskSafeActionAdmissionUncertain(id, {
    rootThreadId, expectedResumeToken, safeActionId, admissionReceiptId, admissionAttemptId,
  }, observedAt = now()) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE id = ? AND task_id = ? AND resume_token = ? AND safe_action_id = ?
          AND root_thread_id = ?
      `).get(admissionReceiptId, task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row || row.admission_attempt_id !== admissionAttemptId) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission timeout does not match the current attempt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      if (row.status === "delivering" && ["admission_uncertain", "recovery_confirmed"].includes(row.admission_state)) {
        this.database.exec("COMMIT");
        return { applied: false, receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status !== "delivering" || !["awaiting_admission", "prepared"].includes(row.admission_state)) {
        throw new ApiError(409, "ADMISSION_NOT_AWAITING", "Only a current awaiting or prepared admission can become uncertain");
      }
      if (!row.admission_deadline_at || Date.parse(row.admission_deadline_at) > Date.parse(observedAt)) {
        throw new ApiError(409, "ADMISSION_DEADLINE_ACTIVE", "Admission deadline has not expired");
      }
      if (this.getOpenTaskAgentRun(task.id) || this.getAgentTaskClaim(task.id)?.status === "active") {
        throw new ApiError(409, "ADMISSION_ALREADY_CLAIMED", "An admitted or open Agent run cannot become uncertain");
      }
      const updated = this.#prepare(`
        UPDATE task_safe_action_receipts
        SET admission_state = 'admission_uncertain', admission_uncertain_at = ?
        WHERE id = ? AND status = 'delivering' AND admission_state IN ('awaiting_admission', 'prepared')
          AND admission_attempt_id = ?
      `).run(observedAt, row.id, admissionAttemptId);
      if (updated.changes !== 1) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission attempt changed before timeout was persisted");
      }
      const uncertain = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return { applied: true, receipt: this.#taskSafeActionReceipt(uncertain) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimTaskSafeActionAdmissionProbe(id, {
    rootThreadId, expectedResumeToken, safeActionId, admissionReceiptId, admissionAttemptId,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE id = ? AND task_id = ? AND resume_token = ? AND safe_action_id = ?
          AND root_thread_id = ?
      `).get(admissionReceiptId, task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row || row.admission_attempt_id !== admissionAttemptId) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission probe does not match the current attempt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      if (row.status !== "delivering" || !["admission_uncertain", "recovery_confirmed"].includes(row.admission_state)) {
        throw new ApiError(409, "ADMISSION_NOT_UNCERTAIN", "Only the current uncertain admission can claim a recovery probe");
      }
      if (row.admission_probe_id) {
        this.database.exec("COMMIT");
        return { applied: false, receipt: this.#taskSafeActionReceipt(row) };
      }
      const probeId = randomUUID();
      const requestedAt = now();
      const updated = this.#prepare(`
        UPDATE task_safe_action_receipts
        SET admission_probe_id = ?, admission_probe_requested_at = ?
        WHERE id = ? AND status = 'delivering' AND admission_state = 'admission_uncertain'
          AND admission_attempt_id = ? AND admission_probe_id IS NULL
      `).run(probeId, requestedAt, row.id, admissionAttemptId);
      if (updated.changes !== 1) {
        throw new ApiError(409, "ADMISSION_PROBE_CONFLICT", "Admission probe changed before it was persisted");
      }
      const probed = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return { applied: true, receipt: this.#taskSafeActionReceipt(probed) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reconcileTaskSafeActionAdmission(id, {
    rootThreadId, expectedResumeToken, safeActionId, admissionReceiptId, admissionAttemptId,
    admissionProbeId, registryObservation,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE id = ? AND task_id = ? AND resume_token = ? AND safe_action_id = ?
          AND root_thread_id = ?
      `).get(admissionReceiptId, task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row || row.admission_attempt_id !== admissionAttemptId) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission reconciliation does not match the current attempt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      if (row.status === "reserved" && row.admission_state === "deferred") {
        this.database.exec("COMMIT");
        return { applied: false, outcome: "absent", receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status === "delivering" && row.admission_state === "recovery_confirmed") {
        this.database.exec("COMMIT");
        return { applied: false, outcome: "present", receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status !== "delivering" || row.admission_state !== "admission_uncertain") {
        throw new ApiError(409, "ADMISSION_NOT_UNCERTAIN", "Only the current uncertain admission can be reconciled");
      }
      if (!row.admission_probe_id
        || row.admission_probe_id !== admissionProbeId
        || !row.admission_probe_requested_at) {
        throw new ApiError(409, "ADMISSION_PROBE_MISMATCH", "Admission reconciliation requires the current durable recovery probe");
      }
      const observedAt = Date.parse(registryObservation?.observedAt ?? "");
      if (registryObservation?.source !== "list_agents"
        || registryObservation?.complete !== true
        || !Array.isArray(registryObservation?.agents)
        || !Number.isFinite(observedAt)
        || observedAt < Date.parse(row.admission_probe_requested_at)) {
        this.database.exec("COMMIT");
        return { applied: false, outcome: "unresolved", receipt: this.#taskSafeActionReceipt(row) };
      }
      const matches = registryObservation.agents.filter((agent) => agent?.agentPath === row.admission_agent_path);
      if (matches.length === 0) {
        if (this.getOpenTaskAgentRun(task.id) || this.getAgentTaskClaim(task.id)?.status === "active") {
          throw new ApiError(409, "ADMISSION_ALREADY_CLAIMED", "An admitted or open Agent run cannot be reconciled as absent");
        }
        const updated = this.#prepare(`
          UPDATE task_safe_action_receipts
          SET status = 'reserved', admission_state = 'deferred', reservation_lease_id = NULL,
            lease_expires_at = NULL, recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
            admission_deferred_reason = 'admission_absent', admission_retry_after = NULL,
            admission_registry_observed_at = ?
          WHERE id = ? AND status = 'delivering' AND admission_state = 'admission_uncertain'
            AND admission_attempt_id = ?
        `).run(registryObservation.observedAt, row.id, admissionAttemptId);
        if (updated.changes !== 1) throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission changed during absence reconciliation");
        const deferred = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
        this.database.exec("COMMIT");
        return { applied: true, outcome: "absent", receipt: this.#taskSafeActionReceipt(deferred) };
      }
      const observed = matches[0];
      if (matches.length !== 1
        || typeof observed.agentThreadId !== "string" || !observed.agentThreadId
        || !["running", "idle", "waiting"].includes(observed.status)) {
        this.database.exec("COMMIT");
        return { applied: false, outcome: "unresolved", receipt: this.#taskSafeActionReceipt(row) };
      }
      const updated = this.#prepare(`
        UPDATE task_safe_action_receipts
        SET admission_state = 'recovery_confirmed', admission_registry_observed_at = ?,
          admission_recovered_agent_thread_id = ?
        WHERE id = ? AND status = 'delivering' AND admission_state = 'admission_uncertain'
          AND admission_attempt_id = ?
      `).run(registryObservation.observedAt, observed.agentThreadId, row.id, admissionAttemptId);
      if (updated.changes !== 1) throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission changed during child reconciliation");
      const confirmed = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return { applied: true, outcome: "present", receipt: this.#taskSafeActionReceipt(confirmed) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deferTaskSafeActionAdmission(id, {
    rootThreadId, expectedResumeToken, safeActionId, admissionReceiptId, admissionAttemptId,
  }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const rootRun = this.#rootAgentRunBinding(task, rootThreadId);
      const row = this.#prepare(`
        SELECT * FROM task_safe_action_receipts
        WHERE id = ? AND task_id = ? AND resume_token = ? AND safe_action_id = ?
          AND root_thread_id = ?
      `).get(admissionReceiptId, task.id, expectedResumeToken, safeActionId, rootThreadId);
      if (!row || row.admission_attempt_id !== admissionAttemptId) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Capacity deferral does not match the current admission attempt");
      }
      this.#assertTaskSafeActionCoordinatorEpoch(row, rootRun);
      if (row.status === "reserved" && row.admission_state === "deferred") {
        this.database.exec("COMMIT");
        return { applied: false, receipt: this.#taskSafeActionReceipt(row) };
      }
      if (row.status !== "delivering" || !["awaiting_admission", "prepared"].includes(row.admission_state)) {
        throw new ApiError(409, "ADMISSION_NOT_AWAITING", "Only the current awaiting admission attempt can be deferred");
      }
      if (this.getOpenTaskAgentRun(task.id) || this.getAgentTaskClaim(task.id)?.status === "active") {
        throw new ApiError(409, "ADMISSION_ALREADY_CLAIMED", "An admitted or open Agent run cannot be deferred");
      }
      const retryCount = Math.max(0, Number(row.admission_retry_count) || 0) + 1;
      const retryAfter = new Date(Date.now() + modelCapacityRetryDelay(retryCount)).toISOString();
      const updated = this.#prepare(`
        UPDATE task_safe_action_receipts
        SET status = 'reserved', admission_state = 'deferred', reservation_lease_id = NULL,
          lease_expires_at = NULL, recovery_lease_id = NULL, recovery_lease_expires_at = NULL,
          admission_deferred_reason = 'model_capacity', admission_retry_count = ?,
          admission_retry_after = ?
        WHERE id = ? AND status = 'delivering' AND admission_state IN ('awaiting_admission', 'prepared')
          AND admission_attempt_id = ?
      `).run(retryCount, retryAfter, row.id, admissionAttemptId);
      if (updated.changes !== 1) {
        throw new ApiError(409, "ADMISSION_ATTEMPT_MISMATCH", "Admission attempt changed before capacity deferral");
      }
      const deferred = this.#prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?").get(row.id);
      this.database.exec("COMMIT");
      return { applied: true, receipt: this.#taskSafeActionReceipt(deferred) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #taskSafeActionReceipt(row) {
    return {
      id: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      resumeToken: row.resume_token,
      safeActionId: row.safe_action_id,
      rootThreadId: row.root_thread_id,
      globalCoordinatorLeaseId: row.global_coordinator_lease_id,
      globalCoordinatorTaskId: row.global_coordinator_task_id,
      globalCoordinatorThreadId: row.global_coordinator_thread_id,
      coordinationDomainId: row.coordination_domain_id,
      domainCoordinatorLeaseId: row.domain_coordinator_lease_id,
      domainCoordinatorTaskId: row.domain_coordinator_task_id,
      domainCoordinatorThreadId: row.domain_coordinator_thread_id,
      rootHostId: row.root_host_id,
      rootWorkspacePath: row.root_workspace_path,
      worktreePath: row.worktree_path,
      worktreeBranch: row.worktree_branch,
      claimedAt: row.claimed_at,
      status: row.status,
      reservationLeaseId: row.reservation_lease_id,
      leaseExpiresAt: row.lease_expires_at,
      deliveredAt: row.delivered_at,
      deliveryTurnId: row.delivery_turn_id,
      admissionAttemptId: row.admission_attempt_id,
      admissionState: row.admission_state,
      admissionAgentName: row.admission_agent_name,
      admissionAgentPath: row.admission_agent_path,
      admissionWriteScope: row.admission_write_scope_json ? JSON.parse(row.admission_write_scope_json) : null,
      admissionPreparedAt: row.admission_prepared_at,
      admissionDeadlineAt: row.admission_deadline_at,
      admissionUncertainAt: row.admission_uncertain_at,
      admissionRegistryObservedAt: row.admission_registry_observed_at,
      admissionRecoveredAgentThreadId: row.admission_recovered_agent_thread_id,
      admissionProbeId: row.admission_probe_id,
      admissionProbeRequestedAt: row.admission_probe_requested_at,
      admissionDeferredReason: row.admission_deferred_reason,
      admissionRetryCount: Number(row.admission_retry_count) || 0,
      admissionRetryAfter: row.admission_retry_after,
      admittedRunId: row.admitted_run_id,
      admittedAgentThreadId: row.admitted_agent_thread_id,
      admittedAt: row.admitted_at,
    };
  }

  #taskSafeActionCoordinatorEpochMatches(row, rootRun) {
    const exactRootBinding = row.root_thread_id === rootRun.rootThreadId
      && row.root_host_id === rootRun.rootHostId
      && typeof row.root_workspace_path === "string"
      && path.isAbsolute(row.root_workspace_path)
      && path.resolve(row.root_workspace_path) === path.resolve(rootRun.rootWorkspacePath);
    if (!exactRootBinding) return false;
    if (row.domain_coordinator_lease_id !== null) {
      return (
        row.coordination_domain_id === rootRun.domainId
        && row.domain_coordinator_lease_id === rootRun.domainCoordinatorLeaseId
        && row.domain_coordinator_task_id === rootRun.domainCoordinatorTaskId
        && row.domain_coordinator_thread_id === rootRun.rootThreadId
      );
    }
    if (row.global_coordinator_lease_id === null) {
      return rootRun.globalCoordinatorLeaseId === undefined
        && rootRun.domainCoordinatorLeaseId === undefined;
    }
    return (
      row.global_coordinator_lease_id === rootRun.globalCoordinatorLeaseId
      && row.global_coordinator_task_id === rootRun.globalCoordinatorTaskId
      && row.global_coordinator_thread_id === rootRun.rootThreadId
    );
  }

  #assertTaskSafeActionCoordinatorEpoch(row, rootRun) {
    if (!this.#taskSafeActionCoordinatorEpochMatches(row, rootRun)) {
      throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_MISMATCH", "Admission attempt belongs to another Global Coordinator lease epoch");
    }
  }

  #assertCurrentGlobalCoordinatorReceiptEpoch(row, projectId) {
    if (row.global_coordinator_lease_id === null) return;
    const project = this.getAgentLaneProject(projectId);
    const lease = project?.coordinatorLease ?? null;
    const activeCoordinator = this.#exactActiveCoordinatorLease(projectId, project, lease);
    const matches = activeCoordinator
      && row.global_coordinator_lease_id === lease.id
      && row.global_coordinator_task_id === lease.holderTaskId
      && row.global_coordinator_thread_id === activeCoordinator.holder.threadId
      && row.root_host_id === activeCoordinator.holder.codexHostId
      && typeof row.root_workspace_path === "string"
      && path.isAbsolute(row.root_workspace_path)
      && path.resolve(row.root_workspace_path) === path.resolve(activeCoordinator.holder.workspacePath);
    if (!matches) {
      throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_MISMATCH", "Admission attempt belongs to another Global Coordinator lease epoch");
    }
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.#prepare(`
        SELECT
          projects.id,
          projects.name,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = projectPrefix(project);
      const maximum = this.#prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      const workingLog = normalizeWorkingLog(input.workingLog, input.developmentContext);
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.#prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.#prepare(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `).run(
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      this.#prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels, workflow_profile,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch, worktree_repository, worktree_repository_verified_at,
          working_log_path, working_log_status, working_log_updated_at,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        input.workflowProfile ?? "formal",
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.repository ?? null : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.repositoryVerifiedAt ?? null : null,
        workingLog?.path ?? null,
        workingLog?.status ?? null,
        workingLog ? timestamp : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const effectiveDevelopmentContext = Object.hasOwn(changes, "developmentContext")
      ? changes.developmentContext
      : current.developmentContext;
    const effectiveWorkingLog = Object.hasOwn(changes, "workingLog")
      ? changes.workingLog
      : current.workingLog;
    if (effectiveWorkingLog) {
      const normalizedWorkingLog = normalizeWorkingLog(effectiveWorkingLog, effectiveDevelopmentContext);
      if (Object.hasOwn(changes, "workingLog")) changes.workingLog = normalizedWorkingLog;
    }
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.#prepare("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      const relation = this.#prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowProfile: "workflow_profile",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    const timestamp = now();
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push(
          "git_branch = ?",
          "worktree_path = ?",
          "worktree_branch = ?",
          "worktree_repository = ?",
          "worktree_repository_verified_at = ?",
        );
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
          value?.type === "worktree" ? value.repository ?? null : null,
          value?.type === "worktree" ? value.repositoryVerifiedAt ?? null : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "workingLog") {
        assignments.push(
          "working_log_path = ?",
          "working_log_status = ?",
          "working_log_updated_at = ?",
        );
        values.push(value?.path ?? null, value?.status ?? null, value ? timestamp : null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.#prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    const storedBinding = threadBinding === undefined
      ? undefined
      : storedThreadBinding(threadBinding, threadId);
    if (storedBinding && !Object.hasOwn(changes, "projectId")) {
      assignments.push(
        "thread_id = ?",
        "thread_codex_project_id = ?",
        "thread_codex_project_kind = ?",
        "thread_codex_host_id = ?",
        "thread_workspace_path = ?",
      );
      values.push(...storedBinding);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNoOpenTaskAgentRunRebinding(current, changes, threadBinding);
      if (projectChanged && this.getAgentTaskDomainProvenance(current.id)) {
        throw new ApiError(
          409,
          "DOMAIN_TODO_PROJECT_MOVE_CONFLICT",
          "Domain-assigned work and its durable provenance cannot move across projects",
        );
      }
      if (projectChanged && this.#prepare(`
        SELECT 1 FROM owner_intent_plan_items WHERE task_id = ? LIMIT 1
      `).get(current.id)) {
        throw new ApiError(
          409,
          "OWNER_INTENT_PLAN_PROJECT_MOVE_CONFLICT",
          "Owner-Intent-planned work and its durable provenance cannot move across projects",
        );
      }
      const result = this.#prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.#prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = this.#prepare(`
        SELECT labels FROM projects WHERE id = ?
      `).get(destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        this.#prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      if (current.status === "in_progress" && changes.status && changes.status !== "in_progress") {
        this.#interruptTaskAgentExecution(current.id, timestamp);
      }
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.#prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.#prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    const storedBinding = threadBinding === undefined
      ? undefined
      : storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNoOpenTaskAgentRunRebinding(current, {}, threadBinding);
      const result = this.#prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (current.status === "in_progress" && status !== "in_progress") {
        this.#interruptTaskAgentExecution(current.id, timestamp);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    const storedBinding = threadBinding === undefined
      ? undefined
      : storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNoOpenTaskAgentRunRebinding(current, {}, threadBinding);
      const result = this.#prepare(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#interruptTaskAgentExecution(current.id, timestamp);
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const storedBinding = threadBinding === undefined
      ? undefined
      : storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertNoOpenTaskAgentRunRebinding(current, {}, threadBinding);
      const result = this.#prepare(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const attachmentIds = this.#prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const result = this.#prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin = "manual") {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.#prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.#prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        if (relationType === "blocks") {
          this.#assertNoDependencyCycle(sourceTaskId, targetTaskId);
        }
        const existing = this.#prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.#prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, origin, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, origin, timestamp);
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const relation = this.#prepare(`
        SELECT origin
        FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).get(relationType, sourceTaskId, targetTaskId);
      if (!relation) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      if (origin && relation.origin !== origin) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      let deleted;
      if (origin === "mention" && relationType === "related") {
        const taskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: relatedTask.identifier,
        })})`;
        const relatedTaskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: task.identifier,
        })})`;
        deleted = this.#prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
            AND origin = 'mention'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks
              WHERE (id = ? AND instr(description, ?) > 0)
                OR (id = ? AND instr(description, ?) > 0)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM comments
              WHERE (task_id = ? AND instr(body, ?) > 0)
                OR (task_id = ? AND instr(body, ?) > 0)
            )
        `).run(
          relationType,
          sourceTaskId,
          targetTaskId,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
        );
      } else {
        deleted = this.#prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).run(relationType, sourceTaskId, targetTaskId);
      }
      if (origin === "mention" && relationType === "related" && deleted.changes === 0) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      if (relationType === "blocks" && deleted.changes > 0) {
        this.#prepare(`
          DELETE FROM owner_intent_plan_dependencies
          WHERE project_id = ? AND source_task_id = ? AND target_task_id = ?
        `).run(task.projectId, sourceTaskId, targetTaskId);
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  listCommentsAfter(taskId, after) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).all(task.id, after.revision)
      .map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const id = randomUUID();
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deliverTaskInboxMessage(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const existing = this.#prepare(`
        SELECT * FROM task_inbox_delivery_receipts
        WHERE task_id = ? AND delivery_id = ?
      `).get(task.id, input.deliveryId);
      if (existing) {
        const receipt = taskInboxDeliveryReceiptFromRow(existing);
        const comment = this.getComment(receipt.commentId);
        const incomingBinding = storedThreadBinding(input.threadBinding, input.threadId);
        const existingBinding = [
          comment.threadBinding?.threadId ?? comment.threadId ?? comment.legacyLocalThreadId ?? null,
          comment.threadBinding?.codexProjectId ?? null,
          comment.threadBinding?.codexProjectKind ?? null,
          comment.threadBinding?.codexHostId ?? null,
          comment.threadBinding?.workspacePath ?? null,
        ];
        const actorMatches = (
          comment.authorType === input.actor.type
          && comment.authorId === input.actor.id
          && comment.authorName === input.actor.name
          && comment.authorAvatarUrl === input.actor.avatarUrl
        );
        if (
          comment.body !== input.body
          || receipt.sourceThreadId !== input.threadId
          || JSON.stringify(existingBinding) !== JSON.stringify(incomingBinding)
          || !actorMatches
        ) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Inbox delivery id is already bound to a different message",
          );
        }
        this.database.exec("COMMIT");
        return { applied: false, receipt, comment };
      }

      const timestamp = now();
      const commentId = randomUUID();
      const receiptId = randomUUID();
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        commentId,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.#prepare(`
        INSERT INTO task_inbox_delivery_receipts (
          id, delivery_id, task_id, project_id, comment_id, source_thread_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        input.deliveryId,
        task.id,
        task.projectId,
        commentId,
        input.threadId,
        timestamp,
      );
      this.database.exec("COMMIT");
      return {
        applied: true,
        receipt: this.getTaskInboxDeliveryReceipt(receiptId),
        comment: this.getComment(commentId),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskInboxDeliveryReceipt(id) {
    const row = this.#prepare(
      "SELECT * FROM task_inbox_delivery_receipts WHERE id = ?",
    ).get(id);
    return row ? taskInboxDeliveryReceiptFromRow(row) : null;
  }

  listTaskInboxDeliveryReceipts(taskId) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM task_inbox_delivery_receipts
      WHERE task_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(task.id).map(taskInboxDeliveryReceiptFromRow);
  }

  recordProjectOwnerIntent(projectId, input, sourceThreadBinding, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getProject(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const config = this.getAgentLaneProject(projectId);
      const ownerRoot = Array.isArray(config?.tasks)
        ? config.tasks.find((task) => task?.id === config.ownerRootTaskId)
        : null;
      if (
        !ownerRoot
        || input.ownerRootTaskId !== config.ownerRootTaskId
        || input.ownerRootThreadId !== ownerRoot.threadId
        || sourceThreadBinding.threadId !== ownerRoot.threadId
        || sourceThreadBinding.codexHostId !== ownerRoot.codexHostId
        || typeof sourceThreadBinding.workspacePath !== "string"
        || typeof ownerRoot.workspacePath !== "string"
        || path.resolve(sourceThreadBinding.workspacePath) !== path.resolve(ownerRoot.workspacePath)
      ) {
        throw new ApiError(
          409,
          "OWNER_ROOT_ROUTE_STALE",
          "Owner Intent must match the exact configured Owner-facing Root",
        );
      }

      const existing = this.#prepare(
        "SELECT * FROM project_owner_intents WHERE delivery_id = ? OR id = ?",
      ).get(input.deliveryId, input.intentId);
      if (existing) {
        const intent = projectOwnerIntentFromRow(existing);
        const exact = intent.projectId === projectId
          && intent.intentId === input.intentId
          && intent.deliveryId === input.deliveryId
          && intent.kind === input.kind
          && intent.goal === input.goal
          && JSON.stringify(intent.constraints) === JSON.stringify(input.constraints)
          && intent.targetIntentId === input.targetIntentId
          && intent.ownerRootTaskId === input.ownerRootTaskId
          && intent.ownerRootThreadId === input.ownerRootThreadId
          && sameThreadBinding(intent.sourceThreadBinding, sourceThreadBinding)
          && intent.ownerTurnId === input.ownerTurnId
          && intent.rootCaptureTurnId === input.rootCaptureTurnId
          && intent.evidence === input.evidence
          && intent.recordedBy.type === actor.type
          && intent.recordedBy.id === actor.id
          && intent.recordedBy.name === actor.name;
        if (!exact) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Owner Intent id or delivery id is already bound to a different payload",
          );
        }
        this.database.exec("COMMIT");
        return { applied: false, intent };
      }

      const existingTurn = this.#prepare(`
        SELECT id FROM project_owner_intents
        WHERE project_id = ? AND (
          (owner_root_thread_id = ? AND owner_turn_id = ?)
          OR root_capture_turn_id = ?
        )
      `).get(projectId, input.ownerRootThreadId, input.ownerTurnId, input.rootCaptureTurnId);
      if (existingTurn) {
        throw new ApiError(
          409,
          "OWNER_TURN_ALREADY_CAPTURED",
          "The Owner or Root capture turn is already bound to another intent",
        );
      }

      if (input.kind === "append" && input.targetIntentId !== null) {
        throw new ApiError(400, "INVALID_OWNER_INTENT", "append intent cannot target another intent");
      }
      if (input.kind !== "append") {
        const target = input.targetIntentId
          ? this.#prepare(
            "SELECT project_id FROM project_owner_intents WHERE id = ?",
          ).get(input.targetIntentId)
          : null;
        if (!target || target.project_id !== projectId) {
          throw new ApiError(
            409,
            "OWNER_INTENT_TARGET_NOT_FOUND",
            "Non-append intent must target an existing intent in the same project",
          );
        }
      }

      const timestamp = now();
      this.#prepare(`
        INSERT INTO project_owner_intents (
          id, delivery_id, project_id, kind, goal, constraints_json, target_intent_id,
          owner_root_task_id, owner_root_thread_id,
          source_codex_project_id, source_codex_project_kind, source_codex_host_id,
          source_workspace_path, owner_turn_id, root_capture_turn_id, evidence,
          status, recorded_by_type, recorded_by_id, recorded_by_name,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 1, ?, ?)
      `).run(
        input.intentId,
        input.deliveryId,
        projectId,
        input.kind,
        input.goal,
        JSON.stringify(input.constraints),
        input.targetIntentId,
        input.ownerRootTaskId,
        input.ownerRootThreadId,
        sourceThreadBinding.codexProjectId,
        sourceThreadBinding.codexProjectKind,
        sourceThreadBinding.codexHostId,
        sourceThreadBinding.workspacePath,
        input.ownerTurnId,
        input.rootCaptureTurnId,
        input.evidence,
        actor.type,
        actor.id,
        actor.name,
        timestamp,
        timestamp,
      );
      const intent = projectOwnerIntentFromRow(this.#prepare(
        "SELECT * FROM project_owner_intents WHERE id = ?",
      ).get(input.intentId));
      this.database.exec("COMMIT");
      return { applied: true, intent };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listProjectOwnerIntents(projectId) {
    if (!this.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.#prepare(`
      SELECT * FROM project_owner_intents
      WHERE project_id = ?
      ORDER BY created_at, id
    `).all(projectId).map(projectOwnerIntentFromRow);
  }

  getPendingProjectOwnerIntent(projectId) {
    const row = this.#prepare(`
      SELECT intent.*, adoption.coordinator_epoch AS adoption_epoch
      FROM project_owner_intents AS intent
      LEFT JOIN owner_intent_adoptions AS adoption ON adoption.intent_id = intent.id
      LEFT JOIN owner_intent_plan_revisions AS revision ON revision.intent_id = intent.id
      WHERE intent.project_id = ? AND (
        (intent.status = 'queued' AND (
          intent.plan_retry_after IS NULL OR intent.plan_retry_after <= ?
        ))
        OR (intent.status = 'adopted' AND revision.id IS NULL AND adoption.state = 'adopted')
      )
      ORDER BY intent.created_at, intent.id
      LIMIT 1
    `).get(projectId, now());
    if (!row) return null;
    if (row.status === "adopted") {
      try {
        const coordinator = this.#currentCoordinatorIdentity(projectId);
        if (row.adoption_epoch === coordinator.epoch) return null;
      } catch (error) {
        if (error?.code !== "COORDINATOR_ROUTE_STALE") throw error;
      }
    }
    return projectOwnerIntentFromRow(row);
  }

  getPendingProjectOwnerIntentPlan(projectId) {
    const row = this.#prepare(`
      SELECT intent.*, adoption.id AS adoption_id, adoption.coordinator_task_id,
        adoption.coordinator_thread_id, adoption.coordinator_epoch,
        adoption.delivery_turn_id, adoption.adopted_at
      FROM project_owner_intents AS intent
      JOIN owner_intent_adoptions AS adoption
        ON adoption.intent_id = intent.id AND adoption.state = 'adopted'
      LEFT JOIN owner_intent_plan_revisions AS revision ON revision.intent_id = intent.id
      WHERE intent.project_id = ? AND intent.status = 'adopted' AND revision.id IS NULL
      ORDER BY adoption.adopted_at, intent.id
      LIMIT 1
    `).get(projectId);
    if (!row) return null;
    return {
      ...projectOwnerIntentFromRow(row),
      adoptionReceipt: {
        id: row.adoption_id,
        coordinatorTaskId: row.coordinator_task_id,
        coordinatorThreadId: row.coordinator_thread_id,
        coordinatorEpoch: row.coordinator_epoch,
        deliveryTurnId: row.delivery_turn_id,
        adoptedAt: row.adopted_at,
      },
    };
  }

  #currentCoordinatorIdentity(projectId) {
    const config = this.getAgentLaneProject(projectId);
    if (!config) {
      throw new ApiError(404, "AGENT_LANES_NOT_CONFIGURED", `Project '${projectId}' has no Agent Lane mapping`);
    }
    const timestamp = Date.now();
    const lease = config.coordinatorLease;
    const activeLease = this.#exactActiveCoordinatorLease(projectId, config, lease, timestamp);
    const coordinatorTaskId = activeLease ? lease.holderTaskId : lease ? null : config.rootTaskId;
    const coordinator = Array.isArray(config.tasks)
      ? config.tasks.find((task) => task?.id === coordinatorTaskId)
      : null;
    if (!coordinator?.threadId
      || !coordinator.codexHostId
      || typeof coordinator.workspacePath !== "string"
      || !path.isAbsolute(coordinator.workspacePath)
      || !coordinatorTaskId) {
      throw new ApiError(409, "COORDINATOR_ROUTE_STALE", "Execution Coordinator is not currently available");
    }
    return {
      taskId: coordinatorTaskId,
      threadId: coordinator.threadId,
      epoch: activeLease ? `lease:${lease.id}` : `configured:${coordinatorTaskId}`,
    };
  }

  claimProjectOwnerIntentAdoption(projectId, intentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const readExecutionIntent = () => ownerIntentExecutionFromRow(this.#prepare(
        "SELECT * FROM project_owner_intents WHERE id = ? AND project_id = ?",
      ).get(intentId, projectId));
      const intentRow = this.#prepare(
        "SELECT * FROM project_owner_intents WHERE id = ? AND project_id = ?",
      ).get(intentId, projectId);
      if (!intentRow) {
        throw new ApiError(404, "OWNER_INTENT_NOT_FOUND", `Owner Intent '${intentId}' does not exist`);
      }
      const coordinator = this.#currentCoordinatorIdentity(projectId);
      if (
        input.coordinatorTaskId !== coordinator.taskId
        || input.coordinatorThreadId !== coordinator.threadId
        || input.coordinatorEpoch !== coordinator.epoch
      ) {
        throw new ApiError(409, "COORDINATOR_ROUTE_STALE", "Coordinator identity or epoch changed before adoption");
      }
      const existing = this.#prepare(
        "SELECT * FROM owner_intent_adoptions WHERE intent_id = ?",
      ).get(intentId);
      if (existing) {
        const adoption = ownerIntentAdoptionFromRow(existing);
        const sameCoordinator = adoption.coordinatorTaskId === input.coordinatorTaskId
          && adoption.coordinatorThreadId === input.coordinatorThreadId
          && adoption.coordinatorEpoch === input.coordinatorEpoch;
        if (adoption.state === "adopted" && sameCoordinator) {
          this.database.exec("COMMIT");
          return {
            claimed: false,
            reason: "already-adopted",
            receipt: adoption,
            executionIntent: readExecutionIntent(),
          };
        }
        if (adoption.state === "reserved" && sameCoordinator
          && Date.parse(adoption.reservationExpiresAt) > Date.now()) {
          this.database.exec("COMMIT");
          return {
            claimed: false,
            reason: "reserved",
            receipt: adoption,
            executionIntent: readExecutionIntent(),
          };
        }
        if (adoption.state === "adopted" && !sameCoordinator) {
          const planned = this.#prepare(
            "SELECT 1 FROM owner_intent_plan_revisions WHERE intent_id = ?",
          ).get(intentId);
          if (planned) {
            throw new ApiError(409, "OWNER_INTENT_ADOPTION_CONFLICT", "A planned intent cannot move to another coordinator epoch");
          }
          this.#prepare(`
            UPDATE project_owner_intents
            SET status = 'queued', version = version + 1, updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'adopted'
          `).run(now(), intentId, projectId);
        }
        this.#prepare("DELETE FROM owner_intent_adoptions WHERE id = ?").run(adoption.id);
      }
      const currentIntent = this.#prepare(
        "SELECT status FROM project_owner_intents WHERE id = ? AND project_id = ?",
      ).get(intentId, projectId);
      if (currentIntent?.status !== "queued") {
        throw new ApiError(409, "OWNER_INTENT_NOT_QUEUED", "Only a queued Owner Intent can be adopted");
      }
      const claimedAt = now();
      const adoptionId = randomUUID();
      const reservationExpiresAt = new Date(Date.now() + OWNER_INTENT_ADOPTION_TTL_MS).toISOString();
      this.#prepare(`
        INSERT INTO owner_intent_adoptions (
          id, intent_id, project_id, coordinator_task_id, coordinator_thread_id,
          coordinator_epoch, state, reservation_expires_at, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `).run(
        adoptionId,
        intentId,
        projectId,
        input.coordinatorTaskId,
        input.coordinatorThreadId,
        input.coordinatorEpoch,
        reservationExpiresAt,
        claimedAt,
      );
      const receipt = ownerIntentAdoptionFromRow(this.#prepare(
        "SELECT * FROM owner_intent_adoptions WHERE id = ?",
      ).get(adoptionId));
      this.database.exec("COMMIT");
      return { claimed: true, receipt, executionIntent: readExecutionIntent() };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  confirmProjectOwnerIntentAdoption(projectId, intentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(`
        SELECT * FROM owner_intent_adoptions
        WHERE id = ? AND intent_id = ? AND project_id = ?
      `).get(input.adoptionId, intentId, projectId);
      if (!row) {
        throw new ApiError(409, "OWNER_INTENT_ADOPTION_STALE", "Intent adoption reservation is unavailable");
      }
      const adoption = ownerIntentAdoptionFromRow(row);
      const coordinator = this.#currentCoordinatorIdentity(projectId);
      if (
        adoption.coordinatorTaskId !== coordinator.taskId
        || adoption.coordinatorThreadId !== coordinator.threadId
        || adoption.coordinatorEpoch !== coordinator.epoch
      ) {
        throw new ApiError(409, "COORDINATOR_ROUTE_STALE", "Coordinator identity or epoch changed before confirmation");
      }
      if (adoption.state === "adopted") {
        if (adoption.deliveryTurnId !== input.deliveryTurnId) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Adoption is already bound to another delivery turn");
        }
        this.database.exec("COMMIT");
        return { confirmed: false, reason: "already-adopted", receipt: adoption };
      }
      if (Date.parse(adoption.reservationExpiresAt) <= Date.now()) {
        throw new ApiError(409, "OWNER_INTENT_ADOPTION_STALE", "Intent adoption reservation expired");
      }
      const adoptedAt = now();
      this.#prepare(`
        UPDATE owner_intent_adoptions
        SET state = 'adopted', delivery_turn_id = ?, adopted_at = ?
        WHERE id = ? AND state = 'reserved'
      `).run(input.deliveryTurnId, adoptedAt, adoption.id);
      const updatedIntent = this.#prepare(`
        UPDATE project_owner_intents
        SET status = 'adopted', version = version + 1, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'queued'
      `).run(adoptedAt, intentId, projectId);
      if (updatedIntent.changes !== 1) {
        throw new ApiError(409, "OWNER_INTENT_NOT_QUEUED", "Owner Intent changed before adoption confirmation");
      }
      const receipt = ownerIntentAdoptionFromRow(this.#prepare(
        "SELECT * FROM owner_intent_adoptions WHERE id = ?",
      ).get(adoption.id));
      this.database.exec("COMMIT");
      return { confirmed: true, receipt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  retryProjectOwnerIntentPlan(projectId, intentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const intentRow = this.#prepare(`
        SELECT * FROM project_owner_intents WHERE id = ? AND project_id = ?
      `).get(intentId, projectId);
      if (!intentRow) {
        throw new ApiError(404, "OWNER_INTENT_NOT_FOUND", `Owner Intent '${intentId}' does not exist`);
      }
      if (intentRow.plan_last_failure_key === input.failureKey) {
        this.database.exec("COMMIT");
        return {
          applied: false,
          exhausted: intentRow.status === "needs_decision",
          intent: projectOwnerIntentFromRow(intentRow),
        };
      }
      const adoption = this.#prepare(`
        SELECT * FROM owner_intent_adoptions
        WHERE id = ? AND intent_id = ? AND project_id = ? AND state = 'adopted'
      `).get(input.adoptionId, intentId, projectId);
      if (!adoption || intentRow.status !== "adopted") {
        throw new ApiError(409, "OWNER_INTENT_PLAN_RETRY_STALE", "Plan retry requires the current adopted intent receipt");
      }
      const coordinator = this.#currentCoordinatorIdentity(projectId);
      if (adoption.coordinator_epoch !== input.coordinatorEpoch
        || adoption.coordinator_task_id !== coordinator.taskId
        || adoption.coordinator_thread_id !== coordinator.threadId
        || adoption.coordinator_epoch !== coordinator.epoch) {
        throw new ApiError(409, "COORDINATOR_ROUTE_STALE", "Plan retry coordinator identity or epoch changed");
      }
      if (this.#prepare(
        "SELECT 1 FROM owner_intent_plan_revisions WHERE intent_id = ?",
      ).get(intentId)) {
        throw new ApiError(409, "OWNER_INTENT_PLAN_RETRY_STALE", "A recorded plan cannot be retried");
      }
      const timestamp = now();
      const retryCount = Number(intentRow.plan_retry_count ?? 0) + 1;
      const exhausted = retryCount >= OWNER_INTENT_PLAN_RETRY_LIMIT;
      this.#prepare("DELETE FROM owner_intent_adoptions WHERE id = ?").run(adoption.id);
      this.#prepare(`
        UPDATE project_owner_intents
        SET status = ?, version = version + 1,
          plan_retry_count = ?, plan_retry_after = ?, plan_last_failure_key = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'adopted'
      `).run(
        exhausted ? "needs_decision" : "queued",
        retryCount,
        exhausted ? null : timestamp,
        input.failureKey,
        timestamp,
        intentId,
        projectId,
      );
      const intent = projectOwnerIntentFromRow(this.#prepare(
        "SELECT * FROM project_owner_intents WHERE id = ?",
      ).get(intentId));
      this.database.exec("COMMIT");
      return { applied: true, exhausted, intent };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listProjectOwnerIntentPlan(projectId) {
    const rows = this.#prepare(`
      SELECT * FROM owner_intent_plan_revisions
      WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId);
    const itemStatement = this.#prepare(`
      SELECT plan_items.*, tasks.identifier, tasks.title, tasks.status, tasks.priority, tasks.version
      FROM owner_intent_plan_items AS plan_items
      JOIN tasks ON tasks.id = plan_items.task_id
      WHERE plan_items.revision_id = ?
      ORDER BY plan_items.created_at, plan_items.id
    `);
    return rows.map((row) => ownerIntentPlanRevisionFromRow(row, itemStatement.all(row.id).map((item) => ({
      id: item.id,
      outcomeKey: item.outcome_key,
      disposition: item.disposition,
      task: {
        id: item.task_id,
        identifier: item.identifier,
        title: item.title,
        status: item.status,
        priority: item.priority,
        version: item.version,
      },
    }))));
  }

  applyProjectOwnerIntentPlan(projectId, intentId, input) {
    const serializedRequest = JSON.stringify(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#prepare(
        "SELECT * FROM owner_intent_plan_revisions WHERE id = ? OR intent_id = ?",
      ).get(input.revisionId, intentId);
      if (existing) {
        if (existing.project_id !== projectId
          || existing.intent_id !== intentId
          || existing.id !== input.revisionId
          || existing.request_json !== serializedRequest) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Plan revision id or intent was reused with different content");
        }
        const result = this.listProjectOwnerIntentPlan(projectId)
          .find((revision) => revision.id === existing.id);
        this.database.exec("COMMIT");
        return { applied: false, revision: result };
      }
      const intent = this.#prepare(`
        SELECT * FROM project_owner_intents WHERE id = ? AND project_id = ?
      `).get(intentId, projectId);
      if (!intent) throw new ApiError(404, "OWNER_INTENT_NOT_FOUND", `Owner Intent '${intentId}' does not exist`);
      if (intent.status !== "adopted" || intent.version !== input.intentVersion) {
        throw new ApiError(409, "OWNER_INTENT_REVISION_STALE", "Plan must match the current adopted Owner Intent revision");
      }
      if (intent.kind === "cancel" && input.items.length > 0) {
        throw new ApiError(
          400,
          "CANCEL_PLAN_MUST_NOT_EXECUTE",
          "A cancel Owner Intent plan cannot create or update executable Todos",
        );
      }
      const adoption = this.#prepare(`
        SELECT * FROM owner_intent_adoptions
        WHERE id = ? AND intent_id = ? AND project_id = ? AND state = 'adopted'
      `).get(input.adoptionId, intentId, projectId);
      if (!adoption) throw new ApiError(409, "OWNER_INTENT_ADOPTION_STALE", "Plan requires the adopted intent receipt");
      const coordinator = this.#currentCoordinatorIdentity(projectId);
      if (input.coordinatorTaskId !== coordinator.taskId
        || input.coordinatorThreadId !== coordinator.threadId
        || input.coordinatorEpoch !== coordinator.epoch
        || adoption.coordinator_task_id !== coordinator.taskId
        || adoption.coordinator_thread_id !== coordinator.threadId
        || adoption.coordinator_epoch !== coordinator.epoch) {
        throw new ApiError(409, "COORDINATOR_ROUTE_STALE", "Plan coordinator identity or epoch changed");
      }
      const decisionSensitiveIntent = `${intent.goal}\n${intent.constraints_json}`;
      if (input.classification === "bounded_delivery" && (
        /\bcapital[- ]allocation\b|资本配置|\bfinancial decision\b|财务决策/i.test(decisionSensitiveIntent)
        || /\bQ4\b[^\n]{0,80}\b(?:metric|basis|methodology)\b|Q4[^\n]{0,80}(?:口径|指标策略)/i.test(decisionSensitiveIntent)
      )) {
        throw new ApiError(
          409,
          "OWNER_DECISION_CLASSIFICATION_REQUIRED",
          "Financial allocation and unresolved metric policy cannot be classified as bounded delivery",
        );
      }
      const timestamp = now();
      const needsDecision = input.classification !== "bounded_delivery";
      const revisionStatus = needsDecision ? "needs_decision" : "applied";
      this.#prepare(`
        INSERT INTO owner_intent_plan_revisions (
          id, project_id, intent_id, intent_version, adoption_id,
          coordinator_task_id, coordinator_thread_id, coordinator_epoch,
          classification, status, summary, request_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.revisionId, projectId, intentId, input.intentVersion, input.adoptionId,
        input.coordinatorTaskId, input.coordinatorThreadId, input.coordinatorEpoch,
        input.classification, revisionStatus, input.summary, serializedRequest, timestamp, timestamp,
      );
      if (needsDecision) {
        this.#prepare(`
          UPDATE project_owner_intents SET status = 'needs_decision', version = version + 1, updated_at = ?
          WHERE id = ? AND project_id = ? AND status = 'adopted'
        `).run(timestamp, intentId, projectId);
        const revision = this.listProjectOwnerIntentPlan(projectId)
          .find((candidate) => candidate.id === input.revisionId);
        this.database.exec("COMMIT");
        return { applied: true, revision };
      }

      const targetIntentId = intent.target_intent_id;
      const reconciledTaskIds = new Set();
      if (["supersede", "cancel"].includes(intent.kind) && targetIntentId) {
        const priorItems = this.#prepare(`
          SELECT plan_items.*, tasks.project_id AS task_project_id, tasks.status,
            EXISTS(SELECT 1 FROM agent_task_claims WHERE task_id = tasks.id AND status = 'active') AS active_claim,
            EXISTS(SELECT 1 FROM task_agent_runs WHERE task_id = tasks.id AND status IN ('active','blocked')) AS open_run
          FROM owner_intent_plan_items AS plan_items
          JOIN tasks ON tasks.id = plan_items.task_id
          WHERE plan_items.intent_id = ?
        `).all(targetIntentId);
        for (const prior of priorItems) {
          if (prior.task_project_id !== projectId || prior.project_id !== projectId) {
            throw new ApiError(
              409,
              "OWNER_INTENT_PLAN_PROJECT_MISMATCH",
              "Owner Intent reconciliation cannot mutate a task in another project",
            );
          }
          reconciledTaskIds.add(prior.task_id);
          if (["backlog", "todo"].includes(prior.status) && !prior.active_claim && !prior.open_run) {
            this.#prepare(`
              UPDATE tasks SET status = 'canceled', version = version + 1, updated_at = ? WHERE id = ?
            `).run(timestamp, prior.task_id);
          }
        }
        this.#prepare(`
          UPDATE project_owner_intents SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND project_id = ? AND status IN ('adopted','needs_decision')
        `).run(intent.kind === "cancel" ? "canceled" : "superseded", timestamp, targetIntentId, projectId);
      }

      const plannedTaskIds = new Map();
      for (const item of input.items) {
        const prior = this.#prepare(`
          SELECT plan_items.task_id, tasks.*
          FROM owner_intent_plan_items AS plan_items
          JOIN tasks ON tasks.id = plan_items.task_id
          JOIN owner_intent_plan_revisions AS revisions ON revisions.id = plan_items.revision_id
          WHERE plan_items.project_id = ? AND plan_items.outcome_key = ?
          ORDER BY revisions.created_at DESC, plan_items.rowid DESC
        `).get(projectId, item.outcomeKey);
        if (prior && prior.project_id !== projectId) {
          throw new ApiError(
            409,
            "OWNER_INTENT_PLAN_PROJECT_MISMATCH",
            "Owner Intent plan provenance cannot mutate a task in another project",
          );
        }
        let taskId;
        let disposition;
        if (prior) {
          taskId = prior.task_id;
          const active = ["in_progress", "in_review", "done"].includes(prior.status)
            || this.#prepare(`
              SELECT 1 FROM agent_task_claims WHERE task_id = ? AND status = 'active'
              UNION ALL SELECT 1 FROM task_agent_runs WHERE task_id = ? AND status IN ('active','blocked')
              LIMIT 1
            `).get(taskId, taskId);
          if (active) {
            disposition = "preserved_active";
          } else {
            this.#prepare(`
              UPDATE tasks SET title = ?, description = ?, priority = ?, status = 'todo',
                version = version + 1, updated_at = ?
              WHERE id = ?
            `).run(item.title, item.description, item.priority, timestamp, taskId);
            disposition = prior.status === "todo"
              && prior.title === item.title
              && prior.description === item.description
              && prior.priority === item.priority ? "reused" : "updated";
          }
        } else {
          const project = this.#prepare(`
            SELECT projects.*, (
              SELECT tasks.identifier FROM tasks WHERE tasks.project_id = projects.id
              ORDER BY tasks.created_at, tasks.id LIMIT 1
            ) AS first_identifier
            FROM projects WHERE id = ?
          `).get(projectId);
          const prefix = projectPrefix(project);
          const maximum = this.#prepare(`
            SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
            FROM tasks WHERE identifier GLOB ?
          `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
          const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
          taskId = randomUUID();
          const sort = this.#prepare(`
            SELECT MIN(sort_order) AS minimum FROM tasks
            WHERE project_id = ? AND status = 'todo' AND archived_at IS NULL
          `).get(projectId).minimum;
          this.#prepare("UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?")
            .run(number + 1, timestamp, projectId);
          this.#prepare(`
            INSERT INTO tasks (
              id, identifier, project_id, title, description, status, priority, labels,
              workflow_profile, sort_order, thread_id,
              creator_type, creator_id, creator_name,
              assignee_type, assignee_id, assignee_name,
              external_source, external_origin, external_id, external_key,
              version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, 'vibe', ?, ?,
              'agent', 'codex-agent', 'Codex Agent', 'agent', 'codex-agent', 'Codex Agent',
              'local', 'owner_intent_plan', ?, ?, 1, ?, ?)
          `).run(
            taskId, `${prefix}-${number}`, projectId, item.title, item.description,
            item.priority, JSON.stringify(["agent-todo", "owner-intent-plan", "no-working-log"]),
            sort === null ? 1000 : sort - 1000, coordinator.threadId,
            item.outcomeKey, item.outcomeKey, timestamp, timestamp,
          );
          disposition = "created";
        }
        plannedTaskIds.set(item.outcomeKey, taskId);
        reconciledTaskIds.add(taskId);
        this.#prepare(`
          INSERT INTO owner_intent_plan_items (
            id, revision_id, project_id, intent_id, outcome_key, task_id, disposition, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), input.revisionId, projectId, intentId, item.outcomeKey, taskId, disposition, timestamp);
        if (input.parentTaskId) {
          const parent = this.#prepare("SELECT project_id FROM tasks WHERE id = ?").get(input.parentTaskId);
          if (!parent || parent.project_id !== projectId) {
            throw new ApiError(400, "CROSS_PROJECT_RELATION", "Plan parent must be in the same project");
          }
          this.#prepare(`
            INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
            VALUES ('parent', ?, ?, 'manual', ?)
            ON CONFLICT DO NOTHING
          `).run(input.parentTaskId, taskId, timestamp);
        }
      }

      const desiredDependencies = new Map();
      for (const item of input.items) {
        const targetTaskId = plannedTaskIds.get(item.outcomeKey);
        for (const dependencyKey of item.blockedByOutcomeKeys) {
          const sourceTaskId = plannedTaskIds.get(dependencyKey);
          if (!sourceTaskId) throw new ApiError(400, "PLAN_DEPENDENCY_MISSING", `Unknown dependency '${dependencyKey}'`);
          desiredDependencies.set(`${sourceTaskId}\0${targetTaskId}`, { sourceTaskId, targetTaskId });
        }
      }
      if (reconciledTaskIds.size > 0) {
        const taskIds = [...reconciledTaskIds];
        const priorDependencies = this.#prepare(`
          SELECT * FROM owner_intent_plan_dependencies
          WHERE project_id = ? AND target_task_id IN (${taskIds.map(() => "?").join(", ")})
        `).all(projectId, ...taskIds);
        for (const dependency of priorDependencies) {
          const key = `${dependency.source_task_id}\0${dependency.target_task_id}`;
          if (desiredDependencies.has(key)) continue;
          this.#prepare(`
            DELETE FROM owner_intent_plan_dependencies
            WHERE project_id = ? AND source_task_id = ? AND target_task_id = ?
          `).run(projectId, dependency.source_task_id, dependency.target_task_id);
          if (dependency.owns_relation === 1) {
            this.#prepare(`
              DELETE FROM task_relations
              WHERE relation_type = 'blocks' AND source_task_id = ? AND target_task_id = ?
            `).run(dependency.source_task_id, dependency.target_task_id);
          }
        }
      }
      for (const { sourceTaskId, targetTaskId } of desiredDependencies.values()) {
        const relation = this.#prepare(`
          SELECT 1 FROM task_relations
          WHERE relation_type = 'blocks' AND source_task_id = ? AND target_task_id = ?
        `).get(sourceTaskId, targetTaskId);
        const ownership = this.#prepare(`
          SELECT owns_relation FROM owner_intent_plan_dependencies
          WHERE project_id = ? AND source_task_id = ? AND target_task_id = ?
        `).get(projectId, sourceTaskId, targetTaskId);
        const ownsRelation = relation ? ownership?.owns_relation ?? 0 : 1;
        if (!relation) {
          this.#prepare(`
            INSERT INTO task_relations (relation_type, source_task_id, target_task_id, origin, created_at)
            VALUES ('blocks', ?, ?, 'manual', ?) ON CONFLICT DO NOTHING
          `).run(sourceTaskId, targetTaskId, timestamp);
        }
        this.#prepare(`
          INSERT INTO owner_intent_plan_dependencies (
            project_id, source_task_id, target_task_id, revision_id, intent_id,
            owns_relation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, source_task_id, target_task_id) DO UPDATE SET
            revision_id = excluded.revision_id,
            intent_id = excluded.intent_id,
            owns_relation = excluded.owns_relation,
            updated_at = excluded.updated_at
        `).run(
          projectId, sourceTaskId, targetTaskId, input.revisionId, intentId,
          ownsRelation, timestamp, timestamp,
        );
      }
      const dependencyCycle = this.#prepare(`
        WITH RECURSIVE dependency_paths(start_task_id, current_task_id) AS (
          SELECT relations.source_task_id, relations.target_task_id
          FROM task_relations AS relations
          JOIN tasks AS sources ON sources.id = relations.source_task_id
          WHERE relations.relation_type = 'blocks' AND sources.project_id = ?
          UNION
          SELECT paths.start_task_id, relations.target_task_id
          FROM dependency_paths AS paths
          JOIN task_relations AS relations
            ON relations.relation_type = 'blocks'
            AND relations.source_task_id = paths.current_task_id
        )
        SELECT 1 FROM dependency_paths
        WHERE start_task_id = current_task_id LIMIT 1
      `).get(projectId);
      if (dependencyCycle) {
        throw new ApiError(400, "PLAN_DEPENDENCY_CYCLE", "Plan dependencies would create a cycle in the complete project graph");
      }
      const revision = this.listProjectOwnerIntentPlan(projectId)
        .find((candidate) => candidate.id === input.revisionId);
      this.database.exec("COMMIT");
      return { applied: true, revision };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendTaskCoordinationEvent(taskId, envelope, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const serializedEnvelope = JSON.stringify(envelope);
      const existing = this.#prepare(`
        SELECT * FROM agent_event_receipts
        WHERE event_id = ? OR (task_id = ? AND idempotency_key = ?)
        LIMIT 1
      `).get(envelope.eventId, task.id, envelope.idempotencyKey);
      if (existing) {
        if (existing.task_id !== task.id || existing.envelope_json !== serializedEnvelope) {
          throw new ApiError(
            409,
            "COORDINATION_EVENT_CONFLICT",
            "The event or idempotency key is already bound to different handoff content",
          );
        }
        const event = this.getTaskCoordinationEvent(existing.event_id);
        this.database.exec("COMMIT");
        return { applied: false, event, comment: this.getComment(existing.comment_id) };
      }

      const parentTaskId = task.relations.parent?.id ?? null;
      if (envelope.parentTaskId !== parentTaskId) {
        throw new ApiError(
          409,
          "COORDINATION_PARENT_MISMATCH",
          "The envelope parent must match the task's durable parent relation",
          { actualParentTaskId: parentTaskId },
        );
      }
      const claim = this.getAgentTaskClaim(task.id);
      if (
        task.status !== "in_progress"
        || claim?.status !== "active"
        || !claim.leaseExpiresAt
        || Date.parse(claim.leaseExpiresAt) <= Date.now()
      ) {
        throw new ApiError(409, "COORDINATION_CLAIM_NOT_ACTIVE", "A handoff requires an active execution claim");
      }
      if (
        claim.agentThreadId !== envelope.senderThreadId
        || claim.agentPath !== envelope.senderAgentPath
      ) {
        throw new ApiError(
          409,
          "COORDINATION_SENDER_MISMATCH",
          "The handoff sender must match the active execution claim",
        );
      }
      const previous = this.#prepare(`
        SELECT envelope_json FROM agent_event_receipts
        WHERE task_id = ? AND envelope_json IS NOT NULL
        ORDER BY created_at DESC, rowid DESC
      `).all(task.id)
        .map((row) => JSON.parse(row.envelope_json))
        .find((candidate) => candidate.senderAgentPath === envelope.senderAgentPath);
      if (previous && envelope.sequence <= previous.sequence) {
        throw new ApiError(
          409,
          "COORDINATION_SEQUENCE_CONFLICT",
          "The handoff sequence must advance for this sender",
          { previousSequence: previous.sequence },
        );
      }

      const timestamp = now();
      const commentId = randomUUID();
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, author_type, author_id, author_name,
          author_avatar_url, version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        commentId,
        task.id,
        coordinationCommentBody(envelope),
        envelope.senderThreadId,
        actor.type,
        actor.id,
        actor.name,
        actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.#prepare(`
        INSERT INTO agent_event_receipts (
          event_id, project_id, task_id, comment_id, idempotency_key, envelope_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.eventId,
        task.projectId,
        task.id,
        commentId,
        envelope.idempotencyKey,
        serializedEnvelope,
        timestamp,
      );
      this.database.exec("COMMIT");
      return {
        applied: true,
        event: this.getTaskCoordinationEvent(envelope.eventId),
        comment: this.getComment(commentId),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskCoordinationEvent(eventId) {
    const row = this.#prepare(`
      SELECT * FROM agent_event_receipts
      WHERE event_id = ? AND envelope_json IS NOT NULL
    `).get(eventId);
    if (!row) return null;
    const acknowledgements = this.#prepare(`
      SELECT * FROM agent_event_acknowledgements
      WHERE event_id = ?
      ORDER BY created_at, rowid
    `).all(eventId).map(coordinationAcknowledgementFromRow);
    return coordinationEventFromRow(row, acknowledgements);
  }

  listTaskCoordinationEvents(taskId) {
    const task = this.#requireTask(taskId);
    return this.#prepare(`
      SELECT * FROM agent_event_receipts
      WHERE task_id = ? AND envelope_json IS NOT NULL
      ORDER BY created_at, rowid
    `).all(task.id).map((row) => this.getTaskCoordinationEvent(row.event_id));
  }

  acknowledgeTaskCoordinationEvent(eventId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#prepare(`
        SELECT * FROM agent_event_receipts
        WHERE event_id = ? AND envelope_json IS NOT NULL
      `).get(eventId);
      if (!row) {
        throw new ApiError(404, "COORDINATION_EVENT_NOT_FOUND", `Coordination event '${eventId}' does not exist`);
      }
      const envelope = JSON.parse(row.envelope_json);
      if (!envelope.requiresAck) {
        throw new ApiError(409, "COORDINATION_ACK_NOT_REQUIRED", "This handoff does not require acknowledgement");
      }
      const task = this.#requireTask(row.task_id);
      if (
        input.senderAgentPath !== "/root"
        || !task.threadBinding
        || task.threadBinding.threadId !== input.senderThreadId
      ) {
        throw new ApiError(
          409,
          "COORDINATION_ACK_SENDER_MISMATCH",
          "Acknowledgement must come from the task's exactly bound Root",
        );
      }
      const existing = this.#prepare(`
        SELECT * FROM agent_event_acknowledgements WHERE event_id = ?
      `).get(eventId);
      if (existing) {
        if (
          existing.acknowledgement_id !== input.acknowledgementId
          || existing.sender_thread_id !== input.senderThreadId
          || existing.sender_agent_path !== input.senderAgentPath
        ) {
          throw new ApiError(
            409,
            "COORDINATION_ACK_CONFLICT",
            "This handoff already has a different acknowledgement",
          );
        }
        const acknowledgement = coordinationAcknowledgementFromRow(existing);
        this.database.exec("COMMIT");
        return { applied: false, acknowledgement };
      }
      const acknowledgement = {
        id: randomUUID(),
        acknowledgementId: input.acknowledgementId,
        eventId,
        senderThreadId: input.senderThreadId,
        senderAgentPath: input.senderAgentPath,
        createdAt: now(),
      };
      this.#prepare(`
        INSERT INTO agent_event_acknowledgements (
          id, acknowledgement_id, event_id, sender_thread_id, sender_agent_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        acknowledgement.id,
        acknowledgement.acknowledgementId,
        acknowledgement.eventId,
        acknowledgement.senderThreadId,
        acknowledgement.senderAgentPath,
        acknowledgement.createdAt,
      );
      this.database.exec("COMMIT");
      return { applied: true, acknowledgement };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getComment(id) {
    const row = this.#prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, threadBinding) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireComment(id);
      this.#requireCommentVersion(current, version);
      const changeRevision = this.#nextCommentAttachmentRevision();
      const result = this.#prepare(`
        UPDATE comments
        SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?,
          change_revision = ?
        WHERE id = ? AND version = ?
      `).run(body, ...(storedBinding ?? []), now(), changeRevision, id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.#prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId, after = null) {
    const task = this.#requireTask(taskId);
    if (after) {
      return this.#prepare(`
        SELECT * FROM attachments
        WHERE task_id = ? AND comment_id IS NULL
          AND change_revision > ?
        ORDER BY change_revision
      `).all(task.id, after.revision).map(attachmentFromRow);
    }
    return this.#prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        task.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId, after = null) {
    const comment = this.#prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId, after);
  }

  createCommentAttachment(commentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const comment = this.#requireComment(commentId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.#prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        comment.taskId,
        comment.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.#prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.#prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.#prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.#prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.#prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.#prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.#prepare(`
        SELECT attachments.*
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        WHERE attachments.task_id IN (${placeholders})
          AND attachments.comment_id IS NULL
          AND attachments.content_type LIKE 'image/%'
          AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
        ORDER BY attachments.task_id, attachments.created_at, attachments.id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId, after = null) {
    if (after) {
      return this.#prepare(`
        SELECT * FROM attachments
        WHERE comment_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `).all(commentId, after.revision).map(attachmentFromRow);
    }
    return this.#prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #nextCommentAttachmentRevision() {
    return this.#prepare(`
      UPDATE comment_attachment_revision
      SET value = value + 1
      WHERE id = 1
      RETURNING value
    `).get().value;
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.#prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.#prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.#prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.#prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.#prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.#prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #assertNoDependencyCycle(sourceTaskId, targetTaskId) {
    const cycle = this.#prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT target_task_id
        FROM task_relations
        WHERE relation_type = 'blocks' AND source_task_id = ?
        UNION
        SELECT task_relations.target_task_id
        FROM task_relations
        JOIN descendants ON task_relations.source_task_id = descendants.id
        WHERE task_relations.relation_type = 'blocks'
      )
      SELECT 1 FROM descendants WHERE id = ?
    `).get(targetTaskId, sourceTaskId);
    if (cycle) {
      throw new ApiError(409, "DEPENDENCY_CYCLE", "This dependency would create a cycle");
    }
  }

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.#prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, threadBinding, timestamp) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    this.#assertNoOpenTaskAgentRunRebinding(current, {}, threadBinding);
    const storedBinding = threadBinding === undefined
      ? undefined
      : storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.#prepare(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(...(storedBinding ?? []), timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #rootAgentRunBinding(task, requestedRootThreadId = null) {
    const binding = task.threadBinding;
    if (!binding) {
      throw new ApiError(409, "ROOT_THREAD_BINDING_REQUIRED", "A durable Agent Run requires a full task Root binding");
    }
    const worktree = task.developmentContext;
    if (worktree?.type !== "worktree" || !worktree.path || !worktree.branch) {
      throw new ApiError(409, "ROOT_WORKTREE_REQUIRED", "A durable Agent Run requires a task worktree and branch");
    }
    const assignment = this.getAgentTaskDomainAssignment(task.id);
    if (assignment) {
      const project = this.getAgentLaneProject(task.projectId);
      const domain = normalizeCoordinationDomains(project ?? {}).find((candidate) => candidate.id === assignment.domainId);
      const lease = project?.domainCoordinatorLeases?.[assignment.domainId] ?? null;
      const activeCoordinator = domain
        ? this.#exactActiveCoordinatorLease(
            task.projectId,
            project,
            lease,
            Date.now(),
            domain.id,
          )
        : null;
      const holder = activeCoordinator?.holder ?? null;
      if (!activeCoordinator) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_LEASE_REQUIRED", "Assigned Todo requires an active domain coordinator lease");
      }
      if (!holder?.threadId || !holder?.codexHostId || !holder?.workspacePath || !path.isAbsolute(holder.workspacePath)) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_BINDING_REQUIRED", "Assigned Todo requires a fully bound domain coordinator");
      }
      if (!requestedRootThreadId || requestedRootThreadId !== holder.threadId) {
        throw new ApiError(409, "DOMAIN_COORDINATOR_THREAD_MISMATCH", "Claim must come from the current domain coordinator route");
      }
      return {
        projectId: task.projectId,
        rootThreadId: holder.threadId,
        rootHostId: holder.codexHostId,
        rootWorkspacePath: holder.workspacePath,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        domainId: domain.id,
        domainWriteScope: domain.writeScope,
        domainLeaseExpiresAt: lease.expiresAt,
        domainCoordinatorLeaseId: lease.id,
        domainCoordinatorTaskId: lease.holderTaskId,
      };
    }
    const project = this.getAgentLaneProject(task.projectId);
    const globalLease = project?.coordinatorLease ?? null;
    const activeGlobalLease = this.#exactActiveCoordinatorLease(task.projectId, project, globalLease);
    if (activeGlobalLease) {
      const globalHolder = activeGlobalLease.holder;
      if (!globalHolder?.threadId || !globalHolder?.codexHostId
        || !globalHolder?.workspacePath || !path.isAbsolute(globalHolder.workspacePath)) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_BINDING_REQUIRED", "Unassigned Todo requires a fully bound Global Coordinator");
      }
      if (!requestedRootThreadId || requestedRootThreadId !== globalHolder.threadId) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_THREAD_MISMATCH", "Unassigned Todo arbitration must come from the active Global Coordinator");
      }
      return {
        projectId: task.projectId,
        rootThreadId: globalHolder.threadId,
        rootHostId: globalHolder.codexHostId,
        rootWorkspacePath: globalHolder.workspacePath,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        globalCoordinatorLeaseId: globalLease.id,
        globalCoordinatorTaskId: globalLease.holderTaskId,
      };
    }
    if (globalLease) {
      const timestamp = Date.now();
      const temporallyActive = !globalLease.releasedAt
        && Date.parse(globalLease.acquiredAt) <= timestamp
        && timestamp < Date.parse(globalLease.expiresAt);
      if (temporallyActive) {
        throw new ApiError(409, "GLOBAL_COORDINATOR_BINDING_REQUIRED", "Unassigned Todo requires an exact-bound active Global Coordinator lease");
      }
      throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_REQUIRED", "Unassigned Todo requires an active Global Coordinator lease");
    }
    if (project && project.rootTaskId == null) {
      throw new ApiError(409, "GLOBAL_COORDINATOR_LEASE_REQUIRED", "Unassigned Todo requires an active Global Coordinator lease");
    }
    if (requestedRootThreadId && requestedRootThreadId !== binding.threadId) {
      throw new ApiError(409, "ROOT_THREAD_MISMATCH", "Claim must match the task Root thread");
    }
    return {
      projectId: task.projectId,
      rootThreadId: binding.threadId,
      rootHostId: binding.codexHostId,
      rootWorkspacePath: binding.workspacePath,
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
    };
  }

  #createTaskAgentRun(task, rootRun, agentPath, agentThreadId, writeScope, timestamp) {
    this.#prepare(`
      INSERT INTO task_agent_runs (
        id, task_id, project_id, role, status, version, root_thread_id, agent_path, agent_thread_id,
        worktree_path, worktree_branch, write_scope_json, started_at, updated_at,
        finished_at, summary, next_action
      ) VALUES (?, ?, ?, 'sub_agent', 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      randomUUID(),
      task.id,
      rootRun.projectId,
      rootRun.rootThreadId,
      agentPath,
      agentThreadId,
      rootRun.worktreePath,
      rootRun.worktreeBranch,
      JSON.stringify(writeScope),
      timestamp,
      timestamp,
    );
  }

  #taskAgentRunForTask(taskId, statuses = null) {
    const statusClause = statuses ? ` AND status IN (${statuses.map(() => "?").join(", ")})` : "";
    const row = this.#prepare(`
      SELECT * FROM task_agent_runs
      WHERE task_id = ?${statusClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(taskId, ...(statuses ?? []));
    return row ? taskAgentRunFromRow(row) : null;
  }

  #assertNoOpenTaskAgentRunRebinding(task, changes, threadBinding) {
    const run = this.#taskAgentRunForTask(task.id, ["active", "blocked"]);
    if (!run) return null;
    const projectChanged = Object.hasOwn(changes, "projectId") && changes.projectId !== task.projectId;
    const worktreeChanged = Object.hasOwn(changes, "developmentContext")
      && !sameDevelopmentContext(changes.developmentContext, task.developmentContext);
    const rootChanged = threadBinding !== undefined && !sameThreadBinding(threadBinding, task.threadBinding);
    if (projectChanged || worktreeChanged || rootChanged) {
      throw new ApiError(
        409,
        "RUN_REBIND_CONFLICT",
        "Root, worktree, and project bindings cannot change while an Agent Run is open",
      );
    }
    return run;
  }

  #assertTaskAgentRunBinding(run, task, rootRun) {
    if (
      run.taskId !== task.id
      || run.projectId !== rootRun.projectId
      || run.rootThreadId !== rootRun.rootThreadId
      || run.worktree.path !== rootRun.worktreePath
      || run.worktree.branch !== rootRun.worktreeBranch
    ) {
      throw new ApiError(
        409,
        "RUN_BINDING_STALE",
        "The durable Agent Run no longer matches the task Root, worktree, or project binding",
      );
    }
  }

  #interruptTaskAgentExecution(taskId, timestamp) {
    this.#prepare(`
      UPDATE agent_task_claims SET status = 'interrupted', completed_at = ?
      WHERE task_id = ? AND status = 'active'
    `).run(timestamp, taskId);
    this.#prepare(`
      UPDATE task_agent_runs
      SET status = 'interrupted', version = version + 1, updated_at = ?, finished_at = ?
      WHERE task_id = ? AND status IN ('active', 'blocked')
    `).run(timestamp, timestamp, taskId);
  }

  #requireTaskAgentRun(id) {
    const run = this.getTaskAgentRun(id);
    if (!run) {
      throw new ApiError(404, "AGENT_RUN_NOT_FOUND", `Agent Run '${id}' does not exist`);
    }
    return run;
  }

  #assertAgentRunThread(run, agentThreadId) {
    if (!agentThreadId || run.agentThreadId !== agentThreadId) {
      throw new ApiError(409, "RUN_THREAD_MISMATCH", "Only the owning Agent thread can update this Agent Run");
    }
  }

  #requireAgentRunVersion(run, expectedVersion) {
    if (run.version !== expectedVersion) {
      throw new ApiError(409, "RUN_VERSION_CONFLICT", "Agent Run was changed by another client", {
        expectedVersion,
        actualVersion: run.version,
      });
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
