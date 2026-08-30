import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { createTaskboardServer, resolveHost } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import {
  deliverTaskboardCoordination,
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

test("Agent Lane snapshot reserves its internal task id and delivers one background continuation", async () => {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  let task;
  const baseUrl = await startServer(async (directory) => {
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
    return {};
  });

  const deliveries = [];
  const options = {
    policy: { enabled: true, projectId: "local" },
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
          },
        },
      );
      assert.equal(reservation.response.status, 200);
      assert.equal(reservation.body.receipt.taskId, claim.taskId);
      return reservation.body.reused === false;
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
          },
        },
      );
      assert.equal(confirmation.response.status, 200);
      return confirmation.body.executionIdentity;
    },
    deliver: async (delivery) => {
      deliveries.push(delivery);
      return { delivery: "started", turnId: "turn-background" };
    },
  };

  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: true,
    todoId: task.identifier,
    actionId: "continue",
  });
  assert.deepEqual(await runTaskboardContinuationMonitorOnce(options), {
    delivered: false,
    reason: "reservation-unavailable",
  });
  assert.equal(deliveries.length, 1);
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
  assert.equal(result.body.version, 4);
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
  const instanceSecret = "b".repeat(64);
  let task;
  let dataDirectory;
  let baseUrl = await startServer(async (directory) => {
    dataDirectory = directory;
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [{
        id: "root", label: "Root", owner: "Codex Root", source: "codex",
        threadId: rootThreadId, taskType: "root_task",
      }],
      adapters: [],
      coordinatorLease: {
        id: "owner-decision-lease",
        holderTaskId: "root",
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
      holderTaskId: "root",
      holderThreadId: rootThreadId,
      expectedLeaseId: "owner-decision-lease",
      leaseDurationSeconds: 60,
    },
  });
  assert.equal(renewedDuringDecision.response.status, 200);

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
    UPDATE owner_decision_deliveries SET delivered_at = ? WHERE id = ?
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
  const baseUrl = await startServer(async (directory) => {
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    database.upsertAgentLaneProject("local", {
      rootTaskId: "root",
      tasks: [
        { id: "root", label: "Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task" },
        { id: "visual", label: "Visual", owner: "Codex Visual", source: "codex", threadId: "visual-thread", taskType: "peer_task" },
      ],
      adapters: [],
    });
    database.close();
    return {};
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

  const renewed = await request(baseUrl, "/api/local/projects/local/coordinator-lease", {
    method: "POST",
    body: {
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      expectedLeaseId: acquired.body.lease.id,
      leaseDurationSeconds: 120,
    },
  });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.body.lease.id, acquired.body.lease.id);
  assert.equal(renewed.body.lease.acquiredAt, acquired.body.lease.acquiredAt);
  assert.ok(renewed.body.lease.expiresAt > acquired.body.lease.expiresAt);
  assert.equal(renewed.body.receipt.action, "renewed");

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

test("Talking Window inbox delivery is durable and idempotent without interrupting active execution", async () => {
  const baseUrl = await startServer(async (directory) => {
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
        'legacy-task', 'LOCAL-1', 'local', 'Legacy task', '', 'todo', 'none', '[]', 1000,
        'legacy-thread', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1,
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

  let version = result.body.task.version;
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
  const baseUrl = await startServer();
  const runtime = await request(baseUrl, "/api/local/host-runtime", {
    method: "PUT",
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
    return {};
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
        },
      });
      assert.equal(result.response.status, 200);
      return result.body.reused === false;
    },
    confirmDelivery: async (delivery) => {
      const result = await request(baseUrl, `/api/tasks/${delivery.todoId}/bootstrap-delivery`, {
        method: "POST",
        body: {
          rootThreadId: delivery.rootThreadId,
          expectedResumeToken: delivery.expectedResumeToken,
          safeActionId: delivery.safeActionId,
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
    },
  });
  assert.equal(changedRemoteDelivery.response.status, 409);
  assert.equal(changedRemoteDelivery.body.error.code, "RESUME_TOKEN_MISMATCH");

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
  const revokedCapsule = await request(baseUrl, `/api/tasks/${task.id}/capsule`);
  assert.deepEqual(revokedCapsule.body.capsule.readyWork.safeActions, []);
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
