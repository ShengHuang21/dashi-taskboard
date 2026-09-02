import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, appendFile, chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { createTaskboardServer, resolveHost } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import {
  classifyOwnerIntentPlanHttpFailure,
  deliverTaskboardCoordination,
  runOwnerIntentPlanningMonitorOnce,
  runTaskboardContinuationMonitorOnce,
} from "../scripts/codex-injector-runtime.mjs";

const runningApps = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(configure, listenOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-test-"));
  const options = configure ? await configure(directory) : {};
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0, ...listenOptions });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
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
  return {
    response,
    body: text ? JSON.parse(text) : undefined,
  };
}

async function requestWithHost(baseUrl, host) {
  const target = new URL("/health", baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(target, { headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function createRepositoryRefreshTask(database, { title, worktreePath, branch }) {
  const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  const threadBinding = {
    threadId: `thread-${title}`,
    codexProjectId: "local",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: worktreePath,
  };
  return database.createTask({
    projectId: "local",
    title,
    description: "",
    status: "todo",
    priority: "medium",
    labels: [],
    threadId: threadBinding.threadId,
    threadBinding,
    actor,
    assignee: actor,
    developmentContext: { type: "worktree", path: worktreePath, branch },
    workingLog: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

async function createRepositoryRefreshTestServer({ directory, gitProbe }) {
  const app = createTaskboardServer({
    dataDirectory: directory,
    worktreeRepositoryExecFile: gitProbe,
  });
  runningApps.push({ app, directory });
  return app;
}

function signedInjectorHeaders(instanceSecret, nonce) {
  return {
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-proof": createHmac("sha256", instanceSecret).update(nonce).digest("hex"),
  };
}

function signedCoordinatorRenewHeaders(instanceSecret, nonce, pathname, body, issuedAt = Date.now(), method = "POST") {
  const timestamp = String(issuedAt);
  const proof = createHmac("sha256", instanceSecret).update(JSON.stringify({
    nonce,
    issuedAt: timestamp,
    method,
    pathname,
    body,
  })).digest("hex");
  return {
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-issued-at": timestamp,
    "x-codex-taskboard-injector-proof": proof,
  };
}

test("resident Coordinator project discovery requires one request-bound host proof", async () => {
  const instanceSecret = "7".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator",
      tasks: [{
        id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex",
        threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local",
        workspacePath: process.cwd(),
      }],
      adapters: [],
      coordinatorLease: {
        id: "lease", holderTaskId: "coordinator", holderThreadId: "coordinator-thread",
        holderCodexHostId: "local", holderWorkspacePath: process.cwd(),
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    database.close();
    return { instanceSecret };
  });
  const pathname = "/api/local/coordinator-monitor-projects";
  const missingProof = await request(baseUrl, pathname);
  assert.equal(missingProof.response.status, 403);

  const headers = signedCoordinatorRenewHeaders(
    instanceSecret, "a".repeat(32), pathname, null, Date.now(), "GET",
  );
  const discovered = await request(baseUrl, pathname, { headers });
  assert.equal(discovered.response.status, 200);
  assert.deepEqual(discovered.body.projectIds, ["local"]);

  const replay = await request(baseUrl, pathname, { headers });
  assert.equal(replay.response.status, 403);
});

test("health and the default local project are available", async () => {
  let skillPath;
  const baseUrl = await startServer(async (directory) => {
    skillPath = path.join(directory, "skills", "manage-taskboard", "SKILL.md");
    return { skillPath };
  });

  const health = await request(baseUrl, "/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const metadata = await request(baseUrl, "/api/meta");
  assert.equal(metadata.response.status, 200);
  assert.deepEqual(metadata.body, {
    manageTaskboardSkillPath: skillPath,
    capabilities: { localAiChat: true },
  });

  const result = await request(baseUrl, "/api/projects");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.projects.length, 1);
  assert.equal(result.body.projects[0].id, "local");
  assert.equal(result.body.projects[0].name, "全局");
  assert.equal(result.body.projects[0].workspacePath, null);
  assert.equal(result.body.projects[0].issueCount, 0);
  const agentLaneProjects = await request(baseUrl, "/api/local/agent-lane-projects");
  assert.equal(agentLaneProjects.response.status, 200);
  assert.deepEqual(agentLaneProjects.body, { projectIds: [] });
});

test("database reuses prepared statements across repeated hot reads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-statement-cache-test-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"), {
    statementCacheMax: 3,
  });
  try {
    const nativePrepare = database.database.prepare.bind(database.database);
    let prepareCalls = 0;
    database.database.prepare = (...args) => {
      prepareCalls += 1;
      return nativePrepare(...args);
    };
    database.statementCache.clear();
    assert.equal(database.getProject("local")?.id, "local");
    const warmedPrepareCalls = prepareCalls;
    assert.ok(warmedPrepareCalls > 0);
    for (let index = 0; index < 20; index += 1) {
      assert.equal(database.getProject("local")?.id, "local");
    }
    assert.equal(prepareCalls, warmedPrepareCalls);
    database.listProjects();
    database.listTasks({ projectId: "local", archived: "false" });
    database.getTask("missing-task");
    assert.equal(database.statementCache.size, 3);
    const prepareCallsBeforeEvictedRead = prepareCalls;
    assert.equal(database.getProject("local")?.id, "local");
    assert.equal(prepareCalls, prepareCallsBeforeEvictedRead + 1);
    assert.equal(database.statementCache.size, 3);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worktree repository refresh coalesces shared task probes and concurrent force", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-refresh-test-"));
  const worktreePath = path.join(directory, "shared-worktree");
  const worktreeAlias = path.join(directory, "shared-worktree-alias");
  await mkdir(worktreePath, { recursive: true });
  await symlink(worktreePath, worktreeAlias);
  const probeCalls = [];
  const gitProbe = async (_executable, args) => {
    probeCalls.push([...args]);
    await new Promise((resolve) => setImmediate(resolve));
    if (args.includes("--show-toplevel")) return { stdout: `${worktreePath}\n` };
    if (args.includes("get-url")) return { stdout: "git@github.com:Owner/Repo.git\n" };
    if (args.includes("--show-current")) return { stdout: "codex/shared\n" };
    throw new Error("unexpected git probe");
  };
  const app = await createRepositoryRefreshTestServer({ directory, gitProbe });
  const tasks = Array.from({ length: 12 }, (_, index) => createRepositoryRefreshTask(
    app.database,
    {
      title: `shared-${index}`,
      worktreePath: index % 2 === 0 ? worktreePath : worktreeAlias,
      branch: "codex/shared",
    },
  ));

  await Promise.all(tasks.map((task) => app.refreshTaskWorktreeRepository(task.id)));
  assert.equal(probeCalls.length, 3);
  const refreshed = tasks.map((task) => app.database.getTask(task.id));
  assert.ok(refreshed.every((task) => task.developmentContext.repository === "github.com/owner/repo"));
  assert.ok(refreshed.every((task) => task.developmentContext.repositoryVerifiedAt));
  assert.equal(new Set(refreshed.map(
    (task) => task.developmentContext.repositoryVerifiedAt,
  )).size, 1);
  const capsules = tasks.map((task) => app.database.getTaskCapsule(task.id));
  assert.ok(capsules.every(
    (capsule) => capsule.executionTarget.repository === "github.com/owner/repo",
  ));
  assert.equal(new Set(capsules.map(
    (capsule) => capsule.executionTarget.repositoryVerifiedAt,
  )).size, 1);

  await Promise.all(tasks.map((task) => app.refreshTaskWorktreeRepository(task.id, { force: true })));
  assert.equal(probeCalls.length, 6);
  await app.refreshTaskWorktreeRepository(tasks[0].id, { force: true });
  assert.equal(probeCalls.length, 9);
});

test("worktree repository refresh isolates identity and retries a shared failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-refresh-test-"));
  const worktreeA = path.join(directory, "worktree-a");
  const worktreeB = path.join(directory, "worktree-b");
  const worktreeFailure = path.join(directory, "worktree-failure");
  await Promise.all([worktreeA, worktreeB, worktreeFailure].map(
    (worktreePath) => mkdir(worktreePath, { recursive: true }),
  ));
  let failSharedWorktree = true;
  const probeCalls = [];
  const gitProbe = async (_executable, args) => {
    const worktreePath = args[1];
    probeCalls.push([...args]);
    await new Promise((resolve) => setImmediate(resolve));
    if (path.basename(worktreePath) === "worktree-failure" && failSharedWorktree) {
      throw new Error("temporary git failure");
    }
    if (args.includes("--show-toplevel")) return { stdout: `${worktreePath}\n` };
    if (args.includes("get-url")) return { stdout: "https://github.com/Owner/Repo.git\n" };
    if (args.includes("--show-current")) return { stdout: "codex/branch-a\n" };
    throw new Error("unexpected git probe");
  };
  const app = await createRepositoryRefreshTestServer({ directory, gitProbe });
  const isolated = [
    createRepositoryRefreshTask(app.database, {
      title: "path-a-branch-a", worktreePath: worktreeA, branch: "codex/branch-a",
    }),
    createRepositoryRefreshTask(app.database, {
      title: "path-a-branch-b", worktreePath: worktreeA, branch: "codex/branch-b",
    }),
    createRepositoryRefreshTask(app.database, {
      title: "path-b-branch-a", worktreePath: worktreeB, branch: "codex/branch-a",
    }),
  ];
  await Promise.all(isolated.map((task) => app.refreshTaskWorktreeRepository(task.id)));
  assert.equal(probeCalls.length, 9);
  assert.equal(app.database.getTask(isolated[0].id).developmentContext.repository, "github.com/owner/repo");
  assert.equal(app.database.getTask(isolated[1].id).developmentContext.repository ?? null, null);
  assert.equal(app.database.getTask(isolated[2].id).developmentContext.repository, "github.com/owner/repo");

  const failureTasks = Array.from({ length: 8 }, (_, index) => createRepositoryRefreshTask(
    app.database,
    { title: `failure-${index}`, worktreePath: worktreeFailure, branch: "codex/branch-a" },
  ));
  await Promise.all(failureTasks.map((task) => app.refreshTaskWorktreeRepository(task.id)));
  assert.equal(probeCalls.length, 12);
  assert.ok(failureTasks.every(
    (task) => (app.database.getTask(task.id).developmentContext.repository ?? null) === null,
  ), JSON.stringify(failureTasks.map(
    (task) => app.database.getTask(task.id).developmentContext,
  )));

  failSharedWorktree = false;
  await Promise.all(failureTasks.map((task) => app.refreshTaskWorktreeRepository(task.id)));
  assert.equal(probeCalls.length, 15);
  assert.ok(failureTasks.every(
    (task) => app.database.getTask(task.id).developmentContext.repository === "github.com/owner/repo",
  ));
});

test("worktree repository refresh cannot write a stale branch verification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-refresh-test-"));
  const worktreePath = path.join(directory, "branch-drift-worktree");
  await mkdir(worktreePath, { recursive: true });
  let probedBranch = "codex/branch-a";
  let releaseFirstProbe;
  const firstProbeGate = new Promise((resolve) => { releaseFirstProbe = resolve; });
  let holdFirstProbe = true;
  const probeCalls = [];
  const gitProbe = async (_executable, args) => {
    probeCalls.push([...args]);
    if (holdFirstProbe) {
      await firstProbeGate;
    }
    if (args.includes("--show-toplevel")) return { stdout: `${worktreePath}\n` };
    if (args.includes("get-url")) return { stdout: "git@github.com:Owner/Repo.git\n" };
    if (args.includes("--show-current")) return { stdout: `${probedBranch}\n` };
    throw new Error("unexpected git probe");
  };
  const app = await createRepositoryRefreshTestServer({ directory, gitProbe });
  const task = createRepositoryRefreshTask(app.database, {
    title: "branch-drift", worktreePath, branch: "codex/branch-a",
  });
  const staleRefresh = app.refreshTaskWorktreeRepository(task.id, { force: true });
  while (probeCalls.length < 3) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  app.database.updateTask(
    task.id,
    task.version,
    { developmentContext: { type: "worktree", path: worktreePath, branch: "codex/branch-b" } },
    task.threadId,
    task.threadBinding,
    actor,
  );
  holdFirstProbe = false;
  releaseFirstProbe();
  await assert.rejects(staleRefresh, (error) => error?.code === "WORKTREE_CHANGED");
  const afterStaleProbe = app.database.getTask(task.id);
  assert.equal(afterStaleProbe.developmentContext.branch, "codex/branch-b");
  assert.equal(afterStaleProbe.developmentContext.repository ?? null, null);
  assert.equal(afterStaleProbe.developmentContext.repositoryVerifiedAt ?? null, null);

  probedBranch = "codex/branch-b";
  await app.refreshTaskWorktreeRepository(task.id, { force: true });
  const refreshed = app.database.getTask(task.id);
  assert.equal(probeCalls.length, 6);
  assert.equal(refreshed.developmentContext.branch, "codex/branch-b");
  assert.equal(refreshed.developmentContext.repository, "github.com/owner/repo");
  assert.ok(refreshed.developmentContext.repositoryVerifiedAt);
});

test("protected panel presence reports live and closed Taskboard pages", async () => {
  const instanceToken = "taskboard-panel-test-token";
  const baseUrl = await startServer(async () => ({
    instanceToken,
    instanceSecret: "a".repeat(64),
  }));
  const route = `/${instanceToken}/api/local/taskboard-panel-presence`;
  const panelId = "panel-12345678";

  const initial = await request(baseUrl, route);
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, { live: false });

  const touched = await request(baseUrl, route, {
    method: "PUT",
    body: { panelId },
  });
  assert.equal(touched.response.status, 204);
  assert.deepEqual((await request(baseUrl, route)).body, { live: true });

  const removed = await request(baseUrl, route, {
    method: "DELETE",
    body: { panelId },
  });
  assert.equal(removed.response.status, 204);
  assert.deepEqual((await request(baseUrl, route)).body, { live: false });
});

test("durable Agent Runs checkpoint, finish, and recover through the API", async () => {
  const baseUrl = await startServer();
  const rootBinding = {
    threadId: "root-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/durable-agent-run-worktree",
  };
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Durable run task",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/durable-agent-run",
      },
      workingLog: { path: "/tmp/durable-agent-run-worktree/CAP-3-WORKING-LOG.md", status: "active" },
    },
  });
  assert.equal(created.response.status, 201);
  const claimed = await request(baseUrl, `/api/tasks/${created.body.task.id}/claim`, {
    method: "POST",
    body: {
      version: created.body.task.version,
      agentPath: "/root/server-test",
      agentThreadId: "server-test-agent",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      writeScope: ["server/database.mjs"],
    },
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.run.status, "active");
  const activeCapsule = await request(baseUrl, `/api/tasks/${created.body.task.id}/capsule`);
  assert.equal(activeCapsule.body.capsule.activeRun.id, claimed.body.run.id);
  assert.equal(activeCapsule.body.capsule.latestRun.id, claimed.body.run.id);
  const wrongThread = await request(baseUrl, `/api/runs/${claimed.body.run.id}/checkpoint`, {
    method: "POST",
    body: {
      version: claimed.body.run.version,
      agentThreadId: "other-agent",
      summary: "Wrong thread",
      nextAction: "Do not persist",
      status: "active",
    },
  });
  assert.equal(wrongThread.response.status, 409);
  assert.equal(wrongThread.body.error.code, "RUN_THREAD_MISMATCH");
  const checkpointed = await request(baseUrl, `/api/runs/${claimed.body.run.id}/checkpoint`, {
    method: "POST",
    body: {
      version: claimed.body.run.version,
      agentThreadId: "server-test-agent",
      summary: "Checkpoint persisted",
      nextAction: "Resume from API",
      status: "blocked",
    },
  });
  assert.equal(checkpointed.response.status, 200);
  assert.equal(checkpointed.body.run.version, 2);
  const capsule = await request(baseUrl, `/api/tasks/${created.body.task.id}/capsule`);
  assert.equal(capsule.body.capsule.latestRun.nextAction, "Resume from API");
  const finished = await request(baseUrl, `/api/runs/${claimed.body.run.id}/finish`, {
    method: "POST",
    body: {
      version: checkpointed.body.run.version,
      agentThreadId: "server-test-agent",
      summary: "Finished",
      nextAction: "Review",
      status: "completed",
    },
  });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.body.task.status, "in_review");
  const repeated = await request(baseUrl, `/api/runs/${claimed.body.run.id}/finish`, {
    method: "POST",
    body: {
      version: checkpointed.body.run.version,
      agentThreadId: "server-test-agent",
      summary: "Finished",
      nextAction: "Review",
      status: "completed",
    },
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.applied, false);
});

test("structured handoff envelopes replay and acknowledge without changing execution", async () => {
  let dataDirectory;
  let baseUrl = await startServer(async (directory) => {
    dataDirectory = directory;
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
      ],
      adapters: [],
    });
    database.close();
    return {};
  });
  const rootBinding = {
    threadId: "root-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/handoff-envelope-worktree",
  };
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Durable handoff",
      description: "",
      status: "todo",
      priority: "high",
      labels: ["agent-todo"],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/handoff-envelope",
      },
    },
  });
  const claimed = await request(baseUrl, `/api/tasks/${created.body.task.id}/claim`, {
    method: "POST",
    body: {
      version: created.body.task.version,
      agentPath: "/root/backend",
      agentThreadId: "backend-thread",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      writeScope: ["server/database.mjs"],
    },
  });
  const envelope = {
    eventId: "handoff-event-1",
    idempotencyKey: "backend-to-root-1",
    parentTaskId: null,
    senderThreadId: "backend-thread",
    senderAgentPath: "/root/backend",
    eventType: "handoff",
    sequence: 1,
    timestamp: "2098-01-01T01:02:03.000Z",
    summary: "Backend contract is verified.",
    evidenceRefs: ["test/server.test.mjs#structured-handoff"],
    blocker: null,
    nextAction: "Root reviews the focused evidence.",
    requiresAck: true,
    causationId: "claim-backend-1",
    correlationId: "feature-handoff-1",
  };

  const first = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`, {
    method: "POST",
    body: envelope,
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.applied, true);
  assert.deepEqual(first.body.event.envelope, envelope);
  assert.equal(first.body.event.acknowledgements.length, 0);
  const pendingCapsule = await request(baseUrl, `/api/tasks/${created.body.task.id}/capsule`);
  assert.equal(pendingCapsule.body.capsule.handoffs.pendingAcknowledgementCount, 1);
  assert.deepEqual(pendingCapsule.body.capsule.handoffs.latestEvent, first.body.event);
  const pendingLanes = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  const pendingTodo = pendingLanes.body.todos.find((todo) => todo.id === created.body.task.identifier);
  assert.equal(pendingTodo.handoffs.pendingAcknowledgementCount, 1);
  assert.deepEqual(pendingTodo.handoffs.latestEvent, first.body.event);

  const duplicate = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`, {
    method: "POST",
    body: envelope,
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.applied, false);
  assert.deepEqual(duplicate.body.event, first.body.event);
  const conflictingDelivery = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`, {
    method: "POST",
    body: { ...envelope, eventId: "handoff-event-conflict", summary: "Conflicting content." },
  });
  assert.equal(conflictingDelivery.response.status, 409);
  assert.equal(conflictingDelivery.body.error.code, "COORDINATION_EVENT_CONFLICT");
  const sensitiveDelivery = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`, {
    method: "POST",
    body: {
      ...envelope,
      eventId: "handoff-event-sensitive",
      idempotencyKey: "backend-to-root-sensitive",
      sequence: 2,
      summary: "token=must-not-persist",
    },
  });
  assert.equal(sensitiveDelivery.response.status, 400);
  assert.equal(sensitiveDelivery.body.error.code, "SENSITIVE_COORDINATION_CONTENT");

  const replay = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`);
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body.events, [first.body.event]);

  const acknowledged = await request(baseUrl, `/api/coordination-events/${envelope.eventId}/acknowledgements`, {
    method: "POST",
    body: {
      acknowledgementId: "root-ack-1",
      senderThreadId: rootBinding.threadId,
      senderAgentPath: "/root",
    },
  });
  assert.equal(acknowledged.response.status, 201);
  assert.equal(acknowledged.body.applied, true);
  const acknowledgedCapsule = await request(baseUrl, `/api/tasks/${created.body.task.id}/capsule`);
  assert.equal(acknowledgedCapsule.body.capsule.handoffs.pendingAcknowledgementCount, 0);
  assert.deepEqual(
    acknowledgedCapsule.body.capsule.handoffs.latestEvent.acknowledgements,
    [acknowledged.body.acknowledgement],
  );
  const wrongRoot = await request(baseUrl, `/api/coordination-events/${envelope.eventId}/acknowledgements`, {
    method: "POST",
    body: {
      acknowledgementId: "wrong-root-ack",
      senderThreadId: "other-root-thread",
      senderAgentPath: "/root",
    },
  });
  assert.equal(wrongRoot.response.status, 409);
  assert.equal(wrongRoot.body.error.code, "COORDINATION_ACK_SENDER_MISMATCH");
  const repeatedAck = await request(baseUrl, `/api/coordination-events/${envelope.eventId}/acknowledgements`, {
    method: "POST",
    body: {
      acknowledgementId: "root-ack-1",
      senderThreadId: rootBinding.threadId,
      senderAgentPath: "/root",
    },
  });
  assert.equal(repeatedAck.response.status, 200);
  assert.equal(repeatedAck.body.applied, false);
  assert.deepEqual(repeatedAck.body.acknowledgement, acknowledged.body.acknowledgement);

  const recovered = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`);
  assert.deepEqual(recovered.body.events[0].acknowledgements, [acknowledged.body.acknowledgement]);
  const taskAfter = await request(baseUrl, `/api/tasks/${created.body.task.id}`);
  assert.equal(taskAfter.body.task.version, claimed.body.task.version);
  assert.equal(taskAfter.body.task.status, "in_progress");
  const runAfter = await request(baseUrl, `/api/runs/${claimed.body.run.id}`);
  assert.deepEqual(runAfter.body.run, claimed.body.run);
  const comments = await request(baseUrl, `/api/tasks/${created.body.task.id}/comments`);
  assert.equal(comments.body.comments.length, 1);
  assert.match(comments.body.comments[0].body, /^Agent Handoff\b/);
  assert.equal(comments.body.comments[0].authorType, "agent");
  assert.match(comments.body.comments[0].body, /Backend contract is verified\./);
  assert.match(comments.body.comments[0].body, /Root reviews the focused evidence\./);

  const running = runningApps.pop();
  await running.app.close();
  const restarted = createTaskboardServer({ dataDirectory });
  const restartedAddress = await restarted.listen({ port: 0 });
  runningApps.push({ app: restarted, directory: dataDirectory });
  baseUrl = `http://127.0.0.1:${restartedAddress.port}`;
  const replayAfterRestart = await request(baseUrl, `/api/tasks/${created.body.task.id}/coordination-events`);
  assert.deepEqual(replayAfterRestart.body.events[0].acknowledgements, [acknowledged.body.acknowledgement]);
});

test("bootstrap safe-action reservation atomically validates the Capsule frontier", async () => {
  let taskId;
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const rootBinding = {
      threadId: "root-thread",
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/bootstrap-safe-action-worktree",
    };
    const task = database.createTask({
      projectId: "local",
      title: "Reserve exact safe action",
      description: "",
      status: "todo",
      priority: "high",
      labels: ["agent-todo"],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: { type: "worktree", path: rootBinding.workspacePath, branch: "codex/bootstrap-safe-action" },
      workingLog: { path: `${rootBinding.workspacePath}/WORKING-LOG.md`, status: "active" },
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    database.createComment(task.id, {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        gates: [{
          id: "local", kind: "test", state: "authorized", scope: "local tests",
          approver: "Owner", approvalRequest: "同意执行本地测试",
          evidence: "Owner resumed", receipt: "turn:resume",
        }],
        actions: [{ id: "test", order: 10, text: "Run local acceptance", gate: "local", target: "candidate", status: "pending" }],
      })}\n\`\`\``,
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
    });
    taskId = task.id;
    database.close();
    return {};
  });

  const bootstrap = await request(baseUrl, `/api/tasks/${taskId}/capsule`);
  const capsule = bootstrap.body.capsule;
  const reservation = await request(baseUrl, `/api/tasks/${taskId}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: "root-thread",
      expectedResumeToken: capsule.resumeToken,
      safeActionId: capsule.readyWork.safeActions[0].id,
      reservationLeaseId: "bootstrap-lease",
    },
  });
  assert.equal(reservation.response.status, 200);
  assert.equal(reservation.body.reused, false);
  assert.equal(reservation.body.receipt.safeActionId, "test");
  assert.equal(reservation.body.receipt.resumeToken, capsule.resumeToken);

  const repeated = await request(baseUrl, `/api/tasks/${taskId}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: "root-thread",
      expectedResumeToken: capsule.resumeToken,
      safeActionId: "test",
      reservationLeaseId: "bootstrap-lease",
    },
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.reused, true);
  assert.equal(repeated.body.receipt.id, reservation.body.receipt.id);

  const wrongRoot = await request(baseUrl, `/api/tasks/${taskId}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: "other-root-thread",
      expectedResumeToken: capsule.resumeToken,
      safeActionId: "test",
      reservationLeaseId: "wrong-root-lease",
    },
  });
  assert.equal(wrongRoot.response.status, 409);
  assert.equal(wrongRoot.body.error.code, "ROOT_THREAD_MISMATCH");

  const stale = await request(baseUrl, `/api/tasks/${taskId}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: "root-thread",
      expectedResumeToken: "0".repeat(64),
      safeActionId: "test",
      reservationLeaseId: "stale-lease",
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "RESUME_TOKEN_MISMATCH");

  const unchanged = await request(baseUrl, `/api/tasks/${taskId}/capsule`);
  assert.equal(unchanged.body.capsule.task.status, "todo");
  assert.equal(unchanged.body.capsule.activeRun, null);
});

test("the default host is loopback-only", () => {
  assert.equal(resolveHost(undefined), "127.0.0.1");
  assert.equal(resolveHost("0.0.0.0"), "0.0.0.0");
});

