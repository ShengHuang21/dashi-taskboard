import path from "node:path";

const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";
const coordinationDeliveries = new Map();
const COORDINATION_DEDUPLICATION_MS = 60_000;
const continuationMonitorRuns = new Map();
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORDINATION_ID_PATTERN = /^[a-z0-9._-]{1,128}$/i;
const RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

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
  const deliveryKey = `${request.codexHostId}:${request.projectId}:${request.todoId}:${request.safeActionId}:${request.expectedResumeToken}:${request.rootThreadId}:${rootWorkspacePath}:${targetRoot}`;
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

async function runTaskboardContinuationMonitorOnceUnlocked({
  policy,
  readSnapshot,
  claimReceipt,
  deliver,
}) {
  if (
    typeof readSnapshot !== "function"
    || typeof claimReceipt !== "function"
    || typeof deliver !== "function"
  ) return { delivered: false, reason: "invalid-monitor" };

  const snapshot = await readSnapshot(policy.projectId);
  if (snapshot?.projectId !== policy.projectId || !Array.isArray(snapshot.todos)) {
    return { delivered: false, reason: "invalid-snapshot" };
  }
  const todo = snapshot.todos.find((candidate) => {
    const target = candidate?.dispatchTarget;
    const readyWork = candidate?.readyWork;
    const safeAction = readyWork?.safeActions?.[0];
    return (
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
  });
  if (!todo) return { delivered: false, reason: "no-eligible-work" };

  const safeAction = todo.readyWork.safeActions[0];
  if (!await claimReceipt({
    todoId: todo.id,
    taskId: todo.taskId,
    rootThreadId: todo.dispatchTarget.rootThreadId,
    safeActionId: safeAction.id,
    expectedResumeToken: todo.readyWork.resumeToken,
  })) {
    return { delivered: false, reason: "reservation-unavailable" };
  }
  await deliver({
    projectId: policy.projectId,
    todoId: todo.id,
    rootThreadId: todo.dispatchTarget.rootThreadId,
    codexHostId: todo.dispatchTarget.codexHostId,
    rootWorkspacePath: path.resolve(todo.dispatchTarget.rootWorkspacePath),
    targetRoot: path.resolve(todo.dispatchTarget.worktreePath),
    safeActionId: safeAction.id,
    expectedResumeToken: todo.readyWork.resumeToken,
  });
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
  await validateExecutionTarget(targetRoot);
  const instruction = [
    `taskctl issue bootstrap ${request.todoId} --json`,
    `Project: ${request.projectId}`,
    `Todo: ${request.todoId}`,
    `Expected Capsule resumeToken: ${request.expectedResumeToken}`,
    `Authorized safe action id: ${request.safeActionId}`,
    `Exact execution worktree: ${targetRoot}`,
    "Before editing or testing, verify the exact execution worktree is a Git worktree and use it for all repository commands. The Root coordination cwd may be different and must not be treated as the execution worktree.",
    "Read the returned Task Capsule and require all of: its resumeToken exactly matches the expected token; readyWork.eligible is true; readyWork.safeActions[0].id exactly matches the authorized safe action id. If any check fails, stop and report the mismatch; do not claim, spawn, or dispatch work.",
    "Execute only readyWork.safeActions[0]. Never execute any readyWork.deferredActions. Coordinate that one bounded action as Root: finish any current safe boundary, then spawn the smallest useful Sub-Agent if needed, claim the Todo with that Sub-Agent thread identity, a future lease, and an explicit bounded write scope, and collect its result back into Root.",
    "Preserve one writer. Do not start Claude or Pi. Do not broaden permissions, deploy, merge, push, install dependencies, use secrets, mutate shared runtimes, or perform financial actions unless separately authorized.",
  ].join("\n");
  const turns = Array.isArray(threadResult.thread.turns) ? threadResult.thread.turns : [];
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
    throw new Error("Codex did not return a valid Root turn receipt");
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
