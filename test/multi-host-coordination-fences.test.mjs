import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import {
  runCrossDomainHandoffMonitorOnce,
  runOwnerDecisionMonitorOnce,
  runOwnerIntentAdoptionMonitorOnce,
  runOwnerIntentCaptureMonitorOnce,
  runOwnerIntentPlanningMonitorOnce,
} from "../scripts/codex-injector-runtime.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const ownerRootThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
const coordinatorThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
const longRemoteHostId = `host-${"x".repeat(251)}`;
const runningServers = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const { app, directory } = runningServers.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function injectorHeaders(instanceSecret, nonce) {
  return {
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-proof": createHmac("sha256", instanceSecret)
      .update(nonce)
      .digest("hex"),
  };
}

function requestBoundHeaders(instanceSecret, nonce, method, pathname, body) {
  const issuedAt = String(Date.now());
  return {
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-issued-at": issuedAt,
    "x-codex-taskboard-injector-proof": createHmac("sha256", instanceSecret)
      .update(JSON.stringify({ nonce, issuedAt, method, pathname, body }))
      .digest("hex"),
  };
}

function executionHeaders(instanceSecret, method, pathname, body, execution) {
  const serialized = Buffer.from(JSON.stringify(execution), "utf8").toString("base64url");
  return {
    "x-codex-taskboard-host-execution": serialized,
    "x-codex-taskboard-host-execution-proof": createHmac("sha256", instanceSecret)
      .update(JSON.stringify({ method, pathname, body, execution: serialized }))
      .digest("hex"),
  };
}

async function jsonRequest(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: JSON.parse(await response.text()) };
}

function createRemoteExecutor(database, codexHostId, executorInstanceId) {
  const registration = database.registerHostExecutor({
    codexHostId,
    executorInstanceId,
    adapterId: "codex-renderer-rpc-v1",
    capabilities: ["thread/read", "thread/resume", "turn/start"],
    idempotencyKey: `register-${executorInstanceId}`,
  }).registration;
  const lease = database.acquireHostExecutorLease({
    codexHostId,
    executorInstanceId,
    registrationFingerprint: registration.fingerprint,
    expectedLeaseId: null,
    leaseDurationSeconds: 300,
    idempotencyKey: `acquire-${executorInstanceId}`,
  }).lease;
  return {
    codexHostId,
    executorInstanceId,
    registrationFingerprint: registration.fingerprint,
    leaseId: lease.id,
  };
}

async function startConfiguredServer(configure) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-multi-host-fences-"));
  const instanceSecret = "d".repeat(64);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  const state = await configure(database);
  database.close();
  const app = createTaskboardServer({ dataDirectory: directory, instanceSecret });
  const address = await app.listen({ port: 0 });
  runningServers.push({ app, directory });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    databasePath,
    instanceSecret,
    ...state,
  };
}

const monitorDefinitions = [{
  name: "Owner Intent capture",
  run: runOwnerIntentCaptureMonitorOnce,
  falseField: "captured",
}, {
  name: "Owner Intent adoption",
  run: runOwnerIntentAdoptionMonitorOnce,
  falseField: "delivered",
}, {
  name: "Owner Intent planning",
  run: runOwnerIntentPlanningMonitorOnce,
  falseField: "applied",
}, {
  name: "cross-domain handoff",
  run: runCrossDomainHandoffMonitorOnce,
  falseField: "delivered",
}, {
  name: "Owner decision",
  run: runOwnerDecisionMonitorOnce,
  falseField: "delivered",
}];

