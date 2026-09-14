import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as createHttpRequest } from "node:http";
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
import { runTaskboardContinuationMonitorOnce } from "../scripts/codex-injector-runtime.mjs";

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry.closed) await entry.app.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

function signedHeaders(secret, pathname, body, sequence, method = "POST") {
  const nonce = sequence.toString(16).padStart(32, "0");
  const issuedAt = String(Date.now());
  return {
    "content-type": "application/json",
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-issued-at": issuedAt,
    "x-codex-taskboard-injector-proof": createHmac("sha256", secret)
      .update(JSON.stringify({ nonce, issuedAt, method, pathname, body }))
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

function createReadyTask(harness, overrides = {}) {
  const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  const binding = overrides.threadBinding ?? {
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
    ...overrides,
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

function recordedEffectMetadata(harness, effectKey) {
  const row = harness.app.database.database.prepare(`
    SELECT * FROM host_executor_effects WHERE effect_key = ?
  `).get(effectKey);
  assert.ok(row, "the fixture has an authoritative effect record");
  return {
    effectKey: row.effect_key,
    codexHostId: row.codex_host_id,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

test("effect inspection recovers recorded completion after the outer execute response is lost", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:48:00.000Z"),
  });
  const executor = harness.lifecycle("executor-lost-response");
  await executor.start();
  const effectKey = "inspection:lost-response";
  let expected;
  let dropped = false;
  const api = createHostExecutorApi({
    baseUrl: harness.baseUrl,
    instanceSecret: harness.secret,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === "POST") {
        expected = recordedEffectMetadata(harness, effectKey);
        assert.equal(expected.status, "completed", "the authority commit precedes response loss");
        await response.body.cancel();
        dropped = true;
        throw new Error("outer execute response lost");
      }
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return response;
    },
  });
  await assert.rejects(() => api.executeEffect({
    effectKey,
    execution: executor.executionEnvelope(),
    operations: [{ method: "turn/start", params: { threadId: "synthetic-root" } }],
  }), /outer execute response lost/);
  assert.equal(dropped, true);
  const inspection = await api.inspectEffect({ codexHostId: "local", effectKey });
  assert.deepEqual(inspection, {
    found: true,
    effect: expected,
    queriedAt: new Date(harness.clock.value).toISOString(),
    observationOnly: true,
  });
  assert.equal(harness.calls.length, 1, "inspection never redispatches the completed effect");
});

test("effect inspection reports an uncertain record without redispatch", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:48:10.000Z"),
    requestReady: () => Promise.reject(new CodexAppServerError(
      "Synthetic uncertain RPC result", null, { definitiveRejection: true },
    )),
  });
  const executor = harness.lifecycle("executor-inspect-uncertain");
  await executor.start();
  const effectKey = "inspection:uncertain";
  await assert.rejects(() => harness.api.executeEffect({
    effectKey,
    execution: executor.executionEnvelope(),
    operations: [{ method: "turn/start", params: { threadId: "synthetic-root" } }],
  }), (error) => error?.status === 502 && error?.code === "HOST_EXECUTOR_RPC_REJECTED");
  const expected = recordedEffectMetadata(harness, effectKey);
  assert.equal(expected.status, "uncertain");
  assert.deepEqual(await harness.api.inspectEffect({ codexHostId: "local", effectKey }), {
    found: true,
    effect: expected,
    queriedAt: new Date(harness.clock.value).toISOString(),
    observationOnly: true,
  });
  assert.equal(harness.calls.length, 1, "inspection does not retry an uncertain RPC");
});

test("effect inspection preserves old records and expired leases on found, absent and wrong-host reads", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:48:20.000Z"),
  });
  createReadyTask(harness);
  const executor = harness.lifecycle("executor-inspect-expired");
  const started = await executor.start();
  const effectKey = "inspection:retained";
  await harness.api.executeEffect({
    effectKey,
    execution: executor.executionEnvelope(),
    operations: [{ method: "turn/start", params: { threadId: "synthetic-root" } }],
  });
  const expected = recordedEffectMetadata(harness, effectKey);
  harness.clock.value += 25 * 60 * 60 * 1_000;
  assert.ok(harness.clock.value > Date.parse(started.lease.expiresAt));
  const snapshot = () => Object.fromEntries([
    "tasks", "host_executor_effects", "host_executor_leases",
    "host_executor_registrations", "host_executor_lease_receipts",
  ].map((table) => [table, harness.app.database.database.prepare(
    `SELECT * FROM ${table} ORDER BY rowid`,
  ).all().map((row) => ({ ...row }))]));
  const nonceCount = () => harness.app.database.database.prepare(
    "SELECT COUNT(*) AS count FROM host_executor_proof_nonces",
  ).get().count;
  const before = snapshot();
  const noncesBefore = nonceCount();
  assert.deepEqual(await harness.api.inspectEffect({ codexHostId: "local", effectKey }), {
    found: true,
    effect: expected,
    queriedAt: new Date(harness.clock.value).toISOString(),
    observationOnly: true,
  });
  for (const input of [
    { codexHostId: "local", effectKey: "inspection:absent" },
    { codexHostId: "remote-builder", effectKey },
  ]) {
    assert.deepEqual(await harness.api.inspectEffect(input), {
      found: false,
      effect: null,
      queriedAt: new Date(harness.clock.value).toISOString(),
      observationOnly: true,
    });
  }
  assert.deepEqual(snapshot(), before, "inspection changes no task, effect or lease state");
  assert.equal(nonceCount(), noncesBefore + 3, "only request-proof nonce bookkeeping changes");
  assert.equal(harness.calls.length, 1);
});

