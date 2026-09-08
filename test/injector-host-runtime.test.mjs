import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  classifyOwnerIntentPlanHttpFailure,
  classifyCoordinatorProvisioningActiveThread,
  classifyCoordinatorProvisioningDeliveryTurns,
  buildCoordinatorProvisioningDeliveryTurnStartParams,
  coordinatorProvisioningResponseJson,
  admissionRecoveryRpcTimeoutMs,
  coordinatorProvisioningTurnStartParams,
  planCoordinatorProvisioningDeliveryRetry,
  selectCoordinatorProvisioningFallbackModel,
  coordinatorProvisioningInspectionDiagnosticReason,
  coordinatorProvisioningThreadReadData,
  coordinatorProvisioningThreadListData,
  coordinatorProvisioningThreadListParams,
  coordinatorThreadSelectionConfirmed,
  createDisposableMonitorTimer,
  createOpenGenerationRouteResolver,
  createSerializedMonitorTick,
  deliverTaskboardAdmissionRecovery,
  deliverTaskboardCapacityObservation,
  deliverTaskboardCoordination,
  deliverTaskboardCrossDomainHandoff,
  deliverTaskboardOwnerDecision,
  deliverTaskboardOwnerIntent,
  findCoordinatorProvisioningThreadAcrossPages,
  findResidentInjectorPids,
  handleHostBindingPayload,
  isExactCoordinatorThreadNotLoadedError,
  isExactCoordinatorThreadNotMaterializedError,
  loadResidentCoordinatorMonitorProjects,
  observeTaskboardOwnerDecision,
  observeTaskboardOwnerIntentCapture,
  observeTaskboardOwnerIntentPlan,
  reconcileInjectionRuntime,
  readCoordinatorProvisioningDeliveryThread,
  readCoordinatorProvisioningAttemptThread,
  resumeCoordinatorProvisioningDeliveryThread,
  normalizeCoordinatorProvisioningPersistedThread,
  runOwnerDecisionMonitorOnce,
  runOwnerIntentAdoptionMonitorOnce,
  runOwnerIntentCaptureMonitorOnce,
  runOwnerIntentPlanningMonitorOnce,
  runBackgroundCoordinatorIdentityHandshakeMonitorOnce,
  runCoordinatorIdentityHandshakeFastLane,
  runCoordinatorLeaseKeepaliveMonitorOnce,
  runCoordinatorLeaseRecoveryMonitorOnce,
  runCoordinatorProvisioningMonitorOnce,
  runDomainCoordinatorProvisioningMonitorOnce,
  runDomainCoordinatorShutdownMonitorOnce,
  runCoordinatorShutdownMonitorOnce,
  runCrossDomainHandoffMonitorOnce,
  runTaskboardProjectMonitorSequence,
  runTaskboardContinuationFastLane,
  runTaskboardContinuationMonitorOnce,
  restartResidentInjector,
  selectCoordinatorProvisioningThread,
  selectResidentCoordinatorMonitorProjects,
  selectLaunchCoordinatorRoute,
} from "../scripts/codex-injector-runtime.mjs";

const coordinatorThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
const localHostExecutor = Object.freeze({ ownedCodexHostId: "local" });
const remoteHostExecutor = Object.freeze({ ownedCodexHostId: "remote-builder" });

function ownerDecisionMonitorSnapshot(request, laneOverrides = {}) {
  return {
    projectId: "taskboard-core",
    coordination: { ownerDecisionRequest: request },
    taskLanes: [{
      id: request.route.rootTaskId,
      threadId: request.route.rootThreadId,
      codexProjectId: request.route.codexProjectId,
      codexProjectKind: request.route.codexProjectKind,
      codexHostId: request.route.codexHostId,
      workspacePath: request.route.rootWorkspacePath,
      ...laneOverrides,
    }],
  };
}

test("Coordinator provisioning HTTP responses preserve the public status and error code", async () => {
  const accepted = await coordinatorProvisioningResponseJson(new Response(
    JSON.stringify({ attempt: { id: "accepted" } }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  assert.deepEqual(accepted, { attempt: { id: "accepted" } });
  await assert.rejects(
    coordinatorProvisioningResponseJson(new Response(
      JSON.stringify({ error: { code: "HOST_EXECUTOR_MISMATCH", details: "ignored" } }),
      { status: 409, headers: { "content-type": "application/json" } },
    )),
    (error) => error?.status === 409
      && error?.code === "HOST_EXECUTOR_MISMATCH"
      && error.message === "Taskboard Coordinator provisioning returned HTTP 409",
  );
  await assert.rejects(
    coordinatorProvisioningResponseJson(new Response("unavailable", { status: 503 })),
    (error) => error?.status === 503
      && error?.code === undefined
      && error.message === "Taskboard Coordinator provisioning returned HTTP 503",
  );
});

test("cold admission recovery allows bounded thread loading beyond the fast RPC budget", () => {
  assert.equal(admissionRecoveryRpcTimeoutMs("thread/read"), 10_000);
  assert.equal(admissionRecoveryRpcTimeoutMs("thread/resume"), 30_000);
  assert.equal(admissionRecoveryRpcTimeoutMs("turn/start"), 30_000);
  assert.equal(admissionRecoveryRpcTimeoutMs("turn/steer"), 10_000);
});

test("admission recovery replays its exact marker and rejects Root workspace drift", async () => {
  const request = {
    mode: "probe",
    rootThreadId: coordinatorThreadId,
    rootWorkspacePath: "/tmp/taskboard/project",
    admissionReceiptId: "receipt-cap46",
    admissionAttemptId: "attempt-cap46",
    admissionProbeId: "probe-cap46",
  };
  const calls = [];
  let turns = [];
  let instruction = null;
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === "thread/read") return {
      thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns },
    };
    if (method === "thread/resume") return {};
    if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      instruction = params.input[0].text;
      return { turn: { id: "turn-cap46-probe" } };
    }
    return assert.fail(`unexpected RPC ${method}`);
  };

  assert.deepEqual(await deliverTaskboardAdmissionRecovery(request, rpc), {
    delivery: "started",
    turnId: "turn-cap46-probe",
  });
  assert.match(instruction, /Taskboard admission recovery probe id: receipt-cap46:attempt-cap46:probe-cap46/);
  turns = [{ id: "turn-cap46-probe", status: "completed", items: [{ text: instruction }] }];
  const priorCallCount = calls.length;
  assert.deepEqual(await deliverTaskboardAdmissionRecovery(request, rpc), {
    delivery: "observed",
    turnId: "turn-cap46-probe",
  });
  assert.deepEqual(calls.slice(priorCallCount), ["thread/read"]);

  await assert.rejects(
    deliverTaskboardAdmissionRecovery(request, async () => ({
      thread: { id: request.rootThreadId, cwd: "/tmp/taskboard/other", turns: [] },
    })),
    /workspace/,
  );
});

test("admission recovery retries the same probe after a terminal transport failure", async () => {
  const request = {
    mode: "probe",
    rootThreadId: coordinatorThreadId,
    rootWorkspacePath: "/tmp/taskboard/project",
    admissionReceiptId: "receipt-cap51",
    admissionAttemptId: "attempt-cap51",
    admissionProbeId: "probe-cap51",
  };
  const marker = "Taskboard admission recovery probe id: receipt-cap51:attempt-cap51:probe-cap51";
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === "thread/read") return {
      thread: {
        id: request.rootThreadId,
        cwd: request.rootWorkspacePath,
        status: { type: "systemError" },
        turns: [{
          id: "01a074f5-e2e3-77a1-9586-0d7505a1dc98",
          status: "failed",
          completedAt: "2026-09-06T05:37:23Z",
          input: marker,
          error: { message: "stream disconnected before completion" },
        }],
      },
    };
    if (method === "thread/resume") return {};
    if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      assert.match(params.input[0].text, new RegExp(marker));
      return { turn: { id: "turn-cap51-retry" } };
    }
    return assert.fail(`unexpected RPC ${method}`);
  };

  assert.deepEqual(await deliverTaskboardAdmissionRecovery(request, rpc, {
    now: () => Date.parse("2026-09-06T05:38:00Z"),
  }), {
    delivery: "started",
    turnId: "turn-cap51-retry",
  });
  assert.deepEqual(calls, ["thread/read", "thread/resume", "turn/start"]);
});

test("admission recovery backs off a recent terminal retry without opening another turn", async () => {
  const request = {
    mode: "probe",
    rootThreadId: coordinatorThreadId,
    rootWorkspacePath: "/tmp/taskboard/project",
    admissionReceiptId: "receipt-cap51-backoff",
    admissionAttemptId: "attempt-cap51-backoff",
    admissionProbeId: "probe-cap51-backoff",
  };
  const marker = "Taskboard admission recovery probe id: receipt-cap51-backoff:attempt-cap51-backoff:probe-cap51-backoff";
  const calls = [];
  const rpc = async (method) => {
    calls.push(method);
    return {
      thread: {
        id: request.rootThreadId,
        cwd: request.rootWorkspacePath,
        turns: [{
          id: "01a074f5-e2e3-77a1-9586-0d7505a1dc98",
          status: "failed",
          completedAt: "2026-09-06T05:37:23Z",
          input: marker,
          error: { message: "stream disconnected before completion" },
        }],
      },
    };
  };

  assert.deepEqual(await deliverTaskboardAdmissionRecovery(request, rpc, {
    now: () => Date.parse("2026-09-06T05:37:28Z"),
  }), {
    delivery: "deferred",
    reason: "terminal-retry-backoff",
  });
  assert.deepEqual(calls, ["thread/read"]);
});

test("admission recovery fails closed when a marked turn has an unknown status", async () => {
  const request = {
    mode: "probe",
    rootThreadId: coordinatorThreadId,
    rootWorkspacePath: "/tmp/taskboard/project",
    admissionReceiptId: "receipt-cap51-unknown",
    admissionAttemptId: "attempt-cap51-unknown",
    admissionProbeId: "probe-cap51-unknown",
  };
  const marker = "Taskboard admission recovery probe id: receipt-cap51-unknown:attempt-cap51-unknown:probe-cap51-unknown";
  const calls = [];
  const rpc = async (method) => {
    calls.push(method);
    return {
      thread: {
        id: request.rootThreadId,
        cwd: request.rootWorkspacePath,
        turns: [{ id: "turn-unknown", status: "mystery", input: marker }],
      },
    };
  };

  assert.deepEqual(await deliverTaskboardAdmissionRecovery(request, rpc), {
    delivery: "deferred",
    reason: "delivery-status-unconfirmed",
  });
  assert.deepEqual(calls, ["thread/read"]);
});

test("Coordinator delivery verifies identity and lease before scanning only current work", () => {
  const params = buildCoordinatorProvisioningDeliveryTurnStartParams({
    attempt: {
      id: "attempt-current-work",
      idempotencyKey: "coordinator-current-work",
      taskId: "coordinator-capstone-dev-current",
      label: "Taskboard Execution Coordinator",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    },
    threadId: coordinatorThreadId,
    projectId: "capstone-dev",
    taskctlPath: "/tmp/taskboard/cli/taskctl.mjs",
    runtimeFile: "/tmp/taskboard/.data/launcher-runtime.json",
    selectedModel: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    workspacePath: "/tmp/taskboard/workspace",
  });
  const instruction = params.input[0].text;

  const registration = instruction.indexOf("Register exactly this window");
  const lease = instruction.indexOf("Acquire one 300-second Global Coordinator lease");
  const replay = instruction.indexOf("Replay the same registration after success");
  const workScan = instruction.indexOf("list current issues for project capstone-dev");
  assert.ok(registration >= 0 && registration < lease);
  assert.ok(lease < replay && replay < workScan);
  assert.match(instruction, /Bootstrap eligible todo issues and continue unfinished in_progress issues/);
  assert.match(instruction, /Do not assign backlog, scan historical done or canceled issues/);
  assert.match(instruction, /read back windows, status, and receipts/);
  assert.doesNotMatch(instruction, /CAP-15/);
  assert.equal(params.threadId, coordinatorThreadId);
  assert.equal(params.model, "gpt-5.6-sol");
});

test("an idle unarchived Coordinator with a protected workspace drift is stale", () => {
  const window = {
    taskId: "root",
    label: "Execution Coordinator",
    role: "coordinator",
    threadId: coordinatorThreadId,
    workspacePath: "/Users/v-sheng.huang/sbkk",
  };
  assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
    window,
    thread: {
      id: coordinatorThreadId,
      cwd: "/Users/v-sheng.huang/sboai",
      status: { type: "notLoaded" },
      turns: [{ status: "completed" }, { status: "interrupted" }],
    },
    activeThreads: [{ id: coordinatorThreadId }],
  }), {
    eligibility: "stale",
    reason: "active-thread-binding-drift",
    window,
  });
  assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
    window,
    thread: {
      id: coordinatorThreadId,
      cwd: "/Users/v-sheng.huang/sboai",
      status: { type: "notLoaded" },
      turns: [{ status: "completed" }],
    },
    activeThreads: [],
  }), {
    eligibility: "stale",
    reason: "inactive-thread-binding-drift",
    window,
  });
  for (const status of [{ type: "active" }, { type: "running" }, { type: "mystery" }, null]) {
    assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
      window,
      thread: {
        id: coordinatorThreadId,
        cwd: "/Users/v-sheng.huang/sboai",
        status,
        turns: [{ status: "completed" }],
      },
      activeThreads: [{ id: coordinatorThreadId }],
    }), {
      eligibility: "uncertain",
      reason: status?.type === "active" || status?.type === "running"
        ? "thread-status-active"
        : "thread-status-unconfirmed",
      window,
    });
  }
  assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
    window,
    thread: null,
    activeThreads: [{ id: coordinatorThreadId }],
  }), {
    eligibility: "uncertain",
    reason: "active-thread-binding-unconfirmed",
    window,
  });
  for (const turns of [undefined, null]) {
    assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
      window,
      thread: { id: coordinatorThreadId, cwd: "/Users/v-sheng.huang/sboai", turns },
      activeThreads: [{ id: coordinatorThreadId }],
    }), {
      eligibility: "uncertain",
      reason: "thread-state-unconfirmed",
      window,
    });
  }
  assert.deepEqual(classifyCoordinatorProvisioningActiveThread({
    window,
    thread: { id: coordinatorThreadId, cwd: window.workspacePath, turns: [] },
    activeThreads: [{ id: coordinatorThreadId }],
  }), {
    eligibility: "eligible",
    busy: false,
    reason: "active-thread",
    window,
  });
});

test("Coordinator provisioning rejects an unauthenticated thread list shape", () => {
  for (const result of [{}, { data: null }, { data: {} }]) {
    assert.throws(
      () => coordinatorProvisioningThreadListData(result),
      /exact thread list array/,
    );
  }
  const threads = [{ id: coordinatorThreadId }];
  assert.equal(coordinatorProvisioningThreadListData({ data: threads }), threads);
});

test("Coordinator provisioning recognizes only its exact thread-not-loaded error", () => {
  const threadId = "01a06791-4dc0-7373-bbee-d7582187ea28";
  assert.equal(
    isExactCoordinatorThreadNotLoadedError(new Error(`thread not loaded: ${threadId}`), threadId),
    true,
  );
  assert.equal(
    isExactCoordinatorThreadNotLoadedError(new Error("Codex App Server request timed out"), threadId),
    false,
  );
  assert.equal(
    isExactCoordinatorThreadNotLoadedError(
      new Error("thread not loaded: 01a00000-0000-7000-8000-000000000000"), threadId,
    ),
    false,
  );
  const thread = { id: threadId };
  assert.equal(coordinatorProvisioningThreadReadData({ thread }), thread);
  assert.throws(
    () => coordinatorProvisioningThreadReadData({}),
    /did not return one exact thread object/,
  );
  assert.throws(
    () => coordinatorProvisioningThreadReadData({ thread: [] }),
    /did not return one exact thread object/,
  );
});

test("Coordinator provisioning materializes one exact empty thread before first delivery", async () => {
  const threadId = "01a067a2-41dc-7400-9515-19625a1c55ed";
  const attempt = {
    threadSource: "taskboard-coordinator-provision-stable",
    workspacePath: "/tmp/taskboard",
  };
  const unmaterialized = new Error(
    `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`,
  );
  assert.equal(isExactCoordinatorThreadNotMaterializedError(unmaterialized, threadId), true);
  assert.equal(
    isExactCoordinatorThreadNotMaterializedError(unmaterialized, coordinatorThreadId),
    false,
  );
  assert.equal(
    isExactCoordinatorThreadNotMaterializedError(new Error("Codex App Server request timed out"), threadId),
    false,
  );

  const calls = [];
  const thread = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId,
    readThread: async (includeTurns) => {
      calls.push(includeTurns);
      if (includeTurns) throw unmaterialized;
      return {
        thread: {
          id: threadId,
          threadSource: attempt.threadSource,
          cwd: attempt.workspacePath,
        },
      };
    },
  });
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(thread.turns, []);
  assert.equal(thread.deliveryMaterialized, false);

  const materialized = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId,
    readThread: async (includeTurns) => ({
      thread: {
        id: threadId,
        threadSource: attempt.threadSource,
        cwd: attempt.workspacePath,
        turns: includeTurns ? [] : null,
      },
    }),
  });
  assert.equal(materialized.deliveryMaterialized, true);
  assert.deepEqual(materialized.turns, []);

  let resumeCalls = 0;
  assert.equal(await resumeCoordinatorProvisioningDeliveryThread(thread, async () => {
    resumeCalls += 1;
  }), false);
  assert.equal(resumeCalls, 0);
  assert.equal(await resumeCoordinatorProvisioningDeliveryThread(materialized, async () => {
    resumeCalls += 1;
  }), true);
  assert.equal(resumeCalls, 1);

  const transientCalls = [];
  await assert.rejects(
    readCoordinatorProvisioningDeliveryThread({
      attempt,
      threadId,
      readThread: async (includeTurns) => {
        transientCalls.push(includeTurns);
        throw new Error("Codex App Server request timed out");
      },
    }),
    /timed out/,
  );
  assert.deepEqual(transientCalls, [true]);

  await assert.rejects(
    readCoordinatorProvisioningDeliveryThread({
      attempt,
      threadId,
      readThread: async (includeTurns) => {
        if (includeTurns) throw unmaterialized;
        return { thread: {} };
      },
    }),
    /did not confirm the exact provisioned Coordinator thread/,
  );
});

test("Coordinator provisioning retries terminal delivery turns on the same thread", () => {
  const marker = "TASKBOARD_COORDINATOR_PROVISIONING_V1:attempt-1";
  const marked = (status, id) => ({ id, status, input: marker });
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns([marked("completed", "turn-complete")], marker),
    { delivery: "observed", turnId: "turn-complete" },
  );
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns(
      [marked("completed", "turn-complete")], marker, { completedIsSuccess: false },
    ),
    { delivery: "retry", turnId: null },
  );
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns([
      marked("completed", "turn-complete"),
      marked("inProgress", "turn-retry"),
    ], marker, { completedIsSuccess: false }),
    { delivery: "busy", turnId: "turn-retry" },
  );
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns([marked("inProgress", "turn-active")], marker),
    { delivery: "busy", turnId: "turn-active" },
  );
  for (const status of ["interrupted", "failed", "canceled"]) {
    assert.deepEqual(
      classifyCoordinatorProvisioningDeliveryTurns([marked(status, `turn-${status}`)], marker),
      { delivery: "retry", turnId: null },
    );
  }
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns([
      marked("interrupted", "old-marker"),
      { id: "unrelated-active", status: "inProgress", input: "other work" },
    ], marker),
    { delivery: "busy", turnId: "unrelated-active" },
  );
});

test("Coordinator provisioning backs off capacity on the same delivery model", () => {
  const marker = "TASKBOARD_COORDINATOR_PROVISIONING_V1:attempt-capacity";
  const completedAt = Date.parse("2026-09-04T02:00:00Z");
  const turns = [{
    id: "turn-capacity",
    status: "failed",
    completedAt: completedAt / 1_000,
    input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-5.5\nTASKBOARD_COORDINATOR_DELIVERY_EFFORT_V1:high`,
    error: { message: "Selected model is at capacity. Please try a different model." },
  }];

  assert.deepEqual(planCoordinatorProvisioningDeliveryRetry(turns, marker, {
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "ultra",
    now: completedAt + 5_000,
  }), {
    failureKind: "model-capacity",
    currentModel: "gpt-5.5",
    currentReasoningEffort: "high",
    unsupportedModels: [],
    retryAfterMs: 10_000,
  });
});

test("Domain provisioning backs off a completed turn until its lease exists", () => {
  const marker = "TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:attempt-domain";
  const completedAt = Date.parse("2026-09-05T02:00:00Z");
  const turns = [{
    id: "turn-domain-incomplete",
    status: "completed",
    completedAt: completedAt / 1_000,
    input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-5.6-sol\nTASKBOARD_COORDINATOR_DELIVERY_EFFORT_V1:high`,
  }];

  assert.deepEqual(planCoordinatorProvisioningDeliveryRetry(turns, marker, {
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "high",
    now: completedAt + 5_000,
    retryCompleted: true,
  }), {
    failureKind: "transient",
    currentModel: "gpt-5.6-sol",
    currentReasoningEffort: "high",
    unsupportedModels: [],
    retryAfterMs: 10_000,
  });
});

test("Coordinator provisioning excludes deterministically unsupported delivery models", () => {
  const marker = "TASKBOARD_COORDINATOR_PROVISIONING_V1:attempt-unsupported";
  const turns = [
    {
      id: "turn-terra",
      status: "failed",
      completedAt: "2026-09-04T02:01:00Z",
      input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-5.6-terra\nTASKBOARD_COORDINATOR_DELIVERY_EFFORT_V1:high`,
      error: { message: "The 'gpt-5.6-terra' model is not supported when using Codex with a ChatGPT account." },
    },
    {
      id: "turn-sol",
      status: "failed",
      completedAt: "2026-09-04T02:00:00Z",
      input: marker,
      error: { message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." },
    },
  ];
  const plan = planCoordinatorProvisioningDeliveryRetry(turns, marker, {
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "ultra",
    now: Date.parse("2026-09-04T02:02:00Z"),
  });
  assert.deepEqual(plan, {
    failureKind: "model-unsupported",
    currentModel: "gpt-5.6-terra",
    currentReasoningEffort: "high",
    unsupportedModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    retryAfterMs: 0,
  });
  assert.deepEqual(selectCoordinatorProvisioningFallbackModel([
    {
      id: "gpt-5.6-sol", hidden: false, isDefault: true,
      defaultReasoningEffort: "ultra",
      supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
    },
    {
      id: "gpt-5.6-terra", hidden: false, isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    },
    {
      id: "gpt-5.5", hidden: false, isDefault: false,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }],
    },
  ], plan.unsupportedModels, plan.currentReasoningEffort), {
    model: "gpt-5.5",
    reasoningEffort: "high",
  });
  const taskboardWorkspacePath = path.resolve("/tmp/taskboard");
  assert.deepEqual(coordinatorProvisioningTurnStartParams(
    coordinatorThreadId,
    `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-5.5`,
    { model: "gpt-5.5", reasoningEffort: "high" },
    taskboardWorkspacePath,
  ), {
    threadId: coordinatorThreadId,
    input: [{
      type: "text",
      text: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-5.5`,
    }],
    model: "gpt-5.5",
    effort: "high",
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [taskboardWorkspacePath],
      networkAccess: true,
    },
  });
});

test("Coordinator provisioning fails closed on chronological terminal turns without durable time", () => {
  const marker = "TASKBOARD_COORDINATOR_PROVISIONING_V1:attempt-no-time";
  const plan = planCoordinatorProvisioningDeliveryRetry([
    {
      id: "legacy-turn-old",
      status: "failed",
      input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-old`,
      error: { message: "Selected model is at capacity. Please try a different model." },
    },
    {
      id: "legacy-turn-new",
      status: "failed",
      input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-new`,
      error: { message: "The 'gpt-new' model is not supported when using Codex with a ChatGPT account." },
    },
  ], marker, {
    defaultModel: "gpt-default",
    defaultReasoningEffort: "high",
    now: Date.parse("2026-09-04T02:02:00Z"),
  });
  assert.deepEqual(plan, {
    failureKind: "model-unsupported",
    currentModel: "gpt-new",
    currentReasoningEffort: "high",
    unsupportedModels: ["gpt-new"],
    retryAfterMs: 300_000,
  });
});

test("Coordinator provisioning derives durable backoff time from App Server UUIDv7 turn ids", () => {
  const marker = "TASKBOARD_COORDINATOR_PROVISIONING_V1:attempt-uuid-time";
  const latestTurnId = "01a067da-f4a5-7583-847e-63aea37d1205";
  const latestTurnTime = Number.parseInt("01a067daf4a5", 16);
  assert.deepEqual(planCoordinatorProvisioningDeliveryRetry([
    {
      id: "01a067d9-d160-7d53-b5d2-fc7a2999b197",
      status: "failed",
      input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-old`,
      error: { message: "Selected model is at capacity. Please try a different model." },
    },
    {
      id: latestTurnId,
      status: "failed",
      input: `${marker}\nTASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:gpt-new`,
      error: { message: "The 'gpt-new' model is not supported when using Codex with a ChatGPT account." },
    },
  ], marker, {
    defaultModel: "gpt-default",
    defaultReasoningEffort: "high",
    now: latestTurnTime + 5_000,
  }), {
    failureKind: "model-unsupported",
    currentModel: "gpt-new",
    currentReasoningEffort: "high",
    unsupportedModels: ["gpt-new"],
    retryAfterMs: 10_000,
  });
});

test("Coordinator provisioning recovers a persisted null source only from its exact marker", async () => {
  const attempt = {
    id: "attempt-persisted",
    threadId: "01a067b2-4a8f-72c2-9c3d-85a89017233c",
    threadSource: "taskboard-coordinator-provision-stable",
    workspacePath: "/tmp/taskboard",
  };
  const marker = `TASKBOARD_COORDINATOR_PROVISIONING_V1:${attempt.id}`;
  const persisted = {
    id: attempt.threadId,
    threadSource: null,
    cwd: attempt.workspacePath,
    turns: [{ id: "turn-1", status: "interrupted", input: marker }],
  };
  assert.equal(
    normalizeCoordinatorProvisioningPersistedThread(attempt, persisted).threadSource,
    attempt.threadSource,
  );
  assert.equal(
    normalizeCoordinatorProvisioningPersistedThread(attempt, { ...persisted, turns: [] }).threadSource,
    null,
  );
  assert.equal(
    normalizeCoordinatorProvisioningPersistedThread(attempt, { ...persisted, cwd: "/tmp/other" }).threadSource,
    null,
  );
  assert.equal(
    normalizeCoordinatorProvisioningPersistedThread(attempt, {
      ...persisted, threadSource: "conflicting-source",
    }).threadSource,
    "conflicting-source",
  );
  const domainMarker = `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${attempt.id}`;
  const recoveredDomain = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId: attempt.threadId,
    marker: domainMarker,
    readThread: async () => ({
      thread: {
        ...persisted,
        turns: [{ id: "turn-domain", status: "completed", input: domainMarker }],
      },
    }),
  });
  assert.equal(recoveredDomain.threadSource, attempt.threadSource);

  const calls = [];
  const recovered = await readCoordinatorProvisioningAttemptThread({
    attempt,
    readThread: async (includeTurns) => {
      calls.push(includeTurns);
      return { thread: persisted };
    },
  });
  assert.deepEqual(calls, [true]);
  assert.equal(recovered.threadSource, attempt.threadSource);

  const deliveryThread = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId: attempt.threadId,
    readThread: async () => ({ thread: persisted }),
  });
  assert.equal(deliveryThread.threadSource, attempt.threadSource);
  assert.deepEqual(
    classifyCoordinatorProvisioningDeliveryTurns(deliveryThread.turns, marker),
    { delivery: "retry", turnId: null },
  );
  for (const rejected of [
    { ...persisted, turns: [] },
    { ...persisted, threadSource: "conflicting-source" },
  ]) {
    await assert.rejects(
      readCoordinatorProvisioningDeliveryThread({
        attempt,
        threadId: attempt.threadId,
        readThread: async () => ({ thread: rejected }),
      }),
      /did not confirm the exact provisioned Coordinator thread/,
    );
  }

  const unmaterialized = new Error(
    `thread ${attempt.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
  );
  const freshCalls = [];
  const fresh = await readCoordinatorProvisioningAttemptThread({
    attempt,
    readThread: async (includeTurns) => {
      freshCalls.push(includeTurns);
      if (includeTurns) throw unmaterialized;
      return { thread: { ...persisted, threadSource: attempt.threadSource, turns: undefined } };
    },
  });
  assert.deepEqual(freshCalls, [true, false]);
  assert.equal(fresh.threadSource, attempt.threadSource);

  assert.equal(await readCoordinatorProvisioningAttemptThread({
    attempt,
    readThread: async () => {
      throw new Error(`thread not loaded: ${attempt.threadId}`);
    },
  }), null);
  await assert.rejects(
    readCoordinatorProvisioningAttemptThread({
      attempt,
      readThread: async () => { throw new Error("Codex App Server request timed out"); },
    }),
    /timed out/,
  );
});

test("Coordinator provisioning searches every authenticated app-server thread source", () => {
  const attempt = {
    threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
    workspacePath: "/tmp/taskboard",
  };
  assert.deepEqual(coordinatorProvisioningThreadListParams(attempt, false), {
    cwd: attempt.workspacePath,
    archived: false,
    limit: 100,
    sourceKinds: [
      "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
      "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
    ],
  });
  assert.deepEqual(coordinatorProvisioningThreadListParams(attempt, true, "next"), {
    cwd: attempt.workspacePath,
    archived: true,
    limit: 100,
    sourceKinds: [
      "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
      "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
    ],
    cursor: "next",
  });
});

test("Coordinator provisioning selects only the exact active thread bound to a started attempt", () => {
  const attempt = {
    threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
    threadSource: "taskboard-coordinator-provision-stable",
    workspacePath: "/tmp/taskboard",
  };
  const exact = {
    id: attempt.threadId, threadSource: attempt.threadSource, cwd: attempt.workspacePath,
  };
  assert.equal(selectCoordinatorProvisioningThread(attempt, [exact]), exact);
  assert.equal(selectCoordinatorProvisioningThread(attempt, []), null);
  assert.throws(() => selectCoordinatorProvisioningThread(attempt, [{
    ...exact, id: "01a08888-a749-7b53-81e2-af2d477f93ae",
  }]), /conflicting threads/);
});

test("Coordinator provisioning inspection diagnostics allow only finite reasons", () => {
  assert.equal(
    coordinatorProvisioningInspectionDiagnosticReason("thread-status-unconfirmed"),
    "thread-status-unconfirmed",
  );
  assert.equal(
    coordinatorProvisioningInspectionDiagnosticReason("thread=secret cwd=/private token=value"),
    "unknown",
  );
  assert.equal(coordinatorProvisioningInspectionDiagnosticReason(null), "unknown");
});

test("background Coordinator identity handshake verifies the exact host thread without changing foreground focus", async () => {
  const confirmations = [];
  const workspacePath = path.resolve("/tmp/sbkk");
  const result = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "local",
    hostExecutor: localHostExecutor,
    listHandshakes: async () => ({ handshakes: [{
      id: "handshake-1", role: "coordinator", threadId: coordinatorThreadId,
      registration: {
        projectId: "local", role: "coordinator", taskId: "coordinator-task",
        label: "Coordinator", threadId: coordinatorThreadId,
        expectedRevision: "a".repeat(64), idempotencyKey: "handshake-1",
      },
      expectedHostBinding: {
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath,
      },
    }] }),
    readThread: async ({ threadId, codexHostId }) => {
      assert.equal(threadId, coordinatorThreadId);
      assert.equal(codexHostId, "local");
      return { thread: { id: threadId, cwd: workspacePath } };
    },
    confirmIdentity: async (handshakeId, registration, binding) => (
      confirmations.push({ handshakeId, registration, binding })
    ),
  });
  assert.deepEqual(result, { confirmed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(confirmations, [{
    handshakeId: "handshake-1",
    registration: {
      projectId: "local", role: "coordinator", taskId: "coordinator-task",
      label: "Coordinator", threadId: coordinatorThreadId,
      expectedRevision: "a".repeat(64), idempotencyKey: "handshake-1",
    },
    binding: {
    threadId: coordinatorThreadId,
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath,
  } }]);

  const wrongWorkspace = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "local",
    hostExecutor: localHostExecutor,
    listHandshakes: async () => ({ handshakes: [{
      id: "handshake-2", role: "coordinator", threadId: coordinatorThreadId,
      registration: {
        projectId: "local", role: "coordinator", taskId: "coordinator-task",
        label: "Coordinator", threadId: coordinatorThreadId,
        expectedRevision: "a".repeat(64), idempotencyKey: "handshake-2",
      },
      expectedHostBinding: {
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      },
    }] }),
    readThread: async () => ({ thread: { id: coordinatorThreadId, cwd: "/tmp/other" } }),
    confirmIdentity: async () => { throw new Error("must not confirm"); },
  });
  assert.deepEqual(wrongWorkspace, { confirmed: 0, skipped: 1, failed: 0 });
});

test("Coordinator identity handshake reads and confirms only the exact owned host", async () => {
  const remoteThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  const workspacePath = "/tmp/taskboard/remote";
  const remoteHandshake = {
    id: "handshake-remote",
    role: "coordinator",
    threadId: remoteThreadId,
    registration: {
      projectId: "taskboard-core",
      role: "coordinator",
      taskId: "remote-coordinator",
      label: "Remote Coordinator",
      threadId: remoteThreadId,
      expectedRevision: "b".repeat(64),
      idempotencyKey: "handshake-remote",
    },
    expectedHostBinding: {
      codexProjectId: "remote-project",
      codexProjectKind: "remote",
      codexHostId: remoteHostExecutor.ownedCodexHostId,
      workspacePath,
    },
  };
  let reads = 0;
  let confirmations = 0;
  const foreignResult = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "taskboard-core",
    hostExecutor: localHostExecutor,
    listHandshakes: async () => ({ handshakes: [remoteHandshake] }),
    readThread: async () => { reads += 1; },
    confirmIdentity: async () => { confirmations += 1; },
  });
  assert.deepEqual(foreignResult, { confirmed: 0, skipped: 1, failed: 0 });
  assert.equal(reads, 0);
  assert.equal(confirmations, 0);

  const localThreadId = coordinatorThreadId;
  const ownedResult = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "taskboard-core",
    hostExecutor: remoteHostExecutor,
    listHandshakes: async () => ({ handshakes: [{
      ...remoteHandshake,
      id: "handshake-local",
      threadId: localThreadId,
      registration: {
        ...remoteHandshake.registration,
        taskId: "local-coordinator",
        threadId: localThreadId,
        idempotencyKey: "handshake-local",
      },
      expectedHostBinding: {
        ...remoteHandshake.expectedHostBinding,
        codexProjectId: "local-project",
        codexProjectKind: "local",
        codexHostId: localHostExecutor.ownedCodexHostId,
        workspacePath: "/tmp/taskboard/local",
      },
    }, remoteHandshake] }),
    readThread: async (route) => {
      reads += 1;
      assert.deepEqual(route, {
        threadId: remoteThreadId,
        codexHostId: remoteHostExecutor.ownedCodexHostId,
      });
      return { thread: { id: remoteThreadId, cwd: workspacePath } };
    },
    confirmIdentity: async (handshakeId, registration, binding) => {
      confirmations += 1;
      assert.equal(handshakeId, remoteHandshake.id);
      assert.equal(registration, remoteHandshake.registration);
      assert.equal(binding.codexHostId, remoteHostExecutor.ownedCodexHostId);
    },
  });
  assert.deepEqual(ownedResult, { confirmed: 1, skipped: 1, failed: 0 });
  assert.equal(reads, 1);
  assert.equal(confirmations, 1);
});

test("each open generation resolves one fresh Coordinator route and coalesces retries", async () => {
  const coordinatorB = "01a004bd-a749-7b53-81e2-af2d477f93af";
  const routes = [
    { taskId: "coordinator-a", threadId: coordinatorThreadId },
    { taskId: "coordinator-b", threadId: coordinatorB },
  ];
  let calls = 0;
  let releaseFirst;
  const resolver = createOpenGenerationRouteResolver(async () => {
    const route = routes[calls];
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return route;
  });
  const selected = [];
  const pinned = [];
  const openGeneration = async (generation) => {
    const route = await resolver(generation);
    selected.push(route.threadId);
    pinned.push(route.threadId);
  };

  const first = resolver(1);
  const duplicate = resolver(1);
  assert.equal(calls, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, duplicate]), [routes[0], routes[0]]);
  assert.equal(await resolver(1), routes[0]);
  assert.equal(calls, 1);
  await openGeneration(1);
  assert.equal(await resolver(2), routes[1]);
  assert.equal(await resolver(2), routes[1]);
  assert.equal(calls, 2);
  await openGeneration(2);
  assert.deepEqual(selected, [coordinatorThreadId, coordinatorB]);
  assert.deepEqual(pinned, [coordinatorThreadId, coordinatorB]);
  assert.equal(calls, 2);
});

test("a failed open generation route resolution remains retryable", async () => {
  let calls = 0;
  const route = { taskId: "coordinator-a", threadId: coordinatorThreadId };
  const resolver = createOpenGenerationRouteResolver(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary snapshot failure");
    return route;
  });
  await assert.rejects(resolver(1), /temporary snapshot failure/);
  assert.equal(await resolver(1), route);
  assert.equal(calls, 2);
});

test("Coordinator selection waits for a delayed active row instead of trusting the pathname", () => {
  assert.equal(coordinatorThreadSelectionConfirmed({
    expectedThreadId: coordinatorThreadId,
    activeThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    routeThreadId: coordinatorThreadId,
  }), false);
  assert.equal(coordinatorThreadSelectionConfirmed({
    expectedThreadId: coordinatorThreadId,
    activeThreadId: coordinatorThreadId,
    routeThreadId: coordinatorThreadId,
  }), true);
  assert.equal(coordinatorThreadSelectionConfirmed({
    expectedThreadId: coordinatorThreadId,
    activeThreadId: null,
    routeThreadId: coordinatorThreadId,
  }), true);
});

test("launch route selects the unique registered Execution Coordinator instead of Owner Root", () => {
  const route = selectLaunchCoordinatorRoute([{
    projectId: "capstone-dev",
    coordination: {
      coordinatorTaskId: "execution-root",
      ownerRootTaskId: "owner-root",
    },
    taskLanes: [
      {
        id: "owner-root",
        taskType: "root_task",
        threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
        codexHostId: "host-owner",
        workspacePath: "/tmp/capstone",
      },
      {
        id: "execution-root",
        taskType: "root_task",
        threadId: coordinatorThreadId,
        codexHostId: "host-coordinator",
        workspacePath: "/tmp/capstone",
      },
    ],
  }]);

  assert.deepEqual(route, {
    projectId: "capstone-dev",
    taskId: "execution-root",
    threadId: coordinatorThreadId,
    codexHostId: "host-coordinator",
    workspacePath: "/tmp/capstone",
  });
});

test("launch route fails closed when registered coordinator routes are missing or ambiguous", () => {
  const ownerOnly = {
    projectId: "capstone-dev",
    coordination: { coordinatorTaskId: null, ownerRootTaskId: "owner-root" },
    taskLanes: [{
      id: "owner-root",
      taskType: "root_task",
      threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
      codexHostId: "host-owner",
      workspacePath: "/tmp/capstone",
    }],
  };
  assert.equal(selectLaunchCoordinatorRoute([ownerOnly]), null);

  const coordinator = {
    id: "execution-root",
    taskType: "root_task",
    threadId: coordinatorThreadId,
    codexHostId: "host-coordinator",
    workspacePath: "/tmp/capstone",
  };
  const first = {
    ...ownerOnly,
    coordination: { coordinatorTaskId: coordinator.id, ownerRootTaskId: "owner-root" },
    taskLanes: [...ownerOnly.taskLanes, coordinator],
  };
  const second = {
    ...first,
    projectId: "taskboard-core",
    coordination: { coordinatorTaskId: "another-root", ownerRootTaskId: "owner-root" },
    taskLanes: [...ownerOnly.taskLanes, {
      ...coordinator,
      id: "another-root",
      threadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
    }],
  };
  assert.equal(selectLaunchCoordinatorRoute([first, second]), null);
});

test("background monitor ticks never overlap a still-running cycle", async () => {
  let releaseFirst;
  let active = 0;
  let peakActive = 0;
  let runs = 0;
  const tick = createSerializedMonitorTick(async () => {
    runs += 1;
    active += 1;
    peakActive = Math.max(peakActive, active);
    if (runs === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    active -= 1;
  });

  const first = tick();
  assert.equal(await tick(), false);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await tick(), true);
  assert.equal(runs, 2);
  assert.equal(peakActive, 1);
});

test("Owner Intent plan HTTP failures distinguish replan validation from stale state", () => {
  assert.equal(classifyOwnerIntentPlanHttpFailure(400, "PLAN_DEPENDENCY_CYCLE"), "invalid-plan");
  assert.equal(
    classifyOwnerIntentPlanHttpFailure(409, "OWNER_DECISION_CLASSIFICATION_REQUIRED"),
    "invalid-plan",
  );
  assert.equal(classifyOwnerIntentPlanHttpFailure(409, "OWNER_INTENT_REVISION_STALE"), "stale-plan");
  assert.equal(classifyOwnerIntentPlanHttpFailure(409, "COORDINATOR_ROUTE_STALE"), "stale-plan");
  assert.equal(classifyOwnerIntentPlanHttpFailure(503, "SERVICE_UNAVAILABLE"), null);
});

function coordinatorKeepaliveSnapshot({
  expiresAt,
  domainExpiresAt = expiresAt,
  globalCodexHostId = localHostExecutor.ownedCodexHostId,
  domainCodexHostId = localHostExecutor.ownedCodexHostId,
} = {}) {
  return {
    projectId: "taskboard-core",
    coordination: {
      coordinatorTaskId: "global",
      lease: {
        id: "global-lease",
        status: "active",
        acquiredAt: "2026-08-31T00:00:00.000Z",
        expiresAt,
      },
      domainCoordinators: [{
        domainId: "frontend",
        coordinatorTaskId: "frontend",
        lease: {
          id: "frontend-lease",
          status: "active",
          acquiredAt: "2026-08-31T00:00:00.000Z",
          expiresAt: domainExpiresAt,
        },
      }],
    },
    taskLanes: [
      {
        id: "global",
        threadId: coordinatorThreadId,
        codexHostId: globalCodexHostId,
        workspacePath: "/tmp/taskboard/global",
      },
      {
        id: "frontend",
        threadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
        codexHostId: domainCodexHostId,
        workspacePath: "/tmp/taskboard/frontend",
      },
    ],
  };
}

test("coordinator keepalive renews exact near-expiry Global and domain leases independently", async () => {
  const renewed = [];
  const now = Date.parse("2026-08-31T01:00:00.000Z");
  const result = await runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => now,
    readSnapshot: async () => coordinatorKeepaliveSnapshot({
      expiresAt: "2026-08-31T01:00:30.000Z",
      domainExpiresAt: "2026-08-31T01:00:35.000Z",
    }),
    readThread: async (route) => ({
      thread: { id: route.threadId, cwd: route.workspacePath, turns: [] },
    }),
    renewLease: async (request) => {
      renewed.push(request);
      if (request.scope === "global") throw new Error("global renewal unavailable");
      return { lease: { id: request.expectedLeaseId, status: "active" } };
    },
  });
  assert.deepEqual(renewed.map(({ scope, domainId }) => [scope, domainId ?? null]), [
    ["global", null],
    ["domain", "frontend"],
  ]);
  assert.equal(result.renewed, 1);
  assert.equal(result.failed, 1);
});

test("resident Coordinator lifecycle discovery keeps an idle background lease alive across ticks", async () => {
  assert.deepEqual(selectResidentCoordinatorMonitorProjects({
    lifecycleProjectIds: ["capstone-dev"],
    continuationPolicyEntries: {},
  }), [{ projectId: "capstone-dev", continuationEnabled: false }]);

  let observedAt = Date.parse("2026-09-02T16:40:00.000Z");
  const originalExpiry = "2026-09-02T16:40:30.000Z";
  const binding = {
    holderTaskId: "cap15-execution-coordinator-20260903",
    holderThreadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
    holderCodexHostId: "local",
    holderWorkspacePath: "/Users/v-sheng.huang/sbkk",
  };
  const lease = {
    id: "global-lease",
    status: "active",
    acquiredAt: "2026-09-02T16:35:00.000Z",
    expiresAt: originalExpiry,
  };
  let busy = true;
  const receipts = [];
  const runTick = () => runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "capstone-dev",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => observedAt,
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        coordinatorTaskId: binding.holderTaskId,
        lease,
        domainCoordinators: [],
      },
      taskLanes: [{
        id: binding.holderTaskId,
        threadId: binding.holderThreadId,
        codexHostId: binding.holderCodexHostId,
        workspacePath: binding.holderWorkspacePath,
      }],
    }),
    readThread: async () => ({
      thread: {
        id: binding.holderThreadId,
        cwd: binding.holderWorkspacePath,
        turns: busy ? [{ id: "active", status: "inProgress" }] : [],
      },
    }),
    renewLease: async (request) => {
      assert.equal(request.expectedLeaseId, lease.id);
      assert.equal(request.holderTaskId, binding.holderTaskId);
      assert.equal(request.holderThreadId, binding.holderThreadId);
      assert.equal(request.codexHostId, binding.holderCodexHostId);
      assert.equal(request.workspacePath, binding.holderWorkspacePath);
      lease.expiresAt = new Date(observedAt + 120_000).toISOString();
      receipts.push({ leaseId: lease.id, ...binding });
      return { lease: { ...lease } };
    },
  });

  assert.deepEqual(await runTick(), { renewed: 0, failed: 0, skipped: 1 });
  busy = false;
  observedAt += 15_000;
  assert.deepEqual(await runTick(), { renewed: 1, failed: 0, skipped: 0 });
  observedAt += 15_000;
  assert.deepEqual(await runTick(), { renewed: 0, failed: 0, skipped: 1 });
  assert.ok(Date.parse(lease.expiresAt) > Date.parse(originalExpiry));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], { leaseId: "global-lease", ...binding });
});

test("resident keepalive survives an unavailable continuation policy without enabling continuation", async () => {
  const projects = await loadResidentCoordinatorMonitorProjects({
    listLifecycleProjects: async () => ["capstone-dev"],
    readContinuationPolicyEntries: async () => {
      throw new Error("client storage unavailable");
    },
  });
  assert.deepEqual(projects, [{ projectId: "capstone-dev", continuationEnabled: false }]);
});

test("Coordinator keepalive skips foreign-first routes and renews only exact owned hosts", async () => {
  const now = Date.parse("2026-08-31T01:00:00.000Z");
  const snapshot = coordinatorKeepaliveSnapshot({
    expiresAt: "2026-08-31T01:00:30.000Z",
    domainExpiresAt: "2026-08-31T01:00:35.000Z",
    globalCodexHostId: remoteHostExecutor.ownedCodexHostId,
    domainCodexHostId: localHostExecutor.ownedCodexHostId,
  });
  const reads = [];
  const renewals = [];
  const run = (hostExecutor) => runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => now,
    readSnapshot: async () => snapshot,
    readThread: async (route) => {
      reads.push(route.codexHostId);
      return { thread: { id: route.threadId, cwd: route.workspacePath, turns: [] } };
    },
    renewLease: async (request) => {
      renewals.push(request);
      return { lease: { id: request.expectedLeaseId, status: "active" } };
    },
  });

  assert.deepEqual(await run(localHostExecutor), { renewed: 1, failed: 0, skipped: 1 });
  assert.deepEqual(reads, [localHostExecutor.ownedCodexHostId]);
  assert.deepEqual(renewals.map(({ scope, codexHostId }) => [scope, codexHostId]), [[
    "domain", localHostExecutor.ownedCodexHostId,
  ]]);

  reads.length = 0;
  renewals.length = 0;
  assert.deepEqual(await run(remoteHostExecutor), { renewed: 1, failed: 0, skipped: 1 });
  assert.deepEqual(reads, [remoteHostExecutor.ownedCodexHostId]);
  assert.deepEqual(renewals.map(({ scope, codexHostId }) => [scope, codexHostId]), [[
    "global", remoteHostExecutor.ownedCodexHostId,
  ]]);
});

async function runCoordinatorHostRouteBoundary({ routeHostId, hostExecutor }) {
  const workspacePath = "/tmp/taskboard/host-boundary";
  const observedAt = Date.parse("2026-08-31T01:00:00.000Z");
  const threadReads = [];
  const mutations = [];
  const taskLane = {
    id: "global",
    threadId: coordinatorThreadId,
    codexHostId: routeHostId,
    workspacePath,
  };
  const readThread = (monitor) => async (route) => {
    threadReads.push(monitor);
    assert.equal(route.codexHostId, routeHostId);
    return { thread: { id: route.threadId, cwd: route.workspacePath, turns: [] } };
  };
  const handshake = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "taskboard-core",
    hostExecutor,
    listHandshakes: async () => ({ handshakes: [{
      id: "handshake-host-boundary",
      role: "coordinator",
      threadId: coordinatorThreadId,
      registration: {
        projectId: "taskboard-core",
        role: "coordinator",
        taskId: "global",
        label: "Coordinator",
        threadId: coordinatorThreadId,
        expectedRevision: "d".repeat(64),
        idempotencyKey: "handshake-host-boundary",
      },
      expectedHostBinding: {
        codexProjectId: "host-boundary-project",
        codexProjectKind: "remote",
        codexHostId: routeHostId,
        workspacePath,
      },
    }] }),
    readThread: async (route) => {
      threadReads.push("handshake");
      assert.equal(route.codexHostId, routeHostId);
      return { thread: { id: route.threadId, cwd: workspacePath } };
    },
    confirmIdentity: async () => { mutations.push("handshake"); },
  });
  const keepalive = await runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => observedAt,
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: {
        coordinatorTaskId: "global",
        lease: {
          id: "global-lease",
          status: "active",
          acquiredAt: "2026-08-31T00:00:00.000Z",
          expiresAt: "2026-08-31T01:00:30.000Z",
        },
        domainCoordinators: [],
      },
      taskLanes: [taskLane],
    }),
    readThread: readThread("keepalive"),
    renewLease: async (request) => {
      mutations.push("keepalive");
      return { lease: { id: request.expectedLeaseId, status: "active" } };
    },
  });
  const recovery = await runCoordinatorLeaseRecoveryMonitorOnce({
    hostExecutor,
    policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: {
        lease: {
          id: "global-lease",
          holderTaskId: "global",
          status: "expired",
          bindingValid: true,
          releasedAt: null,
        },
        domainCoordinators: [],
      },
      taskLanes: [taskLane],
    }),
    readThread: readThread("recovery"),
    recoverLease: async () => {
      mutations.push("recovery");
      return { lease: { id: "global-recovered", status: "active" } };
    },
  });
  return { handshake, keepalive, recovery, threadReads, mutations };
}

test("Coordinator monitors accept exact canonical 240, 241, and 256 character host routes", async () => {
  for (const length of [240, 241, 256]) {
    const ownedCodexHostId = `host-${"x".repeat(length - 5)}`;
    assert.equal(ownedCodexHostId.length, length);
    assert.deepEqual(await runCoordinatorHostRouteBoundary({
      routeHostId: ownedCodexHostId,
      hostExecutor: { ownedCodexHostId },
    }), {
      handshake: { confirmed: 1, skipped: 0, failed: 0 },
      keepalive: { renewed: 1, failed: 0, skipped: 0 },
      recovery: { recovered: 1, failed: 0, skipped: 0 },
      threadReads: ["handshake", "keepalive", "recovery"],
      mutations: ["handshake", "keepalive", "recovery"],
    });
  }
});

test("Coordinator monitors reject noncanonical, missing, and mismatched route hosts before RPC", async () => {
  const cases = [{
    name: "257 characters",
    routeHostId: "x".repeat(257),
  }, {
    name: "control character",
    routeHostId: "local\u0000remote",
  }, {
    name: "missing",
    routeHostId: undefined,
  }, {
    name: "mismatch",
    routeHostId: "remote-builder",
  }];
  for (const candidate of cases) {
    const result = await runCoordinatorHostRouteBoundary({
      routeHostId: candidate.routeHostId,
      hostExecutor: localHostExecutor,
    });
    assert.deepEqual(result, {
      handshake: { confirmed: 0, skipped: 1, failed: 0 },
      keepalive: { renewed: 0, failed: 0, skipped: 1 },
      recovery: { recovered: 0, failed: 0, skipped: 1 },
      threadReads: [],
      mutations: [],
    }, candidate.name);
  }
});

test("Coordinator lease monitors reject missing or invalid host executors before callbacks", async () => {
  const invalidExecutors = [
    undefined,
    null,
    {},
    { ownedCodexHostId: "" },
    { ownedCodexHostId: "   " },
    { ownedCodexHostId: "local\nremote" },
    { ownedCodexHostId: "x".repeat(257) },
  ];
  for (const hostExecutor of invalidExecutors) {
    let callbacks = 0;
    const optionalHostExecutor = hostExecutor === undefined ? {} : { hostExecutor };
    const handshakeResult = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
      projectId: "taskboard-core",
      ...optionalHostExecutor,
      listHandshakes: async () => { callbacks += 1; return { handshakes: [] }; },
      readThread: async () => { callbacks += 1; },
      confirmIdentity: async () => { callbacks += 1; },
    });
    const keepaliveResult = await runCoordinatorLeaseKeepaliveMonitorOnce({
      ...optionalHostExecutor,
      policy: {
        enabled: true,
        projectId: "taskboard-core",
        renewWindowMs: 45_000,
        leaseDurationSeconds: 120,
      },
      readSnapshot: async () => {
        callbacks += 1;
        return {
          projectId: "taskboard-core",
          coordination: { lease: null, domainCoordinators: [] },
          taskLanes: [],
        };
      },
      readThread: async () => { callbacks += 1; },
      renewLease: async () => { callbacks += 1; },
    });
    const recoveryResult = await runCoordinatorLeaseRecoveryMonitorOnce({
      ...optionalHostExecutor,
      policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
      readSnapshot: async () => {
        callbacks += 1;
        return {
          projectId: "taskboard-core",
          coordination: { lease: null, domainCoordinators: [] },
          taskLanes: [],
        };
      },
      readThread: async () => { callbacks += 1; },
      recoverLease: async () => { callbacks += 1; },
    });
    assert.deepEqual(handshakeResult, {
      confirmed: 0, skipped: 0, failed: 0, reason: "host-executor-unavailable",
    });
    assert.deepEqual(keepaliveResult, {
      renewed: 0, failed: 0, skipped: 0, reason: "host-executor-unavailable",
    });
    assert.deepEqual(recoveryResult, {
      recovered: 0, failed: 0, skipped: 0, reason: "host-executor-unavailable",
    });
    assert.equal(callbacks, 0);
  }
});

test("resident Coordinator shutdown waits through idle grace and recovers one exact archive", async () => {
  let observedAt = Date.parse("2026-09-03T00:00:00.000Z");
  const holder = {
    taskId: "execution-coordinator",
    threadId: coordinatorThreadId,
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const owner = {
    taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  let lease = {
    id: "global-lease", holderTaskId: holder.taskId, status: "active",
    acquiredAt: "2026-09-02T23:55:00.000Z",
    expiresAt: "2026-09-03T00:05:00.000Z", releasedAt: null,
    bindingValid: true,
  };
  let attempt = null;
  let archived = false;
  let archiveCalls = 0;
  let releaseCalls = 0;
  let completionCalls = 0;
  const snapshot = () => ({
    projectId: "capstone-dev",
    coordination: {
      assignment: lease.releasedAt ? "unassigned" : "lease",
      coordinatorTaskId: lease.releasedAt ? null : holder.taskId,
      ownerRootTaskId: owner.taskId,
      ownerRootRoute: {
        rootTaskId: owner.taskId, rootThreadId: owner.threadId,
        codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
      },
      lease,
      durableWorkPending: false,
      shutdownAttempt: attempt,
      pendingOwnerIntent: null,
      pendingOwnerIntentPlan: null,
      ownerDecisionRequest: null,
      pendingCrossDomainHandoff: null,
      domainCoordinators: [],
    },
    todos: [],
    taskLanes: [{ id: holder.taskId, ...holder }, { id: owner.taskId, ...owner }],
  });
  const runTick = () => runCoordinatorShutdownMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", idleGraceMs: 30_000 },
    now: () => observedAt,
    readSnapshot: async () => snapshot(),
    readWindows: async () => ({
      projectId: "capstone-dev", revision: "d".repeat(64), ownerRootTaskId: owner.taskId,
      windows: [
        { ...holder, role: "coordinator" },
        { ...owner, role: "owner_root" },
      ],
    }),
    readThread: async () => ({
      thread: { id: holder.threadId, cwd: holder.workspacePath, turns: [] },
    }),
    getAttempt: async () => ({ attempt }),
    requestAttempt: async (request) => {
      assert.equal(request.expectedLeaseId, lease.id);
      assert.equal(request.ownerRootCodexProjectId, owner.codexProjectId);
      assert.equal(request.ownerRootCodexProjectKind, owner.codexProjectKind);
      assert.equal(request.ownerRootCodexHostId, owner.codexHostId);
      assert.equal(request.ownerRootWorkspacePath, path.resolve(owner.workspacePath));
      attempt = { ...request, id: "shutdown-1", status: "pending" };
      return { applied: true, attempt };
    },
    releaseAttempt: async ({ attemptId }) => {
      assert.equal(attemptId, "shutdown-1");
      releaseCalls += 1;
      lease = { ...lease, status: "expired", releasedAt: new Date(observedAt).toISOString() };
      attempt = { ...attempt, status: "released" };
      return { attempt };
    },
    findArchivedThread: async () => archived ? { id: holder.threadId, cwd: holder.workspacePath } : null,
    archiveThread: async ({ threadId, codexHostId }) => {
      assert.equal(threadId, holder.threadId);
      assert.equal(codexHostId, holder.codexHostId);
      archiveCalls += 1;
      archived = true;
      throw new Error("archive response lost");
    },
    completeAttempt: async ({ attemptId }) => {
      assert.equal(attemptId, "shutdown-1");
      completionCalls += 1;
      attempt = { ...attempt, status: "completed" };
      return { attempt };
    },
  });

  assert.equal((await runTick()).reason, "idle-grace");
  observedAt += 29_000;
  assert.equal((await runTick()).reason, "idle-grace");
  observedAt += 1_000;
  assert.deepEqual(await runTick(), {
    shutdown: false, reason: "archive-uncertain", attemptId: "shutdown-1",
  });
  assert.equal(releaseCalls, 1);
  assert.equal(archiveCalls, 1);
  assert.equal(completionCalls, 0);
  observedAt += 15_000;
  assert.deepEqual(await runTick(), {
    shutdown: true, reason: "completed", attemptId: "shutdown-1",
  });
  assert.equal(releaseCalls, 1);
  assert.equal(archiveCalls, 1);
  assert.equal(completionCalls, 1);
});

test("foreign persisted Coordinator shutdown attempts have zero host or mutation effects", async () => {
  for (const [kind, runMonitor] of [
    ["global", runCoordinatorShutdownMonitorOnce],
    ["domain", runDomainCoordinatorShutdownMonitorOnce],
  ]) {
    for (const status of ["pending", "released"]) {
      const projectId = `cap58-${kind}-${status}`;
      const effects = [];
      const attempt = {
        id: `${kind}-${status}-attempt`, projectId, status,
        holderTaskId: `${kind}-holder`, holderThreadId: coordinatorThreadId,
        codexHostId: "remote-builder", workspacePath: `/tmp/${projectId}`,
        ...(kind === "domain" ? { domainId: "frontend" } : {}),
      };
      const common = {
        hostExecutor: localHostExecutor,
        policy: { enabled: true, projectId, idleGraceMs: 1 },
        now: () => 1,
        readSnapshot: async () => ({
          projectId,
          coordination: {
            coordinatorTaskId: "global",
            lease: { id: "global-lease", status: "active", bindingValid: true },
            domainCoordinators: kind === "domain" ? [{
              domainId: "frontend", assignment: "unassigned", durableWorkPending: false,
              coordinatorTaskId: null, lease: { id: "frontend-lease", status: "expired" },
            }] : [],
          },
          taskLanes: [],
        }),
        readWindows: async () => ({ projectId, revision: "a".repeat(64), windows: [] }),
        readThread: async () => { effects.push("read-thread"); },
        getAttempt: async () => ({ attempt }),
        requestAttempt: async () => { effects.push("request"); },
        releaseAttempt: async () => {
          effects.push("release");
          return { attempt: { ...attempt, status: "released" } };
        },
        authorizeAttempt: async () => { effects.push("authorize"); },
        beginArchiveAttempt: async () => { effects.push("begin-archive"); },
        cancelAttempt: async () => { effects.push("cancel"); },
        findArchivedThread: async () => { effects.push("find-archived"); },
        archiveThread: async () => { effects.push("archive"); },
        completeAttempt: async () => { effects.push("complete"); },
      };
      await runMonitor(common);
      assert.deepEqual(effects, [], `${kind} ${status}`);
    }
  }
});

test("Coordinator shutdown rejects same-host cross-attempt transition responses", async () => {
  for (const [kind, runMonitor] of [
    ["global", runCoordinatorShutdownMonitorOnce],
    ["domain", runDomainCoordinatorShutdownMonitorOnce],
  ]) {
    for (const phase of ["release", "complete"]) {
      const projectId = `cap58-cross-attempt-${kind}-${phase}`;
      const domainId = "frontend";
      const attempt = {
        id: `${kind}-${phase}-attempt-a`, projectId,
        ...(kind === "domain" ? { domainId } : {}),
        status: phase === "release" ? "pending" : "archiving",
        holderTaskId: `${kind}-holder`, holderThreadId: coordinatorThreadId,
        codexHostId: "local", workspacePath: `/tmp/${projectId}`,
      };
      const effects = [];
      const result = await runMonitor({
        hostExecutor: localHostExecutor,
        policy: { enabled: true, projectId, idleGraceMs: 1 },
        now: () => 0,
        readSnapshot: async () => ({
          projectId,
          coordination: {
            domainCoordinators: kind === "domain" ? [{ domainId }] : [],
          },
          taskLanes: [],
        }),
        readWindows: async () => ({
          projectId, revision: "d".repeat(64), windows: [],
        }),
        readThread: async () => { effects.push("read-thread"); },
        getAttempt: async () => ({ attempt }),
        requestAttempt: async () => { effects.push("request"); },
        releaseAttempt: async () => {
          effects.push("release");
          return { attempt: { ...attempt, id: `${kind}-${phase}-attempt-b`, status: "released" } };
        },
        authorizeAttempt: async () => { effects.push("authorize"); },
        beginArchiveAttempt: async () => { effects.push("begin-archive"); },
        cancelAttempt: async () => { effects.push("cancel"); },
        findArchivedThread: async () => {
          effects.push("find-archived");
          return { id: attempt.holderThreadId, cwd: attempt.workspacePath };
        },
        archiveThread: async () => { effects.push("archive"); },
        completeAttempt: async () => {
          effects.push("complete");
          return { attempt: { ...attempt, id: `${kind}-${phase}-attempt-b`, status: "completed" } };
        },
      });
      assert.equal(result.shutdown, false, `${kind} ${phase}`);
      assert.equal(result.reason, "attempt-response-mismatch", `${kind} ${phase}`);
      assert.equal(result.attemptId, attempt.id, `${kind} ${phase}`);
      assert.deepEqual(
        effects,
        phase === "release" ? ["release"] : ["find-archived", "complete"],
        `${kind} ${phase}`,
      );
    }
  }
});

test("Coordinator shutdown rejects same-host request responses with another binding", async () => {
  const globalProjectId = "cap58-global-request-envelope";
  let globalObservedAt = 10;
  let globalReleases = 0;
  const globalOptions = freshGlobalShutdownOptions({
    projectId: globalProjectId,
    hostId: "local",
    now: () => globalObservedAt,
    requestAttempt: async (request) => ({ attempt: {
      ...request, id: "global-request-attempt", status: "pending",
      expectedLeaseId: "another-global-lease",
    } }),
  });
  globalOptions.releaseAttempt = async () => { globalReleases += 1; };
  assert.equal((await runCoordinatorShutdownMonitorOnce(globalOptions)).reason, "idle-grace");
  globalObservedAt += 1;
  assert.equal(
    (await runCoordinatorShutdownMonitorOnce(globalOptions)).reason,
    "attempt-response-mismatch",
  );

  const domainProjectId = "cap58-domain-request-envelope";
  const domainId = "frontend";
  let domainObservedAt = 20;
  const globalLane = { id: "global", threadId: coordinatorThreadId };
  const holder = {
    id: domainId, taskId: domainId,
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    source: "codex", taskType: "peer_task", codexProjectId: "project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/frontend",
  };
  const effects = [];
  const domainOptions = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: domainProjectId, idleGraceMs: 1 },
    now: () => domainObservedAt,
    readSnapshot: async () => ({
      projectId: domainProjectId,
      coordination: {
        coordinatorTaskId: globalLane.id,
        lease: { id: "global-lease", status: "active", bindingValid: true },
        domainCoordinators: [{
          domainId, assignment: "lease", durableWorkPending: false,
          coordinatorTaskId: holder.id,
          lease: {
            id: "frontend-lease", holderTaskId: holder.id,
            status: "active", bindingValid: true, releasedAt: null,
          },
        }],
      },
      taskLanes: [globalLane, holder],
    }),
    readWindows: async () => ({
      projectId: domainProjectId, revision: "e".repeat(64),
      windows: [{ ...holder, taskId: holder.id }],
    }),
    readThread: async () => ({
      thread: { id: holder.threadId, cwd: holder.workspacePath, turns: [] },
    }),
    getAttempt: async () => ({ attempt: null }),
    requestAttempt: async (request) => ({ attempt: {
      ...request, id: "domain-request-attempt", status: "pending",
      globalHolderThreadId: "another-global-thread",
    } }),
    releaseAttempt: async () => { effects.push("release"); },
    authorizeAttempt: async () => { effects.push("authorize"); },
    beginArchiveAttempt: async () => { effects.push("begin-archive"); },
    cancelAttempt: async () => { effects.push("cancel"); },
    findArchivedThread: async () => { effects.push("find-archived"); },
    archiveThread: async () => { effects.push("archive"); },
    completeAttempt: async () => { effects.push("complete"); },
  };
  assert.deepEqual(await runDomainCoordinatorShutdownMonitorOnce(domainOptions), {
    shutdown: false, reason: "idle-grace", domainId,
  });
  domainObservedAt += 1;
  const domainResult = await runDomainCoordinatorShutdownMonitorOnce(domainOptions);
  assert.equal(domainResult.shutdown, false);
  assert.equal(domainResult.reason, "attempt-response-mismatch");
  assert.equal(domainResult.domainId, domainId);
  assert.deepEqual({ globalReleases, domainEffects: effects }, {
    globalReleases: 0, domainEffects: [],
  });
});

test("Coordinator shutdown transition responses retain every immutable binding field", async () => {
  const fields = [
    ["expectedRevision", "global"], ["expectedLeaseId", "global"],
    ["idempotencyKey", "global"], ["projectId", "global"], ["id", "global"],
    ["holderTaskId", "global"], ["holderThreadId", "global"],
    ["codexProjectId", "global"], ["codexProjectKind", "global"],
    ["codexHostId", "global"], ["workspacePath", "global"],
    ["ownerRootTaskId", "global"], ["ownerRootThreadId", "global"],
    ["ownerRootCodexProjectId", "global"], ["ownerRootCodexProjectKind", "global"],
    ["ownerRootCodexHostId", "global"], ["ownerRootWorkspacePath", "global"],
    ["domainId", "domain"], ["globalHolderTaskId", "domain"],
    ["globalHolderThreadId", "domain"], ["expectedGlobalLeaseId", "domain"],
  ];
  for (const [index, [field, kind]] of fields.entries()) {
    const projectId = `cap58-transition-envelope-${index}`;
    const domainId = "frontend";
    const attempt = {
      id: `attempt-${index}`, idempotencyKey: `shutdown-${index}`,
      projectId, ...(kind === "domain" ? {
        domainId, globalHolderTaskId: "global", globalHolderThreadId: "global-thread",
        expectedGlobalLeaseId: "global-lease",
      } : {
        ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
        ownerRootCodexProjectId: "owner-project", ownerRootCodexProjectKind: "remote",
        ownerRootCodexHostId: "owner-host", ownerRootWorkspacePath: "/tmp/owner",
      }),
      expectedRevision: "f".repeat(64), expectedLeaseId: `${kind}-lease`,
      holderTaskId: `${kind}-holder`, holderThreadId: coordinatorThreadId,
      codexProjectId: `${kind}-project`, codexProjectKind: "local",
      codexHostId: "local", workspacePath: `/tmp/${projectId}`, status: "pending",
    };
    const alteredValue = field.endsWith("WorkspacePath") || field === "workspacePath"
      ? `/tmp/${projectId}-drift`
      : field === "expectedRevision" ? "0".repeat(64)
        : field === "codexHostId" ? "remote-builder"
          : field === "projectId" ? `${projectId}-drift`
            : field === "domainId" ? "backend"
              : `${attempt[field]}-drift`;
    const effects = [];
    const runMonitor = kind === "global"
      ? runCoordinatorShutdownMonitorOnce
      : runDomainCoordinatorShutdownMonitorOnce;
    const result = await runMonitor({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId, idleGraceMs: 1 },
      now: () => 0,
      readSnapshot: async () => ({
        projectId,
        coordination: {
          domainCoordinators: kind === "domain" ? [{ domainId }] : [],
        },
        taskLanes: [],
      }),
      readWindows: async () => ({ projectId, revision: "1".repeat(64), windows: [] }),
      readThread: async () => { effects.push("read-thread"); },
      getAttempt: async () => ({ attempt }),
      requestAttempt: async () => { effects.push("request"); },
      releaseAttempt: async () => {
        effects.push("release");
        return { attempt: { ...attempt, [field]: alteredValue, status: "released" } };
      },
      authorizeAttempt: async () => { effects.push("authorize"); },
      beginArchiveAttempt: async () => { effects.push("begin-archive"); },
      cancelAttempt: async () => { effects.push("cancel"); },
      findArchivedThread: async () => { effects.push("find-archived"); },
      archiveThread: async () => { effects.push("archive"); },
      completeAttempt: async () => { effects.push("complete"); },
    });
    assert.equal(result.shutdown, false, field);
    assert.equal(result.reason, "attempt-response-mismatch", field);
    assert.equal(result.attemptId, attempt.id, field);
    assert.deepEqual(effects, ["release"], field);
  }
});

test("Coordinator shutdown monitors reject invalid host executors before any callback", async () => {
  for (const [kind, runMonitor] of [
    ["global", runCoordinatorShutdownMonitorOnce],
    ["domain", runDomainCoordinatorShutdownMonitorOnce],
  ]) {
    for (const [label, hostExecutor] of [
      ["missing", undefined],
      ["null", null],
      ["empty", { ownedCodexHostId: "" }],
      ["whitespace", { ownedCodexHostId: " remote-builder " }],
      ["control", { ownedCodexHostId: "remote\nhost" }],
      ["257 characters", { ownedCodexHostId: "h".repeat(257) }],
    ]) {
      let callbacks = 0;
      const called = async () => { callbacks += 1; return {}; };
      const result = await runMonitor({
        hostExecutor,
        policy: { enabled: true, projectId: `cap58-invalid-${kind}-${label}`, idleGraceMs: 1 },
        now: () => { callbacks += 1; return 0; },
        readSnapshot: called,
        readWindows: called,
        readThread: called,
        getAttempt: called,
        requestAttempt: called,
        releaseAttempt: called,
        authorizeAttempt: called,
        beginArchiveAttempt: called,
        cancelAttempt: called,
        findArchivedThread: called,
        archiveThread: called,
        completeAttempt: called,
      });
      assert.deepEqual(result, {
        shutdown: false, reason: "host-executor-unavailable",
      }, `${kind} ${label}`);
      assert.equal(callbacks, 0, `${kind} ${label}`);
    }
  }
});

test("Coordinator shutdown monitors accept canonical 240, 241, and 256 character hosts", async () => {
  for (const length of [240, 241, 256]) {
    for (const [kind, runMonitor] of [
      ["global", runCoordinatorShutdownMonitorOnce],
      ["domain", runDomainCoordinatorShutdownMonitorOnce],
    ]) {
      const hostId = "h".repeat(length);
      const projectId = `cap58-host-${length}-${kind}`;
      const domainId = "frontend";
      const attempt = {
        id: `${kind}-${length}`, projectId, status: "pending",
        holderTaskId: `${kind}-holder`, holderThreadId: coordinatorThreadId,
        codexHostId: hostId, workspacePath: `/tmp/${projectId}`,
        ...(kind === "domain" ? { domainId } : {}),
      };
      let releases = 0;
      const result = await runMonitor({
        hostExecutor: { ownedCodexHostId: hostId },
        policy: { enabled: true, projectId, idleGraceMs: 1 },
        now: () => 0,
        readSnapshot: async () => ({
          projectId,
          coordination: {
            lease: { id: "global-lease", status: "active", bindingValid: true },
            domainCoordinators: kind === "domain" ? [{
              domainId, assignment: "unassigned", durableWorkPending: false,
              coordinatorTaskId: null, lease: { id: "domain-lease", status: "expired" },
            }] : [],
          },
          taskLanes: [],
        }),
        readWindows: async () => ({ projectId, revision: "a".repeat(64), windows: [] }),
        readThread: async () => assert.fail("persisted pending attempt must release first"),
        getAttempt: async () => ({ attempt }),
        requestAttempt: async () => assert.fail("persisted attempt must be reused"),
        releaseAttempt: async ({ attemptId, ownedCodexHostId }) => {
          assert.equal(attemptId, attempt.id);
          assert.equal(ownedCodexHostId, hostId);
          releases += 1;
          throw new Error("stop after proving canonical ownership");
        },
        authorizeAttempt: async () => assert.fail("release failure must stop"),
        beginArchiveAttempt: async () => assert.fail("release failure must stop"),
        cancelAttempt: async () => assert.fail("release failure must stop"),
        findArchivedThread: async () => assert.fail("release failure must stop"),
        archiveThread: async () => assert.fail("release failure must stop"),
        completeAttempt: async () => assert.fail("release failure must stop"),
      });
      assert.equal(result.reason, "release-unavailable", `${kind} ${length}`);
      assert.equal(releases, 1, `${kind} ${length}`);
    }
  }
});

test("domain shutdown skips a foreign persisted attempt and continues to an owned domain", async () => {
  const projectId = "cap58-domain-existing-foreign-first";
  const attempts = {
    frontend: {
      id: "foreign-attempt", projectId, domainId: "frontend", status: "pending",
      holderTaskId: "frontend", holderThreadId: coordinatorThreadId,
      codexHostId: "remote-builder", workspacePath: "/tmp/frontend",
    },
    backend: {
      id: "owned-attempt", projectId, domainId: "backend", status: "pending",
      holderTaskId: "backend", holderThreadId: coordinatorThreadId,
      codexHostId: "local", workspacePath: "/tmp/backend",
    },
  };
  const released = [];
  const result = await runDomainCoordinatorShutdownMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId, idleGraceMs: 1 },
    now: () => 0,
    readSnapshot: async () => ({
      projectId,
      coordination: {
        lease: { id: "global-lease", status: "active", bindingValid: true },
        domainCoordinators: ["frontend", "backend"].map((domainId) => ({
          domainId, assignment: "unassigned", durableWorkPending: false,
          coordinatorTaskId: null, lease: { id: `${domainId}-lease`, status: "expired" },
        })),
      },
      taskLanes: [],
    }),
    readWindows: async () => ({ projectId, revision: "a".repeat(64), windows: [] }),
    readThread: async () => assert.fail("release failure must stop"),
    getAttempt: async ({ domainId }) => ({ attempt: attempts[domainId] }),
    requestAttempt: async () => assert.fail("persisted attempt must be reused"),
    releaseAttempt: async ({ attemptId, ownedCodexHostId }) => {
      released.push(`${attemptId}:${ownedCodexHostId}`);
      throw new Error("stop after owned release");
    },
    authorizeAttempt: async () => assert.fail("release failure must stop"),
    beginArchiveAttempt: async () => assert.fail("release failure must stop"),
    cancelAttempt: async () => assert.fail("release failure must stop"),
    findArchivedThread: async () => assert.fail("release failure must stop"),
    archiveThread: async () => assert.fail("release failure must stop"),
    completeAttempt: async () => assert.fail("release failure must stop"),
  });
  assert.equal(result.domainId, "backend");
  assert.deepEqual(released, ["owned-attempt:local"]);
});

test("mixed-host domain shutdown selects owned-later and rechecks the request response", async () => {
  const projectId = "cap58-domain-fresh-foreign-first";
  let observedAt = 100;
  const globalLane = { id: "global", threadId: coordinatorThreadId };
  const remoteLane = {
    id: "frontend", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    source: "codex", taskType: "peer_task", codexProjectId: "remote-project",
    codexProjectKind: "remote", codexHostId: "remote-builder", workspacePath: "/tmp/frontend",
  };
  const localLane = {
    id: "backend", threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
    source: "codex", taskType: "peer_task", codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/backend",
  };
  const snapshot = {
    projectId,
    coordination: {
      coordinatorTaskId: globalLane.id,
      lease: { id: "global-lease", status: "active", bindingValid: true },
      domainCoordinators: [remoteLane, localLane].map((lane) => ({
        domainId: lane.id, assignment: "lease", durableWorkPending: false,
        coordinatorTaskId: lane.id,
        lease: {
          id: `${lane.id}-lease`, holderTaskId: lane.id,
          status: "active", bindingValid: true, releasedAt: null,
        },
      })),
    },
    taskLanes: [globalLane, remoteLane, localLane],
  };
  const windows = {
    projectId, revision: "b".repeat(64),
    windows: [remoteLane, localLane].map((lane) => ({ ...lane, taskId: lane.id })),
  };
  const readHosts = [];
  const requests = [];
  let releases = 0;
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId, idleGraceMs: 1 },
    now: () => observedAt,
    readSnapshot: async () => snapshot,
    readWindows: async () => windows,
    readThread: async ({ threadId, codexHostId }) => {
      readHosts.push(codexHostId);
      const lane = snapshot.taskLanes.find((candidate) => candidate.threadId === threadId);
      return { thread: { id: threadId, cwd: lane.workspacePath, turns: [] } };
    },
    getAttempt: async () => ({ attempt: null }),
    requestAttempt: async (request) => {
      requests.push(request);
      return { attempt: {
        ...request, id: "foreign-response", status: "pending", codexHostId: "remote-builder",
      } };
    },
    releaseAttempt: async () => { releases += 1; },
    authorizeAttempt: async () => assert.fail("foreign response must stop"),
    beginArchiveAttempt: async () => assert.fail("foreign response must stop"),
    cancelAttempt: async () => assert.fail("foreign response must stop"),
    findArchivedThread: async () => assert.fail("foreign response must stop"),
    archiveThread: async () => assert.fail("foreign response must stop"),
    completeAttempt: async () => assert.fail("foreign response must stop"),
  };
  assert.deepEqual(await runDomainCoordinatorShutdownMonitorOnce(options), {
    shutdown: false, reason: "idle-grace", domainId: "backend",
  });
  observedAt += 1;
  const result = await runDomainCoordinatorShutdownMonitorOnce(options);
  assert.equal(result.domainId, "backend");
  assert.equal(result.reason, "attempt-response-mismatch");
  assert.deepEqual(readHosts, ["local", "local"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].domainId, "backend");
  assert.equal(requests[0].ownedCodexHostId, "local");
  assert.equal(releases, 0);

  const remoteReadHosts = [];
  assert.deepEqual(await runDomainCoordinatorShutdownMonitorOnce({
    ...options,
    hostExecutor: remoteHostExecutor,
    readThread: async ({ threadId, codexHostId }) => {
      remoteReadHosts.push(codexHostId);
      const lane = snapshot.taskLanes.find((candidate) => candidate.threadId === threadId);
      return { thread: { id: threadId, cwd: lane.workspacePath, turns: [] } };
    },
    requestAttempt: async () => assert.fail("first remote observation must wait"),
  }), {
    shutdown: false, reason: "idle-grace", domainId: "frontend",
  });
  assert.deepEqual(remoteReadHosts, ["remote-builder"]);
});

function freshGlobalShutdownOptions({ projectId, hostId, now, requestAttempt, getAttempt }) {
  const holder = {
    id: "coordinator", taskId: "coordinator", threadId: coordinatorThreadId,
    codexProjectId: `${projectId}-holder`, codexProjectKind: hostId === "local" ? "local" : "remote",
    codexHostId: hostId, workspacePath: `/tmp/${projectId}-${hostId}-holder`,
  };
  const owner = {
    id: "owner", taskId: "owner", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: `${projectId}-owner`, codexProjectKind: "remote",
    codexHostId: "owner-host", workspacePath: `/tmp/${projectId}-owner`,
  };
  const lease = {
    id: "global-lease", holderTaskId: holder.id, status: "active",
    bindingValid: true, releasedAt: null,
  };
  return {
    hostExecutor: { ownedCodexHostId: hostId },
    policy: { enabled: true, projectId, idleGraceMs: 1 },
    now,
    readSnapshot: async () => ({
      projectId,
      coordination: {
        assignment: "lease", coordinatorTaskId: holder.id, ownerRootTaskId: owner.id,
        ownerRootRoute: {
          rootTaskId: owner.id, rootThreadId: owner.threadId,
          codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
        },
        lease, durableWorkPending: false, domainCoordinators: [],
      },
      taskLanes: [holder, owner],
    }),
    readWindows: async () => ({
      projectId, revision: "c".repeat(64), ownerRootTaskId: owner.id,
      windows: [{ ...holder, role: "coordinator" }, { ...owner, role: "owner_root" }],
    }),
    readThread: async ({ threadId, codexHostId }) => {
      assert.equal(threadId, holder.threadId);
      assert.equal(codexHostId, hostId);
      return { thread: { id: holder.threadId, cwd: holder.workspacePath, turns: [] } };
    },
    getAttempt: getAttempt ?? (async () => ({ attempt: null })),
    requestAttempt,
    releaseAttempt: async () => assert.fail("test request must stop before release"),
    findArchivedThread: async () => assert.fail("test request must stop before archive lookup"),
    archiveThread: async () => assert.fail("test request must stop before archive"),
    completeAttempt: async () => assert.fail("test request must stop before completion"),
  };
}

test("Global shutdown uses the holder host, not the Owner Root host, and rechecks request ownership", async () => {
  const projectId = "cap58-global-owner-host-differs";
  let observedAt = 1_000;
  let request = null;
  let releases = 0;
  const options = freshGlobalShutdownOptions({
    projectId,
    hostId: "local",
    now: () => observedAt,
    requestAttempt: async (input) => {
      request = input;
      return { attempt: {
        ...input, id: "foreign-global-response", status: "pending",
        codexHostId: "remote-builder",
      } };
    },
  });
  options.releaseAttempt = async () => { releases += 1; };
  assert.equal((await runCoordinatorShutdownMonitorOnce(options)).reason, "idle-grace");
  observedAt += 1;
  assert.deepEqual(await runCoordinatorShutdownMonitorOnce(options), {
    shutdown: false, reason: "attempt-response-mismatch",
  });
  assert.equal(request.ownedCodexHostId, "local");
  assert.equal(request.ownerRootCodexHostId, "owner-host");
  assert.equal(releases, 0);
});

test("Global shutdown single-flight is scoped by exact host and project", async () => {
  const projectId = "cap58-global-flight-host-isolation";
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const started = [];
  const makeOptions = (hostId) => freshGlobalShutdownOptions({
    projectId,
    hostId,
    now: () => 0,
    requestAttempt: async () => assert.fail("persisted attempt must win"),
    getAttempt: async () => {
      started.push(hostId);
      await gate;
      return { attempt: {
        id: `${hostId}-attempt`, projectId, status: "pending",
        holderTaskId: "coordinator", holderThreadId: coordinatorThreadId,
        codexHostId: hostId, workspacePath: `/tmp/${projectId}-${hostId}-holder`,
      } };
    },
  });
  const localOptions = makeOptions("local");
  const remoteOptions = makeOptions("remote-builder");
  const local = runCoordinatorShutdownMonitorOnce(localOptions);
  await Promise.resolve();
  const localDuplicate = runCoordinatorShutdownMonitorOnce(localOptions);
  const remote = runCoordinatorShutdownMonitorOnce(remoteOptions);
  await Promise.resolve();
  releaseGate();
  await Promise.all([local, localDuplicate, remote]);
  assert.deepEqual(started.sort(), ["local", "remote-builder"]);
});

test("Global shutdown idle grace is isolated by host and project", async () => {
  const projectId = "cap58-global-idle-host-isolation";
  let observedAt = 10;
  const requests = [];
  const makeOptions = (hostId) => {
    const options = freshGlobalShutdownOptions({
      projectId,
      hostId,
      now: () => observedAt,
      requestAttempt: async (request) => {
        requests.push(request.ownedCodexHostId);
        return { attempt: { ...request, id: `${hostId}-foreign`, status: "pending", codexHostId: "foreign" } };
      },
    });
    options.releaseAttempt = async () => assert.fail("foreign response must not release");
    return options;
  };
  const local = makeOptions("local");
  const remote = makeOptions("remote-builder");
  assert.equal((await runCoordinatorShutdownMonitorOnce(local)).reason, "idle-grace");
  assert.equal((await runCoordinatorShutdownMonitorOnce(remote)).reason, "idle-grace");
  observedAt += 1;
  assert.equal((await runCoordinatorShutdownMonitorOnce(local)).reason, "attempt-response-mismatch");
  assert.equal((await runCoordinatorShutdownMonitorOnce(remote)).reason, "attempt-response-mismatch");
  assert.deepEqual(requests.sort(), ["local", "remote-builder"]);
});

test("idle domain Coordinator retirement releases and archives only its exact domain thread", async () => {
  let observedAt = Date.parse("2026-09-05T06:00:00.000Z");
  const global = { id: "global", threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae" };
  const holder = {
    id: "frontend", taskId: "frontend",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    source: "codex", taskType: "peer_task", codexProjectId: "project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/frontend",
  };
  let attempt = null;
  let archived = false;
  let releaseCalls = 0;
  let workPending = false;
  const lease = {
    id: "frontend-lease", status: "active", bindingValid: true,
    holderTaskId: holder.id, acquiredAt: "2026-09-05T05:55:00.000Z",
    expiresAt: "2026-09-05T06:05:00.000Z", releasedAt: null,
  };
  const runTick = () => runDomainCoordinatorShutdownMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", idleGraceMs: 30_000 },
    now: () => observedAt,
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        coordinatorTaskId: global.id,
        lease: { id: "global-lease", status: "active", bindingValid: true },
        domainCoordinators: [{
          domainId: "frontend", assignment: "lease", durableWorkPending: workPending,
          coordinatorTaskId: holder.id, lease,
        }, {
          domainId: "backend", assignment: "lease", durableWorkPending: true,
          coordinatorTaskId: "backend", lease: {
            id: "backend-lease", status: "active", bindingValid: true,
          },
        }],
      },
      taskLanes: [{ ...global }, { ...holder }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev", revision: "a".repeat(64),
      windows: [{ ...holder }],
    }),
    readThread: async () => ({
      thread: { id: holder.threadId, cwd: holder.workspacePath, turns: [] },
    }),
    getAttempt: async () => ({ attempt }),
    requestAttempt: async (request) => {
      assert.equal(request.domainId, "frontend");
      assert.equal(request.expectedLeaseId, lease.id);
      assert.equal(request.globalHolderTaskId, global.id);
      assert.equal(Object.hasOwn(request, "fingerprint"), false);
      attempt = { ...request, id: "domain-shutdown", status: "pending" };
      return { applied: true, attempt };
    },
    releaseAttempt: async () => {
      releaseCalls += 1;
      attempt = { ...attempt, status: "released" };
      return { attempt };
    },
    authorizeAttempt: async () => {
      attempt = { ...attempt, status: "authorized" };
      return { attempt, authorized: true };
    },
    beginArchiveAttempt: async () => {
      attempt = { ...attempt, status: "archiving" };
      return { attempt, archiving: true };
    },
    cancelAttempt: async () => {
      attempt = { ...attempt, status: "canceled" };
      return { attempt };
    },
    findArchivedThread: async () => archived
      ? { id: holder.threadId, cwd: holder.workspacePath }
      : null,
    archiveThread: async ({ threadId }) => {
      assert.equal(threadId, holder.threadId);
      archived = true;
    },
    completeAttempt: async () => {
      attempt = { ...attempt, status: "completed" };
      return { attempt };
    },
  });
  assert.equal((await runTick()).reason, "idle-grace");
  workPending = true;
  observedAt += 45_000;
  assert.equal((await runTick()).reason, "no-idle-domain");
  workPending = false;
  assert.equal((await runTick()).reason, "idle-grace");
  observedAt += 30_000;
  assert.deepEqual(await runTick(), {
    shutdown: true, reason: "completed", attemptId: "domain-shutdown", domainId: "frontend",
  });
  assert.equal(releaseCalls, 1);
  assert.equal(archived, true);
});

test("released domain retirement never archives before protected reauthorization", async () => {
  let archiveCalls = 0;
  const result = await runDomainCoordinatorShutdownMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "authorization-project", idleGraceMs: 30_000 },
    now: Date.now,
    readSnapshot: async () => ({
      projectId: "authorization-project",
      coordination: {
        coordinatorTaskId: "global", lease: {
          id: "global-lease", status: "active", bindingValid: true,
        },
        domainCoordinators: [{
          domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
          coordinatorTaskId: null, lease: {
            id: "frontend-lease", status: "expired", bindingValid: true,
            releasedAt: "2026-09-05T06:00:00.000Z",
          },
        }],
      },
      taskLanes: [],
    }),
    readWindows: async () => ({
      projectId: "authorization-project", revision: "b".repeat(64), windows: [],
    }),
    readThread: async () => { throw new Error("must not read"); },
    getAttempt: async () => ({ attempt: {
      id: "released-attempt", projectId: "authorization-project", domainId: "frontend",
      status: "released", holderTaskId: "frontend", holderThreadId: coordinatorThreadId,
      codexHostId: "local", workspacePath: "/tmp/frontend",
    } }),
    requestAttempt: async () => { throw new Error("must not request"); },
    releaseAttempt: async () => { throw new Error("must not release"); },
    authorizeAttempt: async () => { throw new Error("Global lease drift"); },
    beginArchiveAttempt: async () => { throw new Error("must not begin archive"); },
    cancelAttempt: async () => { throw new Error("must not cancel without authorization"); },
    findArchivedThread: async () => { throw new Error("must not inspect archive"); },
    archiveThread: async () => { archiveCalls += 1; },
    completeAttempt: async () => { throw new Error("must not complete"); },
  });
  assert.deepEqual(result, {
    shutdown: false, reason: "archive-authorization-unavailable",
    attemptId: "released-attempt", domainId: "frontend",
  });
  assert.equal(archiveCalls, 0);
});

test("authorized domain retirement releases its fence and retries after transient host failure", async () => {
  let cancelCalls = 0;
  let archiveCalls = 0;
  let hostAvailable = false;
  let attempt = {
    id: "authorized-attempt", projectId: "cancel-project", domainId: "frontend",
    status: "authorized", holderTaskId: "frontend", holderThreadId: coordinatorThreadId,
    codexHostId: "local", workspacePath: "/tmp/frontend",
  };
  const runTick = () => runDomainCoordinatorShutdownMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "cancel-project", idleGraceMs: 30_000 },
    now: Date.now,
    readSnapshot: async () => ({
      projectId: "cancel-project",
      coordination: {
        coordinatorTaskId: "global",
        lease: { id: "global-lease", status: "active", bindingValid: true },
        domainCoordinators: [{
          domainId: "frontend", assignment: "unassigned", durableWorkPending: false,
          coordinatorTaskId: null, lease: {
            id: "frontend-lease", status: "expired", bindingValid: true,
            releasedAt: "2026-09-05T06:00:00.000Z",
          },
        }],
      },
      taskLanes: [],
    }),
    readWindows: async () => ({
      projectId: "cancel-project", revision: "c".repeat(64), windows: [],
    }),
    readThread: async () => {
      if (!hostAvailable) throw new Error("host unavailable");
      return { thread: { id: coordinatorThreadId, cwd: "/tmp/frontend", turns: [] } };
    },
    getAttempt: async () => ({ attempt }),
    requestAttempt: async () => { throw new Error("must not request"); },
    releaseAttempt: async () => { throw new Error("must not release"); },
    authorizeAttempt: async () => {
      attempt = { ...attempt, status: "authorized" };
      return { attempt, authorized: true };
    },
    beginArchiveAttempt: async () => {
      attempt = { ...attempt, status: "archiving" };
      return { attempt, archiving: true };
    },
    cancelAttempt: async () => {
      cancelCalls += 1;
      attempt = { ...attempt, status: "released" };
      return { attempt, abandoned: false };
    },
    findArchivedThread: async () => null,
    archiveThread: async () => { archiveCalls += 1; },
    completeAttempt: async () => {
      attempt = { ...attempt, status: "completed" };
      return { attempt };
    },
  });
  assert.deepEqual(await runTick(), {
    shutdown: false, reason: "thread-unavailable", attemptId: "authorized-attempt",
    domainId: "frontend",
  });
  assert.equal(cancelCalls, 1);
  assert.equal(archiveCalls, 0);
  assert.equal(attempt.status, "released");
  hostAvailable = true;
  assert.deepEqual(await runTick(), {
    shutdown: true, reason: "completed", attemptId: "authorized-attempt",
    domainId: "frontend",
  });
  assert.equal(archiveCalls, 1);
});

test("Coordinator shutdown and replacement provisioning fail closed around work and busy turns", async () => {
  const holder = {
    taskId: "execution-coordinator", threadId: coordinatorThreadId,
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  const owner = {
    id: "owner-root", taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  const baseSnapshot = {
    projectId: "capstone-dev",
    coordination: {
      assignment: "lease", coordinatorTaskId: holder.taskId,
      ownerRootTaskId: "owner-root", ownerRootRoute: {
        rootTaskId: owner.taskId, rootThreadId: owner.threadId,
        codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
      },
      lease: {
        id: "global-lease", holderTaskId: holder.taskId, status: "active",
        acquiredAt: "2026-09-02T23:55:00.000Z", expiresAt: "2026-09-03T00:05:00.000Z",
        bindingValid: true, releasedAt: null,
      },
      durableWorkPending: false, shutdownAttempt: null, domainCoordinators: [],
      pendingOwnerIntent: null, pendingOwnerIntentPlan: null,
      ownerDecisionRequest: null, pendingCrossDomainHandoff: null,
    },
    todos: [],
    taskLanes: [holder, owner],
  };
  let requests = 0;
  for (const snapshot of [
    { ...baseSnapshot, coordination: { ...baseSnapshot.coordination, durableWorkPending: true } },
    baseSnapshot,
  ]) {
    const result = await runCoordinatorShutdownMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "capstone-dev", idleGraceMs: 1 },
      now: () => Date.parse("2026-09-03T00:00:00.000Z"),
      readSnapshot: async () => snapshot,
      readWindows: async () => ({
        projectId: "capstone-dev", revision: "d".repeat(64), ownerRootTaskId: "owner-root",
        windows: [
          { ...holder, role: "coordinator" },
          { ...owner, role: "owner_root" },
        ],
      }),
      readThread: async () => ({ thread: {
        id: holder.threadId, cwd: holder.workspacePath,
        turns: snapshot === baseSnapshot ? [{ id: "busy", status: "inProgress" }] : [],
      } }),
      getAttempt: async () => ({ attempt: null }),
      requestAttempt: async () => { requests += 1; },
      releaseAttempt: async () => null,
      findArchivedThread: async () => null,
      archiveThread: async () => null,
      completeAttempt: async () => null,
    });
    assert.equal(result.shutdown, false);
  }
  assert.equal(requests, 0);

  for (const [field, value] of [
    ["codexProjectId", "other-project"],
    ["codexProjectKind", "remote"],
    ["codexHostId", "other-host"],
    ["workspacePath", "/tmp/other-workspace"],
  ]) {
    const result = await runCoordinatorShutdownMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "capstone-dev", idleGraceMs: 1 },
      now: () => Date.parse("2026-09-03T00:00:00.000Z"),
      readSnapshot: async () => baseSnapshot,
      readWindows: async () => ({
        projectId: "capstone-dev", revision: "d".repeat(64), ownerRootTaskId: owner.taskId,
        windows: [
          { ...holder, role: "coordinator" },
          { ...owner, role: "owner_root", [field]: value },
        ],
      }),
      readThread: async () => ({
        thread: { id: holder.threadId, cwd: holder.workspacePath, turns: [] },
      }),
      getAttempt: async () => ({ attempt: null }),
      requestAttempt: async () => { requests += 1; },
      releaseAttempt: async () => null,
      findArchivedThread: async () => null,
      archiveThread: async () => null,
      completeAttempt: async () => null,
    });
    assert.deepEqual(result, { shutdown: false, reason: "not-idle-or-binding-drift" });
  }
  assert.equal(requests, 0);

  const unassigned = {
    ...baseSnapshot,
    coordination: {
      ...baseSnapshot.coordination, assignment: "unassigned", coordinatorTaskId: null,
      lease: { ...baseSnapshot.coordination.lease, status: "expired", releasedAt: "2026-09-03T00:00:00.000Z" },
      durableWorkPending: false,
    },
  };
  const provisioning = await runCoordinatorProvisioningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
    readSnapshot: async () => unassigned,
    readWindows: async () => ({ projectId: "capstone-dev", revision: "a".repeat(64), windows: [] }),
    requestAttempt: async () => { requests += 1; },
    findThread: async () => null,
    markStarting: async () => null,
    startThread: async () => null,
    attachThread: async () => null,
    deliverInstruction: async () => null,
  });
  assert.deepEqual(provisioning, { provisioned: false, reason: "no-eligible-work" });
  assert.equal(requests, 0);
});

test("resident Coordinator provisioning persists one attempt before starting exactly one replacement thread", async () => {
  const ownerRoot = {
    taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  let attempt = null;
  let startCalls = 0;
  let deliveryCalls = 0;
  let modelReads = 0;
  const runTick = () => runCoordinatorProvisioningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "capstone-dev",
    },
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        assignment: "unassigned",
        durableWorkPending: true,
        ownerRootTaskId: ownerRoot.taskId,
        ownerRootRoute: {
          rootTaskId: ownerRoot.taskId,
          rootThreadId: ownerRoot.threadId,
          codexHostId: ownerRoot.codexHostId,
          rootWorkspacePath: ownerRoot.workspacePath,
        },
        lease: null,
      },
      taskLanes: [{
        id: ownerRoot.taskId,
        threadId: ownerRoot.threadId,
        codexProjectId: ownerRoot.codexProjectId,
        codexProjectKind: ownerRoot.codexProjectKind,
        codexHostId: ownerRoot.codexHostId,
        workspacePath: ownerRoot.workspacePath,
      }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev",
      revision: "a".repeat(64),
      ownerRootTaskId: ownerRoot.taskId,
      coordinatorLease: null,
      windows: [{ ...ownerRoot, role: "owner_root" }],
    }),
    readDefaultModel: async () => {
      modelReads += 1;
      return { model: "gpt-5", reasoningEffort: "high" };
    },
    getAttempt: async () => ({ attempt: attempt ? { ...attempt } : null }),
    requestAttempt: async (request) => {
      if (!attempt) assert.equal(startCalls, 0, "the durable attempt must exist before thread/start");
      attempt ??= {
        ...request,
        id: "attempt-1",
        status: "pending",
        threadId: null,
      };
      return { attempt: { ...attempt } };
    },
    findThread: async ({ threadSource }) => (
      attempt?.threadId && attempt.threadSource === threadSource
        ? { id: attempt.threadId, cwd: ownerRoot.workspacePath, threadSource }
        : null
    ),
    markStarting: async () => {
      attempt.status = "starting";
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      startCalls += 1;
      assert.equal(settings.threadSource, attempt.threadSource);
      assert.equal(settings.cwd, ownerRoot.workspacePath);
      assert.equal(settings.model, "gpt-5");
      assert.equal(settings.config.model_reasoning_effort, "high");
      return { thread: { id: "01a062c1-fd2b-7f61-9114-d483e695640e", cwd: settings.cwd, threadSource: settings.threadSource } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async ({ threadId }) => {
      deliveryCalls += 1;
      assert.equal(threadId, "01a062c1-fd2b-7f61-9114-d483e695640e");
      return { delivery: deliveryCalls === 1 ? "started" : "observed", turnId: "turn-1" };
    },
  });

  assert.deepEqual(await runTick(), { provisioned: true, reason: "thread-started", attemptId: "attempt-1" });
  assert.deepEqual(await runTick(), { provisioned: true, reason: "thread-observed", attemptId: "attempt-1" });
  assert.equal(startCalls, 1);
  assert.equal(deliveryCalls, 2);
  assert.equal(modelReads, 1);
  assert.equal(attempt.threadId, "01a062c1-fd2b-7f61-9114-d483e695640e");
});

test("domain provisioning retries selected-model capacity on the same durable attempt", async () => {
  const revision = "d".repeat(64);
  const domainThreadId = "01a09999-a749-7b53-81e2-af2d477f93ae";
  const globalThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const snapshot = {
    projectId: "capstone-dev",
    coordination: {
      coordinatorTaskId: "global",
      lease: { id: "global-lease", status: "active", bindingValid: true },
      domainCoordinators: [{
        domainId: "frontend",
        assignment: "unassigned",
        durableWorkPending: true,
        eligibleTaskIds: ["frontend"],
        writeScope: ["web"],
      }],
    },
    taskLanes: [
      {
        id: "global", source: "codex", taskType: "root_task",
        threadId: globalThreadId,
        codexProjectId: "local-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/taskboard",
      },
      {
        id: "frontend", label: "Frontend Coordinator", source: "codex",
        taskType: "peer_task", threadId: "legacy-frontend-thread",
      },
    ],
  };
  let attempt = null;
  let requests = 0;
  let starts = 0;
  let resets = 0;
  let attaches = 0;
  let deliveries = 0;
  let expiredResumes = 0;
  let attachedThreadVisible = true;
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "capstone-dev",
      model: null, reasoningEffort: null,
    },
    readSnapshot: async () => snapshot,
    readWindows: async () => ({ projectId: "capstone-dev", revision }),
    readDefaultModel: async (binding) => {
      assert.deepEqual(binding, {
        codexHostId: "local", workspacePath: "/tmp/taskboard",
      });
      return { model: "gpt-5", reasoningEffort: "high" };
    },
    getAttempt: async () => ({ attempt: attempt ? { ...attempt } : null }),
    requestAttempt: async (request) => {
      requests += 1;
      assert.equal(request.ownedCodexHostId, "local");
      assert.equal(request.taskId, "frontend");
      assert.equal(request.codexProjectId, "local-project");
      assert.equal(request.codexHostId, "local");
      assert.equal(request.workspacePath, "/tmp/taskboard");
      const { ownedCodexHostId: _ownedCodexHostId, ...persistedRequest } = request;
      attempt = {
        ...persistedRequest,
        id: "domain-attempt",
        globalHolderCodexProjectId: "local-project",
        globalHolderCodexProjectKind: "local",
        globalHolderCodexHostId: "local",
        globalHolderWorkspacePath: "/tmp/taskboard",
        writeScope: ["web"],
        status: "pending",
        threadId: null,
        retryCount: 0,
        missingSince: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      return { attempt: { ...attempt } };
    },
    findThread: async () => attachedThreadVisible && attempt?.threadId ? {
      id: attempt.threadId,
      cwd: attempt.workspacePath,
      threadSource: attempt.threadSource,
    } : null,
    readThread: async ({ attempt: readAttempt, threadId }) => ({
      id: threadId,
      cwd: readAttempt.workspacePath,
      threadSource: readAttempt.threadSource,
      turns: [{
        id: "domain-turn",
        status: "completed",
        input: `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${readAttempt.id}`,
      }],
    }),
    markStarting: async ({ ownedCodexHostId }) => {
      assert.equal(ownedCodexHostId, "local");
      attempt = { ...attempt, status: "starting" };
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      assert.equal(settings.codexHostId, "local");
      assert.equal(settings.cwd, "/tmp/taskboard");
      assert.equal(settings.approvalPolicy, "never");
      if (starts === 1) {
        throw new Error("Selected model is at capacity. Please try a different model.");
      }
      return { thread: {
        id: domainThreadId,
        cwd: settings.cwd,
        threadSource: settings.threadSource,
      } };
    },
    resetAttempt: async ({ ownedCodexHostId }) => {
      assert.equal(ownedCodexHostId, "local");
      resets += 1;
      attempt = { ...attempt, status: "pending", retryCount: attempt.retryCount + 1 };
      return { attempt: { ...attempt } };
    },
    resumeExpiredAttempt: async ({ ownedCodexHostId }) => {
      assert.equal(ownedCodexHostId, "local");
      expiredResumes += 1;
      attempt = { ...attempt, status: "started" };
      return { attempt: { ...attempt } };
    },
    attachThread: async ({ threadId, ownedCodexHostId }) => {
      assert.equal(ownedCodexHostId, "local");
      attaches += 1;
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async ({ attempt: deliveredAttempt, threadId, domainId }) => {
      deliveries += 1;
      assert.equal(deliveredAttempt.id, "domain-attempt");
      assert.equal(threadId, domainThreadId);
      assert.equal(domainId, "frontend");
      return { delivery: deliveries === 1 ? "started" : "observed", turnId: "domain-turn" };
    },
  };

  assert.deepEqual(await runDomainCoordinatorProvisioningMonitorOnce(options), {
    provisioned: false,
    reason: "model-capacity",
    domainId: "frontend",
    attemptId: "domain-attempt",
  });
  assert.equal(attempt.status, "pending");
  assert.equal(attempt.retryCount, 1);
  assert.deepEqual(await runDomainCoordinatorProvisioningMonitorOnce(options), {
    provisioned: true,
    reason: "domain-thread-started",
    domainId: "frontend",
    attemptId: "domain-attempt",
    threadId: domainThreadId,
  });
  assert.equal(requests, 1);
  assert.equal(starts, 2);
  assert.equal(resets, 1);
  assert.equal(attaches, 1);
  assert.equal(deliveries, 1);
  assert.equal(attempt.threadId, domainThreadId);
  attempt = { ...attempt, status: "expired" };
  attachedThreadVisible = false;
  assert.deepEqual(await runDomainCoordinatorProvisioningMonitorOnce(options), {
    provisioned: true,
    reason: "domain-thread-observed",
    domainId: "frontend",
    attemptId: "domain-attempt",
    threadId: domainThreadId,
  });
  assert.equal(requests, 1);
  assert.equal(starts, 2);
  assert.equal(attaches, 2);
  assert.equal(deliveries, 2);
  assert.equal(expiredResumes, 1);
});

test("domain provisioning rebinds the same attached attempt after Global Coordinator revision drift", async () => {
  const currentRevision = "e".repeat(64);
  const previousRevision = "d".repeat(64);
  const currentGlobalLeaseId = "global-lease-next-epoch";
  const domainThreadId = "01a09999-a749-7b53-81e2-af2d477f93ae";
  const globalThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const workspacePath = "/tmp/taskboard";
  let rebinds = 0;
  let attaches = 0;
  let attempt = {
    id: "domain-attempt-rebind", projectId: "capstone-dev", domainId: "frontend",
    idempotencyKey: "previous-revision-key", taskId: "frontend",
    label: "Frontend Coordinator", threadSource: "taskboard-domain-rebind-frontend",
    model: "gpt-5", reasoningEffort: "high", expectedRevision: previousRevision,
    expectedGlobalLeaseId: "global-lease", globalHolderTaskId: "global",
    globalHolderThreadId: globalThreadId,
    globalHolderCodexProjectId: "local-project", globalHolderCodexProjectKind: "local",
    globalHolderCodexHostId: "local", globalHolderWorkspacePath: workspacePath,
    codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath,
    writeScope: ["web"], status: "started", threadId: domainThreadId, retryCount: 0,
    missingSince: null, createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const result = await runDomainCoordinatorProvisioningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        coordinatorTaskId: "global",
        lease: { id: currentGlobalLeaseId, status: "active", bindingValid: true },
        domainCoordinators: [{
          domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
          eligibleTaskIds: ["frontend"],
          writeScope: ["web"],
        }],
      },
      taskLanes: [
        {
          id: "global", source: "codex", taskType: "root_task", threadId: globalThreadId,
          codexProjectId: "local-project", codexProjectKind: "local",
          codexHostId: "local", workspacePath,
        },
        {
          id: "frontend", label: "Frontend Coordinator", source: "codex",
          taskType: "peer_task", threadId: "legacy-frontend-thread",
        },
      ],
    }),
    readWindows: async () => ({ projectId: "capstone-dev", revision: currentRevision }),
    getAttempt: async ({ idempotencyKey }) => (
      idempotencyKey ? { attempt: null } : { attempt: { ...attempt } }
    ),
    requestAttempt: async () => assert.fail("revision drift must reuse the durable attempt"),
    rebindAttempt: async ({
      attemptId, expectedRevision, expectedGlobalLeaseId, ownedCodexHostId,
    }) => {
      assert.equal(attemptId, attempt.id);
      assert.equal(expectedRevision, currentRevision);
      assert.equal(expectedGlobalLeaseId, currentGlobalLeaseId);
      assert.equal(ownedCodexHostId, "local");
      rebinds += 1;
      attempt = { ...attempt, expectedRevision, expectedGlobalLeaseId };
      return { attempt: { ...attempt } };
    },
    findThread: async () => ({
      id: domainThreadId, cwd: workspacePath, threadSource: attempt.threadSource,
    }),
    markStarting: async () => assert.fail("the attached attempt must not start another thread"),
    startThread: async () => assert.fail("the attached attempt must not start another thread"),
    attachThread: async ({ threadId, ownedCodexHostId }) => {
      assert.equal(threadId, domainThreadId);
      assert.equal(ownedCodexHostId, "local");
      attaches += 1;
      return { attempt: { ...attempt } };
    },
    resetAttempt: async () => assert.fail("revision recovery must not reset the attempt"),
    readThread: async () => ({
      id: domainThreadId, cwd: workspacePath, threadSource: attempt.threadSource,
      turns: [{
        id: "domain-turn", status: "completed",
        input: `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${attempt.id}`,
      }],
    }),
    deliverInstruction: async () => ({ delivery: "observed", turnId: "domain-turn" }),
  });
  assert.equal(rebinds, 1, JSON.stringify(result));
  assert.equal(attaches, 1);
  assert.equal(attempt.expectedRevision, currentRevision);
  assert.equal(attempt.expectedGlobalLeaseId, currentGlobalLeaseId);
  assert.deepEqual(result, {
    provisioned: true, reason: "domain-thread-observed", domainId: "frontend",
    attemptId: attempt.id, threadId: domainThreadId,
  });
});

test("Coordinator provisioning rebinds the same active attempt after safe window revision drift", async () => {
  const owner = {
    taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const previousRevision = "a".repeat(64);
  const previousFingerprint = createHash("sha256")
    .update(JSON.stringify({
      projectId: "capstone-dev", revision: previousRevision, ownerRootTaskId: owner.taskId,
    }))
    .digest("hex");
  const currentRevision = "b".repeat(64);
  let attempt = {
    id: "attempt-rebind",
    projectId: "capstone-dev",
    idempotencyKey: `coordinator-provision-${previousFingerprint}`,
    taskId: `coordinator-capstone-dev-${previousFingerprint.slice(0, 12)}`,
    label: "Taskboard Execution Coordinator",
    threadSource: `taskboard-coordinator-provision-${previousFingerprint}`,
    model: "gpt-5",
    reasoningEffort: "high",
    expectedRevision: previousRevision,
    ownerRootTaskId: owner.taskId,
    ownerRootThreadId: owner.threadId,
    codexProjectId: owner.codexProjectId,
    codexProjectKind: owner.codexProjectKind,
    codexHostId: owner.codexHostId,
    workspacePath: owner.workspacePath,
    status: "pending",
    threadId: null,
  };
  let exactLookups = 0;
  let fallbackLookups = 0;
  let rebinds = 0;
  let starts = 0;
  let loseRebindResponse = true;
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
        ownerRootRoute: {
          rootTaskId: owner.taskId, rootThreadId: owner.threadId,
          codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
        },
        lease: null,
      },
      taskLanes: [{ id: owner.taskId, ...owner }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev", revision: currentRevision, ownerRootTaskId: owner.taskId,
      coordinatorLease: null, windows: [{ ...owner, role: "owner_root" }],
    }),
    getAttempt: async ({ idempotencyKey }) => {
      if (idempotencyKey) {
        exactLookups += 1;
        return { attempt: null };
      }
      fallbackLookups += 1;
      return { attempt: { ...attempt } };
    },
    requestAttempt: async () => assert.fail("the existing durable attempt must be reused"),
    rebindAttempt: async ({ attemptId, expectedRevision }) => {
      rebinds += 1;
      assert.equal(attemptId, attempt.id);
      assert.equal(expectedRevision, currentRevision);
      attempt = { ...attempt, expectedRevision };
      if (loseRebindResponse) {
        loseRebindResponse = false;
        throw new Error("simulated rebind response loss");
      }
      return { attempt: { ...attempt } };
    },
    findThread: async () => null,
    markStarting: async () => {
      attempt = { ...attempt, status: "starting" };
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      assert.equal(settings.approvalPolicy, "never");
      assert.equal(settings.approvalsReviewer, undefined);
      return { thread: {
        id: "01a09999-a749-7b53-81e2-af2d477f93ae",
        cwd: settings.cwd,
        threadSource: settings.threadSource,
      } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
  };

  await assert.rejects(
    runCoordinatorProvisioningMonitorOnce(options),
    /simulated rebind response loss/,
  );
  assert.equal(starts, 0);
  const result = await runCoordinatorProvisioningMonitorOnce(options);

  assert.deepEqual(result, {
    provisioned: true, reason: "thread-started", attemptId: attempt.id,
  });
  assert.equal(exactLookups, 2);
  assert.equal(fallbackLookups, 2);
  assert.equal(rebinds, 1);
  assert.equal(starts, 1);
});

test("Coordinator provisioning rejects explicit model policy drift without rebind or thread start", async () => {
  const owner = {
    taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  for (const policyDrift of [
    { model: "gpt-5.1", reasoningEffort: "high" },
    { model: "gpt-5", reasoningEffort: "medium" },
  ]) {
    let rebinds = 0;
    let starts = 0;
    const attempt = {
      id: "attempt-policy-drift",
      projectId: "capstone-dev",
      idempotencyKey: "older-revision-key",
      taskId: "coordinator-capstone-dev-stable",
      label: "Taskboard Execution Coordinator",
      threadSource: "taskboard-coordinator-provision-stable",
      model: "gpt-5",
      reasoningEffort: "high",
      expectedRevision: "a".repeat(64),
      ownerRootTaskId: owner.taskId,
      ownerRootThreadId: owner.threadId,
      codexProjectId: owner.codexProjectId,
      codexProjectKind: owner.codexProjectKind,
      codexHostId: owner.codexHostId,
      workspacePath: owner.workspacePath,
      status: "pending",
      threadId: null,
    };
    const result = await runCoordinatorProvisioningMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "capstone-dev", ...policyDrift },
      readSnapshot: async () => ({
        projectId: "capstone-dev",
        coordination: {
          assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
          ownerRootRoute: {
            rootTaskId: owner.taskId, rootThreadId: owner.threadId,
            codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
          },
          lease: null,
        },
        taskLanes: [{ id: owner.taskId, ...owner }],
      }),
      readWindows: async () => ({
        projectId: "capstone-dev", revision: "b".repeat(64), ownerRootTaskId: owner.taskId,
        coordinatorLease: null, windows: [{ ...owner, role: "owner_root" }],
      }),
      getAttempt: async ({ idempotencyKey }) => (
        idempotencyKey ? { attempt: null } : { attempt }
      ),
      requestAttempt: async () => assert.fail("policy drift must not create a replacement attempt"),
      rebindAttempt: async () => {
        rebinds += 1;
        return { attempt };
      },
      findThread: async () => null,
      markStarting: async () => assert.fail("policy drift must not advance the attempt"),
      startThread: async () => {
        starts += 1;
        return null;
      },
      attachThread: async () => assert.fail("policy drift must not attach a thread"),
      deliverInstruction: async () => assert.fail("policy drift must not deliver work"),
    });
    assert.deepEqual(result, {
      provisioned: false, reason: "attempt-binding-mismatch", attemptId: attempt.id,
    });
    assert.equal(rebinds, 0);
    assert.equal(starts, 0);
  }
});

test("Coordinator provisioning retries selected-model capacity on the same attempt and fails closed on uncertainty", async () => {
  const owner = {
    taskId: "owner-root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const snapshot = {
    projectId: "capstone-dev",
    coordination: {
      assignment: "unassigned",
      durableWorkPending: true,
      ownerRootTaskId: owner.taskId,
      ownerRootRoute: {
        rootTaskId: owner.taskId,
        rootThreadId: owner.threadId,
        codexHostId: owner.codexHostId,
        rootWorkspacePath: owner.workspacePath,
      },
      lease: null,
    },
    taskLanes: [{ id: owner.taskId, ...owner }],
  };
  const windows = {
    projectId: "capstone-dev",
    revision: "b".repeat(64),
    ownerRootTaskId: owner.taskId,
    windows: [{ ...owner, role: "owner_root" }],
  };
  const runScenario = async (failureMessage, expectRetry) => {
    let attempt;
    let starts = 0;
    let resets = 0;
    let modelReads = 0;
    const options = {
      hostExecutor: localHostExecutor,
      policy: {
        enabled: true, projectId: "capstone-dev",
      },
      readSnapshot: async () => snapshot,
      readWindows: async () => windows,
      getAttempt: async () => ({ attempt: attempt ? { ...attempt } : null }),
      readDefaultModel: async () => ({
        model: ++modelReads === 1 ? "gpt-5" : "gpt-6",
        reasoningEffort: "high",
      }),
      requestAttempt: async (request) => {
        attempt ??= {
          ...request, id: `attempt-${expectRetry ? "capacity" : "uncertain"}`,
          status: "pending", threadId: null,
        };
        return { attempt: { ...attempt } };
      },
      findThread: async () => null,
      markStarting: async () => {
        attempt.status = "starting";
        return { attempt: { ...attempt } };
      },
      startThread: async (settings) => {
        starts += 1;
        assert.equal(settings.model, "gpt-5");
        if (starts === 1) throw new Error(failureMessage);
        return { thread: {
          id: "01a062c1-fd2b-7f61-9114-d483e695640e",
          cwd: settings.cwd,
          threadSource: settings.threadSource,
        } };
      },
      resetAttempt: async () => {
        resets += 1;
        attempt.status = "pending";
        return { attempt: { ...attempt } };
      },
      attachThread: async ({ threadId }) => {
        attempt = { ...attempt, status: "started", threadId };
        return { attempt: { ...attempt } };
      },
      deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
    };
    const first = await runCoordinatorProvisioningMonitorOnce(options);
    const second = await runCoordinatorProvisioningMonitorOnce(options);
    return { first, second, starts, resets, modelReads, attempt };
  };

  const capacity = await runScenario(
    "Selected model is at capacity. Please try a different model.", true,
  );
  assert.equal(capacity.first.reason, "model-capacity");
  assert.equal(capacity.second.reason, "thread-started");
  assert.equal(capacity.starts, 2);
  assert.equal(capacity.resets, 1);
  assert.equal(capacity.modelReads, 1);
  assert.equal(capacity.attempt.status, "started");

  const uncertain = await runScenario("Codex App Server request timed out", false);
  assert.equal(uncertain.first.reason, "thread-start-uncertain");
  assert.equal(uncertain.second.reason, "thread-start-uncertain");
  assert.equal(uncertain.starts, 1);
  assert.equal(uncertain.resets, 0);
  assert.equal(uncertain.attempt.status, "starting");
});

test("Coordinator provisioning safely resets a confirmed missing started thread and starts one replacement", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const revision = "9".repeat(64);
  let attempt = {
    id: "attempt-missing-thread", projectId: "capstone-dev",
    idempotencyKey: "older-revision-key", taskId: "coordinator-capstone-dev-stable",
    label: "Taskboard Execution Coordinator",
    threadSource: "taskboard-coordinator-provision-stable",
    model: "gpt-5", reasoningEffort: "high", expectedRevision: revision,
    ownerRootTaskId: owner.taskId, ownerRootThreadId: owner.threadId,
    codexProjectId: owner.codexProjectId, codexProjectKind: owner.codexProjectKind,
    codexHostId: owner.codexHostId, workspacePath: owner.workspacePath,
    status: "started", threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
    updatedAt: "2026-09-02T00:00:00.000Z", missingSince: null,
  };
  let missingResets = 0;
  let missingObservations = 0;
  let missingClears = 0;
  let starts = 0;
  let currentTime = Date.parse("2026-09-03T00:00:30.000Z");
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
    now: () => currentTime,
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
        ownerRootRoute: {
          rootTaskId: owner.taskId, rootThreadId: owner.threadId,
          codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
        },
        lease: null,
      },
      taskLanes: [{ id: owner.taskId, ...owner }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev", revision, ownerRootTaskId: owner.taskId,
      coordinatorLease: null, windows: [{ ...owner, role: "owner_root" }],
    }),
    getAttempt: async ({ idempotencyKey }) => (
      idempotencyKey ? { attempt: null } : { attempt: { ...attempt } }
    ),
    requestAttempt: async () => assert.fail("the same durable attempt must be reused"),
    findThread: async () => null,
    findArchivedThread: async () => null,
    observeMissingAttempt: async ({ attemptId }) => {
      assert.equal(attemptId, attempt.id);
      missingObservations += 1;
      attempt = {
        ...attempt,
        missingSince: attempt.missingSince
          ?? new Date(currentTime).toISOString(),
      };
      return { attempt: { ...attempt } };
    },
    clearMissingAttempt: async ({ attemptId }) => {
      assert.equal(attemptId, attempt.id);
      missingClears += 1;
      attempt = { ...attempt, missingSince: null };
      return { attempt: { ...attempt } };
    },
    resetMissingAttempt: async ({ attemptId }) => {
      assert.equal(attemptId, attempt.id);
      missingResets += 1;
      attempt = {
        ...attempt,
        status: "pending",
        threadId: null,
        retryCount: 1,
        missingSince: null,
      };
      return { attempt: { ...attempt } };
    },
    markStarting: async () => {
      attempt = { ...attempt, status: "starting" };
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      return { thread: {
        id: "01a08888-a749-7b53-81e2-af2d477f93ae",
        cwd: settings.cwd, threadSource: settings.threadSource,
      } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
  };

  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: false, reason: "started-thread-missing", attemptId: attempt.id,
  });
  assert.equal(missingResets, 0);
  assert.equal(starts, 0);
  assert.equal(missingObservations, 1);
  assert.equal(attempt.missingSince, "2026-09-03T00:00:30.000Z");
  currentTime = Date.parse("2026-09-03T00:02:00.000Z");
  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: false, reason: "missing-thread-reset", attemptId: attempt.id,
  });
  assert.equal(missingResets, 1);
  assert.equal(starts, 0);
  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: true, reason: "thread-started", attemptId: attempt.id,
  });
  assert.equal(missingResets, 1);
  assert.equal(starts, 1);
  assert.equal(missingClears, 0);

  attempt = {
    ...attempt,
    status: "expired",
    threadId: "01a07777-a749-7b53-81e2-af2d477f93ae",
    missingSince: null,
  };
  currentTime += 1_000;
  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: false, reason: "started-thread-missing", attemptId: attempt.id,
  });
  assert.equal(missingObservations, 3);
  assert.equal(missingResets, 1);
  currentTime += 60_000;
  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: false, reason: "missing-thread-reset", attemptId: attempt.id,
  });
  assert.equal(missingResets, 2);
});

test("Coordinator provisioning clears a transient missing observation when the old thread reappears", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const revision = "9".repeat(64);
  const activeThread = {
    id: "01a09999-a749-7b53-81e2-af2d477f93ae",
    cwd: owner.workspacePath,
    threadSource: "taskboard-coordinator-provision-stable",
  };
  let attempt = {
    id: "attempt-transient-missing", projectId: "capstone-dev",
    idempotencyKey: "older-revision-key", taskId: "coordinator-capstone-dev-stable",
    label: "Taskboard Execution Coordinator", threadSource: activeThread.threadSource,
    model: "gpt-5", reasoningEffort: "high", expectedRevision: revision,
    ownerRootTaskId: owner.taskId, ownerRootThreadId: owner.threadId,
    codexProjectId: owner.codexProjectId, codexProjectKind: owner.codexProjectKind,
    codexHostId: owner.codexHostId, workspacePath: owner.workspacePath,
    status: "started", threadId: activeThread.id,
    updatedAt: "2026-09-02T00:00:00.000Z", missingSince: null,
  };
  let currentTime = Date.parse("2026-09-03T00:00:00.000Z");
  let active = false;
  let directReadable = false;
  let directError = new Error("Codex App Server request timed out");
  let listReads = 0;
  let starts = 0;
  let resets = 0;
  let expiredResumes = 0;
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
    now: () => currentTime,
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
        ownerRootRoute: {
          rootTaskId: owner.taskId, rootThreadId: owner.threadId,
          codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
        },
        lease: null,
      },
      taskLanes: [{ id: owner.taskId, ...owner }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev", revision, ownerRootTaskId: owner.taskId,
      coordinatorLease: null, windows: [{ ...owner, role: "owner_root" }],
    }),
    getAttempt: async ({ idempotencyKey }) => (
      idempotencyKey ? { attempt: null } : { attempt: { ...attempt } }
    ),
    requestAttempt: async () => assert.fail("the same durable attempt must be reused"),
    readThread: async () => {
      if (directError) throw directError;
      return directReadable ? activeThread : null;
    },
    findThread: async () => {
      listReads += 1;
      return active ? activeThread : null;
    },
    findArchivedThread: async () => null,
    observeMissingAttempt: async () => {
      attempt = { ...attempt, missingSince: attempt.missingSince ?? new Date(currentTime).toISOString() };
      return { attempt: { ...attempt } };
    },
    clearMissingAttempt: async () => {
      attempt = { ...attempt, missingSince: null };
      return { attempt: { ...attempt } };
    },
    resetMissingAttempt: async () => {
      resets += 1;
      return { attempt: { ...attempt } };
    },
    resumeExpiredAttempt: async () => {
      expiredResumes += 1;
      attempt = { ...attempt, status: "started" };
      return { attempt: { ...attempt } };
    },
    markStarting: async () => assert.fail("an attached thread must not start again"),
    attachThread: async () => ({ attempt: { ...attempt } }),
    deliverInstruction: async () => ({ delivery: "already-delivered", turnId: "turn-1" }),
    startThread: async () => { starts += 1; return { thread: activeThread }; },
  };

  await assert.rejects(() => runCoordinatorProvisioningMonitorOnce(options), /timed out/);
  assert.equal(listReads, 0);
  assert.equal(attempt.missingSince, null);
  assert.equal(resets, 0);
  assert.equal(starts, 0);
  try {
    coordinatorProvisioningThreadReadData({});
  } catch (error) {
    directError = error;
  }
  await assert.rejects(
    () => runCoordinatorProvisioningMonitorOnce(options),
    /did not return one exact thread object/,
  );
  assert.equal(listReads, 0);
  assert.equal(attempt.missingSince, null);
  assert.equal(resets, 0);
  assert.equal(starts, 0);
  directError = null;
  assert.equal((await runCoordinatorProvisioningMonitorOnce(options)).reason, "started-thread-missing");
  assert.equal(attempt.missingSince, "2026-09-03T00:00:00.000Z");
  currentTime += 120_000;
  directReadable = true;
  assert.equal((await runCoordinatorProvisioningMonitorOnce(options)).reason, "thread-started");
  assert.equal(attempt.missingSince, null);
  attempt = { ...attempt, status: "expired" };
  activeThread.turns = [{
    id: "failed-delivery",
    status: "failed",
    input: `TASKBOARD_COORDINATOR_PROVISIONING_V1:${attempt.id}`,
  }];
  assert.equal((await runCoordinatorProvisioningMonitorOnce(options)).reason, "thread-started");
  assert.equal(expiredResumes, 1);
  attempt = { ...attempt, status: "expired" };
  activeThread.turns = [];
  assert.equal(
    (await runCoordinatorProvisioningMonitorOnce(options)).reason,
    "attempt-expired-thread-active",
  );
  attempt = { ...attempt, status: "started" };
  directReadable = false;
  assert.equal((await runCoordinatorProvisioningMonitorOnce(options)).reason, "started-thread-missing");
  assert.equal(attempt.missingSince, "2026-09-03T00:02:00.000Z");
  assert.equal(resets, 0);
  assert.equal(starts, 0);
});

test("Coordinator provisioning thread lookup fails closed when pagination is not exhausted", async () => {
  let pages = 0;
  await assert.rejects(
    () => findCoordinatorProvisioningThreadAcrossPages({
      attempt: {
        threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
        threadSource: "taskboard-coordinator-provision-stable",
        workspacePath: "/tmp/taskboard",
      },
      archived: false,
      listPage: async () => {
        pages += 1;
        return { data: [], nextCursor: `page-${pages + 1}` };
      },
    }),
    /pagination was not exhausted/,
  );
  assert.equal(pages, 10);
});

test("Coordinator provisioning performs zero mutation when a lease or Coordinator window exists", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const baseSnapshot = {
    projectId: "capstone-dev",
    coordination: {
      assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
      ownerRootRoute: {
        rootTaskId: owner.taskId, rootThreadId: owner.threadId,
        codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
      },
      lease: null,
    },
    taskLanes: [{ id: owner.taskId, ...owner }],
  };
  let requests = 0;
  for (const scenario of [
    { lease: { status: "active" }, windows: [] },
    { lease: { status: "expired", bindingValid: true, releasedAt: null }, windows: [] },
    { lease: null, windows: [{ ...owner, taskId: "coordinator", role: "coordinator" }] },
  ]) {
    const result = await runCoordinatorProvisioningMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: {
        enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high",
      },
      readSnapshot: async () => ({
        ...baseSnapshot,
        coordination: { ...baseSnapshot.coordination, lease: scenario.lease },
      }),
      readWindows: async () => ({
        projectId: "capstone-dev", revision: "c".repeat(64), ownerRootTaskId: owner.taskId,
        windows: [{ ...owner, role: "owner_root" }, ...scenario.windows],
      }),
      requestAttempt: async () => { requests += 1; },
      findThread: async () => null,
      markStarting: async () => null,
      startThread: async () => null,
      attachThread: async () => null,
      deliverInstruction: async () => null,
    });
    assert.equal(result.provisioned, false);
  }
  assert.equal(requests, 0);
});

test("Coordinator provisioning retires only protected stale windows and starts one replacement", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const stale = {
    taskId: "root", label: "Execution Coordinator", role: "coordinator",
    threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  let attempt = null;
  let requests = 0;
  let starts = 0;
  let retired = false;
  let preflightReads = 0;
  const beforeRevision = "d".repeat(64);
  const afterRevision = "e".repeat(64);
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high",
    },
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      coordination: {
        assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
        ownerRootRoute: {
          rootTaskId: owner.taskId, rootThreadId: owner.threadId,
          codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
        },
        lease: { status: "released", releasedAt: "2026-09-02T22:55:28.211Z" },
      },
      taskLanes: [{ id: owner.taskId, ...owner }],
    }),
    readWindows: async () => ({
      projectId: "capstone-dev", revision: beforeRevision, ownerRootTaskId: owner.taskId,
      windows: [{ ...owner, role: "owner_root" }, stale],
    }),
    readPreflight: async () => {
      preflightReads += 1;
      return {
        projectId: "capstone-dev",
        revision: retired ? afterRevision : beforeRevision,
        ownerRootTaskId: owner.taskId,
        coordinatorLease: { status: "released", releasedAt: "2026-09-02T22:55:28.211Z" },
        durableWorkPending: true,
        ownerRootValid: true,
        shutdownAttempt: null,
        windows: retired
          ? [{ ...owner, label: "Owner Root", role: "owner_root" }]
          : [{ ...owner, label: "Owner Root", role: "owner_root" }, stale],
      };
    },
    inspectCoordinatorWindow: async (window) => {
      assert.deepEqual(window, stale);
      return { eligibility: "stale", reason: "archived", window };
    },
    getAttempt: async () => ({ attempt: attempt ? { ...attempt } : null }),
    requestAttempt: async (request) => {
      requests += 1;
      assert.deepEqual(request.retireCoordinatorWindows, [stale]);
      retired = true;
      attempt ??= {
        ...request, expectedRevision: afterRevision,
        id: "attempt-stale", status: "pending", threadId: null,
      };
      return { attempt: { ...attempt } };
    },
    findThread: async () => null,
    markStarting: async () => {
      attempt.status = "starting";
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      return { thread: { id: "01a09999-a749-7b53-81e2-af2d477f93ae", cwd: settings.cwd, threadSource: settings.threadSource } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
  };

  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: true, reason: "thread-started", attemptId: "attempt-stale",
  });
  assert.equal(requests, 1);
  assert.equal(starts, 1);
  assert.equal(preflightReads, 2);
});

test("Coordinator provisioning reaches protected stale inspection without reading an invalid full snapshot", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const stale = {
    taskId: "root", label: "Execution Coordinator", role: "coordinator",
    threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  let attempts = 0;
  let inspections = 0;
  let starts = 0;
  let attempt = null;
  let retired = false;
  const beforeRevision = "9".repeat(64);
  const afterRevision = "a".repeat(64);
  const result = await runCoordinatorProvisioningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high",
    },
    readSnapshot: async () => {
      throw new Error("Taskboard Agent Lanes returned HTTP 404");
    },
    readWindows: async () => {
      throw new Error("the protected preflight already contains the exact window revision");
    },
    readPreflight: async () => ({
      projectId: "capstone-dev", revision: retired ? afterRevision : beforeRevision,
      ownerRootTaskId: owner.taskId,
      coordinatorLease: {
        id: "released-lease", holderTaskId: "retired-coordinator",
        holderThreadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
        acquiredAt: "2026-09-02T22:50:00.000Z", expiresAt: "2026-09-02T22:55:00.000Z",
        releasedAt: "2026-09-02T22:55:00.000Z",
      },
      durableWorkPending: true,
      ownerRootValid: true,
      shutdownAttempt: null,
      windows: [{ ...owner, label: "Owner Root", role: "owner_root" }, ...(retired ? [] : [stale])],
    }),
    inspectCoordinatorWindow: async (window) => {
      inspections += 1;
      return { eligibility: "stale", reason: "missing", window };
    },
    getAttempt: async () => ({ attempt: null }),
    requestAttempt: async (request) => {
      attempts += 1;
      assert.deepEqual(request.retireCoordinatorWindows, [stale]);
      retired = true;
      attempt = {
        ...request, expectedRevision: afterRevision,
        id: "attempt-invalid-stale", status: "pending", threadId: null,
      };
      return { attempt: { ...attempt } };
    },
    findThread: async () => null,
    markStarting: async () => {
      attempt.status = "starting";
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      return { thread: {
        id: "01a09999-a749-7b53-81e2-af2d477f93ae",
        cwd: settings.cwd, threadSource: settings.threadSource,
      } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
  });

  assert.equal(result.provisioned, true);
  assert.equal(inspections, 1);
  assert.equal(attempts, 1);
  assert.equal(starts, 1);
});

test("Coordinator provisioning preflight rejects an invalid Owner Root before stale inspection", async () => {
  let inspections = 0;
  let attempts = 0;
  const result = await runCoordinatorProvisioningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high",
    },
    readPreflight: async () => ({
      projectId: "capstone-dev", revision: "8".repeat(64), ownerRootTaskId: "owner-root",
      ownerRootValid: false, coordinatorLease: null, durableWorkPending: true,
      shutdownAttempt: null,
      windows: [{
        taskId: "owner-root", label: "Owner Root", role: "owner_root",
        threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
        codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
        workspacePath: "/tmp/taskboard",
      }, {
        taskId: "root", label: "Execution Coordinator", role: "coordinator",
        threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
        codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
        workspacePath: "/tmp/taskboard",
      }],
    }),
    inspectCoordinatorWindow: async () => { inspections += 1; },
    requestAttempt: async () => { attempts += 1; },
    findThread: async () => null,
    markStarting: async () => null,
    startThread: async () => null,
    attachThread: async () => null,
    deliverInstruction: async () => null,
  });

  assert.deepEqual(result, { provisioned: false, reason: "owner-root-invalid" });
  assert.equal(inspections, 0);
  assert.equal(attempts, 0);
});

test("Coordinator provisioning recovers the same attempt after stale-window retirement response loss", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const stale = {
    taskId: "root", label: "Execution Coordinator", role: "coordinator",
    threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  const beforeRevision = "d".repeat(64);
  const afterRevision = "f".repeat(64);
  let retired = false;
  let attempt = null;
  let requests = 0;
  let starts = 0;
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high",
    },
    readSnapshot: async () => {
      throw new Error("the invalid full snapshot must not gate response-loss recovery");
    },
    readPreflight: async () => ({
      projectId: "capstone-dev", revision: retired ? afterRevision : beforeRevision,
      ownerRootTaskId: owner.taskId,
      coordinatorLease: {
        id: "released-lease", holderTaskId: "retired-coordinator",
        holderThreadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
        acquiredAt: "2026-09-02T22:50:00.000Z", expiresAt: "2026-09-02T22:55:00.000Z",
        releasedAt: "2026-09-02T22:55:00.000Z",
      },
      durableWorkPending: true,
      ownerRootValid: true,
      shutdownAttempt: null,
      windows: [{ ...owner, role: "owner_root" }, ...(retired ? [] : [stale])],
    }),
    readWindows: async () => {
      throw new Error("the protected preflight already contains the exact window revision");
    },
    inspectCoordinatorWindow: async () => ({ eligibility: "stale", reason: "archived", window: stale }),
    getAttempt: async ({ idempotencyKey }) => ({
      attempt: idempotencyKey ? null : attempt ? { ...attempt } : null,
    }),
    requestAttempt: async (request) => {
      requests += 1;
      retired = true;
      attempt = {
        ...request, id: "attempt-response-loss", expectedRevision: afterRevision,
        status: "pending", threadId: null,
      };
      throw new Error("response lost after commit");
    },
    findThread: async () => null,
    markStarting: async () => {
      attempt.status = "starting";
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      starts += 1;
      return { thread: {
        id: "01a09999-a749-7b53-81e2-af2d477f93ae",
        cwd: settings.cwd, threadSource: attempt.threadSource,
      } };
    },
    attachThread: async ({ threadId }) => {
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => ({ delivery: "started", turnId: "turn-1" }),
  };

  await assert.rejects(runCoordinatorProvisioningMonitorOnce(options), /response lost/);
  assert.deepEqual(await runCoordinatorProvisioningMonitorOnce(options), {
    provisioned: true, reason: "thread-started", attemptId: "attempt-response-loss",
  });
  assert.equal(requests, 1);
  assert.equal(starts, 1);
});

test("Coordinator provisioning fails closed for fresh busy or uncertain registered windows", async () => {
  const owner = {
    taskId: "owner-root", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
    workspacePath: "/tmp/taskboard",
  };
  const coordinator = {
    taskId: "coordinator-a", label: "Coordinator", role: "coordinator",
    threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexProjectId: "local-project",
    codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/taskboard",
  };
  let requests = 0;
  for (const inspection of [
    { eligibility: "eligible", busy: true, window: coordinator },
    { eligibility: "uncertain", reason: "host-unavailable", window: coordinator },
  ]) {
    const result = await runCoordinatorProvisioningMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "capstone-dev", model: "gpt-5", reasoningEffort: "high" },
      readSnapshot: async () => ({
        projectId: "capstone-dev",
        coordination: {
          assignment: "unassigned", durableWorkPending: true, ownerRootTaskId: owner.taskId,
          ownerRootRoute: {
            rootTaskId: owner.taskId, rootThreadId: owner.threadId,
            codexHostId: owner.codexHostId, rootWorkspacePath: owner.workspacePath,
          },
          lease: null,
        },
        taskLanes: [{ id: owner.taskId, ...owner }],
      }),
      readWindows: async () => ({
        projectId: "capstone-dev", revision: "e".repeat(64), ownerRootTaskId: owner.taskId,
        windows: [{ ...owner, role: "owner_root" }, coordinator],
      }),
      inspectCoordinatorWindow: async () => inspection,
      requestAttempt: async () => { requests += 1; },
      findThread: async () => null,
      markStarting: async () => null,
      startThread: async () => null,
      attachThread: async () => null,
      deliverInstruction: async () => null,
    });
    assert.equal(result.provisioned, false);
    assert.match(result.reason, /coordinator-window|window-inspection/);
    if (inspection.eligibility === "uncertain") {
      assert.equal(result.inspectionReason, "host-unavailable");
    }
  }
  assert.equal(requests, 0);
});

test("coordinator keepalive fails closed for busy, drifted, or non-active holders", async () => {
  const now = Date.parse("2026-08-31T01:00:00.000Z");
  let renewed = 0;
  const snapshot = coordinatorKeepaliveSnapshot({
    expiresAt: "2026-08-31T01:00:30.000Z",
    domainExpiresAt: "2026-08-31T00:59:59.000Z",
  });
  snapshot.coordination.domainCoordinators[0].lease.status = "expired";
  const result = await runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => now,
    readSnapshot: async () => snapshot,
    readThread: async (route) => ({
      thread: {
        id: route.threadId,
        cwd: route.workspacePath,
        turns: [{ id: "busy", status: "inProgress" }],
      },
    }),
    renewLease: async () => { renewed += 1; },
  });
  assert.equal(renewed, 0);
  assert.deepEqual(result, { renewed: 0, failed: 0, skipped: 2 });
});

test("coordinator keepalive fails closed when thread busy state is unavailable", async () => {
  let renewed = 0;
  const result = await runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    now: () => Date.parse("2026-08-31T01:00:00.000Z"),
    readSnapshot: async () => coordinatorKeepaliveSnapshot({
      expiresAt: "2026-08-31T01:00:30.000Z",
      domainExpiresAt: "2026-08-31T02:00:00.000Z",
    }),
    readThread: async (route) => ({
      thread: { id: route.threadId, cwd: route.workspacePath },
    }),
    renewLease: async () => { renewed += 1; },
  });
  assert.equal(renewed, 0);
  assert.deepEqual(result, { renewed: 0, failed: 0, skipped: 2 });
});

test("coordinator recovery restores only exact naturally expired Global and domain holders", async () => {
  const snapshot = coordinatorKeepaliveSnapshot({
    expiresAt: "2026-08-31T00:59:00.000Z",
    domainExpiresAt: "2026-08-31T00:59:00.000Z",
  });
  snapshot.coordination.lease = {
    ...snapshot.coordination.lease,
    holderTaskId: "global",
    bindingValid: true,
    status: "expired",
    releasedAt: null,
  };
  snapshot.coordination.domainCoordinators[0].lease = {
    ...snapshot.coordination.domainCoordinators[0].lease,
    holderTaskId: "frontend",
    bindingValid: true,
    status: "expired",
    releasedAt: null,
  };
  const recovered = [];
  const result = await runCoordinatorLeaseRecoveryMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
    readSnapshot: async () => snapshot,
    readThread: async (route) => ({
      thread: { id: route.threadId, cwd: route.workspacePath, turns: [] },
    }),
    recoverLease: async (request) => {
      recovered.push(request);
      return { lease: { id: `${request.scope}-recovered`, status: "active" } };
    },
  });
  assert.deepEqual(recovered.map(({ scope, domainId }) => [scope, domainId ?? null]), [
    ["global", null],
    ["domain", "frontend"],
  ]);
  assert.deepEqual(result, { recovered: 2, failed: 0, skipped: 0 });
});

test("Coordinator recovery skips foreign-first expired routes and restores only exact owned hosts", async () => {
  const snapshot = coordinatorKeepaliveSnapshot({
    expiresAt: "2026-08-31T00:59:00.000Z",
    domainExpiresAt: "2026-08-31T00:59:00.000Z",
    globalCodexHostId: remoteHostExecutor.ownedCodexHostId,
    domainCodexHostId: localHostExecutor.ownedCodexHostId,
  });
  snapshot.coordination.lease = {
    ...snapshot.coordination.lease,
    holderTaskId: "global",
    bindingValid: true,
    status: "expired",
    releasedAt: null,
  };
  snapshot.coordination.domainCoordinators[0].lease = {
    ...snapshot.coordination.domainCoordinators[0].lease,
    holderTaskId: "frontend",
    bindingValid: true,
    status: "expired",
    releasedAt: null,
  };
  const reads = [];
  const recoveries = [];
  const result = await runCoordinatorLeaseRecoveryMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
    readSnapshot: async () => snapshot,
    readThread: async (route) => {
      reads.push(route.codexHostId);
      return { thread: { id: route.threadId, cwd: route.workspacePath, turns: [] } };
    },
    recoverLease: async (request) => {
      recoveries.push(request);
      return { lease: { id: `${request.scope}-recovered`, status: "active" } };
    },
  });
  assert.deepEqual(result, { recovered: 1, failed: 0, skipped: 1 });
  assert.deepEqual(reads, [localHostExecutor.ownedCodexHostId]);
  assert.deepEqual(recoveries.map(({ scope, codexHostId }) => [scope, codexHostId]), [[
    "domain", localHostExecutor.ownedCodexHostId,
  ]]);
});

test("coordinator recovery skips explicit release and busy holders", async () => {
  const snapshot = coordinatorKeepaliveSnapshot({
    expiresAt: "2026-08-31T00:59:00.000Z",
    domainExpiresAt: "2026-08-31T00:59:00.000Z",
  });
  snapshot.coordination.lease = {
    ...snapshot.coordination.lease,
    holderTaskId: "global",
    bindingValid: true,
    status: "expired",
    releasedAt: null,
  };
  snapshot.coordination.domainCoordinators[0].lease = {
    ...snapshot.coordination.domainCoordinators[0].lease,
    holderTaskId: "frontend",
    bindingValid: true,
    status: "expired",
    releasedAt: "2026-08-31T00:59:00.000Z",
  };
  let recovered = 0;
  const result = await runCoordinatorLeaseRecoveryMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
    readSnapshot: async () => snapshot,
    readThread: async (route) => ({
      thread: { id: route.threadId, cwd: route.workspacePath, turns: [{ status: "inProgress" }] },
    }),
    recoverLease: async () => { recovered += 1; },
  });
  assert.equal(recovered, 0);
  assert.deepEqual(result, { recovered: 0, failed: 0, skipped: 2 });
});

const coordinationAuthorization = {
  safeActionId: "safe-action",
  expectedResumeToken: "a".repeat(64),
  rootWorkspacePath: path.resolve("/tmp/taskboard/project"),
  deliveryReceipt: {
    id: "coordination-receipt",
    reservationLeaseId: "reservation-lease",
    admissionAttemptId: "admission-attempt",
  },
};
const deliverCoordination = (
  request,
  rpc,
  validateExecutionTarget = async () => {},
  confirmHostAccess,
) => (
  deliverTaskboardCoordination(request, rpc, validateExecutionTarget, confirmHostAccess)
);
const confirmedIdentity = {
  worktreePath: path.resolve("/tmp/taskboard/project"),
  branch: "codex/test",
  repository: null,
};

test("background continuation delivers one eligible first safe action without a mounted view", async () => {
  const deliveries = [];
  const receipts = new Set();
  const todo = {
    id: "TASKBOARD-BACKGROUND",
    taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      rootWorkspacePath: coordinationAuthorization.rootWorkspacePath,
      worktreePath: confirmedIdentity.worktreePath,
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [{ id: "push", text: "Push later" }],
      resumeToken: "b".repeat(64),
    },
  };
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [todo] }),
    claimReceipt: async (claim) => {
      assert.deepEqual(claim, {
        todoId: todo.id,
        taskId: todo.taskId,
        rootThreadId: todo.dispatchTarget.rootThreadId,
        ownedCodexHostId: "local",
        safeActionId: "safe-first",
        expectedResumeToken: "b".repeat(64),
      });
      const key = `${claim.todoId}:${claim.expectedResumeToken}`;
      if (receipts.has(key)) return { available: false, completed: true, receipt: { id: "receipt" } };
      receipts.add(key);
      return {
        available: true, completed: false,
        receipt: { id: "receipt", reservationLeaseId: "lease" },
      };
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async (request) => {
      deliveries.push(request);
      return { delivery: "started", turnId: "turn-background" };
    },
    completeDelivery: async () => ({ completed: true }),
  };

  const first = await runTaskboardContinuationMonitorOnce(options);
  const duplicate = await runTaskboardContinuationMonitorOnce(options);

  assert.deepEqual(first, { delivered: true, todoId: todo.id, actionId: "safe-first" });
  assert.deepEqual(duplicate, { delivered: false, reason: "already-delivered" });
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0], {
    projectId: "taskboard-core",
    todoId: todo.id,
    taskId: todo.taskId,
    rootThreadId: todo.dispatchTarget.rootThreadId,
    codexHostId: "local",
    rootWorkspacePath: coordinationAuthorization.rootWorkspacePath,
    targetRoot: confirmedIdentity.worktreePath,
    safeActionId: "safe-first",
    expectedResumeToken: "b".repeat(64),
    deliveryReceipt: { id: "receipt", reservationLeaseId: "lease" },
    recoveryLeaseId: "lease",
    observeOnly: false,
    executionIdentity: { ...confirmedIdentity, standingAuthority: false },
  });
});

test("background continuation leaves a remote Todo untouched when this executor owns only local", async () => {
  const mutations = { claim: 0, confirm: 0, deliver: 0, complete: 0 };
  const remoteTodo = {
    id: "TASKBOARD-REMOTE-HOST",
    taskId: "3b47e46d-3b02-4ea5-8134-ae7721d9a99c",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "remote-builder",
      rootWorkspacePath: "/srv/taskboard/root",
      worktreePath: "/srv/taskboard/worktree",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [],
      resumeToken: "9".repeat(64),
    },
  };

  const result = await runTaskboardContinuationMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    hostExecutor: { ownedCodexHostId: "local" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [remoteTodo] }),
    claimReceipt: async () => { mutations.claim += 1; },
    confirmDelivery: async () => { mutations.confirm += 1; },
    deliver: async () => { mutations.deliver += 1; },
    completeDelivery: async () => { mutations.complete += 1; },
  });

  assert.deepEqual(result, { delivered: false, reason: "host-executor-unavailable" });
  assert.deepEqual(mutations, { claim: 0, confirm: 0, deliver: 0, complete: 0 });
});

test("background continuation requires an explicit valid host executor", async () => {
  const mutations = { claim: 0, confirm: 0, deliver: 0, complete: 0 };
  const localTodo = {
    id: "TASKBOARD-EXPLICIT-EXECUTOR",
    taskId: "60694ad4-68e7-47a5-a3fa-91357f59f1a8",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/root",
      worktreePath: "/tmp/taskboard/worktree",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first" }],
      deferredActions: [],
      resumeToken: "6".repeat(64),
    },
  };
  const invalidExecutors = [undefined, null, {}, { ownedCodexHostId: "" }, {
    ownedCodexHostId: "   ",
  }, { ownedCodexHostId: "local\nremote" }];

  for (const hostExecutor of invalidExecutors) {
    const result = await runTaskboardContinuationMonitorOnce({
      policy: { enabled: true, projectId: "taskboard-core" },
      ...(hostExecutor === undefined ? {} : { hostExecutor }),
      readSnapshot: async () => ({ projectId: "taskboard-core", todos: [localTodo] }),
      claimReceipt: async () => {
        mutations.claim += 1;
        return {
          available: true,
          completed: false,
          receipt: { id: "invalid-executor-receipt", reservationLeaseId: "lease" },
        };
      },
      confirmDelivery: async () => {
        mutations.confirm += 1;
        return {
          worktreePath: localTodo.dispatchTarget.worktreePath,
          branch: "codex/local-work",
          repository: null,
        };
      },
      deliver: async () => {
        mutations.deliver += 1;
        return { delivery: "started", turnId: "local-turn" };
      },
      completeDelivery: async () => {
        mutations.complete += 1;
        return { completed: true };
      },
    });
    assert.deepEqual(result, { delivered: false, reason: "host-executor-unavailable" });
  }
  assert.deepEqual(mutations, { claim: 0, confirm: 0, deliver: 0, complete: 0 });
});

test("host executor and dispatch routes share the canonical 256 character boundary", async () => {
  let claims = 0;
  let reads = 0;
  const run = (ownedCodexHostId) => runTaskboardContinuationMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    hostExecutor: { ownedCodexHostId },
    readSnapshot: async () => {
      reads += 1;
      return {
        projectId: "taskboard-core",
        todos: [{
          id: "TASKBOARD-HOST-BOUNDARY",
          taskId: "fbf01545-8a8a-492f-a67b-f90a16bdc493",
          run: null,
          dispatchTarget: {
            rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
            codexHostId: ownedCodexHostId,
            rootWorkspacePath: "/srv/taskboard/root",
            worktreePath: "/srv/taskboard/worktree",
          },
          readyWork: {
            eligible: true,
            safeActions: [{ id: "safe-first" }],
            deferredActions: [],
            resumeToken: "5".repeat(64),
          },
        }],
      };
    },
    claimReceipt: async () => {
      claims += 1;
      return { available: false, completed: true, receipt: { id: "already-delivered" } };
    },
    confirmDelivery: async () => assert.fail("completed work must not confirm"),
    deliver: async () => assert.fail("completed work must not deliver"),
    completeDelivery: async () => assert.fail("completed work must not complete twice"),
  });

  for (const length of [240, 241, 256]) {
    assert.deepEqual(await run("h".repeat(length)), {
      delivered: false,
      reason: "already-delivered",
    }, String(length));
  }
  const readsAfterValid = reads;
  const claimsAfterValid = claims;
  for (const invalidHostId of ["h".repeat(257), "remote\ncontrol"]) {
    assert.deepEqual(await run(invalidHostId), {
      delivered: false,
      reason: "host-executor-unavailable",
    }, JSON.stringify(invalidHostId));
  }
  assert.equal(readsAfterValid, 3);
  assert.equal(claimsAfterValid, 3);
  assert.equal(reads, readsAfterValid);
  assert.equal(claims, claimsAfterValid);
});

test("the exact remote host executor delivers once and replay does not redeliver", async () => {
  const calls = { claim: 0, confirm: 0, deliver: 0, complete: 0 };
  const rpcCalls = [];
  let completed = false;
  const remoteTodo = {
    id: "TASKBOARD-REMOTE-EXECUTOR",
    taskId: "7e42020f-ac38-4839-bc5e-4d3ce5dcb203",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "remote-builder",
      rootWorkspacePath: "/srv/taskboard/root",
      worktreePath: "/srv/taskboard/worktree",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [],
      resumeToken: "8".repeat(64),
    },
  };
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    hostExecutor: { ownedCodexHostId: "remote-builder" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [remoteTodo] }),
    claimReceipt: async () => {
      calls.claim += 1;
      return completed
        ? { available: false, completed: true, receipt: { id: "remote-receipt" } }
        : {
            available: true,
            completed: false,
            receipt: {
              id: "remote-receipt",
              reservationLeaseId: "remote-lease",
              admissionAttemptId: "remote-attempt",
            },
          };
    },
    confirmDelivery: async () => {
      calls.confirm += 1;
      return {
        worktreePath: remoteTodo.dispatchTarget.worktreePath,
        branch: "codex/remote-work",
        repository: null,
      };
    },
    deliver: async (request) => {
      calls.deliver += 1;
      assert.equal(request.codexHostId, "remote-builder");
      const hostAwareRpc = async (codexHostId, method, params) => {
        assert.equal(codexHostId, "remote-builder");
        rpcCalls.push(method);
        if (method === "thread/read") return {
          thread: {
            id: request.rootThreadId,
            cwd: request.rootWorkspacePath,
            turns: [],
          },
        };
        if (method === "thread/resume") return {};
        if (method === "turn/start") {
          assert.equal(params.approvalPolicy, "never");
          return { turn: { id: "remote-turn" } };
        }
        return assert.fail(`unexpected remote RPC ${method}`);
      };
      return deliverCoordination(
        request,
        (method, params) => hostAwareRpc(request.codexHostId, method, params),
      );
    },
    completeDelivery: async () => {
      calls.complete += 1;
      completed = true;
      return { completed: true };
    },
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true,
    todoId: remoteTodo.id,
    actionId: "safe-first",
  });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    reason: "already-delivered",
  });
  assert.deepEqual(calls, { claim: 2, confirm: 1, deliver: 1, complete: 1 });
  assert.deepEqual(rpcCalls, ["thread/read", "thread/resume", "turn/start"]);
});

test("concurrent local and remote executors let only the exact remote host claim", async () => {
  let releaseLocalSnapshot;
  let localSnapshotStarted;
  const localSnapshotGate = new Promise((resolve) => { releaseLocalSnapshot = resolve; });
  const localSnapshotObserved = new Promise((resolve) => { localSnapshotStarted = resolve; });
  let claims = 0;
  const remoteTodo = {
    id: "TASKBOARD-CONCURRENT-REMOTE",
    taskId: "8034b761-b99f-4672-b9fc-6d8171ccf525",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "remote-builder",
      rootWorkspacePath: "/srv/taskboard/root",
      worktreePath: "/srv/taskboard/worktree",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first" }],
      deferredActions: [],
      resumeToken: "7".repeat(64),
    },
  };
  const shared = {
    policy: { enabled: true, projectId: "taskboard-core" },
    claimReceipt: async () => {
      claims += 1;
      return {
        available: true,
        completed: false,
        receipt: { id: "concurrent-receipt", reservationLeaseId: "concurrent-lease" },
      };
    },
    confirmDelivery: async () => ({
      worktreePath: remoteTodo.dispatchTarget.worktreePath,
      branch: "codex/remote-work",
      repository: null,
    }),
    deliver: async () => ({ delivery: "started", turnId: "concurrent-turn" }),
    completeDelivery: async () => ({ completed: true }),
  };

  const localRun = runTaskboardContinuationMonitorOnce({
    ...shared,
    hostExecutor: { ownedCodexHostId: "local" },
    readSnapshot: async () => {
      localSnapshotStarted();
      await localSnapshotGate;
      return { projectId: "taskboard-core", todos: [remoteTodo] };
    },
  });
  await localSnapshotObserved;
  const remoteRun = runTaskboardContinuationMonitorOnce({
    ...shared,
    hostExecutor: { ownedCodexHostId: "remote-builder" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [remoteTodo] }),
  });
  await Promise.resolve();
  releaseLocalSnapshot();

  const [localResult, remoteResult] = await Promise.all([localRun, remoteRun]);
  assert.deepEqual(localResult, { delivered: false, reason: "host-executor-unavailable" });
  assert.deepEqual(remoteResult, {
    delivered: true,
    todoId: remoteTodo.id,
    actionId: "safe-first",
  });
  assert.equal(claims, 1);
});

test("background continuation durably defers explicit model capacity and retries the same route", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const todo = {
    id: "CAP-26",
    taskId: "378b3aed-d664-4417-be3c-903e1227e2bf",
    run: null,
    dispatchTarget: {
      rootThreadId,
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [],
      resumeToken: "b".repeat(64),
    },
  };
  let attempt = 0;
  let observedNow = Date.parse("2026-08-31T00:00:30.000Z");
  const deferred = [];
  const deliveredRoutes = [];
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => observedNow,
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [todo],
      coordination: {
        coordinatorTaskId: "coordinator",
        lease: { id: "global-lease", status: "active" },
      },
      windowSubagentTrees: [{
        rootThreadId,
        observed: true,
        summary: { active: 0 },
        capacityObservation: {
          source: "list_agents",
          observedAt: "2026-08-31T00:00:00.000Z",
        },
      }],
    }),
    claimReceipt: async () => {
      attempt += 1;
      return {
        available: true,
        completed: false,
        receipt: {
          id: `receipt-${attempt}`,
          reservationLeaseId: `lease-${attempt}`,
          admissionAttemptId: `attempt-${attempt}`,
        },
      };
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async (request) => {
      deliveredRoutes.push({
        rootThreadId: request.rootThreadId,
        codexHostId: request.codexHostId,
        targetRoot: request.targetRoot,
      });
      if (attempt === 1) {
        throw new Error("Selected model is at capacity. Please try a different model.");
      }
      return { delivery: "started", turnId: "turn-after-capacity" };
    },
    deferAdmission: async (request) => {
      deferred.push(request);
      todo.admission = {
        receiptId: request.admissionReceiptId,
        attemptId: request.admissionAttemptId,
        state: "deferred",
        rootThreadId,
        resumeToken: todo.readyWork.resumeToken,
        safeActionId: todo.readyWork.safeActions[0].id,
        deferredReason: "model_capacity",
        retryCount: 1,
        retryAfter: "2026-08-31T00:00:45.000Z",
        rootHostId: "local",
        rootWorkspacePath: "/tmp/taskboard/project",
        globalCoordinatorLeaseId: "global-lease",
        globalCoordinatorTaskId: "coordinator",
        globalCoordinatorThreadId: rootThreadId,
        coordinationDomainId: null,
        domainCoordinatorLeaseId: null,
        domainCoordinatorTaskId: null,
        domainCoordinatorThreadId: null,
      };
      return {
        applied: true,
        receipt: {
          id: request.admissionReceiptId,
          admissionAttemptId: request.admissionAttemptId,
          admissionState: "deferred",
          admissionDeferredReason: "model_capacity",
          admissionRetryCount: 1,
          admissionRetryAfter: "2026-08-31T00:00:45.000Z",
        },
      };
    },
    completeDelivery: async () => ({ awaitingAdmission: true }),
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    todoId: todo.id,
    actionId: "safe-first",
    reason: "model-capacity-deferred",
  });
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].admissionReceiptId, "receipt-1");
  assert.equal(deferred[0].admissionAttemptId, "attempt-1");

  observedNow = Date.parse("2026-08-31T00:00:40.000Z");
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    reason: "model-capacity-backoff",
  });
  assert.equal(attempt, 1);

  observedNow = Date.parse("2026-08-31T00:01:01.000Z");
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true,
    todoId: todo.id,
    actionId: "safe-first",
  });
  assert.equal(attempt, 2);
  assert.deepEqual(deliveredRoutes, [deliveredRoutes[0], deliveredRoutes[0]]);
});

test("stale capacity markers neither starve later Todos nor block a fresh frontier", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const makeTodo = (id, token) => ({
    id,
    taskId: `${id.toLowerCase()}-task`,
    run: null,
    dispatchTarget: {
      rootThreadId,
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [],
      resumeToken: token,
    },
  });
  const staleRoute = makeTodo("CAP-26-A", "a".repeat(64));
  staleRoute.admission = {
    receiptId: "stale-receipt",
    attemptId: "stale-attempt",
    state: "deferred",
    rootThreadId,
    resumeToken: staleRoute.readyWork.resumeToken,
    safeActionId: "safe-first",
    deferredReason: "model_capacity",
    retryCount: 1,
    retryAfter: "2026-08-31T00:00:15.000Z",
    rootHostId: "local",
    rootWorkspacePath: "/tmp/taskboard/project",
    globalCoordinatorLeaseId: "old-global-lease",
    globalCoordinatorTaskId: "coordinator",
    globalCoordinatorThreadId: rootThreadId,
    coordinationDomainId: null,
    domainCoordinatorLeaseId: null,
    domainCoordinatorTaskId: null,
    domainCoordinatorThreadId: null,
  };
  const generic = makeTodo("CAP-26-B", "b".repeat(64));
  const claimed = [];
  let todos = [staleRoute, generic];
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true, projectId: "taskboard-core",
      maxActiveAgents: 4, capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T00:00:30.000Z"),
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos,
      coordination: {
        coordinatorTaskId: "coordinator",
        lease: { id: "current-global-lease", status: "active" },
      },
      windowSubagentTrees: [{
        rootThreadId,
        observed: true,
        summary: { active: 0 },
        capacityObservation: {
          source: "list_agents", observedAt: "2026-08-31T00:00:30.000Z",
        },
      }],
    }),
    claimReceipt: async (request) => {
      claimed.push(request.todoId);
      return {
        available: true,
        completed: false,
        receipt: {
          id: `receipt-${request.todoId}`,
          reservationLeaseId: `reservation-${request.todoId}`,
          admissionAttemptId: `attempt-${request.todoId}`,
        },
      };
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => ({ delivery: "started", turnId: "turn-capacity-frontier" }),
    completeDelivery: async () => ({ completed: true }),
  };
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true, todoId: generic.id, actionId: "safe-first",
  });
  assert.deepEqual(claimed, [generic.id]);

  const freshFrontier = makeTodo("CAP-26-C", "c".repeat(64));
  freshFrontier.admission = {
    ...staleRoute.admission,
    globalCoordinatorLeaseId: "current-global-lease",
    resumeToken: "d".repeat(64),
  };
  todos = [freshFrontier];
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true, todoId: freshFrontier.id, actionId: "safe-first",
  });
  assert.deepEqual(claimed, [generic.id, freshFrontier.id]);
});

test("background continuation does not reinterpret unrelated delivery failures as capacity", async () => {
  let deferred = false;
  await assert.rejects(runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "CAP-26",
        taskId: "378b3aed-d664-4417-be3c-903e1227e2bf",
        run: null,
        dispatchTarget: {
          rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first", text: "Run focused tests" }],
          deferredActions: [],
          resumeToken: "b".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => ({
      available: true,
      completed: false,
      receipt: {
        id: "receipt-1",
        reservationLeaseId: "lease-1",
        admissionAttemptId: "attempt-1",
      },
    }),
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => { throw new Error("Codex transport disconnected"); },
    deferAdmission: async () => { deferred = true; },
    completeDelivery: async () => assert.fail("failed delivery cannot complete"),
  }), /Codex transport disconnected/);
  assert.equal(deferred, false);
});

test("background continuation recovers an uncertain deterministic child without capacity admission or respawn", async () => {
  const calls = [];
  const admission = {
    receiptId: "recovery-receipt",
    attemptId: "recovery-attempt",
    state: "prepared",
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    resumeToken: "b".repeat(64),
    safeActionId: "safe-action",
    agentName: "task_admission_1234",
    agentPath: "/root/task_admission_1234",
    writeScope: ["server"],
    deadlineAt: "2026-08-31T00:00:00.000Z",
    uncertainAt: null,
    recoveredAgentThreadId: null,
  };
  const result = await runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 1,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T00:01:00.000Z"),
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "TASKBOARD-23",
        taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
        dispatchTarget: {
          rootThreadId: admission.rootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard",
          worktreePath: "/tmp/taskboard/project",
        },
        admission,
      }],
      windowSubagentTrees: [{
        rootThreadId: admission.rootThreadId,
        observed: true,
        summary: { active: 1 },
        capacityObservation: { source: "list_agents", observedAt: "2026-08-31T00:01:00.000Z" },
      }],
    }),
    claimReceipt: async () => { throw new Error("recovery must not reserve or respawn"); },
    confirmDelivery: async () => { throw new Error("recovery must not redeliver normal coordination"); },
    deliver: async () => { throw new Error("recovery must not redeliver normal coordination"); },
    completeDelivery: async () => { throw new Error("recovery must not complete normal delivery"); },
    markAdmissionUncertain: async () => {
      calls.push("uncertain");
      return { receipt: { admissionState: "admission_uncertain", admissionUncertainAt: "2026-08-31T00:01:00.000Z" } };
    },
    claimAdmissionProbe: async () => {
      calls.push("probe-claim");
      return { receipt: { admissionProbeId: "probe-1", admissionProbeRequestedAt: "2026-08-31T00:01:00.000Z" } };
    },
    deliverAdmissionRecovery: async (request) => {
      calls.push(request.mode);
      if (request.mode === "claim") {
        assert.equal(request.expectedResumeToken, "c".repeat(64));
      }
      return { delivery: "steered", turnId: "turn-recovery" };
    },
    reconcileAdmission: async () => {
      calls.push("reconcile");
      return {
        outcome: "present",
        receipt: {
          admissionState: "recovery_confirmed",
          resumeToken: "c".repeat(64),
          admissionAgentName: admission.agentName,
          admissionAgentPath: admission.agentPath,
          admissionWriteScope: admission.writeScope,
          admissionRecoveredAgentThreadId: "child-thread",
        },
      };
    },
  });
  assert.deepEqual(calls, ["uncertain", "probe-claim", "probe", "reconcile", "claim"]);
  assert.deepEqual(result, {
    delivered: true,
    todoId: "TASKBOARD-23",
    reason: "admission-recovery-instructed",
  });
});

test("background continuation never reconciles an unconfirmed admission probe delivery", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  for (const [deliveryReason, expectedReason] of [
    ["terminal-retry-backoff", "admission-terminal-retry-backoff"],
    ["delivery-status-unconfirmed", "admission-delivery-status-unconfirmed"],
  ]) {
    let reconciled = false;
    const result = await runTaskboardContinuationMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "taskboard-core" },
      readSnapshot: async () => ({
        projectId: "taskboard-core",
        todos: [{
          id: "CAP-51",
          taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
          dispatchTarget: {
            rootThreadId,
            codexHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
            worktreePath: "/tmp/taskboard/project",
          },
          admission: {
            receiptId: "recovery-receipt",
            attemptId: "recovery-attempt",
            state: "admission_uncertain",
            rootThreadId,
            resumeToken: "b".repeat(64),
            safeActionId: "safe-action",
          },
        }],
      }),
      claimReceipt: async () => assert.fail("deferred recovery must not reserve work"),
      confirmDelivery: async () => assert.fail("deferred recovery must not confirm work"),
      deliver: async () => assert.fail("deferred recovery must not deliver ordinary work"),
      completeDelivery: async () => assert.fail("deferred recovery must not complete work"),
      markAdmissionUncertain: async () => assert.fail("admission is already uncertain"),
      claimAdmissionProbe: async () => ({
        receipt: {
          admissionProbeId: "probe-cap51",
          admissionProbeRequestedAt: "2026-09-06T05:37:23Z",
        },
      }),
      deliverAdmissionRecovery: async () => ({ delivery: "deferred", reason: deliveryReason }),
      reconcileAdmission: async () => {
        reconciled = true;
        return { outcome: "absent" };
      },
    });
    assert.equal(reconciled, false, deliveryReason);
    assert.deepEqual(result, {
      delivered: false,
      todoId: "CAP-51",
      reason: expectedReason,
    }, deliveryReason);
  }
});

test("background continuation retires an absent child only through the original coordinator Root", async () => {
  const calls = [];
  let reconcileCount = 0;
  const oldRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const replacementRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  const admission = {
    receiptId: "replacement-receipt",
    attemptId: "replacement-attempt",
    state: "admission_uncertain",
    rootThreadId: oldRootThreadId,
    rootHostId: "local",
    rootWorkspacePath: "/tmp/taskboard",
    resumeToken: "d".repeat(64),
    safeActionId: "safe-action",
    coordinationDomainId: "frontend",
    domainCoordinatorLeaseId: "old-lease",
    domainCoordinatorTaskId: "frontend-coordinator",
    domainCoordinatorThreadId: oldRootThreadId,
    agentPath: "/root/task_admission_1234",
  };
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "CAP-44",
        taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
        dispatchTarget: {
          rootThreadId: replacementRootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard",
          worktreePath: "/tmp/taskboard/project",
        },
        domainAssignment: {
          status: "active",
          domainId: "frontend",
          leaseId: "replacement-lease",
          coordinatorTaskId: "frontend-coordinator",
        },
        admission,
      }],
    }),
    claimReceipt: async () => assert.fail("replacement retirement must not reserve work in the same tick"),
    confirmDelivery: async () => assert.fail("replacement retirement must not confirm ordinary delivery"),
    deliver: async () => assert.fail("replacement retirement must not dispatch ordinary work"),
    completeDelivery: async () => assert.fail("replacement retirement must not complete ordinary delivery"),
    claimReplacementAdmissionProbe: async (request) => {
      calls.push(["probe-claim", request.rootThreadId]);
      return {
        applied: calls.filter(([name]) => name === "probe-claim").length === 1,
        receipt: {
          admissionProbeId: "replacement-probe",
          admissionProbeRequestedAt: "2026-08-31T00:01:00.000Z",
        },
        observationTarget: {
          rootThreadId: oldRootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard",
        },
      };
    },
    deliverAdmissionRecovery: async (request) => {
      const priorDeliveries = calls.filter(([name]) => name === "probe").length;
      calls.push([request.mode, request.rootThreadId, priorDeliveries === 0 ? "started" : "observed"]);
      assert.equal(request.mode, "probe");
      assert.equal(request.rootThreadId, oldRootThreadId);
      return {
        delivery: priorDeliveries === 0 ? "started" : "observed",
        turnId: "old-root-probe-turn",
      };
    },
    reconcileReplacementAdmission: async (request) => {
      calls.push(["reconcile", request.rootThreadId]);
      reconcileCount += 1;
      return reconcileCount === 1
        ? { outcome: "unresolved", receipt: { admissionState: "admission_uncertain" } }
        : { outcome: "absent", receipt: { admissionState: "deferred" } };
    },
  };
  const first = await runTaskboardContinuationMonitorOnce(options);
  assert.deepEqual(first, {
    delivered: false,
    todoId: "CAP-44",
    reason: "replacement-admission-unresolved",
  });
  const result = await runTaskboardContinuationMonitorOnce(options);
  assert.deepEqual(calls, [
    ["probe-claim", replacementRootThreadId],
    ["probe", oldRootThreadId, "started"],
    ["reconcile", replacementRootThreadId],
    ["probe-claim", replacementRootThreadId],
    ["probe", oldRootThreadId, "observed"],
    ["reconcile", replacementRootThreadId],
  ]);
  assert.deepEqual(result, {
    delivered: false,
    todoId: "CAP-44",
    reason: "replacement-admission-deferred",
  });
});

test("background continuation recovers a Global admission after exact domain assignment and delivers once", async () => {
  const globalRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const domainRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  const taskId = "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e";
  const globalToken = "d".repeat(64);
  const domainToken = "e".repeat(64);
  let stage = "global-admission";
  let deliveries = 0;
  const todo = () => ({
    id: "CAP-44",
    taskId,
    run: null,
    dispatchTarget: {
      rootThreadId: domainRootThreadId,
      codexHostId: "local",
      rootWorkspacePath: "/tmp/domain-root",
      worktreePath: "/tmp/taskboard/project",
    },
    domainAssignment: {
      status: "active",
      domainId: "frontend",
      leaseId: "frontend-lease",
      coordinatorTaskId: "frontend-coordinator",
      assignedByLeaseId: "global-lease",
      assignedByTaskId: "global-coordinator",
      assignedByThreadId: globalRootThreadId,
    },
    ...(stage === "global-admission" ? {
      admission: {
        receiptId: "global-receipt",
        attemptId: "global-attempt",
        state: "awaiting_admission",
        deadlineAt: "2026-08-31T00:01:00.000Z",
        rootThreadId: globalRootThreadId,
        rootHostId: "local",
        rootWorkspacePath: "/tmp/global-root",
        resumeToken: globalToken,
        safeActionId: "safe-action",
        globalCoordinatorLeaseId: "global-lease",
        globalCoordinatorTaskId: "global-coordinator",
        globalCoordinatorThreadId: globalRootThreadId,
        coordinationDomainId: null,
        domainCoordinatorLeaseId: null,
        domainCoordinatorTaskId: null,
        domainCoordinatorThreadId: null,
        agentPath: "/root/task_admission_1234",
      },
    } : stage === "ready" ? {
      admission: null,
      readyWork: {
        eligible: true,
        safeActions: [{ id: "safe-action", text: "Run exact work" }],
        resumeToken: domainToken,
      },
    } : {
      admission: {
        receiptId: "domain-receipt",
        attemptId: "domain-attempt",
        state: "awaiting_admission",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        rootThreadId: domainRootThreadId,
        rootHostId: "local",
        rootWorkspacePath: "/tmp/domain-root",
        resumeToken: domainToken,
        safeActionId: "safe-action",
        coordinationDomainId: "frontend",
        domainCoordinatorLeaseId: "frontend-lease",
        domainCoordinatorTaskId: "frontend-coordinator",
        domainCoordinatorThreadId: domainRootThreadId,
      },
    }),
  });
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    now: () => Date.parse("2026-08-31T00:02:00.000Z"),
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [todo()] }),
    claimReplacementAdmissionProbe: async (request) => {
      assert.equal(request.rootThreadId, domainRootThreadId);
      assert.equal(request.expectedResumeToken, globalToken);
      return {
        receipt: {
          admissionProbeId: "global-domain-probe",
          admissionProbeRequestedAt: "2026-08-31T00:02:00.000Z",
        },
        observationTarget: {
          rootThreadId: globalRootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/global-root",
        },
      };
    },
    deliverAdmissionRecovery: async (request) => {
      assert.equal(request.mode, "probe");
      assert.equal(request.rootThreadId, globalRootThreadId);
      return { delivery: "observed", turnId: "global-probe-turn" };
    },
    reconcileReplacementAdmission: async (request) => {
      assert.equal(request.rootThreadId, domainRootThreadId);
      stage = "ready";
      return { outcome: "absent", receipt: { admissionState: "deferred" } };
    },
    claimReceipt: async (request) => {
      assert.equal(stage, "ready");
      assert.equal(request.rootThreadId, domainRootThreadId);
      assert.equal(request.expectedResumeToken, domainToken);
      return {
        reused: false,
        available: true,
        completed: false,
        receipt: {
          id: "domain-receipt",
          taskId,
          safeActionId: "safe-action",
          admissionAttemptId: "domain-attempt",
          rootThreadId: domainRootThreadId,
          resumeToken: domainToken,
          reservationLeaseId: "domain-reservation",
        },
      };
    },
    confirmDelivery: async () => ({
      worktreePath: "/tmp/taskboard/project",
      branch: "codex/global-domain-recovery",
    }),
    deliver: async (request) => {
      deliveries += 1;
      assert.equal(request.rootThreadId, domainRootThreadId);
      stage = "current-admission";
      return { delivery: "started", turnId: "domain-delivery-turn" };
    },
    completeDelivery: async () => ({ completed: false, awaitingAdmission: true }),
  };

  const retired = await runTaskboardContinuationMonitorOnce(options);
  assert.deepEqual(retired, {
    delivered: false,
    todoId: "CAP-44",
    reason: "replacement-admission-deferred",
  });
  const delivered = await runTaskboardContinuationMonitorOnce(options);
  assert.deepEqual(delivered, { delivered: true, todoId: "CAP-44", actionId: "safe-action" });
  const replay = await runTaskboardContinuationMonitorOnce(options);
  assert.deepEqual(replay, { delivered: false, reason: "awaiting-admission" });
  assert.equal(deliveries, 1);
});

test("background continuation rejects Global-to-domain recovery without exact assignment provenance", async () => {
  const globalRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const domainRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  for (const [field, value] of [
    ["assignedByLeaseId", "unrelated-global-lease"],
    ["assignedByTaskId", "unrelated-global-task"],
    ["assignedByThreadId", "01a004bd-a749-7b53-81e2-af2d477f93aa"],
  ]) {
    let probed = false;
    const result = await runTaskboardContinuationMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "taskboard-core" },
      now: () => Date.parse("2026-08-31T00:02:00.000Z"),
      readSnapshot: async () => ({
        projectId: "taskboard-core",
        todos: [{
          id: "CAP-44",
          taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
          dispatchTarget: {
            rootThreadId: domainRootThreadId,
            codexHostId: "local",
            rootWorkspacePath: "/tmp/domain-root",
            worktreePath: "/tmp/taskboard/project",
          },
          domainAssignment: {
            status: "active", domainId: "frontend", leaseId: "frontend-lease",
            coordinatorTaskId: "frontend-coordinator",
            assignedByLeaseId: "global-lease",
            assignedByTaskId: "global-coordinator",
            assignedByThreadId: globalRootThreadId,
            [field]: value,
          },
          admission: {
            receiptId: "global-receipt", attemptId: "global-attempt",
            state: "awaiting_admission", deadlineAt: "2026-08-31T00:01:00.000Z",
            rootThreadId: globalRootThreadId, rootHostId: "local",
            rootWorkspacePath: "/tmp/global-root", resumeToken: "d".repeat(64),
            safeActionId: "safe-action", globalCoordinatorLeaseId: "global-lease",
            globalCoordinatorTaskId: "global-coordinator",
            globalCoordinatorThreadId: globalRootThreadId,
            coordinationDomainId: null, domainCoordinatorLeaseId: null,
            domainCoordinatorTaskId: null, domainCoordinatorThreadId: null,
          },
        }],
      }),
      claimReceipt: async () => assert.fail("stale provenance must not reserve ordinary work"),
      confirmDelivery: async () => assert.fail("stale provenance must not confirm work"),
      deliver: async () => assert.fail("stale provenance must not deliver work"),
      completeDelivery: async () => assert.fail("stale provenance must not complete work"),
      claimReplacementAdmissionProbe: async () => { probed = true; },
      reconcileReplacementAdmission: async () => assert.fail("stale provenance must not reconcile"),
      deliverAdmissionRecovery: async () => assert.fail("stale provenance must not probe the old Root"),
    });
    assert.deepEqual(result, { delivered: false, reason: "no-eligible-work" }, field);
    assert.equal(probed, false, field);
  }
});

test("replacement recovery never reconciles an unconfirmed admission probe delivery", async () => {
  const oldRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const replacementRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  for (const [deliveryReason, expectedReason] of [
    ["terminal-retry-backoff", "replacement-admission-terminal-retry-backoff"],
    ["delivery-status-unconfirmed", "replacement-admission-delivery-status-unconfirmed"],
  ]) {
    let reconciled = false;
    const result = await runTaskboardContinuationMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "taskboard-core" },
      readSnapshot: async () => ({
        projectId: "taskboard-core",
        todos: [{
          id: "CAP-51",
          taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
          dispatchTarget: {
            rootThreadId: replacementRootThreadId,
            codexHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
            worktreePath: "/tmp/taskboard/project",
          },
          domainAssignment: {
            status: "active",
            domainId: "frontend",
            leaseId: "replacement-lease",
            coordinatorTaskId: "frontend-coordinator",
          },
          admission: {
            receiptId: "replacement-receipt",
            attemptId: "replacement-attempt",
            state: "admission_uncertain",
            rootThreadId: oldRootThreadId,
            rootHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
            resumeToken: "d".repeat(64),
            safeActionId: "safe-action",
            coordinationDomainId: "frontend",
            domainCoordinatorLeaseId: "old-lease",
            domainCoordinatorTaskId: "frontend-coordinator",
            domainCoordinatorThreadId: oldRootThreadId,
            globalCoordinatorLeaseId: null,
            globalCoordinatorTaskId: null,
            globalCoordinatorThreadId: null,
          },
        }],
      }),
      claimReceipt: async () => assert.fail("deferred replacement must not reserve work"),
      confirmDelivery: async () => assert.fail("deferred replacement must not confirm work"),
      deliver: async () => assert.fail("deferred replacement must not deliver ordinary work"),
      completeDelivery: async () => assert.fail("deferred replacement must not complete work"),
      claimReplacementAdmissionProbe: async () => ({
        receipt: {
          admissionProbeId: "replacement-probe",
          admissionProbeRequestedAt: "2026-09-06T05:37:23Z",
        },
        observationTarget: {
          rootThreadId: oldRootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard",
        },
      }),
      deliverAdmissionRecovery: async () => ({ delivery: "deferred", reason: deliveryReason }),
      reconcileReplacementAdmission: async () => {
        reconciled = true;
        return { outcome: "absent" };
      },
    });
    assert.equal(reconciled, false, deliveryReason);
    assert.deepEqual(result, {
      delivered: false,
      todoId: "CAP-51",
      reason: expectedReason,
    }, deliveryReason);
  }
});

test("background continuation recovers expired pending admissions after coordinator replacement", async () => {
  const oldRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const replacementRootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  for (const admissionState of ["awaiting_admission", "prepared"]) {
    const calls = [];
    const result = await runTaskboardContinuationMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: "taskboard-core" },
      now: () => Date.parse("2026-08-31T00:02:00.000Z"),
      readSnapshot: async () => ({
        projectId: "taskboard-core",
        todos: [{
          id: "CAP-44",
          taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
          dispatchTarget: {
            rootThreadId: replacementRootThreadId,
            codexHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
            worktreePath: "/tmp/taskboard/project",
          },
          domainAssignment: {
            status: "active",
            domainId: "frontend",
            leaseId: "replacement-lease",
            coordinatorTaskId: "frontend-coordinator",
          },
          admission: {
            receiptId: "replacement-receipt",
            attemptId: "replacement-attempt",
            state: admissionState,
            deadlineAt: "2026-08-31T00:01:00.000Z",
            rootThreadId: oldRootThreadId,
            rootHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
            resumeToken: "d".repeat(64),
            safeActionId: "safe-action",
            coordinationDomainId: "frontend",
            domainCoordinatorLeaseId: "old-lease",
            domainCoordinatorTaskId: "frontend-coordinator",
            domainCoordinatorThreadId: oldRootThreadId,
            agentPath: "/root/task_admission_1234",
          },
        }],
      }),
      claimReceipt: async () => assert.fail("replacement recovery must precede ordinary delivery"),
      confirmDelivery: async () => assert.fail("replacement recovery must precede ordinary delivery"),
      deliver: async () => assert.fail("replacement recovery must precede ordinary delivery"),
      completeDelivery: async () => assert.fail("replacement recovery must precede ordinary delivery"),
      claimReplacementAdmissionProbe: async (request) => {
        calls.push(["probe-claim", request.rootThreadId]);
        return {
          receipt: {
            admissionProbeId: "replacement-probe",
            admissionProbeRequestedAt: "2026-08-31T00:02:00.000Z",
          },
          observationTarget: {
            rootThreadId: oldRootThreadId,
            codexHostId: "local",
            rootWorkspacePath: "/tmp/taskboard",
          },
        };
      },
      deliverAdmissionRecovery: async (request) => {
        calls.push([request.mode, request.rootThreadId]);
        return { delivery: "started", turnId: "old-root-probe-turn" };
      },
      reconcileReplacementAdmission: async (request) => {
        calls.push(["reconcile", request.rootThreadId]);
        return { outcome: "absent", receipt: { admissionState: "deferred" } };
      },
    });
    assert.deepEqual(calls, [
      ["probe-claim", replacementRootThreadId],
      ["probe", oldRootThreadId],
      ["reconcile", replacementRootThreadId],
    ], admissionState);
    assert.deepEqual(result, {
      delivered: false,
      todoId: "CAP-44",
      reason: "replacement-admission-deferred",
    }, admissionState);
  }
});

test("background continuation waits for observed Root capacity and backfills after a slot opens", async () => {
  const calls = { claim: 0, deliver: 0, complete: 0 };
  let active = 3;
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const todo = {
    id: "CAP-21",
    taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
    run: null,
    dispatchTarget: {
      rootThreadId,
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [],
      resumeToken: "b".repeat(64),
    },
  };
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T02:00:30.000Z"),
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [todo],
      windowSubagentTrees: [{
        rootThreadId,
        observed: true,
        summary: { active },
        capacityObservation: {
          source: "list_agents",
          observedAt: "2026-08-31T02:00:00.000Z",
        },
      }, {
        rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
        observed: true,
        summary: { active: 3 },
        capacityObservation: {
          source: "list_agents",
          observedAt: "2026-08-31T02:00:00.000Z",
        },
      }],
    }),
    requestCapacityObservation: async () => assert.fail("fresh full capacity must not request another observation"),
    claimReceipt: async () => {
      calls.claim += 1;
      return {
        available: true,
        completed: false,
        receipt: { id: "receipt", reservationLeaseId: "lease" },
      };
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => {
      calls.deliver += 1;
      return { delivery: "started", turnId: "turn-background" };
    },
    completeDelivery: async () => {
      calls.complete += 1;
      return { completed: true };
    },
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    reason: "waiting-capacity",
  });
  assert.deepEqual(calls, { claim: 0, deliver: 0, complete: 0 });

  active = 2;
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true,
    todoId: todo.id,
    actionId: "safe-first",
  });
  assert.deepEqual(calls, { claim: 1, deliver: 1, complete: 1 });
});

test("background continuation fails closed when target Root capacity is not freshly observed", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const base = {
    projectId: "taskboard-core",
    todos: [{
      id: "CAP-21",
      taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
      run: null,
      dispatchTarget: {
        rootThreadId,
        codexHostId: "local",
        rootWorkspacePath: "/tmp/taskboard/project",
        worktreePath: "/tmp/taskboard/project",
      },
      readyWork: {
        eligible: true,
        safeActions: [{ id: "safe-first", text: "Run focused tests" }],
        deferredActions: [],
        resumeToken: "b".repeat(64),
      },
    }],
  };
  const run = (windowSubagentTrees) => runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T02:02:00.000Z"),
    readSnapshot: async () => ({ ...base, windowSubagentTrees }),
    claimReceipt: async () => assert.fail("capacity gate must run before bootstrap claim"),
    confirmDelivery: async () => assert.fail("capacity gate must run before confirmation"),
    deliver: async () => assert.fail("capacity gate must run before delivery"),
    completeDelivery: async () => assert.fail("capacity gate must run before completion"),
  });

  assert.deepEqual(await run([]), { delivered: false, reason: "capacity-unobserved" });
  assert.deepEqual(await run([{
    rootThreadId,
    observed: true,
    summary: { active: 0 },
    capacityObservation: {
      source: "list_agents",
      observedAt: "2026-08-31T02:00:00.000Z",
    },
  }]), { delivered: false, reason: "capacity-observation-stale" });
});

test("background continuation bootstraps an idle Root capacity observation before first delivery", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const calls = [];
  const result = await runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T02:02:00.000Z"),
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "CAP-45",
        taskId: "41795217-b5ff-4628-927b-864441aa2b09",
        run: null,
        dispatchTarget: {
          rootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first", text: "Run focused tests" }],
          deferredActions: [],
          resumeToken: "b".repeat(64),
        },
      }],
      windowSubagentTrees: [],
    }),
    requestCapacityObservation: async (request) => {
      calls.push(request);
      return { delivery: "started", turnId: "turn-capacity-probe" };
    },
    claimReceipt: async () => assert.fail("capacity observation must precede bootstrap claim"),
    confirmDelivery: async () => assert.fail("capacity observation must precede confirmation"),
    deliver: async () => assert.fail("capacity observation must precede delivery"),
    completeDelivery: async () => assert.fail("capacity observation must precede completion"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, "taskboard-core");
  assert.equal(calls[0].todoId, "CAP-45");
  assert.equal(calls[0].rootThreadId, rootThreadId);
  assert.equal(calls[0].reason, "capacity-unobserved");
  assert.deepEqual(result, {
    delivered: false,
    todoId: "CAP-45",
    reason: "capacity-observation-instructed",
  });
});

test("stale capacity probes are idempotent within one retry epoch and rotate afterward", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  let observedNow = Date.parse("2026-08-31T02:02:00.000Z");
  const probeIds = [];
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => observedNow,
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "CAP-45",
        taskId: "41795217-b5ff-4628-927b-864441aa2b09",
        run: null,
        dispatchTarget: {
          rootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first", text: "Run focused tests" }],
          deferredActions: [],
          resumeToken: "b".repeat(64),
        },
      }],
      windowSubagentTrees: [{
        rootThreadId,
        observed: true,
        summary: { active: 0 },
        capacityObservation: {
          source: "list_agents",
          observedAt: "2026-08-31T02:00:00.000Z",
        },
      }],
    }),
    requestCapacityObservation: async (request) => {
      probeIds.push(request.probeId);
      assert.equal(request.reason, "capacity-observation-stale");
      return { delivery: "observed", turnId: "turn-capacity-probe" };
    },
    claimReceipt: async () => assert.fail("stale capacity must not claim"),
    confirmDelivery: async () => assert.fail("stale capacity must not confirm"),
    deliver: async () => assert.fail("stale capacity must not deliver"),
    completeDelivery: async () => assert.fail("stale capacity must not complete"),
  };

  await runTaskboardContinuationMonitorOnce(options);
  await runTaskboardContinuationMonitorOnce(options);
  assert.equal(probeIds[0], probeIds[1]);
  observedNow += 60_000;
  await runTaskboardContinuationMonitorOnce(options);
  assert.notEqual(probeIds[1], probeIds[2]);
});

test("capacity observation delivery starts one idle Root turn and replays its durable marker", async () => {
  const request = {
    projectId: "taskboard-core",
    todoId: "CAP-45",
    taskId: "41795217-b5ff-4628-927b-864441aa2b09",
    rootThreadId: coordinatorThreadId,
    codexHostId: "local",
    rootWorkspacePath: "/tmp/taskboard/project",
    reason: "capacity-unobserved",
    observationId: "unobserved",
    probeId: "c".repeat(64),
  };
  const calls = [];
  let turns = [];
  let instruction = null;
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") return {
      thread: {
        id: request.rootThreadId,
        cwd: request.rootWorkspacePath,
        turns,
      },
    };
    if (method === "thread/resume") return {};
    if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      instruction = params.input[0].text;
      return { turn: { id: "turn-capacity-observation" } };
    }
    return assert.fail(`unexpected RPC ${method}`);
  };

  assert.deepEqual(await deliverTaskboardCapacityObservation(request, rpc), {
    delivery: "started",
    turnId: "turn-capacity-observation",
  });
  assert.match(instruction, new RegExp(request.probeId));
  assert.match(instruction, /collaboration\.list_agents exactly once/);
  assert.match(instruction, /Do not spawn, claim, defer, edit, test, or mutate Taskboard/);
  assert.doesNotMatch(instruction, /spawn_agent|issue claim|admission-defer/);
  turns = [{
    id: "turn-capacity-observation",
    status: "completed",
    items: [{ text: instruction }],
  }];
  const callCountAfterStart = calls.length;
  assert.deepEqual(await deliverTaskboardCapacityObservation(request, rpc), {
    delivery: "observed",
    turnId: "turn-capacity-observation",
  });
  assert.deepEqual(calls.slice(callCountAfterStart).map(([method]) => method), ["thread/read"]);
  assert.deepEqual(calls.slice(0, callCountAfterStart).map(([method]) => method), [
    "thread/read",
    "thread/resume",
    "turn/start",
  ]);
});

test("capacity observation delivery never steers a busy Root and rejects workspace drift", async () => {
  const request = {
    projectId: "taskboard-core",
    todoId: "CAP-45",
    taskId: "41795217-b5ff-4628-927b-864441aa2b09",
    rootThreadId: coordinatorThreadId,
    codexHostId: "local",
    rootWorkspacePath: "/tmp/taskboard/project",
    reason: "capacity-observation-stale",
    observationId: "2026-08-31T02:00:00.000Z",
    probeId: "d".repeat(64),
  };
  const methods = [];
  const busy = await deliverTaskboardCapacityObservation(request, async (method) => {
    methods.push(method);
    if (method === "thread/read") return {
      thread: {
        id: request.rootThreadId,
        cwd: request.rootWorkspacePath,
        turns: [{ id: "turn-busy", status: "inProgress" }],
      },
    };
    return assert.fail(`busy Root must not receive ${method}`);
  });
  assert.deepEqual(busy, { delivery: "busy", turnId: "turn-busy" });
  assert.deepEqual(methods, ["thread/read"]);

  await assert.rejects(
    deliverTaskboardCapacityObservation(request, async () => ({
      thread: { id: request.rootThreadId, cwd: "/tmp/taskboard/other", turns: [] },
    })),
    /cwd does not match/,
  );
});

test("fresh capacity after the bootstrap probe delivers exactly one Todo", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const observedAt = "2026-08-31T02:02:00.000Z";
  let observed = false;
  const calls = { probe: 0, claim: 0, deliver: 0, complete: 0 };
  const todo = {
    id: "CAP-40",
    taskId: "494c4548-4491-4775-9ee0-865ef163b4dc",
    run: null,
    dispatchTarget: {
      rootThreadId,
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Create proof" }],
      deferredActions: [],
      resumeToken: "b".repeat(64),
    },
  };
  const options = {
    hostExecutor: localHostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-31T02:02:15.000Z"),
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [todo],
      windowSubagentTrees: observed ? [{
        rootThreadId,
        observed: true,
        summary: { active: 0 },
        capacityObservation: { source: "list_agents", observedAt },
      }] : [],
    }),
    requestCapacityObservation: async () => {
      calls.probe += 1;
      observed = true;
      return { delivery: "started", turnId: "turn-capacity-probe" };
    },
    claimReceipt: async () => {
      calls.claim += 1;
      return {
        available: true,
        completed: false,
        receipt: { id: "receipt", reservationLeaseId: "lease" },
      };
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => {
      calls.deliver += 1;
      return { delivery: "started", turnId: "turn-background" };
    },
    completeDelivery: async () => {
      calls.complete += 1;
      return { completed: true };
    },
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    todoId: "CAP-40",
    reason: "capacity-observation-instructed",
  });
  assert.deepEqual(calls, { probe: 1, claim: 0, deliver: 0, complete: 0 });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true,
    todoId: "CAP-40",
    actionId: "safe-first",
  });
  assert.deepEqual(calls, { probe: 1, claim: 1, deliver: 1, complete: 1 });
});

test("one project Owner decision is delivered only to its exact confirmed Root window", async () => {
  const request = {
    requestId: "d".repeat(64),
    expectedResumeToken: "e".repeat(64),
    identifier: "CAP-10",
    actionId: "push",
    message: "同意 ordinary push exact commit",
    coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root",
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project",
      codexProjectKind: "local",
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const calls = [];
  const deliver = (current) => deliverTaskboardOwnerDecision(current, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns: [{ id: "turn-active", status: "inProgress" }] } };
    }
    if (method === "turn/steer") return {};
    throw new Error(`Unexpected method: ${method}`);
  });
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ownerDecisionMonitorSnapshot(request),
    claimDelivery: async () => ({
      claimed: true,
      receipt: { id: "delivery-1" },
    }),
    confirmDelivery: async () => ({ confirmed: true }),
    deliver,
    observeDecision: async () => null,
    recordDecision: async () => assert.fail("no Owner decision was observed"),
  };

  assert.deepEqual(await runOwnerDecisionMonitorOnce(options), {
    delivered: true,
    requestId: request.requestId,
    delivery: "steered",
    awaitingOwner: true,
  });
  assert.equal(calls[0][0], "thread/read");
  assert.equal(calls[1][0], "turn/steer");
  assert.match(calls[1][1].input[0].text, /Ask the Owner exactly this one question in this Root window/);
  assert.match(calls[1][1].input[0].text, /Do not approve it yourself/);
  assert.match(calls[1][1].input[0].text, /delivery-1/);
  assert.doesNotMatch(calls[1][1].input[0].text, /attestation token/i);
});

test("an idle Owner decision delivery cannot request interactive approval", async () => {
  const request = {
    requestId: "f".repeat(64),
    expectedResumeToken: "e".repeat(64),
    identifier: "CAP-10",
    actionId: "push",
    message: "Ask the Owner",
    coordinatorEpoch: "configured:root",
    deliveryReceipt: { id: "delivery-idle" },
    route: {
      rootTaskId: "root",
      rootThreadId: coordinatorThreadId,
      codexProjectId: "taskboard-project",
      codexProjectKind: "local",
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const calls = [];
  const result = await deliverTaskboardOwnerDecision(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") return {
      thread: {
        id: request.route.rootThreadId,
        cwd: request.route.rootWorkspacePath,
        turns: [],
      },
    };
    if (method === "thread/resume") return {};
    if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      return { turn: { id: "owner-decision-turn" } };
    }
    return assert.fail(`unexpected RPC ${method}`);
  });
  assert.deepEqual(result, { delivery: "started", turnId: "owner-decision-turn" });
  assert.deepEqual(calls.map(([method]) => method), [
    "thread/read", "thread/resume", "turn/start",
  ]);
});

test("queued Owner Intent never interrupts an active Coordinator turn", async () => {
  const request = {
    intentId: "intent-1",
    goal: "Keep the current work running and revise the next plan",
    constraints: ["Do not widen Git authority"],
    coordinatorEpoch: "lease:coordinator-1",
    route: {
      coordinatorTaskId: "coordinator-1",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
    },
    adoptionReceipt: { id: "adoption-1" },
  };
  const calls = [];
  const result = await deliverTaskboardOwnerIntent(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return {
        thread: {
          id: request.route.coordinatorThreadId,
          cwd: request.route.coordinatorWorkspacePath,
          turns: [{ id: "turn-active", status: "inProgress" }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  assert.deepEqual(result, { delivery: "queued", reason: "coordinator-busy" });
  assert.deepEqual(calls.map(([method]) => method), ["thread/read"]);
});

test("completed Owner Root turn is captured as one stable append intent", async () => {
  const route = {
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexHostId: "local",
    ownerRootWorkspacePath: "/tmp/taskboard/owner-root",
  };
  const observed = await observeTaskboardOwnerIntentCapture(
    { projectId: "taskboard-core", route, capturedOwnerTurnIds: [] },
    async (method, params) => {
      assert.equal(method, "thread/read");
      assert.deepEqual(params, { threadId: route.ownerRootThreadId, includeTurns: true });
      return {
        thread: {
          id: route.ownerRootThreadId,
          cwd: route.ownerRootWorkspacePath,
          turns: [{
            id: "01a05100-1111-7222-8333-444444444444",
            status: "completed",
            input: [{ type: "text", text: "继续把 Taskboard 做到我只需要说目标。" }],
            items: [
              {
                type: "user_message",
                role: "user",
                content: "继续把 Taskboard 做到我只需要说目标。",
              },
              {
                type: "agent_message",
                role: "assistant",
                content: [
                  "可以，我会继续推进并在需要新权限时才找你。",
                  `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
                    kind: "append", targetIntentId: null, constraints: [],
                  })} -->`,
                ].join("\n"),
              },
            ],
          }],
        },
      };
    },
  );
  assert.deepEqual(observed, {
    intentId: "owner-intent-taskboard-core-996ee8e9-01a05100-1111-7222-8333-444444444444",
    deliveryId: "owner-turn-taskboard-core-996ee8e9-01a05100-1111-7222-8333-444444444444",
    kind: "append",
    goal: "继续把 Taskboard 做到我只需要说目标。",
    constraints: [],
    targetIntentId: null,
    ownerRootTaskId: route.ownerRootTaskId,
    ownerRootThreadId: route.ownerRootThreadId,
    ownerTurnId: "01a05100-1111-7222-8333-444444444444",
    rootCaptureTurnId: "01a05100-1111-7222-8333-444444444444",
    evidence: "Protected host observed one completed Owner Root turn.",
  });
});

test("Owner Intent capture ids are scoped to the Taskboard project", async () => {
  const route = {
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexHostId: "local",
    ownerRootWorkspacePath: "/tmp/taskboard/owner-root",
  };
  const ownerTurnId = "01a05100-1111-7222-8333-444444444444";
  const rpc = async () => ({
    thread: {
      id: route.ownerRootThreadId,
      cwd: route.ownerRootWorkspacePath,
      turns: [{
        id: ownerTurnId,
        status: "completed",
        input: [{ type: "text", text: "Continue this project." }],
        items: [
          { type: "user_message", role: "user", content: "Continue this project." },
          {
            type: "agent_message",
            role: "assistant",
            content: `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
              kind: "append", targetIntentId: null, constraints: [],
            })} -->`,
          },
        ],
      }],
    },
  });
  const first = await observeTaskboardOwnerIntentCapture({
    projectId: "project-a", route, capturedOwnerTurnIds: [],
  }, rpc);
  const second = await observeTaskboardOwnerIntentCapture({
    projectId: "project-b", route, capturedOwnerTurnIds: [],
  }, rpc);
  assert.notEqual(first.intentId, second.intentId);
  assert.notEqual(first.deliveryId, second.deliveryId);
  assert.match(first.intentId, /^owner-intent-project-a-/);
  assert.match(second.intentId, /^owner-intent-project-b-/);
});

test("Owner Root assistant route markers carry clarify, supersede, and cancel through the host monitor", async () => {
  const producerSkill = await readFile(new URL("../skills/manage-taskboard/SKILL.md", import.meta.url), "utf8");
  assert.match(producerSkill, /Do not ask the Owner for an intent id or protocol syntax/);
  assert.match(producerSkill, /exactly one invisible HTML comment and no content after it/);
  const ownerRootThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const ownerRootWorkspacePath = "/tmp/taskboard/owner-root";
  for (const [index, kind] of ["clarify", "supersede", "cancel"].entries()) {
    const ownerTurnId = `01a05100-1111-7222-8333-${String(index + 201).padStart(12, "0")}`;
    const targetIntentId = "intent-target";
    const snapshot = {
      projectId: `typed-intent-${kind}`,
      coordination: { ownerRootTaskId: "owner-root" },
      taskLanes: [{
        id: "owner-root", taskType: "root_task", threadId: ownerRootThreadId,
        codexHostId: "local", workspacePath: ownerRootWorkspacePath,
      }],
    };
    let recorded = null;
    const result = await runOwnerIntentCaptureMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId: snapshot.projectId },
      readSnapshot: async () => snapshot,
      listIntents: async () => [{ intentId: targetIntentId, ownerTurnId: "prior-owner-turn" }],
      observeCapture: (request) => observeTaskboardOwnerIntentCapture(request, async () => ({
        thread: {
          id: ownerRootThreadId,
          cwd: ownerRootWorkspacePath,
          turns: [{
            id: ownerTurnId,
            status: "completed",
            input: [{
              type: "text",
              text: kind === "cancel"
                ? "Please cancel the previous goal and stop its queued work."
                : kind === "supersede"
                  ? "Replace the previous goal with this revised outcome."
                  : "Clarify the previous goal with this additional constraint.",
            }],
            items: [{
              type: "agent_message",
              role: "assistant",
              content: [
                "I will route this exact change.",
                `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
                  kind, targetIntentId, constraints: ["Preserve unrelated active work"],
                })} -->`,
              ].join("\n"),
            }],
          }],
        },
      })),
      recordCapture: async (capture) => {
        recorded = capture;
        return { applied: true, intent: capture };
      },
    });
    assert.deepEqual(result, {
      captured: true,
      intentId: recorded.intentId,
      ownerTurnId,
    });
    assert.equal(recorded.kind, kind);
    assert.equal(recorded.targetIntentId, targetIntentId);
    assert.deepEqual(recorded.constraints, ["Preserve unrelated active work"]);
    assert.equal(
      recorded.evidence,
      "Protected host observed one completed Owner Root turn with an exact assistant route marker.",
    );
  }
});

test("malformed or ambiguous Owner Intent route markers fail closed", async () => {
  const route = {
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexHostId: "local",
    ownerRootWorkspacePath: "/tmp/taskboard/owner-root",
  };
  for (const [index, assistantContent] of [
    "Normal acknowledgement without a required final marker.",
    "TASKBOARD_OWNER_INTENT_ROUTE_V1 not-json",
    `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({ kind: "append", constraints: [] })} -->`,
    `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({ kind: "append", targetIntentId: null })} -->`,
    `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
      kind: "append", targetIntentId: null, constraints: null,
    })} -->`,
    `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({ kind: "cancel", targetIntentId: null })} -->`,
    `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
      kind: "append", targetIntentId: null, constraints: [],
    })} -->\nMore assistant content after the marker.`,
    [
      `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({ kind: "cancel", targetIntentId: "intent-a" })} -->`,
      `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({ kind: "cancel", targetIntentId: "intent-b" })} -->`,
    ].join("\n"),
  ].entries()) {
    const observed = await observeTaskboardOwnerIntentCapture(
      { projectId: "taskboard-core", route, capturedOwnerTurnIds: [] },
      async () => ({
        thread: {
          id: route.ownerRootThreadId,
          cwd: route.ownerRootWorkspacePath,
          turns: [{
            id: `01a05100-1111-7222-8333-${String(index + 301).padStart(12, "0")}`,
            status: "completed",
            input: [{ type: "text", text: "Change the current goal." }],
            items: [{ type: "agent_message", role: "assistant", content: assistantContent }],
          }],
        },
      }),
    );
    assert.equal(observed, null);
  }
});

test("an exact typed route to an unknown intent never reaches the protected recorder", async () => {
  const ownerRootThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const ownerRootWorkspacePath = "/tmp/taskboard/owner-root";
  let recordCalls = 0;
  const result = await runOwnerIntentCaptureMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "typed-intent-unknown-target" },
    readSnapshot: async () => ({
      projectId: "typed-intent-unknown-target",
      coordination: { ownerRootTaskId: "owner-root" },
      taskLanes: [{
        id: "owner-root", taskType: "root_task", threadId: ownerRootThreadId,
        codexHostId: "local", workspacePath: ownerRootWorkspacePath,
      }],
    }),
    listIntents: async () => [{ intentId: "known-intent", ownerTurnId: "prior-owner-turn" }],
    observeCapture: (request) => observeTaskboardOwnerIntentCapture(request, async () => ({
      thread: {
        id: ownerRootThreadId,
        cwd: ownerRootWorkspacePath,
        turns: [{
          id: "01a05100-1111-7222-8333-000000000401",
          status: "completed",
          input: [{ type: "text", text: "Cancel the intended work." }],
          items: [{
            type: "agent_message",
            role: "assistant",
            content: `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
              kind: "cancel", targetIntentId: "unknown-intent", constraints: [],
            })} -->`,
          }],
        }],
      },
    })),
    recordCapture: async () => {
      recordCalls += 1;
      return { applied: true };
    },
  });
  assert.deepEqual(result, { captured: false, reason: "owner-intent-target-unavailable" });
  assert.equal(recordCalls, 0);
});

test("first activation baselines at the latest safe Owner turn and fails closed on sensitive text", async () => {
  const route = {
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexHostId: "local",
    ownerRootWorkspacePath: "/tmp/taskboard/owner-root",
  };
  const makeTurn = (id, input) => ({
    id,
    status: "completed",
    input: [{ type: "text", text: input }],
    items: [{
      type: "agent_message", role: "assistant",
      content: `收到。\n<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
        kind: "append", targetIntentId: null, constraints: [],
      })} -->`,
    }],
  });
  const rpc = async () => ({
    thread: {
      id: route.ownerRootThreadId,
      cwd: route.ownerRootWorkspacePath,
      turns: [
        makeTurn("01a05100-1111-7222-8333-000000000001", "很早以前的历史目标。"),
        makeTurn("01a05100-1111-7222-8333-000000000002", "现在要继续的目标。"),
      ],
    },
  });
  const latest = await observeTaskboardOwnerIntentCapture(
    { projectId: "taskboard-core", route, capturedOwnerTurnIds: [] },
    rpc,
  );
  assert.equal(latest.ownerTurnId, "01a05100-1111-7222-8333-000000000002");
  assert.equal(latest.goal, "现在要继续的目标。");

  const sensitive = await observeTaskboardOwnerIntentCapture(
    { projectId: "taskboard-core", route, capturedOwnerTurnIds: [] },
    async () => ({
      thread: {
        id: route.ownerRootThreadId,
        cwd: route.ownerRootWorkspacePath,
        turns: [
          makeTurn("01a05100-1111-7222-8333-000000000001", "很早以前的历史目标。"),
          makeTurn("01a05100-1111-7222-8333-000000000003", "password=do-not-store"),
        ],
      },
    }),
  );
  assert.equal(sensitive, null);
});

test("Codex environment, delegation, AGENTS, and control envelopes are never Owner Intents", async () => {
  const route = {
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexHostId: "local",
    ownerRootWorkspacePath: "/tmp/taskboard/owner-root",
  };
  const controlInputs = [
    "<heartbeat><automation_id>taskboard-loop</automation_id><instructions>continue work</instructions></heartbeat>",
    "<environment_context><cwd>/tmp/internal</cwd></environment_context>",
    "<codex_delegation><source_thread_id>internal</source_thread_id></codex_delegation>",
    "# AGENTS.md instructions for /tmp/internal\n<INSTRUCTIONS>internal routing</INSTRUCTIONS>",
    "Message Type: FINAL_ANSWER\nTask name: /root/internal\nPayload: internal control",
    "Message Type: NEW_TASK\nTask name: /root/internal\nSender: /root\nPayload:\ninternal dispatch",
    "taskctl issue bootstrap CAP-16 --json\nTaskboard Owner Intent adoption id: internal",
  ];
  for (const [index, input] of controlInputs.entries()) {
    const observed = await observeTaskboardOwnerIntentCapture(
      { projectId: "taskboard-core", route, capturedOwnerTurnIds: [] },
      async () => ({
        thread: {
          id: route.ownerRootThreadId,
          cwd: route.ownerRootWorkspacePath,
          turns: [{
            id: `01a05100-1111-7222-8333-${String(index + 10).padStart(12, "0")}`,
            status: "completed",
            input: [{ type: "text", text: input }],
            items: [
              { type: "user_message", role: "user", content: input },
              { type: "agent_message", role: "assistant", content: "Internal response" },
            ],
          }],
        },
      }),
    );
    assert.equal(observed, null, input);
  }

  const adjacent = await observeTaskboardOwnerIntentCapture(
    { projectId: "taskboard-core", route, capturedOwnerTurnIds: ["01a05100-1111-7222-8333-000000000101"] },
    async () => ({
      thread: {
        id: route.ownerRootThreadId,
        cwd: route.ownerRootWorkspacePath,
        turns: [
          {
            id: "01a05100-1111-7222-8333-000000000101", status: "completed",
            input: [{ type: "text", text: "已捕获目标" }],
            items: [{ type: "agent_message", role: "assistant", content: "ok" }],
          },
          {
            id: "01a05100-1111-7222-8333-000000000102", status: "completed",
            input: [{ type: "text", text: "<heartbeat><automation_id>x</automation_id></heartbeat>" }],
            items: [{ type: "agent_message", role: "assistant", content: "internal" }],
          },
          {
            id: "01a05100-1111-7222-8333-000000000103", status: "completed",
            input: [{ type: "text", text: "请继续完成真实目标" }],
            items: [{
              type: "agent_message", role: "assistant",
              content: `ok\n<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
                kind: "append", targetIntentId: null, constraints: [],
              })} -->`,
            }],
          },
        ],
      },
    }),
  );
  assert.equal(adjacent.ownerTurnId, "01a05100-1111-7222-8333-000000000103");
  assert.equal(adjacent.goal, "请继续完成真实目标");

  let recordCalls = 0;
  const frontier = [];
  const newTaskInput = controlInputs.at(-2);
  const monitorResult = await runOwnerIntentCaptureMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "control-envelope-project" },
    readSnapshot: async () => ({
      projectId: "control-envelope-project",
      coordination: { ownerRootTaskId: route.ownerRootTaskId },
      taskLanes: [{
        id: route.ownerRootTaskId,
        taskType: "root_task",
        threadId: route.ownerRootThreadId,
        codexHostId: route.codexHostId,
        workspacePath: route.ownerRootWorkspacePath,
      }],
    }),
    listIntents: async () => frontier,
    observeCapture: (request) => observeTaskboardOwnerIntentCapture(request, async () => ({
      thread: {
        id: route.ownerRootThreadId,
        cwd: route.ownerRootWorkspacePath,
        turns: [{
          id: "01a05100-1111-7222-8333-000000000099",
          status: "completed",
          input: [{ type: "text", text: newTaskInput }],
          items: [
            { type: "user_message", role: "user", content: newTaskInput },
            { type: "agent_message", role: "assistant", content: "Internal response" },
          ],
        }],
      },
    })),
    recordCapture: async () => {
      recordCalls += 1;
      return { applied: true };
    },
  });
  assert.deepEqual(monitorResult, { captured: false, reason: "no-owner-turn" });
  assert.equal(recordCalls, 0);
  assert.deepEqual(frontier, []);
});

test("Owner Intent capture skips Taskboard decision turns and replays exactly once", async () => {
  const ownerRootThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const ownerRootWorkspacePath = "/tmp/taskboard/owner-root";
  const ownerTurnId = "01a05100-1111-7222-8333-555555555555";
  const snapshot = {
    projectId: "taskboard-core",
    coordination: { ownerRootTaskId: "owner-root" },
    taskLanes: [{
      id: "owner-root",
      taskType: "root_task",
      threadId: ownerRootThreadId,
      codexHostId: "local",
      workspacePath: ownerRootWorkspacePath,
    }],
  };
  let recorded = [];
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => snapshot,
    listIntents: async () => recorded.map((intent) => ({ ownerTurnId: intent.ownerTurnId })),
    observeCapture: (request) => observeTaskboardOwnerIntentCapture(request, async () => ({
      thread: {
        id: ownerRootThreadId,
        cwd: ownerRootWorkspacePath,
        turns: [
          {
            id: "01a05100-1111-7222-8333-666666666666",
            status: "completed",
            input: [{
              type: "text",
              text: "Taskboard Owner decision delivery id: delivery-1\nAsk the Owner one question.",
            }],
            items: [{ type: "agent_message", role: "assistant", content: "Which policy?" }],
          },
          {
            id: "01a05100-1111-7222-8333-777777777777",
            status: "completed",
            input: [{ type: "text", text: "Use the existing policy." }],
            items: [{
              type: "agent_message",
              role: "assistant",
              content: `TASKBOARD_OWNER_DECISION_V1 ${JSON.stringify({
                requestId: "request-1", outcome: "authorized", evidence: "Owner chose it",
              })}`,
            }],
          },
          {
            id: ownerTurnId,
            status: "completed",
            input: [{ type: "text", text: "然后继续实现自动恢复。" }],
            items: [{
              type: "agent_message", role: "assistant",
              content: `收到。\n<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 ${JSON.stringify({
                kind: "append", targetIntentId: null, constraints: [],
              })} -->`,
            }],
          },
        ],
      },
    })),
    recordCapture: async (capture) => {
      recorded.push(capture);
      return { applied: true, intent: capture };
    },
  };

  assert.deepEqual(await runOwnerIntentCaptureMonitorOnce(options), {
    captured: true,
    intentId: recorded[0].intentId,
    ownerTurnId,
  });
  assert.deepEqual(await runOwnerIntentCaptureMonitorOnce(options), {
    captured: false,
    reason: "no-owner-turn",
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].goal, "然后继续实现自动恢复。");
});

test("queued Owner Intent is adopted exactly once at an idle Coordinator boundary", async () => {
  const fullGoal = `Revise the next plan ${"goal".repeat(150)}`;
  const fullConstraint = `Preserve one writer ${"constraint".repeat(60)}`;
  const request = {
    intentId: "intent-2",
    kind: "append",
    targetIntentId: null,
    goal: "Revise the next plan…",
    constraints: ["Preserve one writer…"],
    coordinatorEpoch: "configured:coordinator-1",
    route: {
      coordinatorTaskId: "coordinator-1",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
    },
  };
  const calls = [];
  let confirmed;
  const result = await runOwnerIntentAdoptionMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: { pendingOwnerIntent: request },
    }),
    claimAdoption: async () => ({
      claimed: true,
      receipt: { id: "adoption-2" },
      executionIntent: {
        intentId: request.intentId,
        version: 2,
        kind: request.kind,
        targetIntentId: request.targetIntentId,
        goal: fullGoal,
        constraints: [fullConstraint],
      },
    }),
    confirmAdoption: async (receipt, intentId) => {
      confirmed = { receipt, intentId };
      return { confirmed: true, receipt: { id: receipt.adoptionId } };
    },
    deliver: (current, options) => deliverTaskboardOwnerIntent(current, async (method, params) => {
      calls.push([method, params]);
      if (method === "thread/read") {
        return {
          thread: {
            id: request.route.coordinatorThreadId,
            cwd: request.route.coordinatorWorkspacePath,
            turns: [],
          },
        };
      }
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        assert.equal(params.approvalPolicy, "never");
        return { turn: { id: "turn-adopt" } };
      }
      throw new Error(`Unexpected method: ${method}`);
    }, options),
  });
  assert.deepEqual(result, {
    delivered: true,
    intentId: request.intentId,
    delivery: "started",
    adopted: true,
  });
  assert.deepEqual(calls.map(([method]) => method), ["thread/read", "thread/resume", "turn/start"]);
  assert.deepEqual(confirmed, {
    receipt: { adoptionId: "adoption-2", deliveryTurnId: "turn-adopt" },
    intentId: request.intentId,
  });
  assert.match(calls[2][1].input[0].text, /without widening product, Git, deployment/);
  assert.match(calls[2][1].input[0].text, new RegExp(fullGoal));
  assert.match(calls[2][1].input[0].text, new RegExp(fullConstraint));
  assert.match(calls[2][1].input[0].text, /TASKBOARD_OWNER_INTENT_PLAN_V1/);
  assert.match(calls[2][1].input[0].text, /Owner Intent kind: append/);
  assert.match(calls[2][1].input[0].text, /Target Owner Intent id: none/);
  assert.doesNotMatch(calls[2][1].input[0].text, /turn\/steer/);
});

test("cancel Owner Intent instruction emits an empty executable frontier", async () => {
  const request = {
    projectId: "taskboard-core", intentId: "cancel-intent", kind: "cancel",
    targetIntentId: "target-intent", version: 2, goal: "Cancel the target work.",
    constraints: [], coordinatorEpoch: "configured:coordinator-1",
    adoptionReceipt: { id: "cancel-adoption" },
    route: {
      coordinatorTaskId: "coordinator-1",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
    },
  };
  let instruction;
  const result = await deliverTaskboardOwnerIntent(request, async (method, params) => {
    if (method === "thread/read") return {
      thread: { id: request.route.coordinatorThreadId, cwd: request.route.coordinatorWorkspacePath, turns: [] },
    };
    if (method === "thread/resume") return {};
    if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      instruction = params.input[0].text;
      return { turn: { id: "cancel-turn" } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  assert.deepEqual(result, { delivery: "started", turnId: "cancel-turn" });
  assert.match(instruction, /Owner Intent kind: cancel/);
  assert.match(instruction, /Target Owner Intent id: target-intent/);
  const marker = instruction.split("TASKBOARD_OWNER_INTENT_PLAN_V1 ")[1].split(". Never emit", 1)[0];
  assert.deepEqual(JSON.parse(marker).items, []);
  assert.doesNotMatch(marker, /stable-outcome|bounded Todo/);
});

test("Coordinator plan marker is observed and persisted exactly once", async () => {
  const request = {
    intentId: "intent-plan-1",
    version: 2,
    adoptionReceipt: {
      id: "adoption-plan-1",
      deliveryTurnId: "turn-plan-1",
      coordinatorEpoch: "configured:coordinator-1",
    },
    route: {
      coordinatorTaskId: "coordinator-1",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
    },
  };
  const plan = {
    intentId: request.intentId,
    adoptionId: request.adoptionReceipt.id,
    coordinatorEpoch: request.adoptionReceipt.coordinatorEpoch,
    revisionId: "plan-1",
    classification: "bounded_delivery",
    summary: "One bounded outcome",
    parentTaskId: null,
    items: [{
      outcomeKey: "bounded-outcome",
      title: "Bounded Todo",
      description: "No authority widening",
      priority: "high",
      blockedByOutcomeKeys: [],
    }],
  };
  const marker = `TASKBOARD_OWNER_INTENT_PLAN_V1 ${JSON.stringify(plan)}`;
  const observed = await observeTaskboardOwnerIntentPlan(request, async () => ({
    thread: {
      id: request.route.coordinatorThreadId,
      cwd: request.route.coordinatorWorkspacePath,
      turns: [{
        id: request.adoptionReceipt.deliveryTurnId,
        status: "completed",
        input: [{ type: "text", text: `Taskboard Owner Intent adoption id: ${request.adoptionReceipt.id}` }],
        items: [{ type: "agent_message", role: "assistant", content: marker }],
      }],
    },
  }));
  assert.deepEqual(observed, plan);
  const premature = await observeTaskboardOwnerIntentPlan(request, async () => ({
    thread: {
      id: request.route.coordinatorThreadId,
      cwd: request.route.coordinatorWorkspacePath,
      turns: [{
        id: request.adoptionReceipt.deliveryTurnId,
        status: "inProgress",
        input: [{ type: "text", text: `Taskboard Owner Intent adoption id: ${request.adoptionReceipt.id}` }],
        items: [{ type: "agent_message", role: "assistant", content: marker }],
      }],
    },
  }));
  assert.equal(premature, null);
  const invalidMarker = `TASKBOARD_OWNER_INTENT_PLAN_V1 ${JSON.stringify({
    ...plan,
    revisionId: "invalid-plan",
    items: [{}],
  })}`;
  const invalid = await observeTaskboardOwnerIntentPlan(request, async () => ({
    thread: {
      id: request.route.coordinatorThreadId,
      cwd: request.route.coordinatorWorkspacePath,
      turns: [{
        id: request.adoptionReceipt.deliveryTurnId,
        status: "completed",
        input: [{ type: "text", text: `Taskboard Owner Intent adoption id: ${request.adoptionReceipt.id}` }],
        items: [{ type: "agent_message", role: "assistant", content: invalidMarker }],
      }],
    },
  }));
  assert.deepEqual(invalid, { invalid: true, reason: "missing-or-malformed-plan" });
  for (const malformedItems of [[null], [42], [{ outcomeKey: "missing-dependencies" }]]) {
    const malformedMarker = `TASKBOARD_OWNER_INTENT_PLAN_V1 ${JSON.stringify({
      ...plan,
      revisionId: `malformed-${String(malformedItems[0]?.outcomeKey ?? malformedItems[0])}`,
      items: malformedItems,
    })}`;
    const malformed = await observeTaskboardOwnerIntentPlan(request, async () => ({
      thread: {
        id: request.route.coordinatorThreadId,
        cwd: request.route.coordinatorWorkspacePath,
        turns: [{
          id: request.adoptionReceipt.deliveryTurnId,
          status: "completed",
          input: [{ type: "text", text: `Taskboard Owner Intent adoption id: ${request.adoptionReceipt.id}` }],
          items: [{ type: "agent_message", role: "assistant", content: malformedMarker }],
        }],
      },
    }));
    assert.deepEqual(malformed, { invalid: true, reason: "missing-or-malformed-plan" });
  }
  for (const cycleItems of [
    [
      { outcomeKey: "cycle-a", title: "A", description: "A", priority: "high", blockedByOutcomeKeys: ["cycle-b"] },
      { outcomeKey: "cycle-b", title: "B", description: "B", priority: "high", blockedByOutcomeKeys: ["cycle-a"] },
    ],
    [
      { outcomeKey: "cycle-x", title: "X", description: "X", priority: "high", blockedByOutcomeKeys: ["cycle-z"] },
      { outcomeKey: "cycle-y", title: "Y", description: "Y", priority: "high", blockedByOutcomeKeys: ["cycle-x"] },
      { outcomeKey: "cycle-z", title: "Z", description: "Z", priority: "high", blockedByOutcomeKeys: ["cycle-y"] },
    ],
  ]) {
    const cycleMarker = `TASKBOARD_OWNER_INTENT_PLAN_V1 ${JSON.stringify({
      ...plan,
      revisionId: `cycle-plan-${cycleItems.length}`,
      items: cycleItems,
    })}`;
    const cycle = await observeTaskboardOwnerIntentPlan(request, async () => ({
      thread: {
        id: request.route.coordinatorThreadId,
        cwd: request.route.coordinatorWorkspacePath,
        turns: [{
          id: request.adoptionReceipt.deliveryTurnId,
          status: "completed",
          input: [{ type: "text", text: `Taskboard Owner Intent adoption id: ${request.adoptionReceipt.id}` }],
          items: [{ type: "agent_message", role: "assistant", content: cycleMarker }],
        }],
      },
    }));
    assert.deepEqual(cycle, { invalid: true, reason: "missing-or-malformed-plan" });
  }
  let applied;
  const result = await runOwnerIntentPlanningMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: { pendingOwnerIntentPlan: request },
    }),
    observePlan: async () => observed,
    applyPlan: async (current, currentPlan) => {
      applied = { current, currentPlan };
      return { applied: true, revision: { id: plan.revisionId } };
    },
  });
  assert.deepEqual(result, {
    applied: true,
    intentId: request.intentId,
    revisionId: plan.revisionId,
  });
  assert.deepEqual(applied, { current: request, currentPlan: plan });
});

test("terminal Owner Intent planning turns enter durable bounded retry", async () => {
  const projectId = "terminal-plan-retry-project";
  const route = {
    coordinatorTaskId: "coordinator-terminal-retry",
    coordinatorThreadId,
    codexHostId: "local",
    coordinatorWorkspacePath: "/tmp/taskboard/coordinator-terminal-retry",
  };
  const attempts = ["failed", "interrupted", "failed"].map((status, index) => ({
    intentId: "intent-terminal-retry",
    version: index + 1,
    adoptionReceipt: {
      id: `adoption-terminal-retry-${index + 1}`,
      deliveryTurnId: `turn-terminal-retry-${index + 1}`,
      coordinatorEpoch: "configured:coordinator-terminal-retry",
    },
    route,
    status,
  }));
  const durableFailures = new Set();
  let durableRetryCount = 0;
  let needsDecision = false;

  for (const [index, request] of attempts.entries()) {
    const options = {
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId },
      readSnapshot: async () => ({
        projectId,
        coordination: { pendingOwnerIntentPlan: request },
      }),
      observePlan: (current) => observeTaskboardOwnerIntentPlan(current, async () => ({
        thread: {
          id: route.coordinatorThreadId,
          cwd: route.coordinatorWorkspacePath,
          turns: [{
            id: current.adoptionReceipt.deliveryTurnId,
            status: current.status,
            input: [{
              type: "text",
              text: `Taskboard Owner Intent adoption id: ${current.adoptionReceipt.id}`,
            }],
            items: [],
          }],
        },
      })),
      applyPlan: async () => assert.fail("terminal planning turns cannot apply a plan"),
      scheduleRetry: async (current, failure) => {
        const failureKey = `${current.adoptionReceipt.id}:${failure.reason}`;
        if (!durableFailures.has(failureKey)) {
          durableFailures.add(failureKey);
          durableRetryCount += 1;
          needsDecision = durableRetryCount >= 3;
          return { applied: true, exhausted: needsDecision };
        }
        return { applied: false, exhausted: needsDecision };
      },
    };
    const expectedReason = index === 2 ? "plan-retry-exhausted" : "plan-retry-scheduled";
    assert.deepEqual(await runOwnerIntentPlanningMonitorOnce(options), {
      applied: false,
      reason: expectedReason,
    });
    assert.deepEqual(await runOwnerIntentPlanningMonitorOnce(options), {
      applied: false,
      reason: expectedReason,
    });
  }

  assert.equal(durableRetryCount, 3);
  assert.equal(durableFailures.size, 3);
  assert.equal(needsDecision, true);
});

test("server-invalid Owner Intent plan schedules durable bounded replan and accepts a later revision", async () => {
  const request = {
    intentId: "intent-invalid-cache",
    adoptionReceipt: { id: "adoption-invalid-cache", coordinatorEpoch: "configured:coordinator" },
    route: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId,
      codexHostId: "local",
      coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
    },
  };
  const plan = { revisionId: "invalid-cache-plan" };
  let applies = 0;
  const retries = [];
  let currentRequest = request;
  let currentPlan = plan;
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "invalid-cache-project" },
    readSnapshot: async () => ({
      projectId: "invalid-cache-project",
      coordination: { pendingOwnerIntentPlan: currentRequest },
    }),
    observePlan: async () => currentPlan,
    applyPlan: async () => {
      applies += 1;
      return applies === 1
        ? { applied: false, reason: "invalid-plan" }
        : { applied: true };
    },
    scheduleRetry: async (retryRequest, failure) => {
      retries.push({ retryRequest, failure });
      return { applied: true, exhausted: false };
    },
  };
  assert.deepEqual(await runOwnerIntentPlanningMonitorOnce(options), {
    applied: false,
    reason: "plan-retry-scheduled",
  });
  currentRequest = {
    ...request,
    version: 3,
    adoptionReceipt: { id: "adoption-retry", coordinatorEpoch: "configured:coordinator" },
  };
  currentPlan = { revisionId: "valid-retry-plan" };
  assert.deepEqual(await runOwnerIntentPlanningMonitorOnce(options), {
    applied: true,
    intentId: request.intentId,
    revisionId: "valid-retry-plan",
  });
  assert.equal(applies, 2);
  assert.deepEqual(retries, [{
    retryRequest: request,
    failure: { reason: "server-invalid-plan", revisionId: "invalid-cache-plan" },
  }]);
});

test("Owner Intent adoption failure cannot starve continuation or Owner decision monitors", async () => {
  const calls = [];
  const results = await runTaskboardProjectMonitorSequence([
    async () => { calls.push("planning"); return { applied: false }; },
    async () => { calls.push("adoption"); throw new Error("Coordinator host unavailable"); },
    async () => { calls.push("continuation"); return { delivered: true }; },
    async () => { calls.push("owner-decision"); return { delivered: true }; },
  ]);
  assert.deepEqual(calls, ["planning", "adoption", "continuation", "owner-decision"]);
  assert.deepEqual(results, [
    { ok: true, result: { applied: false } },
    { ok: false, error: "Coordinator host unavailable" },
    { ok: true, result: { delivered: true } },
    { ok: true, result: { delivered: true } },
  ]);
});

test("capacity-sensitive continuation runs independently of a slow project monitor sequence", async () => {
  const calls = [];
  const observations = [];
  let releaseSlowMonitor;
  let releaseSlowProject;
  let confirmFirstFastProject;
  let confirmSecondFastProject;
  const slowMonitor = new Promise((resolve) => {
    releaseSlowMonitor = resolve;
  });
  const slowProject = new Promise((resolve) => {
    releaseSlowProject = resolve;
  });
  const firstFastProjectCompleted = new Promise((resolve) => {
    confirmFirstFastProject = resolve;
  });
  const secondFastProjectCompleted = new Promise((resolve) => {
    confirmSecondFastProject = resolve;
  });
  const slowSequence = runTaskboardProjectMonitorSequence([
    async () => {
      calls.push("slow-started");
      await slowMonitor;
      calls.push("slow-finished");
      return { completed: true };
    },
  ]);
  await Promise.resolve();

  let fastProjectRuns = 0;
  const projects = [
    { projectId: "disabled-project", continuationEnabled: false },
    { projectId: "slow-project", continuationEnabled: true },
    { projectId: "capstone-dev", continuationEnabled: true },
    { projectId: "failing-project", continuationEnabled: true },
  ];
  const runContinuation = async (projectId) => {
    calls.push(`continuation:${projectId}`);
    if (projectId === "slow-project") await slowProject;
    if (projectId === "failing-project") throw new Error("snapshot unavailable");
    if (projectId === "capstone-dev") {
      fastProjectRuns += 1;
    }
    return { delivered: true };
  };
  const firstLane = runTaskboardContinuationFastLane({
    hostExecutor: localHostExecutor,
    projects,
    runContinuation,
    observeResult: (result) => {
      observations.push(result);
      if (result.projectId === "capstone-dev" && fastProjectRuns === 1) {
        confirmFirstFastProject();
      }
    },
  });

  assert.deepEqual(firstLane, [{
    projectId: "slow-project",
    state: "started",
  }, {
    projectId: "capstone-dev",
    state: "started",
  }, {
    projectId: "failing-project",
    state: "started",
  }]);
  await firstFastProjectCompleted;
  const secondLane = runTaskboardContinuationFastLane({
    hostExecutor: localHostExecutor,
    projects,
    runContinuation,
    observeResult: (result) => {
      observations.push(result);
      if (result.projectId === "capstone-dev" && fastProjectRuns === 2) {
        confirmSecondFastProject();
      }
    },
  });
  await secondFastProjectCompleted;

  assert.deepEqual(secondLane, [{
    projectId: "slow-project",
    state: "in_flight",
  }, {
    projectId: "capstone-dev",
    state: "started",
  }, {
    projectId: "failing-project",
    state: "started",
  }]);
  assert.equal(fastProjectRuns, 2);
  assert.equal(calls.filter((call) => call === "continuation:slow-project").length, 1);

  releaseSlowProject();
  releaseSlowMonitor();
  await slowSequence;
  await Promise.resolve();
  assert.equal(calls.at(-1), "slow-finished");
  assert.equal(observations.filter((result) => result.projectId === "capstone-dev").length, 2);
  assert.equal(observations.filter((result) => (
    result.projectId === "failing-project" && result.ok === false
  )).length, 2);
});

test("Coordinator identity handshakes run in a dedicated continuation fast lane", async () => {
  const calls = [];
  const results = await runCoordinatorIdentityHandshakeFastLane({
    hostExecutor: localHostExecutor,
    projects: [
      { projectId: "disabled-project", continuationEnabled: false },
      { projectId: "capstone-dev", continuationEnabled: true },
      { projectId: "second-project", continuationEnabled: true },
    ],
    runHandshake: async (projectId) => {
      calls.push(projectId);
      if (projectId === "second-project") throw new Error("host unavailable");
      return { confirmed: 1, skipped: 0, failed: 0 };
    },
  });
  assert.deepEqual(calls, ["capstone-dev", "second-project"]);
  assert.deepEqual(results, [
    {
      projectId: "capstone-dev",
      ok: true,
      result: { confirmed: 1, skipped: 0, failed: 0 },
    },
    { projectId: "second-project", ok: false, error: "host unavailable" },
  ]);
});

test("Coordinator monitor single-flight is scoped by exact host and project", async () => {
  let releaseHandshake;
  const handshakeGate = new Promise((resolve) => { releaseHandshake = resolve; });
  const handshakeRuns = [];
  const runHandshake = (hostExecutor) => runCoordinatorIdentityHandshakeFastLane({
    hostExecutor,
    projects: [{ projectId: "taskboard-core", continuationEnabled: true }],
    runHandshake: async () => {
      handshakeRuns.push(hostExecutor.ownedCodexHostId);
      await handshakeGate;
      return { confirmed: 0, skipped: 0, failed: 0 };
    },
  });
  const handshakeLocal = runHandshake(localHostExecutor);
  const handshakeRemote = runHandshake(remoteHostExecutor);
  releaseHandshake();
  await Promise.all([handshakeLocal, handshakeRemote]);
  assert.deepEqual(handshakeRuns.sort(), ["local", "remote-builder"]);

  const emptySnapshot = {
    projectId: "taskboard-core",
    coordination: { lease: null, domainCoordinators: [] },
    taskLanes: [],
  };
  let releaseKeepalive;
  const keepaliveGate = new Promise((resolve) => { releaseKeepalive = resolve; });
  const keepaliveRuns = [];
  const runKeepalive = (hostExecutor) => runCoordinatorLeaseKeepaliveMonitorOnce({
    hostExecutor,
    policy: {
      enabled: true,
      projectId: "taskboard-core",
      renewWindowMs: 45_000,
      leaseDurationSeconds: 120,
    },
    readSnapshot: async () => {
      keepaliveRuns.push(hostExecutor.ownedCodexHostId);
      await keepaliveGate;
      return emptySnapshot;
    },
    readThread: async () => assert.fail("empty snapshot must not read a thread"),
    renewLease: async () => assert.fail("empty snapshot must not renew a lease"),
  });
  const keepaliveLocal = runKeepalive(localHostExecutor);
  const keepaliveRemote = runKeepalive(remoteHostExecutor);
  releaseKeepalive();
  await Promise.all([keepaliveLocal, keepaliveRemote]);
  assert.deepEqual(keepaliveRuns.sort(), ["local", "remote-builder"]);

  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
  const recoveryRuns = [];
  const runRecovery = (hostExecutor) => runCoordinatorLeaseRecoveryMonitorOnce({
    hostExecutor,
    policy: { enabled: true, projectId: "taskboard-core", leaseDurationSeconds: 120 },
    readSnapshot: async () => {
      recoveryRuns.push(hostExecutor.ownedCodexHostId);
      await recoveryGate;
      return emptySnapshot;
    },
    readThread: async () => assert.fail("empty snapshot must not read a thread"),
    recoverLease: async () => assert.fail("empty snapshot must not recover a lease"),
  });
  const recoveryLocal = runRecovery(localHostExecutor);
  const recoveryRemote = runRecovery(remoteHostExecutor);
  releaseRecovery();
  await Promise.all([recoveryLocal, recoveryRemote]);
  assert.deepEqual(recoveryRuns.sort(), ["local", "remote-builder"]);
});

test("disposed Coordinator fast-lane timers stop old renderer ticks", async () => {
  const events = [];
  let scheduledTick;
  let canceledTimer = null;
  const timer = { unref: () => events.push("unref") };
  const dispose = createDisposableMonitorTimer(
    async () => { events.push("tick"); },
    2_000,
    {
      schedule: (callback, intervalMs) => {
        events.push(`schedule:${intervalMs}`);
        scheduledTick = callback;
        return timer;
      },
      cancel: (candidate) => {
        canceledTimer = candidate;
        events.push("cancel");
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["schedule:2000", "unref", "tick"]);
  scheduledTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["schedule:2000", "unref", "tick", "tick"]);
  dispose();
  assert.equal(canceledTimer, timer);
  scheduledTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["schedule:2000", "unref", "tick", "tick", "cancel"]);
});

test("cross-domain handoff waits for an idle Coordinator without steering", async () => {
  const request = {
    projectId: "taskboard-core",
    sourceTaskId: "source-uuid",
    sourceIdentifier: "CAP-24",
    targetTaskId: "target-uuid",
    targetIdentifier: "CAP-25",
    fingerprint: "a".repeat(64),
    sourceDomainId: "frontend",
    targetDomainId: "backend",
    expectedTargetDomainLeaseId: "backend-lease",
    targetHolderTaskId: "backend",
    route: {
      targetThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      targetWorkspacePath: "/tmp/taskboard/backend",
    },
  };
  const calls = [];
  const result = await runCrossDomainHandoffMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: request.projectId },
    readSnapshot: async () => ({
      projectId: request.projectId,
      coordination: { pendingCrossDomainHandoff: request },
    }),
    claimDelivery: async () => ({ claimed: true, receipt: { id: "handoff-busy" } }),
    confirmDelivery: async () => assert.fail("busy delivery must not confirm"),
    deliver: (deliveryRequest, options) => deliverTaskboardCrossDomainHandoff(
      deliveryRequest,
      async (method) => {
        calls.push(method);
        if (method === "thread/read") return {
          thread: {
            id: request.route.targetThreadId,
            cwd: request.route.targetWorkspacePath,
            turns: [{ id: "active", status: "inProgress" }],
          },
        };
        assert.fail("busy handoff must not steer or start a turn");
      },
      options,
    ),
  });
  assert.deepEqual(result, { delivered: false, reason: "coordinator-busy" });
  assert.deepEqual(calls, ["thread/read"]);
});

test("cross-domain handoff starts and confirms exactly one idle Coordinator turn", async () => {
  const request = {
    projectId: "taskboard-core",
    sourceTaskId: "source-uuid",
    sourceIdentifier: "CAP-24",
    targetTaskId: "target-uuid",
    targetIdentifier: "CAP-25",
    fingerprint: "b".repeat(64),
    sourceDomainId: "frontend",
    targetDomainId: "backend",
    expectedTargetDomainLeaseId: "backend-lease",
    targetHolderTaskId: "backend",
    route: {
      targetThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      targetWorkspacePath: "/tmp/taskboard/backend",
    },
  };
  const calls = [];
  let confirmed = null;
  const result = await runCrossDomainHandoffMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: request.projectId },
    readSnapshot: async () => ({ projectId: request.projectId, coordination: { pendingCrossDomainHandoff: request } }),
    claimDelivery: async () => ({ claimed: true, receipt: { id: "handoff-once" } }),
    confirmDelivery: async (value) => { confirmed = value; return { confirmed: true }; },
    deliver: (deliveryRequest, options) => deliverTaskboardCrossDomainHandoff(
      deliveryRequest,
      async (method, params) => {
        calls.push([method, params]);
        if (method === "thread/read") return {
          thread: { id: request.route.targetThreadId, cwd: request.route.targetWorkspacePath, turns: [] },
        };
        if (method === "turn/start") {
          assert.equal(params.approvalPolicy, "never");
          return { turn: { id: "handoff-turn" } };
        }
        return {};
      },
      options,
    ),
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(calls.map(([method]) => method), ["thread/read", "thread/resume", "turn/start"]);
  assert.deepEqual(confirmed, { deliveryId: "handoff-once", deliveryTurnId: "handoff-turn" });
  const instruction = calls.at(-1)[1].input[0].text;
  assert.match(instruction, /delivery invitation, not dependency acceptance/);
  assert.match(instruction, /dependency-handoff status taskboard-core CAP-25/);
  assert.match(instruction, /dependency-handoff accept taskboard-core CAP-25/);
  assert.doesNotMatch(instruction, /list_agents|spawn_agent|turn\/steer/);
});

test("cross-domain handoff recovers a started marker without a second turn", async () => {
  const request = {
    projectId: "taskboard-core",
    sourceTaskId: "source-uuid",
    sourceIdentifier: "CAP-24",
    targetTaskId: "target-uuid",
    targetIdentifier: "CAP-25",
    fingerprint: "c".repeat(64),
    sourceDomainId: "frontend",
    targetDomainId: "backend",
    expectedTargetDomainLeaseId: "backend-lease",
    targetHolderTaskId: "backend",
    route: {
      targetThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      targetWorkspacePath: "/tmp/taskboard/backend",
    },
  };
  const calls = [];
  let confirmed = null;
  const result = await runCrossDomainHandoffMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: request.projectId },
    readSnapshot: async () => ({ projectId: request.projectId, coordination: { pendingCrossDomainHandoff: request } }),
    claimDelivery: async () => ({ claimed: false, reason: "reserved", receipt: { id: "handoff-recover" } }),
    confirmDelivery: async (value) => { confirmed = value; return { confirmed: true }; },
    deliver: (deliveryRequest, options) => deliverTaskboardCrossDomainHandoff(
      deliveryRequest,
      async (method) => {
        calls.push(method);
        if (method === "thread/read") return {
          thread: {
            id: request.route.targetThreadId,
            cwd: request.route.targetWorkspacePath,
            turns: [{
              id: "existing-handoff-turn",
              status: "completed",
              input: [{ type: "text", text: "Taskboard cross-domain handoff delivery id: handoff-recover" }],
            }],
          },
        };
        assert.fail("marker recovery must not start another turn");
      },
      options,
    ),
  });
  assert.equal(result.delivery, "observed");
  assert.deepEqual(calls, ["thread/read"]);
  assert.deepEqual(confirmed, { deliveryId: "handoff-recover", deliveryTurnId: "existing-handoff-turn" });
});

test("Owner decision observation requires an actual Owner turn in the exact Root thread", async () => {
  const request = {
    requestId: "9".repeat(64), expectedResumeToken: "8".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const receipt = { id: "delivery-observe", deliveryTurnId: "delivery-turn" };
  const marker = `TASKBOARD_OWNER_DECISION_V1 ${JSON.stringify({
    requestId: request.requestId,
    outcome: "authorized",
    evidence: "Owner explicitly approved",
  })}`;
  const read = (turns) => observeTaskboardOwnerDecision(request, receipt, async () => ({
    thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns },
  }));
  assert.equal(await read([{
    id: "delivery-turn",
    input: [{ type: "text", text: `Taskboard Owner decision delivery id: ${receipt.id}` }],
    items: [{ type: "agent_message", role: "assistant", content: marker }],
  }]), null);
  assert.deepEqual(await read([
    {
      id: "delivery-turn",
      input: [{ type: "text", text: `Taskboard Owner decision delivery id: ${receipt.id}` }],
    },
    {
      id: "owner-turn",
      input: [{ type: "text", text: "Yes, approve this exact action" }],
      items: [{ type: "agent_message", role: "assistant", content: marker }],
    },
  ]), {
    outcome: "authorized",
    evidence: "Owner explicitly approved",
    ownerTurnId: "owner-turn",
    rootDecisionTurnId: "owner-turn",
    rootThreadId: request.route.rootThreadId,
  });
});

test("an uncertain Owner delivery is read back by id before any retry side effect", async () => {
  const request = {
    requestId: "7".repeat(64), expectedResumeToken: "6".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
    deliveryReceipt: { id: "delivery-uncertain" },
  };
  const activeTurn = { id: "active-turn", status: "inProgress", input: [] };
  let steerCalls = 0;
  const rpc = async (method, params) => {
    if (method === "thread/read") {
      return { thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns: [activeTurn] } };
    }
    if (method === "turn/steer") {
      steerCalls += 1;
      activeTurn.input = params.input;
      throw new Error("confirmation channel lost after Root accepted the steer");
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  await assert.rejects(deliverTaskboardOwnerDecision(request, rpc), /confirmation channel lost/);
  assert.deepEqual(await deliverTaskboardOwnerDecision(request, rpc), {
    delivery: "observed",
    turnId: "active-turn",
  });
  assert.equal(steerCalls, 1);
});

test("Owner decision delivery uses an atomic durable reservation before any Root call", async () => {
  const request = {
    requestId: "a".repeat(64), expectedResumeToken: "b".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let claims = 0;
  let deliveries = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ownerDecisionMonitorSnapshot(request),
    claimDelivery: async () => {
      claims += 1;
      if (claims > 1) return { claimed: false, reason: "reserved" };
      return { claimed: true, receipt: { id: "delivery-atomic" } };
    },
    deliver: async () => { deliveries += 1; await barrier; return { delivery: "steered", turnId: "turn-1" }; },
    confirmDelivery: async () => ({ confirmed: true }),
    observeDecision: async () => null,
    recordDecision: async () => assert.fail("no Owner decision was observed"),
  };
  const first = runOwnerDecisionMonitorOnce(options);
  const second = runOwnerDecisionMonitorOnce(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries, 1);
  release();
  assert.equal((await first).delivered, true);
  assert.equal((await second).delivered, true);
});

test("Owner decision monitor stops when the service rejects a stale coordinator route", async () => {
  const request = {
    requestId: "3".repeat(64), expectedResumeToken: "4".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "lease:old",
    route: {
      rootTaskId: "old-root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/old-root",
    },
  };
  let delivered = 0;
  const result = await runOwnerDecisionMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ownerDecisionMonitorSnapshot(request),
    claimDelivery: async () => ({ claimed: false, reason: "stale-route" }),
    deliver: async () => { delivered += 1; },
    confirmDelivery: async () => assert.fail("stale route must not confirm"),
    observeDecision: async () => assert.fail("stale route must not be observed"),
    recordDecision: async () => assert.fail("stale route must not record"),
  });
  assert.deepEqual(result, { delivered: false, reason: "stale-route" });
  assert.equal(delivered, 0);
});

test("Owner decision monitor rejects project-kind drift before any callback", async () => {
  const request = {
    requestId: "1".repeat(64), expectedResumeToken: "2".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const mustNotRun = async () => assert.fail("project-kind drift must fail before callbacks");
  assert.deepEqual(await runOwnerDecisionMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ownerDecisionMonitorSnapshot(request, {
      codexProjectKind: "remote",
    }),
    claimDelivery: mustNotRun,
    deliver: mustNotRun,
    confirmDelivery: mustNotRun,
    observeDecision: mustNotRun,
    recordDecision: mustNotRun,
  }), { delivered: false, reason: "invalid-request" });
});

test("a durable delivered request is recorded only from the exact Root observation", async () => {
  const request = {
    requestId: "5".repeat(64), expectedResumeToken: "4".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexProjectId: "taskboard-project", codexProjectKind: "local",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let recorded;
  const result = await runOwnerDecisionMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ownerDecisionMonitorSnapshot(request),
    claimDelivery: async () => ({
      claimed: false,
      reason: "already-delivered",
      receipt: { id: "delivery-record", deliveryTurnId: "delivery-turn" },
    }),
    deliver: async () => assert.fail("delivered receipt must not deliver again"),
    confirmDelivery: async () => assert.fail("delivered receipt must not confirm again"),
    observeDecision: async () => ({
      outcome: "authorized",
      evidence: "Owner approved exact scope",
      ownerTurnId: "owner-turn",
      rootDecisionTurnId: "root-decision-turn",
      rootThreadId: request.route.rootThreadId,
    }),
    recordDecision: async (value) => { recorded = value; return { applied: true }; },
  });
  assert.equal(result.decisionRecorded, true);
  assert.equal(result.delivered, false);
  assert.deepEqual(recorded, {
    taskId: "CAP-10",
    requestId: request.requestId,
    expectedResumeToken: request.expectedResumeToken,
    deliveryId: "delivery-record",
    rootCodexProjectId: request.route.codexProjectId,
    rootCodexProjectKind: request.route.codexProjectKind,
    rootCodexHostId: request.route.codexHostId,
    rootWorkspacePath: request.route.rootWorkspacePath,
    outcome: "authorized",
    evidence: "Owner approved exact scope",
    ownerTurnId: "owner-turn",
    rootDecisionTurnId: "root-decision-turn",
    rootThreadId: request.route.rootThreadId,
  });
});

test("background continuation fails closed for disabled, open-run, or malformed work", async () => {
  let delivered = 0;
  const base = {
    hostExecutor: localHostExecutor,
    policy: { enabled: false, projectId: "taskboard-core" },
    readSnapshot: async () => assert.fail("disabled monitor must not read"),
    claimReceipt: async () => assert.fail("must not claim a receipt"),
    confirmDelivery: async () => assert.fail("must not confirm delivery"),
    deliver: async () => { delivered += 1; },
    completeDelivery: async () => assert.fail("must not complete delivery"),
  };
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce(base),
    { delivered: false, reason: "disabled" },
  );

  const unsafeTodos = [
    {
      id: "OPEN-RUN", run: { state: "active" },
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [{ id: "safe" }], resumeToken: "c".repeat(64) },
    },
    {
      id: "NO-TOKEN", run: null,
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [{ id: "safe" }], resumeToken: null },
    },
    {
      id: "NO-SAFE-ACTION", run: null,
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [], resumeToken: "d".repeat(64) },
    },
  ];
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce({
      ...base,
      policy: { enabled: true, projectId: "taskboard-core" },
      readSnapshot: async () => ({ projectId: "taskboard-core", todos: unsafeTodos }),
    }),
    { delivered: false, reason: "no-eligible-work" },
  );
  assert.equal(delivered, 0);
});

test("background continuation resumes an expired reservation and records exactly one Root delivery", async () => {
  let attempts = 0;
  let delivered = 0;
  let completed = 0;
  const receipt = { id: "bootstrap-receipt", reservationLeaseId: "lease-retry" };
  const options = {
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "UNCERTAIN",
        taskId: "36e47e0e-77f3-41ca-b569-0125788288c4",
        run: null,
        dispatchTarget: {
          rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first" }],
          resumeToken: "e".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => ({ available: true, completed: false, receipt }),
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("failed immediately after claim");
      delivered += 1;
      return { delivery: "started", turnId: "root-turn" };
    },
    completeDelivery: async (_authorization, delivery) => {
      completed += 1;
      assert.equal(delivery.turnId, "root-turn");
      return { completed: true };
    },
  };
  await assert.rejects(runTaskboardContinuationMonitorOnce(options), /failed immediately after claim/);
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce(options),
    { delivered: true, todoId: "UNCERTAIN", actionId: "safe-first" },
  );
  options.claimReceipt = async () => ({ available: false, completed: true, receipt });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false, reason: "already-delivered",
  });
  assert.equal(delivered, 1);
  assert.equal(completed, 1);
});

test("background continuation fails closed when the authoritative reservation is rejected", async () => {
  let delivered = false;
  const result = await runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "STALE",
        taskId: "f727e1f4-e4da-44d3-9c55-4f4d8b487955",
        run: null,
        dispatchTarget: {
          rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first" }],
          resumeToken: "f".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => ({ available: false, completed: false, receipt: null }),
    confirmDelivery: async () => assert.fail("rejected reservations must not confirm delivery"),
    deliver: async () => { delivered = true; },
    completeDelivery: async () => assert.fail("rejected reservations must not complete delivery"),
  });

  assert.deepEqual(result, { delivered: false, reason: "reservation-unavailable" });
  assert.equal(delivered, false);
});

test("background continuation does not reserve an unassigned Todo without a Global route", async () => {
  let claimed = false;
  const result = await runTaskboardContinuationMonitorOnce({
    hostExecutor: localHostExecutor,
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "WAIT-GLOBAL",
        taskId: "f727e1f4-e4da-44d3-9c55-4f4d8b487955",
        run: null,
        dispatchTarget: null,
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first" }],
          resumeToken: "f".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => { claimed = true; },
    confirmDelivery: async () => assert.fail("unrouted work must not confirm delivery"),
    deliver: async () => assert.fail("unrouted work must not be delivered"),
    completeDelivery: async () => assert.fail("unrouted work must not complete delivery"),
  });

  assert.deepEqual(result, { delivered: false, reason: "no-eligible-work" });
  assert.equal(claimed, false);
});

function extractExactObjectCall(source, callee) {
  const marker = `${callee}({`;
  const callStart = source.indexOf(marker);
  assert.notEqual(callStart, -1, `${callee} call must exist`);
  assert.equal(source.indexOf(marker, callStart + marker.length), -1, `${callee} call must be unique`);
  const objectStart = callStart + marker.length - 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return {
        callStart,
        objectStart,
        objectEnd: index + 1,
        objectSource: source.slice(objectStart, index + 1),
      };
    }
  }
  assert.fail(`${callee} call object must be balanced`);
}

function topLevelCallPropertyRecords(objectSource) {
  const records = objectSource.split("\n").map((line, lineIndex) => {
    const match = /^(\s+)([A-Za-z_$][\w$]*)(?:\s*:|\s*,\s*$)/.exec(line);
    return match ? { indent: match[1].length, name: match[2], line, lineIndex } : null;
  }).filter(Boolean);
  const topLevelIndent = Math.min(...records.map((record) => record.indent));
  return records.filter((record) => record.indent === topLevelIndent);
}

const residentCoordinatorHostWiring = [{
  label: "outer identity fast lane",
  callee: "runCoordinatorIdentityHandshakeFastLane",
  properties: ["projects", "hostExecutor", "runHandshake"],
}, {
  label: "inner identity monitor",
  callee: "runBackgroundCoordinatorIdentityHandshakeMonitorOnce",
  properties: ["projectId", "hostExecutor", "listHandshakes", "readThread", "confirmIdentity"],
}, {
  label: "Global shutdown monitor",
  callee: "runCoordinatorShutdownMonitorOnce",
  properties: [
    "hostExecutor", "policy", "now", "readSnapshot", "readWindows", "readThread",
    "getAttempt", "requestAttempt", "releaseAttempt", "findArchivedThread", "archiveThread",
    "completeAttempt",
  ],
}, {
  label: "domain provisioning monitor",
  callee: "runDomainCoordinatorProvisioningMonitorOnce",
  properties: [
    "hostExecutor", "policy", "readSnapshot", "readWindows", "readDefaultModel",
    "getAttempt", "requestAttempt", "rebindAttempt", "findThread", "readThread",
    "markStarting", "startThread", "attachThread", "resetAttempt", "resumeExpiredAttempt",
    "deliverInstruction",
  ],
}, {
  label: "domain shutdown monitor",
  callee: "runDomainCoordinatorShutdownMonitorOnce",
  properties: [
    "hostExecutor", "policy", "now", "readSnapshot", "readWindows", "readThread",
    "getAttempt", "requestAttempt", "releaseAttempt", "authorizeAttempt",
    "beginArchiveAttempt", "cancelAttempt", "findArchivedThread", "archiveThread",
    "completeAttempt",
  ],
}, {
  label: "Owner Intent capture monitor",
  callee: "runOwnerIntentCaptureMonitorOnce",
  properties: [
    "policy", "hostExecutor", "readSnapshot", "listIntents", "observeCapture", "recordCapture",
  ],
}, {
  label: "Owner Intent planning monitor",
  callee: "runOwnerIntentPlanningMonitorOnce",
  properties: [
    "policy", "hostExecutor", "readSnapshot", "observePlan", "applyPlan", "scheduleRetry",
  ],
}, {
  label: "Owner Intent adoption monitor",
  callee: "runOwnerIntentAdoptionMonitorOnce",
  properties: [
    "policy", "hostExecutor", "readSnapshot", "claimAdoption", "confirmAdoption", "deliver",
  ],
}, {
  label: "cross-domain handoff monitor",
  callee: "runCrossDomainHandoffMonitorOnce",
  properties: [
    "policy", "hostExecutor", "readSnapshot", "claimDelivery", "confirmDelivery", "deliver",
  ],
}, {
  label: "Owner decision monitor",
  callee: "runOwnerDecisionMonitorOnce",
  properties: [
    "policy", "hostExecutor", "readSnapshot", "claimDelivery", "confirmDelivery", "deliver",
    "observeDecision", "recordDecision",
  ],
}, {
  label: "lease keepalive monitor",
  callee: "runCoordinatorLeaseKeepaliveMonitorOnce",
  properties: ["hostExecutor", "policy", "readSnapshot", "readThread", "renewLease"],
}, {
  label: "lease recovery monitor",
  callee: "runCoordinatorLeaseRecoveryMonitorOnce",
  properties: ["hostExecutor", "policy", "readSnapshot", "readThread", "recoverLease"],
}];

function assertResidentCoordinatorHostWiring(source) {
  for (const expected of residentCoordinatorHostWiring) {
    const call = extractExactObjectCall(source, expected.callee);
    const properties = topLevelCallPropertyRecords(call.objectSource);
    assert.deepEqual(properties.map(({ name }) => name), expected.properties, expected.label);
    assert.equal(
      properties.find(({ name }) => name === "hostExecutor")?.line.trim(),
      "hostExecutor: currentResidentHostExecutorExecution(),",
      expected.label,
    );
  }
}

function removeExactCallHostExecutor(source, callee) {
  const call = extractExactObjectCall(source, callee);
  const lines = call.objectSource.split("\n");
  const property = topLevelCallPropertyRecords(call.objectSource)
    .find(({ name }) => name === "hostExecutor");
  assert.ok(property, `${callee} must expose a first-level hostExecutor`);
  lines.splice(property.lineIndex, 1);
  return source.slice(0, call.objectStart)
    + lines.join("\n")
    + source.slice(call.objectEnd);
}

test("the resident authenticated host polls durable opt-in policies without the Agent Lanes view", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(source, /residentHostExecutor = Object\.freeze\(\{ ownedCodexHostId: "local" \}\)/);
  assertResidentCoordinatorHostWiring(source);
  for (const { callee } of residentCoordinatorHostWiring) {
    const withoutExactArgument = removeExactCallHostExecutor(source, callee);
    assert.throws(
      () => assertResidentCoordinatorHostWiring(withoutExactArgument),
      assert.AssertionError,
      `${callee} must fail when its own first-level hostExecutor is absent`,
    );
  }
  assert.match(source, /taskboard:background-continuation:policy:/);
  assert.match(source, /api\/client-storage/);
  assert.match(source, /api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-claim/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-delivery/);
  assert.match(source, /validateGitExecutionTarget/);
  assert.match(source, /runTaskboardContinuationMonitorOnce/);
  assert.match(source, /requestCapacityObservation/);
  assert.match(source, /deliverTaskboardCapacityObservation/);
  assert.match(source, /admissionRecoveryRpcTimeoutMs\(method\)/);
  assert.match(source, /deliverTaskboardCoordination/);
  assert.match(source, /runCoordinatorProvisioningMonitorOnce/);
  assert.match(
    source,
    /if \(continuationEnabled\) monitors\.push\(\s*\(\) => runCoordinatorShutdownMonitorOnce\(/,
  );
  assert.match(source, /coordinator-provisioning-attempts/);
  assert.match(source, /return coordinatorProvisioningResponseJson\(response\);/);
  assert.match(source, /"thread\/list"/);
  assert.match(source, /"thread\/start"/);
  assert.match(source, /TASKBOARD_COORDINATOR_PROVISIONING_V1/);
  assert.match(source, /buildCoordinatorProvisioningDeliveryTurnStartParams\(\{/);
  assert.doesNotMatch(source, /Bootstrap CAP-15/);
  assert.match(source, /TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1/);
  assert.match(source, /domain-coordinator status/);
  assert.match(
    source,
    /reuse every original register-window argument, especially the pre-acquire --expected-revision/,
  );
  assert.doesNotMatch(source, /background-continuation-receipts/);
  assert.match(source, /createDisposableMonitorTimer\(async \(\) => \{[\s\S]+backgroundContinuationIntervalMs\)/);
  assert.match(source, /cdp\.onClose\(\(\) => \{[\s\S]+disposeCoordinatorIdentityHandshakeTimer[\s\S]+disposeBackgroundContinuationTimer/);
});

test("the authenticated network proxy signs host-runtime publications", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /method === "PUT" && requestUrl === `\$\{taskboardBaseUrl\}\/api\/local\/host-runtime`[\s\S]{0,500}requestedHeaders\.push\(\.\.\.Object\.entries\(injectorProofHeaders\(\)\)\)/,
  );
});

test("Agent Todo coordination steers an active Root turn", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-17",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return {
        thread: {
          id: request.rootThreadId,
          cwd: request.rootWorkspacePath,
          turns: [{ id: "turn-active", status: "inProgress" }],
        },
      };
    }
    return {};
  });

  assert.deepEqual(result, { delivery: "steered", turnId: "turn-active" });
  assert.equal(calls[1][0], "turn/steer");
  assert.equal(calls[1][1].expectedTurnId, "turn-active");
  assert.equal(calls[1][1].approvalPolicy, undefined);
  assert.equal(calls[1][1].sandboxPolicy, undefined);
  assert.match(calls[1][1].input[0].text, /taskctl issue bootstrap TASKBOARD-17 --json/);
  assert.match(calls[1][1].input[0].text, /Taskboard coordination delivery id: coordination-receipt/);
  assert.match(calls[1][1].input[0].text, /readyWork\.eligible/);
  assert.match(calls[1][1].input[0].text, /safeActions\[0\]\.id/);
  assert.match(calls[1][1].input[0].text, /Never execute any readyWork\.deferredActions/);
  assert.match(calls[1][1].input[0].text, /Todo: TASKBOARD-17/);
  assert.match(calls[1][1].input[0].text, /spawn exactly one smallest useful Sub-Agent/);
  assert.match(calls[1][1].input[0].text, /--admission-receipt-id and --admission-attempt-id/);
  assert.match(calls[1][1].input[0].text, /Admission attempt id: admission-attempt/);
  assert.match(calls[1][1].input[0].text, /issue admission-prepare/);
  assert.match(calls[1][1].input[0].text, /rerouted=true/);
  assert.match(calls[1][1].input[0].text, /exact admissionAgentName/);
  assert.match(calls[1][1].input[0].text, /Exact Root thread id: 01a004bd-a749-7b53-81e2-af2d477f93ae/);
  assert.match(calls[1][1].input[0].text, /--root-thread-id/);
});

test("Agent Todo coordination starts an idle Root turn", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-18",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-new" } };
    return {};
  });

  assert.deepEqual(result, { delivery: "started", turnId: "turn-new" });
  assert.deepEqual(calls.map(([method]) => method), ["thread/read", "thread/resume", "turn/start"]);
  assert.match(calls[2][1].input[0].text, /do not spawn or claim/);
  assert.equal(calls[2][1].approvalPolicy, "never");
  assert.deepEqual(calls[2][1].sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [request.rootWorkspacePath],
    networkAccess: true,
  });
});

test("an idle personal vibe Todo receives full host access only after exact protected revalidation", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-VIBE",
    taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  let revalidated = null;
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-vibe" } };
    return {};
  }, async () => {}, async (candidate) => {
    revalidated = candidate;
    return {
      mode: "dangerFullAccess",
      authorization: "taskboard-personal-vibe",
      taskId: request.taskId,
      receiptId: request.deliveryReceipt.id,
      admissionAttemptId: request.deliveryReceipt.admissionAttemptId,
      rootThreadId: request.rootThreadId,
      worktreePath: request.targetRoot,
    };
  });

  assert.equal(revalidated, request);
  assert.deepEqual(result, { delivery: "started", turnId: "turn-vibe" });
  assert.deepEqual(calls[2][1].sandboxPolicy, { type: "dangerFullAccess" });
});

test("an idle Todo ignores forged or mismatched full-access identity and stays workspace-scoped", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-FORMAL",
    taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
    executionIdentity: {
      hostAccess: { mode: "dangerFullAccess", authorization: "taskboard-personal-vibe" },
    },
  };
  await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-formal" } };
    return {};
  }, async () => {}, async () => ({
    mode: "dangerFullAccess",
    authorization: "taskboard-personal-vibe",
    taskId: "different-task",
    receiptId: request.deliveryReceipt.id,
    admissionAttemptId: request.deliveryReceipt.admissionAttemptId,
    rootThreadId: request.rootThreadId,
    worktreePath: request.targetRoot,
  }));

  assert.deepEqual(calls[2][1].sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [request.rootWorkspacePath],
    networkAccess: true,
  });
});

test("Agent Todo coordination observes a prior durable Root delivery after restart", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local", projectId: "taskboard-core", todoId: "TASKBOARD-OBSERVED",
    targetRoot: "/tmp/taskboard/project", ...coordinationAuthorization,
    deliveryReceipt: { id: "observed-receipt", reservationLeaseId: "observed-lease", admissionAttemptId: "observed-attempt" },
  };
  const calls = [];
  const result = await deliverCoordination(request, async (method) => {
    calls.push(method);
    if (method === "thread/read") {
      return {
        thread: {
          id: request.rootThreadId, cwd: request.rootWorkspacePath,
          turns: [{
            id: "already-delivered-turn", status: "completed",
            input: [{ type: "text", text: "Taskboard coordination delivery id: observed-receipt:observed-attempt" }],
          }],
        },
      };
    }
    assert.fail("an observed durable delivery must not create another Root turn");
  }, async () => assert.fail("observed recovery must not validate an obsolete worktree"));
  assert.deepEqual(result, { delivery: "observed", turnId: "already-delivered-turn" });
  assert.deepEqual(calls, ["thread/read"]);
});

test("a rotated admission attempt is not swallowed by the prior receipt marker", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local", projectId: "taskboard-core", todoId: "TASKBOARD-ROTATED",
    targetRoot: "/tmp/taskboard/project", ...coordinationAuthorization,
    deliveryReceipt: { id: "shared-receipt", reservationLeaseId: "new-lease", admissionAttemptId: "new-attempt" },
  };
  const calls = [];
  const result = await deliverCoordination(request, async (method) => {
    calls.push(method);
    if (method === "thread/read") return {
      thread: {
        id: request.rootThreadId, cwd: request.rootWorkspacePath,
        turns: [{
          id: "old-turn", status: "completed",
          input: [{ type: "text", text: "Taskboard coordination delivery id: shared-receipt:old-attempt" }],
        }],
      },
    };
    if (method === "turn/start") return { turn: { id: "new-turn" } };
    return {};
  });
  assert.deepEqual(result, { delivery: "started", turnId: "new-turn" });
  assert.deepEqual(calls, ["thread/read", "thread/resume", "turn/start"]);
});

test("in-memory coordination dedupe is scoped to the admission attempt", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local", projectId: "taskboard-core", todoId: "TASKBOARD-ROTATED-MEMORY",
    targetRoot: "/tmp/taskboard/project", ...coordinationAuthorization,
    deliveryReceipt: { id: "memory-receipt", reservationLeaseId: "lease-old", admissionAttemptId: "attempt-old" },
  };
  let turnNumber = 0;
  const rpc = async (method) => {
    if (method === "thread/read") return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    if (method === "turn/start") return { turn: { id: `turn-${++turnNumber}` } };
    return {};
  };
  const first = await deliverCoordination(request, rpc);
  const second = await deliverCoordination({
    ...request,
    deliveryReceipt: { id: "memory-receipt", reservationLeaseId: "lease-new", admissionAttemptId: "attempt-new" },
  }, rpc);
  assert.deepEqual(first, { delivery: "started", turnId: "turn-1" });
  assert.deepEqual(second, { delivery: "started", turnId: "turn-2" });
});

test("route-takeover recovery never sends a stale-token instruction when no old marker exists", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local", projectId: "taskboard-core", todoId: "TASKBOARD-STALE-ROUTE",
    targetRoot: "/tmp/taskboard/project", ...coordinationAuthorization,
    deliveryReceipt: { id: "stale-route-receipt", reservationLeaseId: "original-lease" },
    observeOnly: true,
  };
  const calls = [];
  const result = await deliverCoordination(request, async (method) => {
    calls.push(method);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    assert.fail("observe-only recovery must not issue a Root RPC without the old marker");
  }, async () => assert.fail("observe-only recovery must not validate an obsolete worktree"));
  assert.deepEqual(result, { delivery: "not-observed", turnId: null });
  assert.deepEqual(calls, ["thread/read"]);
});

test("the authenticated host binding accepts one bounded Agent Todo request", async () => {
  const calls = [];
  const result = await handleHostBindingPayload({
    executionContextId: 12,
    payload: JSON.stringify({
      id: "coordinate-1",
      action: "coordinate-agent-todo",
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      projectId: "taskboard-core",
      todoId: "TASKBOARD-19",
      targetRoot: "/tmp/taskboard/project",
      ...coordinationAuthorization,
    }),
  }, {
    isAuthorizedContext: (id) => id === 12,
    parseAutomationRequest: () => null,
    coordinateAgentTodo: async (request) => {
      calls.push(["coordinate", request.todoId]);
      return { delivery: "started" };
    },
    sendResponse: async (_id, response) => calls.push(["response", response]),
  });

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.deepEqual(calls, [
    ["coordinate", "TASKBOARD-19"],
    ["response", { id: "coordinate-1", ok: true, delivery: "started" }],
  ]);
});

test("Agent Todo coordination rejects a Root cwd that is not exactly the coordination workspace", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-WRONG", targetRoot: "/tmp/other/project",
    ...coordinationAuthorization,
  };
  await assert.rejects(
    deliverCoordination(request, async (method) => {
      calls.push(method);
      return { thread: { id: request.rootThreadId, cwd: "/tmp/taskboard", turns: [] } };
    }),
    /exactly match/i,
  );
  assert.deepEqual(calls, ["thread/read"]);
});

test("Agent Todo coordination can target a Git worktree outside the Root coordination workspace", async () => {
  const calls = [];
  const validatedTargets = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-SEPARATE",
    rootWorkspacePath: "/Users/owner/capstone-coordination",
    targetRoot: path.resolve("/tmp/capstone-execution-worktree"),
    safeActionId: "safe-action-separate",
    expectedResumeToken: "f".repeat(64),
    deliveryReceipt: { id: "separate-receipt", reservationLeaseId: "separate-lease" },
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-separate" } };
    return {};
  }, async (targetRoot) => validatedTargets.push(targetRoot));
  assert.deepEqual(result, { delivery: "started", turnId: "turn-separate" });
  assert.deepEqual(validatedTargets, [request.targetRoot]);
  const turnStart = calls.find(([method]) => method === "turn/start")?.[1];
  const instruction = turnStart?.input?.[0]?.text ?? "";
  assert.ok(instruction.includes(`Exact execution worktree: ${request.targetRoot}`));
  assert.match(instruction, /coordination cwd may be different/);
  assert.deepEqual(turnStart?.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [path.resolve(request.rootWorkspacePath), request.targetRoot],
    networkAccess: true,
  });
});

test("Agent Todo coordination fails closed without an execution worktree validator", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-NO-VALIDATOR",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  await assert.rejects(
    deliverTaskboardCoordination(request, async () => assert.fail("RPC must not run")),
    /validator is required/i,
  );
});

test("Agent Todo delivery dedupe is scoped to the normalized Todo worktree", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-TARGET-IDENTITY",
    targetRoot: "/tmp/right",
    ...coordinationAuthorization,
  };
  const rpc = async (method) => {
    calls.push(method);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-right" } };
    return {};
  };

  const first = await deliverCoordination(request, rpc);
  const duplicate = await deliverCoordination({ ...request }, rpc);
  assert.deepEqual(first, { delivery: "started", turnId: "turn-right" });
  assert.deepEqual(duplicate, first);
  assert.equal(calls.filter((method) => method === "thread/read").length, 1);

  assert.deepEqual(
    await deliverCoordination({ ...request, targetRoot: "/tmp/wrong" }, rpc),
    { delivery: "started", turnId: "turn-right" },
  );
  assert.equal(calls.filter((method) => method === "thread/read").length, 2);
  assert.equal(calls.filter((method) => method === "turn/start").length, 2);
});

test("Agent Todo coordination is idempotent and requires a turn receipt", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-IDEMPOTENT", targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const rpc = async (method) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-once" } };
    return {};
  };
  const [left, right] = await Promise.all([
    deliverCoordination(request, rpc), deliverCoordination(request, rpc),
  ]);
  assert.deepEqual(left, { delivery: "started", turnId: "turn-once" });
  assert.deepEqual(right, left);
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);

  await assert.rejects(
    deliverCoordination({ ...request, todoId: "TASKBOARD-NO-RECEIPT" }, async (method) => (
      method === "thread/read"
        ? { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } }
        : {}
    )),
    /turn receipt/i,
  );

  const retry = await deliverCoordination(
    { ...request, todoId: "TASKBOARD-NO-RECEIPT" },
    async (method) => method === "thread/read"
      ? { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } }
      : { turn: { id: "turn-after-retry" } },
  );
  assert.deepEqual(retry, { delivery: "started", turnId: "turn-after-retry" });
});

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  codexProjectKind: "local",
  codexHostId: "local",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a binding call from the wrong execution context cannot reach native actions", async () => {
  const calls = [];
  const result = await handleHostBindingPayload(
    {
      payload: JSON.stringify({ id: "host-request-2", action: "ensure" }),
      executionContextId: 44,
    },
    {
      isAuthorizedContext: (executionContextId) => executionContextId === 12,
      parseAutomationRequest: () => null,
      ensure: async () => calls.push("ensure"),
      runAutomation: async () => calls.push("automation"),
      prefill: async () => calls.push("prefill"),
      sendResponse: async () => calls.push("response"),
    },
  );

  assert.deepEqual(result, { responded: false, accepted: false });
  assert.deepEqual(calls, []);
});

test("frame loading and external links require bounded authenticated values", async () => {
  const calls = [];
  const handlers = {
    parseAutomationRequest: () => null,
    ensure: async () => assert.fail("ensure must not run"),
    loadFrame: async (request) => calls.push(["load", request.frameCapability]),
    openExternal: async (request) => calls.push(["open", request.url]),
    runAutomation: async () => assert.fail("automation must not run"),
    prefill: async () => assert.fail("prefill must not run"),
    sendResponse: async (_executionContextId, response) => calls.push(["response", response.ok]),
  };

  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "load-request-1",
      action: "load-frame",
      frameName: "codex-taskboard-8f99fbb3-12d4-48af-8938-89f993fab008",
      frameCapability: "30c3d0c4-aa0f-4169-93c0-bb3da20bc654",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-http",
      action: "open-external",
      url: "http://10.0.203.86:30842/projects",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-1",
      action: "open-external",
      url: "https://example.com/review",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-2",
      action: "open-external",
      url: "javascript:alert(1)",
    }),
    executionContextId: 12,
  }, handlers);

  assert.deepEqual(calls, [
    ["load", "30c3d0c4-aa0f-4169-93c0-bb3da20bc654"],
    ["response", true],
    ["open", "http://10.0.203.86:30842/projects"],
    ["response", true],
    ["open", "https://example.com/review"],
    ["response", true],
    ["response", false],
  ]);
});

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("resident discovery accepts this repository's absolute and relative launch forms only", () => {
  const projectRoot = "/workspace/codex-taskboard";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
  ].join("\n");
  const cwdByPid = new Map([
    [102, projectRoot],
    [103, projectRoot],
    [104, "/workspace/another-repository"],
  ]);

  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9231,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [101, 103]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9229,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [102, 105]);
});

test("refresh stops every stale resident before starting one token-verified replacement", async () => {
  const calls = [];
  const startupToken = "replacement-token";
  const replacement = await restartResidentInjector(9231, {
    findResidents: () => [4321, 5432],
    stopResident: async (pid) => calls.push(["stop", pid]),
    createStartupToken: () => startupToken,
    startResident: (port, token) => {
      calls.push(["start", port, token]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid, token) => calls.push(["ready", port, pid, token]),
  });

  assert.deepEqual(replacement, {
    previousPids: [4321, 5432],
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["stop", 5432],
    ["start", 9231, startupToken],
    ["ready", 9231, 9876, startupToken],
  ]);
});

function cap59Preflight(projectId, ownerHostId, coordinatorWindows = []) {
  const owner = {
    taskId: "owner-root",
    label: "Owner Root",
    role: "owner_root",
    threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "cap59-project",
    codexProjectKind: ownerHostId === "local" ? "local" : "remote",
    codexHostId: ownerHostId,
    workspacePath: "/tmp/cap59-owner",
  };
  return {
    projectId,
    revision: "a".repeat(64),
    ownerRootTaskId: owner.taskId,
    ownerRootValid: true,
    coordinatorLease: null,
    durableWorkPending: true,
    shutdownAttempt: null,
    windows: [owner, ...coordinatorWindows],
  };
}

function cap59ReadyProvisioningOptions({ projectId, hostExecutor, ownerHostId, callbacks }) {
  let attempt = null;
  const preflight = cap59Preflight(projectId, ownerHostId);
  return {
    policy: { enabled: true, projectId, model: "gpt-5", reasoningEffort: "high" },
    ...(hostExecutor === undefined ? {} : { hostExecutor }),
    readPreflight: async () => {
      callbacks.push("preflight");
      return preflight;
    },
    getAttempt: async () => {
      callbacks.push("lookup");
      return { attempt: null };
    },
    requestAttempt: async (request) => {
      callbacks.push(["request", request.ownedCodexHostId]);
      const { ownedCodexHostId: _ownedCodexHostId, ...persistedRequest } = request;
      attempt = {
        ...persistedRequest,
        id: `attempt-${projectId}`,
        status: "pending",
        threadId: null,
      };
      return { attempt: { ...attempt } };
    },
    findThread: async () => {
      callbacks.push("find-thread");
      return null;
    },
    markStarting: async () => {
      callbacks.push("starting");
      attempt = { ...attempt, status: "starting" };
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      callbacks.push("start-thread");
      return {
        thread: {
          id: "01a062c1-fd2b-7f61-9114-d483e695640e",
          cwd: settings.cwd,
          threadSource: settings.threadSource,
        },
      };
    },
    attachThread: async ({ threadId }) => {
      callbacks.push("attach");
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => {
      callbacks.push("deliver");
      return { delivery: "started", turnId: "turn-cap59" };
    },
  };
}

test("CAP-59 Global provisioning rejects invalid host executors before every callback", async () => {
  const cases = [
    ["missing", undefined],
    ["whitespace", { ownedCodexHostId: "   " }],
    ["control", { ownedCodexHostId: "bad\nhost" }],
    ["257 characters", { ownedCodexHostId: "h".repeat(257) }],
  ];
  const observed = [];
  for (const [label, hostExecutor] of cases) {
    const callbacks = [];
    const result = await runCoordinatorProvisioningMonitorOnce(cap59ReadyProvisioningOptions({
      projectId: `cap59-invalid-${label.replaceAll(" ", "-")}`,
      hostExecutor,
      ownerHostId: "local",
      callbacks,
    }));
    observed.push([label, result, callbacks.length]);
  }
  assert.deepEqual(observed, cases.map(([label]) => [label, {
    provisioned: false, reason: "host-executor-unavailable",
  }, 0]));
});

test("CAP-59 Global provisioning accepts canonical host executors and carries ownership", async () => {
  const observed = [];
  for (const length of [240, 241, 256]) {
    const hostId = `h${"x".repeat(length - 1)}`;
    const callbacks = [];
    const result = await runCoordinatorProvisioningMonitorOnce(cap59ReadyProvisioningOptions({
      projectId: `cap59-canonical-${length}`,
      hostExecutor: { ownedCodexHostId: hostId },
      ownerHostId: hostId,
      callbacks,
    }));
    observed.push([length, result.provisioned, callbacks.find((entry) => Array.isArray(entry))?.[1]]);
  }
  assert.deepEqual(observed, [240, 241, 256].map((length) => [
    length,
    true,
    `h${"x".repeat(length - 1)}`,
  ]));
});

test("CAP-59 Global provisioning fences foreign Owner and registered Coordinator routes before inspection", async () => {
  const coordinator = (codexHostId) => ({
    taskId: "coordinator-root",
    label: "Global Coordinator",
    role: "coordinator",
    threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
    codexProjectId: "cap59-project",
    codexProjectKind: codexHostId === "local" ? "local" : "remote",
    codexHostId,
    workspacePath: "/tmp/cap59-coordinator",
  });
  const cases = [
    ["foreign-owner", "remote-builder", coordinator("local")],
    ["foreign-window", "local", coordinator("remote-builder")],
    ["invalid-window", "local", coordinator("bad\nhost")],
    ["duplicate-owner", "local", null],
    ["fresh-invalid-window-set", "local", coordinator("local")],
  ];
  const observed = [];
  const fencedResults = {};
  for (const [label, ownerHostId, window] of cases) {
    const effects = [];
    let duplicateAttempt = null;
    const result = await runCoordinatorProvisioningMonitorOnce({
      policy: { enabled: true, projectId: `cap59-fence-${label}`, model: "gpt-5", reasoningEffort: "high" },
      hostExecutor: localHostExecutor,
      readPreflight: async () => {
        effects.push("preflight");
        const preflight = cap59Preflight(
          `cap59-fence-${label}`,
          ownerHostId,
          window ? [window] : [],
        );
        return label === "duplicate-owner" ? {
          ...preflight,
          windows: [...preflight.windows, {
            taskId: "owner-root-shadow",
            label: "Shadow Owner Root",
            role: "owner_root",
            threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
            codexProjectId: "cap59-project",
            codexProjectKind: "local",
            codexHostId: "local",
            workspacePath: "/tmp/cap59-owner",
          }],
        } : label === "fresh-invalid-window-set" && effects.filter((effect) => effect === "preflight").length > 1 ? {
          ...cap59Preflight(`cap59-fence-${label}`, "local"),
          windows: [...cap59Preflight(`cap59-fence-${label}`, "local").windows, {
            taskId: "owner-root-shadow",
            label: "Shadow Owner Root",
            role: "owner_root",
            threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
            codexProjectId: "cap59-project",
            codexProjectKind: "local",
            codexHostId: "local",
            workspacePath: "/tmp/cap59-owner",
          }],
        } : preflight;
      },
      inspectCoordinatorWindow: async () => {
        effects.push("inspection");
        return label === "fresh-invalid-window-set"
          ? { eligibility: "stale", reason: "archived", window }
          : { eligibility: "eligible", window };
      },
      getAttempt: async () => {
        effects.push("lookup");
        return { attempt: null };
      },
      requestAttempt: async (request) => {
        effects.push("request");
        if (!new Set(["duplicate-owner", "fresh-invalid-window-set"]).has(label)) return null;
        duplicateAttempt = {
          ...request,
          id: "cap59-duplicate-owner-attempt",
          status: "pending",
          threadId: null,
        };
        return { attempt: { ...duplicateAttempt } };
      },
      findThread: async () => { effects.push("find-thread"); return null; },
      markStarting: async () => {
        effects.push("starting");
        duplicateAttempt = { ...duplicateAttempt, status: "starting" };
        return { attempt: { ...duplicateAttempt } };
      },
      startThread: async (settings) => {
        effects.push("start-thread");
        return {
          thread: {
            id: "01a09999-a749-7b53-81e2-af2d477f93ae",
            cwd: settings.cwd,
            threadSource: settings.threadSource,
          },
        };
      },
      attachThread: async ({ threadId }) => {
        effects.push("attach");
        duplicateAttempt = { ...duplicateAttempt, status: "started", threadId };
        return { attempt: { ...duplicateAttempt } };
      },
      deliverInstruction: async () => {
        effects.push("deliver");
        return { delivery: "started", turnId: "turn-cap59-duplicate-owner" };
      },
    });
    if (["duplicate-owner", "fresh-invalid-window-set"].includes(label)) {
      fencedResults[label] = [result, effects];
    } else {
      observed.push([label, result.provisioned, effects]);
    }
  }
  assert.deepEqual(
    [fencedResults["duplicate-owner"], fencedResults["fresh-invalid-window-set"]],
    [[{
      provisioned: false,
      reason: "owner-root-invalid",
    }, ["preflight"]], [{
      provisioned: false,
      reason: "retirement-preflight-invalid",
      attemptId: "cap59-duplicate-owner-attempt",
    }, ["preflight", "inspection", "lookup", "lookup", "request", "preflight"]]],
  );
  assert.deepEqual(observed, cases.slice(0, 3).map(([label]) => [label, false, ["preflight"]]));
});

test("CAP-59 Global provisioning single-flight is scoped by exact host and project", async () => {
  let enterFirstPreflight;
  const firstPreflight = new Promise((resolve) => { enterFirstPreflight = resolve; });
  let releaseFirstPreflight;
  const release = new Promise((resolve) => { releaseFirstPreflight = resolve; });
  const observedHosts = [];
  const makeOptions = (hostId, block) => {
    const callbacks = [];
    const options = cap59ReadyProvisioningOptions({
      projectId: "cap59-single-flight",
      hostExecutor: { ownedCodexHostId: hostId },
      ownerHostId: hostId,
      callbacks,
    });
    options.readPreflight = async () => {
      observedHosts.push(hostId);
      if (block) {
        enterFirstPreflight();
        await release;
      }
      return cap59Preflight("cap59-single-flight", hostId);
    };
    return options;
  };
  const local = runCoordinatorProvisioningMonitorOnce(makeOptions("local", true));
  await firstPreflight;
  const remote = runCoordinatorProvisioningMonitorOnce(makeOptions("remote-builder", false));
  releaseFirstPreflight();
  const results = await Promise.all([local, remote]);
  assert.deepEqual(observedHosts, ["local", "remote-builder"]);
  assert.deepEqual(results.map((result) => result.provisioned), [true, true]);
});

test("CAP-59 Global provisioning rejects immutable response-envelope drift before later effects", async () => {
  const scenarios = [
    ["request", "request"],
    ["rebind", "rebind"],
    ["starting", "starting"],
    ["reset", "reset"],
    ["attach", "attach"],
    ["observe-missing", "observe"],
    ["clear-missing", "clear"],
    ["reset-missing", "reset-missing"],
    ["resume-expired", "resume"],
  ];
  const observed = [];
  for (const [label, transition] of scenarios) {
    const projectId = `cap59-envelope-${label}`;
    const effects = [];
    let attempt = null;
    let identityRequest = null;
    const observedAt = Date.parse("2026-09-07T00:02:00.000Z");
    const drift = (candidate) => ({
      ...candidate,
      ...(transition === "request"
        ? { codexHostId: "remote-builder" }
        : transition === "resume"
          ? { idempotencyKey: `${candidate.idempotencyKey}-drift` }
          : { id: `${candidate.id}-drift` }),
    });
    const fromLookup = (request, status, threadId = null, expectedRevision = "a".repeat(64)) => {
      const fingerprint = request.idempotencyKey.slice("coordinator-provision-".length);
      return {
        id: `attempt-${label}`,
        projectId,
        idempotencyKey: request.idempotencyKey,
        taskId: `coordinator-${projectId}-${fingerprint.slice(0, 12)}`,
        label: "Taskboard Execution Coordinator",
        threadSource: `taskboard-coordinator-provision-${fingerprint}`,
        model: "gpt-5",
        reasoningEffort: "high",
        expectedRevision,
        ownerRootTaskId: "owner-root",
        ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
        codexProjectId: "cap59-project",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "/tmp/cap59-owner",
        status,
        threadId,
        missingSince: null,
      };
    };
    const options = {
      policy: { enabled: true, projectId, model: "gpt-5", reasoningEffort: "high" },
      hostExecutor: localHostExecutor,
      now: () => observedAt,
      readPreflight: async () => cap59Preflight(projectId, "local"),
      getAttempt: async (request) => {
        if (transition === "request") return { attempt: null };
        if (transition === "rebind" && request.idempotencyKey) {
          identityRequest = request;
          return { attempt: null };
        }
        if (!attempt) {
          const status = transition === "attach" ? "starting"
            : transition === "observe" || transition === "clear" || transition === "reset-missing"
              ? "started"
              : transition === "resume" ? "expired" : "pending";
          const threadId = ["observe", "clear", "reset-missing", "resume"].includes(transition)
            ? "01a062c1-fd2b-7f61-9114-d483e695640e" : null;
          attempt = fromLookup(
            identityRequest ?? request,
            status,
            threadId,
            transition === "rebind" ? "b".repeat(64) : undefined,
          );
          if (transition === "clear") attempt.missingSince = "2000-01-01T00:00:00.000Z";
        }
        return { attempt: { ...attempt } };
      },
      requestAttempt: async (request) => {
        effects.push("request");
        attempt = drift({
          ...fromLookup(request, "pending"),
          id: `attempt-${label}`,
        });
        return { attempt: { ...attempt } };
      },
      rebindAttempt: async () => {
        effects.push("rebind");
        attempt = drift({ ...attempt, expectedRevision: "a".repeat(64) });
        return { attempt: { ...attempt } };
      },
      findThread: async (candidate) => {
        effects.push("find");
        if (!["attach", "clear", "resume"].includes(transition)) return null;
        return {
          id: candidate.threadId ?? "01a062c1-fd2b-7f61-9114-d483e695640e",
          cwd: candidate.workspacePath,
          threadSource: candidate.threadSource,
          turns: transition === "resume"
            ? [{ input: `TASKBOARD_COORDINATOR_PROVISIONING_V1:${candidate.id}` }]
            : [],
        };
      },
      markStarting: async () => {
        effects.push("starting");
        attempt = transition === "starting"
          ? drift({ ...attempt, status: "starting" })
          : { ...attempt, status: "starting" };
        return { attempt: { ...attempt } };
      },
      startThread: async (settings) => {
        effects.push("rpc");
        if (transition === "reset") {
          throw new Error("Selected model is at capacity. Please try a different model.");
        }
        return {
          thread: {
            id: "01a062c1-fd2b-7f61-9114-d483e695640e",
            cwd: settings.cwd,
            threadSource: settings.threadSource,
          },
        };
      },
      resetAttempt: async () => {
        effects.push("reset");
        attempt = drift({ ...attempt, status: "pending", threadId: null });
        return { attempt: { ...attempt } };
      },
      attachThread: async ({ threadId }) => {
        effects.push("attach");
        attempt = transition === "attach"
          ? drift({ ...attempt, status: "started", threadId })
          : { ...attempt, status: "started", threadId };
        return { attempt: { ...attempt } };
      },
      observeMissingAttempt: async () => {
        effects.push("observe");
        attempt = transition === "observe"
          ? drift({ ...attempt, missingSince: new Date(observedAt).toISOString() })
          : { ...attempt, missingSince: "2000-01-01T00:00:00.000Z" };
        return { attempt: { ...attempt } };
      },
      clearMissingAttempt: async () => {
        effects.push("clear");
        attempt = drift({ ...attempt, missingSince: null });
        return { attempt: { ...attempt } };
      },
      resetMissingAttempt: async () => {
        effects.push("reset-missing");
        attempt = drift({ ...attempt, status: "pending", threadId: null, missingSince: null });
        return { attempt: { ...attempt } };
      },
      resumeExpiredAttempt: async () => {
        effects.push("resume");
        attempt = drift({ ...attempt, status: "started" });
        return { attempt: { ...attempt } };
      },
      deliverInstruction: async () => {
        effects.push("delivery");
        return { delivery: "started", turnId: "turn-cap59-envelope" };
      },
    };
    const result = await runCoordinatorProvisioningMonitorOnce(options);
    const transitionIndex = effects.indexOf(transition);
    observed.push([
      label,
      result.reason,
      transitionIndex >= 0,
      effects.slice(transitionIndex + 1),
    ]);
  }
  assert.deepEqual(observed, scenarios.map(([label]) => [
    label,
    "attempt-binding-mismatch",
    true,
    [],
  ]));
});

test("CAP-59 Global provisioning replays an exact-host expired attempt", async () => {
  const ownership = [];
  let attempt;
  const replay = await runCoordinatorProvisioningMonitorOnce({
    policy: { enabled: true, projectId: "cap59-exact-replay", model: "gpt-5", reasoningEffort: "high" },
    hostExecutor: localHostExecutor,
    readPreflight: async () => cap59Preflight("cap59-exact-replay", "local"),
    getAttempt: async (request) => {
      ownership.push(["lookup", request.ownedCodexHostId]);
      const fingerprint = request.idempotencyKey.slice("coordinator-provision-".length);
      attempt = {
        id: "cap59-replay-attempt", projectId: "cap59-exact-replay",
        idempotencyKey: request.idempotencyKey,
        taskId: `coordinator-cap59-exact-replay-${fingerprint.slice(0, 12)}`,
        label: "Taskboard Execution Coordinator",
        threadSource: `taskboard-coordinator-provision-${fingerprint}`,
        model: "gpt-5", reasoningEffort: "high", expectedRevision: "a".repeat(64),
        ownerRootTaskId: "owner-root",
        ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
        ownerRootCodexProjectId: "cap59-project",
        ownerRootCodexProjectKind: "local",
        ownerRootCodexHostId: "local",
        ownerRootWorkspacePath: "/tmp/cap59-owner",
        codexProjectId: "cap59-project", codexProjectKind: "local", codexHostId: "local",
        workspacePath: "/tmp/cap59-owner", status: "expired",
        threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
      };
      return { attempt };
    },
    requestAttempt: async () => assert.fail("the exact replay must reuse its attempt"),
    readThread: async () => null,
    findThread: async (candidate) => ({
      id: candidate.threadId, cwd: candidate.workspacePath, threadSource: candidate.threadSource,
      turns: [{ input: `TASKBOARD_COORDINATOR_PROVISIONING_V1:${candidate.id}` }],
    }),
    markStarting: async () => assert.fail("the exact replay must not start another thread"),
    startThread: async () => assert.fail("the exact replay must not start another thread"),
    attachThread: async () => assert.fail("the exact replay is already attached"),
    resumeExpiredAttempt: async (request) => {
      ownership.push(["resume", request.ownedCodexHostId]);
      return { attempt: { ...attempt, status: "started" } };
    },
    deliverInstruction: async () => ({ delivery: "observed", turnId: "turn-cap59-replay" }),
  });
  assert.equal(replay.provisioned, true);
  assert.deepEqual(ownership, [["lookup", "local"], ["resume", "local"]]);
});

for (const [lookupMode, lookupTrace] of [
  ["exact-key", ["exact-lookup"]],
  ["fallback-active", ["exact-lookup", "fallback-lookup"]],
  ["fallback-identity-drift", ["exact-lookup", "fallback-lookup"]],
]) {
  const title = lookupMode === "fallback-identity-drift"
    ? "CAP-59 Global provisioning rejects fallback-active identity drift before attempt recovery"
    : `CAP-59 Global provisioning blocks stale retirement before ${lookupMode} attempt recovery`;
  test(title, async () => {
    const projectId = `cap59-stale-${lookupMode}`;
    const staleWindow = {
      taskId: "cap59-stale-coordinator",
      label: "Stale Global Coordinator",
      role: "coordinator",
      threadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
      codexProjectId: "cap59-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/cap59-owner",
    };
    const effects = [];
    const currentFingerprint = createHash("sha256")
      .update(JSON.stringify({ projectId, revision: "a".repeat(64), ownerRootTaskId: "owner-root" }))
      .digest("hex");
    const fallbackFingerprint = createHash("sha256")
      .update(JSON.stringify({ projectId, revision: "c".repeat(64), ownerRootTaskId: "owner-root" }))
      .digest("hex");
    const mismatchedThreadSourceFingerprint = createHash("sha256")
      .update(JSON.stringify({ projectId, revision: "d".repeat(64), ownerRootTaskId: "owner-root" }))
      .digest("hex");
    const existingFingerprint = lookupMode === "exact-key" ? currentFingerprint : fallbackFingerprint;
    const attemptId = `cap59-stale-attempt-${lookupMode}`;
    const existingAttempt = () => ({
      id: attemptId,
      projectId,
      idempotencyKey: `coordinator-provision-${existingFingerprint}`,
      taskId: `coordinator-${projectId}-${existingFingerprint.slice(0, 12)}`,
      label: "Taskboard Execution Coordinator",
      threadSource: lookupMode === "fallback-identity-drift"
        ? `taskboard-coordinator-provision-${mismatchedThreadSourceFingerprint}`
        : `taskboard-coordinator-provision-${existingFingerprint}`,
      model: "gpt-5",
      reasoningEffort: "high",
      expectedRevision: lookupMode === "fallback-identity-drift"
        ? "a".repeat(64)
        : "b".repeat(64),
      ownerRootTaskId: "owner-root",
      ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
      codexProjectId: "cap59-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/cap59-owner",
      status: "started",
      threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
      retryCount: 0,
      missingSince: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const result = await runCoordinatorProvisioningMonitorOnce({
      policy: { enabled: true, projectId, model: "gpt-5", reasoningEffort: "high" },
      hostExecutor: localHostExecutor,
      readPreflight: async () => {
        effects.push("preflight");
        return cap59Preflight(
          projectId,
          "local",
          lookupMode === "fallback-identity-drift" ? [] : [staleWindow],
        );
      },
      inspectCoordinatorWindow: async (window) => {
        effects.push("inspection");
        assert.deepEqual(window, staleWindow);
        return { eligibility: "stale", reason: "archived", window };
      },
      getAttempt: async (request) => {
        if (request.idempotencyKey) {
          effects.push("exact-lookup");
          assert.equal(request.idempotencyKey, `coordinator-provision-${currentFingerprint}`);
          return { attempt: lookupMode === "exact-key" ? existingAttempt() : null };
        }
        effects.push("fallback-lookup");
        return { attempt: existingAttempt() };
      },
      requestAttempt: async () => {
        effects.push("request");
        return { attempt: null };
      },
      readDefaultModel: async () => {
        effects.push("model");
        return { model: "gpt-5", reasoningEffort: "high" };
      },
      readThread: async (attempt) => {
        effects.push("read-thread");
        return {
          id: attempt.threadId,
          cwd: attempt.workspacePath,
          threadSource: attempt.threadSource,
          turns: [],
        };
      },
      findThread: async () => {
        effects.push("find-thread");
        return null;
      },
      findArchivedThread: async () => {
        effects.push("find-archived");
        return null;
      },
      markStarting: async () => {
        effects.push("starting");
        return { attempt: existingAttempt() };
      },
      startThread: async () => {
        effects.push("start-thread");
        return null;
      },
      attachThread: async () => {
        effects.push("attach");
        return { attempt: existingAttempt() };
      },
      observeMissingAttempt: async () => {
        effects.push("observe-missing");
        return { attempt: existingAttempt() };
      },
      clearMissingAttempt: async () => {
        effects.push("clear-missing");
        return { attempt: existingAttempt() };
      },
      resumeExpiredAttempt: async () => {
        effects.push("resume-expired");
        return { attempt: existingAttempt() };
      },
      deliverInstruction: async () => {
        effects.push("deliver");
        return {
          delivery: lookupMode === "fallback-identity-drift" ? "observed" : "started",
          turnId: "turn-cap59-stale",
        };
      },
    });
    const identityDrift = lookupMode === "fallback-identity-drift";
    assert.deepEqual(
      [result, effects],
      [{
        provisioned: false,
        reason: identityDrift ? "attempt-binding-mismatch" : "stale-retirement-required",
        attemptId,
      }, [
        "preflight",
        ...(identityDrift ? [] : ["inspection"]),
        ...lookupTrace,
      ]],
    );
  });
}

function cap60DomainMonitorOptions({ projectId, hostExecutor, snapshot, effects }) {
  let attempt = null;
  const globalHolder = snapshot.taskLanes.find(
    (lane) => lane.id === snapshot.coordination.coordinatorTaskId,
  );
  return {
    policy: { enabled: true, projectId, model: "gpt-5", reasoningEffort: "high" },
    ...(hostExecutor === undefined ? {} : { hostExecutor }),
    readSnapshot: async () => {
      effects.push("snapshot");
      return snapshot;
    },
    readWindows: async () => {
      effects.push("windows");
      return { projectId, revision: "a".repeat(64) };
    },
    getAttempt: async (request) => {
      effects.push([
        request.idempotencyKey ? "exact-lookup" : "fallback-lookup",
        request.domainId,
        request.ownedCodexHostId,
      ]);
      return { attempt: attempt ? { ...attempt } : null };
    },
    requestAttempt: async (request) => {
      effects.push(["request", request.domainId, request.ownedCodexHostId]);
      const domain = snapshot.coordination.domainCoordinators.find(
        (candidate) => candidate.domainId === request.domainId,
      );
      const { ownedCodexHostId: _ownedCodexHostId, ...persistedRequest } = request;
      attempt = {
        ...persistedRequest,
        id: `attempt-${projectId}`,
        globalHolderCodexProjectId: globalHolder.codexProjectId,
        globalHolderCodexProjectKind: globalHolder.codexProjectKind,
        globalHolderCodexHostId: globalHolder.codexHostId,
        globalHolderWorkspacePath: globalHolder.workspacePath,
        writeScope: domain.writeScope,
        status: "pending",
        threadId: null,
        retryCount: 0,
        missingSince: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      return { attempt: { ...attempt } };
    },
    findThread: async () => {
      effects.push("find-thread");
      return null;
    },
    markStarting: async ({ ownedCodexHostId }) => {
      effects.push(["starting", ownedCodexHostId]);
      attempt = { ...attempt, status: "starting" };
      return { attempt: { ...attempt } };
    },
    startThread: async (settings) => {
      effects.push(["start-thread", settings.codexHostId]);
      return { thread: {
        id: "01a09999-a749-7b53-81e2-af2d477f93ae",
        cwd: settings.cwd,
        threadSource: settings.threadSource,
      } };
    },
    attachThread: async ({ threadId, ownedCodexHostId }) => {
      effects.push(["attach", ownedCodexHostId]);
      attempt = { ...attempt, status: "started", threadId };
      return { attempt: { ...attempt } };
    },
    resetAttempt: async ({ ownedCodexHostId }) => {
      effects.push(["reset", ownedCodexHostId]);
      attempt = { ...attempt, status: "pending", retryCount: attempt.retryCount + 1 };
      return { attempt: { ...attempt } };
    },
    resumeExpiredAttempt: async ({ ownedCodexHostId }) => {
      effects.push(["resume", ownedCodexHostId]);
      attempt = { ...attempt, status: "started" };
      return { attempt: { ...attempt } };
    },
    deliverInstruction: async () => {
      effects.push("deliver");
      return { delivery: "started", turnId: "turn-cap60" };
    },
  };
}

function cap60DomainSnapshot({ projectId, globalHostId, domains, lanes }) {
  return {
    projectId,
    coordination: {
      coordinatorTaskId: "global",
      lease: { id: "global-lease", status: "active", bindingValid: true },
      domainCoordinators: domains,
    },
    taskLanes: [{
      id: "global",
      source: "codex",
      taskType: "root_task",
      threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
      codexProjectId: `project-${globalHostId}`,
      codexProjectKind: globalHostId === "local" ? "local" : "remote",
      codexHostId: globalHostId,
      workspacePath: `/tmp/cap60-${globalHostId}`,
    }, ...lanes],
  };
}

function cap60DomainAttempt(snapshot, {
  revision = "a".repeat(64),
  expectedRevision = revision,
  expectedGlobalLeaseId = snapshot.coordination.lease.id,
  status = "pending",
  threadId = null,
} = {}) {
  const domain = snapshot.coordination.domainCoordinators[0];
  const lane = snapshot.taskLanes.find((candidate) => (
    candidate.id === domain.eligibleTaskIds[0]
  ));
  const globalHolder = snapshot.taskLanes.find((candidate) => (
    candidate.id === snapshot.coordination.coordinatorTaskId
  ));
  const launchLane = lane.codexProjectId ? lane : globalHolder;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    projectId: snapshot.projectId,
    revision: expectedRevision,
    domainId: domain.domainId,
    taskId: lane.id,
    globalLeaseId: expectedGlobalLeaseId,
  })).digest("hex");
  return {
    id: `attempt-${snapshot.projectId}`,
    projectId: snapshot.projectId,
    domainId: domain.domainId,
    idempotencyKey: `domain-coordinator-provision-${fingerprint}`,
    taskId: lane.id,
    label: lane.label,
    threadSource: `taskboard-domain-coordinator-provision-${fingerprint}`,
    model: "gpt-5",
    reasoningEffort: "high",
    expectedRevision,
    expectedGlobalLeaseId,
    globalHolderTaskId: globalHolder.id,
    globalHolderThreadId: globalHolder.threadId,
    globalHolderCodexProjectId: globalHolder.codexProjectId,
    globalHolderCodexProjectKind: globalHolder.codexProjectKind,
    globalHolderCodexHostId: globalHolder.codexHostId,
    globalHolderWorkspacePath: globalHolder.workspacePath,
    codexProjectId: launchLane.codexProjectId,
    codexProjectKind: launchLane.codexProjectKind,
    codexHostId: launchLane.codexHostId,
    workspacePath: launchLane.workspacePath,
    writeScope: domain.writeScope,
    status,
    threadId,
    retryCount: 0,
    missingSince: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: status === "expired"
      ? "2000-01-01T00:00:00.000Z"
      : "2099-01-01T00:00:00.000Z",
  };
}

test("CAP-60 Domain provisioning rejects invalid host executors before every callback", async () => {
  const cases = [
    ["missing", undefined],
    ["null", null],
    ["whitespace", { ownedCodexHostId: "   " }],
    ["control", { ownedCodexHostId: "bad\nhost" }],
    ["257 characters", { ownedCodexHostId: "h".repeat(257) }],
  ];
  const observed = [];
  for (const [label, hostExecutor] of cases) {
    const projectId = `cap60-invalid-${label.replaceAll(" ", "-")}`;
    const effects = [];
    const snapshot = cap60DomainSnapshot({
      projectId,
      globalHostId: "local",
      domains: [{
        domainId: "frontend",
        assignment: "unassigned",
        durableWorkPending: true,
        eligibleTaskIds: ["frontend"],
        writeScope: ["web"],
      }],
      lanes: [{
        id: "frontend", label: "Frontend Coordinator", source: "codex",
        taskType: "peer_task", threadId: "legacy-frontend-thread",
      }],
    });
    const result = await runDomainCoordinatorProvisioningMonitorOnce(
      cap60DomainMonitorOptions({ projectId, hostExecutor, snapshot, effects }),
    );
    observed.push([label, result, effects]);
  }
  assert.deepEqual(observed, cases.map(([label]) => [label, {
    provisioned: false,
    reason: "host-executor-unavailable",
  }, []]));
});

test("CAP-60 Domain provisioning skips foreign-first routes and owns the exact peer route", async () => {
  const projectId = "cap60-owned-route";
  const effects = [];
  const remoteLane = (id) => ({
    id, label: `${id} Coordinator`, source: "codex", taskType: "peer_task",
    threadId: `${id}-thread`, codexProjectId: `${id}-project`, codexProjectKind: "remote",
    codexHostId: "remote-builder", workspacePath: `/tmp/${id}`,
  });
  const localLane = {
    id: "backend-local", label: "Backend Local Coordinator", source: "codex",
    taskType: "peer_task", threadId: "backend-local-thread",
    codexProjectId: "backend-local-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/backend-local",
  };
  const snapshot = cap60DomainSnapshot({
    projectId,
    globalHostId: "remote-global",
    domains: [{
      domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["frontend-remote"], writeScope: ["web"],
    }, {
      domainId: "backend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["backend-remote", "backend-local"], writeScope: ["server"],
    }],
    lanes: [remoteLane("frontend-remote"), remoteLane("backend-remote"), localLane],
  });
  const result = await runDomainCoordinatorProvisioningMonitorOnce(
    cap60DomainMonitorOptions({ projectId, hostExecutor: localHostExecutor, snapshot, effects }),
  );
  assert.deepEqual(result, {
    provisioned: true,
    reason: "domain-thread-started",
    domainId: "backend",
    attemptId: `attempt-${projectId}`,
    threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
  });
  assert.deepEqual(effects.filter((effect) => Array.isArray(effect)), [
    ["exact-lookup", "backend", "local"],
    ["fallback-lookup", "backend", "local"],
    ["request", "backend", "local"],
    ["starting", "local"],
    ["start-thread", "local"],
    ["attach", "local"],
  ]);
  assert.equal(effects.filter((effect) => effect === "deliver").length, 1);
});

test("CAP-60 Domain provisioning skips a foreign persisted attempt and serves a later owned domain", async () => {
  const projectId = "cap60-foreign-attempt";
  const effects = [];
  const localLane = (id) => ({
    id, label: `${id} Coordinator`, source: "codex", taskType: "peer_task",
    threadId: `${id}-thread`, codexProjectId: `${id}-project`, codexProjectKind: "local",
    codexHostId: "local", workspacePath: `/tmp/${id}`,
  });
  const snapshot = cap60DomainSnapshot({
    projectId,
    globalHostId: "local",
    domains: [{
      domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["frontend"], writeScope: ["web"],
    }, {
      domainId: "backend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["backend"], writeScope: ["server"],
    }],
    lanes: [localLane("frontend"), localLane("backend")],
  });
  const foreignAttempt = {
    ...cap60DomainAttempt(snapshot),
    idempotencyKey: `domain-coordinator-provision-${"f".repeat(64)}`,
    threadSource: `taskboard-domain-coordinator-provision-${"f".repeat(64)}`,
    codexProjectId: "foreign-project",
    codexProjectKind: "remote",
    codexHostId: "remote-builder",
    workspacePath: "/tmp/cap60-foreign-attempt",
    expiresAt: "2000-01-01T00:00:00.000Z",
  };
  const foreignAttemptBefore = structuredClone(foreignAttempt);
  const options = cap60DomainMonitorOptions({
    projectId, hostExecutor: localHostExecutor, snapshot, effects,
  });
  const getOwnedAttempt = options.getAttempt;
  options.getAttempt = async (request) => {
    if (request.domainId !== "frontend") return getOwnedAttempt(request);
    effects.push([
      request.idempotencyKey ? "exact-lookup" : "fallback-lookup",
      request.domainId,
      request.ownedCodexHostId,
    ]);
    const persistedAttempt = request.idempotencyKey
      && request.idempotencyKey !== foreignAttempt.idempotencyKey
      ? null
      : foreignAttempt;
    if (!persistedAttempt) {
      return coordinatorProvisioningResponseJson(new Response(
        JSON.stringify({ attempt: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }
    const response = persistedAttempt.codexHostId === request.ownedCodexHostId
      ? new Response(
        JSON.stringify({ attempt: persistedAttempt }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
      : new Response(
        JSON.stringify({ error: { code: "HOST_EXECUTOR_MISMATCH" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    return coordinatorProvisioningResponseJson(response);
  };
  const result = await runDomainCoordinatorProvisioningMonitorOnce(options);
  assert.deepEqual(result, {
    provisioned: true,
    reason: "domain-thread-started",
    domainId: "backend",
    attemptId: `attempt-${projectId}`,
    threadId: "01a09999-a749-7b53-81e2-af2d477f93ae",
  });
  assert.deepEqual(foreignAttempt, foreignAttemptBefore);
  assert.deepEqual(effects.filter((effect) => Array.isArray(effect)), [
    ["exact-lookup", "frontend", "local"],
    ["fallback-lookup", "frontend", "local"],
    ["exact-lookup", "backend", "local"],
    ["fallback-lookup", "backend", "local"],
    ["request", "backend", "local"],
    ["starting", "local"],
    ["start-thread", "local"],
    ["attach", "local"],
  ]);
  assert.equal(effects.filter((effect) => effect === "deliver").length, 1);
});

test("CAP-60 Domain provisioning never skips a different provisioning failure", async () => {
  for (const [status, code] of [
    [409, "DOMAIN_COORDINATOR_PROVISIONING_REVISION_CONFLICT"],
    [503, "HOST_EXECUTOR_MISMATCH"],
  ]) {
    const projectId = `cap60-nonskippable-${status}`;
    const effects = [];
    const snapshot = cap60DomainSnapshot({
      projectId,
      globalHostId: "local",
      domains: [{
        domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
        eligibleTaskIds: ["frontend"], writeScope: ["web"],
      }, {
        domainId: "backend", assignment: "unassigned", durableWorkPending: true,
        eligibleTaskIds: ["backend"], writeScope: ["server"],
      }],
      lanes: ["frontend", "backend"].map((id) => ({
        id, label: `${id} Coordinator`, source: "codex", taskType: "peer_task",
        threadId: `${id}-thread`, codexProjectId: `${id}-project`, codexProjectKind: "local",
        codexHostId: "local", workspacePath: `/tmp/${id}`,
      })),
    });
    const options = cap60DomainMonitorOptions({
      projectId, hostExecutor: localHostExecutor, snapshot, effects,
    });
    options.getAttempt = async (request) => {
      effects.push([
        request.idempotencyKey ? "exact-lookup" : "fallback-lookup",
        request.domainId,
        request.ownedCodexHostId,
      ]);
      if (request.idempotencyKey) return { attempt: null };
      return coordinatorProvisioningResponseJson(new Response(
        JSON.stringify({ error: { code } }),
        { status, headers: { "content-type": "application/json" } },
      ));
    };
    await assert.rejects(
      runDomainCoordinatorProvisioningMonitorOnce(options),
      (error) => error?.status === status && error?.code === code,
    );
    assert.deepEqual(effects, [
      "snapshot",
      "windows",
      ["exact-lookup", "frontend", "local"],
      ["fallback-lookup", "frontend", "local"],
    ]);
  }
});

test("CAP-60 Domain provisioning uses the Global host only for an unbound peer fallback", async () => {
  const projectId = "cap60-fallback-route";
  const snapshot = cap60DomainSnapshot({
    projectId,
    globalHostId: "remote-builder",
    domains: [{
      domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["frontend"], writeScope: ["web"],
    }],
    lanes: [{
      id: "frontend", label: "Frontend Coordinator", source: "codex",
      taskType: "peer_task", threadId: "legacy-frontend-thread",
    }],
  });
  const localEffects = [];
  const local = await runDomainCoordinatorProvisioningMonitorOnce(
    cap60DomainMonitorOptions({ projectId, hostExecutor: localHostExecutor, snapshot, effects: localEffects }),
  );
  assert.deepEqual(local, { provisioned: false, reason: "host-executor-unavailable" });
  assert.deepEqual(localEffects, ["snapshot", "windows"]);

  const remoteEffects = [];
  const remote = await runDomainCoordinatorProvisioningMonitorOnce(
    cap60DomainMonitorOptions({ projectId, hostExecutor: remoteHostExecutor, snapshot, effects: remoteEffects }),
  );
  assert.equal(remote.provisioned, true);
  assert.deepEqual(remoteEffects.filter((effect) => Array.isArray(effect)), [
    ["exact-lookup", "frontend", "remote-builder"],
    ["fallback-lookup", "frontend", "remote-builder"],
    ["request", "frontend", "remote-builder"],
    ["starting", "remote-builder"],
    ["start-thread", "remote-builder"],
    ["attach", "remote-builder"],
  ]);
});

test("CAP-60 Domain provisioning single-flight is scoped by exact host and project", async () => {
  let enteredLocal;
  const localEntered = new Promise((resolve) => { enteredLocal = resolve; });
  let releaseLocal;
  const localRelease = new Promise((resolve) => { releaseLocal = resolve; });
  const observedHosts = [];
  const makeOptions = (hostExecutor, block) => {
    const projectId = "cap60-host-flight";
    const effects = [];
    const snapshot = cap60DomainSnapshot({
      projectId,
      globalHostId: hostExecutor.ownedCodexHostId,
      domains: [],
      lanes: [],
    });
    const options = cap60DomainMonitorOptions({ projectId, hostExecutor, snapshot, effects });
    options.readSnapshot = async () => {
      observedHosts.push(hostExecutor.ownedCodexHostId);
      if (block) {
        enteredLocal();
        await localRelease;
      }
      return snapshot;
    };
    return options;
  };
  const local = runDomainCoordinatorProvisioningMonitorOnce(makeOptions(localHostExecutor, true));
  await localEntered;
  const remote = runDomainCoordinatorProvisioningMonitorOnce(makeOptions(remoteHostExecutor, false));
  releaseLocal();
  const results = await Promise.all([local, remote]);
  assert.deepEqual(observedHosts, ["local", "remote-builder"]);
  assert.deepEqual(results, [
    { provisioned: false, reason: "no-domain-work" },
    { provisioned: false, reason: "no-domain-work" },
  ]);
});

test("CAP-60 Domain provisioning rejects immutable drift after every durable transition", async () => {
  const domainThreadId = "01a09999-a749-7b53-81e2-af2d477f93ae";
  const cases = ["request", "rebind", "starting", "reset", "attach", "resume"];
  for (const action of cases) {
    const projectId = `cap60-envelope-${action}`;
    const snapshot = cap60DomainSnapshot({
      projectId,
      globalHostId: "local",
      domains: [{
        domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
        eligibleTaskIds: ["frontend"], writeScope: ["web"],
      }],
      lanes: [{
        id: "frontend", label: "Frontend Coordinator", source: "codex",
        taskType: "peer_task", threadId: "frontend-template-thread",
        codexProjectId: "frontend-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/cap60-envelope-frontend",
      }],
    });
    const effects = [];
    const currentRevision = "a".repeat(64);
    let attempt = action === "request"
      ? null
      : cap60DomainAttempt(snapshot, action === "rebind" ? {
        expectedRevision: "b".repeat(64),
        expectedGlobalLeaseId: "previous-global-lease",
        status: "started",
        threadId: domainThreadId,
      } : action === "resume" ? {
        status: "expired", threadId: domainThreadId,
      } : {});
    const drift = (candidate) => ({ ...candidate, label: "Drifted Coordinator" });
    const result = await runDomainCoordinatorProvisioningMonitorOnce({
      hostExecutor: localHostExecutor,
      policy: { enabled: true, projectId, model: "gpt-5", reasoningEffort: "high" },
      readSnapshot: async () => snapshot,
      readWindows: async () => ({ projectId, revision: currentRevision }),
      getAttempt: async ({ idempotencyKey }) => {
        if (action === "request") return { attempt: null };
        if (action === "rebind" && idempotencyKey) return { attempt: null };
        return { attempt: { ...attempt } };
      },
      requestAttempt: async () => {
        effects.push("request");
        attempt = cap60DomainAttempt(snapshot);
        return { attempt: drift(attempt) };
      },
      rebindAttempt: async ({ expectedRevision, expectedGlobalLeaseId }) => {
        effects.push("rebind");
        attempt = { ...attempt, expectedRevision, expectedGlobalLeaseId };
        return { attempt: drift(attempt) };
      },
      findThread: async () => {
        effects.push("find-thread");
        return null;
      },
      readThread: async () => {
        effects.push("read-thread");
        return {
          id: domainThreadId,
          cwd: attempt.workspacePath,
          threadSource: attempt.threadSource,
          turns: [{
            id: "cap60-envelope-turn",
            status: "completed",
            input: `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${attempt.id}`,
          }],
        };
      },
      markStarting: async () => {
        effects.push("starting");
        attempt = { ...attempt, status: "starting" };
        return { attempt: action === "starting" ? drift(attempt) : { ...attempt } };
      },
      startThread: async () => {
        effects.push("start-thread");
        if (action === "reset") {
          throw new Error("Selected model is at capacity. Please try a different model.");
        }
        return { thread: {
          id: domainThreadId,
          cwd: attempt.workspacePath,
          threadSource: attempt.threadSource,
        } };
      },
      resetAttempt: async () => {
        effects.push("reset");
        attempt = { ...attempt, status: "pending", retryCount: attempt.retryCount + 1 };
        return { attempt: drift(attempt) };
      },
      attachThread: async ({ threadId }) => {
        effects.push("attach");
        attempt = { ...attempt, status: "started", threadId };
        return { attempt: action === "attach" ? drift(attempt) : { ...attempt } };
      },
      resumeExpiredAttempt: async () => {
        effects.push("resume");
        attempt = { ...attempt, status: "started", expiresAt: "2099-01-01T00:00:00.000Z" };
        return { attempt: drift(attempt) };
      },
      deliverInstruction: async () => {
        effects.push("deliver");
        return { delivery: "started", turnId: "cap60-envelope-turn" };
      },
    });
    assert.equal(result.reason, "attempt-binding-mismatch", `${action}: ${JSON.stringify(result)}`);
    assert.equal(effects.at(-1), action, `${action}: ${JSON.stringify(effects)}`);
    assert.equal(effects.includes("deliver"), false, action);
  }
});

test("CAP-60 Domain provisioning never falls back from a partially bound peer route", async () => {
  const projectId = "cap60-partial-route";
  const effects = [];
  const snapshot = cap60DomainSnapshot({
    projectId,
    globalHostId: "local",
    domains: [{
      domainId: "frontend", assignment: "unassigned", durableWorkPending: true,
      eligibleTaskIds: ["frontend"], writeScope: ["web"],
    }],
    lanes: [{
      id: "frontend", label: "Frontend Coordinator", source: "codex",
      taskType: "peer_task", threadId: "frontend-template-thread",
      codexProjectId: "partial-project",
    }],
  });
  const result = await runDomainCoordinatorProvisioningMonitorOnce(
    cap60DomainMonitorOptions({
      projectId, hostExecutor: localHostExecutor, snapshot, effects,
    }),
  );
  assert.deepEqual(result, {
    provisioned: false, reason: "domain-route-unavailable", domainId: "frontend",
  });
  assert.deepEqual(effects, ["snapshot", "windows"]);
});
