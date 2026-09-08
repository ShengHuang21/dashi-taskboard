import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createHostExecutorApi } from "../scripts/host-executor-api.mjs";
import { createHostExecutorLeaseLifecycle } from "../scripts/host-executor-lifecycle.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import * as remoteHostRuntime from "../scripts/remote-host-executor-runtime.mjs";

const {
  createRemoteHostExecutorManager,
  createRemoteHostExecutorWorker,
  decodeCodexRendererRpcOutcome,
  runRemoteHostExecutorChannelOnce,
} = remoteHostRuntime;

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    await entry.app.close();
    await rm(entry.directory, { recursive: true, force: true });
  }
});

async function launchHarness({ currentTime, afterReserve, requestTimeoutMs } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-remote-channel-"));
  await mkdir(path.join(directory, "worktree"));
  const secret = "e".repeat(64);
  const clock = { value: currentTime ?? Date.parse("2026-09-08T12:00:00.000Z") };
  const localCalls = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    instanceSecret: secret,
    hostExecutorClock: () => clock.value,
    hostExecutorDispatchHooks: afterReserve ? { afterReserve } : undefined,
    remoteHostExecutorPollTimeoutMs: 1_000,
    remoteHostExecutorRequestTimeoutMs: requestTimeoutMs ?? 3_000,
    hostExecutorRpcAdapter: {
      async ensureReady() {},
      requestReady(codexHostId, method, params) {
        localCalls.push({ codexHostId, method, params });
        return Promise.resolve({ local: true });
      },
    },
  });
  const address = await app.listen({ port: 0 });
  running.push({ app, directory });
  return {
    api: createHostExecutorApi({
      baseUrl: `http://127.0.0.1:${address.port}`,
      instanceSecret: secret,
    }),
    app,
    clock,
    directory,
    localCalls,
  };
}

async function waitForRemoteChannel(harness, execution) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      harness.app.remoteHostExecutorChannels.ensureReady(execution);
      return;
    } catch (_) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("Timed out waiting for the remote host executor channel");
}

function remoteLifecycle(harness, codexHostId, executorInstanceId) {
  let operation = 0;
  return createHostExecutorLeaseLifecycle({
    codexHostId,
    executorInstanceId,
    adapterId: "codex-renderer-rpc-v1",
    leaseDurationSeconds: 30,
    renewIntervalMs: 10_000,
    register: harness.api.register,
    inspect: harness.api.inspect,
    acquire: harness.api.acquire,
    renew: harness.api.renew,
    release: harness.api.release,
    schedule: () => ({ scheduled: true }),
    cancel: () => {},
    now: () => harness.clock.value,
    createOperationId: () => `operation-${++operation}`,
  });
}

test("renderer-backed remote host executes one fenced effect exactly once", async () => {
  const harness = await launchHarness();
  const lifecycle = remoteLifecycle(harness, "remote-builder", "executor-remote-a");
  await lifecycle.start();
  const execution = lifecycle.executionEnvelope();
  const input = {
    effectKey: "remote-exactly-once",
    execution,
    operations: [{
      method: "turn/start",
      params: { threadId: "remote-root", approvalPolicy: "never" },
    }],
  };

  const waiting = harness.api.pollRemoteRequest({ execution });
  await waitForRemoteChannel(harness, execution);
  const dispatched = harness.api.executeEffect(input);
  const delivery = await waiting;
  assert.deepEqual(delivery.request?.operations, input.operations);
  const completion = await harness.api.completeRemoteRequest({
    execution,
    requestId: delivery.request.id,
    outcome: { result: [{ turn: { id: "remote-turn" } }] },
  });
  assert.deepEqual(completion, { applied: true, replayed: false, accepted: true });
  const first = await dispatched;
  assert.equal(first.replayed, false);
  assert.equal(first.results?.[0]?.turn?.id, "remote-turn");

  const replay = await harness.api.executeEffect(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.results?.[0]?.turn?.id, "remote-turn");
  assert.equal(harness.localCalls.length, 0, "the local adapter never receives remote work");
});