test("Agent Lane admission is fenced from Root delivery through the exact durable child claim", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const instanceSecret = "6".repeat(64);
  let rootSessionPath;
  let task;
  const baseUrl = await startServer(async (directory) => {
    const sessionsDirectory = path.join(directory, "sessions", "2026", "08", "31");
    await mkdir(sessionsDirectory, { recursive: true });
    rootSessionPath = path.join(sessionsDirectory, `rollout-${rootThreadId}.jsonl`);
    await writeFile(rootSessionPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { session_id: rootThreadId },
    })}\n`);
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [{
        id: "root",
        label: "Taskboard Root",
        owner: "Codex Root",
        source: "codex",
        threadId: rootThreadId,
        taskType: "root_task",
      }],
      adapters: [],
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const rootBinding = {
      threadId: rootThreadId,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/background-continuation-worktree",
    };
    task = database.createTask({
      projectId: "local",
      title: "Deliver exact background continuation",
      description: "",
      status: "todo",
      priority: "high",
      labels: ["agent-todo"],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/background-continuation",
      },
      workingLog: { path: `${rootBinding.workspacePath}/WORKING-LOG.md`, status: "active" },
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    database.createComment(task.id, {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        gates: [{
          id: "local", kind: "test", state: "authorized", scope: "local continuation",
          approver: "Owner", approvalRequest: "同意本地自动衔接",
          evidence: "Owner resumed", receipt: "turn:resume",
        }],
        actions: [{
          id: "continue", order: 10, text: "Continue exact task", gate: "local",
          target: "candidate", status: "pending",
        }],
      })}\n\`\`\``,
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
    });
    database.close();
    return { instanceSecret, admissionTtlMs: 10, codexSessionsDirectory: path.join(directory, "sessions") };
  });

  const deliveries = [];
  let deliveryAttempts = 0;
  let firstReceipt;
  const options = {
    policy: { enabled: true, projectId: "local" },
    now: () => 0,
    readSnapshot: async () => (await request(baseUrl, "/api/local/projects/local/agent-lanes")).body,
    claimReceipt: async (claim) => {
      assert.equal(claim.todoId, task.identifier);
      assert.equal(claim.taskId, task.id);
      const reservation = await request(
        baseUrl,
        `/api/tasks/${encodeURIComponent(claim.todoId)}/bootstrap-claim`,
        {
          method: "POST",
          body: {
            rootThreadId: claim.rootThreadId,
            expectedResumeToken: claim.expectedResumeToken,
            safeActionId: claim.safeActionId,
            reservationLeaseId: "snapshot-reservation",
          },
        },
      );
      assert.equal(reservation.response.status, 200);
      assert.equal(reservation.body.receipt.taskId, claim.taskId);
      firstReceipt ??= reservation.body.receipt;
      return reservation.body;
    },
    confirmDelivery: async (delivery) => {
      const confirmation = await request(
        baseUrl,
        `/api/tasks/${encodeURIComponent(delivery.todoId)}/bootstrap-delivery`,
        {
          method: "POST",
          body: {
            rootThreadId: delivery.rootThreadId,
            expectedResumeToken: delivery.expectedResumeToken,
            safeActionId: delivery.safeActionId,
            reservationLeaseId: delivery.deliveryReceipt.reservationLeaseId,
          },
        },
      );
      assert.equal(confirmation.response.status, 200);
      return confirmation.body.executionIdentity;
    },
    deliver: async (delivery) => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error("injector stopped before first Root RPC");
      deliveries.push(delivery);
      return { delivery: "started", turnId: "turn-background" };
    },
    completeDelivery: async (delivery, rootDelivery) => (await request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(delivery.todoId)}/bootstrap-complete`,
      {
        method: "POST",
        body: {
          rootThreadId: delivery.rootThreadId,
          expectedResumeToken: delivery.expectedResumeToken,
          safeActionId: delivery.safeActionId,
          reservationLeaseId: delivery.deliveryReceipt.reservationLeaseId,
          recoveryLeaseId: delivery.recoveryLeaseId,
          deliveryTurnId: rootDelivery.turnId,
        },
      },
    )).body,
  };

  await assert.rejects(
    runTaskboardContinuationMonitorOnce(options),
    /injector stopped before first Root RPC/,
  );
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    reason: "awaiting-admission",
  });
  assert.equal(deliveryAttempts, 1, "awaiting admission must not blindly redeliver the Root turn");

  const bareClaimBody = {
    version: task.version,
    agentPath: "/root/unfenced-child",
    agentThreadId: "unfenced-child-thread",
    rootThreadId,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    writeScope: ["src"],
  };
  const bareClaim = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: bareClaimBody,
  });
  assert.equal(bareClaim.response.status, 409);
  assert.equal(bareClaim.body.error.code, "ADMISSION_BINDING_REQUIRED");
  const afterBareClaim = await request(baseUrl, `/api/tasks/${task.identifier}`);
  assert.equal(afterBareClaim.body.task.status, "todo");
  assert.equal(afterBareClaim.body.task.version, task.version);

  const firstPrepared = await request(baseUrl, `/api/tasks/${task.identifier}/admission-prepare`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
      writeScope: ["src"],
    },
  });
  assert.equal(firstPrepared.response.status, 200, JSON.stringify(firstPrepared.body));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const firstUncertain = await request(baseUrl, `/api/tasks/${task.identifier}/admission-uncertain`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "1".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
    },
  });
  assert.equal(firstUncertain.response.status, 200, JSON.stringify(firstUncertain.body));
  const firstProbe = await request(baseUrl, `/api/tasks/${task.identifier}/admission-probe`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "2".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
    },
  });
  assert.equal(firstProbe.response.status, 200, JSON.stringify(firstProbe.body));
  assert.match(firstProbe.body.receipt.admissionProbeId, /^[0-9a-f-]{36}$/);
  const preProbeObservation = await request(baseUrl, `/api/tasks/${task.identifier}/admission-reconcile`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "3".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
      admissionProbeId: firstProbe.body.receipt.admissionProbeId,
    },
  });
  assert.equal(preProbeObservation.response.status, 200, JSON.stringify(preProbeObservation.body));
  assert.equal(preProbeObservation.body.outcome, "unresolved");
  assert.equal(preProbeObservation.body.receipt.admissionState, "admission_uncertain");
  const absenceObservedAt = new Date(Date.now() + 10).toISOString();
  await appendFile(rootSessionPath, [
    JSON.stringify({
      timestamp: absenceObservedAt,
      type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "absence-list-agents", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: absenceObservedAt,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "absence-list-agents",
        output: JSON.stringify({ agents: [{ agent_name: "/root", agent_id: rootThreadId, agent_status: "running" }] }),
      },
    }),
  ].join("\n") + "\n");
  const absent = await request(baseUrl, `/api/tasks/${task.identifier}/admission-reconcile`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "4".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
      admissionProbeId: firstProbe.body.receipt.admissionProbeId,
    },
  });
  assert.equal(absent.response.status, 200, JSON.stringify(absent.body));
  assert.equal(absent.body.outcome, "absent");
  assert.equal(absent.body.receipt.admissionState, "deferred");

  const driftComment = await request(baseUrl, `/api/tasks/${task.identifier}/comments`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: { body: "Frontier changed after Root delivery", threadId: rootThreadId },
  });
  assert.equal(driftComment.response.status, 201);
  const driftedCapsule = await request(baseUrl, `/api/tasks/${task.identifier}/capsule`);
  assert.notEqual(driftedCapsule.body.capsule.resumeToken, firstReceipt.resumeToken);
  const driftedClaim = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...bareClaimBody,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
    },
  });
  assert.equal(driftedClaim.response.status, 409);
  assert.equal(driftedClaim.body.error.code, "ADMISSION_ATTEMPT_MISMATCH");
  const afterDriftedClaim = await request(baseUrl, `/api/tasks/${task.identifier}`);
  assert.equal(afterDriftedClaim.body.task.status, "todo");
  assert.equal(afterDriftedClaim.body.task.version, task.version);

  const deferred = await request(baseUrl, `/api/tasks/${task.identifier}/admission-defer`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
    },
  });
  assert.equal(deferred.response.status, 200);
  assert.equal(deferred.body.applied, false);
  const deferredReplay = await request(baseUrl, `/api/tasks/${task.identifier}/admission-defer`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: firstReceipt.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      admissionReceiptId: firstReceipt.id,
      admissionAttemptId: firstReceipt.admissionAttemptId,
    },
  });
  assert.equal(deferredReplay.response.status, 200);
  assert.equal(deferredReplay.body.applied, false);

  const nextReservation = await request(baseUrl, `/api/tasks/${task.identifier}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: driftedCapsule.body.capsule.resumeToken,
      safeActionId: firstReceipt.safeActionId,
      reservationLeaseId: "next-reservation",
    },
  });
  assert.equal(nextReservation.response.status, 200);
  assert.notEqual(nextReservation.body.receipt.admissionAttemptId, firstReceipt.admissionAttemptId);
  const nextReceipt = nextReservation.body.receipt;
  const nextConfirmation = await request(baseUrl, `/api/tasks/${task.identifier}/bootstrap-delivery`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      reservationLeaseId: nextReceipt.reservationLeaseId,
    },
  });
  assert.equal(nextConfirmation.response.status, 200);
  const prepared = await request(baseUrl, `/api/tasks/${task.identifier}/admission-prepare`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      admissionReceiptId: nextReceipt.id,
      admissionAttemptId: nextReceipt.admissionAttemptId,
      writeScope: ["src"],
    },
  });
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.applied, true);
  assert.match(prepared.body.receipt.admissionAgentName, /^[a-z0-9_]+$/);
  assert.equal(
    prepared.body.receipt.admissionAgentPath,
    `/root/${prepared.body.receipt.admissionAgentName}`,
  );
  assert.deepEqual(prepared.body.receipt.admissionWriteScope, ["src"]);
  const preparedReplay = await request(baseUrl, `/api/tasks/${task.identifier}/admission-prepare`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      admissionReceiptId: nextReceipt.id,
      admissionAttemptId: nextReceipt.admissionAttemptId,
      writeScope: ["src"],
    },
  });
  assert.equal(preparedReplay.response.status, 200);
  assert.equal(preparedReplay.body.applied, false);
  const claimBody = {
    version: task.version,
    agentPath: prepared.body.receipt.admissionAgentPath,
    agentThreadId: "admitted-child-thread",
    rootThreadId,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    writeScope: ["src"],
    admissionReceiptId: nextReceipt.id,
  };
  const staleClaim = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: { ...claimBody, admissionAttemptId: firstReceipt.admissionAttemptId },
  });
  assert.equal(staleClaim.response.status, 409);
  assert.equal(staleClaim.body.error.code, "ADMISSION_ATTEMPT_MISMATCH");
  const unchanged = await request(baseUrl, `/api/tasks/${task.identifier}`);
  assert.equal(unchanged.body.task.status, "todo");
  assert.equal(unchanged.body.task.version, task.version);

  const wrongPreparedPath = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...claimBody,
      agentPath: "/root/different-child",
      admissionAttemptId: nextReceipt.admissionAttemptId,
    },
  });
  assert.equal(wrongPreparedPath.response.status, 409);
  assert.equal(wrongPreparedPath.body.error.code, "ADMISSION_AGENT_MISMATCH");
  const wrongPreparedScope = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...claimBody,
      writeScope: ["test"],
      admissionAttemptId: nextReceipt.admissionAttemptId,
    },
  });
  assert.equal(wrongPreparedScope.response.status, 409);
  assert.equal(wrongPreparedScope.body.error.code, "ADMISSION_WRITE_SCOPE_MISMATCH");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const uncertain = await request(baseUrl, `/api/tasks/${task.identifier}/admission-uncertain`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "6".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      admissionReceiptId: nextReceipt.id,
      admissionAttemptId: nextReceipt.admissionAttemptId,
    },
  });
  assert.equal(uncertain.response.status, 200, JSON.stringify(uncertain.body));
  assert.equal(uncertain.body.receipt.admissionState, "admission_uncertain");
  const recoveryProbe = await request(baseUrl, `/api/tasks/${task.identifier}/admission-probe`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "7".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      admissionReceiptId: nextReceipt.id,
      admissionAttemptId: nextReceipt.admissionAttemptId,
    },
  });
  assert.equal(recoveryProbe.response.status, 200, JSON.stringify(recoveryProbe.body));
  const registryObservedAt = new Date(Date.now() + 10).toISOString();
  await appendFile(rootSessionPath, [
    JSON.stringify({
      timestamp: registryObservedAt,
      type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "recovery-list-agents", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: registryObservedAt,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "recovery-list-agents",
        output: JSON.stringify({ agents: [
          { agent_name: "/root", agent_id: rootThreadId, agent_status: "running" },
          { agent_name: prepared.body.receipt.admissionAgentPath, agent_id: "admitted-child-thread", agent_status: "running" },
        ] }),
      },
    }),
  ].join("\n") + "\n");
  const recoverySnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(recoverySnapshot.response.status, 200, JSON.stringify(recoverySnapshot.body));
  const recoveryTree = recoverySnapshot.body.windowSubagentTrees.find((candidate) => candidate.rootThreadId === rootThreadId);
  assert.equal(recoveryTree.registryObservation.agents[0].agentThreadId, "admitted-child-thread");
  const reconciled = await request(baseUrl, `/api/tasks/${task.identifier}/admission-reconcile`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "8".repeat(32)),
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      admissionReceiptId: nextReceipt.id,
      admissionAttemptId: nextReceipt.admissionAttemptId,
      admissionProbeId: recoveryProbe.body.receipt.admissionProbeId,
    },
  });
  assert.equal(reconciled.response.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.outcome, "present", JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.receipt.admissionState, "recovery_confirmed");
  assert.equal(reconciled.body.receipt.admissionRecoveredAgentThreadId, "admitted-child-thread");

  const admitted = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: { ...claimBody, admissionAttemptId: nextReceipt.admissionAttemptId },
  });
  assert.equal(admitted.response.status, 200, JSON.stringify(admitted.body));
  assert.equal(admitted.body.task.status, "in_progress");
  assert.equal(admitted.body.claim.agentThreadId, "admitted-child-thread");
  assert.equal(admitted.body.run.status, "active");
  const widenedReplay = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...claimBody,
      version: admitted.body.task.version,
      writeScope: ["test"],
      admissionAttemptId: nextReceipt.admissionAttemptId,
    },
  });
  assert.equal(widenedReplay.response.status, 409);
  assert.equal(widenedReplay.body.error.code, "ADMISSION_WRITE_SCOPE_MISMATCH");
  const widenedRenewalWithoutAdmissionBinding = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...bareClaimBody,
      version: admitted.body.task.version,
      agentPath: prepared.body.receipt.admissionAgentPath,
      agentThreadId: "admitted-child-thread",
      writeScope: ["test"],
    },
  });
  assert.equal(widenedRenewalWithoutAdmissionBinding.response.status, 409);
  assert.equal(
    widenedRenewalWithoutAdmissionBinding.body.error.code,
    "ADMISSION_WRITE_SCOPE_MISMATCH",
  );
  const snapshotAfterRejectedRenewal = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshotAfterRejectedRenewal.response.status, 200);
  const admittedTodo = snapshotAfterRejectedRenewal.body.todos.find(
    (candidate) => candidate.taskId === task.id,
  );
  assert.deepEqual(admittedTodo.writeScope, ["src"]);
  const exactRenewalWithoutAdmissionBinding = await request(baseUrl, `/api/tasks/${task.identifier}/claim`, {
    method: "POST",
    body: {
      ...bareClaimBody,
      version: admitted.body.task.version,
      agentPath: prepared.body.receipt.admissionAgentPath,
      agentThreadId: "admitted-child-thread",
      writeScope: ["src"],
    },
  });
  assert.equal(exactRenewalWithoutAdmissionBinding.response.status, 200);
  assert.deepEqual(exactRenewalWithoutAdmissionBinding.body.claim.writeScope, ["src"]);
  assert.deepEqual(exactRenewalWithoutAdmissionBinding.body.run.writeScope, ["src"]);
  const completionAfterFastClaim = await request(baseUrl, `/api/tasks/${task.identifier}/bootstrap-complete`, {
    method: "POST",
    body: {
      rootThreadId,
      expectedResumeToken: nextReceipt.resumeToken,
      safeActionId: nextReceipt.safeActionId,
      reservationLeaseId: nextReceipt.reservationLeaseId,
      recoveryLeaseId: nextReceipt.reservationLeaseId,
      deliveryTurnId: "next-root-turn",
    },
  });
  assert.equal(completionAfterFastClaim.response.status, 200);
  assert.equal(completionAfterFastClaim.body.completed, true);
  assert.equal(completionAfterFastClaim.body.receipt.admissionState, "admitted");
  assert.equal(completionAfterFastClaim.body.receipt.admittedRunId, admitted.body.run.id);
  assert.equal(deliveries.length, 0);
});

test("project Agent Lanes read durable database configuration through a local route", async () => {
  const baseUrl = await startServer(async (directory) => {
    const sessionsDirectory = path.join(directory, "sessions", "2026", "08", "23");
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(
      path.join(sessionsDirectory, "rollout-root-thread.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-23T08:02:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "Root milestone complete." },
      })}\n`,
    );
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
        { id: "visual", label: "Visual", owner: "Codex Visual", source: "codex", threadId: "root-thread", taskType: "peer_task" },
        { id: "taskboard", label: "Taskboard", owner: "Codex Taskboard", source: "codex", threadId: "root-thread", taskType: "infrastructure_task" },
      ],
      adapters: [
        { id: "claude", label: "Claude", owner: "Claude", source: "claude", connection: "not_connected" },
        { id: "pi", label: "Pi", owner: "Pi", source: "pi", connection: "not_connected" },
      ],
    });
    const rootBinding = {
      threadId: "root-thread",
      codexProjectId: "local",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/local-agent-worktree",
    };
    database.createTask({
      projectId: "local",
      title: "Capsule-dispatchable lane task",
      description: "",
      status: "todo",
      priority: "medium",
      labels: [],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
      assignee: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/local-agent-lane",
      },
      workingLog: {
        path: `${rootBinding.workspacePath}/CAP-LOCAL-WORKING-LOG.md`,
        status: "planned",
      },
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    database.close();
    return { codexSessionsDirectory: path.join(directory, "sessions") };
  });

  const result = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.readOnly, true);
  assert.equal(result.body.automaticRecoveryEnabled, false);
  assert.equal(result.body.version, 7);
  assert.equal(result.body.taskLanes.length, 3);
  assert.equal(result.body.rootSubagents.length, 0);
  assert.equal(result.body.adapters.length, 2);
  const capsuleTodo = result.body.todos.find((todo) => todo.title === "Capsule-dispatchable lane task");
  assert.equal(capsuleTodo.readyWork.eligible, true);
  assert.deepEqual(capsuleTodo.dispatchTarget, {
    rootThreadId: "root-thread",
    codexHostId: "local",
    rootWorkspacePath: "/tmp/local-agent-worktree",
    worktreePath: "/tmp/local-agent-worktree",
  });
  assert.equal(capsuleTodo.workingLog.status, "planned");
  assert.equal(capsuleTodo.run, null);

  const projects = await request(baseUrl, "/api/local/agent-lane-projects");
  assert.equal(projects.response.status, 200);
  assert.deepEqual(projects.body, { projectIds: ["local"] });

  const mutation = await request(baseUrl, "/api/local/projects/local/agent-lanes", {
    method: "POST",
    body: {},
  });
  assert.equal(mutation.response.status, 405);
});

test("Root records one immutable Owner decision receipt from the project-level request", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const coordinatorThreadId = "01a004bd-a749-7b53-81e2-af2d477f93af";
  const instanceSecret = "b".repeat(64);
  let task;
  let dataDirectory;
  let baseUrl = await startServer(async (directory) => {
    dataDirectory = directory;
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root", label: "Owner Root", owner: "Codex Root", source: "codex",
        threadId: rootThreadId, taskType: "root_task", codexHostId: "local",
        workspacePath: "/tmp/root-owner-decision",
      }, {
        id: "coordinator", label: "Coordinator", owner: "Codex Root", source: "codex",
        threadId: coordinatorThreadId, taskType: "root_task", codexHostId: "local",
        workspacePath: "/tmp/coordinator-owner-decision",
      }],
      adapters: [],
      coordinatorLease: {
        id: "owner-decision-lease",
        holderTaskId: "coordinator",
        holderThreadId: coordinatorThreadId,
        holderCodexHostId: "local",
        holderWorkspacePath: "/tmp/coordinator-owner-decision",
        acquiredAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
      },
    });
    const binding = {
      threadId: rootThreadId,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/root-owner-decision",
    };
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    task = database.createTask({
      projectId: "local", title: "Ask exactly one Owner question", description: "", status: "todo",
      priority: "urgent", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: rootThreadId, threadBinding: binding, actor, assignee: actor,
      developmentContext: { type: "worktree", path: binding.workspacePath, branch: "codex/decision" },
      workingLog: null, startDate: null, dueDate: null, recurrence: null,
    });
    database.createComment(task.id, {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        gates: [{
          id: "push", kind: "push", state: "approval_required", scope: "exact commit",
          approver: "Owner", approvalRequest: "同意 ordinary push exact commit",
        }],
        actions: [{
          id: "push", order: 10, text: "Push exact commit", gate: "push",
          target: "origin", status: "pending",
        }],
      })}\n\`\`\``,
      threadId: rootThreadId,
      threadBinding: binding,
      actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
    });
    database.close();
    return { instanceSecret };
  });

  const lanes = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(lanes.response.status, 200);
  const pending = lanes.body.coordination.ownerDecisionRequest;
  assert.equal(pending.identifier, task.identifier);
  assert.equal(pending.route.rootThreadId, rootThreadId);
  assert.equal(pending.coordinatorEpoch, "lease:owner-decision-lease");
  assert.equal(lanes.body.todos.filter((todo) => todo.readyWork.approvalRequest).length, 1);

  const decisionBody = {
    requestId: pending.requestId,
    expectedResumeToken: pending.expectedResumeToken,
    outcome: "authorized",
    ownerTurnId: "owner-turn-1",
    rootDecisionTurnId: "root-decision-turn-1",
    rootThreadId,
    evidence: "Owner approved in the confirmed Root window",
    receipt: "owner-turn:decision-1",
    decidedAt: new Date().toISOString(),
  };
  const forged = await request(baseUrl, `/api/tasks/${task.identifier}/owner-decisions`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      ...decisionBody,
      deliveryId: "forged-delivery",
    },
  });
  assert.equal(forged.response.status, 403);
  assert.equal(forged.body.error.code, "INJECTOR_PROOF_REQUIRED");

  const injectorHeaders = (nonce) => ({
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-proof": createHmac("sha256", instanceSecret).update(nonce).digest("hex"),
  });
  const unsignedDelivery = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/claim", {
    method: "POST",
    body: pending,
  });
  assert.equal(unsignedDelivery.response.status, 403);
  for (const [nonce, route] of [
    ["a".repeat(32), { ...pending.route, codexHostId: "wrong-host" }],
    ["9".repeat(32), { ...pending.route, rootWorkspacePath: "/tmp/wrong-owner-decision" }],
  ]) {
    const mismatchedDelivery = await request(
      baseUrl,
      "/api/local/projects/local/owner-decision-delivery/claim",
      {
        method: "POST",
        headers: injectorHeaders(nonce),
        body: { ...pending, route },
      },
    );
    assert.equal(mismatchedDelivery.response.status, 409);
    assert.equal(mismatchedDelivery.body.error.code, "OWNER_DECISION_ROUTE_STALE");
  }
  const emptyDeliveryDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
  assert.equal(emptyDeliveryDatabase.prepare(
    "SELECT COUNT(*) AS count FROM owner_decision_deliveries",
  ).get().count, 0);
  emptyDeliveryDatabase.close();
  const routeEpochDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  const exactRouteConfig = routeEpochDatabase.getAgentLaneProject("local");
  const invalidCoordinatorLeases = [
    {
      ...exactRouteConfig.coordinatorLease,
      id: "stale-owner-decision-epoch",
    },
    {
      ...exactRouteConfig.coordinatorLease,
      holderThreadId: "drifted-coordinator-thread",
    },
    {
      ...exactRouteConfig.coordinatorLease,
      releasedAt: new Date().toISOString(),
    },
    {
      ...exactRouteConfig.coordinatorLease,
      acquiredAt: new Date(Date.now() + 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  ];
  routeEpochDatabase.close();
  for (const [index, coordinatorLease] of invalidCoordinatorLeases.entries()) {
    const mutationDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
    mutationDatabase.upsertAgentLaneProject("local", { ...exactRouteConfig, coordinatorLease });
    mutationDatabase.close();
    const staleEpochDelivery = await request(
      baseUrl,
      "/api/local/projects/local/owner-decision-delivery/claim",
      {
        method: "POST",
        headers: injectorHeaders(String(index + 4).repeat(32)),
        body: pending,
      },
    );
    assert.equal(staleEpochDelivery.response.status, 409);
    const unchangedDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
    assert.equal(unchangedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM owner_decision_deliveries",
    ).get().count, 0);
    unchangedDatabase.close();
    const restoreDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
    restoreDatabase.upsertAgentLaneProject("local", exactRouteConfig);
    restoreDatabase.close();
  }
  const delivery = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/claim", {
    method: "POST",
    headers: injectorHeaders("c".repeat(32)),
    body: pending,
  });
  assert.equal(delivery.response.status, 201, JSON.stringify(delivery.body));
  assert.equal(delivery.body.claimed, true);
  assert.equal("attestationToken" in delivery.body.receipt, false);
  const fixtureDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
  const protectedConfig = JSON.parse(fixtureDatabase.prepare(`
    SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'
  `).get().config_json);
  assert.ok(Date.parse(protectedConfig.coordinatorLease.expiresAt)
    > Date.parse(delivery.body.receipt.reservationExpiresAt));
  fixtureDatabase.prepare(`
    UPDATE owner_decision_deliveries SET reservation_expires_at = ? WHERE id = ?
  `).run("2000-01-01T00:00:00.000Z", delivery.body.receipt.id);
  fixtureDatabase.close();
  const retriedDelivery = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/claim", {
    method: "POST",
    headers: injectorHeaders("d".repeat(32)),
    body: pending,
  });
  assert.equal(retriedDelivery.response.status, 201);
  assert.equal(retriedDelivery.body.receipt.id, delivery.body.receipt.id);
  assert.equal("attestationToken" in retriedDelivery.body.receipt, false);
  const routeMutationDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  assert.throws(() => routeMutationDatabase.upsertAgentLaneProject("local", {
    rootTaskId: "replacement",
    tasks: [{
      id: "replacement", label: "Replacement Root", owner: "Codex Root", source: "codex",
      threadId: "replacement-thread", taskType: "root_task",
    }],
    adapters: [],
  }), (error) => error?.code === "OWNER_DECISION_DELIVERY_ACTIVE");
  routeMutationDatabase.close();
  const confirmed = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/confirm", {
    method: "POST",
    headers: injectorHeaders("e".repeat(32)),
    body: {
      deliveryId: retriedDelivery.body.receipt.id,
      deliveryTurnId: "root-delivery-turn-1",
    },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.confirmed, true);

  const renewedDuringDecision = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "coordinator",
      holderThreadId: coordinatorThreadId,
      expectedLeaseId: "owner-decision-lease",
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(renewedDuringDecision.response.status, 200);
  const decisionLeaseReceipts = await request(
    baseUrl,
    "/api/local/projects/local/coordinator-lease/receipts",
  );
  const decisionRenewalReceipt = decisionLeaseReceipts.body.receipts.findLast((receipt) => (
    receipt.leaseId === "owner-decision-lease" && receipt.action === "renewed"
  ));
  assert.equal(decisionRenewalReceipt.holderTaskId, "coordinator");
  assert.equal(decisionRenewalReceipt.holderThreadId, coordinatorThreadId);

  const delayedDecisionDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
  const delayedDelivery = delayedDecisionDatabase.prepare(`
    SELECT decision_expires_at FROM owner_decision_deliveries WHERE id = ?
  `).get(retriedDelivery.body.receipt.id);
  const delayedConfig = JSON.parse(delayedDecisionDatabase.prepare(`
    SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'
  `).get().config_json);
  assert.ok(Date.parse(delayedDelivery.decision_expires_at) > Date.now() + 23 * 60 * 60 * 1_000);
  assert.ok(Date.parse(delayedConfig.coordinatorLease.expiresAt)
    > Date.parse(delayedDelivery.decision_expires_at));
  assert.equal(
    renewedDuringDecision.body.lease.expiresAt,
    delayedConfig.coordinatorLease.expiresAt,
  );
  delayedDecisionDatabase.prepare(`
    UPDATE owner_decision_deliveries
    SET delivered_at = ?, decision_expires_at = NULL
    WHERE id = ?
  `).run(new Date(Date.now() - 2 * 60 * 1_000).toISOString(), retriedDelivery.body.receipt.id);
  delayedDecisionDatabase.close();
  const delayedRouteMutationDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  assert.throws(() => delayedRouteMutationDatabase.upsertAgentLaneProject("local", {
    rootTaskId: "replacement",
    tasks: [{
      id: "replacement", label: "Replacement Root", owner: "Codex Root", source: "codex",
      threadId: "replacement-thread", taskType: "root_task",
    }],
    adapters: [],
  }), (error) => error?.code === "OWNER_DECISION_DELIVERY_ACTIVE");
  delayedRouteMutationDatabase.close();

  const firstServer = runningApps.pop();
  await firstServer.app.close();
  const restartedApp = createTaskboardServer({ dataDirectory: firstServer.directory, instanceSecret });
  const restartedAddress = await restartedApp.listen({ port: 0 });
  runningApps.push({ app: restartedApp, directory: firstServer.directory });
  baseUrl = `http://127.0.0.1:${restartedAddress.port}`;
  const durableReplay = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/claim", {
    method: "POST",
    headers: injectorHeaders("f".repeat(32)),
    body: pending,
  });
  assert.equal(durableReplay.response.status, 200);
  assert.deepEqual(durableReplay.body, {
    claimed: false,
    reason: "already-delivered",
    receipt: { id: retriedDelivery.body.receipt.id, deliveryTurnId: "root-delivery-turn-1" },
  });
  const backfilledDecisionDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
  const backfilledDecision = backfilledDecisionDatabase.prepare(`
    SELECT decision_expires_at FROM owner_decision_deliveries WHERE id = ?
  `).get(retriedDelivery.body.receipt.id);
  assert.ok(Date.parse(backfilledDecision.decision_expires_at) > Date.now() + 23 * 60 * 60 * 1_000);
  backfilledDecisionDatabase.close();
  const durableReplayAgain = await request(baseUrl, "/api/local/projects/local/owner-decision-delivery/claim", {
    method: "POST",
    headers: injectorHeaders("0".repeat(32)),
    body: pending,
  });
  assert.equal(durableReplayAgain.response.status, 200);
  const stableBackfillDatabase = new DatabaseSync(path.join(dataDirectory, "taskboard.sqlite"));
  assert.equal(stableBackfillDatabase.prepare(`
    SELECT decision_expires_at FROM owner_decision_deliveries WHERE id = ?
  `).get(retriedDelivery.body.receipt.id).decision_expires_at, backfilledDecision.decision_expires_at);
  stableBackfillDatabase.close();

  const recorded = await request(baseUrl, `/api/tasks/${task.identifier}/owner-decisions`, {
    method: "POST",
    headers: injectorHeaders("1".repeat(32)),
    body: {
      ...decisionBody,
      deliveryId: retriedDelivery.body.receipt.id,
    },
  });
  assert.equal(recorded.response.status, 201);
  assert.equal(recorded.body.applied, true);
  assert.equal(recorded.body.receipt.recordedBy.type, "agent");
  assert.deepEqual(recorded.body.capsule.readyWork.safeActions.map((action) => action.id), ["push"]);
  assert.equal(recorded.body.capsule.readyWork.ownerDecisionRequest, null);

  const releasedRouteDatabase = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  assert.doesNotThrow(() => releasedRouteDatabase.upsertAgentLaneProject("local", {
    rootTaskId: "replacement",
    tasks: [{
      id: "replacement", label: "Replacement Root", owner: "Codex Root", source: "codex",
      threadId: "replacement-thread", taskType: "root_task",
    }],
    adapters: [],
  }));
  releasedRouteDatabase.close();

  const replay = await request(baseUrl, `/api/tasks/${task.identifier}/owner-decisions`, {
    method: "POST",
    headers: injectorHeaders("2".repeat(32)),
    body: {
      ...decisionBody,
      deliveryId: retriedDelivery.body.receipt.id,
    },
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.applied, false);

  const conflict = await request(baseUrl, `/api/tasks/${task.identifier}/owner-decisions`, {
    method: "POST",
    headers: injectorHeaders("3".repeat(32)),
    body: {
      ...decisionBody,
      deliveryId: retriedDelivery.body.receipt.id,
      outcome: "denied",
    },
  });
  assert.equal(conflict.response.status, 409);
  const after = await request(baseUrl, `/api/tasks/${task.identifier}/capsule`);
  assert.deepEqual(after.body.capsule.readyWork.safeActions.map((action) => action.id), ["push"]);
});

test("project coordinator leases acquire and renew atomically without granting execution ownership", async () => {
  const instanceSecret = "4".repeat(64);
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/inbox-delivery-worktree" },
        { id: "visual", label: "Visual", owner: "Codex Visual", source: "codex", threadId: "visual-thread", taskType: "peer_task", codexHostId: "host-visual", workspacePath: "/tmp/taskboard/visual" },
      ],
      adapters: [],
    });
    database.close();
    return { instanceSecret };
  });

  const acquired = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: null,
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(acquired.response.status, 200);
  assert.equal(acquired.body.lease.holderTaskId, "visual");
  assert.equal(acquired.body.lease.status, "active");
  assert.match(acquired.body.lease.id, /^[0-9a-f-]{36}$/);
  assert.equal(acquired.body.receipt.action, "acquired");
  assert.equal(acquired.body.receipt.leaseId, acquired.body.lease.id);
  assert.equal(acquired.body.receipt.holderThreadId, "visual-thread");

  const wrongBinding = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "root-thread",
      expectedLeaseId: acquired.body.lease.id,
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(wrongBinding.response.status, 409);
  assert.equal(wrongBinding.body.error.code, "COORDINATOR_BINDING_MISMATCH");

  const invalidDuration = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: acquired.body.lease.id,
      leaseDurationSeconds: 10,
    },
  });
  assert.equal(invalidDuration.response.status, 400);
  assert.equal(invalidDuration.body.error.code, "INVALID_FIELD");

  const competing = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "root",
      holderThreadId: "root-thread",
      expectedLeaseId: acquired.body.lease.id,
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(competing.response.status, 409);
  assert.equal(competing.body.error.code, "COORDINATOR_LEASE_ACTIVE");

  const renewPath = "/api/local/projects/local/coordinator-lease/renew";
  const renewBody = {
    holderTaskId: "visual",
    holderThreadId: "visual-thread",
    holderCodexHostId: "host-visual",
    holderWorkspacePath: "/tmp/taskboard/visual",
    expectedLeaseId: acquired.body.lease.id,
    leaseDurationSeconds: 120,
  };
  const renewHeaders = signedCoordinatorRenewHeaders(instanceSecret, "5".repeat(32), renewPath, renewBody);
  const renewed = await request(baseUrl, renewPath, {
    method: "POST",
    headers: renewHeaders,
    body: renewBody,
  });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.body.lease.id, acquired.body.lease.id);
  assert.equal(renewed.body.lease.acquiredAt, acquired.body.lease.acquiredAt);
  assert.ok(renewed.body.lease.expiresAt > acquired.body.lease.expiresAt);
  assert.equal(renewed.body.receipt.action, "renewed");

  const replayedRenewal = await request(baseUrl, renewPath, {
    method: "POST", headers: renewHeaders, body: renewBody,
  });
  assert.equal(replayedRenewal.response.status, 403);

  const substitutedBody = { ...renewBody, leaseDurationSeconds: 3600 };
  const substitutedRenewal = await request(baseUrl, renewPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "7".repeat(32), renewPath, renewBody),
    body: substitutedBody,
  });
  assert.equal(substitutedRenewal.response.status, 403);

  const mismatchedRouteBody = { ...renewBody, holderWorkspacePath: "/tmp/taskboard/drifted" };
  const mismatchedRoute = await request(baseUrl, renewPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "8".repeat(32), renewPath, mismatchedRouteBody),
    body: mismatchedRouteBody,
  });
  assert.equal(mismatchedRoute.response.status, 409);
  assert.equal(mismatchedRoute.body.error.code, "COORDINATOR_BINDING_MISMATCH");

  const rebindingDatabase = new TaskboardDatabase(databasePath);
  const driftedConfig = {
    rootTaskId: "root",
    coordinatorLease: { ...renewed.body.lease, status: undefined },
    tasks: [
      { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
      { id: "visual", label: "Visual", owner: "Codex Visual", source: "codex", threadId: "drifted-thread", taskType: "peer_task", codexHostId: "host-drifted", workspacePath: "/tmp/taskboard/drifted" },
    ],
    adapters: [],
  };
  assert.doesNotThrow(() => rebindingDatabase.upsertAgentLaneProject("local", driftedConfig));
  rebindingDatabase.close();
  const driftedRenewal = await request(baseUrl, renewPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "9".repeat(32), renewPath, renewBody),
    body: renewBody,
  });
  assert.equal(driftedRenewal.response.status, 409);
  assert.equal(driftedRenewal.body.error.code, "COORDINATOR_BINDING_MISMATCH");
  const restoredDatabase = new TaskboardDatabase(databasePath);
  restoredDatabase.upsertAgentLaneProject("local", {
    rootTaskId: "root",
    coordinatorLease: { ...renewed.body.lease, status: undefined },
    tasks: [
      { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
      { id: "visual", label: "Visual", owner: "Codex Visual", source: "codex", threadId: "visual-thread", taskType: "peer_task", codexHostId: "host-visual", workspacePath: "/tmp/taskboard/visual" },
    ],
    adapters: [],
  });
  restoredDatabase.close();

  const stale = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: "00000000-0000-0000-0000-000000000000",
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "COORDINATOR_LEASE_CONFLICT");

  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.coordination.assignment, "lease");
  assert.equal(snapshot.body.coordination.coordinatorTaskId, "visual");
  assert.equal(snapshot.body.coordination.workAuthority, "todo_claim_lease");

  const released = await request(baseUrl, "/api/local/projects/local/coordinator-lease/release", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: renewed.body.lease.id,
    },
  });
  assert.equal(released.response.status, 200);
  assert.equal(released.body.lease.status, "expired");
  assert.equal(released.body.receipt.action, "released");

  const expiredRenewBody = { ...renewBody, expectedLeaseId: renewed.body.lease.id };
  const expiredRenewal = await request(baseUrl, renewPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "6".repeat(32), renewPath, expiredRenewBody),
    body: expiredRenewBody,
  });
  assert.equal(expiredRenewal.response.status, 409);
  assert.equal(expiredRenewal.body.error.code, "COORDINATOR_LEASE_NOT_ACTIVE");

  const afterRelease = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(afterRelease.response.status, 200);
  assert.equal(afterRelease.body.coordination.assignment, "unassigned");
  assert.equal(afterRelease.body.coordination.coordinatorTaskId, null);

  const staleRelease = await request(baseUrl, "/api/local/projects/local/coordinator-lease/release", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: renewed.body.lease.id,
    },
  });
  assert.equal(staleRelease.response.status, 409);
  assert.equal(staleRelease.body.error.code, "COORDINATOR_LEASE_NOT_ACTIVE");

  const receipts = await request(baseUrl, "/api/local/projects/local/coordinator-lease/receipts");
  assert.equal(receipts.response.status, 200);
  assert.deepEqual(
    receipts.body.receipts.map((receipt) => receipt.action),
    ["released", "renewed", "acquired"],
  );
});

