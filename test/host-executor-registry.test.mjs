import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as createHttpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory, removeDirectory } = runningApps.pop();
    await app.close();
    if (removeDirectory) await rm(directory, { recursive: true, force: true });
  }
});

async function launchServer({ directory, instanceSecret, hostExecutorClock, removeDirectory = false }) {
  const app = createTaskboardServer({
    dataDirectory: directory,
    instanceSecret,
    hostExecutorClock,
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory, removeDirectory });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(app) {
  const index = runningApps.findIndex((entry) => entry.app === app);
  if (index >= 0) runningApps.splice(index, 1);
  await app.close();
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function rawHttpRequest(baseUrl, pathname, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl);
    const outgoing = createHttpRequest(target, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          response: { status: response.statusCode },
          body: text ? JSON.parse(text) : undefined,
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function holdWriteLockAndAdvanceClock(databasePath, clockPath, nextTime) {
  const source = `
    const { writeFileSync } = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const [databasePath, clockPath, nextTime] = process.argv.slice(1);
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    process.stdout.write("locked\\n");
    setTimeout(() => {
      writeFileSync(clockPath, nextTime);
      database.exec("COMMIT");
      database.close();
    }, 100);
  `;
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--eval",
    source,
    databasePath,
    clockPath,
    String(nextTime),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock helper exited ${code}: ${stderr}`));
    });
    child.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      if (chunk.toString("utf8") === "locked\n") resolve();
      else reject(new Error(`Unexpected lock helper output: ${chunk}`));
    });
    child.once("exit", (code) => {
      reject(new Error(`Lock helper exited ${code} before acquiring the lock: ${stderr}`));
    });
  });
  return { exited };
}

function nonce(index) {
  return index.toString(16).padStart(32, "0");
}

function signedHeaders(instanceSecret, nonceValue, pathname, body, issuedAt, method = "POST") {
  const timestamp = String(issuedAt);
  const proof = createHmac("sha256", instanceSecret).update(JSON.stringify({
    nonce: nonceValue,
    issuedAt: timestamp,
    method,
    pathname,
    body,
  })).digest("hex");
  return {
    "x-codex-taskboard-injector-nonce": nonceValue,
    "x-codex-taskboard-injector-issued-at": timestamp,
    "x-codex-taskboard-injector-proof": proof,
  };
}

async function protectedRequest({
  baseUrl,
  instanceSecret,
  nonceIndex,
  pathname,
  method = "POST",
  body = null,
}) {
  return request(baseUrl, pathname, {
    method,
    headers: signedHeaders(instanceSecret, nonce(nonceIndex), pathname, body, Date.now(), method),
    ...(body === null ? {} : { body }),
  });
}

async function registerExecutor({
  baseUrl,
  instanceSecret,
  issuedAt,
  nonceIndex,
  codexHostId = "remote-builder",
  executorInstanceId,
  adapterId = "codex-renderer-rpc-v1",
  idempotencyKey,
}) {
  const pathname = `/api/local/host-executors/${codexHostId}/registrations/${executorInstanceId}`;
  const body = { adapterId, idempotencyKey };
  return protectedRequest({
    baseUrl, instanceSecret, issuedAt, nonceIndex, pathname, method: "PUT", body,
  });
}

test("host executor registrations are allowlisted, immutable, durable, and idempotent", async () => {
  const instanceSecret = "a".repeat(64);
  let currentTime = Date.parse("2026-09-08T00:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-registration-"));
  const { app, baseUrl } = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => currentTime,
    removeDirectory: true,
  });
  const pathname = "/api/local/host-executors/remote-builder/registrations/executor-a";
  const body = { adapterId: "codex-renderer-rpc-v1", idempotencyKey: "register-a" };

  const unsigned = await request(baseUrl, pathname, { method: "PUT", body });
  assert.deepEqual([unsigned.response.status, unsigned.body.error.code], [403, "INJECTOR_PROOF_REQUIRED"]);

  const created = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 1,
    executorInstanceId: "executor-a", idempotencyKey: "register-a",
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.applied, true);
  assert.deepEqual(created.body.registration, {
    executorInstanceId: "executor-a",
    codexHostId: "remote-builder",
    adapterId: "codex-renderer-rpc-v1",
    capabilities: [
      "model/list",
      "thread/archive",
      "thread/list",
      "thread/name/set",
      "thread/read",
      "thread/resume",
      "thread/start",
      "turn/start",
      "turn/steer",
    ],
    fingerprint: created.body.registration.fingerprint,
    registeredAt: "2026-09-08T00:00:00.000Z",
  });
  assert.match(created.body.registration.fingerprint, /^[a-f0-9]{64}$/);

  const replay = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 2,
    executorInstanceId: "executor-a", idempotencyKey: "register-a",
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.applied, false);
  assert.deepEqual(replay.body.registration, created.body.registration);

  const conflictingReplay = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 3,
    executorInstanceId: "executor-b", idempotencyKey: "register-a",
  });
  assert.deepEqual(
    [conflictingReplay.response.status, conflictingReplay.body.error.code],
    [409, "HOST_EXECUTOR_REGISTRATION_IDEMPOTENCY_CONFLICT"],
  );

  const unknownAdapter = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 4,
    executorInstanceId: "executor-c", adapterId: "https://untrusted.invalid/rpc",
    idempotencyKey: "register-unknown",
  });
  assert.deepEqual(
    [unknownAdapter.response.status, unknownAdapter.body.error.code],
    [400, "HOST_EXECUTOR_ADAPTER_NOT_ALLOWED"],
  );

  const wrongHostKind = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 5,
    executorInstanceId: "executor-d", adapterId: "local-codex-app-server-v1",
    idempotencyKey: "register-wrong-host-kind",
  });
  assert.deepEqual(
    [wrongHostKind.response.status, wrongHostKind.body.error.code],
    [409, "HOST_EXECUTOR_ADAPTER_HOST_MISMATCH"],
  );

  const listPath = "/api/local/host-executors/remote-builder";
  const listed = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 6,
    pathname: listPath, method: "GET",
  });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body, {
    codexHostId: "remote-builder",
    registrations: [created.body.registration],
    lease: null,
  });

  const inspection = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_registrations").get().count, 1);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_lease_receipts").get().count, 0);
  inspection.close();

  await stopServer(app);
  currentTime += 1_000;
  const restarted = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => currentTime,
    removeDirectory: true,
  });
  const afterRestart = await protectedRequest({
    baseUrl: restarted.baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 7,
    pathname: listPath, method: "GET",
  });
  assert.deepEqual(afterRestart.body.registrations, [created.body.registration]);
});

test("one durable host executor lease excludes competitors and survives restart", async () => {
  const instanceSecret = "b".repeat(64);
  let currentTime = Date.parse("2026-09-08T01:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-lease-"));
  const launched = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => currentTime,
    removeDirectory: true,
  });
  let { app, baseUrl } = launched;
  const registrationA = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 11,
    executorInstanceId: "executor-a", idempotencyKey: "register-a",
  });
  const registrationB = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 12,
    executorInstanceId: "executor-b", idempotencyKey: "register-b",
  });
  assert.deepEqual([registrationA.response.status, registrationB.response.status], [200, 200]);

  const leasePath = "/api/local/host-executors/remote-builder/lease";
  const acquireBody = {
    executorInstanceId: "executor-a",
    registrationFingerprint: registrationA.body.registration.fingerprint,
    expectedLeaseId: null,
    leaseDurationSeconds: 60,
    idempotencyKey: "acquire-a",
  };
  const acquired = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 13,
    pathname: leasePath, body: acquireBody,
  });
  assert.equal(acquired.response.status, 200);
  assert.equal(acquired.body.applied, true);
  assert.equal(acquired.body.lease.status, "active");
  assert.equal(acquired.body.lease.executorInstanceId, "executor-a");
  assert.equal(acquired.body.lease.expiresAt, "2026-09-08T01:01:00.000Z");
  assert.match(acquired.body.lease.id, /^[0-9a-f-]{36}$/);
  assert.equal(acquired.body.receipt.action, "acquired");

  const acquireReplay = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 14,
    pathname: leasePath, body: acquireBody,
  });
  assert.equal(acquireReplay.response.status, 200);
  assert.equal(acquireReplay.body.applied, false);
  assert.deepEqual(acquireReplay.body.lease, acquired.body.lease);
  assert.deepEqual(acquireReplay.body.receipt, acquired.body.receipt);

  const competingBody = {
    executorInstanceId: "executor-b",
    registrationFingerprint: registrationB.body.registration.fingerprint,
    expectedLeaseId: acquired.body.lease.id,
    leaseDurationSeconds: 60,
    idempotencyKey: "acquire-b-active",
  };
  const competing = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 15,
    pathname: leasePath, body: competingBody,
  });
  assert.deepEqual(
    [competing.response.status, competing.body.error.code],
    [409, "HOST_EXECUTOR_LEASE_ACTIVE"],
  );

  currentTime += 20_000;
  const renewPath = `${leasePath}/renew`;
  const renewBody = {
    executorInstanceId: "executor-a",
    registrationFingerprint: registrationA.body.registration.fingerprint,
    expectedLeaseId: acquired.body.lease.id,
    leaseDurationSeconds: 90,
    idempotencyKey: "renew-a",
  };
  const renewed = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 16,
    pathname: renewPath, body: renewBody,
  });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.body.lease.id, acquired.body.lease.id);
  assert.equal(renewed.body.lease.expiresAt, "2026-09-08T01:01:50.000Z");
  assert.equal(renewed.body.receipt.action, "renewed");

  await stopServer(app);
  currentTime += 1_000;
  ({ app, baseUrl } = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => currentTime,
    removeDirectory: true,
  }));
  const statusPath = "/api/local/host-executors/remote-builder";
  const afterRestart = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 17,
    pathname: statusPath, method: "GET",
  });
  assert.equal(afterRestart.body.lease.status, "active");
  assert.equal(afterRestart.body.lease.id, acquired.body.lease.id);

  const releasePath = `${leasePath}/release`;
  const releaseBody = {
    executorInstanceId: "executor-a",
    registrationFingerprint: registrationA.body.registration.fingerprint,
    expectedLeaseId: acquired.body.lease.id,
    idempotencyKey: "release-a",
  };
  const released = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 18,
    pathname: releasePath, body: releaseBody,
  });
  assert.equal(released.response.status, 200);
  assert.equal(released.body.lease.status, "released");
  assert.equal(released.body.receipt.action, "released");

  const acquireBAfterReleaseBody = {
    ...competingBody,
    expectedLeaseId: acquired.body.lease.id,
    idempotencyKey: "acquire-b-after-release",
  };
  const acquiredB = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 19,
    pathname: leasePath, body: acquireBAfterReleaseBody,
  });
  assert.equal(acquiredB.response.status, 200);
  assert.notEqual(acquiredB.body.lease.id, acquired.body.lease.id);
  assert.equal(acquiredB.body.lease.executorInstanceId, "executor-b");

  currentTime += 61_000;
  const expiredStatus = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 20,
    pathname: statusPath, method: "GET",
  });
  assert.equal(expiredStatus.body.lease.status, "expired");
  const acquiredAAfterExpiry = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 21,
    pathname: leasePath,
    body: {
      ...acquireBody,
      expectedLeaseId: acquiredB.body.lease.id,
      idempotencyKey: "acquire-a-after-expiry",
    },
  });
  assert.equal(acquiredAAfterExpiry.response.status, 200);
  assert.notEqual(acquiredAAfterExpiry.body.lease.id, acquiredB.body.lease.id);

  const staleRenew = await protectedRequest({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 22,
    pathname: renewPath,
    body: {
      executorInstanceId: "executor-b",
      registrationFingerprint: registrationB.body.registration.fingerprint,
      expectedLeaseId: acquiredB.body.lease.id,
      leaseDurationSeconds: 60,
      idempotencyKey: "stale-renew-b",
    },
  });
  assert.deepEqual(
    [staleRenew.response.status, staleRenew.body.error.code],
    [409, "HOST_EXECUTOR_LEASE_CONFLICT"],
  );

  const receipts = await protectedRequest({
    baseUrl, instanceSecret, nonceIndex: 23,
    pathname: `${leasePath}/receipts`, method: "GET",
  });
  assert.equal(receipts.response.status, 200);
  assert.deepEqual(
    receipts.body.receipts.map((receipt) => receipt.action),
    ["acquired", "acquired", "released", "renewed", "acquired"],
  );
  assert.equal(receipts.body.receipts[0].leaseId, acquiredAAfterExpiry.body.lease.id);
  assert.equal(receipts.body.receipts[0].executorInstanceId, "executor-a");

  const inspection = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_leases").get().count, 1);
  assert.deepEqual(
    inspection.prepare("SELECT action FROM host_executor_lease_receipts ORDER BY rowid").all().map((row) => row.action),
    ["acquired", "renewed", "released", "acquired", "acquired"],
  );
  inspection.close();
});

test("host executor lease acquisition is atomic per host and independent across hosts", async () => {
  const instanceSecret = "c".repeat(64);
  const currentTime = Date.parse("2026-09-08T02:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-race-"));
  const { baseUrl } = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => currentTime,
    removeDirectory: true,
  });
  const registrationA = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 31,
    codexHostId: "remote-a", executorInstanceId: "executor-a", idempotencyKey: "register-a",
  });
  const registrationB = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 32,
    codexHostId: "remote-a", executorInstanceId: "executor-b", idempotencyKey: "register-b",
  });
  const registrationC = await registerExecutor({
    baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 33,
    codexHostId: "remote-b", executorInstanceId: "executor-c", idempotencyKey: "register-c",
  });
  const pathA = "/api/local/host-executors/remote-a/lease";
  const pathB = "/api/local/host-executors/remote-b/lease";
  const [raceA, raceB, independent] = await Promise.all([
    protectedRequest({
      baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 34, pathname: pathA,
      body: {
        executorInstanceId: "executor-a",
        registrationFingerprint: registrationA.body.registration.fingerprint,
        expectedLeaseId: null, leaseDurationSeconds: 60, idempotencyKey: "race-a",
      },
    }),
    protectedRequest({
      baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 35, pathname: pathA,
      body: {
        executorInstanceId: "executor-b",
        registrationFingerprint: registrationB.body.registration.fingerprint,
        expectedLeaseId: null, leaseDurationSeconds: 60, idempotencyKey: "race-b",
      },
    }),
    protectedRequest({
      baseUrl, instanceSecret, issuedAt: currentTime, nonceIndex: 36, pathname: pathB,
      body: {
        executorInstanceId: "executor-c",
        registrationFingerprint: registrationC.body.registration.fingerprint,
        expectedLeaseId: null, leaseDurationSeconds: 60, idempotencyKey: "independent-c",
      },
    }),
  ]);
  assert.deepEqual(
    [raceA.response.status, raceB.response.status].sort(),
    [200, 409],
  );
  assert.equal(independent.response.status, 200);
  const loser = raceA.response.status === 409 ? raceA : raceB;
  assert.equal(loser.body.error.code, "HOST_EXECUTOR_LEASE_CONFLICT");

  const inspection = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_leases").get().count, 2);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_lease_receipts").get().count, 2);
  inspection.close();
});

test("host executor lease replay is inclusive for 24 hours and receipts then stay bounded", async () => {
  const initialTime = Date.parse("2026-09-08T02:30:00.000Z");
  let currentTime = initialTime;
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-retention-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => currentTime,
  });
  try {
    const registration = database.registerHostExecutor({
      codexHostId: "remote-retention",
      executorInstanceId: "executor-retention",
      adapterId: "codex-renderer-rpc-v1",
      capabilities: ["thread/read"],
      idempotencyKey: "register-retention",
    }).registration;
    const acquireInput = {
      codexHostId: "remote-retention",
      executorInstanceId: registration.executorInstanceId,
      registrationFingerprint: registration.fingerprint,
      expectedLeaseId: null,
      leaseDurationSeconds: 60,
      idempotencyKey: "acquire-retention",
    };
    const acquired = database.acquireHostExecutorLease(acquireInput);

    for (let index = 1; index <= 2_880; index += 1) {
      currentTime += 30_000;
      const renewed = database.renewHostExecutorLease({
        codexHostId: "remote-retention",
        executorInstanceId: registration.executorInstanceId,
        registrationFingerprint: registration.fingerprint,
        expectedLeaseId: acquired.lease.id,
        leaseDurationSeconds: 60,
        idempotencyKey: `renew-retention-${index}`,
      });
      assert.equal(renewed.lease.id, acquired.lease.id);
    }

    const replayAtBoundary = database.acquireHostExecutorLease(acquireInput);
    assert.equal(replayAtBoundary.applied, false);
    assert.deepEqual(replayAtBoundary.receipt, acquired.receipt);

    currentTime += 30_000;
    database.renewHostExecutorLease({
      codexHostId: "remote-retention",
      executorInstanceId: registration.executorInstanceId,
      registrationFingerprint: registration.fingerprint,
      expectedLeaseId: acquired.lease.id,
      leaseDurationSeconds: 60,
      idempotencyKey: "renew-retention-after-boundary",
    });
    assert.throws(
      () => database.acquireHostExecutorLease(acquireInput),
      (error) => error?.code === "HOST_EXECUTOR_LEASE_CONFLICT",
    );

    const inspection = new DatabaseSync(databasePath);
    const receiptStats = inspection.prepare(`
      SELECT COUNT(*) AS count, MIN(created_at) AS oldest
      FROM host_executor_lease_receipts
      WHERE codex_host_id = 'remote-retention'
    `).get();
    assert.deepEqual({ ...receiptStats }, {
      count: 2_881,
      oldest: new Date(initialTime + 30_000).toISOString(),
    });
    assert.deepEqual({ ...inspection.prepare(`
      SELECT lease_id, executor_instance_id FROM host_executor_leases
      WHERE codex_host_id = 'remote-retention'
    `).get() }, {
      lease_id: acquired.lease.id,
      executor_instance_id: registration.executorInstanceId,
    });
    inspection.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor registration retention removes repeated local and remote churn across restarts", async () => {
  let currentTime = Date.parse("2026-09-08T03:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-registration-churn-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const openDatabase = () => new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => currentTime,
  });
  let database = openDatabase();
  const registerCycle = (cycle) => {
    for (const [codexHostId, adapterId] of [
      ["local", "codex-app-local-v1"],
      ["remote-churn", "codex-renderer-rpc-v1"],
    ]) {
      for (let index = 0; index < 2; index += 1) {
        const suffix = `${cycle}-${codexHostId}-${index}`;
        database.registerHostExecutor({
          codexHostId,
          executorInstanceId: `executor-${suffix}`,
          adapterId,
          capabilities: ["thread/read"],
          idempotencyKey: `register-${suffix}`,
        });
      }
    }
  };
  try {
    for (const cycle of ["first", "second"]) {
      registerCycle(cycle);
      database.close();
      currentTime += 24 * 60 * 60 * 1_000;
      database = openDatabase();
      let inspection = new DatabaseSync(databasePath);
      assert.equal(
        inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_registrations").get().count,
        4,
      );
      inspection.close();

      database.close();
      currentTime += 1;
      database = openDatabase();
      inspection = new DatabaseSync(databasePath);
      assert.equal(
        inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_registrations").get().count,
        0,
      );
      inspection.close();
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor registration retention preserves live safety references", async () => {
  const initialTime = Date.parse("2026-09-08T03:15:00.000Z");
  let currentTime = initialTime;
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-registration-references-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const openDatabase = () => new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => currentTime,
  });
  let database = openDatabase();
  try {
    const registrations = new Map();
    for (const executorInstanceId of [
      "executor-current-lease",
      "executor-fresh-receipt",
      "executor-unresolved-effect",
      "executor-fresh-unreferenced",
      "executor-stale-unreferenced",
    ]) {
      registrations.set(executorInstanceId, database.registerHostExecutor({
        codexHostId: `host-${executorInstanceId}`,
        executorInstanceId,
        adapterId: "codex-renderer-rpc-v1",
        capabilities: ["thread/start"],
        idempotencyKey: `register-${executorInstanceId}`,
      }).registration);
    }
    database.close();

    const fixture = new DatabaseSync(databasePath);
    const freshTimestamp = new Date(initialTime + 60_000).toISOString();
    fixture.prepare(`
      INSERT INTO host_executor_leases (
        codex_host_id, lease_id, executor_instance_id, registration_fingerprint,
        acquired_at, expires_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      "host-executor-current-lease",
      "registration-retention-current-lease",
      "executor-current-lease",
      registrations.get("executor-current-lease").fingerprint,
      new Date(initialTime).toISOString(),
      new Date(initialTime + 30_000).toISOString(),
    );
    fixture.prepare(`
      INSERT INTO host_executor_lease_receipts (
        id, codex_host_id, idempotency_key, request_fingerprint, action,
        lease_id, executor_instance_id, result_json, created_at
      ) VALUES (?, ?, ?, ?, 'acquired', ?, ?, '{}', ?)
    `).run(
      "registration-retention-fresh-receipt",
      "host-executor-fresh-receipt",
      "registration-retention-fresh-receipt-key",
      "a".repeat(64),
      "registration-retention-receipt-lease",
      "executor-fresh-receipt",
      freshTimestamp,
    );
    fixture.prepare(`
      INSERT INTO host_executor_effects (
        effect_key, codex_host_id, executor_instance_id, registration_fingerprint,
        lease_id, adapter_id, request_fingerprint, operations_json, status,
        dispatch_token, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uncertain', ?, NULL, ?, ?)
    `).run(
      "registration-retention-unresolved-effect",
      "host-executor-unresolved-effect",
      "executor-unresolved-effect",
      registrations.get("executor-unresolved-effect").fingerprint,
      "registration-retention-unresolved-lease",
      "codex-renderer-rpc-v1",
      "b".repeat(64),
      '[{"method":"thread/start","params":{"prompt":"CAP65_REGISTRATION_SENTINEL"}}]',
      "registration-retention-unresolved-dispatch",
      new Date(initialTime).toISOString(),
      new Date(initialTime).toISOString(),
    );
    fixture.prepare(`
      UPDATE host_executor_registrations SET registered_at = ?
      WHERE executor_instance_id = 'executor-fresh-unreferenced'
    `).run(freshTimestamp);
    fixture.close();

    currentTime = initialTime + 24 * 60 * 60 * 1_000 + 1;
    database = openDatabase();
    let inspection = new DatabaseSync(databasePath);
    assert.deepEqual(inspection.prepare(`
      SELECT executor_instance_id FROM host_executor_registrations
      ORDER BY executor_instance_id
    `).all().map((row) => row.executor_instance_id), [
      "executor-current-lease",
      "executor-fresh-receipt",
      "executor-fresh-unreferenced",
      "executor-unresolved-effect",
    ]);
    assert.equal(inspection.prepare(`
      SELECT operations_json FROM host_executor_effects
      WHERE effect_key = 'registration-retention-unresolved-effect'
    `).get().operations_json, "[]");
    inspection.close();

    database.close();
    currentTime = initialTime + 48 * 60 * 60 * 1_000 + 60_001;
    database = openDatabase();
    inspection = new DatabaseSync(databasePath);
    assert.deepEqual(inspection.prepare(`
      SELECT executor_instance_id FROM host_executor_registrations
      ORDER BY executor_instance_id
    `).all().map((row) => row.executor_instance_id), [
      "executor-current-lease",
      "executor-unresolved-effect",
    ]);
    inspection.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor retention removes resolved payloads and preserves unresolved tombstones", async () => {
  const initialTime = Date.parse("2026-09-08T03:30:00.000Z");
  let currentTime = initialTime;
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-effect-retention-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const openDatabase = () => new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => currentTime,
  });
  let database = openDatabase();
  try {
    const registration = database.registerHostExecutor({
      codexHostId: "remote-effect-retention",
      executorInstanceId: "executor-effect-retention",
      adapterId: "codex-renderer-rpc-v1",
      capabilities: ["thread/start"],
      idempotencyKey: "register-effect-retention",
    }).registration;
    const lease = database.acquireHostExecutorLease({
      codexHostId: "remote-effect-retention",
      executorInstanceId: registration.executorInstanceId,
      registrationFingerprint: registration.fingerprint,
      expectedLeaseId: null,
      leaseDurationSeconds: 60,
      idempotencyKey: "acquire-effect-retention",
    }).lease;
    const execution = {
      codexHostId: lease.codexHostId,
      executorInstanceId: lease.executorInstanceId,
      registrationFingerprint: lease.registrationFingerprint,
      leaseId: lease.id,
    };
    const operations = [{
      method: "thread/start",
      params: { cwd: "/tmp/worktree", prompt: "CAP65_OWNER_PROMPT_SENTINEL" },
    }];
    const effectInput = (effectKey, targetExecution = execution, targetOperations = operations) => ({
      effectKey,
      execution: targetExecution,
      operations: targetOperations,
    });

    database.reserveHostExecutorEffect(effectInput("retention-reserved"));
    database.reserveHostExecutorEffect(effectInput("retention-completed"));
    const completedDispatch = database.beginHostExecutorEffectDispatch(
      effectInput("retention-completed"),
    );
    database.completeHostExecutorEffect(
      "retention-completed",
      completedDispatch.dispatchToken,
      [{ thread: { id: "completed-thread" }, prompt: "CAP65_RESULT_SENTINEL" }],
    );
    database.reserveHostExecutorEffect(effectInput("retention-dispatched"));
    const retainedDispatch = database.beginHostExecutorEffectDispatch(
      effectInput("retention-dispatched"),
    );
    database.reserveHostExecutorEffect(effectInput("retention-uncertain"));
    const uncertainDispatch = database.beginHostExecutorEffectDispatch(
      effectInput("retention-uncertain"),
    );
    database.markHostExecutorEffectUncertain(
      "retention-uncertain",
      uncertainDispatch.dispatchToken,
    );

    database.close();
    currentTime = initialTime + 24 * 60 * 60 * 1_000;
    database = openDatabase();
    let inspection = new DatabaseSync(databasePath);
    const boundaryRows = inspection.prepare(`
      SELECT effect_key, operations_json FROM host_executor_effects ORDER BY effect_key
    `).all();
    assert.equal(boundaryRows.length, 4);
    assert.equal(
      boundaryRows.every((row) => row.operations_json.includes("CAP65_OWNER_PROMPT_SENTINEL")),
      true,
    );
    inspection.close();

    database.close();
    currentTime += 1;
    database = openDatabase();
    inspection = new DatabaseSync(databasePath);
    const retainedRows = inspection.prepare(`
      SELECT effect_key, status, operations_json, result_json
      FROM host_executor_effects ORDER BY effect_key
    `).all();
    assert.deepEqual(retainedRows.map((row) => ({ ...row })), [
      {
        effect_key: "retention-dispatched",
        status: "dispatched",
        operations_json: "[]",
        result_json: null,
      },
      {
        effect_key: "retention-uncertain",
        status: "uncertain",
        operations_json: "[]",
        result_json: null,
      },
    ]);
    inspection.close();

    const nextLease = database.acquireHostExecutorLease({
      codexHostId: "remote-effect-retention",
      executorInstanceId: registration.executorInstanceId,
      registrationFingerprint: registration.fingerprint,
      expectedLeaseId: lease.id,
      leaseDurationSeconds: 60,
      idempotencyKey: "acquire-effect-retention-after-ttl",
    }).lease;
    const nextExecution = {
      codexHostId: nextLease.codexHostId,
      executorInstanceId: nextLease.executorInstanceId,
      registrationFingerprint: nextLease.registrationFingerprint,
      leaseId: nextLease.id,
    };
    assert.throws(
      () => database.reserveHostExecutorEffect(
        effectInput("retention-uncertain", nextExecution),
      ),
      (error) => error?.code === "HOST_EXECUTOR_EFFECT_UNCERTAIN",
    );
    assert.throws(
      () => database.reserveHostExecutorEffect(effectInput(
        "retention-uncertain",
        nextExecution,
        [{ method: "thread/start", params: { cwd: "/tmp/changed" } }],
      )),
      (error) => error?.code === "HOST_EXECUTOR_EFFECT_IDEMPOTENCY_CONFLICT",
    );

    const lateResult = [{ thread: { id: "late-completion" } }];
    const lateCompletion = database.completeHostExecutorEffect(
      "retention-dispatched",
      retainedDispatch.dispatchToken,
      lateResult,
    );
    assert.equal(lateCompletion.status, "completed");
    assert.deepEqual(lateCompletion.operations, []);
    const lateReplay = database.reserveHostExecutorEffect(
      effectInput("retention-dispatched", nextExecution),
    );
    assert.equal(lateReplay.replayed, true);
    assert.deepEqual(lateReplay.effect.result, lateResult);

    assert.equal(database.reserveHostExecutorEffect(
      effectInput("retention-reserved", nextExecution),
    ).applied, true);
    assert.equal(database.reserveHostExecutorEffect(
      effectInput("retention-completed", nextExecution),
    ).applied, true);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor activity drains bounded retention backlog for an inactive host", async () => {
  const initialTime = Date.parse("2026-09-08T04:30:00.000Z");
  let currentTime = initialTime;
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-retention-backlog-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const openDatabase = () => new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => currentTime,
  });
  let database = openDatabase();
  try {
    const inactiveRegistration = database.registerHostExecutor({
      codexHostId: "remote-inactive-backlog",
      executorInstanceId: "executor-inactive-backlog",
      adapterId: "codex-renderer-rpc-v1",
      capabilities: ["thread/start"],
      idempotencyKey: "register-inactive-backlog",
    }).registration;
    database.close();

    const fixture = new DatabaseSync(databasePath);
    fixture.exec("BEGIN IMMEDIATE");
    try {
      fixture.prepare(`
        WITH RECURSIVE backlog(entry_index) AS (
          VALUES (0)
          UNION ALL
          SELECT entry_index + 1 FROM backlog WHERE entry_index + 1 < ?
        )
        INSERT INTO host_executor_registrations (
          executor_instance_id, codex_host_id, adapter_id, capabilities_json,
          idempotency_key, request_fingerprint, registration_fingerprint, registered_at
        )
        SELECT
          'inactive-registration-' || entry_index,
          CASE WHEN entry_index % 2 = 0 THEN 'local' ELSE 'remote-churn-backlog' END,
          CASE WHEN entry_index % 2 = 0
            THEN 'codex-app-local-v1' ELSE 'codex-renderer-rpc-v1' END,
          '["thread/read"]',
          'inactive-registration-key-' || entry_index,
          printf('%064x', entry_index + 65536),
          printf('%064x', entry_index + 65536),
          ?
        FROM backlog
      `).run(8_193, new Date(initialTime).toISOString());
      fixture.prepare(`
        WITH RECURSIVE backlog(entry_index) AS (
          VALUES (0)
          UNION ALL
          SELECT entry_index + 1 FROM backlog WHERE entry_index + 1 < ?
        )
        INSERT INTO host_executor_lease_receipts (
          id, codex_host_id, idempotency_key, request_fingerprint, action,
          lease_id, executor_instance_id, result_json, created_at
        )
        SELECT
          'inactive-receipt-' || entry_index,
          'remote-inactive-backlog',
          'inactive-receipt-key-' || entry_index,
          ?,
          'renewed',
          'inactive-lease',
          'executor-inactive-backlog',
          '{"ownerPrompt":"CAP65_BACKLOG_RECEIPT_SENTINEL"}',
          ?
        FROM backlog
      `).run(8_193, "a".repeat(64), new Date(initialTime).toISOString());
      const insertEffects = fixture.prepare(`
        WITH RECURSIVE backlog(entry_index) AS (
          VALUES (0)
          UNION ALL
          SELECT entry_index + 1 FROM backlog WHERE entry_index + 1 < ?
        )
        INSERT INTO host_executor_effects (
          effect_key, codex_host_id, executor_instance_id, registration_fingerprint,
          lease_id, adapter_id, request_fingerprint, operations_json, status,
          dispatch_token, result_json, created_at, updated_at
        )
        SELECT
          ? || entry_index,
          'remote-inactive-backlog',
          'executor-inactive-backlog',
          ?,
          'inactive-lease',
          'codex-renderer-rpc-v1',
          ?,
          ?,
          ?,
          CASE WHEN ? = 'uncertain' THEN 'inactive-dispatch-' || entry_index ELSE NULL END,
          ?,
          ?,
          ?
        FROM backlog
      `);
      insertEffects.run(
        8_193,
        "inactive-completed-",
        inactiveRegistration.fingerprint,
        "b".repeat(64),
        '[{"method":"thread/start","params":{"prompt":"CAP65_BACKLOG_COMPLETED_SENTINEL"}}]',
        "completed",
        "completed",
        '{"ownerResult":"CAP65_BACKLOG_COMPLETED_RESULT_SENTINEL"}',
        new Date(initialTime).toISOString(),
        new Date(initialTime).toISOString(),
      );
      insertEffects.run(
        8_193,
        "inactive-uncertain-",
        inactiveRegistration.fingerprint,
        "c".repeat(64),
        '[{"method":"thread/start","params":{"prompt":"CAP65_BACKLOG_UNCERTAIN_SENTINEL"}}]',
        "uncertain",
        "uncertain",
        '{"ownerResult":"CAP65_BACKLOG_UNCERTAIN_RESULT_SENTINEL"}',
        new Date(initialTime).toISOString(),
        new Date(initialTime).toISOString(),
      );
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    } finally {
      fixture.close();
    }

    currentTime += 24 * 60 * 60 * 1_000 + 1;
    database = openDatabase();
    const inactiveBacklog = () => {
      const inspection = new DatabaseSync(databasePath);
      try {
        return {
          receipts: inspection.prepare(`
            SELECT COUNT(*) AS count FROM host_executor_lease_receipts
            WHERE codex_host_id = 'remote-inactive-backlog'
          `).get().count,
          resolvedEffects: inspection.prepare(`
            SELECT COUNT(*) AS count FROM host_executor_effects
            WHERE codex_host_id = 'remote-inactive-backlog' AND status = 'completed'
          `).get().count,
          unresolvedTombstones: inspection.prepare(`
            SELECT COUNT(*) AS count FROM host_executor_effects
            WHERE codex_host_id = 'remote-inactive-backlog' AND status = 'uncertain'
          `).get().count,
          unresolvedPayloads: inspection.prepare(`
            SELECT COUNT(*) AS count FROM host_executor_effects
            WHERE codex_host_id = 'remote-inactive-backlog' AND status = 'uncertain'
              AND (operations_json <> '[]' OR result_json IS NOT NULL)
          `).get().count,
          registrations: inspection.prepare(`
            SELECT COUNT(*) AS count FROM host_executor_registrations
            WHERE executor_instance_id LIKE 'inactive-registration-%'
          `).get().count,
        };
      } finally {
        inspection.close();
      }
    };
    assert.deepEqual(inactiveBacklog(), {
      receipts: 4_097,
      resolvedEffects: 4_097,
      unresolvedTombstones: 8_193,
      unresolvedPayloads: 4_097,
      registrations: 4_097,
    });

    const activeRegistration = database.registerHostExecutor({
      codexHostId: "remote-active-backlog",
      executorInstanceId: "executor-active-backlog",
      adapterId: "codex-renderer-rpc-v1",
      capabilities: ["thread/read"],
      idempotencyKey: "register-active-backlog",
    }).registration;
    assert.deepEqual(inactiveBacklog(), {
      receipts: 1,
      resolvedEffects: 1,
      unresolvedTombstones: 8_193,
      unresolvedPayloads: 1,
      registrations: 1,
    });
    const activeLease = database.acquireHostExecutorLease({
      codexHostId: "remote-active-backlog",
      executorInstanceId: activeRegistration.executorInstanceId,
      registrationFingerprint: activeRegistration.fingerprint,
      expectedLeaseId: null,
      leaseDurationSeconds: 60,
      idempotencyKey: "acquire-active-backlog",
    }).lease;
    assert.deepEqual(inactiveBacklog(), {
      receipts: 0,
      resolvedEffects: 0,
      unresolvedTombstones: 8_193,
      unresolvedPayloads: 0,
      registrations: 0,
    });

    database.renewHostExecutorLease({
      codexHostId: "remote-active-backlog",
      executorInstanceId: activeRegistration.executorInstanceId,
      registrationFingerprint: activeRegistration.fingerprint,
      expectedLeaseId: activeLease.id,
      leaseDurationSeconds: 60,
      idempotencyKey: "renew-active-backlog",
    });
    assert.deepEqual(inactiveBacklog(), {
      receipts: 0,
      resolvedEffects: 0,
      unresolvedTombstones: 8_193,
      unresolvedPayloads: 0,
      registrations: 0,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor mutations require a fresh request-bound proof", async () => {
  const instanceSecret = "d".repeat(64);
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-proof-"));
  const { baseUrl } = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => Date.parse("2026-09-08T03:00:00.000Z"),
    removeDirectory: true,
  });
  const pathname = "/api/local/host-executors/remote-proof/registrations/executor-proof";
  const body = { adapterId: "codex-renderer-rpc-v1", idempotencyKey: "register-proof" };
  const signedAt = Date.now();
  const headers = signedHeaders(instanceSecret, nonce(41), pathname, body, signedAt, "PUT");

  const tampered = await request(baseUrl, pathname, {
    method: "PUT",
    headers,
    body: { ...body, idempotencyKey: "tampered" },
  });
  assert.deepEqual(
    [tampered.response.status, tampered.body.error.code],
    [403, "INJECTOR_PROOF_REQUIRED"],
  );

  const accepted = await request(baseUrl, pathname, { method: "PUT", headers, body });
  assert.equal(accepted.response.status, 200);

  const replayedProof = await request(baseUrl, pathname, { method: "PUT", headers, body });
  assert.deepEqual(
    [replayedProof.response.status, replayedProof.body.error.code],
    [403, "INJECTOR_PROOF_REQUIRED"],
  );

  const expiredHeaders = signedHeaders(
    instanceSecret,
    nonce(42),
    pathname,
    body,
    Date.now() - 31_000,
    "PUT",
  );
  const expired = await request(baseUrl, pathname, {
    method: "PUT",
    headers: expiredHeaders,
    body,
  });
  assert.deepEqual(
    [expired.response.status, expired.body.error.code],
    [403, "INJECTOR_PROOF_REQUIRED"],
  );

  const inspection = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  assert.equal(
    inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_registrations").get().count,
    1,
  );
  assert.equal(
    inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_leases").get().count,
    0,
  );
  inspection.close();
});

