import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_ID,
  JIRA_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
  isWorkingLogStatus,
} from "../shared/domain.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { createAgentLaneSnapshotProvider } from "./agent-lane-snapshot.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
import { decodeComposerReferenceKey } from "./composer-reference.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, TaskboardDatabase } from "./database.mjs";
import { createJiraConfigStore } from "./jira-config.mjs";
import { createJiraIntegration } from "./jira-integration.mjs";
import { ProjectSummaryService } from "./project-summary.mjs";
import {
  STANDING_AUTHORITY_ACTIONS,
  normalizeRepository,
  normalizeStandingActions,
} from "./standing-authority.mjs";
import { createTaskboardPanelPresence } from "./taskboard-panel-presence.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const PROJECT_README_BODY_LIMIT = 3 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const HOST_RUNTIME_TTL_MS = 3_000;
const WORKTREE_REPOSITORY_TTL_MS = 30_000;
const STANDING_AUTHORITY_ACTION_SET = new Set(STANDING_AUTHORITY_ACTIONS);
const STANDING_AUTHORITY_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const LAUNCHER_BOUNDARY_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taskboard is running</title>
</head>
<body>
  <main>
    <h1>Taskboard is running</h1>
    <p>This address is the local service boundary.</p>
    <p>Open Taskboard from Codex to use authenticated Agent Lanes.</p>
    <p>No Taskboard data is exposed here.</p>
  </main>