test("Global lease acquisition rejects an incompletely bound explicit Owner Root without mutation", async () => {
  let databasePath;
  let configBefore;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator",
      ownerRootTaskId: "owner",
      tasks: [
        {
          id: "owner", label: "Owner", owner: "Codex Owner Root", source: "codex",
          threadId: "owner-thread", taskType: "root_task",
          codexHostId: "host-owner", workspacePath: "/tmp/owner",
        },
        {
          id: "coordinator", label: "Coordinator", owner: "Codex Coordinator", source: "codex",
          threadId: "coordinator-thread", taskType: "root_task",
          codexHostId: "host-coordinator", workspacePath: "/tmp/coordinator",
        },
      ],
      adapters: [],
    });
    database.close();
    return {};
  });
  const corrupted = new TaskboardDatabase(databasePath);
  const validConfig = corrupted.getAgentLaneProject("local");
  corrupted.upsertAgentLaneProject("local", {
    ...validConfig,
    tasks: validConfig.tasks.map((task) => task.id === "owner"
      ? { ...task, codexHostId: null }
      : task),
  });
  configBefore = corrupted.getAgentLaneProject("local");
  corrupted.close();

  const rejected = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "coordinator", holderThreadId: "coordinator-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });

  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "OWNER_ROOT_BINDING_MISMATCH");
  const database = new TaskboardDatabase(databasePath);
  assert.deepEqual(database.getAgentLaneProject("local"), configBefore);
  assert.deepEqual(database.listAgentLaneCoordinatorReceipts("local"), []);
  database.close();
});

test("Global coordinator lease rejects the configured Owner Root", async () => {
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator", ownerRootTaskId: "owner",
      tasks: [
        { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
        { id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex", threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/coordinator" },
      ],
      adapters: [],
    });
    database.close();
    return {};
  });
  const rejected = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "owner", holderThreadId: "owner-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "OWNER_ROOT_COORDINATOR_CONFLICT");
  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.body.coordination.ownerRootTaskId, "owner");
  assert.equal(snapshot.body.coordination.coordinatorTaskId, "coordinator");
});

test("Owner Root registration rejects an active legacy non-Root Global lease", async () => {
  const instanceSecret = "4".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "legacy-peer",
      coordinatorLease: {
        id: "legacy-peer-lease",
        holderTaskId: "legacy-peer",
        holderThreadId: "legacy-peer-thread",
        holderCodexHostId: "host-legacy-peer",
        holderWorkspacePath: "/tmp/legacy-peer",
        acquiredAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      tasks: [
        {
          id: "legacy-peer", label: "Legacy peer", owner: "Codex", source: "codex",
          threadId: "legacy-peer-thread", taskType: "peer_task",
          codexHostId: "host-legacy-peer", workspacePath: "/tmp/legacy-peer",
        },
      ],
      adapters: [],
    });
    database.close();
    return { instanceSecret };
  });
  const current = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(current.response.status, 200, JSON.stringify(current.body));
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "4".repeat(32)),
    body: {
      threadId: "owner-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "host-owner", workspacePath: "/tmp/owner-root",
    },
  });

  const rejected = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "owner_root", taskId: "owner-root", label: "Owner Root",
      threadId: "owner-thread", expectedRevision: current.body.revision,
      idempotencyKey: "reject-legacy-peer-owner-registration",
    },
  });

  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "OWNER_ROOT_COORDINATOR_CONFLICT");
  const after = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(after.body.ownerRootTaskId, null);
  assert.equal(after.body.revision, current.body.revision);
});

test("domain coordinator leases allow disjoint parallel owners while preserving the Global Coordinator", async () => {
  const instanceSecret = "5".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Global", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
        { id: "frontend-a", label: "Frontend A", owner: "Codex", source: "codex", threadId: "frontend-a-thread", taskType: "peer_task", codexHostId: "host-frontend-a", workspacePath: "/tmp/taskboard/frontend-a" },
        { id: "frontend-b", label: "Frontend B", owner: "Codex", source: "codex", threadId: "frontend-b-thread", taskType: "peer_task", codexHostId: "host-frontend-b", workspacePath: "/tmp/taskboard/frontend-b" },
        { id: "backend", label: "Backend", owner: "Codex", source: "codex", threadId: "backend-thread", taskType: "peer_task", codexHostId: "host-backend", workspacePath: "/tmp/taskboard/backend" },
      ],
      adapters: [],
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend-a", "frontend-b"] },
        { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["backend"] },
      ],
    });
    database.close();
    return { instanceSecret };
  });

  const frontend = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend", {
    method: "POST",
    body: {
      holderTaskId: "frontend-a", holderThreadId: "frontend-a-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  const backend = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/backend", {
    method: "POST",
    body: {
      holderTaskId: "backend", holderThreadId: "backend-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(frontend.response.status, 200, JSON.stringify(frontend.body));
  assert.equal(backend.response.status, 200, JSON.stringify(backend.body));
  assert.deepEqual(frontend.body.lease.writeScope, ["web"]);
  assert.deepEqual(backend.body.lease.writeScope, ["server"]);

  const frontendRenewPath = "/api/local/projects/local/domain-coordinator-leases/frontend/renew";
  const frontendRenewBody = {
    holderTaskId: "frontend-a", holderThreadId: "frontend-a-thread",
    holderCodexHostId: "host-frontend-a", holderWorkspacePath: "/tmp/taskboard/frontend-a",
    expectedLeaseId: frontend.body.lease.id, leaseDurationSeconds: 120,
  };
  const renewedFrontend = await request(
    baseUrl,
    frontendRenewPath,
    {
      method: "POST",
      headers: signedCoordinatorRenewHeaders(
        instanceSecret, "7".repeat(32), frontendRenewPath, frontendRenewBody,
      ),
      body: frontendRenewBody,
    },
  );
  assert.equal(renewedFrontend.response.status, 200);
  assert.equal(renewedFrontend.body.lease.id, frontend.body.lease.id);
  assert.equal(renewedFrontend.body.receipt.action, "renewed");

  const competing = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend", {
    method: "POST",
    body: {
      holderTaskId: "frontend-b", holderThreadId: "frontend-b-thread",
      expectedLeaseId: frontend.body.lease.id, leaseDurationSeconds: 60,
    },
  });
  assert.equal(competing.response.status, 409);
  assert.equal(competing.body.error.code, "DOMAIN_COORDINATOR_LEASE_ACTIVE");

  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.coordination.coordinatorTaskId, "root");
  assert.equal(snapshot.body.coordination.runtimeOwnership, "single_writer");
  assert.deepEqual(snapshot.body.coordination.domainCoordinators.map((domain) => [
    domain.domainId, domain.coordinatorTaskId, domain.assignment,
  ]), [
    ["frontend", "frontend-a", "lease"],
    ["backend", "backend", "lease"],
  ]);

  const receipts = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/receipts");
  assert.equal(receipts.response.status, 200);
  assert.deepEqual(receipts.body.receipts.map((receipt) => receipt.action), ["renewed", "acquired"]);

  const released = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/release", {
    method: "POST",
    body: {
      holderTaskId: "frontend-a", holderThreadId: "frontend-a-thread",
      expectedLeaseId: frontend.body.lease.id,
    },
  });
  assert.equal(released.response.status, 200);
  const expiredFrontendRenewBody = {
    ...frontendRenewBody, expectedLeaseId: frontend.body.lease.id,
  };
  const expiredRenewal = await request(
    baseUrl,
    frontendRenewPath,
    {
      method: "POST",
      headers: signedCoordinatorRenewHeaders(
        instanceSecret, "8".repeat(32), frontendRenewPath, expiredFrontendRenewBody,
      ),
      body: expiredFrontendRenewBody,
    },
  );
  assert.equal(expiredRenewal.response.status, 409);
  assert.equal(expiredRenewal.body.error.code, "DOMAIN_COORDINATOR_LEASE_NOT_ACTIVE");
  const afterImmediateRelease = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(afterImmediateRelease.response.status, 200);
  assert.equal(
    afterImmediateRelease.body.coordination.domainCoordinators.find(
      (domain) => domain.domainId === "frontend",
    ).assignment,
    "unassigned",
  );
  const replacementLease = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend", {
    method: "POST",
    body: {
      holderTaskId: "frontend-b", holderThreadId: "frontend-b-thread",
      expectedLeaseId: frontend.body.lease.id, leaseDurationSeconds: 60,
    },
  });
  assert.equal(replacementLease.response.status, 200);
  assert.equal(replacementLease.body.lease.holderTaskId, "frontend-b");
  assert.notEqual(replacementLease.body.lease.id, frontend.body.lease.id);
});

test("protected domain configuration creates the live routing path with optimistic idempotent writes", async () => {
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "global",
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "host-global", workspacePath: "/tmp/taskboard/global" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "host-frontend", workspacePath: "/tmp/taskboard/frontend" },
        { id: "backend", label: "Backend", owner: "Codex", source: "codex", threadId: "backend-thread", taskType: "peer_task", codexHostId: "host-backend", workspacePath: "/tmp/taskboard/backend" },
      ],
      adapters: [],
    });
    database.close();
    return {};
  });
  const globalLease = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "global", holderThreadId: "global-thread",
      expectedLeaseId: null, leaseDurationSeconds: 120,
    },
  });
  assert.equal(globalLease.response.status, 200, JSON.stringify(globalLease.body));

  const protectedHeaders = { "x-taskboard-client": "taskctl" };
  const initial = await request(baseUrl, "/api/local/projects/local/coordination-domains", {
    headers: protectedHeaders,
  });
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body.domains, []);
  const frontendBody = {
    label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
    expectedRevision: initial.body.revision, idempotencyKey: "configure-frontend-v1",
    holderTaskId: "global", holderThreadId: "global-thread",
    expectedCoordinatorLeaseId: globalLease.body.lease.id,
  };
  const configured = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "PUT", headers: protectedHeaders, body: frontendBody,
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
  assert.equal(configured.body.applied, true);
  assert.deepEqual(configured.body.configuration.domains, [{
    id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
  }]);

  const replayed = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "PUT", headers: protectedHeaders, body: frontendBody,
  });
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.body.applied, false);
  assert.equal(replayed.body.receipt.id, configured.body.receipt.id);
  const reusedKey = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "PUT", headers: protectedHeaders,
    body: { ...frontendBody, label: "Different" },
  });
  assert.equal(reusedKey.response.status, 409);
  assert.equal(reusedKey.body.error.code, "COORDINATION_DOMAIN_IDEMPOTENCY_CONFLICT");

  const overlapping = await request(baseUrl, "/api/local/projects/local/coordination-domains/backend", {
    method: "PUT", headers: protectedHeaders,
    body: {
      ...frontendBody, label: "Backend", writeScope: ["web/admin"], eligibleTaskIds: ["backend"],
      expectedRevision: configured.body.configuration.revision, idempotencyKey: "configure-backend-v1",
    },
  });
  assert.equal(overlapping.response.status, 409);
  assert.equal(overlapping.body.error.code, "COORDINATION_DOMAIN_SCOPE_OVERLAP");
  const afterOverlap = await request(baseUrl, "/api/local/projects/local/coordination-domains", {
    headers: protectedHeaders,
  });
  assert.equal(afterOverlap.body.revision, configured.body.configuration.revision);

  const frontendLease = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend", {
    method: "POST",
    body: {
      holderTaskId: "frontend", holderThreadId: "frontend-thread",
      expectedLeaseId: null, leaseDurationSeconds: 120,
    },
  });
  assert.equal(frontendLease.response.status, 200, JSON.stringify(frontendLease.body));
  const withLease = await request(baseUrl, "/api/local/projects/local/coordination-domains", {
    headers: protectedHeaders,
  });
  const renameWhileReserved = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "PUT", headers: protectedHeaders,
    body: {
      ...frontendBody, label: "Frontend renamed", expectedRevision: withLease.body.revision,
      idempotencyKey: "rename-frontend-reserved",
    },
  });
  assert.equal(renameWhileReserved.response.status, 409);
  assert.equal(renameWhileReserved.body.error.code, "DOMAIN_COORDINATOR_LEASE_RESERVED");
  const removeWhileReserved = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "DELETE", headers: protectedHeaders,
    body: {
      expectedRevision: withLease.body.revision, idempotencyKey: "remove-frontend-reserved",
      holderTaskId: "global", holderThreadId: "global-thread",
      expectedCoordinatorLeaseId: globalLease.body.lease.id,
    },
  });
  assert.equal(removeWhileReserved.response.status, 409);
  assert.equal(removeWhileReserved.body.error.code, "DOMAIN_COORDINATOR_LEASE_RESERVED");

  const released = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/release", {
    method: "POST",
    body: {
      holderTaskId: "frontend", holderThreadId: "frontend-thread",
      expectedLeaseId: frontendLease.body.lease.id,
    },
  });
  assert.equal(released.response.status, 200);
  const afterRelease = await request(baseUrl, "/api/local/projects/local/coordination-domains", {
    headers: protectedHeaders,
  });
  const removed = await request(baseUrl, "/api/local/projects/local/coordination-domains/frontend", {
    method: "DELETE", headers: protectedHeaders,
    body: {
      expectedRevision: afterRelease.body.revision, idempotencyKey: "remove-frontend-v1",
      holderTaskId: "global", holderThreadId: "global-thread",
      expectedCoordinatorLeaseId: globalLease.body.lease.id,
    },
  });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.applied, true);
  assert.deepEqual(removed.body.configuration.domains, []);
});

test("domain creation rejects reserved orphan leases and clears expired migration residue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-orphan-domain-test-"));
  const nowMs = Date.now();
  const orphanLease = (id, acquiredAt, expiresAt) => ({
    id, holderTaskId: "peer", holderThreadId: "peer-thread",
    holderCodexHostId: "host-peer", holderWorkspacePath: "/tmp/taskboard/peer",
    acquiredAt: new Date(acquiredAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
  });
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    const globalLease = {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "host-global", holderWorkspacePath: "/tmp/taskboard/global",
      acquiredAt: new Date(nowMs - 1_000).toISOString(), expiresAt: new Date(nowMs + 120_000).toISOString(),
    };
    database.upsertAgentLaneProject("local", {
      rootTaskId: "global",
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "host-global", workspacePath: "/tmp/taskboard/global" },
        { id: "peer", label: "Peer", owner: "Codex", source: "codex", threadId: "peer-thread", taskType: "peer_task", codexHostId: "host-peer", workspacePath: "/tmp/taskboard/peer" },
      ],
      adapters: [],
      coordinatorLease: globalLease,
      domainCoordinatorLeases: {
        ghost: orphanLease("ghost-lease", nowMs - 1_000, nowMs + 60_000),
        expired: orphanLease("expired-lease", nowMs - 60_000, nowMs - 1_000),
      },
    });
    const control = {
      expectedRevision: database.getAgentLaneCoordinationDomains("local").revision,
      holderTaskId: "global", holderThreadId: "global-thread",
      expectedCoordinatorLeaseId: globalLease.id,
    };
    assert.throws(
      () => database.configureAgentLaneCoordinationDomain("local", "ghost", {
        domain: { label: "Ghost", writeScope: ["ghost"], eligibleTaskIds: ["peer"] },
        ...control, idempotencyKey: "configure-ghost-v1",
      }),
      (error) => error?.status === 409 && error?.code === "DOMAIN_COORDINATOR_LEASE_RESERVED",
    );
    const afterRejected = database.getAgentLaneProject("local");
    assert.equal(afterRejected.coordinationDomains, undefined);
    assert.equal(afterRejected.domainCoordinatorLeases.ghost.id, "ghost-lease");

    const configured = database.configureAgentLaneCoordinationDomain("local", "expired", {
      domain: { label: "Expired", writeScope: ["expired"], eligibleTaskIds: ["peer"] },
      ...control, idempotencyKey: "configure-expired-v1",
    });
    assert.equal(configured.applied, true);
    assert.equal(database.getAgentLaneProject("local").domainCoordinatorLeases.expired, undefined);
    assert.equal(database.getAgentLaneProject("local").domainCoordinatorLeases.ghost.id, "ghost-lease");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("naturally expired coordinator leases recover the same holders with new epochs", async () => {
  const instanceSecret = "a".repeat(64);
  const acquiredAt = new Date(Date.now() - 120_000).toISOString();
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "global",
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "host-global", workspacePath: "/tmp/global" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "host-frontend", workspacePath: "/tmp/frontend" },
      ],
      adapters: [],
      coordinatorLease: {
        id: "expired-global", holderTaskId: "global", holderThreadId: "global-thread",
        holderCodexHostId: "host-global", holderWorkspacePath: "/tmp/global",
        acquiredAt, expiresAt,
      },
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      ],
      domainCoordinatorLeases: {
        frontend: {
          id: "expired-frontend", domainId: "frontend", holderTaskId: "frontend",
          holderThreadId: "frontend-thread", holderCodexHostId: "host-frontend",
          holderWorkspacePath: "/tmp/frontend", acquiredAt, expiresAt, writeScope: ["web"],
        },
      },
    });
    database.close();
    return { instanceSecret };
  });

  const before = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(before.body.coordination.assignment, "unassigned");
  assert.deepEqual(
    {
      holderTaskId: before.body.coordination.lease.holderTaskId,
      bindingValid: before.body.coordination.lease.bindingValid,
      releasedAt: before.body.coordination.lease.releasedAt,
    },
    { holderTaskId: "global", bindingValid: true, releasedAt: null },
  );

  const globalPath = "/api/local/projects/local/coordinator-lease/recover";
  const globalBody = {
    holderTaskId: "global", holderThreadId: "global-thread",
    holderCodexHostId: "host-global", holderWorkspacePath: "/tmp/global",
    expectedLeaseId: "expired-global", leaseDurationSeconds: 120,
  };
  const global = await request(baseUrl, globalPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "b".repeat(32), globalPath, globalBody),
    body: globalBody,
  });
  assert.equal(global.response.status, 200);
  assert.notEqual(global.body.lease.id, "expired-global");
  assert.equal(global.body.receipt.action, "acquired");

  const domainPath = "/api/local/projects/local/domain-coordinator-leases/frontend/recover";
  const domainBody = {
    holderTaskId: "frontend", holderThreadId: "frontend-thread",
    holderCodexHostId: "host-frontend", holderWorkspacePath: "/tmp/frontend",
    expectedLeaseId: "expired-frontend", leaseDurationSeconds: 120,
  };
  const domain = await request(baseUrl, domainPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "c".repeat(32), domainPath, domainBody),
    body: domainBody,
  });
  assert.equal(domain.response.status, 200);
  assert.notEqual(domain.body.lease.id, "expired-frontend");
  assert.equal(domain.body.receipt.action, "acquired");

  const active = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(active.body.coordination.assignment, "lease");
  assert.equal(active.body.coordination.domainCoordinators[0].assignment, "lease");

  const globalRelease = await request(baseUrl, "/api/local/projects/local/coordinator-lease/release", {
    method: "POST",
    body: {
      holderTaskId: "global", holderThreadId: "global-thread", expectedLeaseId: global.body.lease.id,
    },
  });
  assert.equal(globalRelease.response.status, 200);
  const domainRelease = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/release", {
    method: "POST",
    body: {
      holderTaskId: "frontend", holderThreadId: "frontend-thread", expectedLeaseId: domain.body.lease.id,
    },
  });
  assert.equal(domainRelease.response.status, 200);

  const legacyDatabase = new TaskboardDatabase(databasePath);
  const releasedConfig = legacyDatabase.getAgentLaneProject("local");
  const { releasedAt: globalReleasedAt, ...legacyGlobalLease } = releasedConfig.coordinatorLease;
  const { releasedAt: domainReleasedAt, ...legacyDomainLease } = (
    releasedConfig.domainCoordinatorLeases.frontend
  );
  assert.ok(globalReleasedAt);
  assert.ok(domainReleasedAt);
  legacyDatabase.upsertAgentLaneProject("local", {
    ...releasedConfig,
    coordinatorLease: legacyGlobalLease,
    domainCoordinatorLeases: { frontend: legacyDomainLease },
  });
  legacyDatabase.close();

  const legacySnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(legacySnapshot.response.status, 200);
  assert.ok(legacySnapshot.body.coordination.lease.releasedAt);
  assert.ok(legacySnapshot.body.coordination.domainCoordinators[0].lease.releasedAt);

  const releasedGlobalBody = { ...globalBody, expectedLeaseId: global.body.lease.id };
  const releasedGlobal = await request(baseUrl, globalPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "d".repeat(32), globalPath, releasedGlobalBody),
    body: releasedGlobalBody,
  });
  assert.equal(releasedGlobal.response.status, 409);
  assert.equal(releasedGlobal.body.error.code, "COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE");
  const releasedDomainBody = { ...domainBody, expectedLeaseId: domain.body.lease.id };
  const releasedDomain = await request(baseUrl, domainPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "e".repeat(32), domainPath, releasedDomainBody),
    body: releasedDomainBody,
  });
  assert.equal(releasedDomain.response.status, 409);
  assert.equal(releasedDomain.body.error.code, "DOMAIN_COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE");

  const globalReceipts = await request(baseUrl, "/api/local/projects/local/coordinator-lease/receipts");
  const domainReceipts = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/receipts");
  assert.deepEqual(globalReceipts.body.receipts.map((receipt) => receipt.action), ["released", "acquired"]);
  assert.deepEqual(domainReceipts.body.receipts.map((receipt) => receipt.action), ["released", "acquired"]);
});

test("a fresh host runtime drift makes persisted Global and domain coordinator bindings unusable", async () => {
  const instanceSecret = "7".repeat(64);
  const acquiredAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator",
      tasks: [
        {
          id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex",
          threadId: "coordinator-thread", taskType: "root_task",
          codexProjectId: "sbkk-project", codexProjectKind: "local",
          codexHostId: "host-coordinator", workspacePath: "/tmp/sbkk",
        },
        {
          id: "frontend", label: "Frontend", owner: "Codex", source: "codex",
          threadId: "frontend-thread", taskType: "peer_task",
          codexProjectId: "sbkk-project", codexProjectKind: "local",
          codexHostId: "host-frontend", workspacePath: "/tmp/sbkk/frontend",
        },
      ],
      adapters: [],
      coordinatorLease: {
        id: "coordinator-lease", holderTaskId: "coordinator",
        holderThreadId: "coordinator-thread", holderCodexHostId: "host-coordinator",
        holderWorkspacePath: "/tmp/sbkk", acquiredAt, expiresAt,
      },
      coordinationDomains: [{
        id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
      }],
      domainCoordinatorLeases: {
        frontend: {
          id: "frontend-lease", holderTaskId: "frontend", holderThreadId: "frontend-thread",
          holderCodexHostId: "host-frontend", holderWorkspacePath: "/tmp/sbkk/frontend",
          acquiredAt, expiresAt, writeScope: ["web"],
        },
      },
    });
    database.close();
    return { instanceSecret };
  });

  const published = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "7".repeat(32)),
    body: {
      threadId: "coordinator-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "market-project", codexProjectKind: "local",
      codexHostId: "host-coordinator", workspacePath: "/tmp/sbkk",
    },
  });
  assert.equal(published.response.status, 200);

  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.coordination.lease.bindingValid, false);
  assert.equal(snapshot.body.coordination.assignment, "unassigned");

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "c".repeat(32)),
    body: {
      threadId: "coordinator-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "sbkk-project", codexProjectKind: "remote",
      codexHostId: "host-coordinator", workspacePath: "/tmp/sbkk",
    },
  });
  const globalKindSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(globalKindSnapshot.body.coordination.lease.bindingValid, false);

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "8".repeat(32)),
    body: {
      threadId: "frontend-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "market-project", codexProjectKind: "local",
      codexHostId: "host-frontend", workspacePath: "/tmp/sbkk/frontend",
    },
  });
  const domainSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(domainSnapshot.body.coordination.domainCoordinators[0].lease.bindingValid, false);
  assert.equal(domainSnapshot.body.coordination.domainCoordinators[0].assignment, "unassigned");

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "d".repeat(32)),
    body: {
      threadId: "frontend-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "sbkk-project", codexProjectKind: "remote",
      codexHostId: "host-frontend", workspacePath: "/tmp/sbkk/frontend",
    },
  });
  const domainKindSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(domainKindSnapshot.body.coordination.domainCoordinators[0].lease.bindingValid, false);

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "b".repeat(32)),
    body: {
      threadId: "unrelated-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "unrelated-project", codexProjectKind: "local",
      codexHostId: "unrelated-host", workspacePath: "/tmp/unrelated",
    },
  });
  const switchedSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(switchedSnapshot.body.coordination.lease.bindingValid, false);
  assert.equal(switchedSnapshot.body.coordination.domainCoordinators[0].lease.bindingValid, false);

  const inspection = new TaskboardDatabase(databasePath);
  inspection.upsertAgentLaneProject("local", {
    ...inspection.getAgentLaneProject("local"),
    coordinatorLease: null,
    domainCoordinatorLeases: {},
  });
  inspection.close();
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "9".repeat(32)),
    body: {
      threadId: "coordinator-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "market-project", codexProjectKind: "local",
      codexHostId: "host-coordinator", workspacePath: "/tmp/sbkk",
    },
  });
  const rejected = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "coordinator", holderThreadId: "coordinator-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "COORDINATOR_BINDING_MISMATCH");
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "a".repeat(32)),
    body: {
      threadId: "frontend-thread", threadRunning: false, threadTodoProgress: null,
      codexProjectId: "market-project", codexProjectKind: "local",
      codexHostId: "host-frontend", workspacePath: "/tmp/sbkk/frontend",
    },
  });
  const rejectedDomain = await request(
    baseUrl,
    "/api/local/projects/local/domain-coordinator-leases/frontend",
    {
      method: "POST",
      body: {
        holderTaskId: "frontend", holderThreadId: "frontend-thread",
        expectedLeaseId: null, leaseDurationSeconds: 60,
      },
    },
  );
  assert.equal(rejectedDomain.response.status, 409);
  assert.equal(rejectedDomain.body.error.code, "DOMAIN_COORDINATOR_BINDING_MISMATCH");
  const receipts = await request(baseUrl, "/api/local/projects/local/coordinator-lease/receipts");
  assert.deepEqual(receipts.body.receipts, []);
  const domainReceipts = await request(
    baseUrl,
    "/api/local/projects/local/domain-coordinator-leases/frontend/receipts",
  );
  assert.deepEqual(domainReceipts.body.receipts, []);
});

test("legacy unbound coordinator leases fail closed instead of upgrading to a new route", async () => {
  const instanceSecret = "6".repeat(64);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "host-global", workspacePath: process.cwd() },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "host-frontend", workspacePath: process.cwd() },
      ],
      adapters: [],
      coordinatorLease: {
        id: "legacy-global", holderTaskId: "global",
        holderThreadId: "global-thread", holderCodexHostId: "host-global",
        holderWorkspacePath: ".", acquiredAt: new Date().toISOString(), expiresAt,
      },
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      ],
      domainCoordinatorLeases: {
        frontend: {
          id: "legacy-frontend", holderTaskId: "frontend",
          holderThreadId: "frontend-thread", holderCodexHostId: "host-frontend",
          holderWorkspacePath: ".", acquiredAt: new Date().toISOString(), expiresAt,
          writeScope: ["web"],
        },
      },
    });
    database.close();
    return { instanceSecret };
  });
  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.coordination.assignment, "unassigned");
  assert.equal(snapshot.body.coordination.domainCoordinators[0].assignment, "unassigned");
  const beforeDatabase = new TaskboardDatabase(databasePath);
  const beforeConfig = beforeDatabase.getAgentLaneProject("local");
  beforeDatabase.close();

  for (const candidate of [
    {
      pathname: "/api/local/projects/local/coordinator-lease/renew",
      body: {
        holderTaskId: "global", holderThreadId: "global-thread",
        holderCodexHostId: "host-global", holderWorkspacePath: process.cwd(),
        expectedLeaseId: "legacy-global", leaseDurationSeconds: 120,
      },
    },
    {
      pathname: "/api/local/projects/local/domain-coordinator-leases/frontend/renew",
      body: {
        holderTaskId: "frontend", holderThreadId: "frontend-thread",
        holderCodexHostId: "host-frontend", holderWorkspacePath: process.cwd(),
        expectedLeaseId: "legacy-frontend", leaseDurationSeconds: 120,
      },
    },
  ]) {
    const renewal = await request(baseUrl, candidate.pathname, {
      method: "POST",
      headers: signedCoordinatorRenewHeaders(
        instanceSecret, crypto.randomUUID().replaceAll("-", ""), candidate.pathname, candidate.body,
      ),
      body: candidate.body,
    });
    assert.equal(renewal.response.status, 409);
  }
  for (const candidate of [
    {
      pathname: "/api/local/projects/local/coordinator-lease",
      body: { holderTaskId: "global", holderThreadId: "global-thread", expectedLeaseId: "legacy-global", leaseDurationSeconds: 120 },
    },
    {
      pathname: "/api/local/projects/local/domain-coordinator-leases/frontend",
      body: { holderTaskId: "frontend", holderThreadId: "frontend-thread", expectedLeaseId: "legacy-frontend", leaseDurationSeconds: 120 },
    },
  ]) {
    const renewal = await request(baseUrl, candidate.pathname, {
      method: "POST", body: candidate.body,
    });
    assert.equal(renewal.response.status, 409);
  }
  const globalReceipts = await request(baseUrl, "/api/local/projects/local/coordinator-lease/receipts");
  const domainReceipts = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/receipts");
  assert.deepEqual(globalReceipts.body.receipts, []);
  assert.deepEqual(domainReceipts.body.receipts, []);
  const afterDatabase = new TaskboardDatabase(databasePath);
  const afterConfig = afterDatabase.getAgentLaneProject("local");
  afterDatabase.close();
  assert.deepEqual(afterConfig.coordinatorLease, beforeConfig.coordinatorLease);
  assert.deepEqual(afterConfig.domainCoordinatorLeases, beforeConfig.domainCoordinatorLeases);
});