function monitorOptions(name, {
  projectId,
  hostExecutor,
  routeHostId,
  readSnapshot,
  downstream,
}) {
  const coordinatorRoute = {
    coordinatorTaskId: "coordinator",
    coordinatorThreadId,
    codexHostId: routeHostId,
    coordinatorWorkspacePath: "/tmp/taskboard/coordinator",
  };
  const snapshots = {
    "Owner Intent capture": {
      projectId,
      coordination: { ownerRootTaskId: "owner-root" },
      taskLanes: [{
        id: "owner-root",
        taskType: "root_task",
        threadId: ownerRootThreadId,
        codexHostId: routeHostId,
        workspacePath: "/tmp/taskboard/owner-root",
      }],
    },
    "Owner Intent adoption": {
      projectId,
      coordination: {
        pendingOwnerIntent: {
          intentId: "intent-host-scope",
          kind: "append",
          targetIntentId: null,
          goal: "Keep the exact host owner.",
          constraints: [],
          coordinatorEpoch: "configured:coordinator",
          route: coordinatorRoute,
        },
      },
    },
    "Owner Intent planning": {
      projectId,
      coordination: {
        pendingOwnerIntentPlan: {
          intentId: "intent-host-scope",
          adoptionReceipt: {
            id: "adoption-host-scope",
            deliveryTurnId: "turn-host-scope",
            coordinatorEpoch: "configured:coordinator",
          },
          route: coordinatorRoute,
        },
      },
    },
    "cross-domain handoff": {
      projectId,
      coordination: {
        pendingCrossDomainHandoff: {
          projectId,
          sourceTaskId: "source-task",
          sourceIdentifier: "CAP-24",
          targetTaskId: "target-task",
          targetIdentifier: "CAP-25",
          fingerprint: "a".repeat(64),
          sourceDomainId: "frontend",
          targetDomainId: "backend",
          expectedTargetDomainLeaseId: "backend-lease",
          targetHolderTaskId: "backend-coordinator",
          route: {
            targetThreadId: coordinatorThreadId,
            codexHostId: routeHostId,
            targetWorkspacePath: "/tmp/taskboard/backend",
          },
        },
      },
    },
    "Owner decision": {
      projectId,
      coordination: {
        ownerDecisionRequest: {
          requestId: "b".repeat(64),
          expectedResumeToken: "c".repeat(64),
          identifier: "CAP-64",
          actionId: "owner-decision-host-scope",
          message: "Choose the bounded option.",
          coordinatorEpoch: "configured:coordinator",
          route: {
            rootTaskId: "owner-root",
            rootThreadId: ownerRootThreadId,
            codexHostId: routeHostId,
            rootWorkspacePath: "/tmp/taskboard/owner-root",
          },
        },
      },
    },
  };
  const common = {
    policy: { enabled: true, projectId },
    hostExecutor,
    readSnapshot: async () => {
      await readSnapshot();
      return snapshots[name];
    },
  };
  if (name === "Owner Intent capture") return {
    ...common,
    listIntents: async () => { downstream(); return []; },
    observeCapture: async () => null,
    recordCapture: async () => assert.fail("an empty frontier cannot record a capture"),
  };
  if (name === "Owner Intent adoption") return {
    ...common,
    claimAdoption: async () => { downstream(); return { claimed: false, reason: "reservation-rejected" }; },
    confirmAdoption: async () => assert.fail("a rejected claim cannot confirm"),
    deliver: async () => assert.fail("a rejected claim cannot deliver"),
  };
  if (name === "Owner Intent planning") return {
    ...common,
    observePlan: async () => { downstream(); return null; },
    applyPlan: async () => assert.fail("an absent plan cannot apply"),
  };
  if (name === "cross-domain handoff") return {
    ...common,
    claimDelivery: async () => { downstream(); return { claimed: false, reason: "reservation-rejected" }; },
    confirmDelivery: async () => assert.fail("a rejected claim cannot confirm"),
    deliver: async () => assert.fail("a rejected claim cannot deliver"),
  };
  return {
    ...common,
    claimDelivery: async () => { downstream(); return { claimed: false, reason: "reservation-rejected" }; },
    confirmDelivery: async () => assert.fail("a rejected claim cannot confirm"),
    deliver: async () => assert.fail("a rejected claim cannot deliver"),
    observeDecision: async () => assert.fail("a rejected claim cannot observe"),
    recordDecision: async () => assert.fail("a rejected claim cannot record"),
  };
}

