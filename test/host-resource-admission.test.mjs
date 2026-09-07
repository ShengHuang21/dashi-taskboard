import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHostResourceObserver,
  parseLinuxMemoryInfo,
  parseMacMemoryPressure,
} from "../scripts/host-resource-observer.mjs";
import {
  evaluateHostResourceAdmission,
  runTaskboardContinuationFastLane,
  runTaskboardContinuationMonitorOnce,
} from "../scripts/codex-injector-runtime.mjs";

const GIB = 1024 ** 3;
const observedAt = "2026-09-07T00:00:30.000Z";
const observedAtMs = Date.parse(observedAt);
const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";

const hostPolicy = Object.freeze({
  enabled: true,
  localHostId: "local",
  observationMaxAgeMs: 60_000,
  targetCpuRatio: 0.8,
  criticalCpuRatio: 1,
  memoryReserveRatio: 0.2,
  criticalMemoryRatio: 0.1,
  minimumMemoryReserveBytes: 2 * GIB,
  memoryPerAgentBytes: GIB,
  cpuPerAgent: 1,
});

function cpuSample(idle, user, sys = 0) {
  return [{
    model: "fixture",
    speed: 1000,
    times: { idle, user, sys, nice: 0, irq: 0 },
  }];
}

function observation({
  hostId = "local",
  timestamp = observedAt,
  cpuRatio = 0.25,
  memoryRatio = 0.5,
  sampleWindowMs = 15_000,
} = {}) {
  const totalBytes = 16 * GIB;
  return {
    schemaVersion: 1,
    source: "resident-injector",
    hostId,
    observedAt: timestamp,
    platform: "linux",
    cpu: {
      capacity: 8,
      busyRatio: cpuRatio,
      sampleWindowMs,
    },
    memory: {
      totalBytes,
      availableBytes: Math.round(totalBytes * memoryRatio),
      availableRatio: memoryRatio,
      source: "linux-meminfo",
    },
  };
}

function monitorFixture({
  hostObservation = observation(),
  targetHostId = "local",
  active = 0,
  projectId = "taskboard-core",
  todoId = "CAP-54",
  taskId = "28cf5799-a245-4f54-b772-0aa2acf16e35",
  fixtureRootThreadId = rootThreadId,
  hostResourceAdmissionBudget = new Map(),
  todoOverrides = {},
} = {}) {
  const calls = { observe: 0, claim: 0, confirm: 0, deliver: 0, complete: 0 };
  const todo = {
    id: todoId,
    taskId,
    run: null,
    dispatchTarget: {
      rootThreadId: fixtureRootThreadId,
      codexHostId: targetHostId,
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-resource-admission", text: "Continue queued work" }],
      deferredActions: [],
      resumeToken: "a".repeat(64),
    },
    ...todoOverrides,
  };
  return {
    calls,
    todo,
    options: {
      policy: {
        enabled: true,
        projectId,
        maxActiveAgents: 4,
        capacityObservationMaxAgeMs: 60_000,
        hostResourceAdmission: hostPolicy,
      },
      now: () => observedAtMs,
      hostResourceAdmissionBudget,
      readSnapshot: async () => ({
        projectId,
        todos: [todo],
        windowSubagentTrees: [{
          rootThreadId: fixtureRootThreadId,
          observed: true,
          summary: { active },
          capacityObservation: { source: "list_agents", observedAt },
        }],
      }),
      readHostResourceObservation: async () => {
        calls.observe += 1;
        return hostObservation;
      },
      claimReceipt: async () => {
        calls.claim += 1;
        return {
          available: true,
          completed: false,
          receipt: {
            id: "receipt-cap54",
            reservationLeaseId: "lease-cap54",
            admissionAttemptId: "attempt-cap54",
          },
        };
      },
      confirmDelivery: async () => {
        calls.confirm += 1;
        return { worktreePath: "/tmp/taskboard/project", branch: "codex/cap54" };
      },
      deliver: async () => {
        calls.deliver += 1;
        return { delivery: "started", turnId: "turn-cap54" };
      },
      completeDelivery: async () => {
        calls.complete += 1;
        return { completed: true };
      },
    },
  };
}