</body>
</html>`;

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function sendLauncherBoundaryPage(response, method) {
  const body = method === "HEAD" ? "" : LAUNCHER_BOUNDARY_PAGE;
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request, allowOpaqueOrigin = false) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  if (!isTrustedNetworkHost(host)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  if (allowOpaqueOrigin && origin === "null") return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost)) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function parseAfterCursor(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(["after"]), routeLabel);
  const value = searchParams.get("after");
  if (value === null) return null;
  const revision = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor must be a non-negative integer revision");
  }
  return { value, revision };
}

function nextCursor(items, after) {
  if (items.length === 0) return after?.value ?? "0";
  return String(items.reduce(
    (revision, item) => Math.max(revision, item.changeRevision),
    0,
  ));
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function parseCoordinatorLeaseClaim(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "holderTaskId",
    "holderThreadId",
    "expectedLeaseId",
    "leaseDurationSeconds",
  ]));
  if (!Object.hasOwn(value, "expectedLeaseId")) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedLeaseId' is required");
  }
  if (
    !Number.isInteger(value.leaseDurationSeconds)
    || value.leaseDurationSeconds < 30
    || value.leaseDurationSeconds > 3600
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'leaseDurationSeconds' must be an integer from 30 through 3600",
    );
  }
  return {
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedLeaseId: stringField(value.expectedLeaseId, "expectedLeaseId", {
      nullable: true,
      maxLength: 256,
    }),
    leaseDurationSeconds: value.leaseDurationSeconds,
  };
}

function parseCoordinationWindowRegistration(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "role", "taskId", "label", "threadId", "expectedRevision", "idempotencyKey",
  ]));
  const role = stringField(value.role, "role", { required: true, maxLength: 32 });
  if (role !== "owner_root" && role !== "coordinator") {
    throw new ApiError(400, "INVALID_FIELD", "'role' must be owner_root or coordinator");
  }
  const expectedRevision = stringField(value.expectedRevision, "expectedRevision", {
    required: true, maxLength: 64,
  });
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedRevision' must be a lowercase SHA-256 digest");
  }
  return {
    role,
    taskId: stringField(value.taskId, "taskId", { required: true, maxLength: 256 }),
    label: stringField(value.label, "label", { required: true, maxLength: 120 }),
    threadId: stringField(value.threadId, "threadId", { required: true, maxLength: 256 }),
    expectedRevision,
    idempotencyKey: stringField(value.idempotencyKey, "idempotencyKey", {
      required: true, maxLength: 256,
    }),
  };
}

function parseCoordinationIdentityHandshakeRegistration(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "projectId", "role", "taskId", "label", "threadId", "expectedRevision", "idempotencyKey",
  ]));
  const projectId = stringField(value.projectId, "registration.projectId", {
    required: true, maxLength: 128,
  });
  validateProjectId(projectId);
  const registration = parseCoordinationWindowRegistration({
    role: value.role,
    taskId: value.taskId,
    label: value.label,
    threadId: value.threadId,
    expectedRevision: value.expectedRevision,
    idempotencyKey: value.idempotencyKey,
  });
  return { projectId, ...registration };
}

function parseCoordinatorProvisioningRequest(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "idempotencyKey", "taskId", "label", "threadSource", "model", "reasoningEffort",
    "expectedRevision",
    "ownerRootTaskId", "ownerRootThreadId", "codexProjectId", "codexProjectKind",
    "codexHostId", "workspacePath", "retireCoordinatorWindows",
  ]));
  const expectedRevision = stringField(value.expectedRevision, "expectedRevision", {
    required: true, maxLength: 64,
  });
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedRevision' must be a lowercase SHA-256 digest");
  }
  const codexProjectKind = stringField(value.codexProjectKind, "codexProjectKind", {
    required: true, maxLength: 16,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "'codexProjectKind' must be local or remote");
  }
  const workspacePath = stringField(value.workspacePath, "workspacePath", {
    required: true, maxLength: 4096,
  });
  if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute path");
  }
  const codexHostId = stringField(value.codexHostId, "codexHostId", {
    required: true, maxLength: 256,
  });
  if ((codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")) {
    throw new ApiError(400, "INVALID_FIELD", "Coordinator provisioning project identity is invalid");
  }
  const retireCoordinatorWindows = value.retireCoordinatorWindows ?? [];
  if (!Array.isArray(retireCoordinatorWindows) || retireCoordinatorWindows.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", "'retireCoordinatorWindows' must be an array with at most 32 entries");
  }
  const seenRetirements = new Set();
  const parsedRetirements = retireCoordinatorWindows.map((candidate, index) => {
    assertPlainObject(candidate);
    assertAllowedKeys(candidate, new Set([
      "taskId", "label", "role", "threadId", "codexProjectId", "codexProjectKind",
      "codexHostId", "workspacePath",
    ]));
    if (candidate.role !== "coordinator") {
      throw new ApiError(400, "INVALID_FIELD", `retireCoordinatorWindows[${index}].role must be coordinator`);
    }
    const retirement = {
      taskId: stringField(candidate.taskId, `retireCoordinatorWindows[${index}].taskId`, { required: true, maxLength: 256 }),
      label: stringField(candidate.label, `retireCoordinatorWindows[${index}].label`, { required: true, maxLength: 120 }),
      role: "coordinator",
      threadId: stringField(candidate.threadId, `retireCoordinatorWindows[${index}].threadId`, { required: true, maxLength: 256 }),
      codexProjectId: stringField(candidate.codexProjectId, `retireCoordinatorWindows[${index}].codexProjectId`, { required: true, maxLength: 256 }),
      codexProjectKind: stringField(candidate.codexProjectKind, `retireCoordinatorWindows[${index}].codexProjectKind`, { required: true, maxLength: 16 }),
      codexHostId: stringField(candidate.codexHostId, `retireCoordinatorWindows[${index}].codexHostId`, { required: true, maxLength: 256 }),
      workspacePath: path.resolve(stringField(candidate.workspacePath, `retireCoordinatorWindows[${index}].workspacePath`, { required: true, maxLength: 4096 })),
    };
    if (!path.isAbsolute(candidate.workspacePath) || candidate.workspacePath.includes("\0")
      || !new Set(["local", "remote"]).has(retirement.codexProjectKind)
      || (retirement.codexProjectKind === "local" && retirement.codexHostId !== "local")
      || (retirement.codexProjectKind === "remote" && retirement.codexHostId === "local")) {
      throw new ApiError(400, "INVALID_FIELD", `retireCoordinatorWindows[${index}] has an invalid protected identity`);
    }
    const key = `${retirement.taskId}\0${retirement.threadId}`;
    if (seenRetirements.has(key)) {
      throw new ApiError(400, "INVALID_FIELD", "retireCoordinatorWindows must not contain duplicates");
    }
    seenRetirements.add(key);
    return retirement;
  });
  return {
    idempotencyKey: stringField(value.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    taskId: stringField(value.taskId, "taskId", { required: true, maxLength: 256 }),
    label: stringField(value.label, "label", { required: true, maxLength: 120 }),
    threadSource: stringField(value.threadSource, "threadSource", { required: true, maxLength: 256 }),
    model: stringField(value.model, "model", { required: true, maxLength: 256 }),
    reasoningEffort: stringField(value.reasoningEffort, "reasoningEffort", {
      required: true, maxLength: 100,
    }),
    expectedRevision,
    ownerRootTaskId: stringField(value.ownerRootTaskId, "ownerRootTaskId", { required: true, maxLength: 256 }),
    ownerRootThreadId: stringField(value.ownerRootThreadId, "ownerRootThreadId", { required: true, maxLength: 256 }),
    codexProjectId: stringField(value.codexProjectId, "codexProjectId", { required: true, maxLength: 256 }),
    codexProjectKind,
    codexHostId,
    workspacePath: path.resolve(workspacePath),
    retireCoordinatorWindows: parsedRetirements,
  };
}

function parseCoordinatorProvisioningTransition(value, action) {
  assertPlainObject(value);
  assertAllowedKeys(value, action === "attach" ? new Set(["threadId"]) : new Set());
  return action === "attach"
    ? { threadId: stringField(value.threadId, "threadId", { required: true, maxLength: 256 }) }
    : {};
}

function parseCoordinatorProvisioningLookup(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["idempotencyKey"]));
  if (value.idempotencyKey === undefined) return null;
  return stringField(value.idempotencyKey, "idempotencyKey", {
    required: true, maxLength: 256,
  });
}

function parseCoordinatorShutdownRequest(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "idempotencyKey", "expectedRevision", "expectedLeaseId",
    "holderTaskId", "holderThreadId", "ownerRootTaskId", "ownerRootThreadId",
    "ownerRootCodexProjectId", "ownerRootCodexProjectKind",
    "ownerRootCodexHostId", "ownerRootWorkspacePath",
    "codexProjectId", "codexProjectKind", "codexHostId", "workspacePath",
  ]));
  const expectedRevision = stringField(value.expectedRevision, "expectedRevision", {
    required: true, maxLength: 64,
  });
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedRevision' must be a lowercase SHA-256 digest");
  }
  const codexProjectKind = stringField(value.codexProjectKind, "codexProjectKind", {
    required: true, maxLength: 16,
  });
  if (!new Set(["local", "remote"]).has(codexProjectKind)) {
    throw new ApiError(400, "INVALID_FIELD", "'codexProjectKind' must be local or remote");
  }
  const codexHostId = stringField(value.codexHostId, "codexHostId", {
    required: true, maxLength: 256,
  });
  if ((codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")) {
    throw new ApiError(400, "INVALID_FIELD", "Coordinator shutdown project identity is invalid");
  }
  const workspacePath = stringField(value.workspacePath, "workspacePath", {
    required: true, maxLength: 4096,
  });
  if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be an absolute path");
  }
  const ownerRootCodexProjectKind = stringField(
    value.ownerRootCodexProjectKind, "ownerRootCodexProjectKind", { required: true, maxLength: 16 },
  );
  if (!new Set(["local", "remote"]).has(ownerRootCodexProjectKind)) {
    throw new ApiError(400, "INVALID_FIELD", "'ownerRootCodexProjectKind' must be local or remote");
  }
  const ownerRootCodexHostId = stringField(
    value.ownerRootCodexHostId, "ownerRootCodexHostId", { required: true, maxLength: 256 },
  );
  if ((ownerRootCodexProjectKind === "local" && ownerRootCodexHostId !== "local")
    || (ownerRootCodexProjectKind === "remote" && ownerRootCodexHostId === "local")) {
    throw new ApiError(400, "INVALID_FIELD", "Owner Root shutdown project identity is invalid");
  }
  const ownerRootWorkspacePath = stringField(
    value.ownerRootWorkspacePath, "ownerRootWorkspacePath", { required: true, maxLength: 4096 },
  );
  if (!path.isAbsolute(ownerRootWorkspacePath) || ownerRootWorkspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'ownerRootWorkspacePath' must be an absolute path");
  }
  return {
    idempotencyKey: stringField(value.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    expectedRevision,
    expectedLeaseId: stringField(value.expectedLeaseId, "expectedLeaseId", { required: true, maxLength: 256 }),
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    ownerRootTaskId: stringField(value.ownerRootTaskId, "ownerRootTaskId", { required: true, maxLength: 256 }),
    ownerRootThreadId: stringField(value.ownerRootThreadId, "ownerRootThreadId", { required: true, maxLength: 256 }),
    ownerRootCodexProjectId: stringField(value.ownerRootCodexProjectId, "ownerRootCodexProjectId", { required: true, maxLength: 256 }),
    ownerRootCodexProjectKind,
    ownerRootCodexHostId,
    ownerRootWorkspacePath: path.resolve(ownerRootWorkspacePath),
    codexProjectId: stringField(value.codexProjectId, "codexProjectId", { required: true, maxLength: 256 }),
    codexProjectKind,
    codexHostId,
    workspacePath: path.resolve(workspacePath),
  };
}

function parseCoordinatorLeaseRenew(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "holderTaskId", "holderThreadId", "holderCodexHostId", "holderWorkspacePath",
    "expectedLeaseId", "leaseDurationSeconds",
  ]));
  const claim = parseCoordinatorLeaseClaim({
    holderTaskId: value.holderTaskId,
    holderThreadId: value.holderThreadId,
    expectedLeaseId: value.expectedLeaseId,
    leaseDurationSeconds: value.leaseDurationSeconds,
  });
  const holderWorkspacePath = stringField(value.holderWorkspacePath, "holderWorkspacePath", {
    required: true, maxLength: 4096,
  });
  if (!path.isAbsolute(holderWorkspacePath) || holderWorkspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'holderWorkspacePath' must be an absolute path");
  }
  return {
    ...claim,
    holderCodexHostId: stringField(value.holderCodexHostId, "holderCodexHostId", {
      required: true, maxLength: 256,
    }),
    holderWorkspacePath: path.resolve(holderWorkspacePath),
  };
}

function parseCoordinatorLeaseRelease(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["holderTaskId", "holderThreadId", "expectedLeaseId"]));
  return {
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedLeaseId: stringField(value.expectedLeaseId, "expectedLeaseId", { required: true, maxLength: 256 }),
  };
}

function parseDomainTodoAssignment(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "domainId", "taskVersion", "holderTaskId", "holderThreadId", "expectedCoordinatorLeaseId",
  ]));
  return {
    domainId: stringField(value.domainId, "domainId", { required: true, maxLength: 64 }),
    taskVersion: parseVersion(value.taskVersion),
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedCoordinatorLeaseId: stringField(
      value.expectedCoordinatorLeaseId,
      "expectedCoordinatorLeaseId",
      { required: true, maxLength: 256 },
    ),
  };
}

function parseCoordinationDomainConfiguration(value, { remove = false } = {}) {
  assertPlainObject(value);
  const commonKeys = [
    "expectedRevision", "idempotencyKey", "holderTaskId", "holderThreadId",
    "expectedCoordinatorLeaseId",
  ];
  assertAllowedKeys(value, new Set(remove ? commonKeys : [
    ...commonKeys, "label", "writeScope", "eligibleTaskIds",
  ]));
  const expectedRevision = stringField(value.expectedRevision, "expectedRevision", { required: true, maxLength: 64 });
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedRevision' must be a lowercase SHA-256 digest");
  }
  const common = {
    expectedRevision,
    idempotencyKey: stringField(value.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedCoordinatorLeaseId: stringField(value.expectedCoordinatorLeaseId, "expectedCoordinatorLeaseId", { required: true, maxLength: 256 }),
  };
  if (remove) return { ...common, domain: null };
  if (!Array.isArray(value.writeScope) || !Array.isArray(value.eligibleTaskIds)) {
    throw new ApiError(400, "INVALID_FIELD", "'writeScope' and 'eligibleTaskIds' must be arrays");
  }
  return {
    ...common,
    domain: {
      label: stringField(value.label, "label", { required: true, maxLength: 80 }),
      writeScope: value.writeScope,
      eligibleTaskIds: value.eligibleTaskIds,
    },
  };
}

function parseDomainTodoAssignmentClear(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "taskVersion", "holderTaskId", "holderThreadId", "expectedCoordinatorLeaseId",
  ]));
  return {
    domainId: null,
    taskVersion: parseVersion(value.taskVersion),
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedCoordinatorLeaseId: stringField(
      value.expectedCoordinatorLeaseId,
      "expectedCoordinatorLeaseId",
      { required: true, maxLength: 256 },
    ),
  };
}

function parseCrossDomainDependencyClearance(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "sourceTaskId", "idempotencyKey", "holderTaskId", "holderThreadId", "expectedTargetDomainLeaseId",
  ]));
  return {
    sourceTaskId: stringField(value.sourceTaskId, "sourceTaskId", { required: true, maxLength: 256 }),
    idempotencyKey: stringField(value.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedTargetDomainLeaseId: stringField(
      value.expectedTargetDomainLeaseId,
      "expectedTargetDomainLeaseId",
      { required: true, maxLength: 256 },
    ),
  };
}

function parseCoordinatorBindingRepair(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "taskId", "taskVersion", "holderTaskId", "holderThreadId", "expectedLeaseId",
  ]));
  if (!Number.isInteger(value.taskVersion) || value.taskVersion < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'taskVersion' must be a positive integer");
  }
  return {
    taskId: stringField(value.taskId, "taskId", { required: true, maxLength: 256 }),
    taskVersion: value.taskVersion,
    holderTaskId: stringField(value.holderTaskId, "holderTaskId", { required: true, maxLength: 256 }),
    holderThreadId: stringField(value.holderThreadId, "holderThreadId", { required: true, maxLength: 256 }),
    expectedLeaseId: stringField(value.expectedLeaseId, "expectedLeaseId", { required: true, maxLength: 256 }),
  };
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseWorkingLog(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["path", "status"]));
  const workingLogPath = pathField(value.path, "workingLog.path");
  if (!workingLogPath) {
    throw new ApiError(400, "INVALID_FIELD", "'workingLog.path' is required");
  }
  if (!path.isAbsolute(workingLogPath)) {
    throw new ApiError(400, "INVALID_FIELD", "'workingLog.path' must be absolute");
  }
  if (!isWorkingLogStatus(value.status)) {
    throw new ApiError(400, "INVALID_FIELD", "'workingLog.status' must be planned, active, blocked, or complete");
  }
  return { path: path.resolve(workingLogPath), status: value.status };
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseIsoTimestamp(value, name, { nullable = false } = {}) {
  const timestamp = stringField(value, name, { required: !nullable, nullable, maxLength: 64 });
  if (timestamp === null) return null;
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function parseStandingAuthorityGrant(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "repository",
    "actions",
    "sourceTaskId",
    "sourceThreadId",
    "evidence",
    "receipt",
    "grantedAt",
    "expiresAt",
  ]));
  const repository = normalizeRepository(body.repository);
  if (!repository) {
    throw new ApiError(400, "INVALID_FIELD", "'repository' must be a normalized GitHub or GitLab owner/repository URL");
  }
  const actions = normalizeStandingActions(body.actions);
  if (!actions) {
    throw new ApiError(400, "INVALID_FIELD", "'actions' must be a unique non-empty supported action list");
  }
  const grantedAt = parseIsoTimestamp(body.grantedAt, "grantedAt");
  const expiresAt = body.expiresAt === undefined
    ? null
    : parseIsoTimestamp(body.expiresAt, "expiresAt", { nullable: true });
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(grantedAt)) {
    throw new ApiError(400, "INVALID_FIELD", "'expiresAt' must be later than 'grantedAt'");
  }
  if (Date.parse(grantedAt) > Date.now() + STANDING_AUTHORITY_CLOCK_SKEW_MS) {
    throw new ApiError(400, "INVALID_FIELD", "'grantedAt' cannot be more than five minutes in the future");
  }
  return {
    repository,
    actions,
    sourceTaskId: stringField(body.sourceTaskId, "sourceTaskId", { required: true, maxLength: 256 }),
    sourceThreadId: stringField(body.sourceThreadId, "sourceThreadId", { required: true, maxLength: 256 }),
    evidence: stringField(body.evidence, "evidence", { required: true, maxLength: 4096 }),
    receipt: stringField(body.receipt, "receipt", { required: true, maxLength: 256 }),
    grantedAt,
    expiresAt,
  };
}

function parseStandingAuthorityRevocation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["evidence", "receipt"]));
  return {
    evidence: stringField(body.evidence, "evidence", { required: true, maxLength: 4096 }),
    receipt: stringField(body.receipt, "receipt", { required: true, maxLength: 256 }),
  };
}

function parseOwnerDecision(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "requestId",
    "expectedResumeToken",
    "outcome",
    "ownerTurnId",
    "rootDecisionTurnId",
    "rootThreadId",
    "evidence",
    "deliveryId",
    "receipt",
    "decidedAt",
  ]));
  const outcome = stringField(body.outcome, "outcome", { required: true, maxLength: 32 });
  if (!["authorized", "denied"].includes(outcome)) {
    throw new ApiError(400, "INVALID_FIELD", "'outcome' must be authorized or denied");
  }
  const requestId = stringField(body.requestId, "requestId", { required: true, maxLength: 64 });
  const expectedResumeToken = stringField(body.expectedResumeToken, "expectedResumeToken", { required: true, maxLength: 64 });
  if (!/^[a-f0-9]{64}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(expectedResumeToken)) {
    throw new ApiError(400, "INVALID_FIELD", "Decision request and resume token must be SHA-256 values");
  }
  return {
    requestId,
    expectedResumeToken,
    outcome,
    ownerTurnId: stringField(body.ownerTurnId, "ownerTurnId", { required: true, maxLength: 256 }),
    rootDecisionTurnId: stringField(body.rootDecisionTurnId, "rootDecisionTurnId", { required: true, maxLength: 256 }),
    rootThreadId: stringField(body.rootThreadId, "rootThreadId", { required: true, maxLength: 256 }),
    evidence: stringField(body.evidence, "evidence", { required: true, maxLength: 4096 }),
    deliveryId: stringField(body.deliveryId, "deliveryId", { required: true, maxLength: 256 }),
    receipt: stringField(body.receipt, "receipt", { required: true, maxLength: 256 }),
    decidedAt: parseIsoTimestamp(body.decidedAt, "decidedAt"),
  };
}

function parseOwnerDecisionDeliveryClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "requestId", "expectedResumeToken", "gateId", "gateKind", "actionId", "approver", "message",
    "scope", "target", "requestedAt", "taskId", "identifier", "priority",
    "coordinatorEpoch", "route",
  ]));
  assertPlainObject(body.route);
  assertAllowedKeys(body.route, new Set([
    "rootTaskId", "rootThreadId", "codexHostId", "rootWorkspacePath",
  ]));
  const requestId = stringField(body.requestId, "requestId", { required: true, maxLength: 64 });
  const expectedResumeToken = stringField(body.expectedResumeToken, "expectedResumeToken", { required: true, maxLength: 64 });
  if (!/^[a-f0-9]{64}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(expectedResumeToken)) {
    throw new ApiError(400, "INVALID_FIELD", "Delivery request and resume token must be SHA-256 values");
  }
  const rootWorkspacePath = stringField(body.route.rootWorkspacePath, "route.rootWorkspacePath", { required: true, maxLength: 4096 });
  if (!path.isAbsolute(rootWorkspacePath)) {
    throw new ApiError(400, "INVALID_FIELD", "Owner decision Root workspace must be absolute");
  }
  return {
    requestId,
    expectedResumeToken,
    gateId: stringField(body.gateId, "gateId", { required: true, maxLength: 256 }),
    gateKind: stringField(body.gateKind, "gateKind", { required: true, maxLength: 256 }),
    actionId: stringField(body.actionId, "actionId", { required: true, maxLength: 256 }),
    approver: stringField(body.approver, "approver", { required: true, maxLength: 256 }),
    message: stringField(body.message, "message", { required: true, maxLength: 4096 }),
    scope: body.scope ?? null,
    target: body.target ?? null,
    requestedAt: stringField(body.requestedAt, "requestedAt", { required: true, maxLength: 64 }),
    taskId: stringField(body.taskId, "taskId", { required: true, maxLength: 256 }),
    identifier: stringField(body.identifier, "identifier", { required: true, maxLength: 256 }),
    priority: stringField(body.priority, "priority", { required: true, maxLength: 32 }),
    coordinatorEpoch: stringField(body.coordinatorEpoch, "coordinatorEpoch", { required: true, maxLength: 512 }),
    route: {
      rootTaskId: stringField(body.route.rootTaskId, "route.rootTaskId", { required: true, maxLength: 256 }),
      rootThreadId: stringField(body.route.rootThreadId, "route.rootThreadId", { required: true, maxLength: 256 }),
      codexHostId: stringField(body.route.codexHostId, "route.codexHostId", { required: true, maxLength: 256 }),
      rootWorkspacePath,
    },
  };
}

function parseOwnerDecisionDeliveryConfirmation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["deliveryId", "deliveryTurnId"]));
  return {
    deliveryId: stringField(body.deliveryId, "deliveryId", { required: true, maxLength: 256 }),
    deliveryTurnId: stringField(body.deliveryTurnId, "deliveryTurnId", { required: true, maxLength: 256 }),
  };
}

function sameOwnerDecisionDeliveryRequest(left, right) {
  return Boolean(left && right
    && left.requestId === right.requestId
    && left.expectedResumeToken === right.expectedResumeToken
    && left.gateId === right.gateId
    && left.gateKind === right.gateKind
    && left.actionId === right.actionId
    && left.approver === right.approver
    && left.message === right.message
    && JSON.stringify(left.scope ?? null) === JSON.stringify(right.scope ?? null)
    && JSON.stringify(left.target ?? null) === JSON.stringify(right.target ?? null)
    && left.requestedAt === right.requestedAt
    && left.taskId === right.taskId
    && left.identifier === right.identifier
    && left.priority === right.priority
    && left.coordinatorEpoch === right.coordinatorEpoch
    && left.route?.rootTaskId === right.route?.rootTaskId
    && left.route?.rootThreadId === right.route?.rootThreadId
    && left.route?.codexHostId === right.route?.codexHostId
    && path.resolve(left.route?.rootWorkspacePath ?? "") === path.resolve(right.route?.rootWorkspacePath ?? ""));
}

function parseCrossDomainHandoffDeliveryClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "sourceTaskId", "sourceIdentifier", "targetTaskId", "targetIdentifier",
    "fingerprint", "sourceDomainId", "targetDomainId", "expectedTargetDomainLeaseId",
    "targetHolderTaskId", "route",
  ]));
  assertPlainObject(body.route);
  assertAllowedKeys(body.route, new Set(["targetThreadId", "codexHostId", "targetWorkspacePath"]));
  const targetWorkspacePath = stringField(body.route.targetWorkspacePath, "route.targetWorkspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (!path.isAbsolute(targetWorkspacePath)) {
    throw new ApiError(400, "INVALID_FIELD", "Cross-domain handoff target workspace must be absolute");
  }
  return {
    projectId: stringField(body.projectId, "projectId", { required: true, maxLength: 256 }),
    sourceTaskId: stringField(body.sourceTaskId, "sourceTaskId", { required: true, maxLength: 256 }),
    sourceIdentifier: stringField(body.sourceIdentifier, "sourceIdentifier", { required: true, maxLength: 256 }),
    targetTaskId: stringField(body.targetTaskId, "targetTaskId", { required: true, maxLength: 256 }),
    targetIdentifier: stringField(body.targetIdentifier, "targetIdentifier", { required: true, maxLength: 256 }),
    fingerprint: stringField(body.fingerprint, "fingerprint", { required: true, maxLength: 64 }),
    sourceDomainId: stringField(body.sourceDomainId, "sourceDomainId", { required: true, maxLength: 256 }),
    targetDomainId: stringField(body.targetDomainId, "targetDomainId", { required: true, maxLength: 256 }),
    expectedTargetDomainLeaseId: stringField(body.expectedTargetDomainLeaseId, "expectedTargetDomainLeaseId", { required: true, maxLength: 256 }),
    targetHolderTaskId: stringField(body.targetHolderTaskId, "targetHolderTaskId", { required: true, maxLength: 256 }),
    route: {
      targetThreadId: stringField(body.route.targetThreadId, "route.targetThreadId", { required: true, maxLength: 256 }),
      codexHostId: stringField(body.route.codexHostId, "route.codexHostId", { required: true, maxLength: 256 }),
      targetWorkspacePath,
    },
  };
}

function parseCrossDomainHandoffDeliveryConfirmation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["deliveryId", "deliveryTurnId"]));
  return {
    deliveryId: stringField(body.deliveryId, "deliveryId", { required: true, maxLength: 256 }),
    deliveryTurnId: stringField(body.deliveryTurnId, "deliveryTurnId", { required: true, maxLength: 256 }),
  };
}

function sameCrossDomainHandoffDeliveryRequest(left, right) {
  return Boolean(left && right
    && left.projectId === right.projectId
    && left.sourceTaskId === right.sourceTaskId
    && left.sourceIdentifier === right.sourceIdentifier
    && left.targetTaskId === right.targetTaskId
    && left.targetIdentifier === right.targetIdentifier
    && left.fingerprint === right.fingerprint
    && left.sourceDomainId === right.sourceDomainId
    && left.targetDomainId === right.targetDomainId
    && left.expectedTargetDomainLeaseId === right.expectedTargetDomainLeaseId
    && left.targetHolderTaskId === right.targetHolderTaskId
    && left.route?.targetThreadId === right.route?.targetThreadId
    && left.route?.codexHostId === right.route?.codexHostId
    && path.resolve(left.route?.targetWorkspacePath ?? "") === path.resolve(right.route?.targetWorkspacePath ?? ""));
}

function parseProjectReadmeSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["content", "version"]));
  const content = body.content ?? "";
  if (typeof content !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "'content' must be a string");
  }
  if (content.length > 500_000) {
    throw new ApiError(400, "INVALID_FIELD", "'content' cannot exceed 500000 characters");
  }
  const version = body.version;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return { content, version };
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.codexProjectKind must be local or remote");
  }
  if (
    (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function assertInjectorProof(request, instanceSecret) {
  const nonce = requestHeader(request, "x-codex-taskboard-injector-nonce");
  const proof = requestHeader(request, "x-codex-taskboard-injector-proof");
  if (!instanceSecret
    || typeof nonce !== "string"
    || !/^[a-f0-9]{32,128}$/i.test(nonce)
    || typeof proof !== "string"
    || !/^[a-f0-9]{64}$/i.test(proof)
    || createHmac("sha256", instanceSecret).update(nonce).digest("hex") !== proof.toLowerCase()) {
    throw new ApiError(403, "INJECTOR_PROOF_REQUIRED", "Owner decision delivery reservations require the authenticated host Injector");
  }
}

function assertCoordinatorRenewProof(request, instanceSecret, pathname, body, consumedNonces) {
  const nonce = requestHeader(request, "x-codex-taskboard-injector-nonce");
  const issuedAt = requestHeader(request, "x-codex-taskboard-injector-issued-at");
  const proof = requestHeader(request, "x-codex-taskboard-injector-proof");
  const issuedAtMs = typeof issuedAt === "string" ? Number(issuedAt) : Number.NaN;
  const currentTime = Date.now();
  for (const [key, expiresAt] of consumedNonces) {
    if (expiresAt <= currentTime) consumedNonces.delete(key);
  }
  const expected = typeof nonce === "string" && typeof issuedAt === "string" && instanceSecret
    ? createHmac("sha256", instanceSecret).update(JSON.stringify({
        nonce, issuedAt, method: request.method, pathname, body,
      })).digest("hex")
    : null;
  if (!instanceSecret
    || typeof nonce !== "string"
    || !/^[a-f0-9]{32,128}$/i.test(nonce)
    || !Number.isSafeInteger(issuedAtMs)
    || Math.abs(currentTime - issuedAtMs) > 30_000
    || typeof proof !== "string"
    || !/^[a-f0-9]{64}$/i.test(proof)
    || expected !== proof.toLowerCase()
    || consumedNonces.has(nonce)) {
    throw new ApiError(403, "INJECTOR_PROOF_REQUIRED", "Coordinator renewal requires a fresh request-bound host Injector proof");
  }
  consumedNonces.set(nonce, currentTime + 60_000);
}

function actorFromRequest(request) {
  if (request.headers["x-taskboard-client"] === "taskctl") {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user or codex-agent");
  }
  return value;
}

function parseWorkflowProfile(value, fallback) {
  const profile = value ?? fallback;
  if (profile !== "formal" && profile !== "vibe") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowProfile' must be formal or vibe");
  }
  return profile;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "workingLog", "workflowProfile", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    workingLog: parseWorkingLog(body.workingLog ?? null),
    workflowProfile: parseWorkflowProfile(body.workflowProfile, "formal"),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "projectId", "title", "description", "status", "priority", "labels", "threadId", "threadBinding",
    "assigneeTarget", "developmentContext", "workingLog", "workflowProfile", "startDate", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const threadBinding = parseThreadBinding(body.threadBinding);
  if (threadId !== undefined) {
    throw new ApiError(400, "INVALID_FIELD", "Use 'threadBinding' to rebind a task root");
  }
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.workingLog !== undefined) changes.workingLog = parseWorkingLog(body.workingLog);
  if (body.workflowProfile !== undefined) changes.workflowProfile = parseWorkflowProfile(body.workflowProfile);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined && threadBinding === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, threadBinding, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseAgentClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "agentPath", "agentThreadId", "rootThreadId", "leaseExpiresAt", "writeScope",
    "admissionReceiptId", "admissionAttemptId",
  ]));
  const agentPath = stringField(body.agentPath, "agentPath", { required: true, maxLength: 240 });
  if (!agentPath.startsWith("/root/")) {
    throw new ApiError(400, "INVALID_FIELD", "'agentPath' must identify a Root Sub-Agent");
  }
  const agentThreadId = parseThreadId(body.agentThreadId);
  if (!agentThreadId) {
    throw new ApiError(400, "INVALID_FIELD", "'agentThreadId' is required");
  }
  const leaseExpiresAt = stringField(body.leaseExpiresAt, "leaseExpiresAt", { required: true, maxLength: 64 });
  const leaseDate = new Date(leaseExpiresAt);
  if (Number.isNaN(leaseDate.getTime()) || leaseDate <= new Date()) {
    throw new ApiError(400, "INVALID_FIELD", "'leaseExpiresAt' must be a future ISO timestamp");
  }
  if (!Array.isArray(body.writeScope) || body.writeScope.length === 0 || body.writeScope.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", "'writeScope' must contain 1 to 32 paths");
  }
  const writeScope = body.writeScope.map((value) => stringField(value, "writeScope", { required: true, maxLength: 240 }));
  return {
    version: parseVersion(body.version),
    agentPath,
    agentThreadId,
    rootThreadId: parseThreadId(body.rootThreadId) ?? null,
    leaseExpiresAt: leaseDate.toISOString(),
    writeScope,
    admissionReceiptId: body.admissionReceiptId === undefined
      ? null
      : stringField(body.admissionReceiptId, "admissionReceiptId", { required: true, maxLength: 128 }),
    admissionAttemptId: body.admissionAttemptId === undefined
      ? null
      : stringField(body.admissionAttemptId, "admissionAttemptId", { required: true, maxLength: 128 }),
  };
}

function parseSafeActionAdmissionDeferral(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "rootThreadId", "expectedResumeToken", "safeActionId", "admissionReceiptId", "admissionAttemptId",
  ]));
  return {
    rootThreadId: parseThreadId(body.rootThreadId),
    expectedResumeToken: stringField(body.expectedResumeToken, "expectedResumeToken", { required: true, maxLength: 128 }),
    safeActionId: stringField(body.safeActionId, "safeActionId", { required: true, maxLength: 128 }),
    admissionReceiptId: stringField(body.admissionReceiptId, "admissionReceiptId", { required: true, maxLength: 128 }),
    admissionAttemptId: stringField(body.admissionAttemptId, "admissionAttemptId", { required: true, maxLength: 128 }),
  };
}

function parseSafeActionAdmissionPreparation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "rootThreadId", "expectedResumeToken", "safeActionId", "admissionReceiptId",
    "admissionAttemptId", "writeScope",
  ]));
  if (!Array.isArray(body.writeScope) || body.writeScope.length === 0 || body.writeScope.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", "'writeScope' must contain 1 to 32 paths");
  }
  return {
    rootThreadId: parseThreadId(body.rootThreadId),
    expectedResumeToken: stringField(body.expectedResumeToken, "expectedResumeToken", { required: true, maxLength: 128 }),
    safeActionId: stringField(body.safeActionId, "safeActionId", { required: true, maxLength: 128 }),
    admissionReceiptId: stringField(body.admissionReceiptId, "admissionReceiptId", { required: true, maxLength: 128 }),
    admissionAttemptId: stringField(body.admissionAttemptId, "admissionAttemptId", { required: true, maxLength: 128 }),
    writeScope: body.writeScope.map((value) => stringField(value, "writeScope", { required: true, maxLength: 240 })),
  };
}

function parseSafeActionAdmissionReconciliation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "rootThreadId", "expectedResumeToken", "safeActionId", "admissionReceiptId",
    "admissionAttemptId", "admissionProbeId",
  ]));
  return {
    rootThreadId: parseThreadId(body.rootThreadId),
    expectedResumeToken: stringField(body.expectedResumeToken, "expectedResumeToken", { required: true, maxLength: 128 }),
    safeActionId: stringField(body.safeActionId, "safeActionId", { required: true, maxLength: 128 }),
    admissionReceiptId: stringField(body.admissionReceiptId, "admissionReceiptId", { required: true, maxLength: 128 }),
    admissionAttemptId: stringField(body.admissionAttemptId, "admissionAttemptId", { required: true, maxLength: 128 }),
    admissionProbeId: stringField(body.admissionProbeId, "admissionProbeId", { required: true, maxLength: 128 }),
  };
}

function parseSafeActionBootstrapClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "rootThreadId", "expectedResumeToken", "safeActionId", "reservationLeaseId", "recoveryLeaseId", "deliveryTurnId",
  ]));
  const rootThreadId = parseThreadId(body.rootThreadId);
  if (!rootThreadId) throw new ApiError(400, "INVALID_FIELD", "'rootThreadId' is required");
  const expectedResumeToken = stringField(body.expectedResumeToken, "expectedResumeToken", {
    required: true,
    maxLength: 64,
  });
  if (!/^[a-f0-9]{64}$/.test(expectedResumeToken)) {
    throw new ApiError(400, "INVALID_FIELD", "'expectedResumeToken' must be a SHA-256 token");
  }
  return {
    rootThreadId,
    expectedResumeToken,
    safeActionId: stringField(body.safeActionId, "safeActionId", { required: true, maxLength: 128 }),
    reservationLeaseId: stringField(body.reservationLeaseId, "reservationLeaseId", {
      required: true, maxLength: 64,
    }),
    ...(body.recoveryLeaseId === undefined ? {} : {
      recoveryLeaseId: stringField(body.recoveryLeaseId, "recoveryLeaseId", { required: true, maxLength: 64 }),
    }),
    ...(body.deliveryTurnId === undefined ? {} : {
      deliveryTurnId: stringField(body.deliveryTurnId, "deliveryTurnId", { required: true, maxLength: 256 }),
    }),
  };
}

function parseAgentRunCheckpoint(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "agentThreadId", "summary", "nextAction", "status"]));
  const status = body.status ?? "active";
  if (!["active", "blocked"].includes(status)) {
    throw new ApiError(400, "INVALID_FIELD", "'status' must be active or blocked for a checkpoint");
  }
  return {
    version: parseVersion(body.version),
    agentThreadId: stringField(body.agentThreadId, "agentThreadId", { required: true, maxLength: 256 }),
    summary: stringField(body.summary, "summary", { required: true, maxLength: 10_000 }),
    nextAction: stringField(body.nextAction, "nextAction", { required: true, maxLength: 2_000 }),
    status,
  };
}

function parseAgentRunFinish(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "agentThreadId", "summary", "nextAction", "status"]));
  if (!["completed", "failed", "interrupted"].includes(body.status)) {
    throw new ApiError(400, "INVALID_FIELD", "'status' must be completed, failed, or interrupted for a finish");
  }
  return {
    version: parseVersion(body.version),
    agentThreadId: stringField(body.agentThreadId, "agentThreadId", { required: true, maxLength: 256 }),
    summary: stringField(body.summary, "summary", { required: true, maxLength: 10_000 }),
    nextAction: stringField(body.nextAction, "nextAction", { required: true, maxLength: 2_000 }),
    status: body.status,
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseRelationOrigin(value) {
  if (value === undefined) return undefined;
  if (value !== "manual" && value !== "mention") {
    throw new ApiError(400, "INVALID_FIELD", "'origin' must be manual or mention");
  }
  return value;
}

function parseRelationMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding", "origin"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    origin: parseRelationOrigin(body.origin),
  };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseInboxDelivery(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["deliveryId", "body", "threadId", "threadBinding"]));
  const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
  const threadBinding = parseThreadBinding(body.threadBinding);
  if (threadBinding && threadBinding.threadId !== threadId) {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.threadId must match threadId");
  }
  return {
    deliveryId: stringField(body.deliveryId, "deliveryId", { required: true, maxLength: 256 }),
    body: stringField(body.body, "body", { required: true, maxLength: 100_000 }),
    threadId,
    threadBinding,
  };
}

function parseOwnerIntent(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "intentId", "deliveryId", "kind", "goal", "constraints", "targetIntentId",
    "ownerRootTaskId", "ownerRootThreadId", "ownerTurnId", "rootCaptureTurnId", "evidence",
  ]));
  if (!["append", "supersede", "clarify", "cancel"].includes(body.kind)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'kind' must be append, supersede, clarify, or cancel",
    );
  }
  if (!Array.isArray(body.constraints) || body.constraints.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", "'constraints' must be an array of at most 32 strings");
  }
  const constraints = body.constraints.map((value, index) => stringField(
    value,
    `constraints[${index}]`,
    { required: true, maxLength: 2_000 },
  ));
  assertNoSensitiveCoordinationText([body.goal, body.evidence, ...constraints]);
  return {
    intentId: stringField(body.intentId, "intentId", { required: true, maxLength: 256 }),
    deliveryId: stringField(body.deliveryId, "deliveryId", { required: true, maxLength: 256 }),
    kind: body.kind,
    goal: stringField(body.goal, "goal", { required: true, maxLength: 20_000 }),
    constraints,
    targetIntentId: stringField(body.targetIntentId ?? null, "targetIntentId", {
      nullable: true,
      maxLength: 256,
    }),
    ownerRootTaskId: stringField(body.ownerRootTaskId, "ownerRootTaskId", {
      required: true,
      maxLength: 256,
    }),
    ownerRootThreadId: stringField(body.ownerRootThreadId, "ownerRootThreadId", {
      required: true,
      maxLength: 256,
    }),
    ownerTurnId: stringField(body.ownerTurnId, "ownerTurnId", { required: true, maxLength: 256 }),
    rootCaptureTurnId: stringField(body.rootCaptureTurnId, "rootCaptureTurnId", {
      required: true,
      maxLength: 256,
    }),
    evidence: stringField(body.evidence, "evidence", { required: true, maxLength: 2_000 }),
  };
}

function parseOwnerIntentAdoptionClaim(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "coordinatorTaskId", "coordinatorThreadId", "coordinatorEpoch",
  ]));
  return {
    coordinatorTaskId: stringField(body.coordinatorTaskId, "coordinatorTaskId", {
      required: true,
      maxLength: 256,
    }),
    coordinatorThreadId: stringField(body.coordinatorThreadId, "coordinatorThreadId", {
      required: true,
      maxLength: 256,
    }),
    coordinatorEpoch: stringField(body.coordinatorEpoch, "coordinatorEpoch", {
      required: true,
      maxLength: 512,
    }),
  };
}

function parseOwnerIntentAdoptionConfirmation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["adoptionId", "deliveryTurnId"]));
  return {
    adoptionId: stringField(body.adoptionId, "adoptionId", { required: true, maxLength: 256 }),
    deliveryTurnId: stringField(body.deliveryTurnId, "deliveryTurnId", {
      required: true,
      maxLength: 256,
    }),
  };
}

function parseOwnerIntentPlanRetry(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "adoptionId", "coordinatorEpoch", "failureKey",
  ]));
  return {
    adoptionId: stringField(body.adoptionId, "adoptionId", { required: true, maxLength: 256 }),
    coordinatorEpoch: stringField(body.coordinatorEpoch, "coordinatorEpoch", {
      required: true,
      maxLength: 512,
    }),
    failureKey: stringField(body.failureKey, "failureKey", { required: true, maxLength: 512 }),
  };
}

function parseOwnerIntentPlan(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "revisionId", "intentVersion", "adoptionId", "coordinatorTaskId",
    "coordinatorThreadId", "coordinatorEpoch", "classification", "summary",
    "parentTaskId", "items",
  ]));
  const classifications = new Set([
    "bounded_delivery", "new_product_scope", "financial_decision",
    "metric_policy", "missing_authority",
  ]);
  if (!classifications.has(body.classification)) {
    throw new ApiError(400, "INVALID_FIELD", "Invalid Owner Intent plan classification");
  }
  if (!Array.isArray(body.items) || body.items.length > 16) {
    throw new ApiError(400, "INVALID_FIELD", "'items' must be an array of at most 16 bounded Todos");
  }
  if (body.classification !== "bounded_delivery" && body.items.length > 0) {
    throw new ApiError(400, "DECISION_PLAN_MUST_NOT_EXECUTE", "A needs-decision plan cannot create executable Todos");
  }
  const outcomeKeys = new Set();
  const items = body.items.map((item, index) => {
    assertPlainObject(item);
    assertAllowedKeys(item, new Set([
      "outcomeKey", "title", "description", "priority", "blockedByOutcomeKeys",
    ]));
    const outcomeKey = stringField(item.outcomeKey, `items[${index}].outcomeKey`, {
      required: true,
      maxLength: 128,
    });
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(outcomeKey) || outcomeKeys.has(outcomeKey)) {
      throw new ApiError(400, "INVALID_FIELD", "Plan outcome keys must be unique bounded identifiers");
    }
    outcomeKeys.add(outcomeKey);
    if (!Array.isArray(item.blockedByOutcomeKeys) || item.blockedByOutcomeKeys.length > 16) {
      throw new ApiError(400, "INVALID_FIELD", "blockedByOutcomeKeys must be an array of at most 16 keys");
    }
    return {
      outcomeKey,
      title: stringField(item.title, `items[${index}].title`, { required: true, maxLength: 240 }),
      description: stringField(item.description ?? "", `items[${index}].description`, {
        maxLength: 20_000,
      }),
      priority: parsePriority(item.priority, "medium"),
      blockedByOutcomeKeys: item.blockedByOutcomeKeys.map((value, dependencyIndex) => stringField(
        value,
        `items[${index}].blockedByOutcomeKeys[${dependencyIndex}]`,
        { required: true, maxLength: 128 },
      )),
    };
  });
  for (const item of items) {
    if (item.blockedByOutcomeKeys.some((key) => !outcomeKeys.has(key) || key === item.outcomeKey)) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "Plan dependencies must reference another outcome in the same revision",
      );
    }
  }
  const dependencies = new Map(items.map((item) => [item.outcomeKey, item.blockedByOutcomeKeys]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if ([...dependencies.keys()].some(visit)) {
    throw new ApiError(400, "PLAN_DEPENDENCY_CYCLE", "Plan dependency graph must be acyclic");
  }
  assertNoSensitiveCoordinationText([
    body.summary,
    ...items.flatMap((item) => [item.title, item.description]),
  ]);
  if (!Number.isInteger(body.intentVersion) || body.intentVersion < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'intentVersion' must be a positive integer");
  }
  return {
    revisionId: stringField(body.revisionId, "revisionId", { required: true, maxLength: 256 }),
    intentVersion: body.intentVersion,
    adoptionId: stringField(body.adoptionId, "adoptionId", { required: true, maxLength: 256 }),
    coordinatorTaskId: stringField(body.coordinatorTaskId, "coordinatorTaskId", { required: true, maxLength: 256 }),
    coordinatorThreadId: stringField(body.coordinatorThreadId, "coordinatorThreadId", { required: true, maxLength: 256 }),
    coordinatorEpoch: stringField(body.coordinatorEpoch, "coordinatorEpoch", { required: true, maxLength: 512 }),
    classification: body.classification,
    summary: stringField(body.summary, "summary", { required: true, maxLength: 4_000 }),
    parentTaskId: stringField(body.parentTaskId ?? null, "parentTaskId", { nullable: true, maxLength: 256 }),
    items,
  };
}

function assertNoSensitiveCoordinationText(values) {
  const sensitive = /-----BEGIN [^-]+-----|\bAKIA[A-Z0-9]{16}\b|https?:\/\/[^\s/:@]+:[^\s/@]+@|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/i;
  if (values.some((value) => typeof value === "string" && sensitive.test(value))) {
    throw new ApiError(
      400,
      "SENSITIVE_COORDINATION_CONTENT",
      "Coordination envelopes may contain evidence references, but not credentials or secret values",
    );
  }
}

function parseCoordinationEnvelope(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "eventId", "idempotencyKey", "parentTaskId", "senderThreadId", "senderAgentPath",
    "eventType", "sequence", "timestamp", "summary", "evidenceRefs", "blocker",
    "nextAction", "requiresAck", "causationId", "correlationId",
  ]));
  if (body.eventType !== "handoff") {
    throw new ApiError(400, "INVALID_FIELD", "Phase 1 coordination eventType must be handoff");
  }
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'sequence' must be a positive integer");
  }
  const timestamp = stringField(body.timestamp, "timestamp", { required: true, maxLength: 64 });
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ApiError(400, "INVALID_FIELD", "'timestamp' must be an ISO timestamp");
  }
  if (!Array.isArray(body.evidenceRefs) || body.evidenceRefs.length > 32) {
    throw new ApiError(400, "INVALID_FIELD", "'evidenceRefs' must contain at most 32 references");
  }
  const evidenceRefs = body.evidenceRefs.map((reference) => (
    stringField(reference, "evidenceRefs", { required: true, maxLength: 2048 })
  ));
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'evidenceRefs' must be unique");
  }
  if (body.requiresAck !== true && body.requiresAck !== false) {
    throw new ApiError(400, "INVALID_FIELD", "'requiresAck' must be a boolean");
  }
  const senderAgentPath = stringField(body.senderAgentPath, "senderAgentPath", {
    required: true,
    maxLength: 240,
  });
  if (!senderAgentPath.startsWith("/root/")) {
    throw new ApiError(400, "INVALID_FIELD", "'senderAgentPath' must identify a Root Sub-Agent");
  }
  const envelope = {
    eventId: stringField(body.eventId, "eventId", { required: true, maxLength: 256 }),
    idempotencyKey: stringField(body.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    parentTaskId: stringField(body.parentTaskId, "parentTaskId", { nullable: true, maxLength: 128 }),
    senderThreadId: stringField(body.senderThreadId, "senderThreadId", { required: true, maxLength: 256 }),
    senderAgentPath,
    eventType: body.eventType,
    sequence: body.sequence,
    timestamp,
    summary: stringField(body.summary, "summary", { required: true, maxLength: 2_000 }),
    evidenceRefs,
    blocker: stringField(body.blocker, "blocker", { nullable: true, maxLength: 2_000 }),
    nextAction: stringField(body.nextAction, "nextAction", { required: true, maxLength: 2_000 }),
    requiresAck: body.requiresAck,
    causationId: stringField(body.causationId, "causationId", { nullable: true, maxLength: 256 }),
    correlationId: stringField(body.correlationId, "correlationId", { nullable: true, maxLength: 256 }),
  };
  assertNoSensitiveCoordinationText([
    envelope.summary,
    envelope.blocker,
    envelope.nextAction,
    ...envelope.evidenceRefs,
  ]);
  return envelope;
}

function parseCoordinationAcknowledgement(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["acknowledgementId", "senderThreadId", "senderAgentPath"]));
  const senderAgentPath = stringField(body.senderAgentPath, "senderAgentPath", {
    required: true,
    maxLength: 240,
  });
  if (senderAgentPath !== "/root") {
    throw new ApiError(400, "INVALID_FIELD", "'senderAgentPath' must identify the task Root");
  }
  return {
    acknowledgementId: stringField(body.acknowledgementId, "acknowledgementId", {
      required: true,
      maxLength: 256,
    }),
    senderThreadId: stringField(body.senderThreadId, "senderThreadId", {
      required: true,
      maxLength: 256,
    }),
    senderAgentPath,
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  const kind = request.headers["x-taskboard-attachment-kind"];
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Taskboard-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  if (body.contractVersion !== undefined) return parseComposerTurn(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

function parseComposerCandidateQuery(searchParams) {
  assertAllowedQuery(
    searchParams,
    new Set(["projectId", "threadId", "trigger", "query", "surface"]),
    "GET /api/local/ai/composer/candidates",
  );
  let projectId;
  const rawProjectId = searchParams.get("projectId");
  if (rawProjectId !== null) {
    try {
      projectId = validateProjectId(rawProjectId);
    } catch {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project id is invalid");
    }
  }
  const trigger = searchParams.get("trigger");
  if (trigger !== "/" && trigger !== "@") {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer trigger must be '/' or '@'");
  }
  const query = searchParams.get("query") ?? "";
  if (query.length > 256) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer query cannot exceed 256 characters");
  }
  let threadId;
  try {
    threadId = parseThreadId(searchParams.get("threadId") ?? undefined);
  } catch {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread id is invalid");
  }
  const surface = searchParams.get("surface") ?? "ai-chat";
  if (!new Set(["ai-chat", "issue-description", "comment"]).has(surface)) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer surface is invalid");
  }
  return { projectId, threadId, trigger, query, surface };
}

function invalidComposerRebindRequest(message) {
  return new ApiError(400, "INVALID_COMPOSER_REBIND_REQUEST", message);
}

function assertComposerRebindKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidComposerRebindRequest(`'${field}.${key}' is not allowed`);
    }
  }
}

function parseComposerRebindRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidComposerRebindRequest("Composer rebind body must be an object");
  }
  assertComposerRebindKeys(
    value,
    new Set(["contractVersion", "projectId", "threadId", "document"]),
    "body",
  );
  if (value.contractVersion !== "composer.v1") {
    throw invalidComposerRebindRequest("'contractVersion' must be 'composer.v1'");
  }
  let projectId;
  try {
    projectId = validateProjectId(value.projectId);
  } catch {
    throw invalidComposerRebindRequest("'projectId' is invalid");
  }
  let threadId;
  try {
    threadId = parseThreadId(value.threadId);
  } catch {
    throw invalidComposerRebindRequest("'threadId' is invalid");
  }
  const document = value.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidComposerRebindRequest("'document' must be an object");
  }
  assertComposerRebindKeys(document, new Set(["version", "nodes"]), "document");
  if (document.version !== 1) {
    throw invalidComposerRebindRequest("'document.version' must be 1");
  }
  if (!Array.isArray(document.nodes) || document.nodes.length > 200) {
    throw invalidComposerRebindRequest("'document.nodes' must contain at most 200 entries");
  }
  let textLength = 0;
  const nodes = document.nodes.map((node, nodeIndex) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}]' must be an object`);
    }
    if (node.type === "text") {
      assertComposerRebindKeys(node, new Set(["type", "text"]), `document.nodes[${nodeIndex}]`);
      if (typeof node.text !== "string") {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].text' must be a string`);
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "unsupportedReference") {
      assertComposerRebindKeys(
        node,
        new Set(["type", "referenceUri", "label"]),
        `document.nodes[${nodeIndex}]`,
      );
      if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
      }
      if (typeof node.referenceUri !== "string" || node.referenceUri.length > 1_024) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is invalid`,
        );
      }
      const match = /^taskboard:\/\/composer-reference\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        node.referenceUri,
      );
      if (!match) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is not a composer reference marker`,
        );
      }
      try {
        decodeComposerReferenceKey(match[3]);
      } catch {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' has an invalid reference key`,
        );
      }
      const reasonCode = match[1] !== "v1"
        ? "REFERENCE_FORMAT_UNSUPPORTED"
        : !new Set(["skill", "agent"]).has(match[2])
          ? "REFERENCE_KIND_UNSUPPORTED"
          : null;
      if (!reasonCode) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}]' must use persistedReference for supported markers`,
        );
      }
      return {
        type: "unsupportedReference",
        referenceUri: node.referenceUri,
        label: node.label,
        reasonCode,
      };
    }
    if (node.type !== "persistedReference") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].type' must be text, persistedReference or unsupportedReference`,
      );
    }
    assertComposerRebindKeys(
      node,
      new Set(["type", "referenceKind", "referenceKey", "label"]),
      `document.nodes[${nodeIndex}]`,
    );
    if (node.referenceKind !== "skill" && node.referenceKind !== "agent") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKind' must be skill or agent`,
      );
    }
    if (
      typeof node.referenceKey !== "string"
      || node.referenceKey.length === 0
      || node.referenceKey.length > 512
    ) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is invalid`,
      );
    }
    if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
    }
    let stableId;
    try {
      stableId = decodeComposerReferenceKey(node.referenceKey);
    } catch {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is not canonical base64url`,
      );
    }
    if (node.referenceKind === "skill" && stableId !== stableId.normalize("NFC")) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' does not contain an NFC Skill name`,
      );
    }
    return {
      type: "persistedReference",
      referenceKind: node.referenceKind,
      referenceKey: node.referenceKey,
      label: node.label,
      stableId,
    };
  });
  if (textLength > 100_000) {
    throw invalidComposerRebindRequest("Composer text cannot exceed 100000 characters");
  }
  return {
    contractVersion: "composer.v1",
    projectId,
    threadId,
    document: { version: 1, nodes },
  };
}