test("malformed remote results become uncertain and can never be re-dispatched", async () => {
  const harness = await launchHarness();
  const lifecycle = remoteLifecycle(harness, "remote-malformed", "executor-malformed");
  await lifecycle.start();
  const execution = lifecycle.executionEnvelope();
  const input = {
    effectKey: "remote-malformed-result",
    execution,
    operations: [
      { method: "thread/resume", params: { threadId: "remote-root" } },
      { method: "turn/start", params: { threadId: "remote-root", approvalPolicy: "never" } },
    ],
  };

  const waiting = harness.api.pollRemoteRequest({ execution });
  await waitForRemoteChannel(harness, execution);
  const dispatched = harness.api.executeEffect(input);
  const delivery = await waiting;
  const completion = await harness.api.completeRemoteRequest({
    execution,
    requestId: delivery.request.id,
    outcome: { result: [{ resumed: true }] },
  });
  assert.deepEqual(completion, { applied: true, replayed: false, accepted: false });
  await assert.rejects(
    dispatched,
    (error) => error?.status === 502
      && error?.code === "HOST_EXECUTOR_CHANNEL_RESULT_INVALID",
  );
  await assert.rejects(
    () => harness.api.executeEffect(input),
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
  );
  assert.equal(harness.localCalls.length, 0);
});

test("only an exact remote model-capacity rejection releases the same effect", async () => {
  const harness = await launchHarness();
  const lifecycle = remoteLifecycle(harness, "remote-capacity", "executor-capacity");
  await lifecycle.start();
  const execution = lifecycle.executionEnvelope();
  const input = {
    effectKey: "remote-capacity-retry",
    execution,
    operations: [{ method: "thread/start", params: { cwd: "/srv/remote" } }],
  };

  const firstPoll = harness.api.pollRemoteRequest({ execution, pollId: "capacity-poll-1" });
  await waitForRemoteChannel(harness, execution);
  const firstDispatch = harness.api.executeEffect(input);
  const firstRequest = await firstPoll;
  await harness.api.completeRemoteRequest({
    execution,
    requestId: firstRequest.request.id,
    outcome: {
      error: {
        message: "Selected model is at capacity. Please try a different model.",
        definitiveRejection: true,
      },
    },
  });
  await assert.rejects(
    firstDispatch,
    (error) => error?.status === 503 && error?.code === "HOST_EXECUTOR_MODEL_CAPACITY",
  );

  const secondPoll = harness.api.pollRemoteRequest({ execution, pollId: "capacity-poll-2" });
  await waitForRemoteChannel(harness, execution);
  const secondDispatch = harness.api.executeEffect(input);
  const secondRequest = await secondPoll;
  await harness.api.completeRemoteRequest({
    execution,
    requestId: secondRequest.request.id,
    outcome: { result: [{ thread: { id: "remote-after-capacity" } }] },
  });
  const result = await secondDispatch;
  assert.equal(result.results?.[0]?.thread?.id, "remote-after-capacity");
});

test("ordinary remote rejection and disconnect stay uncertain", async () => {
  const harness = await launchHarness();
  const lifecycle = remoteLifecycle(harness, "remote-uncertain", "executor-uncertain");
  await lifecycle.start();
  const execution = lifecycle.executionEnvelope();
  const rejectedInput = {
    effectKey: "remote-ordinary-rejection",
    execution,
    operations: [{ method: "turn/start", params: { threadId: "remote-root" } }],
  };
  const rejectionPoll = harness.api.pollRemoteRequest({ execution });
  await waitForRemoteChannel(harness, execution);
  const rejectionDispatch = harness.api.executeEffect(rejectedInput);
  const rejectionRequest = await rejectionPoll;
  await harness.api.completeRemoteRequest({
    execution,
    requestId: rejectionRequest.request.id,
    outcome: {
      error: { message: "Codex rejected this mutation", definitiveRejection: true },
    },
  });
  await assert.rejects(
    rejectionDispatch,
    (error) => error?.status === 502 && error?.code === "HOST_EXECUTOR_RPC_REJECTED",
  );
  await assert.rejects(
    () => harness.api.executeEffect(rejectedInput),
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
  );

  const disconnectedInput = {
    effectKey: "remote-disconnected",
    execution,
    operations: [{ method: "thread/start", params: { cwd: "/srv/disconnected" } }],
  };
  const disconnectPoll = harness.api.pollRemoteRequest({ execution });
  await waitForRemoteChannel(harness, execution);
  const disconnectDispatch = harness.api.executeEffect(disconnectedInput);
  await disconnectPoll;
  assert.deepEqual(
    await harness.api.disconnectRemoteChannel({ execution }),
    { applied: true },
  );
  await assert.rejects(
    disconnectDispatch,
    (error) => error?.status === 503
      && error?.code === "HOST_EXECUTOR_CHANNEL_DISCONNECTED",
  );
  await assert.rejects(
    () => harness.api.executeEffect(disconnectedInput),
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
  );
});