test("host observer parses effective available memory on macOS and Linux", () => {
  assert.deepEqual(parseMacMemoryPressure([
    "The system has 17179869184 (1048576 pages with a page size of 16384).",
    "System-wide memory free percentage: 41%",
  ].join("\n")), {
    totalBytes: 17179869184,
    availableBytes: 7043746365,
    availableRatio: 0.41,
    source: "macos-memory-pressure",
  });

  assert.deepEqual(parseLinuxMemoryInfo([
    "MemTotal:       16384000 kB",
    "MemFree:          128000 kB",
    "MemAvailable:    6291456 kB",
  ].join("\n")), {
    totalBytes: 16777216000,
    availableBytes: 6442450944,
    availableRatio: 0.384,
    source: "linux-meminfo",
  });
});

test("host observer warms one CPU interval, caches bursts, and reports Windows memory", () => {
  let now = observedAtMs;
  let cpuIndex = 0;
  const samples = [cpuSample(100, 100), cpuSample(150, 150)];
  const observer = createHostResourceObserver({
    hostId: "local",
    now: () => now,
    platform: () => "win32",
    readCpuInfo: () => samples[Math.min(cpuIndex++, samples.length - 1)],
    readCpuCapacity: () => 1,
    readTotalMemory: () => 8 * GIB,
    readFreeMemory: () => 3 * GIB,
    minimumSampleIntervalMs: 5_000,
  });

  const warming = observer();
  assert.equal(warming.cpu.busyRatio, null);
  assert.equal(warming.cpu.sampleWindowMs, null);
  assert.equal(warming.memory.source, "windows-os-freemem");
  assert.equal(observer(), warming);
  assert.equal(cpuIndex, 1);

  now += 15_000;
  const sampled = observer();
  assert.equal(sampled.cpu.capacity, 1);
  assert.equal(sampled.cpu.busyRatio, 0.5);
  assert.equal(sampled.cpu.sampleWindowMs, 15_000);
  assert.equal(sampled.memory.availableRatio, 0.375);
  assert.equal(cpuIndex, 2);
});

test("host resource admission takes the minimum CPU and memory headroom", () => {
  assert.deepEqual(evaluateHostResourceAdmission({
    target: { codexHostId: "local" },
    policy: hostPolicy,
    observation: observation(),
    observedAtMs,
  }), {
    available: true,
    applied: true,
    pressure: "healthy",
    cpuHeadroomAgents: 4,
    memoryHeadroomAgents: 4,
    headroomAgents: 4,
  });

  assert.deepEqual(evaluateHostResourceAdmission({
    target: { codexHostId: "local" },
    policy: hostPolicy,
    observation: observation({ cpuRatio: 0.85 }),
    observedAtMs,
  }), {
    available: false,
    applied: true,
    reason: "waiting-host-resources",
    pressure: "warning",
    cpuHeadroomAgents: 0,
    memoryHeadroomAgents: 4,
    headroomAgents: 0,
  });

  assert.equal(evaluateHostResourceAdmission({
    target: { codexHostId: "local" },
    policy: hostPolicy,
    observation: observation({ memoryRatio: 0.05 }),
    observedAtMs,
  }).pressure, "critical");
});

test("continuation queues under CPU or memory pressure and resumes when healthy", async () => {
  const fixture = monitorFixture({ hostObservation: observation({ memoryRatio: 0.15 }) });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.deepEqual(fixture.calls, { observe: 1, claim: 0, confirm: 0, deliver: 0, complete: 0 });

  fixture.options.readHostResourceObservation = async () => {
    fixture.calls.observe += 1;
    return observation();
  };
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
    delivered: true,
    todoId: "CAP-54",
    actionId: "safe-resource-admission",
  });
  assert.deepEqual(fixture.calls, { observe: 2, claim: 1, confirm: 1, deliver: 1, complete: 1 });

  const cpuFixture = monitorFixture({ hostObservation: observation({ cpuRatio: 0.9 }) });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(cpuFixture.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.equal(cpuFixture.calls.claim, 0);
});

