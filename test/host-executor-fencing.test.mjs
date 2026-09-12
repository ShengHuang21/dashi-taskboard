import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import {
  createHostExecutorApi,
  createHostExecutorEffectKey,
} from "../scripts/host-executor-api.mjs";
import { createHostExecutorLeaseLifecycle } from "../scripts/host-executor-lifecycle.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { CodexAppServerError } from "../server/codex-app-server.mjs";

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry.closed) await entry.app.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

function signedHeaders(secret, pathname, body, sequence) {
  const nonce = sequence.toString(16).padStart(32, "0");
  const issuedAt = String(Date.now());
  return {
    "content-type": "application/json",
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-issued-at": issuedAt,
    "x-codex-taskboard-injector-proof": createHmac("sha256", secret)
      .update(JSON.stringify({ nonce, issuedAt, method: "POST", pathname, body }))
      .digest("hex"),
  };
}

function executionHeaders(secret, pathname, body, execution) {
  const serialized = Buffer.from(JSON.stringify(execution), "utf8").toString("base64url");
  return {
    "x-codex-taskboard-host-execution": serialized,
    "x-codex-taskboard-host-execution-proof": createHmac("sha256", secret)
      .update(JSON.stringify({
        method: "POST", pathname, body, execution: serialized,
      }))
      .digest("hex"),
  };
}

async function postEffect(baseUrl, secret, effectKey, execution, operations, sequence) {
  const pathname = `/api/local/host-executors/local/effects/${encodeURIComponent(effectKey)}/execute`;
  const body = { execution, operations };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: signedHeaders(secret, pathname, body, sequence),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function launchHarness({ currentTime, afterReserve, requestReady, subscribe, useDefaultAdapter = false, reopenDirectory } = {}) {
  const directory = reopenDirectory ?? await mkdtemp(path.join(os.tmpdir(), "taskboard-host-fence-"));
  const worktreePath = path.join(directory, "worktree");
  await mkdir(worktreePath, { recursive: true });
  const secret = "d".repeat(64);
  const calls = [];
  const adapter = {
    ...(subscribe ? { subscribe } : {}),
    async ensureReady() {},
    requestReady(codexHostId, method, params) {
      calls.push({ codexHostId, method, params });
      if (requestReady) return requestReady({ calls, codexHostId, method, params });
      return Promise.resolve({ turn: { id: `turn-${calls.length}` } });
    },
  };
  const clock = { value: currentTime ?? Date.now() };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: "/usr/bin/false",
    codexStatePath: path.join(directory, "codex-state"),
    codexSessionsDirectory: path.join(directory, "sessions"),
    instanceSecret: secret,
    hostExecutorClock: () => clock.value,
    hostExecutorRpcAdapter: useDefaultAdapter ? undefined : adapter,
    hostExecutorDispatchHooks: afterReserve ? { afterReserve } : undefined,
    worktreeRepositoryExecFile: async () => {
      throw new Error("repository probe intentionally unavailable in the fence harness");
    },
  });
  const address = await app.listen({ port: 0 });
  running.push({ app, directory });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = createHostExecutorApi({ baseUrl, instanceSecret: secret });
  let operation = 0;
  const lifecycle = (executorInstanceId) => createHostExecutorLeaseLifecycle({
    codexHostId: "local",
    executorInstanceId,
    adapterId: "local-codex-app-server-v1",
    leaseDurationSeconds: 30,
    renewIntervalMs: 10_000,
    register: api.register,
    inspect: api.inspect,
    acquire: api.acquire,
    renew: api.renew,
    release: api.release,
    schedule: () => ({ scheduled: true }),
    cancel: () => {},
    now: () => clock.value,
    createOperationId: () => `operation-${++operation}`,
  });
  return { api, app, baseUrl, calls, clock, directory, lifecycle, secret, worktreePath };
}