test("invalid host executor inputs and idempotency conflicts do not mutate leases", async () => {
  const instanceSecret = "e".repeat(64);
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-validation-"));
  const { baseUrl } = await launchServer({
    directory,
    instanceSecret,
    hostExecutorClock: () => Date.parse("2026-09-08T04:00:00.000Z"),
    removeDirectory: true,
  });

  const invalidHostPath = "/api/local/host-executors/%20remote-invalid/registrations/executor-a";
  const registrationBody = {
    adapterId: "codex-renderer-rpc-v1",
    idempotencyKey: "invalid-host-registration",
  };
  const invalidHost = await protectedRequest({
    baseUrl,
    instanceSecret,
    nonceIndex: 51,
    pathname: invalidHostPath,
    method: "PUT",
    body: registrationBody,
  });
  assert.deepEqual(
    [invalidHost.response.status, invalidHost.body.error.code],
    [400, "INVALID_FIELD"],
  );

  const registration = await registerExecutor({
    baseUrl,
    instanceSecret,
    nonceIndex: 52,
    codexHostId: "remote-validation",
    executorInstanceId: "executor-a",
    idempotencyKey: "register-a",
  });
  assert.equal(registration.response.status, 200);
  const leasePath = "/api/local/host-executors/remote-validation/lease";
  const leaseBody = {
    executorInstanceId: "executor-a",
    registrationFingerprint: registration.body.registration.fingerprint,
    expectedLeaseId: null,
    leaseDurationSeconds: 60,
    idempotencyKey: "acquire-a",
  };

  const invalidDuration = await protectedRequest({
    baseUrl,
    instanceSecret,
    nonceIndex: 53,
    pathname: leasePath,
    body: { ...leaseBody, leaseDurationSeconds: 29, idempotencyKey: "invalid-duration" },
  });
  assert.deepEqual(
    [invalidDuration.response.status, invalidDuration.body.error.code],
    [400, "INVALID_FIELD"],
  );

  const acquired = await protectedRequest({
    baseUrl,
    instanceSecret,
    nonceIndex: 54,
    pathname: leasePath,
    body: leaseBody,
  });
  assert.equal(acquired.response.status, 200);

  const conflictingReplay = await protectedRequest({
    baseUrl,
    instanceSecret,
    nonceIndex: 55,
    pathname: leasePath,
    body: { ...leaseBody, leaseDurationSeconds: 90 },
  });
  assert.deepEqual(
    [conflictingReplay.response.status, conflictingReplay.body.error.code],
    [409, "HOST_EXECUTOR_LEASE_IDEMPOTENCY_CONFLICT"],
  );

  const inspection = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  assert.equal(
    inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_registrations").get().count,
    1,
  );
  assert.equal(
    inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_leases").get().count,
    1,
  );
  assert.equal(
    inspection.prepare("SELECT COUNT(*) AS count FROM host_executor_lease_receipts").get().count,
    1,
  );
  assert.equal(
    inspection.prepare("SELECT expires_at FROM host_executor_leases").get().expires_at,
    acquired.body.lease.expiresAt,
  );
  inspection.close();
});