test("one resident tick atomically shares the final host slot across projects", async () => {
  const sharedBudget = new Map();
  const tightObservation = observation({ cpuRatio: 0.67 });
  const first = monitorFixture({
    projectId: "taskboard-project-a",
    todoId: "CAP-54-A",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e36",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
    hostObservation: tightObservation,
    hostResourceAdmissionBudget: sharedBudget,
  });
  const second = monitorFixture({
    projectId: "taskboard-project-b",
    todoId: "CAP-54-B",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e37",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b0",
    hostObservation: tightObservation,
    hostResourceAdmissionBudget: sharedBudget,
  });
  let releaseFirstClaim;
  let firstClaimStarted;
  const firstClaimEntered = new Promise((resolve) => { firstClaimStarted = resolve; });
  const holdFirstClaim = new Promise((resolve) => { releaseFirstClaim = resolve; });
  first.options.claimReceipt = async () => {
    first.calls.claim += 1;
    firstClaimStarted();
    await holdFirstClaim;
    return {
      available: true,
      completed: false,
      receipt: {
        id: "receipt-cap54-a",
        reservationLeaseId: "lease-cap54-a",
        admissionAttemptId: "attempt-cap54-a",
      },
    };
  };

  const firstRun = runTaskboardContinuationMonitorOnce(first.options);
  await firstClaimEntered;
  const secondResult = await runTaskboardContinuationMonitorOnce(second.options);
  releaseFirstClaim();
  const firstResult = await firstRun;

  assert.deepEqual(firstResult, {
    delivered: true,
    todoId: "CAP-54-A",
    actionId: "safe-resource-admission",
  });
  assert.equal(first.calls.claim + second.calls.claim, 1);
  assert.equal(first.calls.deliver + second.calls.deliver, 1);
  assert.deepEqual(secondResult, {
    delivered: false,
    reason: "waiting-host-resources",
  });
});