test("fresh coordinator acquisition rejects incomplete Global and domain window bindings", async () => {
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    const invalidLegacyConfig = {
      rootTaskId: "global",
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task" },
      ],
      adapters: [],
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      ],
    };
    assert.throws(() => database.upsertAgentLaneProject("local", invalidLegacyConfig), (error) => (
      error?.code === "COORDINATION_DOMAIN_BINDING_MISMATCH"
    ));
    database.upsertAgentLaneProject("local", {
      ...invalidLegacyConfig,
      tasks: invalidLegacyConfig.tasks.map((task) => task.id === "frontend"
        ? { ...task, codexHostId: "local", workspacePath: "/tmp/frontend" }
        : task),
    });
    database.close();
    return {};
  });
  for (const candidate of [
    {
      pathname: "/api/local/projects/local/coordinator-lease",
      body: { holderTaskId: "global", holderThreadId: "global-thread", expectedLeaseId: null, leaseDurationSeconds: 60 },
    },
    {
      pathname: "/api/local/projects/local/domain-coordinator-leases/frontend",
      body: { holderTaskId: "global", holderThreadId: "global-thread", expectedLeaseId: null, leaseDurationSeconds: 60 },
    },
  ]) {
    const acquisition = await request(baseUrl, candidate.pathname, {
      method: "POST", body: candidate.body,
    });
    assert.equal(acquisition.response.status, 409);
    assert.ok([
      "COORDINATOR_BINDING_MISMATCH",
      "COORDINATION_DOMAIN_BINDING_MISMATCH",
      "DOMAIN_COORDINATOR_BINDING_MISMATCH",
    ].includes(acquisition.body.error.code));
  }
  const receipts = await request(baseUrl, "/api/local/projects/local/coordinator-lease/receipts");
  const domainReceipts = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend/receipts");
  assert.deepEqual(receipts.body.receipts, []);
  assert.deepEqual(domainReceipts.body.receipts, []);
});