test("a late close from an old poll cannot cancel the replacement lease channel", async () => {
  const harness = await launchHarness();
  const lifecycleA = remoteLifecycle(harness, "remote-takeover", "executor-a");
  const stateA = await lifecycleA.start();
  const executionA = lifecycleA.executionEnvelope();
  const oldPoll = harness.api.pollRemoteRequest({ execution: executionA, pollId: "old-poll" });
  await waitForRemoteChannel(harness, executionA);

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  const lifecycleB = remoteLifecycle(harness, "remote-takeover", "executor-b");
  await lifecycleB.start();
  const executionB = lifecycleB.executionEnvelope();
  const newPoll = harness.api.pollRemoteRequest({ execution: executionB, pollId: "new-poll" });
  await waitForRemoteChannel(harness, executionB);
  assert.deepEqual(await oldPoll, { request: null });
  assert.equal(
    harness.app.remoteHostExecutorChannels.cancelPoll(executionA, "old-poll"),
    false,
  );
  assert.doesNotThrow(() => (
    harness.app.remoteHostExecutorChannels.ensureReady(executionB)
  ));
  await harness.api.disconnectRemoteChannel({ execution: executionB });
  assert.deepEqual(await newPoll, { request: null });
});

test("takeover between reserve and dispatch performs zero remote RPC", async () => {
  let reservationReached;
  const reserved = new Promise((resolve) => { reservationReached = resolve; });
  let releaseFence;
  const fence = new Promise((resolve) => { releaseFence = resolve; });
  let pauseOnce = true;
  const harness = await launchHarness({
    afterReserve: async () => {
      if (!pauseOnce) return;
      pauseOnce = false;
      reservationReached();
      await fence;
    },
  });
  const lifecycleA = remoteLifecycle(harness, "remote-final-fence", "executor-a");
  const stateA = await lifecycleA.start();
  const executionA = lifecycleA.executionEnvelope();
  const pollA = harness.api.pollRemoteRequest({ execution: executionA, pollId: "poll-a" });
  await waitForRemoteChannel(harness, executionA);
  const dispatchA = harness.api.executeEffect({
    effectKey: "remote-final-fence",
    execution: executionA,
    operations: [{ method: "thread/start", params: { cwd: "/srv/fenced" } }],
  });
  await reserved;

  harness.clock.value = Date.parse(stateA.lease.expiresAt);
  const lifecycleB = remoteLifecycle(harness, "remote-final-fence", "executor-b");
  await lifecycleB.start();
  const executionB = lifecycleB.executionEnvelope();
  releaseFence();
  await assert.rejects(
    dispatchA,
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_LEASE_STALE",
  );
  assert.equal(
    harness.app.remoteHostExecutorChannels.cancelPoll(executionA, "poll-a"),
    true,
  );
  assert.deepEqual(await pollA, { request: null });
  const pollB = harness.api.pollRemoteRequest({ execution: executionB, pollId: "poll-b" });
  await waitForRemoteChannel(harness, executionB);
  assert.doesNotThrow(() => harness.app.remoteHostExecutorChannels.ensureReady(executionB));
  await harness.api.disconnectRemoteChannel({ execution: executionB });
  assert.deepEqual(await pollB, { request: null });
  assert.equal(harness.localCalls.length, 0);
});

