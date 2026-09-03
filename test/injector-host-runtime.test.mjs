import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  classifyOwnerIntentPlanHttpFailure,
  classifyCoordinatorProvisioningActiveThread,
  coordinatorProvisioningThreadListData,
  coordinatorThreadSelectionConfirmed,
  createOpenGenerationRouteResolver,
  createSerializedMonitorTick,
  deliverTaskboardCoordination,
  deliverTaskboardCrossDomainHandoff,
  deliverTaskboardOwnerDecision,
  deliverTaskboardOwnerIntent,
  findResidentInjectorPids,
  handleHostBindingPayload,
  loadResidentCoordinatorMonitorProjects,
  observeTaskboardOwnerDecision,
  observeTaskboardOwnerIntentCapture,
  observeTaskboardOwnerIntentPlan,
  reconcileInjectionRuntime,
  runOwnerDecisionMonitorOnce,
  runOwnerIntentAdoptionMonitorOnce,
  runOwnerIntentCaptureMonitorOnce,
  runOwnerIntentPlanningMonitorOnce,
  runBackgroundCoordinatorIdentityHandshakeMonitorOnce,
  runCoordinatorLeaseKeepaliveMonitorOnce,
  runCoordinatorLeaseRecoveryMonitorOnce,
  runCoordinatorProvisioningMonitorOnce,
  runCoordinatorShutdownMonitorOnce,
  runCrossDomainHandoffMonitorOnce,
  runTaskboardProjectMonitorSequence,
  runTaskboardContinuationMonitorOnce,
  restartResidentInjector,
  selectResidentCoordinatorMonitorProjects,
  selectLaunchCoordinatorRoute,
} from "../scripts/codex-injector-runtime.mjs";

const coordinatorThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";

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
    thread: { id: coordinatorThreadId, cwd: "/Users/v-sheng.huang/sboai", turns: [] },
    activeThreads: [{ id: coordinatorThreadId }],
  }), {
    eligibility: "stale",
    reason: "active-thread-binding-drift",
    window,
  });
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

test("background Coordinator identity handshake verifies the exact host thread without changing foreground focus", async () => {
  const confirmations = [];
  const result = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "local",
    listHandshakes: async () => ({ handshakes: [{
      id: "handshake-1", role: "coordinator", threadId: coordinatorThreadId,
      registration: {
        projectId: "local", role: "coordinator", taskId: "coordinator-task",
        label: "Coordinator", threadId: coordinatorThreadId,
        expectedRevision: "a".repeat(64), idempotencyKey: "handshake-1",
      },
      expectedHostBinding: {
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      },
    }] }),
    readThread: async ({ threadId, codexHostId }) => {
      assert.equal(threadId, coordinatorThreadId);
      assert.equal(codexHostId, "local");
      return { thread: { id: threadId, cwd: "/tmp/sbkk" } };
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
    codexHostId: "local", workspacePath: "/tmp/sbkk",
  } }]);

  const wrongWorkspace = await runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
    projectId: "local",
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

function coordinatorKeepaliveSnapshot({ expiresAt, domainExpiresAt = expiresAt } = {}) {
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
        codexHostId: "host-global",
        workspacePath: "/tmp/taskboard/global",
      },
      {
        id: "frontend",
        threadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
        codexHostId: "host-frontend",
        workspacePath: "/tmp/taskboard/frontend",
      },
    ],
  };
}