async function resolveComposerRebindWorkspace(aiChat, input) {
  let thread;
  if (input.threadId !== undefined) {
    try {
      thread = aiChat.getThread(input.threadId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread does not exist");
      }
      throw error;
    }
    if (thread.origin.projectId !== input.projectId) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread does not belong to the selected project",
      );
    }
    try {
      if (!(await stat(thread.origin.workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_UNAVAILABLE",
        "The conversation workspace is not available on this device",
      );
    }
    return thread.origin.workspacePath;
  }
  let resolved;
  try {
    resolved = await aiChat.resolveContext(input.projectId, thread?.origin.issueId);
  } catch (error) {
    if (
      error instanceof ApiError
      && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)
    ) {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
    }
    throw error;
  }
  return resolved.workspacePath;
}

function parseComposerDocument(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "nodes"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_COMPOSER_DOCUMENT", "'document.version' must be 1");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > 200) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'document.nodes' must be an array with at most 200 entries",
    );
  }
  let textLength = 0;
  const nodes = value.nodes.map((node, index) => {
    assertPlainObject(node);
    if (typeof node.type !== "string" || !node.type) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        `'document.nodes[${index}].type' is required`,
      );
    }
    if (node.type === "text") {
      assertAllowedKeys(node, new Set(["type", "text"]));
      if (typeof node.text !== "string") {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_DOCUMENT",
          `'document.nodes[${index}].text' must be a string`,
        );
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "skill" || node.type === "agent") {
      assertAllowedKeys(node, new Set(["type", "candidateRef", "label"]));
      return {
        type: node.type,
        candidateRef: stringField(
          node.candidateRef,
          `document.nodes[${index}].candidateRef`,
          { required: true, maxLength: 512 },
        ),
        label: stringField(node.label, `document.nodes[${index}].label`, {
          required: true,
          maxLength: 256,
        }),
      };
    }
    return { type: node.type };
  });
  if (textLength > 100_000) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "Composer text cannot exceed 100000 characters",
    );
  }
  return { version: 1, nodes };
}