test("a remote result timeout becomes uncertain without a second delivery", async () => {
  const harness = await launchHarness({ requestTimeoutMs: 30 });
  const lifecycle = remoteLifecycle(harness, "remote-timeout", "executor-timeout");
  await lifecycle.start();
  const execution = lifecycle.executionEnvelope();
  const input = {
    effectKey: "remote-timeout-effect",
    execution,
    operations: [{ method: "thread/start", params: { cwd: "/srv/timeout" } }],
  };
  const poll = harness.api.pollRemoteRequest({ execution });
  await waitForRemoteChannel(harness, execution);
  const dispatched = harness.api.executeEffect(input);
  const delivery = await poll;
  assert.equal(delivery.request.operations.length, 1);
  await assert.rejects(
    dispatched,
    (error) => error?.status === 503 && error?.code === "HOST_EXECUTOR_CHANNEL_TIMEOUT",
  );
  await assert.rejects(
    () => harness.api.executeEffect(input),
    (error) => error?.status === 409 && error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
  );
  assert.equal(harness.localCalls.length, 0);
});

test("disjoint remote hosts progress concurrently without touching the local adapter", async () => {
  const harness = await launchHarness();
  const lifecycleA = remoteLifecycle(harness, "remote-parallel-a", "executor-a");
  const lifecycleB = remoteLifecycle(harness, "remote-parallel-b", "executor-b");
  await Promise.all([lifecycleA.start(), lifecycleB.start()]);
  const executionA = lifecycleA.executionEnvelope();
  const executionB = lifecycleB.executionEnvelope();
  const pollA = harness.api.pollRemoteRequest({ execution: executionA });
  const pollB = harness.api.pollRemoteRequest({ execution: executionB });
  await Promise.all([
    waitForRemoteChannel(harness, executionA),
    waitForRemoteChannel(harness, executionB),
  ]);
  const dispatchA = harness.api.executeEffect({
    effectKey: "remote-parallel-a",
    execution: executionA,
    operations: [{ method: "thread/start", params: { cwd: "/srv/a" } }],
  });
  const dispatchB = harness.api.executeEffect({
    effectKey: "remote-parallel-b",
    execution: executionB,
    operations: [{ method: "thread/start", params: { cwd: "/srv/b" } }],
  });
  const [deliveryA, deliveryB] = await Promise.all([pollA, pollB]);
  await Promise.all([
    harness.api.completeRemoteRequest({
      execution: executionA,
      requestId: deliveryA.request.id,
      outcome: { result: [{ thread: { id: "thread-a" } }] },
    }),
    harness.api.completeRemoteRequest({
      execution: executionB,
      requestId: deliveryB.request.id,
      outcome: { result: [{ thread: { id: "thread-b" } }] },
    }),
  ]);
  const [resultA, resultB] = await Promise.all([dispatchA, dispatchB]);
  assert.equal(resultA.results[0].thread.id, "thread-a");
  assert.equal(resultB.results[0].thread.id, "thread-b");
  assert.equal(harness.localCalls.length, 0);
});