test("host-routed coordination monitors require an explicit canonical executor before snapshot reads", async () => {
  for (const definition of monitorDefinitions) {
    let reads = 0;
    let downstreamCalls = 0;
    const result = await definition.run(monitorOptions(definition.name, {
      projectId: `missing-host-${definition.name.toLowerCase().replaceAll(" ", "-")}`,
      hostExecutor: undefined,
      routeHostId: longRemoteHostId,
      readSnapshot: async () => { reads += 1; },
      downstream: () => { downstreamCalls += 1; },
    }));
    assert.deepEqual(result, {
      [definition.falseField]: false,
      reason: "host-executor-unavailable",
    }, definition.name);
    assert.equal(reads, 0, definition.name);
    assert.equal(downstreamCalls, 0, definition.name);
  }
});

test("five coordination monitor single-flights are isolated by exact canonical host", async () => {
  for (const definition of monitorDefinitions) {
    const projectId = `host-scope-${definition.name.toLowerCase().replaceAll(" ", "-")}`;
    let releaseForeign;
    let releaseOwner;
    const foreignGate = new Promise((resolve) => { releaseForeign = resolve; });
    const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
    let foreignReads = 0;
    let ownerReads = 0;
    let foreignDownstream = 0;
    let ownerDownstream = 0;
    const foreign = definition.run(monitorOptions(definition.name, {
      projectId,
      hostExecutor: { ownedCodexHostId: "local" },
      routeHostId: longRemoteHostId,
      readSnapshot: async () => { foreignReads += 1; await foreignGate; },
      downstream: () => { foreignDownstream += 1; },
    }));
    await Promise.resolve();
    const ownerOptions = monitorOptions(definition.name, {
      projectId,
      hostExecutor: { ownedCodexHostId: longRemoteHostId },
      routeHostId: longRemoteHostId,
      readSnapshot: async () => { ownerReads += 1; await ownerGate; },
      downstream: () => { ownerDownstream += 1; },
    });
    const ownerFirst = definition.run(ownerOptions);
    const ownerReplay = definition.run(ownerOptions);
    await Promise.resolve();
    releaseForeign();
    releaseOwner();
    await Promise.all([foreign, ownerFirst, ownerReplay]);
    assert.equal(foreignReads, 1, definition.name);
    assert.equal(ownerReads, 1, definition.name);
    assert.equal(foreignDownstream, 0, definition.name);
    assert.equal(ownerDownstream, 1, definition.name);
  }
});