function parseComposerTurn(body) {
  assertAllowedKeys(body, new Set([
    "contractVersion",
    "revision",
    "document",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (body.contractVersion !== "composer.v1") {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'contractVersion' must be 'composer.v1'",
    );
  }
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  return {
    contractVersion: "composer.v1",
    revision: stringField(body.revision, "revision", { required: true, maxLength: 512 }),
    document: parseComposerDocument(body.document),
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments: parseAiAttachments(body.attachments),
  };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

async function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      if (line.startsWith("prunable")) prunable = true;
    }
    if (!worktreePath || prunable) continue;
    try {
      await stat(worktreePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath, processEnv = process.env) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      env: environment,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...(await parseWorktrees(worktreesResult.stdout)),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

export function resolveServerOptions(options = {}) {
  const configuredDataDirectory = options.dataDirectory ?? process.env.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const instanceToken = String(
    options.instanceToken ?? process.env.CODEX_TASKBOARD_INSTANCE_TOKEN ?? "",
  ).trim();
  if (instanceToken && !/^[a-z0-9-]{16,128}$/i.test(instanceToken)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_TOKEN must be an identifier");
  }
  const instanceSecret = String(
    options.instanceSecret ?? process.env.CODEX_TASKBOARD_INSTANCE_SECRET ?? "",
  ).trim();
  if (instanceToken && !/^[a-f0-9-]{32,128}$/i.test(instanceSecret)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_SECRET must be set in launcher mode");
  }
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    jiraConfigPath: options.jiraConfigPath ?? path.join(dataDirectory, "jira-connection.json"),
    clientStoragePath: options.clientStoragePath ?? path.join(dataDirectory, "client-storage.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath
      ?? process.env.CODEX_TASKBOARD_SKILL_PATH
      ?? path.join(PROJECT_ROOT, "skills", "manage-taskboard", "SKILL.md"),
    codexExecutable: resolveCodexExecutable({ explicit: options.codexExecutable }),
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    instanceToken,
    instanceSecret,
    version: String(
      options.version ?? process.env.CODEX_TASKBOARD_VERSION ?? "development",
    ).trim(),
    codexSessionsDirectory: options.codexSessionsDirectory
      ?? path.join(codexHome, "sessions"),
    agentLaneConfigPath: options.agentLaneConfigPath
      ?? process.env.CODEX_TASKBOARD_AGENT_LANE_CONFIG_PATH
      ?? path.join(dataDirectory, "agent-lanes.json"),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "127.0.0.1") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const codexProcessEnvironment = withoutTaskboardLauncherEnvironment(
    options.processEnv ?? process.env,
  );
  const openCodexThread = options.openCodexThread ?? (async (threadId) => {
    const deepLink = `codex://threads/${encodeURIComponent(threadId)}`;
    const command = process.platform === "darwin"
      ? { executable: "/usr/bin/open", args: [deepLink] }
      : process.platform === "win32"
        ? { executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", deepLink] }
        : { executable: "xdg-open", args: [deepLink] };
    await execFileAsync(command.executable, command.args, {
      env: codexProcessEnvironment,
      timeout: 10_000,
      windowsHide: true,
    });
  });
  const routePrefix = resolved.instanceToken ? `/${resolved.instanceToken}` : "";
  const database = new TaskboardDatabase(resolved.databasePath, {
    admissionTtlMs: options.admissionTtlMs,
  });
  const worktreeRepositoryExecFile = options.worktreeRepositoryExecFile ?? execFileAsync;
  const worktreeRepositoryTtlMs = options.worktreeRepositoryTtlMs ?? WORKTREE_REPOSITORY_TTL_MS;
  const worktreeRepositoryCache = new Map();
  const worktreeRepositoryInFlight = new Map();
  const worktreeRealpathInFlight = new Map();
  const events = new EventHub();
  const panelPresence = options.panelPresence ?? createTaskboardPanelPresence();
  const coordinatorRenewNonces = new Map();
  let clientStorageWrite = Promise.resolve();

  async function refreshTaskWorktreeRepository(taskId, { force = false } = {}) {
    const task = database.getTask(taskId);
    if (!task || task.developmentContext?.type !== "worktree") return task;
    const worktreePath = task.developmentContext.path;
    const expectedBranch = task.developmentContext.branch;
    let resolvedPath = null;
    try {
      const realpathKey = `${path.resolve(worktreePath)}\0${expectedBranch}`;
      let pendingRealpath = worktreeRealpathInFlight.get(realpathKey);
      if (!pendingRealpath) {
        pendingRealpath = realpath(worktreePath);
        worktreeRealpathInFlight.set(realpathKey, pendingRealpath);
      }
      try {
        resolvedPath = await pendingRealpath;
      } finally {
        if (worktreeRealpathInFlight.get(realpathKey) === pendingRealpath) {
          worktreeRealpathInFlight.delete(realpathKey);
        }
      }
    } catch {
      resolvedPath = null;
    }
    let resolution = null;
    if (resolvedPath) {
      const cacheKey = `${resolvedPath}\0${expectedBranch}`;
      const activeResolution = worktreeRepositoryInFlight.get(cacheKey);
      if (activeResolution) {
        resolution = await activeResolution;
      } else {
        const cached = worktreeRepositoryCache.get(cacheKey);
        if (!force && cached && Date.now() - cached.cachedAt < worktreeRepositoryTtlMs) {
          resolution = cached;
        } else {
          const pendingResolution = (async () => {
            let repository = null;
            let cacheable = false;
            try {
              const [topLevelResult, remoteResult, branchResult] = await Promise.all([
                worktreeRepositoryExecFile(
                  "git",
                  ["-C", resolvedPath, "rev-parse", "--show-toplevel"],
                  { env: codexProcessEnvironment, timeout: 5_000, windowsHide: true },
                ),
                worktreeRepositoryExecFile(
                  "git",
                  ["-C", resolvedPath, "remote", "get-url", "origin"],
                  { env: codexProcessEnvironment, timeout: 5_000, windowsHide: true },
                ),
                worktreeRepositoryExecFile(
                  "git",
                  ["-C", resolvedPath, "branch", "--show-current"],
                  { env: codexProcessEnvironment, timeout: 5_000, windowsHide: true },
                ),
              ]);
              const resolvedTopLevel = await realpath(topLevelResult.stdout.trim());
              const actualBranch = branchResult.stdout.trim();
              if (resolvedTopLevel === resolvedPath
                && actualBranch
                && actualBranch === expectedBranch) {
                repository = normalizeRepository(remoteResult.stdout.trim());
              }
              cacheable = true;
            } catch {
              repository = null;
            }
            return {
              repository,
              verifiedAt: new Date().toISOString(),
              cachedAt: Date.now(),
              cacheable,
            };
          })();
          worktreeRepositoryInFlight.set(cacheKey, pendingResolution);
          try {
            resolution = await pendingResolution;
            if (resolution.cacheable) worktreeRepositoryCache.set(cacheKey, resolution);
            else worktreeRepositoryCache.delete(cacheKey);
          } finally {
            if (worktreeRepositoryInFlight.get(cacheKey) === pendingResolution) {
              worktreeRepositoryInFlight.delete(cacheKey);
            }
          }
        }
      }
    }
    const repository = resolution?.repository ?? null;
    const verifiedAt = resolution?.verifiedAt ?? new Date().toISOString();
    const updated = database.recordTaskWorktreeRepository(task.id, {
      worktreePath,
      expectedBranch,
      repository,
      verifiedAt,
    });
    return updated;
  }

  async function verifiedTaskCapsule(taskId, options) {
    const current = database.getTaskCapsule(taskId);
    if (!options?.force) {
      const envelope = current?.authorization?.state === "valid"
        ? current.authorization.envelope
        : null;
      const approvalKinds = new Map((envelope?.gates ?? []).map((gate) => [gate.id, gate]));
      const hasStandingCandidate = envelope?.useStandingAuthority === true
        && envelope.actions.some((action) => {
          const gate = approvalKinds.get(action.gate);
          return action.status === "pending"
            && gate?.state === "approval_required"
            && STANDING_AUTHORITY_ACTION_SET.has(gate.kind);
        });
      const repository = hasStandingCandidate ? normalizeRepository(envelope.repository) : null;
      const timestamp = Date.now();
      const hasActivePolicy = repository !== null
        && database.listProjectStandingAuthorities(current.task.projectId).some((authority) => (
          authority.repository === repository
          && authority.revokedAt === null
          && Date.parse(authority.grantedAt) <= timestamp
          && (authority.expiresAt === null || Date.parse(authority.expiresAt) > timestamp)
        ));
      // Projection only needs repository discovery while an active policy could
      // unlock pending work. Execution endpoints still force a fresh probe.
      if (!hasActivePolicy || current.standingAuthority.state === "matched") return current;
    }
    await refreshTaskWorktreeRepository(taskId, options);
    return database.getTaskCapsule(taskId);
  }

  function assertInsideWorktree(worktreePath, targetPath, message) {
    const relative = path.relative(worktreePath, targetPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ApiError(409, "STANDING_SCOPE_MISMATCH", message);
    }
  }

  async function nearestExistingParent(targetPath, worktreePath) {
    let candidate = path.dirname(targetPath);
    while (true) {
      try {
        const candidateStat = await lstat(candidate);
        if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
          throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "New edit targets require one real directory parent");
        }
        const resolvedParent = await realpath(candidate);
        if (resolvedParent === worktreePath) return resolvedParent;
        assertInsideWorktree(worktreePath, resolvedParent, "New edit target parent must stay inside the exact worktree");
        return resolvedParent;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "New edit target has no existing worktree parent");
      }
      candidate = parent;
    }
  }

  async function assertStandingActionExecutionScope(taskId, safeActionId) {
    const task = database.getTask(taskId);
    const capsule = database.getTaskCapsule(taskId);
    const action = capsule?.readyWork.safeActions.find((candidate) => candidate.id === safeActionId);
    if (!action?.standingAuthority) return;
    const worktreePath = await realpath(task.developmentContext.path);
    if (action.standingScope.kind === "edit") {
      for (const relativePath of action.standingScope.paths) {
        const targetPath = path.resolve(worktreePath, relativePath);
        assertInsideWorktree(worktreePath, targetPath, "Edit target must stay inside the exact worktree");
        try {
          const targetStat = await lstat(targetPath);
          if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
            throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "Existing edit target must be one real worktree file");
          }
          const resolvedTarget = await realpath(targetPath);
          assertInsideWorktree(worktreePath, resolvedTarget, "Edit target must resolve inside the exact worktree");
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (error.code !== "ENOENT") throw error;
          await nearestExistingParent(targetPath, worktreePath);
        }
      }
      return;
    }
    if (action.standingScope.kind !== "scoped_delete") return;
    for (const relativePath of action.standingScope.paths) {
      let resolvedTarget;
      let targetStat;
      try {
        const targetPath = path.resolve(worktreePath, relativePath);
        const linkStat = await lstat(targetPath);
        if (linkStat.isSymbolicLink()) {
          throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "Scoped delete target cannot be a symbolic link");
        }
        resolvedTarget = await realpath(targetPath);
        targetStat = await stat(resolvedTarget);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "Scoped delete target must be one existing worktree file");
      }
      assertInsideWorktree(worktreePath, resolvedTarget, "Scoped delete target must resolve to a file inside the exact worktree");
      if (!targetStat.isFile()) {
        throw new ApiError(409, "STANDING_SCOPE_MISMATCH", "Scoped delete target must resolve to a file inside the exact worktree");
      }
    }
  }

  async function readClientStorage() {
    try {
      const value = JSON.parse(await readFile(resolved.clientStoragePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function updateClientStorage(body) {
    assertPlainObject(body);
    assertAllowedKeys(body, new Set(["key", "value"]));
    const key = stringField(body.key, "key", { required: true, maxLength: 512 });
    const value = stringField(body.value, "value", { nullable: true, maxLength: 100_000 });
    clientStorageWrite = clientStorageWrite.catch(() => {}).then(async () => {
      const entries = await readClientStorage();
      if (value === null) delete entries[key];
      else entries[key] = value;
      await mkdir(path.dirname(resolved.clientStoragePath), { recursive: true });
      const temporaryPath = `${resolved.clientStoragePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, resolved.clientStoragePath);
      await chmod(resolved.clientStoragePath, 0o600);
    });
    await clientStorageWrite;
  }
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const jiraConfig = options.jiraConfigStore ?? createJiraConfigStore({
    configPath: resolved.jiraConfigPath,
  });
  const jira = createJiraIntegration({
    configStore: jiraConfig,
    database,
    fetch: options.jiraFetch ?? globalThis.fetch,
  });
  let hostRuntime = null;
  const observedHostRuntimes = new Map();
  function currentHostThreadBinding(threadId) {
    if (
      !hostRuntime
      || hostRuntime.threadId !== threadId
      || !hostRuntime.codexProjectId
      || !hostRuntime.codexProjectKind
      || !hostRuntime.codexHostId
      || !hostRuntime.workspacePath
    ) return undefined;
    return {
      threadId,
      codexProjectId: hostRuntime.codexProjectId,
      codexProjectKind: hostRuntime.codexProjectKind,
      codexHostId: hostRuntime.codexHostId,
      workspacePath: hostRuntime.workspacePath,
    };
  }
  function currentHostThreadIdentity(threadId) {
    if (
      hostRuntime
      && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
      && hostRuntime.threadId === threadId
      && hostRuntime.codexProjectId
      && hostRuntime.codexProjectKind
      && hostRuntime.codexHostId
      && hostRuntime.workspacePath
    ) {
      return {
        threadId,
        codexProjectId: hostRuntime.codexProjectId,
        codexProjectKind: hostRuntime.codexProjectKind,
        codexHostId: hostRuntime.codexHostId,
        workspacePath: hostRuntime.workspacePath,
      };
    }
    return null;
  }
  function observedHostThreadIdentity(threadId) {
    const identity = observedHostRuntimes.get(threadId) ?? null;
    return identity && Date.now() - identity.updatedAt <= HOST_RUNTIME_TTL_MS
      ? identity
      : null;
  }
  function assertCurrentCoordinatorHostBinding(projectId, input, errorCode = "COORDINATOR_BINDING_MISMATCH") {
    const identity = observedHostThreadIdentity(input.holderThreadId);
    if (!identity) return;
    const config = database.getAgentLaneProject(projectId);
    const holder = Array.isArray(config?.tasks)
      ? config.tasks.find((task) => task?.id === input.holderTaskId) ?? null
      : null;
    const mismatch = !holder
      || holder.threadId !== identity.threadId
      || !path.isAbsolute(holder.workspacePath ?? "")
      || !path.isAbsolute(identity.workspacePath)
      || holder.codexHostId !== identity.codexHostId
      || path.resolve(holder.workspacePath ?? "") !== path.resolve(identity.workspacePath)
      || (holder.codexProjectId && holder.codexProjectId !== identity.codexProjectId)
      || (holder.codexProjectKind && holder.codexProjectKind !== identity.codexProjectKind)
      || (input.holderCodexHostId && input.holderCodexHostId !== identity.codexHostId)
      || (input.holderWorkspacePath
        && path.resolve(input.holderWorkspacePath) !== path.resolve(identity.workspacePath));
    if (mismatch) {
      throw new ApiError(
        409,
        errorCode,
        "Coordinator lease holder does not match the current protected host identity",
      );
    }
  }
  function resolveInputThreadBinding(input) {
    if (input.threadBinding !== undefined) return input;
    const threadBinding = currentHostThreadBinding(input.threadId);
    return threadBinding ? { ...input, threadBinding } : input;
  }
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveThreadBinding: currentHostThreadBinding,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath, codexProcessEnvironment);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
    assertTaskProjectMoveAllowed: (taskId, targetProjectId) => {
      if (!database.hasAiChatThreadProjectConflict(taskId, targetProjectId)) return;
      throw new CloudProxyError(
        409,
        "AI_CHAT_PROJECT_MOVE_BLOCKED",
        "Delete issue-linked AI conversations before moving the issue to another project",
      );
    },
  });
  async function readCloudJson(pathname) {
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    }));
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(
        upstream.ok ? 502 : upstream.status,
        "INVALID_CLOUD_RESPONSE",
        "Cloud taskboard returned an invalid JSON response",
      );
    }
    if (!upstream.ok) {
      throw new ApiError(
        upstream.status,
        payload?.error?.code ?? "CLOUD_REQUEST_FAILED",
        payload?.error?.message ?? "Cloud taskboard request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  async function resolveAiChatContext(projectId, issueId) {
    const config = await cloudConfig.read();
    if (!config.remoteUrl) {
      let resolvedWorkspace;
      try {
        resolvedWorkspace = await resolveAiWorkspace(
          projectId,
          resolved.codexStatePath,
          database,
        );
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "PROJECT_WORKSPACE_UNAVAILABLE"
          || projectId !== DEFAULT_PROJECT_ID
        ) {
          throw error;
        }
        resolvedWorkspace = {
          workspacePath: PROJECT_ROOT,
          addDirectories: [],
          project: database.getProject(projectId),
        };
      }
      let issue;
      if (issueId !== undefined) {
        issue = database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolvedWorkspace, issue };
    }

    const projectPayload = await readCloudJson("/api/projects");
    const project = Array.isArray(projectPayload.projects)
      ? projectPayload.projects.find((candidate) => candidate?.id === projectId)
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    let issue;
    if (issueId !== undefined) {
      const issuePayload = await readCloudJson(`/api/tasks/${encodeURIComponent(issueId)}`);
      issue = issuePayload.task;
      if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
    }

    const resolvedWorkspace = await resolveMappedAiWorkspace(
      projectId,
      project,
      config.projectMappings,
    );
    return { ...resolvedWorkspace, issue };
  }

  const aiChat = new AiChatService({
    database,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    manageTaskboardSkillPath: resolved.skillPath,
    processEnv: codexProcessEnvironment,
    resolveContext: resolveAiChatContext,
  });
  const projectSummary = new ProjectSummaryService({
    database,
    codexExecutable: resolved.codexExecutable,
    processEnv: codexProcessEnvironment,
    workspacePath: PROJECT_ROOT,
  });
  const agentLanes = createAgentLaneSnapshotProvider({
    sessionsDirectory: resolved.codexSessionsDirectory,
    getLaneConfig: (projectId) => database.getAgentLaneProject(projectId),
    listTasks: (projectId) => database.listTasks({ projectId, archived: "false" }),
    getClaim: (taskId) => database.getAgentTaskClaim(taskId),
    getAdmission: (taskId) => database.getTaskSafeActionAdmission(taskId),
    getTaskCapsule: (taskId) => verifiedTaskCapsule(taskId),
    getTaskDomainAssignment: (taskId) => database.getAgentTaskDomainAssignment(taskId),
    getTask: (identifier) => database.getTask(identifier),
    listComments: (taskId) => database.listComments(taskId),
    getPendingOwnerIntent: (projectId) => database.getPendingProjectOwnerIntent(projectId),
    getPendingOwnerIntentPlan: (projectId) => database.getPendingProjectOwnerIntentPlan(projectId),
    getCoordinatorDurableWork: (projectId) => database.hasAgentLaneCoordinatorDurableWork(projectId),
    getCoordinatorDurableWorkReason: (projectId) => (
      database.getAgentLaneCoordinatorDurableWorkReason(projectId)
    ),
    getCoordinatorShutdownAttempt: (projectId) => database.getAgentLaneCoordinatorShutdownAttempt(projectId),
    getCurrentHostIdentity: (threadId) => observedHostThreadIdentity(threadId),
    recordProgress: async (progress) => {
      const candidates = database.listTasks({ projectId: progress.projectId, archived: "false" }).filter((task) => {
        const claim = database.getAgentTaskClaim(task.id);
        return claim?.status === "active"
          && claim.projectId === progress.projectId
          && claim.agentThreadId === progress.agentThreadId
          && claim.agentPath === progress.agentPath;
      });
      if (candidates.length !== 1) return { applied: false, reason: "claim_not_unique" };
      const result = database.recordAgentTaskProgress(candidates[0].id, {
        ...progress,
        actor: CODEX_AGENT_ACTOR,
      });
      if (result.applied) events.emit("comment.created", result);
      return result;
    },
    recordCompletion: async (completion) => {
      const candidates = database.listTasks({ projectId: completion.projectId, archived: "false" }).filter((task) => {
        const claim = database.getAgentTaskClaim(task.id);
        return claim?.status === "active"
          && claim.projectId === completion.projectId
          && claim.agentThreadId === completion.agentThreadId
          && claim.agentPath === completion.agentPath;
      });
      if (candidates.length !== 1) return { applied: false, reason: "claim_not_unique" };
      const result = database.completeAgentTask(candidates[0].id, {
        ...completion,
        actor: CODEX_AGENT_ACTOR,
      });
      if (result.applied) {
        events.emit("comment.created", result);
        events.emit("task.moved", { task: result.task });
      }
      return result;
    },
  });
  let agentLaneTimer = null;
  let agentLaneReconcile = null;
  const reconcileAgentLanes = async () => {
    if (agentLaneReconcile) return agentLaneReconcile;
    agentLaneReconcile = (async () => {
      for (const projectId of database.listAgentLaneProjectIds()) {
        await agentLanes.reconcileProject(projectId);
      }
    })().finally(() => { agentLaneReconcile = null; });
    return agentLaneReconcile;
  };
  const aiEventResponses = new Set();
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (
        resolved.instanceToken
        && incomingUrl.pathname === "/"
        && (request.method === "GET" || request.method === "HEAD")
      ) {
        assertTrustedNetworkRequest(request, true);
        sendLauncherBoundaryPage(response, request.method);
        return;
      }
      if (resolved.instanceToken && incomingUrl.pathname !== "/health") {
        if (incomingUrl.pathname === routePrefix) {
          response.writeHead(301, { location: `${incomingUrl.pathname}/${incomingUrl.search}` });
          response.end();
          return;
        }
        if (
          incomingUrl.pathname !== routePrefix
          && !incomingUrl.pathname.startsWith(`${routePrefix}/`)
        ) {
          throw new ApiError(404, "NOT_FOUND", "Route not found");
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }

      assertTrustedNetworkRequest(request, Boolean(resolved.instanceToken));
      const origin = request.headers.origin;
      const trustedEmbedOrigin = TRUSTED_EMBED_ORIGINS.has(origin)
        || (Boolean(resolved.instanceToken) && origin === "null");
      if (trustedEmbedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          request.headers["access-control-request-headers"] ?? "content-type",
        );
        response.setHeader("access-control-expose-headers", "x-codex-taskboard-proof");
        response.setHeader("access-control-allow-private-network", "true");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (resolved.instanceToken && origin === "app://-") {
        const challenge = request.headers["x-codex-taskboard-challenge"];
        if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
          throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
        }
        response.setHeader(
          "x-codex-taskboard-proof",
          createHmac("sha256", resolved.instanceSecret).update(challenge).digest("hex"),
        );
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (resolved.instanceToken) {
          const challenge = request.headers["x-codex-taskboard-challenge"];
          if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
            throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
          }
          return sendJson(response, 200, {
            status: "ok",
            product: "codex-taskboard",
            version: resolved.version,
            proof: createHmac("sha256", resolved.instanceSecret)
              .update(challenge)
              .digest("hex"),
          });
        }
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/client-storage") {
        if (request.method === "GET") {
          await clientStorageWrite;
          return sendJson(response, 200, { entries: await readClientStorage() });
        }
        if (request.method === "PATCH") {
          await updateClientStorage(await readJson(request));
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      if (pathname === "/api/local/coordinator-monitor-projects") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/coordinator-monitor-projects");
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, null, coordinatorRenewNonces,
        );
        return sendJson(response, 200, {
          projectIds: database.listAgentLaneProjectIds().filter((projectId) => {
            const config = database.getAgentLaneProject(projectId);
            return Boolean(config?.coordinatorLease)
              || Object.keys(config?.domainCoordinatorLeases ?? {}).length > 0;
          }),
        });
      }

      if (pathname === "/api/local/taskboard-panel-presence") {
        if (request.method === "GET") {
          return sendJson(response, 200, { live: panelPresence.hasLivePanel() });
        }
        if (request.method === "PUT" || request.method === "DELETE") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["panelId"]));
          const panelId = stringField(body.panelId, "panelId", {
            required: true,
            maxLength: 80,
          });
          if (!/^[a-z0-9-]{8,80}$/i.test(panelId)) {
            throw new ApiError(400, "INVALID_FIELD", "'panelId' must be a bounded identifier");
          }
          if (request.method === "PUT") panelPresence.touch(panelId);
          else panelPresence.remove(panelId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(url.searchParams.getAll("threadId").map((value) => (
          value.trim().replace(/^(?:local|cloud):/i, "")
        )))];
        if (threadIds.length > 64 || threadIds.some((threadId) => (
          !CODEX_THREAD_ID_PATTERN.test(threadId)
        ))) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      const codexThreadOpenMatch = pathname.match(/^\/api\/local\/codex-threads\/([^/]+)\/open$/);
      if (codexThreadOpenMatch) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "Codex thread open routes");
        await assertEmptyRequestBody(request, "Codex thread open routes");
        const threadId = decodeURIComponent(codexThreadOpenMatch[1]);
        if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must be a valid Codex thread ID");
        }
        try {
          await openCodexThread(threadId);
        } catch {
          throw new ApiError(503, "CODEX_OPEN_FAILED", "Could not open the Codex conversation");
        }
        return sendJson(response, 200, { opened: true });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          assertInjectorProof(request, resolved.instanceSecret);
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
          ]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            codexProjectId: stringField(body.codexProjectId ?? null, "codexProjectId", {
              nullable: true,
              maxLength: 256,
            }),
            codexProjectKind: body.codexProjectKind === "local" || body.codexProjectKind === "remote"
              ? body.codexProjectKind
              : null,
            codexHostId: stringField(body.codexHostId ?? null, "codexHostId", {
              nullable: true,
              maxLength: 256,
            }),
            workspacePath: stringField(body.workspacePath ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
            updatedAt: Date.now(),
          };
          observedHostRuntimes.delete(threadId);
          observedHostRuntimes.set(threadId, { ...hostRuntime });
          if (observedHostRuntimes.size > 512) {
            observedHostRuntimes.delete(observedHostRuntimes.keys().next().value);
          }
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/agent-lane-projects") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/agent-lane-projects");
        return sendJson(response, 200, { projectIds: database.listAgentLaneProjectIds() });
      }

      if (pathname === "/api/local/activation-readiness") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/activation-readiness");
        return sendJson(response, 200, database.getActivationReadiness());
      }

      const activationWorkflowProfileRoute = pathname.match(
        /^\/api\/local\/activation-readiness\/workflow-profiles\/([^/]+)$/,
      );
      if (activationWorkflowProfileRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/activation-readiness/workflow-profiles/:id");
        if (request.headers["x-taskboard-client"] !== "taskctl") {
          throw new ApiError(
            403,
            "TASKCTL_REQUIRED",
            "Activation workflow profile migration is available only through protected taskctl",
          );
        }
        const taskId = decodeRouteSegment(activationWorkflowProfileRoute[1], "Task id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["version"]));
        const result = database.applyActivationWorkflowProfile(
          taskId,
          parseVersion(body.version),
          actorFromRequest(request),
        );
        if (result.applied) events.emit("task.updated", { task: result.task });
        return sendJson(response, 200, result);
      }

      const coordinatorProvisioningLookupRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-provisioning-attempts\/lookup$/,
      );
      if (coordinatorProvisioningLookupRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-provisioning-attempts/lookup");
        const projectId = decodeRouteSegment(coordinatorProvisioningLookupRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const idempotencyKey = parseCoordinatorProvisioningLookup(body);
        return sendJson(response, 200, {
          attempt: database.getAgentLaneCoordinatorProvisioningAttempt(projectId, idempotencyKey),
        });
      }

      const coordinatorProvisioningPreflightRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-provisioning-preflight$/,
      );
      if (coordinatorProvisioningPreflightRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/coordinator-provisioning-preflight");
        const projectId = decodeRouteSegment(coordinatorProvisioningPreflightRoute[1], "Project id");
        validateProjectId(projectId);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, null, coordinatorRenewNonces,
        );
        return sendJson(
          response,
          200,
          database.getAgentLaneCoordinatorProvisioningPreflight(projectId),
        );
      }

      const coordinatorShutdownLookupRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-shutdown-attempts\/lookup$/,
      );
      if (coordinatorShutdownLookupRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-shutdown-attempts/lookup");
        const projectId = decodeRouteSegment(coordinatorShutdownLookupRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set());
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        return sendJson(response, 200, {
          attempt: database.getAgentLaneCoordinatorShutdownAttempt(projectId),
        });
      }

      const coordinatorShutdownRequestRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-shutdown-attempts$/,
      );
      if (coordinatorShutdownRequestRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-shutdown-attempts");
        const projectId = decodeRouteSegment(coordinatorShutdownRequestRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        return sendJson(response, 200, database.requestAgentLaneCoordinatorShutdownAttempt(
          projectId, parseCoordinatorShutdownRequest(body),
        ));
      }

      const coordinatorShutdownTransitionRoute = pathname.match(
        /^\/api\/local\/coordinator-shutdown-attempts\/([^/]+)\/(release|complete)$/,
      );
      if (coordinatorShutdownTransitionRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/coordinator-shutdown-attempts/:id/:action");
        const attemptId = decodeRouteSegment(coordinatorShutdownTransitionRoute[1], "Attempt id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set());
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        return sendJson(response, 200, database.transitionAgentLaneCoordinatorShutdownAttempt(
          attemptId, coordinatorShutdownTransitionRoute[2],
        ));
      }

      const coordinatorProvisioningRequestRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-provisioning-attempts$/,
      );
      if (coordinatorProvisioningRequestRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-provisioning-attempts");
        const projectId = decodeRouteSegment(coordinatorProvisioningRequestRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = parseCoordinatorProvisioningRequest(body);
        return sendJson(response, 200, database.requestAgentLaneCoordinatorProvisioningAttempt(
          projectId, input,
        ));
      }

      const coordinatorProvisioningTransitionRoute = pathname.match(
        /^\/api\/local\/coordinator-provisioning-attempts\/([^/]+)\/(starting|attach|reset)$/,
      );
      if (coordinatorProvisioningTransitionRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/coordinator-provisioning-attempts/:id/:action");
        const attemptId = decodeRouteSegment(coordinatorProvisioningTransitionRoute[1], "Attempt id");
        const action = coordinatorProvisioningTransitionRoute[2];
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = parseCoordinatorProvisioningTransition(body, action);
        return sendJson(response, 200, database.transitionAgentLaneCoordinatorProvisioningAttempt(
          attemptId, action, input,
        ));
      }

      const coordinatorLeaseRenewRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease\/renew$/,
      );
      if (coordinatorLeaseRenewRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-lease/renew");
        const projectId = decodeRouteSegment(coordinatorLeaseRenewRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = { ...parseCoordinatorLeaseRenew(body), renewOnly: true };
        assertCurrentCoordinatorHostBinding(projectId, input);
        return sendJson(response, 200, database.claimAgentLaneCoordinator(projectId, input));
      }

      const coordinatorLeaseRecoverRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease\/recover$/,
      );
      if (coordinatorLeaseRecoverRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-lease/recover");
        const projectId = decodeRouteSegment(coordinatorLeaseRecoverRoute[1], "Project id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = { ...parseCoordinatorLeaseRenew(body), recoverOnly: true };
        assertCurrentCoordinatorHostBinding(projectId, input);
        return sendJson(response, 200, database.claimAgentLaneCoordinator(projectId, input));
      }

      const coordinatorLeaseRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease$/,
      );
      if (coordinatorLeaseRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-lease");
        const projectId = decodeRouteSegment(coordinatorLeaseRoute[1], "Project id");
        validateProjectId(projectId);
        const input = parseCoordinatorLeaseClaim(await readJson(request));
        assertCurrentCoordinatorHostBinding(projectId, input);
        const result = database.claimAgentLaneCoordinator(projectId, input);
        return sendJson(response, 200, result);
      }

      const coordinationWindowsRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordination-windows$/,
      );
      if (coordinationWindowsRoute) {
        assertNoQuery(url.searchParams, `${request.method} /api/local/projects/:id/coordination-windows`);
        const projectId = decodeRouteSegment(coordinationWindowsRoute[1], "Project id");
        validateProjectId(projectId);
        if (request.headers["x-taskboard-client"] !== "taskctl") {
          throw new ApiError(
            403,
            "TASKCTL_REQUIRED",
            "Coordination window configuration is available only through protected taskctl",
          );
        }
        if (request.method === "GET") {
          return sendJson(response, 200, database.getAgentLaneCoordinationWindows(projectId));
        }
        if (request.method === "POST") {
          const input = parseCoordinationWindowRegistration(await readJson(request));
          let threadBinding = currentHostThreadIdentity(input.threadId);
          if (!threadBinding) {
            const priorHandshake = database.getAgentLaneCoordinationIdentityHandshake(
              projectId, input.idempotencyKey,
            );
            if (priorHandshake?.status === "completed"
              && database.hasAgentLaneCoordinationWindowReceipt(projectId, input.idempotencyKey)) {
              threadBinding = priorHandshake.threadBinding;
            }
          }
          if (!threadBinding) {
            const handshake = database.requestAgentLaneCoordinationIdentityHandshake(projectId, input);
            return sendJson(response, 202, { pending: true, handshake });
          }
          return sendJson(response, 200, database.registerAgentLaneCoordinationWindow(
            projectId,
            input,
            threadBinding,
          ));
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const coordinationIdentityHandshakesRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordination-identity-handshakes$/,
      );
      if (coordinationIdentityHandshakesRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/coordination-identity-handshakes");
        const projectId = decodeRouteSegment(coordinationIdentityHandshakesRoute[1], "Project id");
        validateProjectId(projectId);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, null, coordinatorRenewNonces,
        );
        return sendJson(response, 200, {
          handshakes: database.listAgentLaneCoordinationIdentityHandshakes(projectId),
        });
      }

      const coordinationIdentityHandshakeConfirmRoute = pathname.match(
        /^\/api\/local\/coordination-identity-handshakes\/([^/]+)\/confirm$/,
      );
      if (coordinationIdentityHandshakeConfirmRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/coordination-identity-handshakes/:id/confirm");
        const handshakeId = decodeRouteSegment(coordinationIdentityHandshakeConfirmRoute[1], "Handshake id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["registration", "threadBinding"]));
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const registration = parseCoordinationIdentityHandshakeRegistration(body.registration);
        const threadBinding = parseThreadBinding(body.threadBinding);
        if (!threadBinding?.codexProjectId) {
          throw new ApiError(400, "INVALID_FIELD", "A complete protected thread identity is required");
        }
        const handshake = database.confirmAgentLaneCoordinationIdentityHandshake(
          handshakeId, registration, threadBinding,
        );
        const registrationResult = database.registerAgentLaneCoordinationWindow(
          registration.projectId, registration, threadBinding,
        );
        return sendJson(response, 200, {
          handshake: database.getAgentLaneCoordinationIdentityHandshake(
            registration.projectId, registration.idempotencyKey,
          ) ?? handshake,
          registration: registrationResult,
        });
      }

      const domainCoordinatorLeaseRenewRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-coordinator-leases\/([^/]+)\/renew$/,
      );

      const coordinationDomainsRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordination-domains(?:\/([^/]+))?$/,
      );
      if (coordinationDomainsRoute) {
        const projectId = decodeRouteSegment(coordinationDomainsRoute[1], "Project id");
        const domainId = coordinationDomainsRoute[2]
          ? decodeRouteSegment(coordinationDomainsRoute[2], "Coordination domain id")
          : null;
        validateProjectId(projectId);
        if (domainId !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(domainId)) {
          throw new ApiError(400, "INVALID_COORDINATION_DOMAIN", "Coordination domain id is invalid");
        }
        assertNoQuery(url.searchParams, `${request.method} /api/local/projects/:id/coordination-domains`);
        if (request.headers["x-taskboard-client"] !== "taskctl") {
          throw new ApiError(403, "TASKCTL_REQUIRED", "Coordination domain configuration is available only through protected taskctl");
        }
        if (request.method === "GET" && domainId === null) {
          return sendJson(response, 200, database.getAgentLaneCoordinationDomains(projectId));
        }
        if (request.method === "PUT" && domainId !== null) {
          return sendJson(response, 200, database.configureAgentLaneCoordinationDomain(
            projectId, domainId, parseCoordinationDomainConfiguration(await readJson(request)),
          ));
        }
        if (request.method === "DELETE" && domainId !== null) {
          return sendJson(response, 200, database.configureAgentLaneCoordinationDomain(
            projectId, domainId, parseCoordinationDomainConfiguration(await readJson(request), { remove: true }),
          ));
        }
        return methodNotAllowed(response, domainId === null ? ["GET"] : ["PUT", "DELETE"]);
      }
      if (domainCoordinatorLeaseRenewRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/domain-coordinator-leases/:domainId/renew");
        const projectId = decodeRouteSegment(domainCoordinatorLeaseRenewRoute[1], "Project id");
        const domainId = decodeRouteSegment(domainCoordinatorLeaseRenewRoute[2], "Coordination domain id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = { ...parseCoordinatorLeaseRenew(body), renewOnly: true };
        assertCurrentCoordinatorHostBinding(projectId, input, "DOMAIN_COORDINATOR_BINDING_MISMATCH");
        return sendJson(response, 200, database.claimAgentLaneDomainCoordinator(projectId, domainId, input));
      }

      const domainCoordinatorLeaseRecoverRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-coordinator-leases\/([^/]+)\/recover$/,
      );
      if (domainCoordinatorLeaseRecoverRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/domain-coordinator-leases/:domainId/recover");
        const projectId = decodeRouteSegment(domainCoordinatorLeaseRecoverRoute[1], "Project id");
        const domainId = decodeRouteSegment(domainCoordinatorLeaseRecoverRoute[2], "Coordination domain id");
        validateProjectId(projectId);
        const body = await readJson(request);
        assertCoordinatorRenewProof(
          request, resolved.instanceSecret, pathname, body, coordinatorRenewNonces,
        );
        const input = { ...parseCoordinatorLeaseRenew(body), recoverOnly: true };
        assertCurrentCoordinatorHostBinding(projectId, input, "DOMAIN_COORDINATOR_BINDING_MISMATCH");
        return sendJson(response, 200, database.claimAgentLaneDomainCoordinator(projectId, domainId, input));
      }

      const domainCoordinatorLeaseRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-coordinator-leases\/([^/]+)$/,
      );
      if (domainCoordinatorLeaseRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/domain-coordinator-leases/:domainId");
        const projectId = decodeRouteSegment(domainCoordinatorLeaseRoute[1], "Project id");
        const domainId = decodeRouteSegment(domainCoordinatorLeaseRoute[2], "Coordination domain id");
        validateProjectId(projectId);
        const input = parseCoordinatorLeaseClaim(await readJson(request));
        assertCurrentCoordinatorHostBinding(projectId, input, "DOMAIN_COORDINATOR_BINDING_MISMATCH");
        return sendJson(response, 200, database.claimAgentLaneDomainCoordinator(projectId, domainId, input));
      }

      const domainCoordinatorLeaseReleaseRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-coordinator-leases\/([^/]+)\/release$/,
      );
      if (domainCoordinatorLeaseReleaseRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/domain-coordinator-leases/:domainId/release");
        const projectId = decodeRouteSegment(domainCoordinatorLeaseReleaseRoute[1], "Project id");
        const domainId = decodeRouteSegment(domainCoordinatorLeaseReleaseRoute[2], "Coordination domain id");
        validateProjectId(projectId);
        return sendJson(response, 200, database.releaseAgentLaneDomainCoordinator(
          projectId,
          domainId,
          parseCoordinatorLeaseRelease(await readJson(request)),
        ));
      }

      const domainCoordinatorLeaseReceiptsRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-coordinator-leases\/([^/]+)\/receipts$/,
      );
      if (domainCoordinatorLeaseReceiptsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/domain-coordinator-leases/:domainId/receipts");
        const projectId = decodeRouteSegment(domainCoordinatorLeaseReceiptsRoute[1], "Project id");
        const domainId = decodeRouteSegment(domainCoordinatorLeaseReceiptsRoute[2], "Coordination domain id");
        validateProjectId(projectId);
        return sendJson(response, 200, {
          receipts: database.listAgentLaneDomainCoordinatorReceipts(projectId, domainId),
        });
      }

      const domainTodoAssignmentRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/domain-todo-assignments\/([^/]+)$/,
      );

      const crossDomainDependencyClearanceRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/cross-domain-dependency-clearances\/([^/]+)$/,
      );

      const crossDomainHandoffDeliveryRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/cross-domain-handoff-delivery\/(claim|confirm)$/,
      );
      if (crossDomainHandoffDeliveryRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/cross-domain-handoff-delivery/:action");
        assertInjectorProof(request, resolved.instanceSecret);
        const projectId = decodeRouteSegment(crossDomainHandoffDeliveryRoute[1], "Project id");
        validateProjectId(projectId);
        if (crossDomainHandoffDeliveryRoute[2] === "confirm") {
          return sendJson(response, 200, database.confirmCrossDomainHandoffDelivery(
            projectId,
            parseCrossDomainHandoffDeliveryConfirmation(await readJson(request)),
          ));
        }
        const deliveryRequest = parseCrossDomainHandoffDeliveryClaim(await readJson(request));
        let snapshot;
        try {
          snapshot = await agentLanes.getProjectSnapshot(projectId);
        } catch (error) {
          if (["AGENT_LANES_NOT_CONFIGURED", "AGENT_LANES_CONFIG_UNAVAILABLE"].includes(error?.code)) {
            throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Target Domain Coordinator is not currently available");
          }
          throw error;
        }
        if (!sameCrossDomainHandoffDeliveryRequest(
          snapshot?.coordination?.pendingCrossDomainHandoff,
          deliveryRequest,
        )) {
          throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE", "Cross-domain handoff frontier or exact target route changed before delivery");
        }
        const result = database.claimCrossDomainHandoffDelivery(projectId, deliveryRequest);
        return sendJson(response, result.claimed ? 201 : 200, result);
      }
      if (crossDomainDependencyClearanceRoute) {
        const projectId = decodeRouteSegment(crossDomainDependencyClearanceRoute[1], "Project id");
        const taskId = decodeRouteSegment(crossDomainDependencyClearanceRoute[2], "Task id");
        validateProjectId(projectId);
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        if (task.projectId !== projectId) {
          throw new ApiError(409, "CROSS_DOMAIN_HANDOFF_PROJECT_MISMATCH", "Dependency clearance must stay inside one project");
        }
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/local/projects/:id/cross-domain-dependency-clearances/:taskId");
          return sendJson(response, 200, {
            clearances: database.listCrossDomainDependencyClearances(task.id),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/local/projects/:id/cross-domain-dependency-clearances/:taskId");
          if (request.headers["x-taskboard-client"] !== "taskctl") {
            throw new ApiError(403, "TASKCTL_REQUIRED", "Cross-domain dependency clearance is available only through protected taskctl");
          }
          return sendJson(response, 200, database.acceptCrossDomainDependencyClearance(
            task.id,
            parseCrossDomainDependencyClearance(await readJson(request)),
          ));
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (domainTodoAssignmentRoute) {
        const projectId = decodeRouteSegment(domainTodoAssignmentRoute[1], "Project id");
        const taskId = decodeRouteSegment(domainTodoAssignmentRoute[2], "Task id");
        validateProjectId(projectId);
        const task = database.getTask(taskId);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
        if (task.projectId !== projectId) {
          throw new ApiError(409, "DOMAIN_TODO_PROJECT_MISMATCH", "Domain Todo assignment must stay inside one project");
        }
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/local/projects/:id/domain-todo-assignments/:taskId");
          return sendJson(response, 200, {
            assignment: database.getAgentTaskDomainAssignment(task.id),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/local/projects/:id/domain-todo-assignments/:taskId");
          if (request.headers["x-taskboard-client"] !== "taskctl") {
            throw new ApiError(403, "TASKCTL_REQUIRED", "Domain Todo assignment is available only through protected taskctl");
          }
          return sendJson(response, 200, database.setAgentTaskDomain(
            projectId,
            task.id,
            parseDomainTodoAssignment(await readJson(request)),
          ));
        }
        if (request.method === "DELETE") {
          assertNoQuery(url.searchParams, "DELETE /api/local/projects/:id/domain-todo-assignments/:taskId");
          if (request.headers["x-taskboard-client"] !== "taskctl") {
            throw new ApiError(403, "TASKCTL_REQUIRED", "Domain Todo assignment is available only through protected taskctl");
          }
          return sendJson(response, 200, database.setAgentTaskDomain(
            projectId,
            task.id,
            parseDomainTodoAssignmentClear(await readJson(request)),
          ));
        }
        return methodNotAllowed(response, ["GET", "POST", "DELETE"]);
      }

      const coordinatorLeaseReleaseRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease\/release$/,
      );
      if (coordinatorLeaseReleaseRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-lease/release");
        const projectId = decodeRouteSegment(coordinatorLeaseReleaseRoute[1], "Project id");
        validateProjectId(projectId);
        return sendJson(response, 200, database.releaseAgentLaneCoordinator(
          projectId,
          parseCoordinatorLeaseRelease(await readJson(request)),
        ));
      }

      const coordinatorBindingRepairRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease\/repair-binding$/,
      );
      if (coordinatorBindingRepairRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/coordinator-lease/repair-binding");
        const projectId = decodeRouteSegment(coordinatorBindingRepairRoute[1], "Project id");
        validateProjectId(projectId);
        const input = parseCoordinatorBindingRepair(await readJson(request));
        const threadBinding = currentHostThreadIdentity(input.holderThreadId);
        if (!threadBinding) {
          throw new ApiError(
            409,
            "HOST_IDENTITY_UNAVAILABLE",
            "The coordinator thread must be the fresh protected Codex host identity",
          );
        }
        const result = database.repairLegacyTaskRootBinding(
          projectId,
          input,
          threadBinding,
          actorFromRequest(request),
        );
        events.emit("task.updated", { task: result.task });
        return sendJson(response, 200, result);
      }

      const coordinatorLeaseReceiptsRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/coordinator-lease\/receipts$/,
      );
      if (coordinatorLeaseReceiptsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/coordinator-lease/receipts");
        const projectId = decodeRouteSegment(coordinatorLeaseReceiptsRoute[1], "Project id");
        validateProjectId(projectId);
        return sendJson(response, 200, {
          receipts: database.listAgentLaneCoordinatorReceipts(projectId),
        });
      }

      const ownerDecisionDeliveryRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/owner-decision-delivery\/(claim|confirm)$/,
      );
      if (ownerDecisionDeliveryRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:id/owner-decision-delivery/:action");
        assertInjectorProof(request, resolved.instanceSecret);
        const projectId = decodeRouteSegment(ownerDecisionDeliveryRoute[1], "Project id");
        validateProjectId(projectId);
        if (ownerDecisionDeliveryRoute[2] === "confirm") {
          return sendJson(response, 200, database.confirmOwnerDecisionDelivery(
            projectId,
            parseOwnerDecisionDeliveryConfirmation(await readJson(request)),
          ));
        }
        const deliveryRequest = parseOwnerDecisionDeliveryClaim(await readJson(request));
        let snapshot;
        try {
          snapshot = await agentLanes.getProjectSnapshot(projectId);
        } catch (error) {
          if (["AGENT_LANES_NOT_CONFIGURED", "AGENT_LANES_CONFIG_UNAVAILABLE"].includes(error?.code)) {
            throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision coordinator is not currently available");
          }
          throw error;
        }
        if (!sameOwnerDecisionDeliveryRequest(
          snapshot?.coordination?.ownerDecisionRequest,
          deliveryRequest,
        )) {
          throw new ApiError(409, "OWNER_DECISION_ROUTE_STALE", "Owner decision request or exact Root route changed before delivery");
        }
        const result = database.claimOwnerDecisionDelivery(projectId, deliveryRequest);
        return sendJson(response, result.claimed ? 201 : 200, result);
      }

      const ownerIntentsRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/owner-intents$/);
      if (ownerIntentsRoute) {
        const projectId = decodeRouteSegment(ownerIntentsRoute[1], "Project id");
        validateProjectId(projectId);
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/local/projects/:id/owner-intents");
          return sendJson(response, 200, { intents: database.listProjectOwnerIntents(projectId) });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/local/projects/:id/owner-intents");
          assertInjectorProof(request, resolved.instanceSecret);
          const input = parseOwnerIntent(await readJson(request));
          const sourceThreadBinding = currentHostThreadIdentity(input.ownerRootThreadId);
          if (!sourceThreadBinding) {
            throw new ApiError(
              409,
              "HOST_IDENTITY_UNAVAILABLE",
              "Owner Intent must come from the fresh protected Owner Root host identity",
            );
          }
          const result = database.recordProjectOwnerIntent(
            projectId,
            input,
            sourceThreadBinding,
            CODEX_AGENT_ACTOR,
          );
          return sendJson(response, result.applied ? 201 : 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const ownerIntentAdoptionRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/owner-intents\/([^/]+)\/adoption\/(claim|confirm)$/,
      );
      if (ownerIntentAdoptionRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(
          url.searchParams,
          "POST /api/local/projects/:projectId/owner-intents/:intentId/adoption/:action",
        );
        assertInjectorProof(request, resolved.instanceSecret);
        const projectId = decodeRouteSegment(ownerIntentAdoptionRoute[1], "Project id");
        const intentId = decodeRouteSegment(ownerIntentAdoptionRoute[2], "Owner Intent id");
        validateProjectId(projectId);
        if (ownerIntentAdoptionRoute[3] === "confirm") {
          return sendJson(response, 200, database.confirmProjectOwnerIntentAdoption(
            projectId,
            intentId,
            parseOwnerIntentAdoptionConfirmation(await readJson(request)),
          ));
        }
        const result = database.claimProjectOwnerIntentAdoption(
          projectId,
          intentId,
          parseOwnerIntentAdoptionClaim(await readJson(request)),
        );
        return sendJson(response, result.claimed ? 201 : 200, result);
      }

      const ownerIntentPlanRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/owner-intents\/([^/]+)\/plan-revisions$/,
      );
      const ownerIntentPlanRetryRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/owner-intents\/([^/]+)\/plan-retry$/,
      );
      if (ownerIntentPlanRetryRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/projects/:projectId/owner-intents/:intentId/plan-retry");
        assertInjectorProof(request, resolved.instanceSecret);
        const projectId = decodeRouteSegment(ownerIntentPlanRetryRoute[1], "Project id");
        const intentId = decodeRouteSegment(ownerIntentPlanRetryRoute[2], "Owner Intent id");
        validateProjectId(projectId);
        const result = database.retryProjectOwnerIntentPlan(
          projectId,
          intentId,
          parseOwnerIntentPlanRetry(await readJson(request)),
        );
        return sendJson(response, result.applied ? 201 : 200, result);
      }
      if (ownerIntentPlanRoute) {
        const projectId = decodeRouteSegment(ownerIntentPlanRoute[1], "Project id");
        const intentId = decodeRouteSegment(ownerIntentPlanRoute[2], "Owner Intent id");
        validateProjectId(projectId);
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/local/projects/:projectId/owner-intents/:intentId/plan-revisions");
          return sendJson(response, 200, {
            revisions: database.listProjectOwnerIntentPlan(projectId)
              .filter((revision) => revision.intentId === intentId),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/local/projects/:projectId/owner-intents/:intentId/plan-revisions");
          assertInjectorProof(request, resolved.instanceSecret);
          const result = database.applyProjectOwnerIntentPlan(
            projectId,
            intentId,
            parseOwnerIntentPlan(await readJson(request)),
          );
          return sendJson(response, result.applied ? 201 : 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const ownerIntentPlanFrontierRoute = pathname.match(
        /^\/api\/local\/projects\/([^/]+)\/owner-intent-plan$/,
      );
      if (ownerIntentPlanFrontierRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:projectId/owner-intent-plan");
        const projectId = decodeRouteSegment(ownerIntentPlanFrontierRoute[1], "Project id");
        validateProjectId(projectId);
        return sendJson(response, 200, { revisions: database.listProjectOwnerIntentPlan(projectId) });
      }

      const agentLaneRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/agent-lanes$/);
      if (agentLaneRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/agent-lanes");
        const projectId = decodeRouteSegment(agentLaneRoute[1], "Project id");
        validateProjectId(projectId);
        if (!database.getProject(projectId)) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        }
        try {
          return sendJson(response, 200, await agentLanes.getProjectSnapshot(projectId));
        } catch (error) {
          if (error?.code === "AGENT_LANES_NOT_CONFIGURED") {
            throw new ApiError(404, error.code, error.message);
          }
          if (error?.code === "AGENT_LANES_CONFIG_UNAVAILABLE") {
            throw new ApiError(503, error.code, error.message);
          }
          throw error;
        }
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/jira-connection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 连接接口不接受查询参数");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { connection: await jira.status() });
        }
        if (request.method === "PUT") {
          const activeCloudConfig = await cloudConfig.read();
          if (activeCloudConfig.remoteUrl) {
            throw new ApiError(
              409,
              "JIRA_LOCAL_MODE_REQUIRED",
              "Jira 连接当前仅支持本地数据模式，请先退出云端协作模式",
            );
          }
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["baseUrl", "username", "password", "projects"]));
          const baseUrl = stringField(body.baseUrl, "baseUrl", { required: true, maxLength: 2048 });
          const username = stringField(body.username ?? "", "username", { maxLength: 254 });
          const password = body.password ?? "";
          if (typeof password !== "string") {
            throw new ApiError(400, "INVALID_FIELD", "'password' must be a string");
          }
          if (password.length > 4096) {
            throw new ApiError(400, "INVALID_FIELD", "'password' cannot exceed 4096 characters");
          }
          try {
            const connection = await jira.configure({
              baseUrl,
              username,
              password,
              projects: body.projects,
            });
            events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
            return sendJson(response, 200, { connection });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, error.code ?? "INVALID_JIRA_CONFIG", error.message);
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-connection/sync") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 同步接口不接受查询参数");
        }
        await assertEmptyRequestBody(request, "POST /api/local/jira-connection/sync");
        const connection = await jira.sync({ force: true });
        events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
        return sendJson(response, 200, { connection });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          manageTaskboardSkillPath: resolved.skillPath,
          capabilities: { localAiChat: isLoopbackAddress(request.socket.remoteAddress) },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: { transport: "poll", intervalMs: 2000 },
              localCapabilities: { available: true },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["projectId"]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(response, 200, await aiChat.getCatalog(projectId));
      }

      if (pathname === "/api/local/ai/composer/candidates") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const query = parseComposerCandidateQuery(url.searchParams);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.candidatesForSurface(
            await aiChat.getComposerCandidates(query),
            query,
          ),
        );
      }

      if (pathname === "/api/local/ai/composer/rebind") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/composer/rebind");
        const input = parseComposerRebindRequest(await readJson(request));
        const workspacePath = await resolveComposerRebindWorkspace(aiChat, input);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.rebindPersistedReferences({
            workspacePath,
            nodes: input.document.nodes,
          }),
        );
      }

      const projectSummaryRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/summary$/);
      if (projectSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/summary");
        const projectId = validateProjectId(
          decodeRouteSegment(projectSummaryRoute[1], "Project id"),
        );
        return sendJson(response, 200, projectSummary.get(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadCompactRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/compact$/);
      if (aiThreadCompactRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/compact");
        const threadId = decodeRouteSegment(aiThreadCompactRoute[1], "Thread id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/threads/:id/compact");
        const thread = await aiChat.compactThread(threadId);
        return sendJson(response, 200, { thread });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }


      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          const projects = database.listProjects().map((project) => ({
            ...project,
            workspacePath: project.id === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig?.projectMappings[project.id] ?? project.workspacePath,
          }));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "DELETE") {
          database.deleteProject(projectId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["DELETE"]);
      }

      const projectLabelsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
      const projectStandingAuthoritiesRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/standing-authorities$/,
      );
      if (projectStandingAuthoritiesRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Standing authority routes do not accept query parameters");
        }
        const projectId = decodeRouteSegment(projectStandingAuthoritiesRoute[1], "Project id");
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, {
            authorities: database.listProjectStandingAuthorities(projectId),
          });
        }
        if (request.method === "POST") {
          const result = database.grantProjectStandingAuthority(
            projectId,
            parseStandingAuthorityGrant(await readJson(request)),
            actorFromRequest(request),
          );
          events.emit("project.standing-authority.updated", { projectId, authority: result.authority });
          return sendJson(response, result.created ? 201 : 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectStandingAuthorityRevokeRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/standing-authorities\/([^/]+)\/revoke$/,
      );
      if (projectStandingAuthorityRevokeRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Standing authority routes do not accept query parameters");
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const projectId = decodeRouteSegment(projectStandingAuthorityRevokeRoute[1], "Project id");
        const authorityId = decodeRouteSegment(projectStandingAuthorityRevokeRoute[2], "Standing authority id");
        validateProjectId(projectId);
        const result = database.revokeProjectStandingAuthority(
          projectId,
          authorityId,
          parseStandingAuthorityRevocation(await readJson(request)),
          actorFromRequest(request),
        );
        events.emit("project.standing-authority.updated", { projectId, authority: result.authority });
        return sendJson(response, 200, result);
      }

      if (projectLabelsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project label routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectLabelsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST" && request.method !== "DELETE") {
          return methodNotAllowed(response, ["POST", "DELETE"]);
        }
        if (request.method === "DELETE" && projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
            "Jira 标签目录由同步管理，不能在 Taskboard 中删除",
          );
        }
        const label = parseProjectLabel(await readJson(request));
        const project = request.method === "POST"
          ? database.addProjectLabel(projectId, label)
          : database.deleteProjectLabel(projectId, label);
        events.emit("project.labels.updated", { project });
        return sendJson(response, 200, { project });
      }

      const projectReadmeAttachmentsRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/readme\/attachments$/,
      );
      if (projectReadmeAttachmentsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README attachment routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const metadata = parseAttachmentHeaders(request);
        if (metadata.kind !== "inline") {
          throw new ApiError(400, "INVALID_ATTACHMENT_KIND", "Project README attachments must be inline");
        }
        const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
        const id = randomUUID();
        await mkdir(resolved.attachmentsDirectory, { recursive: true });
        const storagePath = path.join(resolved.attachmentsDirectory, id);
        await writeFile(storagePath, body, { flag: "wx" });
        let attachment;
        try {
          attachment = database.createProjectReadmeAttachment(projectId, {
            id,
            ...metadata,
            size: body.length,
          });
        } catch (error) {
          await unlink(storagePath);
          throw error;
        }
        return sendJson(response, 201, { attachment });
      }

      const projectReadmeRoute = pathname.match(/^\/api\/projects\/([^/]+)\/readme$/);
      if (projectReadmeRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { readme: database.getProjectReadme(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseProjectReadmeSave(await readJson(
            request,
            PROJECT_README_BODY_LIMIT,
            "Project README request cannot exceed 3 MiB",
          ));
          const readme = database.saveProjectReadme(projectId, input.content, input.version);
          events.emit("project.readme.updated", {
            projectId,
            readmeVersion: readme.version,
          });
          return sendJson(response, 200, { readme });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: projectId === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(
          response,
          200,
          await scanDevelopmentContexts(workspacePath, codexProcessEnvironment),
        );
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (!filters.projectId || filters.projectId === JIRA_PROJECT_ID) await jira.sync();
          return sendJson(response, 200, { tasks: database.listTasks(filters) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...parsedInput } = parseTaskCreate(await readJson(request));
          const input = resolveInputThreadBinding(parsedInput);
          if (input.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_CREATE_UNAVAILABLE",
              "请在 Jira 中新建议题，Taskboard 当前只同步已分配给你的任务",
            );
          }
          const task = database.createTask({
            ...input,
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          events.emit("task.created", { task });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId, threadBinding, origin } = parseRelationMutation(
            await readJson(request),
          );
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId, threadBinding, origin } = parseRelationMutation(
            await readJson(request),
          );
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskActivitiesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
      if (taskActivitiesRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskActivitiesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Activity routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { activities: database.listTaskActivities(taskId) });
        }
        return methodNotAllowed(response, ["GET"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Comment routes");
          const comments = after
            ? database.listCommentsAfter(taskId, after)
            : database.listComments(taskId);
          return sendJson(response, 200, {
            comments,
            nextCursor: nextCursor(comments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const comment = database.createComment(taskId, {
            ...resolveInputThreadBinding(parseCommentCreate(await readJson(request))),
            actor: actorFromRequest(request),
          });
          const task = database.getTask(taskId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskInboxDeliveriesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/inbox-deliveries$/);
      if (taskInboxDeliveriesRoute) {
        const taskId = decodeRouteSegment(taskInboxDeliveriesRoute[1], "Task id");
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/tasks/:id/inbox-deliveries");
          return sendJson(response, 200, {
            receipts: database.listTaskInboxDeliveryReceipts(taskId),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/tasks/:id/inbox-deliveries");
          const result = database.deliverTaskInboxMessage(taskId, {
            ...resolveInputThreadBinding(parseInboxDelivery(await readJson(request))),
            actor: actorFromRequest(request),
          });
          if (result.applied) {
            events.emit("comment.created", { comment: result.comment, task: database.getTask(taskId) });
          }
          return sendJson(response, result.applied ? 201 : 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskCoordinationEventsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/coordination-events$/);
      if (taskCoordinationEventsRoute) {
        const taskId = decodeRouteSegment(taskCoordinationEventsRoute[1], "Task id");
        if (request.method === "GET") {
          assertNoQuery(url.searchParams, "GET /api/tasks/:id/coordination-events");
          return sendJson(response, 200, {
            events: database.listTaskCoordinationEvents(taskId),
          });
        }
        if (request.method === "POST") {
          assertNoQuery(url.searchParams, "POST /api/tasks/:id/coordination-events");
          const result = database.appendTaskCoordinationEvent(
            taskId,
            parseCoordinationEnvelope(await readJson(request)),
            CODEX_AGENT_ACTOR,
          );
          if (result.applied) {
            events.emit("comment.created", { comment: result.comment, task: database.getTask(taskId) });
          }
          return sendJson(response, result.applied ? 201 : 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const coordinationAcknowledgementsRoute = pathname.match(
        /^\/api\/coordination-events\/([^/]+)\/acknowledgements$/,
      );
      if (coordinationAcknowledgementsRoute) {
        const eventId = decodeRouteSegment(coordinationAcknowledgementsRoute[1], "Coordination event id");
        assertNoQuery(url.searchParams, "POST /api/coordination-events/:id/acknowledgements");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const result = database.acknowledgeTaskCoordinationEvent(
          eventId,
          parseCoordinationAcknowledgement(await readJson(request)),
        );
        return sendJson(response, result.applied ? 201 : 200, result);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = resolveInputThreadBinding(parseCommentPatch(await readJson(request)));
          const comment = database.updateComment(
            id,
            patch.version,
            patch.body,
            patch.threadId,
            patch.threadBinding,
          );
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listCommentAttachments(commentId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listAttachments(taskId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/(content|download)$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id) ?? database.getProjectReadmeAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = attachmentContentRoute[2] === "content"
          && INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskAgentRunRoute = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(checkpoint|finish))?$/);
      if (taskAgentRunRoute) {
        const id = decodeRouteSegment(taskAgentRunRoute[1], "Agent Run id");
        const action = taskAgentRunRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/runs/:id does not accept query parameters");
          }
          const run = database.getTaskAgentRun(id);
          if (!run) throw new ApiError(404, "AGENT_RUN_NOT_FOUND", `Agent Run '${id}' does not exist`);
          return sendJson(response, 200, { run });
        }
        if (action === "checkpoint" && request.method === "POST") {
          const checkpoint = parseAgentRunCheckpoint(await readJson(request));
          const result = database.checkpointTaskAgentRun(id, checkpoint.version, checkpoint);
          if (result.applied) events.emit("task.updated", { task: result.task });
          return sendJson(response, 200, result);
        }
        if (action === "finish" && request.method === "POST") {
          const finish = parseAgentRunFinish(await readJson(request));
          const result = database.finishTaskAgentRun(id, finish.version, finish);
          if (result.applied) {
            events.emit(result.run.status === "completed" ? "task.moved" : "task.updated", { task: result.task });
          }
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET"]);
      }

      const safeActionBootstrapClaimRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/bootstrap-claim$/);
      if (safeActionBootstrapClaimRoute) {
        let id;
        try {
          id = decodeURIComponent(safeActionBootstrapClaimRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/bootstrap-claim");
        const claim = parseSafeActionBootstrapClaim(await readJson(request));
        const task = await refreshTaskWorktreeRepository(id, { force: true });
        await assertStandingActionExecutionScope(id, claim.safeActionId);
        const result = database.claimTaskSafeAction(
          id,
          claim,
        );
        const safeAction = database.getTaskCapsule(id).readyWork.safeActions[0];
        return sendJson(response, 200, {
          ...result,
          ...(result.recovering === true && result.available === true ? {
            executionIdentity: {
              worktreePath: result.recoveryRoute.worktreePath,
              branch: result.recoveryRoute.branch,
              repository: task.developmentContext.repository,
              verifiedAt: task.developmentContext.repositoryVerifiedAt,
              standingScope: safeAction?.standingAuthority ? safeAction.standingScope : null,
            },
          } : {}),
        });
      }

      const safeActionBootstrapDeliveryRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/bootstrap-delivery$/);
      if (safeActionBootstrapDeliveryRoute) {
        const id = decodeRouteSegment(safeActionBootstrapDeliveryRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/bootstrap-delivery");
        const delivery = parseSafeActionBootstrapClaim(await readJson(request));
        const task = await refreshTaskWorktreeRepository(id, { force: true });
        await assertStandingActionExecutionScope(id, delivery.safeActionId);
        const result = database.confirmTaskSafeActionDelivery(id, delivery);
        const safeAction = database.getTaskCapsule(id).readyWork.safeActions[0];
        return sendJson(response, 200, {
          ...result,
          executionIdentity: {
            worktreePath: task.developmentContext.path,
            branch: task.developmentContext.branch,
            repository: task.developmentContext.repository,
            verifiedAt: task.developmentContext.repositoryVerifiedAt,
            standingScope: safeAction.standingAuthority ? safeAction.standingScope : null,
          },
        });
      }

      const safeActionBootstrapCompleteRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/bootstrap-complete$/);
      if (safeActionBootstrapCompleteRoute) {
        const id = decodeRouteSegment(safeActionBootstrapCompleteRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/bootstrap-complete");
        const completion = parseSafeActionBootstrapClaim(await readJson(request));
        if (!completion.deliveryTurnId) {
          throw new ApiError(400, "INVALID_FIELD", "'deliveryTurnId' is required");
        }
        return sendJson(response, 200, database.completeTaskSafeActionDelivery(id, completion));
      }

      const safeActionAdmissionDeferralRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/admission-defer$/);
      if (safeActionAdmissionDeferralRoute) {
        const id = decodeRouteSegment(safeActionAdmissionDeferralRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/admission-defer");
        const deferral = parseSafeActionAdmissionDeferral(await readJson(request));
        return sendJson(response, 200, database.deferTaskSafeActionAdmission(id, deferral));
      }

      const safeActionAdmissionPreparationRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/admission-prepare$/);
      if (safeActionAdmissionPreparationRoute) {
        const id = decodeRouteSegment(safeActionAdmissionPreparationRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/admission-prepare");
        const preparation = parseSafeActionAdmissionPreparation(await readJson(request));
        return sendJson(response, 200, database.prepareTaskSafeActionAdmission(id, preparation));
      }

      const safeActionAdmissionUncertainRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/admission-uncertain$/);
      if (safeActionAdmissionUncertainRoute) {
        const id = decodeRouteSegment(safeActionAdmissionUncertainRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/admission-uncertain");
        assertInjectorProof(request, resolved.instanceSecret);
        const binding = parseSafeActionAdmissionDeferral(await readJson(request));
        return sendJson(response, 200, database.markTaskSafeActionAdmissionUncertain(id, binding));
      }

      const safeActionAdmissionReconcileRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/admission-reconcile$/);
      if (safeActionAdmissionReconcileRoute) {
        const id = decodeRouteSegment(safeActionAdmissionReconcileRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/admission-reconcile");
        assertInjectorProof(request, resolved.instanceSecret);
        const binding = parseSafeActionAdmissionReconciliation(await readJson(request));
        const task = database.getTask(id);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
        const snapshot = await agentLanes.getProjectSnapshot(task.projectId);
        const tree = snapshot.windowSubagentTrees?.find((candidate) => (
          candidate.rootThreadId === binding.rootThreadId
        ));
        return sendJson(response, 200, database.reconcileTaskSafeActionAdmission(id, {
          ...binding,
          registryObservation: tree?.registryObservation ?? null,
        }));
      }

      const safeActionAdmissionProbeRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/admission-probe$/);
      if (safeActionAdmissionProbeRoute) {
        const id = decodeRouteSegment(safeActionAdmissionProbeRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/admission-probe");
        assertInjectorProof(request, resolved.instanceSecret);
        const binding = parseSafeActionAdmissionDeferral(await readJson(request));
        return sendJson(response, 200, database.claimTaskSafeActionAdmissionProbe(id, binding));
      }

      const ownerDecisionRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/owner-decisions$/);
      if (ownerDecisionRoute) {
        const id = decodeRouteSegment(ownerDecisionRoute[1], "Task id");
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/:id/owner-decisions");
        assertInjectorProof(request, resolved.instanceSecret);
        const result = database.recordTaskOwnerDecision(
          id,
          parseOwnerDecision(await readJson(request)),
          CODEX_AGENT_ACTOR,
        );
        if (result.applied) events.emit("task.updated", { task: database.getTask(id) });
        return sendJson(response, result.applied ? 201 : 200, result);
      }

      const taskCapsuleRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/capsule$/);
      if (taskCapsuleRoute) {
        let id;
        try {
          id = decodeURIComponent(taskCapsuleRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id/capsule does not accept query parameters");
        }
        const capsule = await verifiedTaskCapsule(id);
        if (!capsule) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
        return sendJson(response, 200, { capsule });
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move|claim))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "PATCH") {
          const actor = actorFromRequest(request);
          const {
            version,
            changes,
            threadId,
            threadBinding,
            assigneeTarget,
          } = parseTaskPatch(await readJson(request));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          let jiraChanged = false;
          if (current.source !== "jira" && changes.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_PROJECT_MOVE_UNAVAILABLE",
              "本地任务不能移入 Jira 同步项目",
            );
          }
          if (current.source === "jira") {
            if (current.version !== version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be updated");
            }
            if (Object.hasOwn(changes, "projectId")) {
              throw new ApiError(409, "JIRA_PROJECT_MOVE_UNAVAILABLE", "Jira 任务不能移到本地项目");
            }
            if (assigneeTarget !== undefined) {
              throw new ApiError(409, "JIRA_ASSIGNEE_UNAVAILABLE", "请在 Jira 中修改经办人");
            }
            const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
            const recurrence = Object.hasOwn(changes, "recurrence")
              ? changes.recurrence
              : current.recurrence;
            if (recurrence && !dueDate) {
              throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
            }
            jiraChanged = await jira.updateTask(current, changes);
          }
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actor);
          }
          let task;
          try {
            task = database.updateTask(id, version, changes, threadId, threadBinding, actor);
          } catch (error) {
            if (jiraChanged) {
              try {
                await jira.reconcile();
              } catch {
                throw new ApiError(
                  502,
                  "JIRA_RECONCILE_FAILED",
                  "Jira 已更新，但 Taskboard 重新同步失败，请手动同步",
                );
              }
            }
            throw error;
          }
          events.emit("task.updated", { task });
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "DELETE") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_DELETE_UNAVAILABLE", "Jira 任务不能从 Taskboard 永久删除");
          }
          const { version } = parseArchive(await readJson(request));
          const deleted = database.deleteArchivedTask(id, version);
          for (const attachmentId of deleted.attachmentIds) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachmentId));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          events.emit("task.deleted", { task: deleted.task });
          return sendEmpty(response, 204);
        }
        if (action === "move" && request.method === "POST") {
          const move = parseMove(await readJson(request));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (current.source === "jira") {
            if (current.version !== move.version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: move.version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
            }
            await jira.moveTask(current, move.status);
          }
          const task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            move.threadId,
            move.threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.moved", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "claim" && request.method === "POST") {
          const claim = parseAgentClaim(await readJson(request));
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(
              409,
              "JIRA_CLAIM_UNAVAILABLE",
              "Jira tasks cannot be claimed without a Jira transition",
            );
          }
          const result = database.claimAgentTask(id, claim.version, claim);
          events.emit("task.moved", { task: result.task });
          return sendJson(response, 200, result);
        }
        if (action === "archive" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_ARCHIVE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动归档");
          }
          const { version, threadId, threadBinding } = parseArchive(await readJson(request));
          const task = database.archiveTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_RESTORE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动恢复");
          }
          const { version, threadId, threadBinding } = parseArchive(await readJson(request));
          const task = database.restoreTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    refreshTaskWorktreeRepository,
    aiChat,
    agentLanes,
    reconcileAgentLanes,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort(), fd = null } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Taskboard server must bind to 127.0.0.1 or 0.0.0.0");
      }
      if (fd !== null && (!Number.isInteger(fd) || fd < 3 || fd > 255)) {
        throw new Error("Taskboard server listen fd must be an inherited file descriptor");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (fd === null) server.listen(port, host);
        else server.listen({ fd });
      });
      listening = true;
      await reconcileAgentLanes();
      agentLaneTimer = setInterval(() => {
        reconcileAgentLanes().catch((error) => console.error("Agent lane reconcile failed", error));
      }, options.agentLaneReconcileIntervalMs ?? 5_000);
      agentLaneTimer.unref?.();
      return server.address();
    },
    async close() {
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      if (agentLaneTimer) clearInterval(agentLaneTimer);
      agentLaneTimer = null;
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await aiChat.close();
      await projectSummary.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
