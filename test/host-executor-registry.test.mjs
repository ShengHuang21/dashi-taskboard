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