test("remote host executor lists and confirms only its own Coordinator identity handshake", async () => {
  const projectId = "remote-handshake-scope";
  const remoteHostId = "remote-handshake-host";
  const remoteWorkspacePath = "/tmp/taskboard/remote-handshake";
  const registration = {
    role: "coordinator",
    taskId: "coordinator",
    label: "Remote Coordinator",
    threadId: coordinatorThreadId,
    expectedRevision: null,
    idempotencyKey: "remote-handshake-window",
  };
  const server = await startConfiguredServer(async (database) => {
    database.createProject({ id: projectId, name: "Remote handshake scope", workspacePath: null });
    database.upsertAgentLaneProject(projectId, {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [
        {
          id: "owner-root",
          label: "Remote Owner Root",
          owner: "Codex",
          source: "codex",
          threadId: ownerRootThreadId,
          taskType: "root_task",
          codexProjectId: "remote-project",
          codexProjectKind: "remote",
          codexHostId: remoteHostId,
          workspacePath: remoteWorkspacePath,
        },
        {
          id: "coordinator",
          label: "Remote Coordinator",
          owner: "Codex",
          source: "codex",
          threadId: coordinatorThreadId,
          taskType: "root_task",
          codexProjectId: "remote-project",
          codexProjectKind: "remote",
          codexHostId: remoteHostId,
          workspacePath: remoteWorkspacePath,
        },
      ],
      adapters: [],
    });
    registration.expectedRevision = database.getAgentLaneCoordinationWindows(projectId).revision;
    const handshake = database.requestAgentLaneCoordinationIdentityHandshake(projectId, registration);
    const execution = createRemoteExecutor(database, remoteHostId, "remote-handshake-executor");
    return { execution, handshake };
  });
  const listPath = `/api/local/projects/${projectId}/coordination-identity-handshakes`;
  const localList = await jsonRequest(server.baseUrl, listPath, {
    headers: {
      ...requestBoundHeaders(server.instanceSecret, "1".repeat(32), "GET", listPath, null),
      "x-taskboard-client": "taskctl",
    },
  });
  assert.equal(localList.response.status, 200, JSON.stringify(localList.body));
  assert.deepEqual(localList.body.handshakes, []);

  const remoteList = await jsonRequest(server.baseUrl, listPath, {
    headers: {
      ...requestBoundHeaders(server.instanceSecret, "2".repeat(32), "GET", listPath, null),
      ...executionHeaders(server.instanceSecret, "GET", listPath, null, server.execution),
    },
  });
  assert.equal(remoteList.response.status, 200, JSON.stringify(remoteList.body));
  assert.deepEqual(remoteList.body.handshakes.map(({ id }) => id), [server.handshake.id]);

  const confirmPath = `/api/local/coordination-identity-handshakes/${server.handshake.id}/confirm`;
  const confirmBody = {
    registration: { projectId, ...registration },
    threadBinding: {
      threadId: coordinatorThreadId,
      codexProjectId: "remote-project",
      codexProjectKind: "remote",
      codexHostId: remoteHostId,
      workspacePath: remoteWorkspacePath,
    },
  };
  const confirmed = await jsonRequest(server.baseUrl, confirmPath, {
    method: "POST",
    headers: {
      ...requestBoundHeaders(
        server.instanceSecret, "3".repeat(32), "POST", confirmPath, confirmBody,
      ),
      ...executionHeaders(
        server.instanceSecret, "POST", confirmPath, confirmBody, server.execution,
      ),
    },
    body: confirmBody,
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.handshake.status, "completed");
  assert.equal(confirmed.body.registration.applied, true);
});

test("foreign host confirmation cannot mutate another host's stale handshake", async () => {
  const observed = [];
  for (const [index, staleKind] of ["expired", "revision-stale"].entries()) {
    const projectId = `foreign-stale-${staleKind}`;
    const ownerHostId = `owner-host-${staleKind}`;
    const foreignHostId = `foreign-host-${staleKind}`;
    const ownerWorkspacePath = `/tmp/taskboard/owner-${staleKind}`;
    const registration = {
      role: "coordinator",
      taskId: "coordinator",
      label: "Remote Coordinator",
      threadId: coordinatorThreadId,
      expectedRevision: null,
      idempotencyKey: `foreign-stale-window-${staleKind}`,
    };
    const server = await startConfiguredServer(async (database) => {
      database.createProject({ id: projectId, name: projectId, workspacePath: null });
      const config = {
        rootTaskId: "owner-root",
        ownerRootTaskId: "owner-root",
        tasks: [
          {
            id: "owner-root",
            label: "Remote Owner Root",
            owner: "Codex",
            source: "codex",
            threadId: ownerRootThreadId,
            taskType: "root_task",
            codexProjectId: `owner-project-${staleKind}`,
            codexProjectKind: "remote",
            codexHostId: ownerHostId,
            workspacePath: ownerWorkspacePath,
          },
          {
            id: "coordinator",
            label: "Remote Coordinator",
            owner: "Codex",
            source: "codex",
            threadId: coordinatorThreadId,
            taskType: "root_task",
            codexProjectId: `owner-project-${staleKind}`,
            codexProjectKind: "remote",
            codexHostId: ownerHostId,
            workspacePath: ownerWorkspacePath,
          },
        ],
        adapters: [],
      };
      database.upsertAgentLaneProject(projectId, config);
      registration.expectedRevision = database.getAgentLaneCoordinationWindows(projectId).revision;
      const handshake = database.requestAgentLaneCoordinationIdentityHandshake(
        projectId,
        registration,
      );
      if (staleKind === "expired") {
        database.database.prepare(`
          UPDATE agent_coordination_identity_handshakes SET expires_at = ? WHERE id = ?
        `).run("2000-01-01T00:00:00.000Z", handshake.id);
      } else {
        database.upsertAgentLaneProject(projectId, {
          ...config,
          tasks: config.tasks.map((task) => (
            task.id === "owner-root" ? { ...task, label: "Updated Owner Root" } : task
          )),
        });
      }
      return {
        execution: createRemoteExecutor(
          database,
          foreignHostId,
          `foreign-executor-${staleKind}`,
        ),
        handshake,
      };
    });
    const confirmPath = `/api/local/coordination-identity-handshakes/${server.handshake.id}/confirm`;
    const confirmBody = {
      registration: { projectId, ...registration },
      threadBinding: {
        threadId: coordinatorThreadId,
        codexProjectId: `foreign-project-${staleKind}`,
        codexProjectKind: "remote",
        codexHostId: foreignHostId,
        workspacePath: `/tmp/taskboard/foreign-${staleKind}`,
      },
    };
    const response = await jsonRequest(server.baseUrl, confirmPath, {
      method: "POST",
      headers: {
        ...requestBoundHeaders(
          server.instanceSecret,
          String(index + 8).repeat(32),
          "POST",
          confirmPath,
          confirmBody,
        ),
        ...executionHeaders(
          server.instanceSecret,
          "POST",
          confirmPath,
          confirmBody,
          server.execution,
        ),
      },
      body: confirmBody,
    });
    const inspection = new DatabaseSync(server.databasePath, { readOnly: true });
    const row = inspection.prepare(`
      SELECT status FROM agent_coordination_identity_handshakes WHERE id = ?
    `).get(server.handshake.id);
    inspection.close();
    observed.push({
      staleKind,
      statusCode: response.response.status,
      errorCode: response.body.error?.code,
      persistedStatus: row.status,
    });
  }
  assert.deepEqual(observed, [
    {
      staleKind: "expired",
      statusCode: 409,
      errorCode: "HOST_EXECUTOR_LEASE_STALE",
      persistedStatus: "pending",
    },
    {
      staleKind: "revision-stale",
      statusCode: 409,
      errorCode: "HOST_EXECUTOR_LEASE_STALE",
      persistedStatus: "pending",
    },
  ]);
});

test("remote Owner Intent survives a later heartbeat from another host", async () => {
  const projectId = "remote-owner-intent";
  const remoteHostId = "remote-owner-host";
  const remoteWorkspacePath = "/tmp/taskboard/remote-owner";
  const server = await startConfiguredServer(async (database) => {
    database.createProject({ id: projectId, name: "Remote Owner Intent", workspacePath: null });
    database.upsertAgentLaneProject(projectId, {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root",
        label: "Remote Owner Root",
        owner: "Codex",
        source: "codex",
        threadId: ownerRootThreadId,
        taskType: "root_task",
        codexProjectId: "remote-owner-project",
        codexProjectKind: "remote",
        codexHostId: remoteHostId,
        workspacePath: remoteWorkspacePath,
      }],
      adapters: [],
    });
    return {
      execution: createRemoteExecutor(database, remoteHostId, "remote-owner-executor"),
    };
  });
  const hostRuntimePath = "/api/local/host-runtime";
  const remoteBinding = {
    threadId: ownerRootThreadId,
    codexProjectId: "remote-owner-project",
    codexProjectKind: "remote",
    codexHostId: remoteHostId,
    workspacePath: remoteWorkspacePath,
  };
  const remoteHeartbeat = await jsonRequest(server.baseUrl, hostRuntimePath, {
    method: "PUT",
    headers: injectorHeaders(server.instanceSecret, "4".repeat(32)),
    body: { ...remoteBinding, threadRunning: false, threadTodoProgress: null },
  });
  assert.equal(remoteHeartbeat.response.status, 200, JSON.stringify(remoteHeartbeat.body));
  const localHeartbeat = await jsonRequest(server.baseUrl, hostRuntimePath, {
    method: "PUT",
    headers: injectorHeaders(server.instanceSecret, "5".repeat(32)),
    body: {
      threadId: coordinatorThreadId,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/taskboard/local-root",
      threadRunning: false,
      threadTodoProgress: null,
    },
  });
  assert.equal(localHeartbeat.response.status, 200, JSON.stringify(localHeartbeat.body));

  const intentPath = `/api/local/projects/${projectId}/owner-intents`;
  const intentBody = {
    intentId: "remote-owner-intent-1",
    deliveryId: "remote-owner-delivery-1",
    kind: "append",
    goal: "Continue the exact remote Owner goal.",
    constraints: ["Preserve one writer."],
    targetIntentId: null,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId,
    ownerTurnId: "remote-owner-turn-1",
    rootCaptureTurnId: "remote-root-capture-1",
    evidence: "Observed the exact remote Owner Root turn.",
  };
  const recorded = await jsonRequest(server.baseUrl, intentPath, {
    method: "POST",
    headers: {
      ...injectorHeaders(server.instanceSecret, "6".repeat(32)),
      ...executionHeaders(server.instanceSecret, "POST", intentPath, intentBody, server.execution),
    },
    body: intentBody,
  });
  assert.equal(recorded.response.status, 201, JSON.stringify(recorded.body));
  assert.equal(recorded.body.applied, true);
  assert.deepEqual(recorded.body.intent.sourceThreadBinding, remoteBinding);

  const conflictingHeartbeat = await jsonRequest(server.baseUrl, hostRuntimePath, {
    method: "PUT",
    headers: injectorHeaders(server.instanceSecret, "7".repeat(32)),
    body: {
      ...remoteBinding,
      codexProjectId: "wrong-remote-owner-project",
      threadRunning: false,
      threadTodoProgress: null,
    },
  });
  assert.equal(conflictingHeartbeat.response.status, 200, JSON.stringify(conflictingHeartbeat.body));
  const conflictingBody = {
    ...intentBody,
    intentId: "remote-owner-intent-2",
    deliveryId: "remote-owner-delivery-2",
    ownerTurnId: "remote-owner-turn-2",
    rootCaptureTurnId: "remote-root-capture-2",
  };
  const rejected = await jsonRequest(server.baseUrl, intentPath, {
    method: "POST",
    headers: {
      ...injectorHeaders(server.instanceSecret, "8".repeat(32)),
      ...executionHeaders(
        server.instanceSecret, "POST", intentPath, conflictingBody, server.execution,
      ),
    },
    body: conflictingBody,
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "OWNER_ROOT_ROUTE_STALE");
  const listed = await jsonRequest(server.baseUrl, intentPath);
  assert.deepEqual(listed.body.intents.map(({ intentId }) => intentId), [intentBody.intentId]);
});