test("coordinator keepalive renews exact near-expiry Global and domain leases independently", async () => {
  const renewed = [];
  const now = Date.parse("2026-08-31T01:00:00.000Z");
  const result = await runCoordinatorLeaseKeepaliveMonitorOnce({
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
      assert.equal(request.ownerRootWorkspacePath, owner.workspacePath);
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
  const options = {
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
      projectId: "capstone-dev", revision: "d".repeat(64), ownerRootTaskId: owner.taskId,
      windows: [{ ...owner, role: "owner_root" }, stale],
    }),
    inspectCoordinatorWindow: async (window) => {
      assert.deepEqual(window, stale);
      return { eligibility: "stale", reason: "archived", window };
    },
    getAttempt: async () => ({ attempt: attempt ? { ...attempt } : null }),
    requestAttempt: async (request) => {
      requests += 1;
      assert.deepEqual(request.retireCoordinatorWindows, [stale]);
      attempt ??= { ...request, id: "attempt-stale", status: "pending", threadId: null };
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
  const result = await runCoordinatorProvisioningMonitorOnce({
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
      projectId: "capstone-dev", revision: "9".repeat(64), ownerRootTaskId: owner.taskId,
      coordinatorLease: {
        id: "released-lease", holderTaskId: "retired-coordinator",
        holderThreadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
        acquiredAt: "2026-09-02T22:50:00.000Z", expiresAt: "2026-09-02T22:55:00.000Z",
        releasedAt: "2026-09-02T22:55:00.000Z",
      },
      durableWorkPending: true,
      ownerRootValid: true,
      shutdownAttempt: null,
      windows: [{ ...owner, label: "Owner Root", role: "owner_root" }, stale],
    }),
    inspectCoordinatorWindow: async (window) => {
      inspections += 1;
      return { eligibility: "stale", reason: "missing", window };
    },
    getAttempt: async () => ({ attempt: null }),
    requestAttempt: async (request) => {
      attempts += 1;
      assert.deepEqual(request.retireCoordinatorWindows, [stale]);
      attempt = {
        ...request, id: "attempt-invalid-stale", status: "pending", threadId: null,
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
  rootWorkspacePath: "/tmp/taskboard/project",
  deliveryReceipt: {
    id: "coordination-receipt",
    reservationLeaseId: "reservation-lease",
    admissionAttemptId: "admission-attempt",
  },
};
const deliverCoordination = (request, rpc, validateExecutionTarget = async () => {}) => (
  deliverTaskboardCoordination(request, rpc, validateExecutionTarget)
);
const confirmedIdentity = {
  worktreePath: "/tmp/taskboard/project",
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
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [{ id: "push", text: "Push later" }],
      resumeToken: "b".repeat(64),
    },
  };
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [todo] }),
    claimReceipt: async (claim) => {
      assert.deepEqual(claim, {
        todoId: todo.id,
        taskId: todo.taskId,
        rootThreadId: todo.dispatchTarget.rootThreadId,
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
    rootThreadId: todo.dispatchTarget.rootThreadId,
    codexHostId: "local",
    rootWorkspacePath: "/tmp/taskboard/project",
    targetRoot: "/tmp/taskboard/project",
    safeActionId: "safe-first",
    expectedResumeToken: "b".repeat(64),
    deliveryReceipt: { id: "receipt", reservationLeaseId: "lease" },
    observeOnly: false,
    executionIdentity: { ...confirmedIdentity, standingAuthority: false },
  });
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
      return { delivery: "steered", turnId: "turn-recovery" };
    },
    reconcileAdmission: async () => {
      calls.push("reconcile");
      return {
        outcome: "present",
        receipt: {
          admissionState: "recovery_confirmed",
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
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: { ownerDecisionRequest: request },
    }),
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
      if (method === "turn/start") return { turn: { id: "turn-adopt" } };
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
  };
  const plan = { revisionId: "invalid-cache-plan" };
  let applies = 0;
  const retries = [];
  let currentRequest = request;
  let currentPlan = plan;
  const options = {
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
        if (method === "turn/start") return { turn: { id: "handoff-turn" } };
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
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let claims = 0;
  let deliveries = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
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
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/old-root",
    },
  };
  let delivered = 0;
  const result = await runOwnerDecisionMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
    claimDelivery: async () => ({ claimed: false, reason: "stale-route" }),
    deliver: async () => { delivered += 1; },
    confirmDelivery: async () => assert.fail("stale route must not confirm"),
    observeDecision: async () => assert.fail("stale route must not be observed"),
    recordDecision: async () => assert.fail("stale route must not record"),
  });
  assert.deepEqual(result, { delivered: false, reason: "stale-route" });
  assert.equal(delivered, 0);
});

test("a durable delivered request is recorded only from the exact Root observation", async () => {
  const request = {
    requestId: "5".repeat(64), expectedResumeToken: "4".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let recorded;
  const result = await runOwnerDecisionMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
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

test("the resident authenticated host polls durable opt-in policies without the Agent Lanes view", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(source, /taskboard:background-continuation:policy:/);
  assert.match(source, /api\/client-storage/);
  assert.match(source, /api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-claim/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-delivery/);
  assert.match(source, /validateGitExecutionTarget/);
  assert.match(source, /runTaskboardContinuationMonitorOnce/);
  assert.match(source, /deliverTaskboardCoordination/);
  assert.match(source, /runCoordinatorProvisioningMonitorOnce/);
  assert.match(source, /coordinator-provisioning-attempts/);
  assert.match(source, /"thread\/list"/);
  assert.match(source, /"thread\/start"/);
  assert.match(source, /TASKBOARD_COORDINATOR_PROVISIONING_V1/);
  assert.doesNotMatch(source, /background-continuation-receipts/);
  assert.match(source, /setInterval\(\(\) => void tick\(\), backgroundContinuationIntervalMs\)/);
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
    targetRoot: "/tmp/capstone-execution-worktree",
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
  const instruction = calls.find(([method]) => method === "turn/start")?.[1]?.input?.[0]?.text ?? "";
  assert.match(instruction, /Exact execution worktree: \/tmp\/capstone-execution-worktree/);
  assert.match(instruction, /coordination cwd may be different/);
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
