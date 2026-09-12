import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    await entry.app.close();
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

async function launchHarness({ currentTime, afterReserve, requestReady } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-fence-"));
  const worktreePath = path.join(directory, "worktree");
  await mkdir(worktreePath);
  const secret = "d".repeat(64);
  const calls = [];
  const adapter = {
    async ensureReady() {},
    requestReady(codexHostId, method, params) {
      calls.push({ codexHostId, method, params });
      if (requestReady) return requestReady({ calls, codexHostId, method, params });
      return Promise.resolve({ turn: { id: `turn-${calls.length}` } });
    },
  };
  const clock = { value: currentTime };
  const app = createTaskboardServer({
    dataDirectory: directory,
    instanceSecret: secret,
    hostExecutorClock: () => clock.value,
    hostExecutorRpcAdapter: adapter,
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
