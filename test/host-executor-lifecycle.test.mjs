import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createHostExecutorApi } from "../scripts/host-executor-api.mjs";
import { createHostExecutorLeaseLifecycle } from "../scripts/host-executor-lifecycle.mjs";

const executorInstanceId = "executor-local-a";
const codexHostId = "local";
const adapterId = "local-codex-app-server-v1";
const fingerprint = "a".repeat(64);

function registration() {
  return {
    executorInstanceId,
    codexHostId,
    adapterId,
    capabilities: ["thread/list", "thread/read"],
    fingerprint,
    registeredAt: "2026-09-08T00:00:00.000Z",
  };
}

function activeLease(id = "lease-local-a", holder = executorInstanceId) {
  return {
    id,
    codexHostId,
    executorInstanceId: holder,
    registrationFingerprint: holder === executorInstanceId ? fingerprint : "b".repeat(64),
    acquiredAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-08T00:02:00.000Z",
    releasedAt: null,
    status: "active",
  };
}

function inactiveLease(status = "expired", id = "lease-old") {
  return {
    ...activeLease(id, "executor-old"),
    status,
    ...(status === "released" ? { releasedAt: "2026-09-08T00:00:30.000Z" } : {}),
  };
}

function leaseReceipt(action, lease) {
  return {
    action,
    codexHostId,
    executorInstanceId,
    leaseId: lease.id,
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const scheduled = [];
  const stateChanges = [];
  let operationSequence = 0;
  const transport = {
    register: async (request) => {
      calls.push(["register", request]);
      return { applied: true, registration: registration() };
    },
    inspect: async (request) => {
      calls.push(["inspect", request]);
      return { codexHostId, registrations: [registration()], lease: null };
    },
    acquire: async (request) => {
      calls.push(["acquire", request]);
      const lease = activeLease();
      return { applied: true, lease, receipt: leaseReceipt("acquired", lease) };
    },
    renew: async (request) => {
      calls.push(["renew", request]);
      const lease = activeLease(request.expectedLeaseId);
      return { applied: true, lease, receipt: leaseReceipt("renewed", lease) };
    },
    release: async (request) => {
      calls.push(["release", request]);
      const lease = {
        ...activeLease(request.expectedLeaseId),
        status: "released",
        releasedAt: "2026-09-08T00:01:00.000Z",
      };
      return {
        applied: true,
        lease,
        receipt: leaseReceipt("released", lease),
      };
    },
    ...overrides.transport,
  };
  const lifecycle = createHostExecutorLeaseLifecycle({
    codexHostId,
    executorInstanceId,
    adapterId,
    leaseDurationSeconds: 120,
    renewIntervalMs: 30_000,
    ...transport,
    schedule: (callback, intervalMs) => {
      const timer = { callback, intervalMs, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
    now: overrides.now ?? (() => Date.parse("2026-09-08T00:01:00.000Z")),
    createOperationId: () => `op-${++operationSequence}`,
    onStateChange: (state) => stateChanges.push(state),
    onError: overrides.onError ?? (() => {}),
  });
  return { lifecycle, calls, scheduled, stateChanges };
}

test("first startup registers one immutable local executor and acquires one lease", async () => {
  const { lifecycle, calls, scheduled, stateChanges } = createHarness();

  const state = await lifecycle.start();

  assert.equal(state.active, true);
  assert.equal(state.reason, "lease-acquired");
  assert.equal(state.lease.id, "lease-local-a");
  assert.equal(lifecycle.isActive(), true);
  const execution = lifecycle.executionEnvelope();
  assert.equal(Object.isFrozen(execution), true);
  assert.deepEqual(execution, {
    codexHostId,
    executorInstanceId,
    registrationFingerprint: fingerprint,
    leaseId: "lease-local-a",
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 30_000);
  assert.deepEqual(calls.map(([action]) => action), ["register", "inspect", "acquire"]);
  assert.deepEqual(calls[0][1], {
    codexHostId,
    executorInstanceId,
    adapterId,
    idempotencyKey: `host-executor-register:${executorInstanceId}`,
  });
  assert.equal(calls[2][1].expectedLeaseId, null);
  assert.equal(calls[2][1].registrationFingerprint, fingerprint);
  assert.equal(calls[2][1].leaseDurationSeconds, 120);
  assert.equal(stateChanges.at(-1).active, true);
});

test("same-process service restart replays registration and renews the same lease epoch", async () => {
  let inspectionCount = 0;
  const lease = activeLease();
  const { lifecycle, calls } = createHarness({
    transport: {
      inspect: async (request) => {
        calls.push(["inspect", request]);
        inspectionCount += 1;
        return {
          codexHostId,
          registrations: [registration()],
          lease: inspectionCount === 1 ? null : lease,
        };
      },
    },
  });

  await lifecycle.start();
  const afterRestart = await lifecycle.reconcile();

  assert.equal(afterRestart.active, true);
  assert.equal(afterRestart.reason, "lease-renewed");
  assert.equal(afterRestart.lease.id, lease.id);
  assert.equal(calls.filter(([action]) => action === "acquire").length, 1);
  assert.equal(calls.filter(([action]) => action === "renew").length, 1);
  assert.equal(calls.filter(([action]) => action === "register").length, 2);
  const registrationKeys = calls
    .filter(([action]) => action === "register")
    .map(([, request]) => request.idempotencyKey);
  assert.deepEqual(new Set(registrationKeys), new Set([`host-executor-register:${executorInstanceId}`]));
});

test("an active competitor is never stolen and an expired epoch is acquired with exact CAS", async () => {
  let currentLease = activeLease("lease-competitor", "executor-competitor");
  const { lifecycle, calls } = createHarness({
    transport: {
      inspect: async (request) => {
        calls.push(["inspect", request]);
        return { codexHostId, registrations: [registration()], lease: currentLease };
      },
      acquire: async (request) => {
        calls.push(["acquire", request]);
        assert.equal(request.expectedLeaseId, "lease-competitor");
        const lease = activeLease("lease-local-b");
        return { applied: true, lease, receipt: leaseReceipt("acquired", lease) };
      },
    },
  });

  const blocked = await lifecycle.start();
  assert.equal(blocked.active, false);
  assert.equal(blocked.reason, "lease-held-by-another");
  assert.equal(calls.some(([action]) => action === "acquire"), false);

  currentLease = inactiveLease("expired", "lease-competitor");
  const recovered = await lifecycle.reconcile();
  assert.equal(recovered.active, true);
  assert.equal(recovered.lease.id, "lease-local-b");
  assert.equal(calls.filter(([action]) => action === "acquire").length, 1);
});

test("an uncertain renewal disables ownership until exact state is recovered", async () => {
  let inspectionCount = 0;
  const errors = [];
  const { lifecycle, stateChanges } = createHarness({
    onError: (error) => errors.push(error.message),
    transport: {
      inspect: async () => ({
        codexHostId,
        registrations: [registration()],
        lease: inspectionCount++ === 0 ? null : activeLease(),
      }),
      renew: async () => {
        throw new Error("renewal response uncertain");
      },
    },
  });

  await lifecycle.start();
  const uncertain = await lifecycle.reconcile();

  assert.equal(uncertain.active, false);
  assert.equal(uncertain.reason, "reconcile-uncertain");
  assert.equal(lifecycle.isActive(), false);
  assert.deepEqual(errors, ["renewal response uncertain"]);
  assert.equal(stateChanges.at(-1).active, false);
});

test("a mismatched renewal receipt disables ownership before another monitor tick", async () => {
  let inspectionCount = 0;
  const errors = [];
  const { lifecycle } = createHarness({
    onError: (error) => errors.push(error.message),
    transport: {
      inspect: async () => ({
        codexHostId,
        registrations: [registration()],
        lease: inspectionCount++ === 0 ? null : activeLease(),
      }),
      renew: async (request) => {
        const lease = activeLease(request.expectedLeaseId);
        return {
          applied: true,
          lease,
          receipt: { ...leaseReceipt("renewed", lease), leaseId: "lease-substituted" },
        };
      },
    },
  });

  await lifecycle.start();
  const rejected = await lifecycle.reconcile();

  assert.equal(rejected.active, false);
  assert.equal(rejected.reason, "reconcile-uncertain");
  assert.match(errors[0], /invalid host executor renewed receipt/);
});

test("a suspended process loses its monitor gate at the exact lease expiry", async () => {
  let currentTime = Date.parse("2026-09-08T00:01:00.000Z");
  const { lifecycle } = createHarness({ now: () => currentTime });

  const started = await lifecycle.start();
  assert.equal(started.active, true);

  currentTime = Date.parse("2026-09-08T00:02:00.000Z");
  assert.equal(lifecycle.isActive(), false);
  assert.equal(lifecycle.snapshot().active, false);
});

test("concurrent manual and timer reconciliations share one serialized operation", async () => {
  let releaseRegistration;
  const registrationBlocked = new Promise((resolve) => {
    releaseRegistration = resolve;
  });
  let registerCalls = 0;
  const { lifecycle, calls } = createHarness({
    transport: {
      register: async (request) => {
        calls.push(["register", request]);
        registerCalls += 1;
        await registrationBlocked;
        return { applied: true, registration: registration() };
      },
    },
  });

  const first = lifecycle.reconcile();
  const second = lifecycle.reconcile();
  await Promise.resolve();
  assert.equal(registerCalls, 1);

  releaseRegistration();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState.active, true);
  assert.equal(secondState.active, true);
  assert.equal(calls.filter(([action]) => action === "acquire").length, 1);
});

test("the scheduled renewal tick coalesces with a concurrent service-restart reconciliation", async () => {
  let releaseSecondRegistration;
  const secondRegistrationBlocked = new Promise((resolve) => {
    releaseSecondRegistration = resolve;
  });
  let registrationCount = 0;
  let currentLease = null;
  const { lifecycle, calls, scheduled } = createHarness({
    transport: {
      register: async (request) => {
        calls.push(["register", request]);
        registrationCount += 1;
        if (registrationCount === 2) await secondRegistrationBlocked;
        return { applied: registrationCount === 1, registration: registration() };
      },
      inspect: async (request) => {
        calls.push(["inspect", request]);
        return { codexHostId, registrations: [registration()], lease: currentLease };
      },
      acquire: async (request) => {
        calls.push(["acquire", request]);
        currentLease = activeLease();
        return {
          applied: true,
          lease: currentLease,
          receipt: leaseReceipt("acquired", currentLease),
        };
      },
    },
  });

  await lifecycle.start();
  scheduled[0].callback();
  const restart = lifecycle.reconcile();
  await Promise.resolve();
  assert.equal(registrationCount, 2);

  releaseSecondRegistration();
  await restart;
  assert.equal(calls.filter(([action]) => action === "renew").length, 1);
});

test("graceful stop releases only the exact currently owned lease and is idempotent", async () => {
  let currentLease = null;
  const { lifecycle, calls, scheduled } = createHarness({
    transport: {
      inspect: async (request) => {
        calls.push(["inspect", request]);
        return { codexHostId, registrations: [registration()], lease: currentLease };
      },
      acquire: async (request) => {
        calls.push(["acquire", request]);
        currentLease = activeLease();
        return {
          applied: true,
          lease: currentLease,
          receipt: leaseReceipt("acquired", currentLease),
        };
      },
    },
  });

  await lifecycle.start();
  await lifecycle.stop();
  await lifecycle.stop();

  assert.equal(lifecycle.isActive(), false);
  assert.equal(scheduled[0].cancelled, true);
  const releases = calls.filter(([action]) => action === "release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0][1].expectedLeaseId, "lease-local-a");
  assert.equal(releases[0][1].executorInstanceId, executorInstanceId);
});

test("stale cleanup cannot release a replacement executor lease", async () => {
  let inspectionCount = 0;
  const { lifecycle, calls } = createHarness({
    transport: {
      inspect: async (request) => {
        calls.push(["inspect", request]);
        inspectionCount += 1;
        return {
          codexHostId,
          registrations: [registration()],
          lease: inspectionCount === 1
            ? null
            : activeLease("lease-replacement", "executor-replacement"),
        };
      },
    },
  });

  await lifecycle.start();
  await lifecycle.stop();

  assert.equal(calls.some(([action]) => action === "release"), false);
  assert.equal(lifecycle.isActive(), false);
});

test("real Taskboard restart preserves the exact resident registration and lease epoch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-lifecycle-"));
  const instanceSecret = "c".repeat(64);
  let app = null;
  let api = null;
  let operationSequence = 0;
  const launch = async () => {
    app = createTaskboardServer({ dataDirectory: directory, instanceSecret });
    const address = await app.listen({ port: 0 });
    api = createHostExecutorApi({
      baseUrl: `http://127.0.0.1:${address.port}`,
      instanceSecret,
    });
  };
  await launch();
  const lifecycle = createHostExecutorLeaseLifecycle({
    codexHostId,
    executorInstanceId,
    adapterId,
    leaseDurationSeconds: 120,
    renewIntervalMs: 30_000,
    register: (request) => api.register(request),
    inspect: (request) => api.inspect(request),
    acquire: (request) => api.acquire(request),
    renew: (request) => api.renew(request),
    release: (request) => api.release(request),
    schedule: () => ({ timer: true }),
    cancel: () => {},
    createOperationId: () => `integration-${++operationSequence}`,
  });

  try {
    const started = await lifecycle.start();
    assert.equal(started.active, true);
    const leaseId = started.lease.id;
    const registeredAt = started.registration.registeredAt;

    await app.close();
    app = null;
    await launch();

    const restarted = await lifecycle.reconcile();
    assert.equal(restarted.active, true);
    assert.equal(restarted.reason, "lease-renewed");
    assert.equal(restarted.lease.id, leaseId);
    assert.equal(restarted.registration.registeredAt, registeredAt);

    await lifecycle.stop();
    const finalState = await api.inspect({ codexHostId });
    assert.equal(finalState.registrations.length, 1);
    assert.equal(finalState.lease.id, leaseId);
    assert.equal(finalState.lease.status, "released");
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resident injector wires lifecycle start, restart reconciliation, monitor gates, and cleanup", () => {
  const source = readFileSync(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");

  assert.match(source, /createHostExecutorApi/);
  assert.match(source, /createHostExecutorLeaseLifecycle/);
  assert.match(source, /await publishRuntime\(\);[\s\S]*?await residentHostExecutorLeaseLifecycle\?\.start\(\);/);
  assert.match(source, /service\.restarted[\s\S]*?await publishRuntime\(\);[\s\S]*?residentHostExecutorLeaseLifecycle\?\.reconcile\(\)/);
  assert.match(source, /residentHostExecutorLeaseIsActive\(\)/);
  assert.equal(source.match(/!residentHostExecutorLeaseIsActive\(\)/g)?.length, 4);
  assert.equal(source.match(/residentHostExecutorContext\.run\(/g)?.length, 4);
  assert.match(source, /residentHostExecutorMutatingRpcMethods\.has\(method\)[\s\S]*?\.executeEffect\(\{/);
  assert.match(source, /residentHostExecutorFenceHeaders\(pathname, body\)/);
  assert.match(source, /if \(options\.watch\) \{[\s\S]*?createResidentHostExecutorLeaseLifecycle\(\)/);
  assert.match(source, /disposeResidentCoordinatorMonitors\?\.\(\);[\s\S]*?await residentHostExecutorLeaseLifecycle\?\.stop\(\);[\s\S]*?await closeLocalCodexThreadRpcTransport\(\);/);
});