test("coordination domain configuration rejects overlapping and case-aliased write scopes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-domain-overlap-"));
  try {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    assert.throws(() => database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [{ id: "root", label: "Root", owner: "Codex", source: "codex", threadId: "root-thread", taskType: "root_task" }],
      adapters: [],
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["root"] },
        { id: "frontend-tests", label: "Frontend tests", writeScope: ["web/test"], eligibleTaskIds: ["root"] },
      ],
    }), (error) => error?.code === "COORDINATION_DOMAIN_SCOPE_OVERLAP");
    for (const rightScope of ["WEB", "WEB/src"]) {
      assert.throws(() => database.upsertAgentLaneProject("local", {
        rootTaskId: "root",
        tasks: [{ id: "root", label: "Root", owner: "Codex", source: "codex", threadId: "root-thread", taskType: "root_task" }],
        adapters: [],
        coordinationDomains: [
          { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["root"] },
          { id: "frontend-alias", label: "Frontend alias", writeScope: [rightScope], eligibleTaskIds: ["root"] },
        ],
      }), (error) => error?.code === "COORDINATION_DOMAIN_SCOPE_OVERLAP");
    }
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("protected domain Todo assignment persists the Global Coordinator decision", async () => {
  let todo;
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    database.createProject({ id: "other", name: "Other", workspacePath: null });
    database.upsertAgentLaneProject("local", {
      rootTaskId: "global",
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
      ],
      adapters: [],
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      ],
    });
    const binding = {
      threadId: "global-thread", codexProjectId: "local", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/global",
    };
    todo = database.createTask({
      projectId: "local", title: "Frontend work", description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
      actor, assignee: actor, developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain" },
      workingLog: null, workflowProfile: "vibe", startDate: null, dueDate: null, recurrence: null,
    });
    database.close();
    return {};
  });
  const global = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: { holderTaskId: "global", holderThreadId: "global-thread", expectedLeaseId: null, leaseDurationSeconds: 120 },
  });
  assert.equal(global.response.status, 200);
  const domain = await request(baseUrl, "/api/local/projects/local/domain-coordinator-leases/frontend", {
    method: "POST",
    body: { holderTaskId: "frontend", holderThreadId: "frontend-thread", expectedLeaseId: null, leaseDurationSeconds: 120 },
  });
  assert.equal(domain.response.status, 200);

  const browserWrite = await request(baseUrl, `/api/local/projects/local/domain-todo-assignments/${todo.identifier}`, {
    method: "POST",
    body: {
      domainId: "frontend", taskVersion: todo.version, holderTaskId: "global",
      holderThreadId: "global-thread", expectedCoordinatorLeaseId: global.body.lease.id,
    },
  });
  assert.equal(browserWrite.response.status, 403);
  const assigned = await request(baseUrl, `/api/local/projects/local/domain-todo-assignments/${todo.identifier}`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      domainId: "frontend", taskVersion: todo.version, holderTaskId: "global",
      holderThreadId: "global-thread", expectedCoordinatorLeaseId: global.body.lease.id,
    },
  });
  assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.assignment.taskId, todo.id);
  assert.equal(assigned.body.assignment.domainId, "frontend");
  assert.equal(assigned.body.task.version, todo.version + 1);
  const status = await request(baseUrl, `/api/local/projects/local/domain-todo-assignments/${todo.identifier}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.assignment.assignedByLeaseId, global.body.lease.id);
  const crossProjectStatus = await request(
    baseUrl,
    `/api/local/projects/other/domain-todo-assignments/${todo.identifier}`,
  );
  assert.equal(crossProjectStatus.response.status, 409);
  assert.equal(crossProjectStatus.body.error.code, "DOMAIN_TODO_PROJECT_MISMATCH");
  assert.equal(crossProjectStatus.body.assignment, undefined);
  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200);
  const projected = snapshot.body.todos.find((candidate) => candidate.taskId === todo.id);
  assert.equal(projected.domainAssignment.domainId, "frontend");
  assert.equal(projected.dispatchTarget.rootThreadId, "frontend-thread");
  assert.equal(projected.dispatchTarget.worktreePath, "/tmp/product");
  const cleared = await request(baseUrl, `/api/local/projects/local/domain-todo-assignments/${todo.identifier}`, {
    method: "DELETE",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      taskVersion: assigned.body.task.version, holderTaskId: "global",
      holderThreadId: "global-thread", expectedCoordinatorLeaseId: global.body.lease.id,
    },
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.assignment, null);
  assert.equal(cleared.body.task.version, assigned.body.task.version + 1);
});

test("protected cross-domain clearance binds the exact target coordinator frontier", async () => {
  let source;
  let target;
  const instanceSecret = "d".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const expiresAt = "2099-01-01T00:00:00.000Z";
    database.upsertAgentLaneProject("local", {
      tasks: [
        { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
        { id: "backend", label: "Backend", owner: "Codex", source: "codex", threadId: "backend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/backend" },
      ],
      adapters: [],
      coordinatorLease: { id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/global", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
      coordinationDomains: [
        { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
        { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["backend"] },
      ],
      domainCoordinatorLeases: {
        frontend: { id: "frontend-lease", holderTaskId: "frontend", holderThreadId: "frontend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
        backend: { id: "backend-lease", holderTaskId: "backend", holderThreadId: "backend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/backend", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
      },
    });
    const binding = {
      threadId: "global-thread", codexProjectId: "local", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/global",
    };
    const createTodo = (title) => database.createTask({
      projectId: "local", title, description: "", status: "todo", priority: "high",
      labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
      actor, assignee: actor, developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain" },
      workingLog: null, workflowProfile: "vibe", startDate: null, dueDate: null, recurrence: null,
    });
    source = createTodo("Frontend source");
    target = createTodo("Backend target");
    source = database.setAgentTaskDomain("local", source.id, {
      domainId: "frontend", taskVersion: source.version, holderTaskId: "global",
      holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
    }).task;
    target = database.setAgentTaskDomain("local", target.id, {
      domainId: "backend", taskVersion: target.version, holderTaskId: "global",
      holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
    }).task;
    source = database.addTaskRelation(
      source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
    ).task;
    source = database.moveTask(source.id, source.version, "done", undefined, binding.threadId, binding, actor);
    database.close();
    return { instanceSecret };
  });

  const route = `/api/local/projects/local/cross-domain-dependency-clearances/${target.identifier}`;
  const pending = await request(baseUrl, route);
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.clearances[0].status, "awaiting_handoff");
  const agentLanes = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  const deliveryRequest = agentLanes.body.coordination.pendingCrossDomainHandoff;
  assert.equal(deliveryRequest.sourceTaskId, source.id);
  assert.equal(deliveryRequest.targetTaskId, target.id);
  const deliveryRoute = "/api/local/projects/local/cross-domain-handoff-delivery/claim";
  const unsignedDelivery = await request(baseUrl, deliveryRoute, {
    method: "POST",
    body: deliveryRequest,
  });
  assert.equal(unsignedDelivery.response.status, 403);
  const claimedDelivery = await request(baseUrl, deliveryRoute, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "1".repeat(32)),
    body: deliveryRequest,
  });
  assert.equal(claimedDelivery.response.status, 201, JSON.stringify(claimedDelivery.body));
  const replayedDelivery = await request(baseUrl, deliveryRoute, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "2".repeat(32)),
    body: deliveryRequest,
  });
  assert.equal(replayedDelivery.response.status, 200);
  assert.equal(replayedDelivery.body.reason, "reserved");
  assert.equal(replayedDelivery.body.receipt.id, claimedDelivery.body.receipt.id);
  const confirmedDelivery = await request(
    baseUrl,
    "/api/local/projects/local/cross-domain-handoff-delivery/confirm",
    {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, "3".repeat(32)),
      body: { deliveryId: claimedDelivery.body.receipt.id, deliveryTurnId: "backend-delivery-turn" },
    },
  );
  assert.equal(confirmedDelivery.response.status, 200, JSON.stringify(confirmedDelivery.body));
  const afterDelivery = await request(baseUrl, route);
  assert.equal(afterDelivery.body.clearances[0].status, "awaiting_handoff");
  assert.equal(afterDelivery.body.clearances[0].delivery.state, "delivered");
  const unprotected = await request(baseUrl, route, {
    method: "POST",
    body: {
      sourceTaskId: source.identifier, idempotencyKey: "api-clearance-1",
      holderTaskId: "backend", holderThreadId: "backend-thread",
      expectedTargetDomainLeaseId: "backend-lease",
    },
  });
  assert.equal(unprotected.response.status, 403);
  const wrongRoute = await request(baseUrl, route, {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      sourceTaskId: source.identifier, idempotencyKey: "api-clearance-1",
      holderTaskId: "frontend", holderThreadId: "frontend-thread",
      expectedTargetDomainLeaseId: "frontend-lease",
    },
  });
  assert.equal(wrongRoute.response.status, 409);
  assert.equal(wrongRoute.body.error.code, "CROSS_DOMAIN_HANDOFF_ROUTE_MISMATCH");
  const accepted = await request(baseUrl, route, {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      sourceTaskId: source.identifier, idempotencyKey: "api-clearance-1",
      holderTaskId: "backend", holderThreadId: "backend-thread",
      expectedTargetDomainLeaseId: "backend-lease",
    },
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.clearance.status, "accepted");
  const projected = await request(baseUrl, `/api/tasks/${target.identifier}/capsule`);
  assert.equal(projected.response.status, 200);
  assert.ok(!projected.body.capsule.readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));
});

test("background Coordinator registration requests a protected host identity handshake without UI focus", async () => {
  let databasePath;
  const instanceSecret = "c".repeat(64);
  const backgroundThreadId = "01a062c1-fd2b-7f61-9114-d483e695640e";
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        connection: "connected", threadId: "owner-thread", taskType: "root_task",
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      }],
      adapters: [],
      coordinatorLease: null,
    });
    database.close();
    return { instanceSecret };
  });
  const before = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const registration = {
    role: "coordinator",
    taskId: "background-coordinator",
    label: "Background Coordinator",
    threadId: backgroundThreadId,
    expectedRevision: before.body.revision,
    idempotencyKey: "background-coordinator-register-v1",
  };

  const pending = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: registration,
  });

  assert.equal(pending.response.status, 202, JSON.stringify(pending.body));
  assert.equal(pending.body.pending, true);
  assert.equal(pending.body.handshake.threadId, backgroundThreadId);
  assert.equal(pending.body.handshake.taskId, "background-coordinator");
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordination_identity_handshakes",
  ).get().count, 1);
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordination_window_receipts",
  ).get().count, 0);
  inspection.close();

  const replayedPending = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: registration,
  });
  assert.equal(replayedPending.response.status, 202);
  assert.equal(replayedPending.body.handshake.id, pending.body.handshake.id);
  const conflictingPending = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: { ...registration, label: "Conflicting Coordinator" },
  });
  assert.equal(conflictingPending.response.status, 409);
  assert.equal(conflictingPending.body.error.code, "COORDINATION_WINDOW_IDEMPOTENCY_CONFLICT");
  const leaseBeforeRegistration = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "background-coordinator", holderThreadId: backgroundThreadId,
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(leaseBeforeRegistration.response.status, 409);

  const listPath = "/api/local/projects/local/coordination-identity-handshakes";
  const listed = await request(baseUrl, listPath, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "1".repeat(32), listPath, null, Date.now(), "GET",
    ),
  });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.handshakes.length, 1);
  assert.deepEqual(listed.body.handshakes[0].expectedHostBinding, {
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
  });
  const registrationProof = { projectId: "local", ...registration };

  const confirmPath = `/api/local/coordination-identity-handshakes/${pending.body.handshake.id}/confirm`;
  const wrongBody = { registration: registrationProof, threadBinding: {
    threadId: backgroundThreadId, codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/wrong-workspace",
  } };
  const wrongConfirmation = await request(baseUrl, confirmPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "2".repeat(32), confirmPath, wrongBody),
    body: wrongBody,
  });
  assert.equal(wrongConfirmation.response.status, 409);
  assert.equal(wrongConfirmation.body.error.code, "COORDINATION_IDENTITY_MISMATCH");

  const confirmBody = { registration: registrationProof, threadBinding: {
    threadId: backgroundThreadId, codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
  } };
  const unprotected = await request(baseUrl, confirmPath, { method: "POST", body: confirmBody });
  assert.equal(unprotected.response.status, 403);
  const staleConfirmation = await request(baseUrl, confirmPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "4".repeat(32), confirmPath, confirmBody, Date.now() - 31_000,
    ),
    body: confirmBody,
  });
  assert.equal(staleConfirmation.response.status, 403);
  for (const [index, conflictingRegistration] of [
    { ...registrationProof, projectId: "other" },
    { ...registrationProof, idempotencyKey: "other-key" },
    { ...registrationProof, taskId: "other-task" },
    { ...registrationProof, role: "owner_root" },
    { ...registrationProof, label: "Other payload" },
  ].entries()) {
    const conflictingBody = { ...confirmBody, registration: conflictingRegistration };
    const conflict = await request(baseUrl, confirmPath, {
      method: "POST",
      headers: signedCoordinatorRenewHeaders(
        instanceSecret, String(index + 5).repeat(32), confirmPath, conflictingBody,
      ),
      body: conflictingBody,
    });
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
  }
  const confirmed = await request(baseUrl, confirmPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "3".repeat(32), confirmPath, confirmBody),
    body: confirmBody,
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.handshake.status, "completed");
  assert.equal(confirmed.body.registration.applied, true);

  const registered = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: registration,
  });
  assert.equal(registered.response.status, 200, JSON.stringify(registered.body));
  assert.equal(registered.body.applied, false);
  assert.equal(registered.body.configuration.ownerRootTaskId, "owner-root");
  assert.equal(registered.body.configuration.windows.length, 2);
  const replayedRegistration = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: registration,
  });
  assert.equal(replayedRegistration.response.status, 200);
  assert.equal(replayedRegistration.body.applied, false);
  assert.equal(replayedRegistration.body.receipt.id, registered.body.receipt.id);

  const acquired = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "background-coordinator", holderThreadId: backgroundThreadId,
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(acquired.response.status, 200, JSON.stringify(acquired.body));
  assert.equal(acquired.body.receipt.action, "acquired");
  const uncertainAcquireRetry = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "background-coordinator", holderThreadId: backgroundThreadId,
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(uncertainAcquireRetry.response.status, 409);
  assert.equal(uncertainAcquireRetry.body.error.code, "COORDINATOR_LEASE_CONFLICT");

  const currentWindows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const expiringRequest = {
    ...registration, taskId: "expiring-coordinator", threadId: "expiring-thread",
    expectedRevision: currentWindows.body.revision, idempotencyKey: "expiring-window",
  };
  const expiring = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: expiringRequest,
  });
  assert.equal(expiring.response.status, 202);
  const expiryInspection = new DatabaseSync(databasePath);
  expiryInspection.prepare(`
    UPDATE agent_coordination_identity_handshakes SET expires_at = ? WHERE id = ?
  `).run(new Date(Date.now() - 1_000).toISOString(), expiring.body.handshake.id);
  expiryInspection.close();
  const afterExpiry = await request(baseUrl, listPath, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "a".repeat(32), listPath, null, Date.now(), "GET",
    ),
  });
  assert.equal(afterExpiry.response.status, 200);
  assert.deepEqual(afterExpiry.body.handshakes, []);

  const drifting = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: { ...expiringRequest, taskId: "drifting-coordinator", threadId: "drifting-thread", idempotencyKey: "drifting-window" },
  });
  assert.equal(drifting.response.status, 202);
  const driftInspection = new DatabaseSync(databasePath);
  const storedProject = driftInspection.prepare(
    "SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'",
  ).get();
  driftInspection.prepare(
    "UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = 'local'",
  ).run(JSON.stringify({ ...JSON.parse(storedProject.config_json), handshakeTestDrift: true }), new Date().toISOString());
  driftInspection.close();
  const afterDrift = await request(baseUrl, listPath, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "b".repeat(32), listPath, null, Date.now(), "GET",
    ),
  });
  assert.equal(afterDrift.response.status, 200);
  assert.deepEqual(afterDrift.body.handshakes, []);
  const finalInspection = new DatabaseSync(databasePath);
  assert.equal(finalInspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordination_identity_handshakes",
  ).get().count, 3);
  assert.deepEqual(finalInspection.prepare(`
    SELECT status FROM agent_coordination_identity_handshakes ORDER BY created_at, id
  `).all().map((row) => row.status).sort(), ["canceled", "completed", "expired"]);
  assert.equal(finalInspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordination_window_receipts",
  ).get().count, 1);
  assert.equal(finalInspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_lease_receipts WHERE action = 'acquired'",
  ).get().count, 1);
  finalInspection.close();
});

test("resident provisioning persists one protected idempotent attempt before replacement thread start", async () => {
  let databasePath;
  const instanceSecret = "d".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        connection: "connected", threadId: "owner-thread", taskType: "root_task",
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      }],
      adapters: [],
      coordinatorLease: null,
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    database.createTask({
      projectId: "local", title: "Replacement work", description: "", status: "todo",
      priority: "medium", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: null, threadBinding: null, actor, assignee: actor,
      developmentContext: null, workingLog: null, startDate: null, dueDate: null,
      recurrence: null,
    });
    database.close();
    return { instanceSecret };
  });
  const windows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const pathname = "/api/local/projects/local/coordinator-provisioning-attempts";
  const body = {
    idempotencyKey: "coordinator-provision-a",
    taskId: "coordinator-local-a",
    label: "Taskboard Execution Coordinator",
    threadSource: "taskboard-coordinator-provision-a",
    model: "gpt-5",
    reasoningEffort: "high",
    expectedRevision: windows.body.revision,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "owner-thread",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/sbkk",
  };
  const unprotected = await request(baseUrl, pathname, { method: "POST", body });
  assert.equal(unprotected.response.status, 403);
  const created = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "1".repeat(32), pathname, body),
    body,
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.applied, true);
  assert.equal(created.body.attempt.status, "pending");
  assert.equal(created.body.attempt.threadId, null);

  const replayed = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "2".repeat(32), pathname, body),
    body,
  });
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.applied, false);
  assert.equal(replayed.body.attempt.id, created.body.attempt.id);
  const lookupPath = "/api/local/projects/local/coordinator-provisioning-attempts/lookup";
  const lookupBody = { idempotencyKey: body.idempotencyKey };
  const lookup = await request(baseUrl, lookupPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "a".repeat(32), lookupPath, lookupBody),
    body: lookupBody,
  });
  assert.equal(lookup.response.status, 200, JSON.stringify(lookup.body));
  assert.equal(lookup.body.attempt.model, "gpt-5");
  assert.equal(lookup.body.attempt.reasoningEffort, "high");

  const conflictBody = { ...body, label: "Different replacement" };
  const conflict = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "3".repeat(32), pathname, conflictBody),
    body: conflictBody,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "COORDINATOR_PROVISIONING_IDEMPOTENCY_CONFLICT");
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_provisioning_attempts",
  ).get().count, 1);
  inspection.close();

  const secondBody = {
    ...body,
    idempotencyKey: "coordinator-provision-b",
    threadSource: "taskboard-coordinator-provision-b",
  };
  const second = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "4".repeat(32), pathname, secondBody),
    body: secondBody,
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, "COORDINATOR_PROVISIONING_IN_PROGRESS");

  const startingPath = `/api/local/coordinator-provisioning-attempts/${created.body.attempt.id}/starting`;
  const starting = await request(baseUrl, startingPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "5".repeat(32), startingPath, {}),
    body: {},
  });
  assert.equal(starting.response.status, 200, JSON.stringify(starting.body));
  assert.equal(starting.body.attempt.status, "starting");
  const shortExpiry = new Date(Date.now() + 1_000).toISOString();
  const expiryInspection = new DatabaseSync(databasePath);
  expiryInspection.prepare(`
    UPDATE agent_coordinator_provisioning_attempts SET expires_at = ? WHERE id = ?
  `).run(shortExpiry, created.body.attempt.id);
  expiryInspection.close();
  const resetPath = `/api/local/coordinator-provisioning-attempts/${created.body.attempt.id}/reset`;
  const reset = await request(baseUrl, resetPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "6".repeat(32), resetPath, {}),
    body: {},
  });
  assert.equal(reset.response.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.attempt.status, "pending");
  assert.equal(reset.body.attempt.retryCount, 1);
  assert.ok(Date.parse(reset.body.attempt.expiresAt) > Date.parse(shortExpiry) + 9 * 60_000);
  const restarted = await request(baseUrl, startingPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "7".repeat(32), startingPath, {}),
    body: {},
  });
  assert.equal(restarted.response.status, 200, JSON.stringify(restarted.body));
  assert.equal(restarted.body.attempt.status, "starting");
  const attachPath = `/api/local/coordinator-provisioning-attempts/${created.body.attempt.id}/attach`;
  const attachBody = { threadId: "01a062c1-fd2b-7f61-9114-d483e695640e" };
  const attached = await request(baseUrl, attachPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "8".repeat(32), attachPath, attachBody),
    body: attachBody,
  });
  assert.equal(attached.response.status, 200, JSON.stringify(attached.body));
  assert.equal(attached.body.attempt.status, "started");
  assert.equal(attached.body.attempt.threadId, attachBody.threadId);
  const repeatedAttach = await request(baseUrl, attachPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "9".repeat(32), attachPath, attachBody),
    body: attachBody,
  });
  assert.equal(repeatedAttach.response.status, 200);
  assert.equal(repeatedAttach.body.attempt.threadId, attachBody.threadId);

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "b".repeat(32)),
    body: {
      threadId: attachBody.threadId, threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/sbkk",
    },
  });
  const exactRegistrationBody = {
    role: "coordinator", taskId: body.taskId, label: body.label,
    threadId: attachBody.threadId, expectedRevision: body.expectedRevision,
    idempotencyKey: `${body.idempotencyKey}-window`,
  };
  for (const terminalStatus of ["expired", "canceled"]) {
    const terminalInspection = new DatabaseSync(databasePath);
    terminalInspection.prepare(`
      UPDATE agent_coordinator_provisioning_attempts SET status = ? WHERE id = ?
    `).run(terminalStatus, created.body.attempt.id);
    terminalInspection.close();
    const lateRegistration = await request(
      baseUrl,
      "/api/local/projects/local/coordination-windows",
      {
        method: "POST",
        headers: { "x-taskboard-client": "taskctl" },
        body: exactRegistrationBody,
      },
    );
    assert.equal(lateRegistration.response.status, 409);
    assert.equal(
      lateRegistration.body.error.code,
      "COORDINATOR_PROVISIONING_REGISTRATION_MISMATCH",
    );
    const zeroTerminalMutationInspection = new DatabaseSync(databasePath);
    assert.equal(zeroTerminalMutationInspection.prepare(
      "SELECT status FROM agent_coordinator_provisioning_attempts WHERE id = ?",
    ).get(created.body.attempt.id).status, terminalStatus);
    assert.equal(zeroTerminalMutationInspection.prepare(
      "SELECT COUNT(*) AS count FROM agent_coordination_window_receipts",
    ).get().count, 0);
    zeroTerminalMutationInspection.close();
  }
  const resumeInspection = new DatabaseSync(databasePath);
  resumeInspection.prepare(`
    UPDATE agent_coordinator_provisioning_attempts SET status = 'started' WHERE id = ?
  `).run(created.body.attempt.id);
  resumeInspection.close();
  const mismatchedRegistration = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    {
      method: "POST",
      headers: { "x-taskboard-client": "taskctl" },
      body: {
        role: "coordinator", taskId: body.taskId, label: "Different replacement",
        threadId: attachBody.threadId, expectedRevision: body.expectedRevision,
        idempotencyKey: "different-window-key",
      },
    },
  );
  assert.equal(mismatchedRegistration.response.status, 409);
  assert.equal(
    mismatchedRegistration.body.error.code,
    "COORDINATOR_PROVISIONING_REGISTRATION_MISMATCH",
  );
  const zeroMutationInspection = new DatabaseSync(databasePath);
  assert.equal(zeroMutationInspection.prepare(
    "SELECT status FROM agent_coordinator_provisioning_attempts WHERE id = ?",
  ).get(created.body.attempt.id).status, "started");
  assert.equal(zeroMutationInspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordination_window_receipts",
  ).get().count, 0);
  zeroMutationInspection.close();
  const registered = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: exactRegistrationBody,
  });
  assert.equal(registered.response.status, 200, JSON.stringify(registered.body));
  const replayedRegistration = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    {
      method: "POST",
      headers: { "x-taskboard-client": "taskctl" },
      body: exactRegistrationBody,
    },
  );
  assert.equal(replayedRegistration.response.status, 200);
  assert.equal(replayedRegistration.body.applied, false);
  assert.equal(replayedRegistration.body.receipt.id, registered.body.receipt.id);
  const postCompletionMismatch = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    {
      method: "POST",
      headers: { "x-taskboard-client": "taskctl" },
      body: {
        role: "owner_root", taskId: body.taskId, label: body.label,
        threadId: attachBody.threadId, expectedRevision: body.expectedRevision,
        idempotencyKey: `${body.idempotencyKey}-window`,
      },
    },
  );
  assert.equal(postCompletionMismatch.response.status, 409);
  assert.equal(
    postCompletionMismatch.body.error.code,
    "COORDINATOR_PROVISIONING_REGISTRATION_MISMATCH",
  );
  const completedInspection = new DatabaseSync(databasePath);
  assert.equal(completedInspection.prepare(`
    SELECT status FROM agent_coordinator_provisioning_attempts WHERE id = ?
  `).get(created.body.attempt.id).status, "completed");
  completedInspection.close();
});

test("resident provisioning atomically retires exact stale Coordinator windows", async () => {
  let databasePath;
  const instanceSecret = "e".repeat(64);
  const staleWindow = {
    taskId: "root", label: "Execution Coordinator", role: "coordinator",
    threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
  };
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        connection: "connected", threadId: "owner-thread", taskType: "root_task",
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      }, {
        id: staleWindow.taskId, label: staleWindow.label, owner: "Codex Global Coordinator",
        source: "codex", connection: "connected", threadId: staleWindow.threadId,
        taskType: "root_task", codexProjectId: staleWindow.codexProjectId,
        codexProjectKind: staleWindow.codexProjectKind, codexHostId: staleWindow.codexHostId,
        workspacePath: staleWindow.workspacePath,
      }],
      adapters: [],
      coordinatorLease: {
        id: "released-lease", holderTaskId: "root", holderThreadId: staleWindow.threadId,
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
        acquiredAt: "2026-09-02T20:00:00.000Z", expiresAt: "2026-09-02T20:05:00.000Z",
        releasedAt: "2026-09-02T20:05:00.000Z",
      },
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    database.createTask({
      projectId: "local", title: "Ready replacement work", description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: null, threadBinding: null, actor, assignee: actor,
      developmentContext: null, workingLog: null, startDate: null, dueDate: null,
      recurrence: null,
    });
    database.close();
    return { instanceSecret };
  });
  const before = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const pathname = "/api/local/projects/local/coordinator-provisioning-attempts";
  const body = {
    idempotencyKey: "stale-window-replacement", taskId: "coordinator-local-next",
    label: "Taskboard Execution Coordinator", threadSource: "stale-window-replacement-source",
    model: "gpt-5", reasoningEffort: "high", expectedRevision: before.body.revision,
    ownerRootTaskId: "owner-root", ownerRootThreadId: "owner-thread",
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
    retireCoordinatorWindows: [staleWindow],
  };
  const wrongBody = {
    ...body, idempotencyKey: "wrong-stale-window",
    retireCoordinatorWindows: [{ ...staleWindow, threadId: "different-thread" }],
  };
  const rejected = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "1".repeat(32), pathname, wrongBody),
    body: wrongBody,
  });
  assert.equal(rejected.response.status, 409);
  const zeroMutation = new DatabaseSync(databasePath);
  assert.equal(zeroMutation.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_provisioning_attempts",
  ).get().count, 0);
  zeroMutation.close();

  const created = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "2".repeat(32), pathname, body),
    body,
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.applied, true);
  const after = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.deepEqual(after.body.windows.map((window) => window.taskId), ["owner-root"]);
  assert.equal(after.body.coordinatorLease.id, "released-lease");
  assert.ok(after.body.coordinatorLease.releasedAt);
  assert.notEqual(after.body.revision, before.body.revision);
  assert.equal(created.body.attempt.expectedRevision, after.body.revision);
  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.body));
  assert.equal(snapshot.body.coordination.assignment, "unassigned");
  assert.equal(snapshot.body.coordination.lease.status, "expired");
  assert.ok(snapshot.body.coordination.lease.releasedAt);
  const activeLookupPath = "/api/local/projects/local/coordinator-provisioning-attempts/lookup";
  const activeLookup = await request(baseUrl, activeLookupPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "4".repeat(32), activeLookupPath, {}),
    body: {},
  });
  assert.equal(activeLookup.response.status, 200, JSON.stringify(activeLookup.body));
  assert.equal(activeLookup.body.attempt.id, created.body.attempt.id);
  const recoveryPath = `/api/local/coordinator-provisioning-attempts/${created.body.attempt.id}/starting`;
  const recovered = await request(baseUrl, recoveryPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "5".repeat(32), recoveryPath, {}),
    body: {},
  });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.attempt.status, "starting");

  const replay = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "3".repeat(32), pathname, body),
    body,
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.applied, false);
  assert.equal(replay.body.attempt.id, created.body.attempt.id);
});

test("protected Coordinator provisioning preflight survives an invalid stale Agent Lane", async () => {
  const instanceSecret = "f".repeat(64);
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "owner-root",
      ownerRootTaskId: "owner-root",
      tasks: [{
        id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        connection: "connected", threadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
        taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      }],
      adapters: [],
      coordinatorLease: {
        id: "released-lease", holderTaskId: "retired-coordinator",
        holderThreadId: "01a062c1-fd2b-7f61-9114-d483e695640e",
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
        acquiredAt: "2026-09-02T22:50:00.000Z", expiresAt: "2026-09-02T22:55:00.000Z",
        releasedAt: "2026-09-02T22:55:00.000Z",
      },
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    database.createTask({
      projectId: "local", title: "Ready replacement work", description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: null, threadBinding: null, actor, assignee: actor,
      developmentContext: null, workingLog: null, startDate: null, dueDate: null,
      recurrence: null,
    });
    database.close();
    return { instanceSecret };
  });

  const invalidDatabase = new TaskboardDatabase(databasePath);
  const validConfig = invalidDatabase.getAgentLaneProject("local");
  invalidDatabase.upsertAgentLaneProject("local", {
    ...validConfig,
    tasks: [...validConfig.tasks, {
      id: "root", label: "Execution Coordinator", source: "codex",
      connection: "connected", threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/sbkk",
    }],
  });
  invalidDatabase.close();

  const brokenSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(brokenSnapshot.response.status, 404);
  const pathname = "/api/local/projects/local/coordinator-provisioning-preflight";
  const unprotected = await request(baseUrl, pathname);
  assert.equal(unprotected.response.status, 403);
  const preflight = await request(baseUrl, pathname, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "8".repeat(32), pathname, null, Date.now(), "GET",
    ),
  });
  assert.equal(preflight.response.status, 200, JSON.stringify(preflight.body));
  assert.equal(preflight.body.projectId, "local");
  assert.equal(preflight.body.ownerRootTaskId, "owner-root");
  assert.equal(preflight.body.ownerRootValid, true);
  assert.equal(preflight.body.durableWorkPending, true);
  assert.equal(preflight.body.coordinatorLease.releasedAt, "2026-09-02T22:55:00.000Z");
  assert.deepEqual(preflight.body.windows.map((window) => window.taskId), ["owner-root", "root"]);

  const malformedOwnerDatabase = new TaskboardDatabase(databasePath);
  const malformedConfig = malformedOwnerDatabase.getAgentLaneProject("local");
  malformedOwnerDatabase.upsertAgentLaneProject("local", {
    ...malformedConfig,
    tasks: malformedConfig.tasks.map((task) => (
      task.id === "owner-root" ? { ...task, owner: "   " } : task
    )),
  });
  malformedOwnerDatabase.close();
  const invalidOwnerPreflight = await request(baseUrl, pathname, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "b".repeat(32), pathname, null, Date.now(), "GET",
    ),
  });
  assert.equal(invalidOwnerPreflight.response.status, 200, JSON.stringify(invalidOwnerPreflight.body));
  assert.equal(invalidOwnerPreflight.body.ownerRootValid, false);
  const rejectedPath = "/api/local/projects/local/coordinator-provisioning-attempts";
  const rejectedBody = {
    idempotencyKey: "invalid-owner-replacement", taskId: "coordinator-local-next",
    label: "Taskboard Execution Coordinator", threadSource: "invalid-owner-source",
    model: "gpt-5", reasoningEffort: "high", expectedRevision: invalidOwnerPreflight.body.revision,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
    retireCoordinatorWindows: [invalidOwnerPreflight.body.windows[1]],
  };
  const rejected = await request(baseUrl, rejectedPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "c".repeat(32), rejectedPath, rejectedBody,
    ),
    body: rejectedBody,
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "COORDINATOR_PROVISIONING_OWNER_ROOT_MISMATCH");
  const repairOwnerDatabase = new TaskboardDatabase(databasePath);
  const repairConfig = repairOwnerDatabase.getAgentLaneProject("local");
  repairOwnerDatabase.upsertAgentLaneProject("local", {
    ...repairConfig,
    tasks: repairConfig.tasks.map((task) => (
      task.id === "owner-root" ? { ...task, owner: "Codex Owner Root" } : task
    )),
  });
  repairOwnerDatabase.close();
  const repairedPreflight = await request(baseUrl, pathname, {
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "d".repeat(32), pathname, null, Date.now(), "GET",
    ),
  });
  assert.equal(repairedPreflight.body.ownerRootValid, true);

  const provisioningPath = "/api/local/projects/local/coordinator-provisioning-attempts";
  const body = {
    idempotencyKey: "invalid-stale-replacement", taskId: "coordinator-local-next",
    label: "Taskboard Execution Coordinator", threadSource: "invalid-stale-replacement-source",
    model: "gpt-5", reasoningEffort: "high", expectedRevision: repairedPreflight.body.revision,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: "01a050de-03c2-7f32-ba9c-4342b40ac18a",
    codexProjectId: "codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/sbkk",
    retireCoordinatorWindows: [repairedPreflight.body.windows[1]],
  };
  const created = await request(baseUrl, provisioningPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "9".repeat(32), provisioningPath, body,
    ),
    body,
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.applied, true);
  const recoveredSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(recoveredSnapshot.response.status, 200, JSON.stringify(recoveredSnapshot.body));
  assert.equal(recoveredSnapshot.body.coordination.assignment, "unassigned");
  const lookupPath = "/api/local/projects/local/coordinator-provisioning-attempts/lookup";
  const lookup = await request(baseUrl, lookupPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "a".repeat(32), lookupPath, {},
    ),
    body: {},
  });
  assert.equal(lookup.response.status, 200, JSON.stringify(lookup.body));
  assert.equal(lookup.body.attempt.id, created.body.attempt.id);
});

test("resident shutdown releases and retires one exact idle Coordinator attempt", async () => {
  let databasePath;
  const instanceSecret = "e".repeat(64);
  const holderThreadId = "01a062c1-fd2b-7f61-9114-d483e695640e";
  const ownerThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  const leaseId = "lease-shutdown-a";
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    const current = Date.now();
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator-a",
      ownerRootTaskId: "owner-root",
      tasks: [
        {
          id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
          connection: "connected", threadId: ownerThreadId, taskType: "root_task",
          codexProjectId: "codex-project", codexProjectKind: "local",
          codexHostId: "local", workspacePath: "/tmp/sbkk",
        },
        {
          id: "coordinator-a", label: "Execution Coordinator", owner: "Codex Global Coordinator",
          source: "codex", connection: "connected", threadId: holderThreadId,
          taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
          codexHostId: "local", workspacePath: "/tmp/sbkk",
        },
      ],
      adapters: [],
      coordinatorLease: {
        id: leaseId, holderTaskId: "coordinator-a", holderThreadId,
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
        acquiredAt: new Date(current - 60_000).toISOString(),
        expiresAt: new Date(current + 300_000).toISOString(),
      },
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    database.createTask({
      projectId: "local", title: "Reviewed work", description: "", status: "in_review",
      priority: "medium", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: null, threadBinding: null, actor, assignee: actor,
      developmentContext: null, workingLog: null, startDate: null, dueDate: null,
      recurrence: null,
    });
    database.close();
    return { instanceSecret };
  });
  const windows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const pathname = "/api/local/projects/local/coordinator-shutdown-attempts";
  const body = {
    idempotencyKey: "coordinator-shutdown-a",
    expectedRevision: windows.body.revision,
    expectedLeaseId: leaseId,
    holderTaskId: "coordinator-a",
    holderThreadId,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: ownerThreadId,
    ownerRootCodexProjectId: "codex-project",
    ownerRootCodexProjectKind: "local",
    ownerRootCodexHostId: "local",
    ownerRootWorkspacePath: "/tmp/sbkk",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/sbkk",
  };
  const created = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "c".repeat(32), pathname, body),
    body,
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.applied, true);
  assert.equal(created.body.attempt.status, "pending");
  const replay = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "d".repeat(32), pathname, body),
    body,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.applied, false);
  assert.equal(replay.body.attempt.id, created.body.attempt.id);
  const conflictBody = { ...body, workspacePath: "/tmp/other" };
  const conflict = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "f".repeat(32), pathname, conflictBody),
    body: conflictBody,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "COORDINATOR_SHUTDOWN_IDEMPOTENCY_CONFLICT");

  const blockedRenew = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "coordinator-a", holderThreadId,
      expectedLeaseId: leaseId, leaseDurationSeconds: 300,
    },
  });
  assert.equal(blockedRenew.response.status, 409);
  assert.equal(blockedRenew.body.error.code, "COORDINATOR_SHUTDOWN_IN_PROGRESS");
  const blockedOrdinaryRelease = await request(
    baseUrl,
    "/api/local/projects/local/coordinator-lease/release",
    {
      method: "POST",
      body: {
        holderTaskId: "coordinator-a", holderThreadId, expectedLeaseId: leaseId,
      },
    },
  );
  assert.equal(blockedOrdinaryRelease.response.status, 409);
  assert.equal(blockedOrdinaryRelease.body.error.code, "COORDINATOR_SHUTDOWN_IN_PROGRESS");

  const blockedProvisioningBody = {
    idempotencyKey: "replacement-during-shutdown",
    taskId: "coordinator-b",
    label: "Taskboard Execution Coordinator",
    threadSource: "taskboard-coordinator-b",
    model: "gpt-5",
    reasoningEffort: "high",
    expectedRevision: windows.body.revision,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: ownerThreadId,
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/sbkk",
  };
  const provisioningPath = "/api/local/projects/local/coordinator-provisioning-attempts";
  const blockedProvisioning = await request(baseUrl, provisioningPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "0".repeat(32), provisioningPath, blockedProvisioningBody,
    ),
    body: blockedProvisioningBody,
  });
  assert.equal(blockedProvisioning.response.status, 409);
  assert.equal(blockedProvisioning.body.error.code, "COORDINATOR_SHUTDOWN_IN_PROGRESS");

  const releasePath = `/api/local/coordinator-shutdown-attempts/${created.body.attempt.id}/release`;
  const released = await request(baseUrl, releasePath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "1".repeat(32), releasePath, {}),
    body: {},
  });
  assert.equal(released.response.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.attempt.status, "released");
  assert.equal(released.body.lease.id, leaseId);
  assert.equal(released.body.receipt.action, "released");
  const repeatedRelease = await request(baseUrl, releasePath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "2".repeat(32), releasePath, {}),
    body: {},
  });
  assert.equal(repeatedRelease.response.status, 200);
  assert.equal(repeatedRelease.body.attempt.status, "released");
  assert.equal(repeatedRelease.body.receipt.id, released.body.receipt.id);

  const completePath = `/api/local/coordinator-shutdown-attempts/${created.body.attempt.id}/complete`;
  const completed = await request(baseUrl, completePath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "3".repeat(32), completePath, {}),
    body: {},
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.attempt.status, "completed");
  const completedReplay = await request(baseUrl, completePath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "4".repeat(32), completePath, {}),
    body: {},
  });
  assert.equal(completedReplay.response.status, 200);
  assert.equal(completedReplay.body.attempt.id, created.body.attempt.id);
  const finalWindows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(finalWindows.body.windows.some((window) => window.taskId === "coordinator-a"), false);
  assert.equal(finalWindows.body.windows.some((window) => window.taskId === "owner-root"), true);
  assert.equal(finalWindows.body.coordinatorLease.id, "lease-shutdown-a");
  assert.ok(finalWindows.body.coordinatorLease.releasedAt);
  const quietProvisioningBody = {
    ...blockedProvisioningBody,
    idempotencyKey: "replacement-without-work",
    expectedRevision: finalWindows.body.revision,
  };
  const quietProvisioning = await request(baseUrl, provisioningPath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(
      instanceSecret, "5".repeat(32), provisioningPath, quietProvisioningBody,
    ),
    body: quietProvisioningBody,
  });
  assert.equal(quietProvisioning.response.status, 409);
  assert.equal(quietProvisioning.body.error.code, "COORDINATOR_PROVISIONING_NO_ELIGIBLE_WORK");
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_shutdown_attempts",
  ).get().count, 1);
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_lease_receipts WHERE lease_id = ? AND action = 'released'",
  ).get(leaseId).count, 1);
  inspection.close();
});

test("resident shutdown cancels without releasing when durable work appears", async () => {
  let databasePath;
  const instanceSecret = "f".repeat(64);
  const holderThreadId = "coordinator-thread";
  const ownerThreadId = "owner-thread";
  const leaseId = "lease-shutdown-work";
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    const current = Date.now();
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator-a",
      ownerRootTaskId: "owner-root",
      tasks: [
        {
          id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
          connection: "connected", threadId: ownerThreadId, taskType: "root_task",
          codexProjectId: "codex-project", codexProjectKind: "local",
          codexHostId: "local", workspacePath: "/tmp/sbkk",
        },
        {
          id: "coordinator-a", label: "Execution Coordinator", owner: "Codex Global Coordinator",
          source: "codex", connection: "connected", threadId: holderThreadId,
          taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
          codexHostId: "local", workspacePath: "/tmp/sbkk",
        },
      ],
      adapters: [],
      coordinatorLease: {
        id: leaseId, holderTaskId: "coordinator-a", holderThreadId,
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
        acquiredAt: new Date(current - 60_000).toISOString(),
        expiresAt: new Date(current + 300_000).toISOString(),
      },
    });
    database.close();
    return { instanceSecret };
  });
  const windows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  const pathname = "/api/local/projects/local/coordinator-shutdown-attempts";
  const body = {
    idempotencyKey: "coordinator-shutdown-work",
    expectedRevision: windows.body.revision,
    expectedLeaseId: leaseId,
    holderTaskId: "coordinator-a",
    holderThreadId,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: ownerThreadId,
    ownerRootCodexProjectId: "codex-project",
    ownerRootCodexProjectKind: "local",
    ownerRootCodexHostId: "local",
    ownerRootWorkspacePath: "/tmp/sbkk",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/sbkk",
  };
  const created = await request(baseUrl, pathname, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "6".repeat(32), pathname, body),
    body,
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));

  const database = new TaskboardDatabase(databasePath);
  const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  database.createTask({
    projectId: "local", title: "New eligible work", description: "", status: "todo",
    priority: "medium", labels: ["agent-todo"], workflowProfile: "vibe",
    threadId: null, threadBinding: null, actor, assignee: actor,
    developmentContext: null, workingLog: null, startDate: null, dueDate: null,
    recurrence: null,
  });
  database.close();

  const releasePath = `/api/local/coordinator-shutdown-attempts/${created.body.attempt.id}/release`;
  const rejected = await request(baseUrl, releasePath, {
    method: "POST",
    headers: signedCoordinatorRenewHeaders(instanceSecret, "7".repeat(32), releasePath, {}),
    body: {},
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "COORDINATOR_SHUTDOWN_RELEASE_CONFLICT");

  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare(
    "SELECT status FROM agent_coordinator_shutdown_attempts WHERE id = ?",
  ).get(created.body.attempt.id).status, "canceled");
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_lease_receipts WHERE lease_id = ? AND action = 'released'",
  ).get(leaseId).count, 0);
  const config = JSON.parse(inspection.prepare(
    "SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'",
  ).get().config_json);
  assert.equal(config.coordinatorLease.id, leaseId);
  assert.equal(config.coordinatorLease.releasedAt ?? null, null);
  assert.equal(config.tasks.some((window) => window.id === "coordinator-a"), true);
  inspection.close();
});

test("resident shutdown cancels before release for every Owner Root host binding drift", async (t) => {
  const ownerThreadId = "owner-thread";
  const holderThreadId = "coordinator-thread";
  for (const [field, driftedValue] of [
    ["codexProjectId", "other-project"],
    ["codexProjectKind", "remote"],
    ["codexHostId", "other-host"],
    ["workspacePath", "/tmp/other-workspace"],
  ]) {
    await t.test(field, async () => {
      let databasePath;
      const instanceSecret = "9".repeat(64);
      const leaseId = `lease-owner-drift-${field}`;
      const baseUrl = await startServer(async (directory) => {
        databasePath = path.join(directory, "taskboard.sqlite");
        const database = new TaskboardDatabase(databasePath);
        const current = Date.now();
        database.upsertAgentLaneProject("local", {
          rootTaskId: "coordinator-a",
          ownerRootTaskId: "owner-root",
          tasks: [
            {
              id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
              connection: "connected", threadId: ownerThreadId, taskType: "root_task",
              codexProjectId: "codex-project", codexProjectKind: "local",
              codexHostId: "local", workspacePath: "/tmp/sbkk",
            },
            {
              id: "coordinator-a", label: "Execution Coordinator", owner: "Codex Global Coordinator",
              source: "codex", connection: "connected", threadId: holderThreadId,
              taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
              codexHostId: "local", workspacePath: "/tmp/sbkk",
            },
          ],
          adapters: [],
          coordinatorLease: {
            id: leaseId, holderTaskId: "coordinator-a", holderThreadId,
            holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
            acquiredAt: new Date(current - 60_000).toISOString(),
            expiresAt: new Date(current + 300_000).toISOString(),
          },
        });
        database.close();
        return { instanceSecret };
      });
      const windows = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
        headers: { "x-taskboard-client": "taskctl" },
      });
      const pathname = "/api/local/projects/local/coordinator-shutdown-attempts";
      const body = {
        idempotencyKey: `shutdown-owner-drift-${field}`,
        expectedRevision: windows.body.revision,
        expectedLeaseId: leaseId,
        holderTaskId: "coordinator-a",
        holderThreadId,
        ownerRootTaskId: "owner-root",
        ownerRootThreadId: ownerThreadId,
        ownerRootCodexProjectId: "codex-project",
        ownerRootCodexProjectKind: "local",
        ownerRootCodexHostId: "local",
        ownerRootWorkspacePath: "/tmp/sbkk",
        codexProjectId: "codex-project",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "/tmp/sbkk",
      };
      const created = await request(baseUrl, pathname, {
        method: "POST",
        headers: signedCoordinatorRenewHeaders(instanceSecret, "1".repeat(32), pathname, body),
        body,
      });
      assert.equal(created.response.status, 200, JSON.stringify(created.body));

      const drift = new DatabaseSync(databasePath);
      const row = drift.prepare(
        "SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'",
      ).get();
      const config = JSON.parse(row.config_json);
      config.tasks = config.tasks.map((window) => window.id === "owner-root"
        ? { ...window, [field]: driftedValue }
        : window);
      drift.prepare(
        "UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = 'local'",
      ).run(JSON.stringify(config), new Date().toISOString());
      drift.close();

      const releasePath = `/api/local/coordinator-shutdown-attempts/${created.body.attempt.id}/release`;
      const rejected = await request(baseUrl, releasePath, {
        method: "POST",
        headers: signedCoordinatorRenewHeaders(instanceSecret, "2".repeat(32), releasePath, {}),
        body: {},
      });
      assert.equal(rejected.response.status, 409);
      assert.equal(rejected.body.error.code, "COORDINATOR_SHUTDOWN_BINDING_MISMATCH");
      const inspection = new DatabaseSync(databasePath);
      assert.equal(inspection.prepare(
        "SELECT status FROM agent_coordinator_shutdown_attempts WHERE id = ?",
      ).get(created.body.attempt.id).status, "canceled");
      assert.equal(inspection.prepare(
        "SELECT COUNT(*) AS count FROM agent_coordinator_lease_receipts WHERE lease_id = ? AND action = 'released'",
      ).get(leaseId).count, 0);
      inspection.close();
    });
  }
});

test("resident shutdown fences domain writes and cancels on coordination revision drift", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-shutdown-revision-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const holderThreadId = "coordinator-thread";
  const ownerThreadId = "owner-thread";
  const leaseId = "lease-shutdown-revision";
  const database = new TaskboardDatabase(databasePath);
  const current = Date.now();
  database.upsertAgentLaneProject("local", {
    rootTaskId: "coordinator-a",
    ownerRootTaskId: "owner-root",
    tasks: [
      {
        id: "owner-root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        connection: "connected", threadId: ownerThreadId, taskType: "root_task",
        codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      },
      {
        id: "coordinator-a", label: "Execution Coordinator", owner: "Codex Global Coordinator",
        source: "codex", connection: "connected", threadId: holderThreadId,
        taskType: "root_task", codexProjectId: "codex-project", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/tmp/sbkk",
      },
    ],
    adapters: [],
    coordinatorLease: {
      id: leaseId, holderTaskId: "coordinator-a", holderThreadId,
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/sbkk",
      acquiredAt: new Date(current - 60_000).toISOString(),
      expiresAt: new Date(current + 300_000).toISOString(),
    },
  });
  const expectedRevision = database.getAgentLaneCoordinationWindows("local").revision;
  const created = database.requestAgentLaneCoordinatorShutdownAttempt("local", {
    idempotencyKey: "shutdown-revision-drift",
    expectedRevision,
    expectedLeaseId: leaseId,
    holderTaskId: "coordinator-a",
    holderThreadId,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: ownerThreadId,
    ownerRootCodexProjectId: "codex-project",
    ownerRootCodexProjectKind: "local",
    ownerRootCodexHostId: "local",
    ownerRootWorkspacePath: "/tmp/sbkk",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/sbkk",
  });
  assert.throws(
    () => database.configureAgentLaneCoordinationDomain("local", "review", {
      domain: { label: "Review", writeScope: ["review"], eligibleTaskIds: ["coordinator-a"] },
      expectedRevision,
      idempotencyKey: "domain-during-shutdown",
      holderTaskId: "coordinator-a",
      holderThreadId,
      expectedCoordinatorLeaseId: leaseId,
    }),
    (error) => error?.status === 409 && error?.code === "COORDINATOR_SHUTDOWN_IN_PROGRESS",
  );
  database.close();

  const drift = new DatabaseSync(databasePath);
  const row = drift.prepare(
    "SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'",
  ).get();
  const config = JSON.parse(row.config_json);
  config.coordinationDomains = [{
    id: "bypass", label: "Bypass", writeScope: ["bypass"], eligibleTaskIds: ["coordinator-a"],
  }];
  drift.prepare(
    "UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = 'local'",
  ).run(JSON.stringify(config), new Date().toISOString());
  drift.close();

  const reopened = new TaskboardDatabase(databasePath);
  assert.throws(
    () => reopened.transitionAgentLaneCoordinatorShutdownAttempt(created.attempt.id, "release"),
    (error) => error?.status === 409 && error?.code === "COORDINATOR_SHUTDOWN_RELEASE_CONFLICT",
  );
  reopened.close();
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare(
    "SELECT status FROM agent_coordinator_shutdown_attempts WHERE id = ?",
  ).get(created.attempt.id).status, "canceled");
  assert.equal(inspection.prepare(
    "SELECT COUNT(*) AS count FROM agent_coordinator_lease_receipts WHERE lease_id = ? AND action = 'released'",
  ).get(leaseId).count, 0);
  const finalConfig = JSON.parse(inspection.prepare(
    "SELECT config_json FROM agent_lane_projects WHERE project_id = 'local'",
  ).get().config_json);
  assert.equal(finalConfig.coordinatorLease.id, leaseId);
  assert.equal(finalConfig.coordinatorLease.releasedAt ?? null, null);
  inspection.close();
});

test("protected window registration separates Owner Root from a replaceable coordinator", async () => {
  let databasePath;
  const instanceSecret = "a".repeat(64);
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "legacy-root",
      tasks: [
        {
          id: "legacy-root", label: "Legacy Root", owner: "Codex Root", source: "codex",
          threadId: "legacy-thread", taskType: "root_task",
        },
      ],
      adapters: [
        {
          id: "adapter-only", label: "External adapter", owner: "External",
          source: "external", connection: "not_connected",
        },
      ],
    });
    database.close();
    return { instanceSecret };
  });

  const initial = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.ownerRootTaskId, null);
  assert.match(initial.body.revision, /^[a-f0-9]{64}$/);

  const ownerRegistration = {
    role: "owner_root",
    taskId: "owner-root",
    label: "Owner conversation",
    threadId: "owner-thread",
    expectedRevision: initial.body.revision,
    idempotencyKey: "owner-root-window-1",
  };
  const unprotected = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", body: ownerRegistration,
  });
  assert.equal(unprotected.response.status, 403);
  assert.equal(unprotected.body.error.code, "TASKCTL_REQUIRED");

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "a".repeat(32)),
    body: {
      threadId: "owner-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "host-owner", workspacePath: "/tmp/owner-root",
    },
  });
  const owner = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: ownerRegistration,
  });
  assert.equal(owner.response.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.applied, true);
  assert.equal(owner.body.configuration.ownerRootTaskId, "owner-root");
  assert.notEqual(owner.body.configuration.revision, initial.body.revision);
  assert.deepEqual(owner.body.configuration.windows.find((window) => window.taskId === "owner-root"), {
    taskId: "owner-root", label: "Owner conversation", role: "owner_root",
    threadId: "owner-thread", codexHostId: "host-owner",
    codexProjectId: "codex-project", codexProjectKind: "local",
    workspacePath: "/tmp/owner-root",
  });

  const replay = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: ownerRegistration,
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.applied, false);
  assert.equal(replay.body.receipt.id, owner.body.receipt.id);
  assert.equal(replay.body.configuration.revision, owner.body.configuration.revision);

  const conflictingReplay = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: { ...ownerRegistration, label: "Different payload" },
  });
  assert.equal(conflictingReplay.response.status, 409);
  assert.equal(conflictingReplay.body.error.code, "COORDINATION_WINDOW_IDEMPOTENCY_CONFLICT");
  const afterConflict = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(afterConflict.body.revision, owner.body.configuration.revision);

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "b".repeat(32)),
    body: {
      threadId: "coordinator-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "host-coordinator", workspacePath: "/tmp/coordinator",
    },
  });
  const coordinator = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "coordinator", taskId: "global-coordinator", label: "Global Coordinator",
      threadId: "coordinator-thread", expectedRevision: owner.body.configuration.revision,
      idempotencyKey: "global-coordinator-window-1",
    },
  });
  assert.equal(coordinator.response.status, 200, JSON.stringify(coordinator.body));
  assert.equal(coordinator.body.configuration.ownerRootTaskId, "owner-root");
  assert.equal(coordinator.body.configuration.coordinatorLease, null);

  const lease = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "global-coordinator", holderThreadId: "coordinator-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(lease.response.status, 200, JSON.stringify(lease.body));
  assert.equal(lease.body.lease.holderTaskId, "global-coordinator");

  const beforeGlobalBindingConflict = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    { headers: { "x-taskboard-client": "taskctl" } },
  );
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "f".repeat(32)),
    body: {
      threadId: "coordinator-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "host-coordinator-new", workspacePath: "/tmp/coordinator-new",
    },
  });
  const globalBindingConflict = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    {
      method: "POST", headers: { "x-taskboard-client": "taskctl" },
      body: {
        role: "coordinator", taskId: "global-coordinator", label: "Global Coordinator",
        threadId: "coordinator-thread", expectedRevision: beforeGlobalBindingConflict.body.revision,
        idempotencyKey: "global-binding-conflict-1",
      },
    },
  );
  assert.equal(globalBindingConflict.response.status, 409);
  assert.equal(globalBindingConflict.body.error.code, "COORDINATOR_LEASE_ACTIVE");
  const afterGlobalBindingConflict = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    { headers: { "x-taskboard-client": "taskctl" } },
  );
  assert.equal(afterGlobalBindingConflict.body.revision, beforeGlobalBindingConflict.body.revision);

  const beforeAdapterConflict = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    { headers: { "x-taskboard-client": "taskctl" } },
  );
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "e".repeat(32)),
    body: {
      threadId: "adapter-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "host-adapter", workspacePath: "/tmp/adapter-window",
    },
  });
  const adapterConflict = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "coordinator", taskId: "adapter-only", label: "Invalid collision",
      threadId: "adapter-thread", expectedRevision: beforeAdapterConflict.body.revision,
      idempotencyKey: "adapter-collision-1",
    },
  });
  assert.equal(adapterConflict.response.status, 409);
  assert.equal(adapterConflict.body.error.code, "COORDINATION_WINDOW_TASK_CONFLICT");
  const afterAdapterConflict = await request(
    baseUrl,
    "/api/local/projects/local/coordination-windows",
    { headers: { "x-taskboard-client": "taskctl" } },
  );
  assert.equal(afterAdapterConflict.body.revision, beforeAdapterConflict.body.revision);
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM agent_coordination_window_receipts").get().count, 2);
  inspection.close();
});

test("window registration cannot activate a legacy Global lease as the Owner Root", async () => {
  let databasePath;
  const instanceSecret = "c".repeat(64);
  const acquiredAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "legacy-holder",
      tasks: [
        {
          id: "legacy-holder", label: "Legacy holder", owner: "Codex", source: "codex",
          threadId: "legacy-holder-thread", taskType: "root_task",
        },
      ],
      adapters: [],
      coordinatorLease: {
        id: "legacy-lease", holderTaskId: "legacy-holder",
        holderThreadId: "legacy-holder-thread", holderCodexHostId: "legacy-host",
        holderWorkspacePath: "/tmp/legacy-holder", acquiredAt, expiresAt,
      },
    });
    database.close();
    return { instanceSecret };
  });
  const before = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "c".repeat(32)),
    body: {
      threadId: "legacy-holder-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "remote",
      codexHostId: "legacy-host", workspacePath: "/tmp/legacy-holder",
    },
  });
  const rejected = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "owner_root", taskId: "legacy-holder", label: "Owner conversation",
      threadId: "legacy-holder-thread", expectedRevision: before.body.revision,
      idempotencyKey: "legacy-owner-conflict-1",
    },
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "OWNER_ROOT_COORDINATOR_CONFLICT");
  const after = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(after.body.revision, before.body.revision);
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM agent_coordination_window_receipts").get().count, 0);
  inspection.close();
});

test("window registration cannot reserve a future Global lease holder as the Owner Root", async () => {
  let databasePath;
  const instanceSecret = "1".repeat(64);
  const acquiredAt = new Date(Date.now() + 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "future-holder",
      tasks: [
        {
          id: "future-holder", label: "Future holder", owner: "Codex", source: "codex",
          threadId: "future-thread", taskType: "root_task",
          codexHostId: "future-host", workspacePath: "/tmp/future-holder",
        },
      ],
      adapters: [],
      coordinatorLease: {
        id: "future-lease", holderTaskId: "future-holder", holderThreadId: "future-thread",
        holderCodexHostId: "future-host", holderWorkspacePath: "/tmp/future-holder",
        acquiredAt, expiresAt,
      },
    });
    database.close();
    return { instanceSecret };
  });
  const before = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "1".repeat(32)),
    body: {
      threadId: "future-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "remote",
      codexHostId: "future-host", workspacePath: "/tmp/future-holder",
    },
  });
  const rejected = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "owner_root", taskId: "future-holder", label: "Owner conversation",
      threadId: "future-thread", expectedRevision: before.body.revision,
      idempotencyKey: "future-owner-conflict-1",
    },
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "OWNER_ROOT_COORDINATOR_CONFLICT");
  const after = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(after.body.revision, before.body.revision);
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM agent_coordination_window_receipts").get().count, 0);
  inspection.close();
});

test("window registration preserves an active domain coordinator binding", async () => {
  let databasePath;
  const instanceSecret = "d".repeat(64);
  const acquiredAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        {
          id: "root", label: "Root", owner: "Codex", source: "codex",
          threadId: "root-thread", taskType: "root_task",
        },
        {
          id: "domain-root", label: "Domain Root", owner: "Codex", source: "codex",
          threadId: "domain-thread", taskType: "peer_task",
          codexHostId: "domain-host", workspacePath: "/tmp/domain-old",
        },
      ],
      adapters: [],
      coordinationDomains: [
        { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["domain-root"] },
      ],
      domainCoordinatorLeases: {
        backend: {
          id: "domain-lease", holderTaskId: "domain-root", holderThreadId: "domain-thread",
          holderCodexHostId: "domain-host", holderWorkspacePath: "/tmp/domain-old",
          acquiredAt, expiresAt,
        },
      },
    });
    database.close();
    return { instanceSecret };
  });
  const before = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT", headers: signedInjectorHeaders(instanceSecret, "d".repeat(32)),
    body: {
      threadId: "domain-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "remote",
      codexHostId: "domain-new-host", workspacePath: "/tmp/domain-new",
    },
  });
  const rejected = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    method: "POST", headers: { "x-taskboard-client": "taskctl" },
    body: {
      role: "coordinator", taskId: "domain-root", label: "Domain Root",
      threadId: "domain-thread", expectedRevision: before.body.revision,
      idempotencyKey: "domain-binding-conflict-1",
    },
  });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "COORDINATION_WINDOW_TASK_CONFLICT");
  const after = await request(baseUrl, "/api/local/projects/local/coordination-windows", {
    headers: { "x-taskboard-client": "taskctl" },
  });
  assert.equal(after.body.revision, before.body.revision);
  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM agent_coordination_window_receipts").get().count, 0);
  inspection.close();
});

test("active coordinator repairs one legacy Root binding from protected host identity", async () => {
  let legacyTask;
  const instanceSecret = "b".repeat(64);
  const repairActor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/replacement-root" },
      ],
      adapters: [],
    });
    legacyTask = database.createTask({
      projectId: "local", title: "Legacy recovery target", description: "preserve me", status: "todo",
      priority: "high", labels: ["agent-todo"], threadId: "legacy-thread", actor: repairActor,
      assignee: repairActor, workflowId: null, developmentContext: null, startDate: null,
      dueDate: null, recurrence: null,
    });
    database.close();
    return { instanceSecret };
  });

  const lease = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: null, leaseDurationSeconds: 60,
    },
  });
  assert.equal(lease.response.status, 200);

  const forgedHost = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    body: {
      threadId: "root-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/replacement-root",
    },
  });
  assert.equal(forgedHost.response.status, 403);
  assert.equal(forgedHost.body.error.code, "INJECTOR_PROOF_REQUIRED");
  const afterForgedHost = await request(baseUrl, `/api/tasks/${legacyTask.identifier}`);
  const activitiesAfterForgedHost = await request(baseUrl, `/api/tasks/${legacyTask.identifier}/activities`);
  assert.equal(afterForgedHost.body.task.threadBinding, null);
  assert.equal(afterForgedHost.body.task.version, legacyTask.version);
  assert.deepEqual(activitiesAfterForgedHost.body.activities, []);

  const host = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "1".repeat(32)),
    body: {
      threadId: "root-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/replacement-root",
    },
  });
  assert.equal(host.response.status, 200);

  const wrongHostThread = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "2".repeat(32)),
    body: {
      threadId: "other-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/replacement-root",
    },
  });
  assert.equal(wrongHostThread.response.status, 200);
  const wrongHostRepair = await request(baseUrl, "/api/local/projects/local/coordinator-lease/repair-binding", {
    method: "POST",
    body: {
      taskId: legacyTask.identifier, taskVersion: legacyTask.version,
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: lease.body.lease.id,
    },
  });
  assert.equal(wrongHostRepair.response.status, 409);
  assert.equal(wrongHostRepair.body.error.code, "HOST_IDENTITY_UNAVAILABLE");

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "3".repeat(32)),
    body: {
      threadId: "root-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/replacement-root",
    },
  });

  const staleLease = await request(baseUrl, "/api/local/projects/local/coordinator-lease/repair-binding", {
    method: "POST",
    body: {
      taskId: legacyTask.identifier, taskVersion: legacyTask.version,
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: "stale-lease",
    },
  });
  assert.equal(staleLease.response.status, 409);
  assert.equal(staleLease.body.error.code, "COORDINATOR_LEASE_CONFLICT");
  const afterStaleLease = await request(baseUrl, `/api/tasks/${legacyTask.identifier}`);
  assert.equal(afterStaleLease.body.task.threadBinding, null);
  assert.equal(afterStaleLease.body.task.version, legacyTask.version);

  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "4".repeat(32)),
    body: {
      threadId: "root-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "drifted-host", workspacePath: "/tmp/drifted-repair-root",
    },
  });
  const driftedHostRepair = await request(baseUrl, "/api/local/projects/local/coordinator-lease/repair-binding", {
    method: "POST",
    body: {
      taskId: legacyTask.identifier, taskVersion: legacyTask.version,
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: lease.body.lease.id,
    },
  });
  assert.equal(driftedHostRepair.response.status, 409);
  assert.equal(driftedHostRepair.body.error.code, "COORDINATOR_BINDING_MISMATCH");
  const afterDriftedHost = await request(baseUrl, `/api/tasks/${legacyTask.identifier}`);
  const activitiesAfterDriftedHost = await request(baseUrl, `/api/tasks/${legacyTask.identifier}/activities`);
  assert.equal(afterDriftedHost.body.task.threadBinding, null);
  assert.equal(afterDriftedHost.body.task.version, legacyTask.version);
  assert.deepEqual(activitiesAfterDriftedHost.body.activities, []);
  await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "5".repeat(32)),
    body: {
      threadId: "root-thread", threadRunning: true, threadTodoProgress: null,
      codexProjectId: "codex-project", codexProjectKind: "local",
      codexHostId: "local", workspacePath: "/tmp/replacement-root",
    },
  });

  const repaired = await request(baseUrl, "/api/local/projects/local/coordinator-lease/repair-binding", {
    method: "POST",
    body: {
      taskId: legacyTask.identifier, taskVersion: legacyTask.version,
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: lease.body.lease.id,
    },
  });
  assert.equal(repaired.response.status, 200);
  assert.equal(repaired.body.task.description, "preserve me");
  assert.equal(repaired.body.task.legacyLocalThreadId, null);
  assert.deepEqual(repaired.body.task.threadBinding, {
    threadId: "root-thread",
    codexProjectId: "codex-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/replacement-root",
  });
  assert.equal(repaired.body.receipt.taskId, legacyTask.id);
  assert.equal(repaired.body.receipt.leaseId, lease.body.lease.id);
  const activities = await request(baseUrl, `/api/tasks/${legacyTask.identifier}/activities`);
  const repairActivity = activities.body.activities.find(
    (activity) => activity.id === repaired.body.receipt.id,
  );
  assert.ok(repairActivity);
  assert.deepEqual(
    repairActivity.changes.find((change) => change.field === "coordinatorLeaseId"),
    { field: "coordinatorLeaseId", before: null, after: lease.body.lease.id },
  );

  const capsule = await request(baseUrl, `/api/tasks/${legacyTask.identifier}/capsule`);
  assert.equal(capsule.response.status, 200);
  assert.doesNotMatch(capsule.body.capsule.readyWork.reasonCodes.join(","), /LEGACY_THREAD_BINDING_ONLY/);

  const repeated = await request(baseUrl, "/api/local/projects/local/coordinator-lease/repair-binding", {
    method: "POST",
    body: {
      taskId: legacyTask.identifier, taskVersion: repaired.body.task.version,
      holderTaskId: "root", holderThreadId: "root-thread",
      expectedLeaseId: lease.body.lease.id,
    },
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, "ROOT_BINDING_ALREADY_DURABLE");

  const unchanged = await request(baseUrl, `/api/tasks/${legacyTask.identifier}`);
  assert.deepEqual(unchanged.body.task.threadBinding, repaired.body.task.threadBinding);
  assert.equal(unchanged.body.task.version, repaired.body.task.version);
});

test("Talking Window inbox delivery is durable and idempotent without interrupting active execution", async () => {
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/inbox-delivery-worktree" },
      ],
      adapters: [],
    });
    database.close();
    return {};
  });
  const rootBinding = {
    threadId: "root-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/inbox-delivery-worktree",
  };
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "local",
      title: "Project Talking Window",
      description: "Receive Owner input while execution continues.",
      status: "todo",
      priority: "high",
      labels: ["project-inbox"],
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/inbox-delivery",
      },
      workingLog: {
        path: `${rootBinding.workspacePath}/WORKING-LOG.md`,
        status: "active",
      },
    },
  });
  assert.equal(created.response.status, 201);

  const claimed = await request(baseUrl, `/api/tasks/${created.body.task.id}/claim`, {
    method: "POST",
    body: {
      version: created.body.task.version,
      agentPath: "/root/worker",
      agentThreadId: "worker-thread",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      writeScope: ["server/app.mjs"],
    },
  });
  assert.equal(claimed.response.status, 200);
  const coordinator = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "root",
      holderThreadId: "root-thread",
      expectedLeaseId: null,
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(coordinator.response.status, 200);
  const taskBefore = claimed.body.task;
  const runBefore = claimed.body.run;

  const deliveryBody = {
    deliveryId: "owner-message-1",
    body: "新想法已收到；当前执行不要停止。",
    threadId: "talking-window-thread",
  };
  const first = await request(baseUrl, `/api/tasks/${created.body.task.id}/inbox-deliveries`, {
    method: "POST",
    body: deliveryBody,
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.applied, true);
  assert.equal(first.body.receipt.status, "queued");
  assert.equal(first.body.receipt.executionDisposition, "current_execution_continues");
  assert.equal(first.body.receipt.sourceThreadId, "talking-window-thread");
  assert.equal(first.body.comment.body, deliveryBody.body);

  const duplicate = await request(baseUrl, `/api/tasks/${created.body.task.id}/inbox-deliveries`, {
    method: "POST",
    body: deliveryBody,
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.applied, false);
  assert.deepEqual(duplicate.body.receipt, first.body.receipt);
  assert.deepEqual(duplicate.body.comment, first.body.comment);

  const conflictingDuplicate = await request(
    baseUrl,
    `/api/tasks/${created.body.task.id}/inbox-deliveries`,
    {
      method: "POST",
      body: { ...deliveryBody, body: "同一 id 下的不同 Owner 消息不得被静默丢弃。" },
    },
  );
  assert.equal(conflictingDuplicate.response.status, 409);
  assert.equal(conflictingDuplicate.body.error.code, "IDEMPOTENCY_CONFLICT");

  const conflictingSourceThread = await request(
    baseUrl,
    `/api/tasks/${created.body.task.id}/inbox-deliveries`,
    {
      method: "POST",
      body: { ...deliveryBody, threadId: "different-talking-window" },
    },
  );
  assert.equal(conflictingSourceThread.response.status, 409);
  assert.equal(conflictingSourceThread.body.error.code, "IDEMPOTENCY_CONFLICT");

  const conflictingBinding = await request(
    baseUrl,
    `/api/tasks/${created.body.task.id}/inbox-deliveries`,
    {
      method: "POST",
      body: {
        ...deliveryBody,
        threadBinding: {
          threadId: deliveryBody.threadId,
          codexProjectId: "different-project",
          codexProjectKind: "local",
          codexHostId: "local",
          workspacePath: "/tmp/different-workspace",
        },
      },
    },
  );
  assert.equal(conflictingBinding.response.status, 409);
  assert.equal(conflictingBinding.body.error.code, "IDEMPOTENCY_CONFLICT");

  const conflictingActor = await request(
    baseUrl,
    `/api/tasks/${created.body.task.id}/inbox-deliveries`,
    {
      method: "POST",
      headers: {
        "x-taskboard-user-id": "different-owner",
        "x-taskboard-user-name": encodeURIComponent("其他 Owner"),
      },
      body: deliveryBody,
    },
  );
  assert.equal(conflictingActor.response.status, 409);
  assert.equal(conflictingActor.body.error.code, "IDEMPOTENCY_CONFLICT");

  const taskAfter = await request(baseUrl, `/api/tasks/${created.body.task.id}`);
  const capsuleAfter = await request(baseUrl, `/api/tasks/${created.body.task.id}/capsule`);
  const runAfter = await request(baseUrl, `/api/runs/${runBefore.id}`);
  const lanesAfter = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(taskAfter.response.status, 200);
  assert.equal(capsuleAfter.response.status, 200);
  assert.equal(taskAfter.body.task.status, taskBefore.status);
  assert.equal(taskAfter.body.task.version, taskBefore.version);
  assert.deepEqual(runAfter.body.run, runBefore);
  assert.equal(capsuleAfter.body.capsule.inbox.pendingCount, 1);
  assert.deepEqual(capsuleAfter.body.capsule.inbox.latestReceipt, first.body.receipt);
  assert.equal(lanesAfter.body.coordination.coordinatorTaskId, "root");
  assert.equal(lanesAfter.body.coordination.lease.id, coordinator.body.lease.id);
  const talkingWindowTodo = lanesAfter.body.todos.find((todo) => todo.id === created.body.task.identifier);
  assert.equal(talkingWindowTodo.inbox.pendingCount, 1);
  assert.deepEqual(talkingWindowTodo.inbox.latestReceipt, first.body.receipt);
  assert.equal(talkingWindowTodo.run.id, runBefore.id);

  const receipts = await request(baseUrl, `/api/tasks/${created.body.task.id}/inbox-deliveries`);
  const comments = await request(baseUrl, `/api/tasks/${created.body.task.id}/comments`);
  assert.equal(receipts.response.status, 200);
  assert.deepEqual(receipts.body.receipts, [first.body.receipt]);
  assert.equal(comments.body.comments.length, 1);
  assert.equal(comments.body.comments[0].id, first.body.comment.id);
});

test("Owner Intent ingest is host-bound, idempotent, and cannot widen task authority", async () => {
  const instanceSecret = "7".repeat(64);
  const ownerThreadId = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  let taskIdentifier;
  let databasePath;
  const baseUrl = await startServer(async (directory) => {
    databasePath = path.join(directory, "taskboard.sqlite");
    const database = new TaskboardDatabase(databasePath);
    database.upsertAgentLaneProject("local", {
      rootTaskId: "coordinator",
      ownerRootTaskId: "owner-root",
      tasks: [
        {
          id: "owner-root", label: "Owner Root", owner: "Codex Root", source: "codex",
          threadId: ownerThreadId, taskType: "root_task", codexHostId: "local",
          workspacePath: "/tmp/owner-root-workspace",
        },
        {
          id: "coordinator", label: "Coordinator", owner: "Codex Root", source: "codex",
          threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", taskType: "root_task",
          codexHostId: "local", workspacePath: "/tmp/coordinator-workspace",
        },
      ],
      adapters: [],
    });
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const task = database.createTask({
      projectId: "local", title: "Existing bounded work", description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], workflowProfile: "vibe",
      threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", actor, assignee: actor,
      developmentContext: null, workingLog: null, startDate: null, dueDate: null, recurrence: null,
    });
    taskIdentifier = task.identifier;
    database.close();
    return { instanceSecret };
  });

  const hostBinding = {
    threadId: ownerThreadId,
    codexProjectId: "owner-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/owner-root-workspace",
  };
  const host = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "8".repeat(32)),
    body: {
      ...hostBinding,
      threadRunning: false,
      threadTodoProgress: null,
    },
  });
  assert.equal(host.response.status, 200);

  const capsuleBefore = await request(baseUrl, `/api/tasks/${taskIdentifier}/capsule`);
  const legacyInbox = await request(baseUrl, `/api/tasks/${taskIdentifier}/inbox-deliveries`, {
    method: "POST",
    body: {
      deliveryId: "legacy-inbox-before-intent",
      body: "Existing inbox receipt must remain unchanged.",
      threadId: ownerThreadId,
      threadBinding: hostBinding,
    },
  });
  assert.equal(legacyInbox.response.status, 201);

  const fullOwnerGoal = `Keep one Owner-facing Root and let the coordinator derive the Todo. ${"goal-boundary ".repeat(40)}`.trim();
  const fullOwnerConstraint = `Do not grant commit, push, financial, or product-scope authority. ${"constraint-boundary ".repeat(20)}`.trim();
  const intentBody = {
    intentId: "owner-intent-1",
    deliveryId: "owner-intent-delivery-1",
    kind: "append",
    goal: fullOwnerGoal,
    constraints: [fullOwnerConstraint],
    targetIntentId: null,
    ownerRootTaskId: "owner-root",
    ownerRootThreadId: ownerThreadId,
    ownerTurnId: "owner-turn-1",
    rootCaptureTurnId: "root-capture-turn-1",
    evidence: "Observed exact Owner turn followed by the Root capture marker.",
  };
  const unsigned = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    body: intentBody,
  });
  assert.equal(unsigned.response.status, 403);
  assert.equal(unsigned.body.error.code, "INJECTOR_PROOF_REQUIRED");

  const shiftedHost = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "01".repeat(32)),
    body: {
      ...hostBinding,
      codexHostId: "replacement-host",
      workspacePath: "/tmp/replaced-owner-root-workspace",
      threadRunning: false,
      threadTodoProgress: null,
    },
  });
  assert.equal(shiftedHost.response.status, 200);
  const staleBinding = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "02".repeat(32)),
    body: intentBody,
  });
  assert.equal(staleBinding.response.status, 409);
  assert.equal(staleBinding.body.error.code, "OWNER_ROOT_ROUTE_STALE");
  const emptyAfterStale = await request(baseUrl, "/api/local/projects/local/owner-intents");
  assert.deepEqual(emptyAfterStale.body.intents, []);
  const restoredHost = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "03".repeat(32)),
    body: { ...hostBinding, threadRunning: false, threadTodoProgress: null },
  });
  assert.equal(restoredHost.response.status, 200);

  const first = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "9".repeat(32)),
    body: intentBody,
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.applied, true);
  assert.equal(first.body.intent.status, "queued");
  assert.equal(first.body.intent.executionDisposition, "current_execution_continues");
  assert.deepEqual(first.body.intent.sourceThreadBinding, hostBinding);

  const duplicate = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "a".repeat(32)),
    body: intentBody,
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.applied, false);
  assert.deepEqual(duplicate.body.intent, first.body.intent);

  const conflict = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "b".repeat(32)),
    body: { ...intentBody, goal: "A different outcome must not be silently dropped." },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

  const listed = await request(baseUrl, "/api/local/projects/local/owner-intents");
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.intents, [first.body.intent]);
  const capsuleAfter = await request(baseUrl, `/api/tasks/${taskIdentifier}/capsule`);
  assert.deepEqual(capsuleAfter.body.capsule.authorization, capsuleBefore.body.capsule.authorization);
  assert.deepEqual(capsuleAfter.body.capsule.readyWork, capsuleBefore.body.capsule.readyWork);
  const inboxAfter = await request(baseUrl, `/api/tasks/${taskIdentifier}/inbox-deliveries`);
  assert.deepEqual(inboxAfter.body.receipts, [legacyInbox.body.receipt]);

  const snapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.body));
  assert.equal(snapshot.body.coordination.ownerRootTaskId, "owner-root");
  assert.equal(snapshot.body.coordination.coordinatorTaskId, "coordinator");
  assert.deepEqual(snapshot.body.coordination.ownerRootRoute, {
    rootTaskId: "owner-root",
    rootThreadId: ownerThreadId,
    codexHostId: hostBinding.codexHostId,
    rootWorkspacePath: hostBinding.workspacePath,
  });
  assert.equal(snapshot.body.coordination.pendingOwnerIntent.intentId, intentBody.intentId);
  assert.equal(snapshot.body.coordination.pendingOwnerIntent.status, "queued");
  assert.notEqual(snapshot.body.coordination.pendingOwnerIntent.goal, fullOwnerGoal);
  assert.equal(snapshot.body.coordination.pendingOwnerIntent.goal.endsWith("…"), true);
  assert.notEqual(snapshot.body.coordination.pendingOwnerIntent.constraints[0], fullOwnerConstraint);
  assert.equal(snapshot.body.coordination.pendingOwnerIntent.constraints[0].endsWith("…"), true);
  assert.deepEqual(snapshot.body.coordination.pendingOwnerIntent.route, {
    coordinatorTaskId: "coordinator",
    coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    coordinatorWorkspacePath: "/tmp/coordinator-workspace",
  });

  const adoptionPath = `/api/local/projects/local/owner-intents/${intentBody.intentId}/adoption`;
  const unsignedAdoptionClaim = await request(baseUrl, `${adoptionPath}/claim`, {
    method: "POST",
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  assert.equal(unsignedAdoptionClaim.response.status, 403);
  const adoptionClaim = await request(baseUrl, `${adoptionPath}/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "c".repeat(32)),
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  assert.equal(adoptionClaim.response.status, 201, JSON.stringify(adoptionClaim.body));
  assert.equal(adoptionClaim.body.claimed, true);
  assert.deepEqual(Object.keys(adoptionClaim.body.executionIntent).sort(), [
    "constraints", "goal", "intentId", "kind", "targetIntentId", "version",
  ]);
  assert.equal(adoptionClaim.body.executionIntent.kind, "append");
  assert.equal(adoptionClaim.body.executionIntent.targetIntentId, null);
  assert.equal(adoptionClaim.body.executionIntent.goal, fullOwnerGoal);
  assert.deepEqual(adoptionClaim.body.executionIntent.constraints, [fullOwnerConstraint]);
  const adoptionConfirm = await request(baseUrl, `${adoptionPath}/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "d".repeat(32)),
    body: {
      adoptionId: adoptionClaim.body.receipt.id,
      deliveryTurnId: "coordinator-adoption-turn-1",
    },
  });
  assert.equal(adoptionConfirm.response.status, 200, JSON.stringify(adoptionConfirm.body));
  assert.equal(adoptionConfirm.body.confirmed, true);
  const adoptedList = await request(baseUrl, "/api/local/projects/local/owner-intents");
  assert.equal(adoptedList.body.intents[0].status, "adopted");
  const adoptedIntent = adoptedList.body.intents[0];
  const noPending = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(noPending.body.coordination.pendingOwnerIntent, null);
  assert.equal(noPending.body.coordination.pendingOwnerIntentPlan.status, "adopted");
  assert.equal(
    noPending.body.coordination.pendingOwnerIntentPlan.adoptionReceipt.id,
    adoptionClaim.body.receipt.id,
  );

  let planBody = {
    revisionId: "owner-plan-1",
    intentVersion: adoptedIntent.version,
    adoptionId: adoptionClaim.body.receipt.id,
    coordinatorTaskId: "coordinator",
    coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    coordinatorEpoch: "configured:coordinator",
    classification: "bounded_delivery",
    summary: "Derive two bounded delivery slices without widening authority.",
    parentTaskId: null,
    items: [
      {
        outcomeKey: "owner-root-boundary",
        title: "Keep Owner Root separate",
        description: "Preserve the single Owner-facing communication route.",
        priority: "high",
        blockedByOutcomeKeys: [],
      },
      {
        outcomeKey: "replacement-recovery",
        title: "Recover the plan after coordinator replacement",
        description: "Read the durable frontier from Taskboard.",
        priority: "medium",
        blockedByOutcomeKeys: ["owner-root-boundary"],
      },
    ],
  };
  const planPath = `/api/local/projects/local/owner-intents/${intentBody.intentId}/plan-revisions`;
  for (const [revisionId, items] of [
    ["cycle-plan-2", [
      { outcomeKey: "cycle-a", title: "A", description: "A", priority: "high", blockedByOutcomeKeys: ["cycle-b"] },
      { outcomeKey: "cycle-b", title: "B", description: "B", priority: "high", blockedByOutcomeKeys: ["cycle-a"] },
    ]],
    ["cycle-plan-3", [
      { outcomeKey: "cycle-x", title: "X", description: "X", priority: "high", blockedByOutcomeKeys: ["cycle-z"] },
      { outcomeKey: "cycle-y", title: "Y", description: "Y", priority: "high", blockedByOutcomeKeys: ["cycle-x"] },
      { outcomeKey: "cycle-z", title: "Z", description: "Z", priority: "high", blockedByOutcomeKeys: ["cycle-y"] },
    ]],
  ]) {
    const cyclicPlan = await request(baseUrl, planPath, {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, revisionId.endsWith("2") ? "0".repeat(32) : "1".repeat(32)),
      body: { ...planBody, revisionId, items },
    });
    assert.equal(cyclicPlan.response.status, 400);
    assert.equal(cyclicPlan.body.error.code, "PLAN_DEPENDENCY_CYCLE");
  }
  const retryPath = `/api/local/projects/local/owner-intents/${intentBody.intentId}/plan-retry`;
  const retryBody = {
    adoptionId: adoptionClaim.body.receipt.id,
    coordinatorEpoch: "configured:coordinator",
    failureKey: "invalid-cycle-plan-attempt-1",
  };
  const unsignedRetry = await request(baseUrl, retryPath, {
    method: "POST",
    body: retryBody,
  });
  assert.equal(unsignedRetry.response.status, 403);
  const retry = await request(baseUrl, retryPath, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "12".repeat(16)),
    body: retryBody,
  });
  assert.equal(retry.response.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.applied, true);
  assert.equal(retry.body.exhausted, false);
  assert.equal(retry.body.intent.status, "queued");
  assert.equal(retry.body.intent.planRetryCount, 1);
  const retryReplay = await request(baseUrl, retryPath, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "13".repeat(16)),
    body: retryBody,
  });
  assert.equal(retryReplay.response.status, 200);
  assert.equal(retryReplay.body.applied, false);

  const retryClaim = await request(baseUrl, `${adoptionPath}/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "14".repeat(16)),
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  assert.equal(retryClaim.response.status, 201, JSON.stringify(retryClaim.body));
  assert.notEqual(retryClaim.body.receipt.id, adoptionClaim.body.receipt.id);
  const retryConfirm = await request(baseUrl, `${adoptionPath}/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "15".repeat(16)),
    body: { adoptionId: retryClaim.body.receipt.id, deliveryTurnId: "coordinator-replan-turn-2" },
  });
  assert.equal(retryConfirm.body.confirmed, true);
  const retriedIntents = await request(baseUrl, "/api/local/projects/local/owner-intents");
  const retriedIntent = retriedIntents.body.intents.find((item) => item.id === intentBody.intentId);
  planBody = {
    ...planBody,
    intentVersion: retriedIntent.version,
    adoptionId: retryClaim.body.receipt.id,
  };
  const plan = await request(baseUrl, planPath, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "e".repeat(32)),
    body: planBody,
  });
  assert.equal(plan.response.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.revision.status, "applied");
  assert.deepEqual(plan.body.revision.items.map((item) => item.disposition), ["created", "created"]);
  assert.equal(plan.body.revision.items.every((item) => item.task.status === "todo"), true);
  const planReplay = await request(baseUrl, planPath, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "f".repeat(32)),
    body: planBody,
  });
  assert.equal(planReplay.response.status, 200, JSON.stringify(planReplay.body));
  assert.equal(planReplay.body.applied, false);
  assert.deepEqual(planReplay.body.revision, plan.body.revision);
  const frontier = await request(baseUrl, "/api/local/projects/local/owner-intent-plan");
  assert.deepEqual(frontier.body.revisions, [plan.body.revision]);
  const plannedCapsule = await request(
    baseUrl,
    `/api/tasks/${plan.body.revision.items[0].task.identifier}/capsule`,
  );
  assert.equal(plannedCapsule.body.capsule.authorization.state, "absent");
  assert.equal(plannedCapsule.body.capsule.readyWork.eligible, false);

  const financialIntent = {
    ...intentBody,
    intentId: "owner-intent-financial",
    deliveryId: "owner-intent-delivery-financial",
    goal: "Decide a new capital-allocation policy and Q4 metric basis.",
    ownerTurnId: "owner-turn-financial",
    rootCaptureTurnId: "root-capture-turn-financial",
  };
  const financialRecorded = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "1".repeat(32)),
    body: financialIntent,
  });
  assert.equal(financialRecorded.response.status, 201);
  const financialSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  const financialPending = financialSnapshot.body.coordination.pendingOwnerIntent;
  assert.equal(financialPending.intentId, financialIntent.intentId);
  const financialClaimPath = `/api/local/projects/local/owner-intents/${financialIntent.intentId}/adoption`;
  let previousFinancialAdoptionId = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const financialClaim = await request(baseUrl, `${financialClaimPath}/claim`, {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, String(attempt + 1).repeat(32)),
      body: {
        coordinatorTaskId: "coordinator",
        coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
        coordinatorEpoch: "configured:coordinator",
      },
    });
    assert.equal(financialClaim.response.status, 201, JSON.stringify(financialClaim.body));
    assert.notEqual(financialClaim.body.receipt.id, previousFinancialAdoptionId);
    const deliveryTurnId = `financial-replan-turn-${attempt}`;
    const financialConfirm = await request(baseUrl, `${financialClaimPath}/confirm`, {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, String(attempt + 4).repeat(32)),
      body: { adoptionId: financialClaim.body.receipt.id, deliveryTurnId },
    });
    assert.equal(financialConfirm.body.confirmed, true);
    const financialIntents = await request(baseUrl, "/api/local/projects/local/owner-intents");
    const financialAdopted = financialIntents.body.intents.find(
      (item) => item.id === financialIntent.intentId,
    );
    const revisionId = `unsafe-owner-plan-financial-${attempt}`;
    const unsafeFinancialPlan = await request(
      baseUrl,
      `/api/local/projects/local/owner-intents/${financialIntent.intentId}/plan-revisions`,
      {
        method: "POST",
        headers: signedInjectorHeaders(instanceSecret, String(attempt + 7).repeat(32)),
        body: {
          revisionId,
          intentVersion: financialAdopted.version,
          adoptionId: financialClaim.body.receipt.id,
          coordinatorTaskId: "coordinator",
          coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          coordinatorEpoch: "configured:coordinator",
          classification: "bounded_delivery",
          summary: "Incorrectly treat the financial policy as execution.",
          parentTaskId: null,
          items: [],
        },
      },
    );
    assert.equal(unsafeFinancialPlan.response.status, 409);
    assert.equal(unsafeFinancialPlan.body.error.code, "OWNER_DECISION_CLASSIFICATION_REQUIRED");
    const planFailureReason = classifyOwnerIntentPlanHttpFailure(
      unsafeFinancialPlan.response.status,
      unsafeFinancialPlan.body.error.code,
    );
    const monitorResult = await runOwnerIntentPlanningMonitorOnce({
      policy: { enabled: true, projectId: "local" },
      readSnapshot: async () => ({
        projectId: "local",
        coordination: {
          pendingOwnerIntentPlan: {
            intentId: financialIntent.intentId,
            version: financialAdopted.version,
            adoptionReceipt: financialClaim.body.receipt,
          },
        },
      }),
      observePlan: async () => ({ revisionId }),
      applyPlan: async () => ({ applied: false, reason: planFailureReason }),
      scheduleRetry: async (retryRequest) => {
        const scheduled = await request(
          baseUrl,
          `/api/local/projects/local/owner-intents/${financialIntent.intentId}/plan-retry`,
          {
            method: "POST",
            headers: signedInjectorHeaders(instanceSecret, String(attempt + 10).repeat(32)),
            body: {
              adoptionId: retryRequest.adoptionReceipt.id,
              coordinatorEpoch: retryRequest.adoptionReceipt.coordinatorEpoch,
              failureKey: `financial-semantic-plan-attempt-${attempt}`,
            },
          },
        );
        assert.equal(scheduled.response.status, 201, JSON.stringify(scheduled.body));
        return scheduled.body;
      },
    });
    assert.deepEqual(monitorResult, {
      applied: false,
      reason: attempt === 3 ? "plan-retry-exhausted" : "plan-retry-scheduled",
    });
    previousFinancialAdoptionId = financialClaim.body.receipt.id;
  }
  const exhaustedFinancialIntents = await request(baseUrl, "/api/local/projects/local/owner-intents");
  const exhaustedFinancialIntent = exhaustedFinancialIntents.body.intents.find(
    (item) => item.id === financialIntent.intentId,
  );
  assert.equal(exhaustedFinancialIntent.status, "needs_decision");
  assert.equal(exhaustedFinancialIntent.planRetryCount, 3);
  const exhaustedFinancialSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(exhaustedFinancialSnapshot.body.coordination.pendingOwnerIntent, null);
  assert.equal(exhaustedFinancialSnapshot.body.coordination.pendingOwnerIntentPlan, null);

  const decisionIntent = {
    ...financialIntent,
    intentId: "owner-intent-financial-decision",
    deliveryId: "owner-intent-delivery-financial-decision",
    ownerTurnId: "owner-turn-financial-decision",
    rootCaptureTurnId: "root-capture-turn-financial-decision",
  };
  const decisionRecorded = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "d1".repeat(16)),
    body: decisionIntent,
  });
  assert.equal(decisionRecorded.response.status, 201);
  const decisionClaimPath = `/api/local/projects/local/owner-intents/${decisionIntent.intentId}/adoption`;
  const decisionClaim = await request(baseUrl, `${decisionClaimPath}/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "d2".repeat(16)),
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  const decisionConfirm = await request(baseUrl, `${decisionClaimPath}/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "d3".repeat(16)),
    body: { adoptionId: decisionClaim.body.receipt.id, deliveryTurnId: "financial-decision-turn" },
  });
  assert.equal(decisionConfirm.body.confirmed, true);
  const decisionIntents = await request(baseUrl, "/api/local/projects/local/owner-intents");
  const decisionAdopted = decisionIntents.body.intents.find((item) => item.id === decisionIntent.intentId);
  const financialPlan = await request(
    baseUrl,
    `/api/local/projects/local/owner-intents/${decisionIntent.intentId}/plan-revisions`,
    {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, "4".repeat(32)),
      body: {
        revisionId: "owner-plan-financial",
        intentVersion: decisionAdopted.version,
        adoptionId: decisionClaim.body.receipt.id,
        coordinatorTaskId: "coordinator",
        coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
        coordinatorEpoch: "configured:coordinator",
        classification: "financial_decision",
        summary: "Owner decision is required before deriving any executable work.",
        parentTaskId: null,
        items: [],
      },
    },
  );
  assert.equal(financialPlan.response.status, 201, JSON.stringify(financialPlan.body));
  assert.equal(financialPlan.body.revision.status, "needs_decision");
  assert.deepEqual(financialPlan.body.revision.items, []);

  const activePlannedTask = plan.body.revision.items[0].task;
  const moved = await request(baseUrl, `/api/tasks/${activePlannedTask.id}/move`, {
    method: "POST",
    body: {
      version: activePlannedTask.version,
      status: "in_progress",
      sortOrder: 100,
      threadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    },
  });
  assert.equal(moved.response.status, 200);
  const cancelIntent = {
    ...intentBody,
    intentId: "owner-intent-cancel",
    deliveryId: "owner-intent-delivery-cancel",
    kind: "cancel",
    goal: "Cancel the queued plan while preserving work already in progress.",
    targetIntentId: intentBody.intentId,
    ownerTurnId: "owner-turn-cancel",
    rootCaptureTurnId: "root-capture-turn-cancel",
  };
  const cancelRecorded = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "5".repeat(32)),
    body: cancelIntent,
  });
  assert.equal(cancelRecorded.response.status, 201, JSON.stringify(cancelRecorded.body));
  const cancelClaimPath = `/api/local/projects/local/owner-intents/${cancelIntent.intentId}/adoption`;
  const cancelClaim = await request(baseUrl, `${cancelClaimPath}/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "6".repeat(32)),
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  await request(baseUrl, `${cancelClaimPath}/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "7".repeat(32)),
    body: { adoptionId: cancelClaim.body.receipt.id, deliveryTurnId: "cancel-turn" },
  });
  const beforeCancelPlan = await request(baseUrl, "/api/local/projects/local/owner-intents");
  const cancelAdopted = beforeCancelPlan.body.intents.find((item) => item.id === cancelIntent.intentId);
  const cancelPlan = await request(
    baseUrl,
    `/api/local/projects/local/owner-intents/${cancelIntent.intentId}/plan-revisions`,
    {
      method: "POST",
      headers: signedInjectorHeaders(instanceSecret, "8".repeat(32)),
      body: {
        revisionId: "owner-plan-cancel",
        intentVersion: cancelAdopted.version,
        adoptionId: cancelClaim.body.receipt.id,
        coordinatorTaskId: "coordinator",
        coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
        coordinatorEpoch: "configured:coordinator",
        classification: "bounded_delivery",
        summary: "Cancel only unclaimed auto-planned work.",
        parentTaskId: null,
        items: [],
      },
    },
  );
  assert.equal(cancelPlan.response.status, 201, JSON.stringify(cancelPlan.body));
  const preservedActive = await request(baseUrl, `/api/tasks/${activePlannedTask.id}`);
  const canceledQueued = await request(baseUrl, `/api/tasks/${plan.body.revision.items[1].task.id}`);
  assert.equal(preservedActive.body.task.status, "in_progress");
  assert.equal(canceledQueued.body.task.status, "canceled");

  const recoveryIntent = {
    ...intentBody,
    intentId: "owner-intent-recovery",
    deliveryId: "owner-intent-delivery-recovery",
    goal: "Recover this unplanned intent after replacing the coordinator.",
    ownerTurnId: "owner-turn-recovery",
    rootCaptureTurnId: "root-capture-turn-recovery",
  };
  const recoveryRecorded = await request(baseUrl, "/api/local/projects/local/owner-intents", {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "9".repeat(32)),
    body: recoveryIntent,
  });
  assert.equal(recoveryRecorded.response.status, 201);
  const recoveryPath = `/api/local/projects/local/owner-intents/${recoveryIntent.intentId}`;
  const oldReserved = await request(baseUrl, `${recoveryPath}/adoption/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "a".repeat(32)),
    body: {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      coordinatorEpoch: "configured:coordinator",
    },
  });
  assert.equal(oldReserved.response.status, 201);
  const replacementConfig = (coordinatorId, coordinatorThreadId) => ({
    rootTaskId: coordinatorId,
    ownerRootTaskId: "owner-root",
    tasks: [
      {
        id: "owner-root", label: "Owner Root", owner: "Codex Root", source: "codex",
        threadId: ownerThreadId, taskType: "root_task", codexHostId: "local",
        workspacePath: "/tmp/owner-root-workspace",
      },
      {
        id: coordinatorId, label: "Coordinator", owner: "Codex Root", source: "codex",
        threadId: coordinatorThreadId, taskType: "root_task", codexHostId: "local",
        workspacePath: `/tmp/${coordinatorId}-workspace`,
      },
    ],
    adapters: [],
  });
  const replacementDatabase = new TaskboardDatabase(databasePath);
  replacementDatabase.upsertAgentLaneProject(
    "local",
    replacementConfig("coordinator-b", "01a004bd-a749-7b53-81e2-af2d477f93af"),
  );
  replacementDatabase.close();
  const replacementSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(replacementSnapshot.body.coordination.pendingOwnerIntent.intentId, recoveryIntent.intentId);
  const replacementClaim = await request(baseUrl, `${recoveryPath}/adoption/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "b".repeat(32)),
    body: {
      coordinatorTaskId: "coordinator-b",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
      coordinatorEpoch: "configured:coordinator-b",
    },
  });
  assert.equal(replacementClaim.response.status, 201, JSON.stringify(replacementClaim.body));
  const staleReservedConfirm = await request(baseUrl, `${recoveryPath}/adoption/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "c".repeat(32)),
    body: { adoptionId: oldReserved.body.receipt.id, deliveryTurnId: "stale-turn" },
  });
  assert.equal(staleReservedConfirm.response.status, 409);
  const replacementConfirm = await request(baseUrl, `${recoveryPath}/adoption/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "d".repeat(32)),
    body: { adoptionId: replacementClaim.body.receipt.id, deliveryTurnId: "replacement-b-turn" },
  });
  assert.equal(replacementConfirm.body.confirmed, true);

  const secondReplacementDatabase = new TaskboardDatabase(databasePath);
  secondReplacementDatabase.upsertAgentLaneProject(
    "local",
    replacementConfig("coordinator-c", "01a004bd-a749-7b53-81e2-af2d477f93b0"),
  );
  secondReplacementDatabase.close();
  const reAdoptSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(reAdoptSnapshot.body.coordination.pendingOwnerIntent.intentId, recoveryIntent.intentId);
  assert.equal(reAdoptSnapshot.body.coordination.pendingOwnerIntentPlan, null);
  const reAdoptClaim = await request(baseUrl, `${recoveryPath}/adoption/claim`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "e".repeat(32)),
    body: {
      coordinatorTaskId: "coordinator-c",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b0",
      coordinatorEpoch: "configured:coordinator-c",
    },
  });
  assert.equal(reAdoptClaim.response.status, 201, JSON.stringify(reAdoptClaim.body));
  const stalePlan = await request(baseUrl, `${recoveryPath}/plan-revisions`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "f".repeat(32)),
    body: {
      revisionId: "stale-replacement-plan",
      intentVersion: replacementSnapshot.body.coordination.pendingOwnerIntent.version + 1,
      adoptionId: replacementClaim.body.receipt.id,
      coordinatorTaskId: "coordinator-b",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93af",
      coordinatorEpoch: "configured:coordinator-b",
      classification: "bounded_delivery",
      summary: "This stale plan must fail.",
      parentTaskId: null,
      items: [],
    },
  });
  assert.equal(stalePlan.response.status, 409);
  const reAdoptConfirm = await request(baseUrl, `${recoveryPath}/adoption/confirm`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "0".repeat(32)),
    body: { adoptionId: reAdoptClaim.body.receipt.id, deliveryTurnId: "replacement-c-turn" },
  });
  assert.equal(reAdoptConfirm.body.confirmed, true);
  const finalRecoveryIntents = await request(baseUrl, "/api/local/projects/local/owner-intents");
  const recoveredIntent = finalRecoveryIntents.body.intents.find((item) => item.id === recoveryIntent.intentId);
  const recoveredPlan = await request(baseUrl, `${recoveryPath}/plan-revisions`, {
    method: "POST",
    headers: signedInjectorHeaders(instanceSecret, "1".repeat(31) + "2"),
    body: {
      revisionId: "recovered-plan",
      intentVersion: recoveredIntent.version,
      adoptionId: reAdoptClaim.body.receipt.id,
      coordinatorTaskId: "coordinator-c",
      coordinatorThreadId: "01a004bd-a749-7b53-81e2-af2d477f93b0",
      coordinatorEpoch: "configured:coordinator-c",
      classification: "bounded_delivery",
      summary: "Recovered exactly once after replacement.",
      parentTaskId: null,
      items: [],
    },
  });
  assert.equal(recoveredPlan.response.status, 201, JSON.stringify(recoveredPlan.body));
});

test("connected Agent Lane opens its exact Codex thread through the local launcher", async () => {
  const openedThreads = [];
  const baseUrl = await startServer(() => ({
    openCodexThread: async (threadId) => openedThreads.push(threadId),
  }));
  const threadId = "01a0035b-1d22-70b2-8233-d7a4ec283459";

  const result = await request(baseUrl, `/api/local/codex-threads/${threadId}/open`, {
    method: "POST",
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { opened: true });
  assert.deepEqual(openedThreads, [threadId]);
});

test("launcher mode proves service identity and hides every route behind its instance token", async () => {
  const instanceToken = "7a6f8d37-78ce-46c9-87a8-08e10db88da2";
  const instanceSecret = "2e587946-96d6-47b5-930a-1ba70214fa88";
  const version = "0.2.0";
  const challenge = "8cbeea6e83e574def3f9d397cabddffc";
  const baseUrl = await startServer(() => ({ instanceToken, instanceSecret, version }));
  const unauthenticatedHealth = await request(baseUrl, "/health");
  assert.equal(unauthenticatedHealth.response.status, 401);

  const health = await request(baseUrl, "/health", {
    headers: { "x-codex-taskboard-challenge": challenge },
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.body.product, "codex-taskboard");
  assert.equal(health.body.version, version);
  assert.equal(
    health.body.proof,
    createHmac("sha256", instanceSecret).update(challenge).digest("hex"),
  );

  const publicApi = await request(baseUrl, "/api/projects");
  assert.equal(publicApi.response.status, 404);

  const boundaryPage = await fetch(`${baseUrl}/`);
  const boundaryBody = await boundaryPage.text();
  assert.equal(boundaryPage.status, 200);
  assert.equal(boundaryPage.headers.get("cache-control"), "no-store");
  assert.match(boundaryPage.headers.get("content-type"), /^text\/html\b/);
  assert.match(boundaryBody, /Open Taskboard from Codex to use authenticated Agent Lanes/);
  assert.match(boundaryBody, /No Taskboard data is exposed here/);
  assert.doesNotMatch(boundaryBody, new RegExp(instanceToken));
  assert.doesNotMatch(boundaryBody, /\/api\//);

  const launcherApi = await request(baseUrl, `/${instanceToken}/api/projects`, {
    headers: { origin: "null" },
  });
  assert.equal(launcherApi.response.status, 200);
  assert.equal(launcherApi.response.headers.get("access-control-allow-origin"), "null");
});

test("existing task and comment thread attribution remains content-specific", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'legacy-task', 'LOCAL-1', 'local', 'Legacy task', '', 'todo', 'none', '["vibe-coding","no-working-log"]', 1000,
        'legacy-thread', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        'legacy-formal-task', 'LOCAL-2', 'local', 'Legacy formal task', '', 'todo', 'none', '["vibe-coding"]', 2000,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO comments VALUES (
        'legacy-comment', 'legacy-task', 'Legacy comment', 'legacy-comment-thread', 'local', '本地用户', 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO attachments VALUES (
        'legacy-attachment', 'legacy-task', 'legacy.txt', 'text/plain', 0,
        '2026-07-20T00:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const result = await request(baseUrl, "/api/tasks/legacy-task");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.threadId, "legacy-thread");
  assert.equal(result.body.task.threadBinding, null);
  assert.equal(result.body.task.legacyLocalThreadId, "legacy-thread");
  assert.deepEqual(result.body.task.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal,
  })), [
    { threadId: "legacy-thread", legacyLocal: true },
    { threadId: "legacy-comment-thread", legacyLocal: true },
  ]);
  assert.equal(result.body.task.creatorType, "agent");
  assert.equal(result.body.task.creatorId, "codex-agent");
  assert.equal(result.body.task.creatorName, "Codex Agent");
  assert.deepEqual(result.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });
  assert.equal(Object.hasOwn(result.body.task, "linkedThreadId"), false);
  const columns = runningApps.at(-1).app.database.database.prepare("PRAGMA table_info(tasks)").all();
  assert.equal(columns.some((column) => column.name === "thread_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_type"), true);
  assert.equal(columns.some((column) => column.name === "assignee_id"), true);
  assert.equal(columns.some((column) => column.name === "assignee_name"), true);
  assert.equal(columns.some((column) => column.name === "assignee_avatar_url"), true);
  assert.equal(columns.some((column) => column.name === "linked_thread_id"), false);
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads, undefined);
  const readiness = await request(baseUrl, "/api/local/activation-readiness");
  assert.equal(readiness.response.status, 200);
  assert.deepEqual(readiness.body.workflowProfileCandidates.map((candidate) => ({
    taskId: candidate.taskId,
    identifier: candidate.identifier,
    taskVersion: candidate.taskVersion,
    suggestedProfile: candidate.suggestedProfile,
    status: candidate.status,
  })), [{
    taskId: "legacy-task",
    identifier: "LOCAL-1",
    taskVersion: 1,
    suggestedProfile: "vibe",
    status: "pending",
  }]);
  assert.deepEqual(readiness.body.legacyRootBindings.map((binding) => binding.identifier), ["LOCAL-1"]);
  const preservedFormal = await request(baseUrl, "/api/tasks/legacy-formal-task");
  assert.equal(preservedFormal.body.task.workflowProfile, "formal");
  const rejectedBrowserMutation = await request(
    baseUrl,
    "/api/local/activation-readiness/workflow-profiles/LOCAL-1",
    { method: "POST", body: { version: 1 } },
  );
  assert.equal(rejectedBrowserMutation.response.status, 403);
  assert.equal(rejectedBrowserMutation.body.error.code, "TASKCTL_REQUIRED");
  const rejectedFormalMigration = await request(
    baseUrl,
    "/api/local/activation-readiness/workflow-profiles/LOCAL-2",
    { method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: { version: 1 } },
  );
  assert.equal(rejectedFormalMigration.response.status, 409);
  assert.equal(rejectedFormalMigration.body.error.code, "ACTIVATION_CANDIDATE_MISSING");

  const appliedProfile = await request(
    baseUrl,
    "/api/local/activation-readiness/workflow-profiles/LOCAL-1",
    { method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: { version: 1 } },
  );
  assert.equal(appliedProfile.response.status, 200);
  assert.equal(appliedProfile.body.applied, true);
  assert.equal(appliedProfile.body.task.workflowProfile, "vibe");
  assert.equal(appliedProfile.body.task.version, 2);
  assert.equal(appliedProfile.body.receipt.taskVersionBefore, 1);
  assert.equal(appliedProfile.body.receipt.taskVersionAfter, 2);

  const replayedProfile = await request(
    baseUrl,
    "/api/local/activation-readiness/workflow-profiles/LOCAL-1",
    { method: "POST", headers: { "x-taskboard-client": "taskctl" }, body: { version: 1 } },
  );
  assert.equal(replayedProfile.response.status, 200);
  assert.equal(replayedProfile.body.applied, false);
  assert.deepEqual(replayedProfile.body.receipt, appliedProfile.body.receipt);

  const afterReadiness = await request(baseUrl, "/api/local/activation-readiness");
  assert.equal(afterReadiness.body.workflowProfileCandidates[0].status, "applied");
  assert.equal(runningApps.at(-1).app.database.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  const comments = await request(baseUrl, "/api/tasks/legacy-task/comments");
  assert.equal(comments.body.comments[0].threadId, "legacy-comment-thread");
  assert.equal(comments.body.comments[0].threadBinding, null);
  assert.equal(comments.body.comments[0].legacyLocalThreadId, "legacy-comment-thread");
  assert.equal(comments.body.comments[0].authorType, "agent");
  assert.equal(comments.body.comments[0].authorId, "codex-agent");
  assert.equal(comments.body.comments[0].authorName, "Codex Agent");
  assert.deepEqual(comments.body.comments[0].attachments, []);
  const attachments = await request(baseUrl, "/api/tasks/legacy-task/attachments");
  assert.equal(attachments.body.attachments[0].commentId, null);

  let version = appliedProfile.body.task.version;
  for (const status of ["in_review", "blocked", "canceled"]) {
    const moveResult = await request(baseUrl, "/api/tasks/legacy-task/move", {
      method: "POST",
      body: { version, status },
    });
    assert.equal(moveResult.response.status, 200);
    assert.equal(moveResult.body.task.status, status);
    version = moveResult.body.task.version;
  }
  const tasksSql = runningApps.at(-1).app.database.database.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
  `).get().sql;
  assert.match(tasksSql, /'in_review'/);
  assert.match(tasksSql, /'blocked'/);
  assert.match(tasksSql, /'canceled'/);
  const commentForeignKeys = runningApps.at(-1).app.database.database
    .prepare("PRAGMA foreign_key_list(comments)")
    .all();
  assert.equal(commentForeignKeys.some((foreignKey) => foreignKey.table === "tasks"), true);
});