test("remote runtime delivers one atomic operation envelope through the renderer bridge", async () => {
  const execution = {
    codexHostId: "remote-builder",
    executorInstanceId: "executor-runtime",
    registrationFingerprint: "a".repeat(64),
    leaseId: "lease-runtime",
  };
  const operations = [
    { method: "thread/resume", params: { threadId: "remote-root" } },
    { method: "turn/start", params: { threadId: "remote-root", approvalPolicy: "never" } },
  ];
  const rpcCalls = [];
  let completion = null;
  const result = await runRemoteHostExecutorChannelOnce({
    execution,
    pollRequest: async () => ({ request: { id: "request-1", operations } }),
    executeRpc: async (codexHostId, method, params) => {
      rpcCalls.push({ codexHostId, method, params });
      return { method };
    },
    completeRequest: async (input) => {
      completion = input;
      return { applied: true, replayed: false };
    },
    isCurrent: () => true,
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(rpcCalls, operations.map(({ method, params }) => ({
    codexHostId: "remote-builder", method, params,
  })));
  assert.deepEqual(completion, {
    execution,
    requestId: "request-1",
    outcome: { result: [{ method: "thread/resume" }, { method: "turn/start" }] },
  });
});

test("only an exact renderer JSON-RPC error is a definitive rejection", () => {
  assert.deepEqual(
    decodeCodexRendererRpcOutcome({
      kind: "response",
      message: { result: { thread: { id: "remote-thread" } } },
    }),
    { thread: { id: "remote-thread" } },
  );
  assert.throws(
    () => decodeCodexRendererRpcOutcome({
      kind: "response",
      message: { error: { message: "Selected model is at capacity." } },
    }),
    (error) => error?.definitiveRejection === true
      && error?.message === "Selected model is at capacity.",
  );
  for (const malformed of [
    { kind: "transport-error", error: "renderer timed out" },
    { kind: "response", message: {} },
    { kind: "response", message: { result: undefined } },
    { kind: "response", message: { result: {}, error: { message: "both" } } },
    { kind: "response", message: { error: "not-an-error-object" } },
    { kind: "response", message: { error: { message: "   " } } },
  ]) {
    assert.throws(
      () => decodeCodexRendererRpcOutcome(malformed),
      (error) => error?.definitiveRejection === false,
      JSON.stringify(malformed),
    );
  }
});

test("removing a host during execution sends no remaining RPC and no completion", async () => {
  const execution = {
    codexHostId: "remote-removal",
    executorInstanceId: "executor-removal",
    registrationFingerprint: "b".repeat(64),
    leaseId: "lease-removal",
  };
  let active = true;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const calls = [];
  const completions = [];
  const disconnects = [];
  const worker = createRemoteHostExecutorWorker({
    codexHostId: execution.codexHostId,
    lifecycle: {
      async start() { active = true; return { active: true }; },
      async reconcile() { return { active }; },
      async stop() { active = false; return { active: false }; },
      isActive: () => active,
      executionEnvelope: () => active ? execution : null,
      snapshot: () => ({ active }),
    },
    pollRequest: async () => ({
      request: {
        id: "removal-request",
        operations: [
          { method: "thread/resume", params: { threadId: "remote-root" } },
          { method: "turn/start", params: { threadId: "remote-root" } },
        ],
      },
    }),
    executeRpc: async (_host, method) => {
      calls.push(method);
      firstStarted();
      await firstGate;
      return { method };
    },
    completeRequest: async (input) => { completions.push(input); },
    disconnectRequest: async (input) => { disconnects.push(input); },
    wait: async () => {},
  });
  await worker.start();
  await started;
  const stopping = worker.stop();
  releaseFirst();
  await stopping;
  assert.deepEqual(calls, ["thread/resume"]);
  assert.deepEqual(completions, []);
  assert.deepEqual(disconnects, [{ execution }]);
});

test("inventory manager drives the real lease, channel, and renderer lifecycle", async () => {
  const harness = await launchHarness();
  const rpcCalls = [];
  let executorSequence = 0;
  const manager = createRemoteHostExecutorManager({
    createWorker: (codexHostId) => {
      const lifecycle = remoteLifecycle(
        harness,
        codexHostId,
        `executor-${codexHostId}-${++executorSequence}`,
      );
      return createRemoteHostExecutorWorker({
        codexHostId,
        lifecycle,
        pollRequest: harness.api.pollRemoteRequest,
        completeRequest: harness.api.completeRemoteRequest,
        disconnectRequest: harness.api.disconnectRemoteChannel,
        executeRpc: async (host, method, params) => {
          rpcCalls.push({ host, method, params });
          return { turn: { id: "manager-remote-turn" } };
        },
        retryDelayMs: 1,
      });
    },
  });
  await manager.reconcile(["remote-managed"]);
  const inspection = await harness.api.inspect({ codexHostId: "remote-managed" });
  const registration = inspection.registrations[0];
  const execution = {
    codexHostId: "remote-managed",
    executorInstanceId: registration.executorInstanceId,
    registrationFingerprint: registration.fingerprint,
    leaseId: inspection.lease.id,
  };
  await waitForRemoteChannel(harness, execution);
  const input = {
    effectKey: "remote-manager-lifecycle",
    execution,
    operations: [{ method: "turn/start", params: { threadId: "managed-root" } }],
  };
  const result = await harness.api.executeEffect(input);
  assert.equal(result.results?.[0]?.turn?.id, "manager-remote-turn");
  const replay = await harness.api.executeEffect(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(rpcCalls, [{
    host: "remote-managed",
    method: "turn/start",
    params: { threadId: "managed-root" },
  }]);
  const firstLeaseId = execution.leaseId;
  const firstExecutorInstanceId = execution.executorInstanceId;
  await manager.reconcile([]);
  await manager.reconcile(["remote-managed"]);
  const reappeared = await harness.api.inspect({ codexHostId: "remote-managed" });
  assert.equal(reappeared.lease.status, "active");
  assert.notEqual(reappeared.lease.id, firstLeaseId);
  assert.notEqual(reappeared.lease.executorInstanceId, firstExecutorInstanceId);
  const secondExecutorInstanceId = reappeared.lease.executorInstanceId;

  await manager.reconcile([]);
  harness.clock.value += 24 * 60 * 60 * 1_000 + 1;
  await manager.reconcile(["remote-managed"]);
  const thirdGeneration = await harness.api.inspect({ codexHostId: "remote-managed" });
  const thirdExecutorInstanceId = thirdGeneration.lease.executorInstanceId;
  assert.deepEqual(
    thirdGeneration.registrations.map((entry) => entry.executorInstanceId),
    [secondExecutorInstanceId, thirdExecutorInstanceId],
  );

  await manager.reconcile([]);
  harness.clock.value += 24 * 60 * 60 * 1_000 + 1;
  await manager.reconcile(["remote-managed"]);
  const fourthGeneration = await harness.api.inspect({ codexHostId: "remote-managed" });
  assert.deepEqual(
    fourthGeneration.registrations.map((entry) => entry.executorInstanceId),
    [thirdExecutorInstanceId, fourthGeneration.lease.executorInstanceId],
  );
  await manager.stop();
});

test("remote host inventory starts and releases only exact host workers", async () => {
  const events = [];
  const manager = createRemoteHostExecutorManager({
    createWorker: (codexHostId) => ({
      async start() { events.push(`start:${codexHostId}`); },
      async stop() { events.push(`stop:${codexHostId}`); },
    }),
  });
  await manager.reconcile(["remote-b", "remote-a", "remote-a"]);
  await manager.reconcile(["remote-b", "remote-c"]);
  await manager.stop();
  assert.deepEqual(events, [
    "start:remote-a",
    "start:remote-b",
    "stop:remote-a",
    "start:remote-c",
    "stop:remote-b",
    "stop:remote-c",
  ]);
});

test("remote worker stop aborts a hung renderer RPC before releasing its lifecycle", async () => {
  const execution = {
    codexHostId: "remote-hung-rpc",
    executorInstanceId: "executor-hung-rpc",
    registrationFingerprint: "c".repeat(64),
    leaseId: "lease-hung-rpc",
  };
  let rpcStarted;
  const started = new Promise((resolve) => { rpcStarted = resolve; });
  let releaseRpc;
  const rpcGate = new Promise((resolve) => { releaseRpc = resolve; });
  const events = [];
  const worker = createRemoteHostExecutorWorker({
    codexHostId: execution.codexHostId,
    lifecycle: {
      async start() { return { active: true }; },
      async reconcile() { return { active: true }; },
      async stop() { events.push("release"); return { active: false }; },
      isActive: () => true,
      executionEnvelope: () => execution,
      snapshot: () => ({ active: false }),
    },
    pollRequest: async () => ({
      request: {
        id: "hung-request",
        operations: [{ method: "turn/start", params: { threadId: "remote-root" } }],
      },
    }),
    executeRpc: async () => {
      events.push("rpc");
      rpcStarted();
      return rpcGate;
    },
    completeRequest: async () => { events.push("complete"); },
    disconnectRequest: async () => { events.push("disconnect"); },
    wait: async () => {},
  });
  await worker.start();
  await started;
  const stopping = worker.stop();
  const stoppedBeforeRpc = await Promise.race([
    stopping.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  releaseRpc({ turn: { id: "too-late" } });
  await stopping;
  assert.equal(stoppedBeforeRpc, true);
  assert.deepEqual(events, ["rpc", "disconnect", "release"]);
});

test("manager starts no later worker after stop races an in-flight start", async () => {
  const events = [];
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const manager = createRemoteHostExecutorManager({
    createWorker: (codexHostId) => ({
      async start() {
        events.push(`start:${codexHostId}`);
        if (codexHostId === "remote-a") {
          firstStarted();
          await firstGate;
        }
      },
      async stop() { events.push(`stop:${codexHostId}`); },
    }),
  });
  const reconciling = manager.reconcile(["remote-a", "remote-b"]);
  await started;
  const stopping = manager.stop();
  releaseFirst();
  await Promise.all([reconciling, stopping]);
  assert.equal(events.includes("start:remote-b"), false);
  assert.equal(events.includes("stop:remote-a"), true);
});

test("manager fences every worker before awaiting any slow stop", async () => {
  const events = [];
  let releaseFirstStop;
  const firstStopGate = new Promise((resolve) => { releaseFirstStop = resolve; });
  const manager = createRemoteHostExecutorManager({
    createWorker: (codexHostId) => ({
      async start() { events.push(`start:${codexHostId}`); },
      async stop() {
        events.push(`stop:${codexHostId}`);
        if (codexHostId === "remote-a") await firstStopGate;
      },
    }),
  });
  await manager.reconcile(["remote-a", "remote-b"]);
  const stopping = manager.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = [...events];
  releaseFirstStop();
  await stopping;
  assert.equal(beforeRelease.includes("stop:remote-a"), true);
  assert.equal(beforeRelease.includes("stop:remote-b"), true);
});

test("manager retains a failed-start handle until cleanup succeeds", async () => {
  let stopCalls = 0;
  const manager = createRemoteHostExecutorManager({
    createWorker: () => ({
      async start() { throw new Error("start failed"); },
      async stop() {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("cleanup failed");
      },
    }),
  });
  await assert.rejects(
    manager.reconcile(["remote-cleanup"]),
    (error) => error instanceof AggregateError
      && error.errors.some((entry) => entry?.message === "start failed")
      && error.errors.some((entry) => entry instanceof AggregateError),
  );
  await manager.stop();
  assert.equal(stopCalls, 2);
});

test("remote worker backs off and reports one consecutive failure per class", async () => {
  const execution = {
    codexHostId: "remote-backoff",
    executorInstanceId: "executor-backoff",
    registrationFingerprint: "d".repeat(64),
    leaseId: "lease-backoff",
  };
  const delays = [];
  const releases = [];
  const errors = [];
  let pollAttempt = 0;
  const worker = createRemoteHostExecutorWorker({
    codexHostId: execution.codexHostId,
    lifecycle: {
      async start() { return { active: true }; },
      async reconcile() { return { active: true }; },
      async stop() { return { active: false }; },
      isActive: () => true,
      executionEnvelope: () => execution,
      snapshot: () => ({ active: false }),
    },
    pollRequest: async () => {
      pollAttempt += 1;
      if (pollAttempt === 4) return { request: null };
      const error = new Error(pollAttempt === 3 ? "denied" : "offline");
      error.code = pollAttempt === 3 ? "CHANNEL_DENIED" : "CHANNEL_DOWN";
      throw error;
    },
    executeRpc: async () => ({}),
    completeRequest: async () => ({}),
    disconnectRequest: async () => ({}),
    wait: (delayMs) => new Promise((resolve) => {
      delays.push(delayMs);
      releases.push(resolve);
    }),
    onError: (error) => { errors.push(error.code); },
  });
  await worker.start();
  for (let index = 0; index < 4; index += 1) {
    while (delays.length <= index) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (index < 3) releases[index]();
  }
  const stopping = worker.stop();
  releases[3]();
  await stopping;
  assert.deepEqual(delays.slice(0, 4), [500, 1_000, 2_000, 500]);
  assert.deepEqual(errors, ["CHANNEL_DOWN", "CHANNEL_DENIED", "CHANNEL_DOWN"]);
});

test("remote worker stop interrupts an in-flight retry backoff", async () => {
  const execution = {
    codexHostId: "remote-backoff-stop",
    executorInstanceId: "executor-backoff-stop",
    registrationFingerprint: "e".repeat(64),
    leaseId: "lease-backoff-stop",
  };
  let retryStarted;
  const started = new Promise((resolve) => { retryStarted = resolve; });
  const worker = createRemoteHostExecutorWorker({
    codexHostId: execution.codexHostId,
    lifecycle: {
      async start() { return { active: true }; },
      async reconcile() { return { active: true }; },
      async stop() { return { active: false }; },
      isActive: () => true,
      executionEnvelope: () => execution,
      snapshot: () => ({ active: false }),
    },
    pollRequest: async () => { throw new Error("offline"); },
    executeRpc: async () => ({}),
    completeRequest: async () => ({}),
    disconnectRequest: async () => ({}),
    wait: async () => {
      retryStarted();
      return new Promise(() => {});
    },
  });
  await worker.start();
  await started;
  const stoppedPromptly = await Promise.race([
    worker.stop().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(stoppedPromptly, true);
});

test("remote inventory hard timeout closes its renderer and revokes old workers", async () => {
  assert.equal(typeof remoteHostRuntime.createRemoteHostInventoryController, "function");
  const renderer = { closed: false, close() { this.closed = true; } };
  let hang = false;
  const events = [];
  const manager = createRemoteHostExecutorManager({
    createWorker: (codexHostId) => ({
      async start() { events.push(`start:${codexHostId}`); },
      async stop() { events.push(`stop:${codexHostId}`); },
    }),
  });
  const controller = remoteHostRuntime.createRemoteHostInventoryController({
    listRenderers: () => [renderer],
    readHostIds: async () => (hang ? new Promise(() => {}) : ["remote-timeout"]),
    manager,
    readTimeoutMs: 10,
  });
  await controller.reconcile();
  hang = true;
  await assert.rejects(controller.reconcile(), /timed out/);
  assert.equal(renderer.closed, true);
  assert.equal(controller.rendererFor("remote-timeout"), null);
  assert.deepEqual(events, ["start:remote-timeout", "stop:remote-timeout"]);
  await controller.stop();
});

test("remote inventory fences a rebound worker before publishing its new renderer", async () => {
  assert.equal(typeof remoteHostRuntime.createRemoteHostInventoryController, "function");
  const oldRenderer = { name: "old", closed: false };
  const newRenderer = { name: "new", closed: false };
  let renderers = [oldRenderer];
  let controller;
  const observations = [];
  const manager = {
    async reconcile(hostIds, options = {}) {
      observations.push({
        hostIds: [...hostIds],
        startMissing: options.startMissing !== false,
        renderer: controller?.rendererFor("remote-rebound")?.name ?? null,
      });
      return { hosts: [...hostIds] };
    },
    async stop() {},
  };
  controller = remoteHostRuntime.createRemoteHostInventoryController({
    listRenderers: () => renderers,
    readHostIds: async () => ["remote-rebound"],
    manager,
    readTimeoutMs: 25,
  });
  await controller.reconcile();
  renderers = [newRenderer];
  await controller.reconcile();
  assert.deepEqual(observations, [
    { hostIds: [], startMissing: false, renderer: null },
    { hostIds: ["remote-rebound"], startMissing: true, renderer: "old" },
    { hostIds: [], startMissing: false, renderer: "old" },
    { hostIds: ["remote-rebound"], startMissing: true, renderer: "new" },
  ]);
  await controller.stop();
});

test("an expired remote inventory generation cannot publish stale hosts", async () => {
  assert.equal(typeof remoteHostRuntime.createRemoteHostInventoryController, "function");
  const oldRenderer = { name: "old", closed: false };
  const newRenderer = { name: "new", closed: false };
  let listCall = 0;
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  let oldReadStarted;
  const oldStarted = new Promise((resolve) => { oldReadStarted = resolve; });
  const events = [];
  const manager = {
    async reconcile(hostIds) { events.push([...hostIds]); return { hosts: [...hostIds] }; },
    async stop() {},
  };
  const controller = remoteHostRuntime.createRemoteHostInventoryController({
    listRenderers: () => (++listCall === 1 ? [oldRenderer] : [newRenderer]),
    readHostIds: async (renderer) => {
      if (renderer === oldRenderer) {
        oldReadStarted();
        await oldGate;
        return ["remote-old"];
      }
      return ["remote-new"];
    },
    manager,
    readTimeoutMs: 100,
  });
  const oldReconcile = controller.reconcile();
  await oldStarted;
  const newReconcile = controller.reconcile();
  releaseOld();
  await Promise.all([oldReconcile, newReconcile]);
  assert.equal(controller.rendererFor("remote-old"), null);
  assert.equal(controller.rendererFor("remote-new"), newRenderer);
  assert.equal(events.some((hosts) => hosts.includes("remote-old")), false);
  await controller.stop();
});