test("one resident tick also shares the final observed Agent slot across projects", async () => {
  const sharedBudget = new Map();
  const first = monitorFixture({
    projectId: "agent-slot-project-a",
    todoId: "CAP-54-C",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e38",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b1",
    active: 2,
    hostResourceAdmissionBudget: sharedBudget,
  });
  const second = monitorFixture({
    projectId: "agent-slot-project-b",
    todoId: "CAP-54-D",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e39",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b2",
    active: 2,
    hostResourceAdmissionBudget: sharedBudget,
  });

  assert.equal((await runTaskboardContinuationMonitorOnce(first.options)).delivered, true);
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(second.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.equal(first.calls.claim + second.calls.claim, 1);
});

test("a successful steer keeps the final host slot reserved for the tick", async () => {
  const sharedBudget = new Map();
  const first = monitorFixture({
    projectId: "steered-project-a",
    todoId: "CAP-54-I",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3e",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b7",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  const second = monitorFixture({
    projectId: "steered-project-b",
    todoId: "CAP-54-J",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3f",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b8",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  first.options.deliver = async () => {
    first.calls.deliver += 1;
    return { delivery: "steered", turnId: "turn-cap54-steered" };
  };

  assert.equal((await runTaskboardContinuationMonitorOnce(first.options)).delivered, true);
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(second.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.equal(first.calls.claim + second.calls.claim, 1);
  assert.equal(first.calls.deliver + second.calls.deliver, 1);
});

test("unknown or malformed delivery status conservatively holds the tick budget", async () => {
  const cases = [
    ["unknown", { delivery: "future-status", turnId: "turn-cap54-unknown" }],
    ["malformed", { turnId: "turn-cap54-malformed" }],
  ];
  for (const [suffix, delivery] of cases) {
    const sharedBudget = new Map();
    const first = monitorFixture({
      projectId: `unknown-project-${suffix}-a`,
      todoId: `CAP-54-${suffix}-A`,
      taskId: suffix === "unknown"
        ? "28cf5799-a245-4f54-b772-0aa2acf16e40"
        : "28cf5799-a245-4f54-b772-0aa2acf16e41",
      fixtureRootThreadId: suffix === "unknown"
        ? "01a004bd-a749-7b53-81e2-af2d477f93b9"
        : "01a004bd-a749-7b53-81e2-af2d477f93ba",
      hostObservation: observation({ cpuRatio: 0.67 }),
      hostResourceAdmissionBudget: sharedBudget,
    });
    const second = monitorFixture({
      projectId: `unknown-project-${suffix}-b`,
      todoId: `CAP-54-${suffix}-B`,
      taskId: suffix === "unknown"
        ? "28cf5799-a245-4f54-b772-0aa2acf16e42"
        : "28cf5799-a245-4f54-b772-0aa2acf16e43",
      fixtureRootThreadId: suffix === "unknown"
        ? "01a004bd-a749-7b53-81e2-af2d477f93bb"
        : "01a004bd-a749-7b53-81e2-af2d477f93bc",
      hostObservation: observation({ cpuRatio: 0.67 }),
      hostResourceAdmissionBudget: sharedBudget,
    });
    first.options.deliver = async () => {
      first.calls.deliver += 1;
      return delivery;
    };

    assert.equal((await runTaskboardContinuationMonitorOnce(first.options)).delivered, true);
    assert.deepEqual(await runTaskboardContinuationMonitorOnce(second.options), {
      delivered: false,
      reason: "waiting-host-resources",
    });
    assert.equal(second.calls.claim, 0);
  }
});

test("definitely unstarted admissions release the shared tick budget", async () => {
  const sharedBudget = new Map();
  const first = monitorFixture({
    projectId: "deferred-project-a",
    todoId: "CAP-54-E",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3a",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b3",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  const second = monitorFixture({
    projectId: "deferred-project-b",
    todoId: "CAP-54-F",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3b",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b4",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  first.options.deliver = async () => {
    first.calls.deliver += 1;
    throw new Error("Selected model is at capacity. Please try a different model.");
  };
  first.options.deferAdmission = async () => ({
    receipt: { admissionState: "deferred" },
  });

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(first.options), {
    delivered: false,
    todoId: "CAP-54-E",
    actionId: "safe-resource-admission",
    reason: "model-capacity-deferred",
  });
  assert.equal((await runTaskboardContinuationMonitorOnce(second.options)).delivered, true);
  assert.equal(second.calls.claim, 1);
  assert.equal(second.calls.deliver, 1);
});

test("only observed and observe-only not-observed statuses release without a start", async () => {
  for (const [suffix, deliveryStatus, observeOnly] of [
    ["observed", "observed", false],
    ["not-observed", "not-observed", true],
  ]) {
    const sharedBudget = new Map();
    const first = monitorFixture({
      projectId: `no-start-${suffix}-a`,
      todoId: `CAP-54-${suffix}-A`,
      taskId: suffix === "observed"
        ? "28cf5799-a245-4f54-b772-0aa2acf16e44"
        : "28cf5799-a245-4f54-b772-0aa2acf16e45",
      fixtureRootThreadId: suffix === "observed"
        ? "01a004bd-a749-7b53-81e2-af2d477f93bd"
        : "01a004bd-a749-7b53-81e2-af2d477f93be",
      hostObservation: observation({ cpuRatio: 0.67 }),
      hostResourceAdmissionBudget: sharedBudget,
    });
    const second = monitorFixture({
      projectId: `no-start-${suffix}-b`,
      todoId: `CAP-54-${suffix}-B`,
      taskId: suffix === "observed"
        ? "28cf5799-a245-4f54-b772-0aa2acf16e46"
        : "28cf5799-a245-4f54-b772-0aa2acf16e47",
      fixtureRootThreadId: suffix === "observed"
        ? "01a004bd-a749-7b53-81e2-af2d477f93bf"
        : "01a004bd-a749-7b53-81e2-af2d477f93c0",
      hostObservation: observation({ cpuRatio: 0.67 }),
      hostResourceAdmissionBudget: sharedBudget,
    });
    first.options.claimReceipt = async () => {
      first.calls.claim += 1;
      return {
        available: true,
        completed: false,
        observeOnly,
        receipt: {
          id: `receipt-cap54-${suffix}`,
          reservationLeaseId: `lease-cap54-${suffix}`,
          admissionAttemptId: `attempt-cap54-${suffix}`,
        },
      };
    };
    first.options.deliver = async () => {
      first.calls.deliver += 1;
      return { delivery: deliveryStatus, turnId: `turn-cap54-${suffix}` };
    };

    const firstResult = await runTaskboardContinuationMonitorOnce(first.options);
    assert.equal(firstResult.delivered, deliveryStatus === "observed");
    assert.equal((await runTaskboardContinuationMonitorOnce(second.options)).delivered, true);
    assert.equal(second.calls.claim, 1);
  }
});

test("ambiguous delivery failure holds only its tick budget", async () => {
  const sharedBudget = new Map();
  const first = monitorFixture({
    projectId: "ambiguous-project-a",
    todoId: "CAP-54-G",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3c",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b5",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  const sameTick = monitorFixture({
    projectId: "ambiguous-project-b",
    todoId: "CAP-54-H",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3d",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b6",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: sharedBudget,
  });
  first.options.deliver = async () => {
    first.calls.deliver += 1;
    throw new Error("transport failed after dispatch may have started");
  };

  await assert.rejects(
    runTaskboardContinuationMonitorOnce(first.options),
    /transport failed after dispatch may have started/,
  );
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(sameTick.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.equal(sameTick.calls.claim, 0);

  const nextTick = monitorFixture({
    projectId: "ambiguous-project-b",
    todoId: "CAP-54-H",
    taskId: "28cf5799-a245-4f54-b772-0aa2acf16e3d",
    fixtureRootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b6",
    hostObservation: observation({ cpuRatio: 0.67 }),
    hostResourceAdmissionBudget: new Map(),
  });
  assert.equal((await runTaskboardContinuationMonitorOnce(nextTick.options)).delivered, true);
  assert.equal(nextTick.calls.claim, 1);
});

test("continuation fast lane gives every project one shared per-tick budget", async () => {
  const observedBudgets = [];
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  runTaskboardContinuationFastLane({
    projects: [
      { projectId: "budget-contract-a", continuationEnabled: true },
      { projectId: "budget-contract-b", continuationEnabled: true },
    ],
    runContinuation: async (_projectId, budget) => {
      observedBudgets.push(budget);
      if (observedBudgets.length === 2) complete();
      return { delivered: false };
    },
  });
  await completed;
  assert.equal(observedBudgets.length, 2);
  assert.ok(observedBudgets[0] instanceof Map);
  assert.equal(observedBudgets[0], observedBudgets[1]);
});

test("local continuation fails closed for missing, warming, stale, or wrong-host observations", async () => {
  const cases = [
    [null, "host-resource-observation-unavailable"],
    [observation({ cpuRatio: null }), "host-resource-observation-warming"],
    [observation({ sampleWindowMs: 120_000 }), "host-resource-observation-warming"],
    [observation({ timestamp: "2026-09-06T23:58:00.000Z" }), "host-resource-observation-stale"],
    [observation({ hostId: "another-host" }), "host-resource-observation-unavailable"],
  ];
  for (const [hostObservation, reason] of cases) {
    const fixture = monitorFixture({ hostObservation });
    assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
      delivered: false,
      reason,
    });
    assert.equal(fixture.calls.claim, 0);
  }
});

test("remote continuation bypasses this resident host gate", async () => {
  const fixture = monitorFixture({ targetHostId: "remote-host", hostObservation: null });
  fixture.options.readHostResourceObservation = async () => assert.fail("remote work must not sample local resources");
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
    delivered: true,
    todoId: "CAP-54",
    actionId: "safe-resource-admission",
  });
});

test("due model-capacity retries still wait for current host resource headroom", async () => {
  const fixture = monitorFixture({
    hostObservation: observation({ cpuRatio: 0.95 }),
    todoOverrides: {
      admission: {
        receiptId: "receipt-model-capacity",
        attemptId: "attempt-model-capacity",
        state: "deferred",
        rootThreadId,
        resumeToken: "a".repeat(64),
        safeActionId: "safe-resource-admission",
        deferredReason: "model_capacity",
        retryCount: 1,
        retryAfter: "2026-09-07T00:00:00.000Z",
        rootHostId: "local",
        rootWorkspacePath: "/tmp/taskboard/project",
        coordinationDomainId: null,
        domainCoordinatorLeaseId: null,
        domainCoordinatorTaskId: null,
        domainCoordinatorThreadId: null,
        globalCoordinatorLeaseId: null,
        globalCoordinatorTaskId: null,
        globalCoordinatorThreadId: null,
      },
    },
  });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
    delivered: false,
    reason: "waiting-host-resources",
  });
  assert.equal(fixture.calls.claim, 0);
});

test("due model-capacity retry bypasses only stale Agent slots, never host pressure", async () => {
  const makeRetry = (hostObservation) => {
    const fixture = monitorFixture({
      hostObservation,
      todoOverrides: {
        admission: {
          receiptId: "receipt-stale-slots",
          attemptId: "attempt-stale-slots",
          state: "deferred",
          rootThreadId,
          resumeToken: "a".repeat(64),
          safeActionId: "safe-resource-admission",
          deferredReason: "model_capacity",
          retryCount: 1,
          retryAfter: "2026-09-07T00:00:00.000Z",
          rootHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          coordinationDomainId: null,
          domainCoordinatorLeaseId: null,
          domainCoordinatorTaskId: null,
          domainCoordinatorThreadId: null,
          globalCoordinatorLeaseId: null,
          globalCoordinatorTaskId: null,
          globalCoordinatorThreadId: null,
        },
      },
    });
    fixture.options.readSnapshot = async () => ({
      projectId: "taskboard-core",
      todos: [fixture.todo],
      windowSubagentTrees: [],
    });
    return fixture;
  };

  for (const [hostObservation, reason] of [
    [observation({ cpuRatio: 0.99 }), "waiting-host-resources"],
    [null, "host-resource-observation-unavailable"],
  ]) {
    const fixture = makeRetry(hostObservation);
    assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
      delivered: false,
      reason,
    });
    assert.deepEqual(fixture.calls, { observe: 1, claim: 0, confirm: 0, deliver: 0, complete: 0 });
  }

  const healthy = makeRetry(observation());
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(healthy.options), {
    delivered: true,
    todoId: "CAP-54",
    actionId: "safe-resource-admission",
  });
  assert.deepEqual(healthy.calls, { observe: 1, claim: 1, confirm: 1, deliver: 1, complete: 1 });
});

test("admission recovery completes before the new-start resource gate", async () => {
  const fixture = monitorFixture({
    hostObservation: observation({ memoryRatio: 0.05 }),
    todoOverrides: {
      admission: {
        receiptId: "receipt-recovery",
        attemptId: "attempt-recovery",
        state: "recovery_confirmed",
        rootThreadId,
        resumeToken: "a".repeat(64),
        safeActionId: "safe-resource-admission",
      },
    },
  });
  fixture.options.readHostResourceObservation = async () => {
    assert.fail("recovery must not wait for a new-start resource observation");
  };
  fixture.options.markAdmissionUncertain = async () => assert.fail("confirmed recovery must stay confirmed");
  fixture.options.claimAdmissionProbe = async () => assert.fail("confirmed recovery must not probe");
  fixture.options.reconcileAdmission = async () => assert.fail("confirmed recovery must not reconcile");
  fixture.options.deliverAdmissionRecovery = async (request) => {
    assert.equal(request.mode, "claim");
    return { delivery: "started", turnId: "turn-recovered" };
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(fixture.options), {
    delivered: true,
    todoId: "CAP-54",
    reason: "admission-recovery-instructed",
  });
  assert.deepEqual(fixture.calls, { observe: 0, claim: 0, confirm: 0, deliver: 0, complete: 0 });
});