test("activation readiness redetects exact vibe candidates created after schema migration", async () => {
  let identifier;
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };
    const task = database.createTask({
      projectId: "local",
      title: "Late-labeled personal Taskboard work",
      description: "",
      status: "todo",
      priority: "none",
      labels: ["taskboard", "vibe-coding", "no-working-log"],
      workflowProfile: "formal",
      threadId: null,
      actor,
      assignee: actor,
      developmentContext: null,
      workingLog: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    identifier = task.identifier;
    database.close();
    return {};
  });

  const readiness = await request(baseUrl, "/api/local/activation-readiness");

  assert.equal(readiness.response.status, 200);
  assert.deepEqual(readiness.body.workflowProfileCandidates.map((candidate) => ({
    identifier: candidate.identifier,
    taskVersion: candidate.taskVersion,
    suggestedProfile: candidate.suggestedProfile,
    status: candidate.status,
  })), [{
    identifier,
    taskVersion: 1,
    suggestedProfile: "vibe",
    status: "pending",
  }]);
});

test("task thread migration excludes comment-only aggregate entries", async () => {
  const baseUrl = await startServer(async (directory) => {
    const databasePath = path.join(directory, "taskboard.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_threads (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, thread_id)
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 2, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'aggregate-task', 'LOCAL-1', 'local', 'Aggregate task', '', 'todo', 'none', '[]', 1000,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T03:00:00.000Z'
      );
      INSERT INTO task_threads VALUES ('aggregate-task', 'thread-subject', '2026-07-20T01:00:00.000Z');
      INSERT INTO task_threads VALUES ('aggregate-task', 'thread-comment-only', '2026-07-20T02:00:00.000Z');
      INSERT INTO comments VALUES (
        'aggregate-comment', 'aggregate-task', 'Comment', 'thread-comment-only', 'local', '本地用户', 1,
        '2026-07-20T02:00:00.000Z', '2026-07-20T02:00:00.000Z'
      );
    `);
    database.close();
    return { databasePath };
  });

  const task = await request(baseUrl, "/api/tasks/aggregate-task");
  assert.equal(task.body.task.threadId, "thread-subject");
  const taskThreads = runningApps.at(-1).app.database.database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
  `).get();
  assert.equal(taskThreads, undefined);
  const comments = await request(baseUrl, "/api/tasks/aggregate-task/comments");
  assert.equal(comments.body.comments[0].threadId, "thread-comment-only");
});

test("development context scan resolves the current Codex conversation workspace", async () => {
  let expectedWorkspace;
  const baseUrl = await startServer(async (directory) => {
    expectedWorkspace = directory;
    const processesPath = path.join(directory, "chat_processes.json");
    await writeFile(processesPath, JSON.stringify({
      recent: [{
        conversationId: "019f7f96-287b-7da0-bc7f-ffe03af85cc8",
        cwd: directory,
        updatedAtMs: 20,
      }],
    }));
    return {
      codexStatePath: path.join(directory, "missing-state.json"),
      codexProcessesPath: processesPath,
    };
  });
  const result = await request(
    baseUrl,
    "/api/projects/local/development-contexts?codexThreadId=019f7f96-287b-7da0-bc7f-ffe03af85cc8",
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.workspacePath, expectedWorkspace);
  assert.deepEqual(result.body.contexts, []);

  const deviceWorkspace = path.join(expectedWorkspace, "another-device-workspace");
  const deviceResult = await request(
    baseUrl,
    `/api/projects/local/development-contexts?workspacePath=${encodeURIComponent(deviceWorkspace)}`,
  );
  assert.equal(deviceResult.response.status, 200);
  assert.equal(deviceResult.body.workspacePath, deviceWorkspace);
});

test("device workspaces come from this machine's Codex project roots", async () => {
  const baseUrl = await startServer(async (directory) => {
    const codexStatePath = path.join(directory, "codex-state.json");
    await writeFile(codexStatePath, JSON.stringify({
      "local-projects": {
        "local-project-a": { rootPaths: ["/Users/alice/project-a"] },
        "local-project-b": { rootPaths: ["/Users/alice/project-b"] },
      },
    }));
    return { codexStatePath };
  });
  const result = await request(baseUrl, "/api/device-workspaces");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.workspaces, {
    "local-project-a": "/Users/alice/project-a",
    "local-project-b": "/Users/alice/project-b",
  });
});