test("effect inspection requires fresh proof and exposes only bounded metadata", async () => {
  const harness = await launchHarness({
    currentTime: Date.parse("2026-09-08T09:48:30.000Z"),
  });
  const executor = harness.lifecycle("executor-inspect-proof");
  await executor.start();
  const effectKey = "inspection:protected";
  await harness.api.executeEffect({
    effectKey,
    execution: executor.executionEnvelope(),
    operations: [{ method: "turn/start", params: { threadId: "synthetic-private-payload" } }],
  });
  const pathname = `/api/local/host-executors/local/effects/${encodeURIComponent(effectKey)}`;
  const get = async (route, headers) => {
    const response = await fetch(`${harness.baseUrl}${route}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const missingProof = await get(pathname);
  assert.deepEqual([missingProof.status, missingProof.body?.error?.code], [403, "INJECTOR_PROOF_REQUIRED"]);
  const invalidProof = await get(pathname, {
    ...signedHeaders(harness.secret, pathname, null, 901, "GET"),
    "x-codex-taskboard-injector-proof": "0".repeat(64),
  });
  assert.deepEqual([invalidProof.status, invalidProof.body?.error?.code], [403, "INJECTOR_PROOF_REQUIRED"]);
  const headers = signedHeaders(harness.secret, pathname, null, 902, "GET");
  const fresh = await get(pathname, headers);
  assert.equal(fresh.status, 200);
  assert.deepEqual(Object.keys(fresh.body).sort(), ["effect", "found", "observationOnly", "queriedAt"]);
  assert.deepEqual(Object.keys(fresh.body.effect).sort(), [
    "codexHostId", "createdAt", "effectKey", "requestFingerprint", "status", "updatedAt",
  ]);
  assert.deepEqual(fresh.body.effect, recordedEffectMetadata(harness, effectKey));
  const replay = await get(pathname, headers);
  assert.deepEqual([replay.status, replay.body?.error?.code], [403, "INJECTOR_PROOF_REQUIRED"]);

  let sequence = 903;
  for (const [route, code] of [
    ["/api/local/host-executors/%20bad-host/effects/key", "INVALID_FIELD"],
    ["/api/local/host-executors/local/effects/%20invalid", "INVALID_FIELD"],
    [`${pathname}?unexpected=1`, "UNKNOWN_QUERY_PARAMETER"],
  ]) {
    const rejected = await get(route, signedHeaders(harness.secret, route, null, sequence++, "GET"));
    assert.deepEqual([rejected.status, rejected.body?.error?.code], [400, code]);
  }
  const requestBody = JSON.stringify({ notSignedAsNull: true });
  const bodyResponse = await new Promise((resolve, reject) => {
    const request = createHttpRequest(`${harness.baseUrl}${pathname}`, {
      method: "GET",
      headers: {
        ...signedHeaders(harness.secret, pathname, null, sequence++, "GET"),
        "content-length": Buffer.byteLength(requestBody),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end(requestBody);
  });
  assert.deepEqual([bodyResponse.status, bodyResponse.body?.error?.code], [400, "INVALID_BODY"]);
  assert.equal(harness.calls.length, 1);
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

function recordedHoldInput(harness, ready, status, suffix) {
  const db = harness.app.database;
  return {
    eventId: `recorded-hold-${ready.task.id}-${suffix}`, idempotencyKey: `recorded-hold-${suffix}`,
    senderThreadId: db.getTask(ready.task.id).threadId,
    expectedRecordId: db.getTaskContinuation(ready.task.id).record?.eventId ?? null,
    expectedResumeToken: db.getTaskCapsule(ready.task.id).resumeToken,
    goal: "Honor the recorded stop boundary", sourceRefs: ["test:recorded-hold"],
    authorizationSource: null, actionIds: [], stopBoundary: "No new automatic admission while held", status,
    checkpoint: { summary: suffix, nextActionId: null, waitingKind: "none", waitingDetail: null, retryAt: null },
  };
}

test("recorded hold D1: persisted holds inhibit ordinary and capacity selection without starving a ready peer", async (t) => {
  let heldFixture;
  for (const [status, reason] of [
    ["paused", "CONTINUATION_PAUSED"], ["canceled", "CONTINUATION_CANCELED"],
    ["endpoint_reached", "CONTINUATION_ENDPOINT_REACHED"],
  ]) {
    const harness = await launchHarness();
    const binding = {
      threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexProjectId: "local-project",
      codexProjectKind: "local", codexHostId: "local", workspacePath: harness.worktreePath,
    };
    const ready = createReadyTask(harness, { threadBinding: binding });
    const db = harness.app.database;
    db.upsertAgentLaneProject("local", {
      rootTaskId: "root", tasks: [{ id: "root", label: "Root", owner: "Codex", source: "codex",
        taskType: "root_task", ...binding }], adapters: [],
    });
    const before = db.getTaskCapsule(ready.task.id);
    assert.equal(before.readyWork.eligible, true);
    const recorded = db.appendTaskContinuation(ready.task.id, recordedHoldInput(harness, ready, status, status));
    const held = db.getTaskCapsule(ready.task.id);
    assert.equal(held.readyWork.eligible, false);
    assert.deepEqual(held.readyWork.reasonCodes, [reason]);
    assert.deepEqual(held.authorization, before.authorization);
    assert.equal(held.readyWork.approvalRequest, null);
    assert.equal(held.readyWork.ownerDecisionRequest, null);
    const snapshot = await (await fetch(`${harness.baseUrl}/api/local/projects/local/agent-lanes`)).json();
    const todo = snapshot.todos.find((candidate) => candidate.taskId === ready.task.id);
    assert.deepEqual(todo.readyWork.reasonCodes, [reason]);
    assert.equal(todo.readyWork.eligible, false);
    const calls = [];
    const unexpected = (name) => async (request) => { calls.push([name, request.taskId]); assert.fail(`${name} selected held task`); };
    await runTaskboardContinuationMonitorOnce({
      hostExecutor: { ownedCodexHostId: "local" },
      policy: { enabled: true, projectId: "local", maxActiveAgents: 2, capacityObservationMaxAgeMs: 60_000 },
      readSnapshot: async () => snapshot,
      claimReceipt: unexpected("claim"), confirmDelivery: unexpected("confirm"), deliver: unexpected("deliver"),
      completeDelivery: unexpected("complete"), requestCapacityObservation: unexpected("capacity-probe"),
    });
    assert.deepEqual(calls, []);
    t.diagnostic(JSON.stringify({ case: "D1", taskId: ready.task.id, recordId: recorded.event.eventId,
      status, reason, eligible: held.readyWork.eligible, heldTaskCalls: calls.length }));
    heldFixture = { harness, ready, binding, todo };
  }
  const { harness, ready: held, binding, todo: heldTodo } = heldFixture;
  const peer = createReadyTask(harness, { threadBinding: binding });
  const mixed = await (await fetch(`${harness.baseUrl}/api/local/projects/local/agent-lanes`)).json();
  const peerTodo = mixed.todos.find((candidate) => candidate.taskId === peer.task.id);
  assert.equal(peerTodo.readyWork.eligible, true);
  const calls = [];
  const result = await runTaskboardContinuationMonitorOnce({
    hostExecutor: { ownedCodexHostId: "local" }, policy: { enabled: true, projectId: "local" },
    readSnapshot: async () => ({ ...mixed, todos: [heldTodo, peerTodo] }),
    claimReceipt: async (request) => {
      calls.push(["claim", request.taskId]);
      return { available: true, completed: false, receipt: { id: "peer-receipt", reservationLeaseId: "peer-lease" } };
    },
    confirmDelivery: async (request) => {
      calls.push(["confirm", request.taskId]);
      return { worktreePath: harness.worktreePath, branch: "codex/host-fence" };
    },
    deliver: async (request) => { calls.push(["deliver", request.taskId]); return { delivery: "started", turnId: "peer-turn" }; },
    completeDelivery: async (request) => { calls.push(["complete", request.taskId]); return { completed: true }; },
    requestCapacityObservation: async (request) => { calls.push(["capacity-probe", request.taskId]); },
  });
  assert.equal(result.delivered, true);
  assert.equal(result.todoId, peerTodo.id);
  assert.equal(calls.some(([, taskId]) => taskId === held.task.id), false);
  assert.deepEqual(calls, ["claim", "confirm", "deliver", "complete"].map((name) => [name, peer.task.id]));
  t.diagnostic(JSON.stringify({ case: "D1-mixed", heldTaskId: held.task.id, selectedPeerTaskId: peer.task.id, heldTaskCalls: 0, peerCalls: calls.length }));
});

test("recorded hold D3: a pause committed after reservation rejects the tagged start at its final token fence", async (t) => {
  let attempt;
  let recorded;
  const harness = await launchHarness({ afterReserve() {
    recorded = harness.app.database.appendTaskContinuation(attempt.ready.task.id,
      recordedHoldInput(harness, attempt.ready, "paused", "after-reserve"));
  } });
  attempt = await confirmRoutedAttempt(harness);
  await assert.rejects(harness.api.executeEffect(attempt.effect), (error) => (
    error.status === 409 && error.code === "ORDINARY_DELIVERY_IDENTITY_MISMATCH"
  ));
  const row = harness.app.database.database.prepare("SELECT * FROM host_executor_effects WHERE effect_key = ?").get(attempt.effect.effectKey);
  assert.equal(row.status, "reserved");
  assert.equal(row.dispatch_token, null);
  assert.equal(row.result_json, null);
  assert.equal(harness.calls.filter((call) => call.method === "turn/start").length, 0);
  assert.equal(routedRows(harness)[0].effect_key, null);
  t.diagnostic(JSON.stringify({ case: "D3", taskId: attempt.ready.task.id, recordId: recorded.event.eventId,
    receiptId: attempt.receipt.id, attemptId: attempt.receipt.admissionAttemptId,
    effectStatus: row.status, errorCode: "ORDINARY_DELIVERY_IDENTITY_MISMATCH", submittedStarts: 0 }));
});

test("recorded hold D4: real append replay and reopen preserve latest non-ABA tokens and reject a stale append", async (t) => {
  let harness = await launchHarness();
  const ready = createReadyTask(harness);
  let db = harness.app.database;
  const activeA = recordedHoldInput(harness, ready, "active", "active-a");
  db.appendTaskContinuation(ready.task.id, activeA);
  const tokenA = db.getTaskCapsule(ready.task.id).resumeToken;
  const holdH = recordedHoldInput(harness, ready, "paused", "hold-h");
  const storedH = db.appendTaskContinuation(ready.task.id, holdH);
  const tokenH = db.getTaskCapsule(ready.task.id).resumeToken;
  assert.notEqual(tokenH, tokenA);
  assert.deepEqual(db.appendTaskContinuation(ready.task.id, holdH), { applied: false, event: storedH.event });
  assert.equal(db.getTaskCapsule(ready.task.id).resumeToken, tokenH);
  const activeB = recordedHoldInput(harness, ready, "active", "active-b");
  const storedB = db.appendTaskContinuation(ready.task.id, activeB);
  const tokenB = db.getTaskCapsule(ready.task.id).resumeToken;
  assert.notEqual(tokenB, tokenH);
  assert.notEqual(tokenB, tokenA);
  assert.deepEqual(db.appendTaskContinuation(ready.task.id, holdH), { applied: false, event: storedH.event });
  assert.equal(db.getTaskContinuation(ready.task.id).record.eventId, storedB.event.eventId);
  assert.equal(db.getTaskCapsule(ready.task.id).resumeToken, tokenB);
  await harness.app.close();
  running.find((entry) => entry.app === harness.app).closed = true;
  harness = await launchHarness({ reopenDirectory: harness.directory });
  db = harness.app.database;
  assert.deepEqual(db.getTaskContinuation(ready.task.id).record, storedB.event);
  assert.equal(db.getTaskCapsule(ready.task.id).resumeToken, tokenB);
  const stale = { ...recordedHoldInput(harness, ready, "paused", "stale"), expectedResumeToken: tokenH };
  assert.equal(stale.expectedRecordId, storedB.event.eventId);
  assert.throws(() => db.appendTaskContinuation(ready.task.id, stale), (error) => error.code === "CONTINUATION_STALE");
  assert.equal(db.getTaskContinuation(ready.task.id).record.eventId, storedB.event.eventId);
  assert.equal(db.getTaskCapsule(ready.task.id).resumeToken, tokenB);
  const count = db.database.prepare("SELECT COUNT(*) AS count FROM agent_event_receipts WHERE task_id = ? AND json_extract(envelope_json, '$.eventType') = 'continuation_record'").get(ready.task.id).count;
  assert.equal(count, 3);
  t.diagnostic(JSON.stringify({ case: "D4", taskId: ready.task.id, activeA: activeA.eventId, holdH: holdH.eventId,
    latest: storedB.event.eventId, distinctTokens: new Set([tokenA, tokenH, tokenB]).size,
    persistedRecords: count, replayStable: true, reopenStable: true, staleAppend: "CONTINUATION_STALE" }));
});

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

function stateOutsideEventReceipts(harness, excluded = ["agent_event_receipts"]) {
  const db = harness.app.database.database;
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .filter(({ name }) => !excluded.includes(name))
    .map(({ name }) => [name, createHash("sha256")
      .update(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).digest("hex")]));
}

function effectOriginRows(harness) {
  return harness.app.database.database.prepare(`
    SELECT envelope_json FROM agent_event_receipts
    WHERE json_extract(envelope_json, '$.eventType') = 'continuation_effect_origin' ORDER BY rowid
  `).all().map((row) => JSON.parse(row.envelope_json));
}

async function confirmRoutedAttempt(harness, { beforeConfirm } = {}) {
  const ready = createReadyTask(harness, { workflowProfile: "vibe", workingLog: null });
  const db = harness.app.database;
  const coordinatorWorkspace = path.join(harness.directory, "coordinator");
  const lane = (id, threadId, taskType) => ({
    id, label: id, owner: "Codex", source: "codex", threadId, taskType,
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: coordinatorWorkspace,
  });
  const lease = (id, holderTaskId, holderThreadId) => ({
    id, holderTaskId, holderThreadId, holderCodexHostId: "local", holderWorkspacePath: coordinatorWorkspace,
    acquiredAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
  });
  db.upsertAgentLaneProject("local", {
    rootTaskId: "global", tasks: [lane("global", "global-thread", "root_task"), lane("domain", "coordinator-thread", "peer_task")],
    adapters: [], coordinatorLease: lease("r10-global", "global", "global-thread"),
    coordinationDomains: [{ id: "web", label: "Web", writeScope: ["web"], eligibleTaskIds: ["domain"] }],
    domainCoordinatorLeases: { web: lease("r10-domain", "domain", "coordinator-thread") },
  });
  db.setAgentTaskDomain("local", ready.task.id, {
    taskVersion: ready.task.version, domainId: "web", holderTaskId: "global", holderThreadId: "global-thread",
    expectedCoordinatorLeaseId: "r10-global",
  });
  ready.capsule = db.getTaskCapsule(ready.task.id);
  ready.binding = { ...ready.binding, threadId: "coordinator-thread", workspacePath: coordinatorWorkspace };
  const executor = harness.lifecycle("r10-executor");
  await executor.start();
  const execution = executor.executionEnvelope();
  const claimed = await postBootstrapClaim(harness, ready, execution, "r10-reservation");
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  beforeConfirm?.();
  const confirmed = await postBootstrapDelivery(harness, ready, execution, "r10-reservation");
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const receipt = confirmed.body.receipt;
  const ordinaryDelivery = { receiptId: receipt.id, admissionAttemptId: receipt.admissionAttemptId };
  const effect = {
    effectKey: "r10-effect", execution, ordinaryDelivery,
    operations: [{ method: "turn/start", params: { threadId: ready.binding.threadId, input: "private-r10-input" } }],
  };
  const admissionInput = {
    rootThreadId: ready.binding.threadId, expectedResumeToken: receipt.resumeToken, safeActionId: receipt.safeActionId,
    admissionReceiptId: receipt.id, admissionAttemptId: receipt.admissionAttemptId,
  };
  return { ready, receipt, effect, executor, admissionInput };
}

function routedObservation(harness, taskId) {
  return harness.app.database.getTaskSafeActionAdmission(taskId)?.recordedDeliveryObservation;
}

function routedRows(harness) {
  return harness.app.database.database.prepare("SELECT * FROM ordinary_delivery_observations ORDER BY rowid").all();
}

test("routed attempt D1: exact coordinator result reaches the real admission projection without native parameter pollution", async (t) => {
  const subscription = terminalSubscription();
  const harness = await launchHarness({ subscribe: subscription.subscribe });
  const attempt = await confirmRoutedAttempt(harness);
  await harness.api.executeEffect(attempt.effect);
  const excluded = ["agent_event_receipts", "ordinary_delivery_observations"];
  const stateBeforeObservation = stateOutsideEventReceipts(harness, excluded);
  subscription.emit(terminalNotification("turn-1", "completed", attempt.ready.task.threadId));
  assert.equal(routedObservation(harness, attempt.ready.task.id).terminal, undefined);
  subscription.emit(terminalNotification("other-turn", "completed", "coordinator-thread"));
  subscription.emit(terminalNotification("turn-1", "completed", "coordinator-thread"));
  const observation = routedObservation(harness, attempt.ready.task.id);
  assert.equal(observation.taskId, attempt.ready.task.id);
  assert.equal(observation.receiptId, attempt.receipt.id);
  assert.equal(observation.admissionAttemptId, attempt.receipt.admissionAttemptId);
  assert.equal(observation.rootThreadId, "coordinator-thread");
  assert.notEqual(observation.rootThreadId, attempt.ready.task.threadId);
  assert.notEqual(observation.rootWorkspacePath, observation.worktreePath);
  assert.equal(observation.domainCoordinatorLeaseId, "r10-domain");
  assert.equal(observation.nativeResult.turnId, "turn-1");
  assert.equal(observation.terminal.turnStatus, "completed");
  assert.equal(observation.currentAdmissionContextMatches, true);
  assert.equal(observation.observationOnly, true);
  assert.equal(observation.liveExecution, "unknown");
  assert.equal(observation.eligibleForDispatch, false);
  assert.equal(Object.hasOwn(observation, "resumeTokenHash"), false);
  assert.equal(JSON.stringify(observation).includes(attempt.receipt.resumeToken), false);
  assert.equal(JSON.stringify(observation).includes(routedRows(harness)[0].dispatch_token), false);
  assert.deepEqual(harness.calls[0].params, attempt.effect.operations[0].params);
  const snapshot = await (await fetch(`${harness.baseUrl}/api/local/projects/local/agent-lanes`)).json();
  assert.deepEqual(snapshot.todos.find((todo) => todo.taskId === attempt.ready.task.id).admission.recordedDeliveryObservation, observation);
  assert.deepEqual(stateOutsideEventReceipts(harness, excluded), stateBeforeObservation);
  t.diagnostic(JSON.stringify({ case: "D1", taskId: observation.taskId, receiptId: observation.receiptId,
    admissionAttemptId: observation.admissionAttemptId, nativeResult: observation.nativeResult, terminal: observation.terminal,
    currentAdmissionContextMatches: observation.currentAdmissionContextMatches, observationOnly: observation.observationOnly,
    liveExecution: observation.liveExecution, eligibleForDispatch: observation.eligibleForDispatch, otherTablesUnchanged: true }));
  const injector = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  const ordinaryClosure = injector.slice(injector.indexOf("deliver: (request) => deliverTaskboardCoordination("), injector.indexOf("async function runBackgroundContinuationFastLane"));
  assert.match(ordinaryClosure, /request.codexHostId === "local" && method === "turn\/start"/);
  assert.match(ordinaryClosure, /receiptId: request.deliveryReceipt.id/);
  assert.equal(harness.calls.length, 1);
});

test("routed attempt D2: bounded early evidence selects the returned turn and survives a discarded outer ACK", async () => {
  for (const early of [true, false]) {
    const subscription = terminalSubscription();
    let resolveResult;
    let started;
    const dispatchStarted = new Promise((resolve) => { started = resolve; });
    const harness = await launchHarness({ subscribe: subscription.subscribe, requestReady() {
      started();
      return new Promise((resolve) => { resolveResult = resolve; });
    } });
    const attempt = await confirmRoutedAttempt(harness);
    const effectPromise = harness.api.executeEffect(attempt.effect);
    await dispatchStarted;
    if (early) {
      subscription.emit(terminalNotification("unrelated", "failed", "coordinator-thread"));
      subscription.emit(terminalNotification("selected", "interrupted", "coordinator-thread"));
      subscription.emit(terminalNotification("selected", "failed", "coordinator-thread"));
    }
    resolveResult({ turn: { id: "selected", status: "inProgress" } });
    await effectPromise; // Deliberately discard the outer result; all assertions use the durable consumer.
    if (!early) subscription.emit(terminalNotification("selected", "interrupted", "coordinator-thread"));
    const original = routedObservation(harness, attempt.ready.task.id);
    subscription.emit(terminalNotification("selected", "interrupted", "coordinator-thread"));
    subscription.emit(terminalNotification("selected", "completed", "coordinator-thread"));
    assert.deepEqual(routedObservation(harness, attempt.ready.task.id), original);
    assert.equal(original.terminal.turnStatus, "interrupted");
    assert.equal(original.nativeResult.turnId, "selected");
    assert.equal(harness.calls.length, 1);
  }
});

test("routed attempt D4: exact tagged replay is immutable and historical untagged effects cannot acquire a pair", async () => {
  const harness = await launchHarness();
  const attempt = await confirmRoutedAttempt(harness);
  await harness.api.executeEffect(attempt.effect);
  const frozen = routedRows(harness);
  await harness.api.executeEffect(attempt.effect);
  await assert.rejects(harness.api.executeEffect({ ...attempt.effect, effectKey: "r10-different-effect" }), /another frozen context or effect/);
  for (const ordinaryDelivery of [undefined, { ...attempt.effect.ordinaryDelivery, admissionAttemptId: "wrong-attempt" }]) {
    await assert.rejects(harness.api.executeEffect({ ...attempt.effect, ordinaryDelivery }), /another Codex RPC payload/);
  }
  assert.deepEqual(routedRows(harness), frozen);
  const untagged = { ...attempt.effect, effectKey: "r10-historical", ordinaryDelivery: undefined };
  await harness.api.executeEffect(untagged);
  const row = harness.app.database.database.prepare("SELECT * FROM host_executor_effects WHERE effect_key = ?").get(untagged.effectKey);
  assert.equal(row.request_fingerprint, createHash("sha256").update(JSON.stringify({ codexHostId: "local", operations: untagged.operations })).digest("hex"));
  await assert.rejects(harness.api.executeEffect({ ...untagged, ordinaryDelivery: attempt.effect.ordinaryDelivery }), /another Codex RPC payload/);
  harness.app.database.database.exec("DELETE FROM ordinary_delivery_observations");
  await harness.api.executeEffect(attempt.effect);
  assert.deepEqual(routedRows(harness), []);
  assert.equal(harness.calls.length, 2);
});

test("routed attempt D3: real domain recovery preserves frozen history across rebind, reclaim and reopen", async (t) => {
  for (const childPresent of [true, false]) {
    const subscription = terminalSubscription();
    let harness = await launchHarness({ subscribe: subscription.subscribe });
    const attempt = await confirmRoutedAttempt(harness);
    let db = harness.app.database;
    await harness.api.executeEffect(attempt.effect);
    subscription.emit(terminalNotification("turn-1", "completed", "coordinator-thread"));
    const frozen = routedRows(harness);
    const prepared = db.prepareTaskSafeActionAdmission(attempt.ready.task.id, { ...attempt.admissionInput, writeScope: ["web"] });
    const config = db.getAgentLaneProject("local");
    db.upsertAgentLaneProject("local", { ...config, domainCoordinatorLeases: {
      web: { ...config.domainCoordinatorLeases.web, expiresAt: new Date(Date.now() - 1).toISOString() },
    } });
    const recovered = db.claimAgentLaneDomainCoordinator("local", "web", {
      holderTaskId: "domain", holderThreadId: "coordinator-thread", holderCodexHostId: "local",
      holderWorkspacePath: attempt.ready.binding.workspacePath,
      expectedLeaseId: "r10-domain", leaseDurationSeconds: 120, recoverOnly: true,
    });
    db.markTaskSafeActionAdmissionUncertain(attempt.ready.task.id, attempt.admissionInput,
      new Date(Date.parse(prepared.receipt.admissionDeadlineAt) + 1).toISOString());
    const probe = db.claimTaskSafeActionAdmissionProbe(attempt.ready.task.id, attempt.admissionInput);
    const reconciled = db.reconcileTaskSafeActionAdmission(attempt.ready.task.id, {
      ...attempt.admissionInput, admissionProbeId: probe.receipt.admissionProbeId,
      registryObservation: {
        source: "list_agents", complete: true,
        observedAt: new Date(Date.parse(probe.receipt.admissionProbeRequestedAt) + 1).toISOString(),
        agents: childPresent ? [{ agentPath: prepared.receipt.admissionAgentPath, agentThreadId: "r10-child", status: "running" }] : [],
      },
    });
    assert.deepEqual(routedRows(harness), frozen);
    if (childPresent) {
      assert.equal(reconciled.receipt.domainCoordinatorLeaseId, recovered.lease.id);
      assert.notEqual(reconciled.receipt.resumeToken, attempt.receipt.resumeToken);
      assert.equal(routedObservation(harness, attempt.ready.task.id).currentAdmissionContextMatches, false);
      await harness.api.executeEffect(attempt.effect);
      assert.equal(harness.calls.length, 1, "completed replay does not recapture the new epoch");
    } else {
      const currentCapsule = db.getTaskCapsule(attempt.ready.task.id);
      const claimInput = {
        rootThreadId: "coordinator-thread", ownedCodexHostId: "local", expectedResumeToken: currentCapsule.resumeToken,
        safeActionId: attempt.receipt.safeActionId, reservationLeaseId: "r10-reclaimed",
      };
      const reclaimed = db.claimTaskSafeAction(attempt.ready.task.id, claimInput);
      assert.notEqual(reclaimed.receipt.admissionAttemptId, attempt.receipt.admissionAttemptId);
      db.confirmTaskSafeActionDelivery(attempt.ready.task.id, claimInput);
      const current = routedObservation(harness, attempt.ready.task.id);
      assert.equal(current.admissionAttemptId, reclaimed.receipt.admissionAttemptId);
      assert.equal(current.nativeResult, undefined);
      assert.equal(current.terminal, undefined);
    }
    const beforeReopen = db.getTaskSafeActionAdmission(attempt.ready.task.id);
    const historyBeforeReopen = routedRows(harness);
    await harness.app.close();
    running.find((entry) => entry.app === harness.app).closed = true;
    assert.equal(subscription.listeners.size, 0);
    harness = await launchHarness({ reopenDirectory: harness.directory });
    db = harness.app.database;
    assert.deepEqual(routedRows(harness), historyBeforeReopen);
    assert.deepEqual(db.getTaskSafeActionAdmission(attempt.ready.task.id), beforeReopen);
    t.diagnostic(JSON.stringify({ case: "D3", childPresent, originalReceiptId: attempt.receipt.id,
      originalAttemptId: attempt.receipt.admissionAttemptId, currentAttemptId: beforeReopen.admissionAttemptId,
      currentAdmissionContextMatches: beforeReopen.recordedDeliveryObservation.currentAdmissionContextMatches,
      nativeResult: beforeReopen.recordedDeliveryObservation.nativeResult ?? null, historyRows: historyBeforeReopen.length,
      reopenPreserved: true }));
    if (childPresent) {
      db.claimAgentTask(attempt.ready.task.id, db.getTask(attempt.ready.task.id).version, {
        agentPath: prepared.receipt.admissionAgentPath, agentThreadId: "r10-child", rootThreadId: "coordinator-thread",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), writeScope: ["web"],
        admissionReceiptId: attempt.receipt.id, admissionAttemptId: attempt.receipt.admissionAttemptId,
      });
      assert.equal(db.getTaskSafeActionAdmission(attempt.ready.task.id), null, "admitted/delivered attempt leaves outstanding projection");
      assert.deepEqual(routedRows(harness), historyBeforeReopen);
    }
  }
});

test("routed attempt D5: tag applicability excludes resume, remote, recovery and capacity observation", async () => {
  const harness = await launchHarness();
  const attempt = await confirmRoutedAttempt(harness);
  await assert.rejects(harness.api.executeEffect({ ...attempt.effect, operations: [{ method: "thread/resume", params: { threadId: "coordinator-thread" } }] }), /one local turn\/start/);
  await assert.rejects(harness.api.executeEffect({ ...attempt.effect, execution: { ...attempt.effect.execution, codexHostId: "remote-host" } }), /one local turn\/start/);
  await assert.rejects(harness.api.executeEffect({ ...attempt.effect, ordinaryDelivery: { ...attempt.effect.ordinaryDelivery, extra: "forbidden" } }), /Unknown field/);
  await harness.api.executeEffect({ ...attempt.effect, ordinaryDelivery: undefined, operations: [{ method: "thread/resume", params: { threadId: "coordinator-thread" } }] });
  assert.equal(routedRows(harness)[0].effect_key, null);
  assert.equal(harness.calls.length, 1);
  const injector = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  const excluded = injector.slice(injector.indexOf("requestCapacityObservation: (request)"), injector.indexOf("deliver: (request) => deliverTaskboardCoordination("));
  assert.doesNotMatch(excluded, /receiptId: request.deliveryReceipt.id/);
});

test("routed attempt D6: overflow, optional write failures and native loss never invent a terminal or retry authority", async () => {
  const subscription = terminalSubscription();
  const overflowHarness = await launchHarness({ subscribe: subscription.subscribe, requestReady() {
    for (let index = 0; index < 33; index += 1) {
      subscription.emit(terminalNotification(`overflow-${index}`, "completed", "coordinator-thread"));
    }
    return Promise.resolve({ turn: { id: "overflow-0" } });
  } });
  const overflow = await confirmRoutedAttempt(overflowHarness);
  await overflowHarness.api.executeEffect(overflow.effect);
  assert.equal(routedObservation(overflowHarness, overflow.ready.task.id).terminal, undefined);
  subscription.emit(terminalNotification("overflow-0", "failed", "coordinator-thread"));
  assert.equal(routedObservation(overflowHarness, overflow.ready.task.id).terminal.turnStatus, "failed");

  for (const point of ["snapshot", "bind", "completion"]) {
    const selected = terminalSubscription();
    const harness = await launchHarness({ subscribe: selected.subscribe, requestReady() {
      selected.emit(terminalNotification("write-failure", "completed", "coordinator-thread"));
      return Promise.resolve({ turn: { id: "write-failure" } });
    } });
    const sql = harness.app.database.database;
    const installFailure = () => sql.exec(`CREATE TRIGGER r10_optional_failure BEFORE ${
      point === "snapshot" ? "INSERT" : point === "bind" ? "UPDATE OF effect_key" : "UPDATE OF native_turn_id"
    } ON ordinary_delivery_observations BEGIN SELECT RAISE(ABORT, 'r10 optional failure'); END;`);
    const attempt = await confirmRoutedAttempt(harness, { beforeConfirm: point === "snapshot" ? installFailure : undefined });
    if (point === "snapshot") sql.exec("DROP TRIGGER r10_optional_failure");
    else installFailure();
    await assert.rejects(harness.api.executeEffect({ ...attempt.effect, ordinaryDelivery: { ...attempt.effect.ordinaryDelivery, admissionAttemptId: "wrong" } }), /exact ordinary delivering attempt/);
    assert.equal(harness.calls.length, 0);
    const response = await harness.api.executeEffect(attempt.effect);
    assert.equal(response.effect.status, "completed");
    if (point !== "snapshot") sql.exec("DROP TRIGGER r10_optional_failure");
    selected.emit(terminalNotification("write-failure", "completed", "coordinator-thread"));
    await harness.api.executeEffect(attempt.effect);
    const observation = routedObservation(harness, attempt.ready.task.id);
    if (point === "snapshot") {
      assert.equal(observation, null);
      assert.deepEqual(routedRows(harness), []);
    } else {
      assert.equal(observation.nativeResult, undefined);
      assert.equal(observation.terminal, undefined);
      if (point === "bind") assert.equal(routedRows(harness)[0].dispatch_token, null);
    }
    assert.equal(harness.calls.length, 1);
  }

  for (const capacity of [false, true]) {
    const selected = terminalSubscription();
    const harness = await launchHarness({ subscribe: selected.subscribe, requestReady({ calls }) {
      selected.emit(terminalNotification("lost-result", "completed", "coordinator-thread"));
      if (capacity && calls.length > 1) return Promise.resolve({ turn: { id: "fresh-result" } });
      return Promise.reject(capacity
        ? new CodexAppServerError("Selected model is at capacity. Please try a different model.", null, { definitiveRejection: true })
        : new Error("synthetic result lost"));
    } });
    const attempt = await confirmRoutedAttempt(harness);
    await assert.rejects(harness.api.executeEffect(attempt.effect));
    const row = harness.app.database.database.prepare("SELECT * FROM host_executor_effects WHERE effect_key = ?").get(attempt.effect.effectKey);
    assert.equal(row.status, capacity ? "reserved" : "uncertain");
    assert.equal(routedObservation(harness, attempt.ready.task.id).nativeResult, undefined);
    assert.equal(routedObservation(harness, attempt.ready.task.id).eligibleForDispatch, false);
    assert.equal(routedRows(harness)[0].dispatch_token === null, capacity);
    if (capacity) {
      await harness.api.executeEffect(attempt.effect);
      assert.equal(routedObservation(harness, attempt.ready.task.id).nativeResult.turnId, "fresh-result");
      assert.equal(routedObservation(harness, attempt.ready.task.id).terminal, undefined);
    } else {
      await assert.rejects(harness.api.executeEffect(attempt.effect), /requires observation/);
      assert.equal(harness.calls.length, 1);
    }
  }

  const harness = await launchHarness();
  const attempt = await confirmRoutedAttempt(harness);
  await assert.rejects(harness.api.executeEffect({ ...attempt.effect, operations: [{ method: "turn/start", params: { threadId: "wrong-target" } }] }), /exact ordinary delivering attempt/);
  const sql = harness.app.database.database;
  sql.exec("ALTER TABLE task_safe_action_receipts RENAME TO r10_temporarily_unavailable_receipts");
  try {
    await assert.rejects(harness.api.executeEffect(attempt.effect));
  } finally {
    sql.exec("ALTER TABLE r10_temporarily_unavailable_receipts RENAME TO task_safe_action_receipts");
  }
  assert.equal(harness.calls.length, 0, "mandatory identity SQL failure is not optional dispatch permission");
  assert.equal(routedRows(harness)[0].effect_key, null);
  const databaseSource = await readFile(new URL("../server/database.mjs", import.meta.url), "utf8");
  for (const method of ["completeHostExecutorEffect(", "markHostExecutorEffectUncertain(", "releaseHostExecutorEffectAfterRejection("]) {
    const start = databaseSource.indexOf(`  ${method}`);
    const end = databaseSource.indexOf("\n  }", start);
    assert.match(databaseSource.slice(start, end), /finally \{\s*this.#ordinaryDeliveryBuffers.delete\(dispatchToken\)/);
  }
  assert.match(databaseSource, /close\(\) \{\s*this.#ordinaryDeliveryBuffers.clear\(\)/);
});

test("effect terminal D1: protected execute joins both notification orders with exactly the recorded origin fields", async () => {
  for (const terminalFirst of [false, true]) {
    const subscription = terminalSubscription();
    const turnId = terminalFirst ? "terminal-before-response" : "response-before-terminal";
    const harness = await launchHarness({ subscribe: subscription.subscribe, requestReady() {
      if (terminalFirst) subscription.emit(terminalNotification(turnId));
      return Promise.resolve({ turn: { id: turnId, status: "inProgress", output: "private-result" } });
    } });
    const ready = createReadyTask(harness);
    const agreement = enrollTerminalTask(harness, ready);
    const executor = harness.lifecycle("origin-executor");
    await executor.start();
    const operations = [{ method: "turn/start", params: { threadId: ready.binding.threadId, input: "private-prompt" } }];
    const response = await postEffect(harness.baseUrl, harness.secret, "origin-order", executor.executionEnvelope(), operations, 801);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.effect.status, "completed");
    assert.equal(response.body.results[0].turn.id, turnId);
    const beforeObservation = stateOutsideEventReceipts(harness);
    if (!terminalFirst) subscription.emit(terminalNotification(turnId));
    const assessmentResponse = await fetch(`${harness.baseUrl}/api/local/tasks/${ready.task.id}/continuation`);
    const assessment = await assessmentResponse.json();
    assert.equal(assessmentResponse.status, 200);
    assert.equal(assessment.recordedTerminalEffectOrigin.status, "matched");
    const origin = assessment.recordedTerminalEffectOrigin.origin;
    assert.deepEqual(Object.keys(origin).sort(), [
      "eventId", "eventType", "taskId", "projectId", "source", "codexHostId", "threadId", "turnId", "effectKey",
      "requestFingerprint", "operationIndex", "continuationRecordId", "bindingAtObservation", "recordedAt",
    ].sort());
    assert.equal(origin.eventType, "continuation_effect_origin");
    assert.equal(origin.source, "taskboard-local-host-effect-completion");
    assert.equal(origin.operationIndex, 0);
    assert.equal(origin.turnId, turnId);
    assert.equal(origin.effectKey, "origin-order");
    assert.equal(origin.continuationRecordId, agreement.eventId);
    assert.deepEqual(origin.bindingAtObservation, ready.binding);
    const row = harness.app.database.database.prepare("SELECT * FROM host_executor_effects WHERE effect_key = ?").get(origin.effectKey);
    assert.equal(origin.requestFingerprint, row.request_fingerprint);
    assert.equal(JSON.stringify(origin).includes(row.dispatch_token), false);
    assert.equal(JSON.stringify(origin).includes("private-"), false);
    assert.ok(Number.isFinite(Date.parse(origin.recordedAt)));
    assert.deepEqual(assessment.recordedTerminalCheckpoint.turnId, turnId);
    assert.equal(assessment.liveExecution, "unknown");
    assert.equal(assessment.eligibleForDispatch, false);
    assert.deepEqual(stateOutsideEventReceipts(harness), beforeObservation);
    assert.equal(harness.calls.length, 1);
  }
});

test("effect terminal D2: completed replay never backfills enrollment or reattributes changed agreement and binding", async () => {
  const subscription = terminalSubscription();
  const harness = await launchHarness({ subscribe: subscription.subscribe });
  const ready = createReadyTask(harness);
  enrollTerminalTask(harness, ready);
  const executor = harness.lifecycle("origin-replay-executor");
  await executor.start();
  const execution = executor.executionEnvelope();
  const operations = [{ method: "turn/start", params: { threadId: ready.binding.threadId } }];
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "origin-replay", execution, operations, 811)).status, 200);
  const first = effectOriginRows(harness);
  const laterEnrolled = createReadyTask(harness);
  enrollTerminalTask(harness, laterEnrolled);
  const replay = await postEffect(harness.baseUrl, harness.secret, "origin-replay", execution, operations, 812);
  assert.equal(replay.body.replayed, true);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(effectOriginRows(harness), first);
  enrollTerminalTask(harness, ready, "changed-agreement");
  subscription.emit(terminalNotification("turn-1"));
  assert.deepEqual(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalEffectOrigin,
    { status: "unavailable", origin: null });
  assert.deepEqual(harness.app.database.getTaskContinuation(laterEnrolled.task.id).recordedTerminalEffectOrigin,
    { status: "unavailable", origin: null });

  assert.equal((await postEffect(harness.baseUrl, harness.secret, "origin-binding", execution, operations, 813)).status, 200);
  const captured = effectOriginRows(harness);
  const current = harness.app.database.getTask(ready.task.id);
  harness.app.database.updateTask(current.id, current.version, {}, undefined,
    { ...ready.binding, workspacePath: `${harness.worktreePath}-new` });
  subscription.emit(terminalNotification("turn-2"));
  const changed = harness.app.database.getTaskContinuation(ready.task.id);
  assert.equal(changed.recordedTerminalCheckpoint.turnId, "turn-2");
  assert.deepEqual(changed.recordedTerminalEffectOrigin, { status: "unavailable", origin: null });
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "origin-binding", execution, operations, 814)).body.replayed, true);
  assert.deepEqual(effectOriginRows(harness), captured);
  assert.equal(harness.calls.length, 2);
});

test("effect terminal D3: receipts survive pruning and key reuse is a distinct ambiguous dispatch generation", async () => {
  const subscription = terminalSubscription();
  const initialTime = Date.parse("2026-09-12T12:00:00Z");
  const requestReady = () => Promise.resolve({ turn: { id: "shared-native-turn" } });
  let harness = await launchHarness({ currentTime: initialTime, subscribe: subscription.subscribe, requestReady });
  const ready = createReadyTask(harness);
  enrollTerminalTask(harness, ready);
  let executor = harness.lifecycle("origin-generation-a");
  await executor.start();
  const operations = [{ method: "turn/start", params: { threadId: ready.binding.threadId } }];
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "reusable-origin-key", executor.executionEnvelope(), operations, 821)).status, 200);
  const first = effectOriginRows(harness)[0];
  await harness.app.close();
  running.find((entry) => entry.app === harness.app).closed = true;
  harness = await launchHarness({
    currentTime: initialTime + 24 * 60 * 60 * 1_000 + 1,
    subscribe: subscription.subscribe, requestReady, reopenDirectory: harness.directory,
  });
  assert.deepEqual(effectOriginRows(harness), [first]);
  assert.equal(harness.app.database.database.prepare("SELECT COUNT(*) AS count FROM host_executor_effects").get().count, 0);
  const replacement = enrollTerminalTask(harness, ready, "new-generation-agreement");
  executor = harness.lifecycle("origin-generation-b");
  await executor.start();
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "reusable-origin-key", executor.executionEnvelope(), operations, 822)).status, 200);
  const origins = effectOriginRows(harness);
  assert.equal(origins.length, 2);
  assert.notEqual(origins[1].eventId, first.eventId);
  assert.equal(origins[1].effectKey, first.effectKey);
  assert.equal(origins[1].requestFingerprint, first.requestFingerprint);
  assert.equal(origins[1].continuationRecordId, replacement.eventId);
  subscription.emit(terminalNotification("shared-native-turn"));
  const assessment = harness.app.database.getTaskContinuation(ready.task.id);
  assert.equal(assessment.recordedTerminalCheckpoint.continuationRecordId, replacement.eventId);
  assert.deepEqual(assessment.recordedTerminalEffectOrigin, { status: "ambiguous", origin: null },
    "an older-context generation must not be hidden before counting origins");
  subscription.emit(terminalNotification("newer-unmatched-terminal"));
  assert.deepEqual(harness.app.database.getTaskContinuation(ready.task.id).recordedTerminalEffectOrigin,
    { status: "unavailable", origin: null }, "do not fall back to the older correlated terminal");
});

test("effect terminal D4: optional receipt failure preserves successful effect and excluded inputs remain unavailable", async () => {
  const subscription = terminalSubscription();
  let rpcResult = { turn: { id: "capture-fails" } };
  const harness = await launchHarness({ subscribe: subscription.subscribe, requestReady: () => Promise.resolve(rpcResult) });
  const db = harness.app.database;
  const ready = createReadyTask(harness);
  enrollTerminalTask(harness, ready);
  const executor = harness.lifecycle("origin-failure-executor");
  await executor.start();
  const execution = executor.executionEnvelope();
  const operation = { method: "turn/start", params: { threadId: ready.binding.threadId } };
  db.database.exec(`CREATE TEMP TRIGGER fail_origin_receipt BEFORE INSERT ON agent_event_receipts
    WHEN json_extract(NEW.envelope_json, '$.eventType') = 'continuation_effect_origin'
    BEGIN SELECT RAISE(ABORT, 'synthetic optional-origin failure'); END`);
  const response = await postEffect(harness.baseUrl, harness.secret, "origin-insert-abort", execution, [operation], 831);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.effect.status, "completed");
  assert.deepEqual(response.body.results, [rpcResult]);
  db.database.exec("DROP TRIGGER fail_origin_receipt");
  subscription.emit(terminalNotification("capture-fails"));
  assert.deepEqual(db.getTaskContinuation(ready.task.id).recordedTerminalEffectOrigin, { status: "unavailable", origin: null });
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "origin-insert-abort", execution, [operation], 832)).body.replayed, true);
  assert.equal(harness.calls.length, 1, "capture failure does not retry a successful native effect");
  let sequence = 833;
  for (const [operations, result] of [
    [[{ method: "thread/resume", params: { threadId: ready.binding.threadId } }], { turn: { id: "other-method" } }],
    [[operation, operation], { turn: { id: "batch" } }],
    [[{ method: "turn/start", params: {} }], { turn: { id: "missing-thread" } }],
    [[operation], {}],
    [[operation], { turn: { id: " invalid " } }],
    [[{ method: "turn/start", params: { threadId: "not-enrolled" } }], { turn: { id: "not-enrolled" } }],
  ]) {
    rpcResult = result;
    const resultResponse = await postEffect(harness.baseUrl, harness.secret, `excluded-${sequence}`, execution, operations, sequence++);
    assert.equal(resultResponse.status, 200, JSON.stringify(resultResponse.body));
    assert.equal(resultResponse.body.effect.status, "completed");
  }
  const incomplete = createReadyTask(harness);
  const incompleteBinding = { ...incomplete.binding, threadId: "incomplete-origin-thread" };
  db.updateTask(incomplete.task.id, incomplete.task.version, {}, undefined, incompleteBinding);
  enrollTerminalTask(harness, incomplete);
  const incompleteCurrent = db.getTask(incomplete.task.id);
  db.updateTask(incompleteCurrent.id, incompleteCurrent.version, {}, undefined, { ...incompleteBinding, workspacePath: null });
  rpcResult = { turn: { id: "incomplete-origin-turn" } };
  assert.equal((await postEffect(harness.baseUrl, harness.secret, "excluded-incomplete-binding", execution,
    [{ method: "turn/start", params: { threadId: incompleteBinding.threadId } }], sequence++)).status, 200);
  const remoteRegistration = db.registerHostExecutor({ codexHostId: "remote-synthetic", executorInstanceId: "origin-remote",
    adapterId: "codex-renderer-rpc-v1", capabilities: ["turn/start"], idempotencyKey: "remote-registration" }).registration;
  const remoteLease = db.acquireHostExecutorLease({ codexHostId: "remote-synthetic", executorInstanceId: "origin-remote",
    registrationFingerprint: remoteRegistration.fingerprint, idempotencyKey: "remote-acquire", expectedLeaseId: null,
    leaseDurationSeconds: 30 }).lease;
  const remoteInput = { effectKey: "excluded-remote", operations: [operation], execution: {
    codexHostId: "remote-synthetic", executorInstanceId: "origin-remote", registrationFingerprint: remoteRegistration.fingerprint,
    leaseId: remoteLease.id,
  } };
  db.reserveHostExecutorEffect(remoteInput);
  const remoteDispatch = db.beginHostExecutorEffectDispatch(remoteInput);
  assert.equal(db.completeHostExecutorEffect(remoteInput.effectKey, remoteDispatch.dispatchToken, [{ turn: { id: "remote-turn" } }]).status, "completed");
  const scrubbedInput = { effectKey: "excluded-scrubbed", execution, operations: [operation] };
  db.reserveHostExecutorEffect(scrubbedInput);
  const scrubbedDispatch = db.beginHostExecutorEffectDispatch(scrubbedInput);
  harness.clock.value += 24 * 60 * 60 * 1_000 + 1;
  assert.equal(db.completeHostExecutorEffect(scrubbedInput.effectKey, scrubbedDispatch.dispatchToken, [{ turn: { id: "scrubbed-turn" } }]).status, "completed");
  assert.deepEqual(effectOriginRows(harness), []);
});

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