function createReadyTask(harness) {
  const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  const binding = {
    threadId: "root-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: harness.worktreePath,
  };
  const task = harness.app.database.createTask({
    projectId: "local",
    title: "Fence resident continuation mutation",
    description: "",
    status: "todo",
    priority: "high",
    labels: ["agent-todo"],
    threadId: binding.threadId,
    threadBinding: binding,
    actor,
    assignee: actor,
    workflowId: null,
    developmentContext: {
      type: "worktree", path: harness.worktreePath, branch: "codex/host-fence",
    },
    workingLog: { path: `${harness.worktreePath}/WORKING-LOG.md`, status: "active" },
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  harness.app.database.createComment(task.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "local", kind: "test", state: "authorized", scope: "focused test",
        approver: "Owner", approvalRequest: "run", evidence: "test", receipt: "test:fence",
      }],
      actions: [{
        id: "execute", order: 10, text: "Execute", gate: "local",
        target: "candidate", status: "pending",
      }],
    })}\n\`\`\``,
    threadId: binding.threadId,
    threadBinding: binding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });
  const capsule = harness.app.database.getTaskCapsule(task.id);
  return { task, binding, capsule };
}

async function postBootstrapClaim(harness, ready, execution, reservationLeaseId) {
  const pathname = `/api/tasks/${encodeURIComponent(ready.task.id)}/bootstrap-claim`;
  const body = {
    rootThreadId: ready.binding.threadId,
    ownedCodexHostId: "local",
    expectedResumeToken: ready.capsule.resumeToken,
    safeActionId: ready.capsule.readyWork.safeActions[0].id,
    reservationLeaseId,
  };
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...executionHeaders(harness.secret, pathname, body, execution),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function postBootstrapDelivery(harness, ready, execution, reservationLeaseId) {
  const pathname = `/api/tasks/${encodeURIComponent(ready.task.id)}/bootstrap-delivery`;
  const body = {
    rootThreadId: ready.binding.threadId,
    expectedResumeToken: ready.capsule.resumeToken,
    safeActionId: ready.capsule.readyWork.safeActions[0].id,
    reservationLeaseId,
  };
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...executionHeaders(harness.secret, pathname, body, execution),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function postUnfencedBootstrapClaim(harness, ready, reservationLeaseId, headers = {}) {
  const pathname = `/api/tasks/${encodeURIComponent(ready.task.id)}/bootstrap-claim`;
  const body = {
    rootThreadId: ready.binding.threadId,
    ownedCodexHostId: "local",
    expectedResumeToken: ready.capsule.resumeToken,
    safeActionId: ready.capsule.readyWork.safeActions[0].id,
    reservationLeaseId,
  };
  const response = await fetch(`${harness.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("independent identical RPC occurrences never share one permanent effect identity", () => {
  const input = {
    codexHostId: "local",
    method: "thread/start",
    params: { cwd: "/tmp/worktree", threadSource: "taskboard-provision-attempt" },
  };
  const first = createHostExecutorEffectKey({ ...input, occurrenceId: "occurrence-1" });
  const replay = createHostExecutorEffectKey({ ...input, occurrenceId: "occurrence-1" });
  const next = createHostExecutorEffectKey({ ...input, occurrenceId: "occurrence-2" });
  assert.equal(first, replay, "one HTTP occurrence retains one retry identity");
  assert.notEqual(first, next, "a later legitimate occurrence is never replayed forever");
});

test("a definite capacity rejection releases the effect for an exact retry", async () => {
  const capacity = "Selected model is at capacity. Please try a different model.";
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:45:00.000Z"),
    requestReady: ({ calls }) => calls.length === 1
      ? Promise.reject(new CodexAppServerError(capacity, null, { definitiveRejection: true }))
      : Promise.resolve({ thread: { id: "thread-after-capacity" } }),
  });
  const executor = harness.lifecycle("executor-capacity");
  await executor.start();
  const execution = executor.executionEnvelope();
  const operations = [{ method: "thread/start", params: { cwd: "/tmp/worktree" } }];

  await assert.rejects(
    () => harness.api.executeEffect({
      effectKey: "capacity-retry", execution, operations,
    }),
    (error) => error?.status === 503
      && error?.code === "HOST_EXECUTOR_MODEL_CAPACITY"
      && error?.message === capacity,
  );

  const second = await harness.api.executeEffect({
    effectKey: "capacity-retry", execution, operations,
  });
  assert.equal(second.results?.[0]?.thread?.id, "thread-after-capacity");
  assert.equal(harness.calls.length, 2, "the same semantic effect reaches the adapter again");
});

test("a non-capacity RPC rejection becomes uncertain and is never re-dispatched", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:47:00.000Z"),
    requestReady: ({ calls }) => calls.length === 1
      ? Promise.reject(new CodexAppServerError(
        "Codex rejected the mutation after accepting the request",
        null,
        { definitiveRejection: true },
      ))
      : Promise.resolve({ thread: { id: "must-not-be-created" } }),
  });
  const executor = harness.lifecycle("executor-rpc-rejection");
  await executor.start();
  const execution = executor.executionEnvelope();
  const input = {
    effectKey: "ordinary-rpc-rejection",
    execution,
    operations: [{ method: "thread/start", params: { cwd: "/tmp/worktree" } }],
  };

  await assert.rejects(
    () => harness.api.executeEffect(input),
    (error) => error?.status === 502 && error?.code === "HOST_EXECUTOR_RPC_REJECTED",
  );
  await assert.rejects(
    () => harness.api.executeEffect(input),
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
  );
  assert.equal(harness.calls.length, 1, "an uncertain mutation is never sent twice");
});

test("an unfenced resident HTTP mutation fails closed before the first registration", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:50:00.000Z"),
  });
  const ready = createReadyTask(harness);
  const rejected = await postUnfencedBootstrapClaim(
    harness, ready, "unfenced-resident",
  );
  assert.deepEqual(
    [rejected.status, rejected.body?.error?.code],
    [403, "HOST_EXECUTOR_PROOF_REQUIRED"],
  );

  const manual = await postUnfencedBootstrapClaim(
    harness,
    ready,
    "manual-taskctl",
    { "x-taskboard-client": "taskctl" },
  );
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
});

function enrollTerminalTask(harness, ready, suffix = "first") {
  const db = harness.app.database;
  return db.appendTaskContinuation(ready.task.id, {
    eventId: `agreement-${ready.task.id}-${suffix}`,
    idempotencyKey: `agreement-${suffix}`,
    senderThreadId: db.getTask(ready.task.id).threadId,
    expectedRecordId: db.getTaskContinuation(ready.task.id).record?.eventId ?? null,
    expectedResumeToken: db.getTaskCapsule(ready.task.id).resumeToken,
    goal: "Observe a bound thread without dispatching",
    sourceRefs: ["test:owned-terminal"], authorizationSource: null, actionIds: [],
    stopBoundary: "No automatic continuation", status: "active",
    checkpoint: { summary: "Enrolled", nextActionId: null, waitingKind: "none", waitingDetail: null, retryAt: null },
  }).event;
}

function terminalNotification(turnId, status = "completed", threadId = "root-thread") {
  return { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } };
}

function terminalSubscription() {
  const listeners = new Set();
  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(notification) { return [...listeners].flatMap((listener) => listener(notification)); },
  };
}

function terminalReceiptRows(harness) {
  return harness.app.database.database.prepare(`
    SELECT envelope_json FROM agent_event_receipts
    WHERE json_extract(envelope_json, '$.eventType') = 'continuation_owned_terminal' ORDER BY rowid
  `).all().map((row) => JSON.parse(row.envelope_json));
}

function stateOutsideEventReceipts(harness) {
  const db = harness.app.database.database;
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .filter(({ name }) => name !== "agent_event_receipts")
    .map(({ name }) => [name, createHash("sha256")
      .update(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).digest("hex")]));
}

test("owned terminal D1: default adapter notification is a whitelisted historical checkpoint, not dispatch authority", async () => {
  const harness = await launchHarness({ useDefaultAdapter: true });
  const ready = createReadyTask(harness);
  const agreement = enrollTerminalTask(harness, ready);
  const before = stateOutsideEventReceipts(harness);
  const resumeToken = harness.app.database.getTaskCapsule(ready.task.id).resumeToken;
  const notification = terminalNotification("terminal-1");
  notification.params.turn.error = { message: "private-error-must-not-be-retained" };
  notification.params.item = { text: "private-item-must-not-be-retained" };
  notification.params.source = "untrusted-producer";
  for (const listener of harness.app.aiChat.appServer.listeners) listener(notification);
  const response = await fetch(`${harness.baseUrl}/api/local/tasks/${ready.task.id}/continuation`);
  assert.equal(response.status, 200);
  const assessment = await response.json();
  const checkpoint = assessment.recordedTerminalCheckpoint;
  assert.deepEqual(Object.keys(checkpoint).sort(), [
    "eventId", "eventType", "taskId", "projectId", "source", "codexHostId", "threadId", "turnId", "turnStatus",
    "continuationRecordId", "bindingAtObservation", "requirementsRevision", "observedAt",
  ].sort());
  assert.equal(checkpoint.eventType, "continuation_owned_terminal");
  assert.equal(checkpoint.source, "taskboard-server-owned-app-server");
  assert.equal(checkpoint.continuationRecordId, agreement.eventId);
  assert.deepEqual(checkpoint.bindingAtObservation, ready.binding);
  assert.equal(checkpoint.requirementsRevision, harness.app.database.getTaskCapsule(ready.task.id).requirementsRevision);
  assert.equal(checkpoint.turnStatus, "completed");
  assert.ok(Number.isFinite(Date.parse(checkpoint.observedAt)));
  assert.equal(assessment.liveExecution, "unknown");
  assert.equal(assessment.eligibleForDispatch, false);
  assert.deepEqual(stateOutsideEventReceipts(harness), before);
  assert.equal(harness.app.database.getTaskCapsule(ready.task.id).resumeToken, resumeToken);
  assert.equal(harness.app.aiChat.appServer.child, null);
  assert.deepEqual(harness.calls, []);
});

test("owned terminal D2: statuses and exact enrolled local binding scope use only the selected adapter", async () => {
  const subscription = terminalSubscription();
  const harness = await launchHarness({ subscribe: subscription.subscribe });
  const first = createReadyTask(harness);
  const shared = createReadyTask(harness);
  const remote = createReadyTask(harness);
  const otherThread = createReadyTask(harness);
  const incomplete = createReadyTask(harness);
  const unenrolled = createReadyTask(harness);
  for (const ready of [first, shared, remote, otherThread, incomplete]) enrollTerminalTask(harness, ready);
  for (const [ready, change] of [
    [remote, { codexHostId: "remote-host", codexProjectKind: "remote" }],
    [otherThread, { threadId: "other-thread" }],
    [incomplete, { workspacePath: null }],
  ]) {
    harness.app.database.updateTask(ready.task.id, ready.task.version, {}, undefined, { ...ready.binding, ...change });
  }
  for (const notification of [
    null, {}, { method: "item/completed" }, terminalNotification("", "completed"),
    terminalNotification("t", "running"), terminalNotification("t", "unknown"),
    terminalNotification("t", "completed", ""), { ...terminalNotification("t"), id: 1 },
    { method: "turn/completed", params: { threadId: "root-thread" } },
  ]) assert.deepEqual(subscription.emit(notification), []);
  assert.equal(terminalReceiptRows(harness).length, 0);
  for (const status of ["completed", "interrupted", "failed"]) {
    subscription.emit(terminalNotification(`turn-${status}`, status));
    for (const ready of [first, shared]) {
      assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint.turnStatus, status);
    }
  }
  assert.deepEqual(new Set(terminalReceiptRows(harness).map((event) => event.taskId)), new Set([first.task.id, shared.task.id]));
  assert.equal(terminalReceiptRows(harness).length, 6);
  for (const ready of [remote, otherThread, incomplete, unenrolled]) {
    assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, null);
  }
  assert.deepEqual(harness.calls, []);

  const unavailable = await launchHarness(); // Explicit override without subscribe must not fall back to aiChat.
  const notObserved = createReadyTask(unavailable);
  enrollTerminalTask(unavailable, notObserved);
  for (const listener of unavailable.app.aiChat.appServer.listeners) listener(terminalNotification("unavailable"));
  assert.equal(unavailable.app.database.getTaskContinuation(notObserved.task.id).recordedTerminalCheckpoint, null);
  assert.equal(terminalReceiptRows(unavailable).length, 0);
});

test("owned terminal D3: first receipt survives replay, conflict and reopen without rebinding to changed context", async () => {
  const subscription = terminalSubscription();
  let harness = await launchHarness({ subscribe: subscription.subscribe });
  const ready = createReadyTask(harness);
  enrollTerminalTask(harness, ready);
  const notification = terminalNotification("stable-turn", "interrupted");
  subscription.emit(notification);
  const first = harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint;
  harness.app.database.updateTask(ready.task.id, ready.task.version,
    { description: "Changed requirements" }, undefined, undefined, ready.task.assignee);
  assert.equal(subscription.emit(notification)[0].applied, false);
  assert.equal(subscription.emit(terminalNotification("stable-turn", "failed"))[0].conflict, true);
  assert.deepEqual(terminalReceiptRows(harness), [first]);
  await harness.app.close();
  running.find((entry) => entry.app === harness.app).closed = true;
  harness = await launchHarness({ subscribe: subscription.subscribe, reopenDirectory: harness.directory });
  assert.deepEqual(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, first);
  assert.equal(subscription.emit(notification)[0].applied, false);

  const replacement = enrollTerminalTask(harness, ready, "replacement");
  assert.notEqual(replacement.eventId, first.continuationRecordId);
  assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, null);
  subscription.emit(notification);
  assert.deepEqual(terminalReceiptRows(harness), [first]);
  assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, null);
  subscription.emit(terminalNotification("new-context"));
  const next = harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint;
  assert.equal(next.continuationRecordId, replacement.eventId);
  assert.notEqual(next.requirementsRevision, first.requirementsRevision);
  const current = harness.app.database.getTask(ready.task.id);
  harness.app.database.updateTask(current.id, current.version, {}, undefined, {
    ...ready.binding, workspacePath: `${harness.worktreePath}-changed`,
  });
  assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, null);
  subscription.emit(terminalNotification("new-context"));
  assert.deepEqual(terminalReceiptRows(harness), [first, next]);
  assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint, null);
});

test("owned terminal D4: latest means receipt order and the listener unsubscribes before database close", async () => {
  const subscription = terminalSubscription();
  let harness;
  let unsubscribedWithOpenDatabase = false;
  harness = await launchHarness({ subscribe(listener) {
    const unsubscribe = subscription.subscribe(listener);
    return () => {
      assert.equal(harness.app.database.database.prepare("SELECT 1 AS value").get().value, 1);
      unsubscribedWithOpenDatabase = true;
      unsubscribe();
    };
  } });
  const ready = createReadyTask(harness);
  enrollTerminalTask(harness, ready);
  const newer = terminalNotification("native-newer");
  newer.params.turn.startedAt = "2027-01-01T00:00:00Z";
  const older = terminalNotification("native-older", "failed");
  older.params.turn.startedAt = "2025-01-01T00:00:00Z";
  subscription.emit(newer);
  subscription.emit(older);
  subscription.emit(newer);
  assert.equal(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalCheckpoint.turnId, "native-older");
  assert.equal(terminalReceiptRows(harness).length, 2);
  await harness.app.close();
  running.find((entry) => entry.app === harness.app).closed = true;
  assert.equal(unsubscribedWithOpenDatabase, true);
  assert.equal(subscription.listeners.size, 0);
  assert.deepEqual(subscription.emit(terminalNotification("after-close")), []);
});

test("expired executor cannot mutate or deliver after a competing lease takes over", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T10:00:00.000Z"),
  });
  const executorA = harness.lifecycle("executor-a");
  const executorB = harness.lifecycle("executor-b");
  const stateA = await executorA.start();
  const executionA = executorA.executionEnvelope();
  assert.equal(Object.isFrozen(executionA), true);

  let resumeA;
  const outerGate = new Promise((resolve) => { resumeA = resolve; });
  const attemptA = (async () => {
    assert.equal(executorA.isActive(), true, "A passes the resident outer gate");
    await outerGate;
    return postEffect(
      harness.baseUrl,
      harness.secret,
      "continuation:receipt-1",
      executionA,
      [{ method: "turn/start", params: { threadId: "root-1" } }],
      41,
    );
  })();

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  const stateB = await executorB.start();
  assert.notEqual(stateB.lease.id, stateA.lease.id);
  const deliveredB = await postEffect(
    harness.baseUrl,
    harness.secret,
    "continuation:receipt-1",
    executorB.executionEnvelope(),
    [{ method: "turn/start", params: { threadId: "root-1" } }],
    42,
  );
  assert.equal(deliveredB.status, 200);
  assert.equal(harness.calls.length, 1);

  resumeA();
  const rejectedA = await attemptA;
  assert.deepEqual(
    [rejectedA.status, rejectedA.body?.error?.code],
    [409, "HOST_EXECUTOR_LEASE_STALE"],
  );
  assert.equal(harness.calls.length, 1, "A performs zero external delivery");

  const replayB = await postEffect(
    harness.baseUrl,
    harness.secret,
    "continuation:receipt-1",
    executorB.executionEnvelope(),
    [{ method: "turn/start", params: { threadId: "root-1" } }],
    43,
  );
  assert.equal(replayB.status, 200);
  assert.equal(harness.calls.length, 1, "B's semantic effect is delivered exactly once");

  const conflictingReplayB = await postEffect(
    harness.baseUrl,
    harness.secret,
    "continuation:receipt-1",
    executorB.executionEnvelope(),
    [{ method: "turn/start", params: { threadId: "different-root" } }],
    44,
  );
  assert.deepEqual(
    [conflictingReplayB.status, conflictingReplayB.body?.error?.code],
    [409, "HOST_EXECUTOR_EFFECT_IDEMPOTENCY_CONFLICT"],
  );
  assert.equal(harness.calls.length, 1, "a reused key with a different payload cannot deliver");

  const inspection = new DatabaseSync(path.join(harness.directory, "taskboard.sqlite"));
  const effects = inspection.prepare(`
    SELECT executor_instance_id, lease_id, status FROM host_executor_effects
  `).all().map((row) => ({ ...row }));
  inspection.close();
  assert.deepEqual(effects, [{
    executor_instance_id: "executor-b",
    lease_id: stateB.lease.id,
    status: "completed",
  }]);
});

test("expired executor cannot write a continuation receipt after takeover", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T10:30:00.000Z"),
  });
  const ready = createReadyTask(harness);
  const executorA = harness.lifecycle("executor-a");
  const executorB = harness.lifecycle("executor-b");
  const stateA = await executorA.start();
  const executionA = executorA.executionEnvelope();

  let resumeA;
  const outerGate = new Promise((resolve) => { resumeA = resolve; });
  const attemptA = (async () => {
    assert.equal(executorA.isActive(), true, "A passes the resident outer gate");
    await outerGate;
    return postBootstrapClaim(harness, ready, executionA, "reservation-a");
  })();

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  const stateB = await executorB.start();
  const acceptedB = await postBootstrapClaim(
    harness,
    ready,
    executorB.executionEnvelope(),
    "reservation-b",
  );
  assert.equal(acceptedB.status, 200, JSON.stringify(acceptedB.body));

  resumeA();
  const rejectedA = await attemptA;
  assert.deepEqual(
    [rejectedA.status, rejectedA.body?.error?.code],
    [409, "HOST_EXECUTOR_LEASE_STALE"],
  );
  const receipts = harness.app.database.database.prepare(`
    SELECT reservation_lease_id FROM task_safe_action_receipts WHERE task_id = ?
  `).all(ready.task.id).map((row) => ({ ...row }));
  assert.deepEqual(receipts, [{ reservation_lease_id: "reservation-b" }]);
  assert.notEqual(stateB.lease.id, stateA.lease.id);
});

test("expired executor cannot refresh repository metadata before delivery fencing", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T10:45:00.000Z"),
  });
  const ready = createReadyTask(harness);
  const executorA = harness.lifecycle("executor-a");
  const executorB = harness.lifecycle("executor-b");
  const stateA = await executorA.start();
  const executionA = executorA.executionEnvelope();
  const reservationLeaseId = "reservation-repository-fence";
  const reservation = await postBootstrapClaim(
    harness,
    ready,
    executionA,
    reservationLeaseId,
  );
  assert.equal(reservation.status, 200, JSON.stringify(reservation.body));

  harness.app.database.recordTaskWorktreeRepository(ready.task.id, {
    worktreePath: harness.worktreePath,
    expectedBranch: "codex/host-fence",
    repository: "owner/repository-before-takeover",
    verifiedAt: "2026-09-08T10:45:01.000Z",
  });
  const before = harness.app.database.getTask(ready.task.id).developmentContext;

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  await executorB.start();
  const rejectedA = await postBootstrapDelivery(
    harness,
    ready,
    executionA,
    reservationLeaseId,
  );
  assert.deepEqual(
    [rejectedA.status, rejectedA.body?.error?.code],
    [409, "HOST_EXECUTOR_LEASE_STALE"],
  );
  const after = harness.app.database.getTask(ready.task.id).developmentContext;
  assert.deepEqual(
    {
      repository: after.repository,
      repositoryVerifiedAt: after.repositoryVerifiedAt,
    },
    {
      repository: before.repository,
      repositoryVerifiedAt: before.repositoryVerifiedAt,
    },
    "a stale delivery must perform zero repository metadata mutation",
  );
});

test("takeover between reservation and final fence prevents stale Codex dispatch", async () => {
  let releaseFinalFence;
  const finalFence = new Promise((resolve) => { releaseFinalFence = resolve; });
  let reservationReached;
  const reserved = new Promise((resolve) => { reservationReached = resolve; });
  let pauseOnce = true;
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T11:00:00.000Z"),
    afterReserve: async () => {
      if (!pauseOnce) return;
      pauseOnce = false;
      reservationReached();
      await finalFence;
    },
  });
  const executorA = harness.lifecycle("executor-a");
  const executorB = harness.lifecycle("executor-b");
  const stateA = await executorA.start();
  const requestA = postEffect(
    harness.baseUrl,
    harness.secret,
    "continuation:receipt-2",
    executorA.executionEnvelope(),
    [{ method: "turn/start", params: { threadId: "root-2" } }],
    51,
  );
  await reserved;

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  const stateB = await executorB.start();
  assert.notEqual(stateB.lease.id, stateA.lease.id);
  releaseFinalFence();

  const rejectedA = await requestA;
  assert.deepEqual(
    [rejectedA.status, rejectedA.body?.error?.code],
    [409, "HOST_EXECUTOR_LEASE_STALE"],
  );
  assert.equal(harness.calls.length, 0, "adapter is untouched after A loses the final fence");
});