test("accepts private LAN requests and rejects public Host and Origin headers", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });

  const codexOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "app://-" },
  });
  assert.equal(codexOriginResult.response.status, 200);

  const lanHostResult = await requestWithHost(baseUrl, "192.168.1.24:47823");
  assert.equal(lanHostResult.status, 200);

  const lanOriginResult = await request(baseUrl, "/health", {
    headers: { origin: "http://192.168.1.24:47823" },
  });
  assert.equal(lanOriginResult.response.status, 200);

  const localHostnameResult = await requestWithHost(baseUrl, "taskboard.local:47823");
  assert.equal(localHostnameResult.status, 200);

  const hostResult = await requestWithHost(baseUrl, "taskboard.example.com");
  assert.equal(hostResult.status, 403);
  assert.equal(hostResult.body.error.code, "INVALID_HOST");

  const originResult = await request(baseUrl, "/health", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(originResult.response.status, 403);
  assert.equal(originResult.body.error.code, "INVALID_ORIGIN");
});

test("project and task CRUD flow", async () => {
  const baseUrl = await startServer();

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "website", name: "Website", workspacePath: "/work/website" },
  });
  assert.equal(projectResult.response.status, 201);
  assert.equal(projectResult.body.project.id, "website");
  assert.equal(projectResult.body.project.workspacePath, "/work/website");

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "website",
      title: "Build task board",
      description: "Create the first local board",
      status: "todo",
      priority: "high",
      labels: ["frontend", "mvp"],
      workflowProfile: "vibe",
      threadId: "thread-123",
      developmentContext: {
        type: "worktree",
        path: "/work/website/.worktrees/taskboard",
        branch: "worktree/taskboard",
      },
      dueDate: "2026-07-24",
      recurrence: { interval: 2, unit: "week" },
    },
  });
  assert.equal(createResult.response.status, 201);
  const created = createResult.body.task;
  assert.equal(created.identifier, "WEB-1");
  assert.equal(created.version, 1);
  assert.equal(created.sortOrder, 1000);
  assert.equal(created.archivedAt, null);
  assert.deepEqual(created.labels, ["frontend", "mvp"]);
  assert.equal(created.workflowProfile, "vibe");
  assert.equal(created.threadId, "thread-123");
  assert.equal(created.creatorType, "user");
  assert.equal(created.creatorId, "local-user");
  assert.equal(created.creatorName, "本地用户");
  assert.equal(created.creatorAvatarUrl, null);
  assert.deepEqual(created.developmentContext, {
    type: "worktree",
    path: "/work/website/.worktrees/taskboard",
    branch: "worktree/taskboard",
  });
  assert.equal(created.dueDate, "2026-07-24");
  assert.deepEqual(created.recurrence, { interval: 2, unit: "week" });

  const projectsAfterCreate = await request(baseUrl, "/api/projects");
  const websiteProject = projectsAfterCreate.body.projects.find((project) => project.id === "website");
  assert.equal(websiteProject.issueCount, 1);

  const getResult = await request(baseUrl, `/api/tasks/${created.id}`);
  assert.equal(getResult.response.status, 200);
  assert.deepEqual(getResult.body.task, created);
  const getByIdentifier = await request(baseUrl, `/api/tasks/${created.identifier}`);
  assert.equal(getByIdentifier.response.status, 200);
  assert.equal(getByIdentifier.body.task.id, created.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=website&status=todo");
  assert.equal(listResult.response.status, 200);
  assert.deepEqual(listResult.body.tasks.map((task) => task.id), [created.id]);

  const patchResult = await request(baseUrl, `/api/tasks/${created.identifier}`, {
    method: "PATCH",
    body: {
      version: created.version,
      title: "Build polished task board",
      priority: "urgent",
      workflowProfile: "formal",
      developmentContext: { type: "branch", branch: "feature/polish" },
    },
  });
  assert.equal(patchResult.response.status, 200);
  const updated = patchResult.body.task;
  assert.equal(updated.title, "Build polished task board");
  assert.equal(updated.priority, "urgent");
  assert.equal(updated.workflowProfile, "formal");
  assert.equal(updated.threadId, "thread-123");
  assert.deepEqual(updated.developmentContext, { type: "branch", branch: "feature/polish" });
  assert.equal(updated.version, 2);

  const archiveResult = await request(baseUrl, `/api/tasks/${created.id}/archive`, {
    method: "POST",
    body: { version: updated.version, threadId: "thread-archive" },
  });
  assert.equal(archiveResult.response.status, 200);
  assert.equal(archiveResult.body.task.version, 3);
  assert.equal(archiveResult.body.task.threadId, "thread-123");
  assert.match(archiveResult.body.task.archivedAt, /^\d{4}-\d{2}-\d{2}T/);

  const activeList = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeList.body.tasks, []);
  const archivedList = await request(baseUrl, "/api/tasks?projectId=website&archived=true");
  assert.deepEqual(archivedList.body.tasks.map((task) => task.id), [created.id]);

  const projectsAfterArchive = await request(baseUrl, "/api/projects");
  const archivedWebsiteProject = projectsAfterArchive.body.projects.find((project) => project.id === "website");
  assert.equal(archivedWebsiteProject.issueCount, 0);

  const restoreResult = await request(baseUrl, `/api/tasks/${created.id}/restore`, {
    method: "POST",
    body: { version: archiveResult.body.task.version, threadId: "thread-restore" },
  });
  assert.equal(restoreResult.response.status, 200);
  assert.equal(restoreResult.body.task.archivedAt, null);
  assert.equal(restoreResult.body.task.version, 4);
  assert.equal(restoreResult.body.task.threadId, "thread-123");

  const activeAfterRestore = await request(baseUrl, "/api/tasks?projectId=website");
  assert.deepEqual(activeAfterRestore.body.tasks.map((task) => task.id), [created.id]);
  const projectsAfterRestore = await request(baseUrl, "/api/projects");
  const restoredWebsiteProject = projectsAfterRestore.body.projects.find((project) => project.id === "website");
  assert.equal(restoredWebsiteProject.issueCount, 1);
});

test("moving a task updates its status and sort order", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Move me" },
  });
  const task = createResult.body.task;

  const moveResult = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress", sortOrder: 2500.5, threadId: "thread-move" },
  });
  assert.equal(moveResult.response.status, 200);
  assert.equal(moveResult.body.task.status, "in_progress");
  assert.equal(moveResult.body.task.sortOrder, 2500.5);
  assert.equal(moveResult.body.task.threadId, null);
  assert.equal(moveResult.body.task.version, 2);
});

test("remote task bindings keep their own identity and can be cleared independently", async () => {
  const baseUrl = await startServer();
  const legacy = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Legacy binding", threadId: "legacy-thread" },
  })).body.task;
  assert.equal(legacy.threadId, "legacy-thread");
  assert.equal(legacy.threadBinding, null);
  assert.equal(legacy.legacyLocalThreadId, "legacy-thread");
  assert.deepEqual(legacy.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal,
  })), [{ threadId: "legacy-thread", legacyLocal: true }]);
  const binding = {
    threadId: "remote-thread-a",
    codexProjectId: "remote-project-a",
    codexProjectKind: "remote",
    codexHostId: "ssh-a",
    workspacePath: "/same/remote/path",
  };
  const created = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Remote binding", threadId: binding.threadId, threadBinding: binding },
  })).body.task;
  assert.deepEqual(created.threadBinding, binding);
  assert.deepEqual(created.conversationRefs.map((ref) => ref.codexHostId), ["ssh-a"]);

  const controllerComment = (await request(baseUrl, `/api/tasks/${created.id}/comments`, {
    method: "POST",
    body: { body: "Controller note", threadId: "controller-thread" },
  })).body.comment;
  assert.equal(controllerComment.threadBinding, null);
  assert.equal(controllerComment.legacyLocalThreadId, "controller-thread");

  const blocked = (await request(baseUrl, `/api/tasks/${created.id}/move`, {
    method: "POST",
    body: {
      version: created.version,
      status: "blocked",
      threadId: "controller-thread",
      threadBinding: binding,
    },
  })).body.task;
  assert.equal(blocked.threadId, binding.threadId);
  assert.deepEqual(blocked.threadBinding, binding);
  assert.deepEqual(blocked.conversationRefs.map((ref) => ({
    threadId: ref.threadId,
    legacyLocal: ref.legacyLocal ?? false,
  })), [
    { threadId: binding.threadId, legacyLocal: false },
    { threadId: "controller-thread", legacyLocal: true },
  ]);

  const restored = (await request(baseUrl, `/api/tasks/${created.id}/move`, {
    method: "POST",
    body: {
      version: blocked.version,
      status: "todo",
      threadId: "controller-thread",
      threadBinding: null,
    },
  })).body.task;
  assert.equal(restored.threadId, null);
  assert.equal(restored.threadBinding, null);
  assert.deepEqual(restored.conversationRefs.map((ref) => ref.threadId), ["controller-thread"]);
});

test("the active local Codex conversation supplies its exact task binding identity", async () => {
  const instanceSecret = "c".repeat(64);
  const baseUrl = await startServer(() => ({ instanceSecret }));
  const runtime = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
    headers: signedInjectorHeaders(instanceSecret, "4".repeat(32)),
    body: {
      threadId: "local-thread",
      threadRunning: true,
      threadTodoProgress: null,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/work/local-project",
    },
  });
  assert.equal(runtime.response.status, 200);
  const task = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Local binding", threadId: "local-thread" },
  })).body.task;
  assert.deepEqual(task.threadBinding, {
    threadId: "local-thread",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/work/local-project",
  });
});