test("host executor lease decisions sample time only after acquiring the SQLite write lock", async () => {
  const initialTime = Date.parse("2026-09-08T05:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-lock-time-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const clockPath = path.join(directory, "clock.txt");
  await writeFile(clockPath, String(initialTime));
  const database = new TaskboardDatabase(databasePath, {
    hostExecutorClock: () => Number(readFileSync(clockPath, "utf8")),
  });
  try {
    const register = (codexHostId, executorInstanceId) => (
      database.registerHostExecutor({
        codexHostId,
        executorInstanceId,
        adapterId: "codex-renderer-rpc-v1",
        capabilities: ["thread/read"],
        idempotencyKey: `register-${executorInstanceId}`,
      }).registration
    );
    const acquire = (codexHostId, registration, expectedLeaseId, idempotencyKey) => (
      database.acquireHostExecutorLease({
        codexHostId,
        executorInstanceId: registration.executorInstanceId,
        registrationFingerprint: registration.fingerprint,
        expectedLeaseId,
        leaseDurationSeconds: 30,
        idempotencyKey,
      })
    );

    const renewRegistration = register("remote-renew-lock", "executor-renew");
    const releaseRegistration = register("remote-release-lock", "executor-release");
    const takeoverRegistrationA = register("remote-takeover-lock", "executor-takeover-a");
    const takeoverRegistrationB = register("remote-takeover-lock", "executor-takeover-b");
    register("remote-registration-lock", "executor-registration-old");
    const renewedCandidate = acquire(
      "remote-renew-lock", renewRegistration, null, "acquire-renew-candidate",
    );
    const releasedCandidate = acquire(
      "remote-release-lock", releaseRegistration, null, "acquire-release-candidate",
    );
    const takeoverCandidate = acquire(
      "remote-takeover-lock", takeoverRegistrationA, null, "acquire-takeover-candidate",
    );

    const afterExpiry = initialTime + 31_000;
    const renewLock = await holdWriteLockAndAdvanceClock(databasePath, clockPath, afterExpiry);
    let renewError;
    try {
      database.renewHostExecutorLease({
        codexHostId: "remote-renew-lock",
        executorInstanceId: renewRegistration.executorInstanceId,
        registrationFingerprint: renewRegistration.fingerprint,
        expectedLeaseId: renewedCandidate.lease.id,
        leaseDurationSeconds: 30,
        idempotencyKey: "renew-after-lock-wait",
      });
    } catch (error) {
      renewError = error;
    }
    await renewLock.exited;

    await writeFile(clockPath, String(initialTime));
    const releaseLock = await holdWriteLockAndAdvanceClock(databasePath, clockPath, afterExpiry);
    let releaseError;
    try {
      database.releaseHostExecutorLease({
        codexHostId: "remote-release-lock",
        executorInstanceId: releaseRegistration.executorInstanceId,
        registrationFingerprint: releaseRegistration.fingerprint,
        expectedLeaseId: releasedCandidate.lease.id,
        idempotencyKey: "release-after-lock-wait",
      });
    } catch (error) {
      releaseError = error;
    }
    await releaseLock.exited;

    await writeFile(clockPath, String(initialTime));
    const acquireLock = await holdWriteLockAndAdvanceClock(databasePath, clockPath, afterExpiry);
    let takeover;
    let takeoverError;
    try {
      takeover = acquire(
        "remote-takeover-lock",
        takeoverRegistrationB,
        takeoverCandidate.lease.id,
        "takeover-after-lock-wait",
      );
    } catch (error) {
      takeoverError = error;
    }
    await acquireLock.exited;

    const retentionBoundary = initialTime + 24 * 60 * 60 * 1_000;
    await writeFile(clockPath, String(retentionBoundary));
    const registrationLock = await holdWriteLockAndAdvanceClock(
      databasePath,
      clockPath,
      retentionBoundary + 1,
    );
    const latestRegistration = register(
      "remote-registration-lock",
      "executor-registration-new",
    );
    await registrationLock.exited;
    assert.deepEqual(
      [renewError?.code, releaseError?.code, takeoverError?.code],
      [
        "HOST_EXECUTOR_LEASE_NOT_ACTIVE",
        "HOST_EXECUTOR_LEASE_NOT_ACTIVE",
        undefined,
      ],
    );
    assert.notEqual(takeover.lease.id, takeoverCandidate.lease.id);
    assert.equal(takeover.lease.executorInstanceId, "executor-takeover-b");

    const inspection = new DatabaseSync(databasePath);
    assert.equal(
      inspection.prepare(`
        SELECT COUNT(*) AS count FROM host_executor_lease_receipts
        WHERE idempotency_key IN ('renew-after-lock-wait', 'release-after-lock-wait')
      `).get().count,
      0,
    );
    assert.equal(
      inspection.prepare(`
        SELECT executor_instance_id FROM host_executor_leases
        WHERE codex_host_id = 'remote-takeover-lock'
      `).get().executor_instance_id,
      "executor-takeover-b",
    );
    assert.deepEqual(
      inspection.prepare(`
        SELECT executor_instance_id FROM host_executor_registrations
        WHERE codex_host_id = 'remote-registration-lock'
        ORDER BY executor_instance_id
      `).all().map((row) => row.executor_instance_id),
      [latestRegistration.executorInstanceId],
    );
    inspection.close();
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor proof nonce remains one-use across a same-secret server restart", async () => {
  const instanceSecret = "1".repeat(64);
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-proof-restart-"));
  let { app, baseUrl } = await launchServer({
    directory,
    instanceSecret,
    removeDirectory: false,
  });
  const pathname = "/api/local/host-executors";
  const headers = signedHeaders(instanceSecret, nonce(71), pathname, null, Date.now(), "GET");
  const first = await request(baseUrl, pathname, { method: "GET", headers });
  assert.equal(first.response.status, 200);

  await stopServer(app);
  ({ app, baseUrl } = await launchServer({
    directory,
    instanceSecret,
    removeDirectory: true,
  }));
  const replay = await request(baseUrl, pathname, { method: "GET", headers });
  assert.deepEqual(
    [replay.response.status, replay.body?.error?.code],
    [403, "INJECTOR_PROOF_REQUIRED"],
  );
});

test("host executor nonce retention covers the inclusive proof freshness endpoint", async () => {
  const initialTime = Date.parse("2026-09-08T06:00:00.000Z");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-nonce-boundary-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const originalDateNow = Date.now;
  let currentTime = initialTime;
  try {
    Date.now = () => currentTime;
    const nonceValue = "ab".repeat(16);
    const issuedAt = initialTime + 30_000;
    assert.equal(database.consumeHostExecutorProofNonce(nonceValue, issuedAt), true);
    currentTime = initialTime + 60_000;
    assert.equal(database.consumeHostExecutorProofNonce(nonceValue, issuedAt), false);
  } finally {
    Date.now = originalDateNow;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("host executor GET inspection rejects an actual request body", async () => {
  const instanceSecret = "2".repeat(64);
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-host-executor-get-body-"));
  const { baseUrl } = await launchServer({
    directory,
    instanceSecret,
    removeDirectory: true,
  });
  const pathname = "/api/local/host-executors";
  const body = JSON.stringify({ notSignedAsNull: true });
  const headers = {
    ...signedHeaders(instanceSecret, nonce(81), pathname, null, Date.now(), "GET"),
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  };
  const response = await rawHttpRequest(baseUrl, pathname, {
    method: "GET",
    headers,
    body,
  });
  assert.deepEqual(
    [response.response.status, response.body?.error?.code],
    [400, "INVALID_BODY"],
  );
});