test("host runtime rejects incomplete or kind-host inconsistent identity atomically", async () => {
  const server = await startConfiguredServer(async () => ({}));
  const hostRuntimePath = "/api/local/host-runtime";
  const validRuntime = {
    threadId: ownerRootThreadId,
    codexProjectId: "remote-owner-project",
    codexProjectKind: "remote",
    codexHostId: "remote-owner-host",
    workspacePath: "/tmp/taskboard/remote-owner",
    threadRunning: false,
    threadTodoProgress: null,
  };
  const published = await jsonRequest(server.baseUrl, hostRuntimePath, {
    method: "PUT",
    headers: injectorHeaders(server.instanceSecret, "9".repeat(32)),
    body: validRuntime,
  });
  assert.equal(published.response.status, 200, JSON.stringify(published.body));
  const before = await jsonRequest(server.baseUrl, hostRuntimePath);

  for (const [nonce, body] of [
    ["a".repeat(32), { ...validRuntime, codexProjectKind: "local" }],
    ["b".repeat(32), { ...validRuntime, codexProjectId: null }],
  ]) {
    const rejected = await jsonRequest(server.baseUrl, hostRuntimePath, {
      method: "PUT",
      headers: injectorHeaders(server.instanceSecret, nonce),
      body,
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "INVALID_FIELD");
    const after = await jsonRequest(server.baseUrl, hostRuntimePath);
    assert.deepEqual(after.body.runtime, before.body.runtime);
  }
});