test("issues support parent, sub-issue, blocking, and related issue relationships", async () => {
  const baseUrl = await startServer();
  const createIssue = async (title, status = "todo", projectId = "local") => {
    const result = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId, title, status },
    });
    assert.equal(result.response.status, 201);
    return result.body.task;
  };
  const latest = async (id) => (await request(baseUrl, `/api/tasks/${id}`)).body.task;
  const mutateRelation = async (method, task, type, related, version = task.version) => (
    request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(related.id)}`,
      {
        method,
        body: { version, threadId: "thread-relations" },
      },
    )
  );

  const parent = await createIssue("Parent issue");
  const child = await createIssue("Child issue", "done");
  const grandchild = await createIssue("Grandchild issue", "canceled");
  const blocker = await createIssue("Blocking issue", "in_progress");
  const related = await createIssue("Related issue");

  const parentAdded = await mutateRelation("POST", child, "parent", parent);
  assert.equal(parentAdded.response.status, 200);
  assert.equal(parentAdded.body.task.version, child.version + 1);
  assert.equal(parentAdded.body.task.threadId, null);
  assert.equal(parentAdded.body.task.relations.parent.id, parent.id);
  assert.equal(parentAdded.body.relatedTask.id, parent.id);

  const parentAfterAdd = await latest(parent.id);
  assert.deepEqual(parentAfterAdd.relations.subIssues.map((issue) => issue.id), [child.id]);
  assert.equal(parentAfterAdd.relations.subIssues[0].status, "done");

  const childWithGrandchild = await mutateRelation("POST", grandchild, "parent", await latest(child.id));
  assert.equal(childWithGrandchild.response.status, 200);
  const cycle = await mutateRelation("POST", await latest(parent.id), "parent", await latest(grandchild.id));
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.body.error.code, "RELATION_CYCLE");

  const self = await mutateRelation("POST", await latest(parent.id), "related", await latest(parent.id));
  assert.equal(self.response.status, 400);
  assert.equal(self.body.error.code, "SELF_RELATION");

  const blocksAdded = await mutateRelation("POST", await latest(parent.id), "blocks", blocker);
  assert.equal(blocksAdded.response.status, 200);
  assert.deepEqual(blocksAdded.body.task.relations.blocks.map((issue) => issue.id), [blocker.id]);
  assert.deepEqual((await latest(blocker.id)).relations.blockedBy.map((issue) => issue.id), [parent.id]);

  const duplicateBlocks = await mutateRelation(
    "POST",
    await latest(blocker.id),
    "blocked_by",
    await latest(parent.id),
  );
  assert.equal(duplicateBlocks.response.status, 409);
  assert.equal(duplicateBlocks.body.error.code, "RELATION_EXISTS");

  const relatedAdded = await mutateRelation("POST", await latest(parent.id), "related", related);
  assert.equal(relatedAdded.response.status, 200);
  assert.deepEqual(relatedAdded.body.task.relations.related.map((issue) => issue.id), [related.id]);
  assert.deepEqual((await latest(related.id)).relations.related.map((issue) => issue.id), [parent.id]);

  const stale = await mutateRelation(
    "DELETE",
    relatedAdded.body.task,
    "related",
    related,
    relatedAdded.body.task.version - 1,
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");

  const relatedRemoved = await mutateRelation("DELETE", relatedAdded.body.task, "related", related);
  assert.equal(relatedRemoved.response.status, 200);
  assert.deepEqual(relatedRemoved.body.task.relations.related, []);
  assert.deepEqual((await latest(related.id)).relations.related, []);

  const replacementParent = await createIssue("Replacement parent");
  const childBeforeReplace = await latest(child.id);
  const replaced = await mutateRelation("POST", childBeforeReplace, "parent", replacementParent);
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.body.task.relations.parent.id, replacementParent.id);
  assert.deepEqual((await latest(parent.id)).relations.subIssues, []);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues.map((issue) => issue.id), [child.id]);

  const parentRemoved = await mutateRelation("DELETE", replaced.body.task, "parent", replacementParent);
  assert.equal(parentRemoved.response.status, 200);
  assert.equal(parentRemoved.body.task.relations.parent, null);
  assert.deepEqual((await latest(replacementParent.id)).relations.subIssues, []);

  const projectResult = await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "other", name: "Other" },
  });
  assert.equal(projectResult.response.status, 201);
  const crossProject = await createIssue("Other project issue", "todo", "other");
  const crossProjectRelation = await mutateRelation(
    "POST",
    await latest(parent.id),
    "related",
    crossProject,
  );
  assert.equal(crossProjectRelation.response.status, 400);
  assert.equal(crossProjectRelation.body.error.code, "CROSS_PROJECT_RELATION");
});

test("issue relationship changes are broadcast in realtime", async () => {
  const baseUrl = await startServer();
  const first = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime source" },
  })).body.task;
  const second = (await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Realtime target" },
  })).body.task;

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const changed = await request(
    baseUrl,
    `/api/tasks/${first.id}/relations/related/${second.id}`,
    {
      method: "POST",
      body: { version: first.version, threadId: "thread-realtime-relation" },
    },
  );
  assert.equal(changed.response.status, 200);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.relation\.updated/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.relation.updated");
  assert.equal(event.task.id, first.id);
  assert.equal(event.relatedTask.id, second.id);
  await reader.cancel();
});

test("all task statuses are accepted, filtered, and listed in workflow order", async () => {
  const baseUrl = await startServer();
  const statuses = ["canceled", "done", "blocked", "in_review", "in_progress", "todo", "backlog"];

  for (const status of statuses) {
    const createResult = await request(baseUrl, "/api/tasks", {
      method: "POST",
      body: { title: status, status },
    });
    assert.equal(createResult.response.status, 201);
    assert.equal(createResult.body.task.status, status);
  }

  const listResult = await request(baseUrl, "/api/tasks");
  assert.deepEqual(
    listResult.body.tasks.map((task) => task.status),
    ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"],
  );

  for (const status of ["in_review", "blocked", "canceled"]) {
    const filteredResult = await request(baseUrl, `/api/tasks?status=${status}`);
    assert.equal(filteredResult.response.status, 200);
    assert.deepEqual(filteredResult.body.tasks.map((task) => task.status), [status]);
  }
});

test("task and comment mutations keep content-specific conversation attribution", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Keep attribution", threadId: "thread-original" },
  });
  const task = createResult.body.task;
  const updateResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "Still attributed" },
  });
  assert.equal(updateResult.body.task.threadId, "thread-original");

  const rejectedRebind = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: updateResult.body.task.version, title: "Still attributed again", threadId: "thread-original" },
  });
  assert.equal(rejectedRebind.response.status, 400);
  assert.equal(rejectedRebind.body.error.code, "INVALID_FIELD");

  const repeatedUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: updateResult.body.task.version, title: "Still attributed again" },
  });
  assert.equal(repeatedUpdate.body.task.threadId, "thread-original");

  const commentCreate = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "Attributed comment", threadId: "thread-comment" },
  });
  const comment = commentCreate.body.comment;
  const commentUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited from the UI" },
  });
  assert.equal(commentUpdate.body.comment.threadId, "thread-comment");
  const taskAfterComment = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterComment.body.task.threadId, "thread-original");
});

test("stale updates receive a version conflict", async () => {
  const baseUrl = await startServer();
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Concurrent edit" },
  });
  const task = createResult.body.task;

  const firstUpdate = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "First editor" },
  });
  assert.equal(firstUpdate.response.status, 200);

  const staleUpdate = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "done", sortOrder: 1 },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(staleUpdate.body.error.details, {
    expectedVersion: 1,
    actualVersion: 2,
  });
});

test("issue comments can be created, edited, listed, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Discuss me" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.comments, []);

  const createResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "First comment", threadId: "thread-comment-create" },
  });
  assert.equal(createResult.response.status, 201);
  const comment = createResult.body.comment;
  assert.equal(comment.taskId, task.id);
  assert.equal(comment.body, "First comment");
  assert.equal(comment.threadId, "thread-comment-create");
  assert.deepEqual(comment.attachments, []);
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "local-user");
  assert.equal(comment.authorName, "本地用户");
  assert.equal(comment.version, 1);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(listResult.body.comments.map((item) => item.id), [comment.id]);

  const updateResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Edited comment", threadId: "thread-comment-update" },
  });
  assert.equal(updateResult.response.status, 200);
  const updated = updateResult.body.comment;
  assert.equal(updated.body, "Edited comment");
  assert.equal(updated.threadId, "thread-comment-update");
  assert.equal(updated.version, 2);

  const taskAfterUpdate = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterUpdate.body.task.threadId, null);

  const staleUpdate = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { version: comment.version, body: "Stale edit" },
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.error.code, "VERSION_CONFLICT");

  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: updated.version, threadId: "thread-comment-delete" },
  });
  assert.equal(deleteResult.response.status, 204);

  const finalList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(finalList.body.comments, []);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("taskctl issue creation and comments use the Codex Agent identity", async () => {
  const baseUrl = await startServer();
  const agentHeaders = {
    "x-taskboard-client": "taskctl",
    "x-taskboard-user-id": "spoofed-user",
    "x-taskboard-user-name": "Spoofed User",
    "x-taskboard-user-avatar": "https://example.com/spoofed.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: agentHeaders,
    body: { title: "Created by Codex", threadId: "thread-agent-create" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "agent");
  assert.equal(task.creatorId, "codex-agent");
  assert.equal(task.creatorName, "Codex Agent");
  assert.equal(task.creatorAvatarUrl, null);
  assert.deepEqual(task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: agentHeaders,
    body: { body: "Implemented by Codex", threadId: "thread-agent-comment" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "agent");
  assert.equal(comment.authorId, "codex-agent");
  assert.equal(comment.authorName, "Codex Agent");
  assert.equal(comment.authorAvatarUrl, null);
  assert.equal(comment.threadId, "thread-agent-comment");
});

test("project standing authority is provenance-bound, idempotent, revocable, and projected into Capsules", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  let worktreePath;
  let escapedLinkPath;
  let outsideFile;
  let repositoryProbeCalls = 0;
  let failRepositoryProbe = false;
  const baseUrl = await startServer(async (directory) => {
    worktreePath = path.join(directory, "standing-authority-worktree");
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init", worktreePath]);
    await execFileAsync("git", ["-C", worktreePath, "checkout", "-b", "codex/standing-authority-test"]);
    await execFileAsync("git", ["-C", worktreePath, "remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
    outsideFile = path.join(directory, "outside.txt");
    escapedLinkPath = path.join(worktreePath, "escaped-link");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, escapedLinkPath);
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [{
        id: "root", label: "Standing Authority Root", owner: "Codex Root", source: "codex",
        threadId: rootThreadId, taskType: "root_task",
      }],
      adapters: [],
    });
    database.close();
    return {
      worktreeRepositoryTtlMs: 0,
      worktreeRepositoryExecFile: async (...args) => {
        repositoryProbeCalls += 1;
        if (failRepositoryProbe) throw new Error("temporary repository probe failure");
        return execFileAsync(...args);
      },
    };
  });
  const rootBinding = {
    threadId: rootThreadId,
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: worktreePath,
  };
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      projectId: "local",
      title: "Standing authority source",
      status: "todo",
      workflowProfile: "vibe",
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      developmentContext: {
        type: "worktree",
        path: rootBinding.workspacePath,
        branch: "codex/standing-authority-test",
      },
    },
  });
  assert.equal(created.response.status, 201);
  const task = created.body.task;
  const grantBody = {
    repository: "https://github.com/Owner/Repo.git",
    actions: ["edit", "test", "scoped_delete", "ordinary_push", "draft_pr"],
    sourceTaskId: task.identifier,
    sourceThreadId: rootBinding.threadId,
    evidence: "Owner granted standing authority in the confirmed Root window",
    receipt: "owner-turn:standing-authority:1",
    grantedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: null,
  };
  const granted = await request(baseUrl, "/api/projects/local/standing-authorities", {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: grantBody,
  });
  assert.equal(granted.response.status, 201);
  assert.equal(granted.body.created, true);
  assert.equal(granted.body.authority.repository, "github.com/owner/repo");
  assert.equal(granted.body.authority.sourceTaskId, task.id);
  assert.deepEqual(granted.body.authority.recordedBy, {
    type: "agent", id: "codex-agent", name: "Codex Agent",
  });

  const replay = await request(baseUrl, "/api/projects/local/standing-authorities", {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: grantBody,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.created, false);
  const conflict = await request(baseUrl, "/api/projects/local/standing-authorities", {
    method: "POST",
    body: { ...grantBody, actions: ["commit"] },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "STANDING_AUTHORITY_RECEIPT_CONFLICT");
  const wrongRoot = await request(baseUrl, "/api/projects/local/standing-authorities", {
    method: "POST",
    body: {
      ...grantBody,
      receipt: "owner-turn:standing-authority:wrong-root",
      sourceThreadId: "not-the-confirmed-root",
    },
  });
  assert.equal(wrongRoot.response.status, 409);
  assert.equal(wrongRoot.body.error.code, "STANDING_AUTHORITY_ROOT_MISMATCH");
  const futureGrant = await request(baseUrl, "/api/projects/local/standing-authorities", {
    method: "POST",
    body: {
      ...grantBody,
      receipt: "owner-turn:standing-authority:future",
      grantedAt: "2099-01-01T00:00:00.000Z",
    },
  });
  assert.equal(futureGrant.response.status, 400);

  const envelope = {
    repository: "github.com/owner/repo",
    useStandingAuthority: true,
    gates: [
      {
        id: "push", kind: "ordinary_push", state: "approval_required", scope: "origin branch",
        approver: "Owner", approvalRequest: "Approve ordinary push",
      },
      {
        id: "delete", kind: "scoped_delete", state: "approval_required", scope: "one declared file",
        approver: "Owner", approvalRequest: "Approve scoped delete",
      },
      {
        id: "edit", kind: "edit", state: "approval_required", scope: "one declared file",
        approver: "Owner", approvalRequest: "Approve edit",
      },
    ],
    actions: [
      {
        id: "push-branch", order: 1, text: "Push branch", gate: "push", target: "origin", status: "pending",
        standingScope: {
          kind: "ordinary_push", remote: "origin", branch: "codex/standing-authority-test", force: false,
        },
      },
      {
        id: "delete-link", order: 2, text: "Delete escaped link", gate: "delete", target: "escaped-link", status: "pending",
        standingScope: { kind: "scoped_delete", paths: ["escaped-link"], recursive: false },
      },
      {
        id: "edit-link", order: 3, text: "Edit escaped link", gate: "edit", target: "escaped-link", status: "pending",
        standingScope: { kind: "edit", paths: ["escaped-link"] },
      },
    ],
  };
  await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``,
      threadId: rootBinding.threadId,
    },
  });
  const capsule = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.equal(capsule.response.status, 200);
  assert.equal(repositoryProbeCalls, 3);
  const repeatedCapsule = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.equal(repeatedCapsule.response.status, 200);
  assert.equal(repositoryProbeCalls, 3);
  assert.deepEqual(
    capsule.body.capsule.readyWork.safeActions.map((action) => action.id),
    ["push-branch", "delete-link", "edit-link"],
    JSON.stringify(capsule.body.capsule, null, 2),
  );
  assert.deepEqual(
    capsule.body.capsule.standingAuthority.authorizedActionIds,
    ["push-branch", "delete-link", "edit-link"],
  );

  const escapedDeleteClaim = await request(baseUrl, `/api/tasks/${task.id}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: rootBinding.threadId,
      expectedResumeToken: capsule.body.capsule.resumeToken,
      safeActionId: "delete-link",
      reservationLeaseId: "escaped-delete-reservation",
    },
  });
  assert.equal(escapedDeleteClaim.response.status, 409);
  assert.equal(escapedDeleteClaim.body.error.code, "STANDING_SCOPE_MISMATCH");
  await access(escapedLinkPath);

  const escapedEditClaim = await request(baseUrl, `/api/tasks/${task.id}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: rootBinding.threadId,
      expectedResumeToken: capsule.body.capsule.resumeToken,
      safeActionId: "edit-link",
      reservationLeaseId: "escaped-edit-reservation",
    },
  });
  assert.equal(escapedEditClaim.response.status, 409);
  assert.equal(escapedEditClaim.body.error.code, "STANDING_SCOPE_MISMATCH");

  const laneSnapshot = await request(baseUrl, "/api/local/projects/local/agent-lanes");
  assert.equal(laneSnapshot.response.status, 200);
  const standingTodo = laneSnapshot.body.todos.find((todo) => todo.taskId === task.id);
  assert.equal(standingTodo?.readyWork.safeActions[0]?.standingAuthority, true);
  let validatedIdentity = null;
  const monitorResult = await runTaskboardContinuationMonitorOnce({
    policy: { enabled: true, projectId: "local" },
    readSnapshot: async () => laneSnapshot.body,
    claimReceipt: async (claim) => {
      const result = await request(baseUrl, `/api/tasks/${claim.todoId}/bootstrap-claim`, {
        method: "POST",
        body: {
          rootThreadId: claim.rootThreadId,
          expectedResumeToken: claim.expectedResumeToken,
          safeActionId: claim.safeActionId,
          reservationLeaseId: "standing-reservation",
        },
      });
      assert.equal(result.response.status, 200);
      return result.body;
    },
    confirmDelivery: async (delivery) => {
      const result = await request(baseUrl, `/api/tasks/${delivery.todoId}/bootstrap-delivery`, {
        method: "POST",
        body: {
          rootThreadId: delivery.rootThreadId,
          expectedResumeToken: delivery.expectedResumeToken,
          safeActionId: delivery.safeActionId,
          reservationLeaseId: delivery.deliveryReceipt.reservationLeaseId,
        },
      });
      assert.equal(result.response.status, 200);
      return result.body.executionIdentity;
    },
    deliver: (delivery) => deliverTaskboardCoordination(
      delivery,
      async (method) => {
        if (method === "thread/read") {
          return { thread: { id: rootBinding.threadId, cwd: rootBinding.workspacePath, turns: [{ id: "active-turn", status: "inProgress" }] } };
        }
        if (method === "turn/steer") return {};
        throw new Error(`Unexpected RPC method: ${method}`);
      },
      async (targetRoot, executionIdentity) => {
        assert.equal(targetRoot, worktreePath);
        validatedIdentity = executionIdentity;
      },
    ),
    completeDelivery: async (delivery, rootDelivery) => (await request(
      baseUrl,
      `/api/tasks/${delivery.todoId}/bootstrap-complete`,
      {
        method: "POST",
        body: {
          rootThreadId: delivery.rootThreadId,
          expectedResumeToken: delivery.expectedResumeToken,
          safeActionId: delivery.safeActionId,
          reservationLeaseId: delivery.deliveryReceipt.reservationLeaseId,
          recoveryLeaseId: delivery.recoveryLeaseId,
          deliveryTurnId: rootDelivery.turnId,
        },
      },
    )).body,
  });
  assert.deepEqual(monitorResult, {
    delivered: true,
    todoId: task.identifier,
    actionId: "push-branch",
  });
  assert.equal(validatedIdentity?.standingAuthority, true);
  assert.equal(validatedIdentity?.repository, "github.com/owner/repo");
  assert.equal(validatedIdentity?.branch, "codex/standing-authority-test");
  assert.deepEqual(validatedIdentity?.standingScope, {
    kind: "ordinary_push", remote: "origin", branch: "codex/standing-authority-test", force: false,
  });

  const editablePath = path.join(worktreePath, "editable.txt");
  await writeFile(editablePath, "inside", "utf8");
  const editTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      projectId: "local",
      title: "Edit path swap task",
      status: "todo",
      workflowProfile: "vibe",
      threadId: rootBinding.threadId,
      threadBinding: rootBinding,
      developmentContext: {
        type: "worktree", path: worktreePath, branch: "codex/standing-authority-test",
      },
    },
  });
  const editTask = editTaskResult.body.task;
  await request(baseUrl, `/api/tasks/${editTask.id}/comments`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        repository: "github.com/owner/repo",
        useStandingAuthority: true,
        gates: [{
          id: "edit", kind: "edit", state: "approval_required", scope: "one file",
          approver: "Owner", approvalRequest: "Approve edit",
        }],
        actions: [{
          id: "edit-file", order: 1, text: "Edit file", gate: "edit", target: "editable.txt", status: "pending",
          standingScope: { kind: "edit", paths: ["editable.txt"] },
        }],
      })}\n\`\`\``,
      threadId: rootBinding.threadId,
    },
  });
  const editCapsule = (await request(baseUrl, `/api/tasks/${editTask.id}/capsule`)).body.capsule;
  const editClaim = await request(baseUrl, `/api/tasks/${editTask.id}/bootstrap-claim`, {
    method: "POST",
    body: {
      rootThreadId: rootBinding.threadId,
      expectedResumeToken: editCapsule.resumeToken,
      safeActionId: "edit-file",
      reservationLeaseId: "edit-file-reservation",
    },
  });
  assert.equal(editClaim.response.status, 200);
  await unlink(editablePath);
  await symlink(outsideFile, editablePath);
  const swappedEditDelivery = await request(baseUrl, `/api/tasks/${editTask.id}/bootstrap-delivery`, {
    method: "POST",
    body: {
      rootThreadId: rootBinding.threadId,
      expectedResumeToken: editCapsule.resumeToken,
      safeActionId: "edit-file",
      reservationLeaseId: "edit-file-reservation",
    },
  });
  assert.equal(swappedEditDelivery.response.status, 409);
  assert.equal(swappedEditDelivery.body.error.code, "STANDING_SCOPE_MISMATCH");

  await execFileAsync("git", ["-C", worktreePath, "remote", "set-url", "origin", "git@github.com:Company/Other.git"]);
  const changedRemoteDelivery = await request(baseUrl, `/api/tasks/${task.id}/bootstrap-delivery`, {
    method: "POST",
    body: {
      rootThreadId: rootBinding.threadId,
      expectedResumeToken: capsule.body.capsule.resumeToken,
      safeActionId: "push-branch",
      reservationLeaseId: "standing-reservation",
    },
  });
  assert.equal(changedRemoteDelivery.response.status, 409);
  assert.equal(changedRemoteDelivery.body.error.code, "RESUME_TOKEN_MISMATCH");

  failRepositoryProbe = true;
  const failedProjection = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.equal(failedProjection.response.status, 200);
  assert.equal(failedProjection.body.capsule.executionTarget.repository ?? null, null);
  assert.deepEqual(failedProjection.body.capsule.readyWork.safeActions, []);
  failRepositoryProbe = false;
  await execFileAsync("git", ["-C", worktreePath, "remote", "set-url", "origin", "git@github.com:Owner/Repo.git"]);
  const recoveredProjection = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.equal(recoveredProjection.response.status, 200);
  assert.equal(recoveredProjection.body.capsule.standingAuthority.state, "matched");
  assert.deepEqual(
    recoveredProjection.body.capsule.readyWork.safeActions.map((action) => action.id),
    ["push-branch", "delete-link", "edit-link"],
  );

  const authorityId = granted.body.authority.id;
  const revokeBody = { evidence: "Owner revoked standing authority", receipt: "owner-turn:standing-authority:2" };
  const revoked = await request(baseUrl, `/api/projects/local/standing-authorities/${authorityId}/revoke`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: revokeBody,
  });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.changed, true);
  const revokeReplay = await request(baseUrl, `/api/projects/local/standing-authorities/${authorityId}/revoke`, {
    method: "POST",
    headers: { "x-taskboard-client": "taskctl" },
    body: revokeBody,
  });
  assert.equal(revokeReplay.response.status, 200);
  assert.equal(revokeReplay.body.changed, false);
  const revokeConflict = await request(baseUrl, `/api/projects/local/standing-authorities/${authorityId}/revoke`, {
    method: "POST",
    body: { ...revokeBody, evidence: "Different revocation" },
  });
  assert.equal(revokeConflict.response.status, 409);
  assert.equal(revokeConflict.body.error.code, "STANDING_AUTHORITY_RECEIPT_CONFLICT");
  const repositoryProbeCallsBeforeRevokedProjection = repositoryProbeCalls;
  const revokedCapsule = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.deepEqual(revokedCapsule.body.capsule.readyWork.safeActions, []);
  assert.equal(
    repositoryProbeCalls,
    repositoryProbeCallsBeforeRevokedProjection,
    "ordinary Capsule projection must reuse the recorded repository after policy changes",
  );
});

test("Codex-hosted user mutations persist the current account identity and avatar", async () => {
  const baseUrl = await startServer();
  const userHeaders = {
    "x-taskboard-user-id": "test-user",
    "x-taskboard-user-name": "Test%20User",
    "x-taskboard-user-avatar": "https://example.com/test-user.png",
  };
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: userHeaders,
    body: { title: "Created in Codex UI" },
  });
  assert.equal(createTaskResult.response.status, 201);
  const task = createTaskResult.body.task;
  assert.equal(task.creatorType, "user");
  assert.equal(task.creatorId, "test-user");
  assert.equal(task.creatorName, "Test User");
  assert.equal(task.creatorAvatarUrl, "https://example.com/test-user.png");
  assert.deepEqual(task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const assignedToCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: task.version,
      assigneeTarget: "codex-agent",
    },
  });
  assert.equal(assignedToCodexResult.response.status, 200);
  assert.deepEqual(assignedToCodexResult.body.task.assignee, {
    type: "agent",
    id: "codex-agent",
    name: "Codex Agent",
    avatarUrl: null,
  });

  const assignedToUserResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: assignedToCodexResult.body.task.version,
      assigneeTarget: "current-user",
    },
  });
  assert.equal(assignedToUserResult.response.status, 200);
  assert.deepEqual(assignedToUserResult.body.task.assignee, {
    type: "user",
    id: "test-user",
    name: "Test User",
    avatarUrl: "https://example.com/test-user.png",
  });

  const updatedByCodexResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "x-taskboard-client": "taskctl" },
    body: {
      version: assignedToUserResult.body.task.version,
      title: "Updated through taskctl",
    },
  });
  assert.equal(updatedByCodexResult.response.status, 200);
  assert.deepEqual(updatedByCodexResult.body.task.assignee, assignedToUserResult.body.task.assignee);

  const invalidAssigneeResult = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: {
      version: updatedByCodexResult.body.task.version,
      assigneeTarget: { type: "agent" },
    },
  });
  assert.equal(invalidAssigneeResult.response.status, 400);
  assert.equal(invalidAssigneeResult.body.error.code, "INVALID_FIELD");

  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    headers: userHeaders,
    body: { body: "Commented in Codex UI" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.authorType, "user");
  assert.equal(comment.authorId, "test-user");
  assert.equal(comment.authorName, "Test User");
  assert.equal(comment.authorAvatarUrl, "https://example.com/test-user.png");
});

test("issue attachments can be uploaded, listed, opened, downloaded, and deleted", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Attach files" },
  });
  const task = createTaskResult.body.task;

  const emptyList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.equal(emptyList.response.status, 200);
  assert.deepEqual(emptyList.body.attachments, []);

  const contents = "attachment contents\n";
  const uploadResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-taskboard-filename": encodeURIComponent("设计说明.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, null);
  assert.equal(attachment.filename, "设计说明.txt");
  assert.equal(attachment.contentType, "text/plain");
  assert.equal(attachment.size, Buffer.byteLength(contents));
  assert.match(attachment.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const listResult = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(listResult.body.attachments, [attachment]);

  const contentResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("content-type"), "text/plain");
  assert.match(contentResponse.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);
  assert.equal(await contentResponse.text(), contents);

  const headResponse = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(Number(headResponse.headers.get("content-length")), Buffer.byteLength(contents));
  assert.equal(await headResponse.text(), "");

  const htmlUpload = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/html",
      "x-taskboard-filename": encodeURIComponent("page.html"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "<script>document.body.textContent = 'unsafe'</script>",
  });
  const htmlAttachment = htmlUpload.body.attachment;
  const htmlContent = await fetch(`${baseUrl}/api/attachments/${htmlAttachment.id}/content`);
  assert.equal(htmlContent.headers.get("content-type"), "application/octet-stream");
  assert.match(htmlContent.headers.get("content-disposition"), /^attachment;/);
  assert.equal(htmlContent.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const htmlDelete = await request(baseUrl, `/api/attachments/${htmlAttachment.id}`, { method: "DELETE" });
  assert.equal(htmlDelete.response.status, 204);

  const deleteResult = await request(baseUrl, `/api/attachments/${attachment.id}`, { method: "DELETE" });
  assert.equal(deleteResult.response.status, 204);
  const finalList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(finalList.body.attachments, []);
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  assert.equal(deletedContent.body.error.code, "ATTACHMENT_NOT_FOUND");
});

test("permanent task deletion requires archiving and removes attachment files", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-delete-project", name: "Delete project", workspacePath: null },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "temp-delete-project", title: "Delete permanently" },
  });
  const task = created.body.task;
  const uploaded = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "evidence.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment",
  });
  assert.equal(uploaded.response.status, 201);
  const comment = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "Comment with attachment" },
  });
  assert.equal(comment.response.status, 201);
  const commentUpload = await request(
    baseUrl,
    `/api/comments/${comment.body.comment.id}/attachments`,
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "comment-evidence.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "comment attachment",
    },
  );
  assert.equal(commentUpload.response.status, 201);
  const attachmentIds = [uploaded.body.attachment.id, commentUpload.body.attachment.id];
  const storagePaths = attachmentIds.map((attachmentId) => path.join(
    runningApps.at(-1).app.options.attachmentsDirectory,
    attachmentId,
  ));
  await Promise.all(storagePaths.map((storagePath) => access(storagePath)));

  const activeDelete = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: task.version },
  });
  assert.equal(activeDelete.response.status, 409);
  assert.equal(activeDelete.body.error.code, "TASK_NOT_ARCHIVED");

  const archived = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });
  const deleted = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: archived.body.task.version },
  });
  assert.equal(deleted.response.status, 204);
  await Promise.all(storagePaths.map((storagePath) => (
    assert.rejects(access(storagePath), { code: "ENOENT" })
  )));
  assert.equal((await request(baseUrl, `/api/tasks/${task.id}`)).response.status, 404);
  const database = runningApps.at(-1).app.database.database;
  assert.equal(database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id), undefined);
  assert.equal(
    database.prepare("SELECT 1 FROM comments WHERE id = ?").get(comment.body.comment.id),
    undefined,
  );
  const attachmentExists = database.prepare("SELECT 1 FROM attachments WHERE id = ?");
  for (const attachmentId of attachmentIds) {
    assert.equal(attachmentExists.get(attachmentId), undefined);
  }
  assert.equal((await request(baseUrl, "/api/projects/temp-delete-project", {
    method: "DELETE",
  })).response.status, 204);
});

test("comments support attachments and deleting a comment removes its files", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Comment files" },
  });
  const task = createTaskResult.body.task;
  const createCommentResult = await request(baseUrl, `/api/tasks/${task.id}/comments`, {
    method: "POST",
    body: { body: "", threadId: "thread-attachment" },
  });
  assert.equal(createCommentResult.response.status, 201);
  const comment = createCommentResult.body.comment;
  assert.equal(comment.body, "");

  const contents = "comment attachment\n";
  const uploadResult = await request(baseUrl, `/api/comments/${comment.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("comment.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: contents,
  });
  assert.equal(uploadResult.response.status, 201);
  const attachment = uploadResult.body.attachment;
  assert.equal(attachment.taskId, task.id);
  assert.equal(attachment.commentId, comment.id);

  const attachmentList = await request(baseUrl, `/api/comments/${comment.id}/attachments`);
  assert.deepEqual(attachmentList.body.attachments, [attachment]);
  const commentList = await request(baseUrl, `/api/tasks/${task.id}/comments`);
  assert.deepEqual(commentList.body.comments[0].attachments, [attachment]);
  const taskAttachmentList = await request(baseUrl, `/api/tasks/${task.id}/attachments`);
  assert.deepEqual(taskAttachmentList.body.attachments, []);

  const storagePath = path.join(runningApps.at(-1).app.options.attachmentsDirectory, attachment.id);
  await access(storagePath);
  const deleteResult = await request(baseUrl, `/api/comments/${comment.id}`, {
    method: "DELETE",
    body: { version: comment.version, threadId: "thread-delete-comment" },
  });
  assert.equal(deleteResult.response.status, 204);
  await assert.rejects(access(storagePath), { code: "ENOENT" });
  const deletedContent = await request(baseUrl, `/api/attachments/${attachment.id}/content`);
  assert.equal(deletedContent.response.status, 404);
  const taskAfterDelete = await request(baseUrl, `/api/tasks/${task.id}`);
  assert.equal(taskAfterDelete.body.task.threadId, null);
});

test("attachment uploads reject unsafe filenames", async () => {
  const baseUrl = await startServer();
  const createTaskResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Validate attachments" },
  });
  const task = createTaskResult.body.task;

  const result = await request(baseUrl, `/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("../outside.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "unsafe",
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "INVALID_FILENAME");
});

test("request boundaries reject unknown fields and invalid values", async () => {
  const baseUrl = await startServer();

  const unknown = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", unexpected: true },
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

  const invalid = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Invalid", status: "started" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_FIELD");
  assert.match(invalid.body.error.message, /in_review/);
  assert.match(invalid.body.error.message, /blocked/);
  assert.match(invalid.body.error.message, /canceled/);

  const invalidWorktree = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      title: "Invalid",
      developmentContext: { type: "worktree", path: "/tmp/bad\0path", branch: null },
    },
  });
  assert.equal(invalidWorktree.response.status, 400);
  assert.equal(invalidWorktree.body.error.code, "INVALID_FIELD");
});

test("task changes from one LAN client are broadcast to another client", async () => {
  const baseUrl = await startServer(undefined, { host: "0.0.0.0" });
  const lanHeaders = {
    host: "192.168.1.24:47823",
    origin: "http://192.168.1.24:47823",
  };
  const eventResponse = await fetch(`${baseUrl}/api/events`, { headers: lanHeaders });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: lanHeaders,
    body: { title: "Broadcast me" },
  });
  assert.equal(createResult.response.status, 201);

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.created/);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.type, "task.created");
  assert.equal(event.task.id, createResult.body.task.id);

  const listResult = await request(baseUrl, "/api/tasks?projectId=local", {
    headers: lanHeaders,
  });
  assert.equal(listResult.response.status, 200);
  assert.equal(listResult.body.tasks.some((task) => task.id === createResult.body.task.id), true);
  await reader.cancel();
});
