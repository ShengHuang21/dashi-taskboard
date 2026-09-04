import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { createAgentLaneSnapshotProvider } from "../server/agent-lane-snapshot.mjs";
import { defaultIsPathCaseSensitive, TaskboardDatabase } from "../server/database.mjs";
import {
  observeTaskboardOwnerIntentPlan,
  runOwnerIntentPlanningMonitorOnce,
  runTaskboardContinuationMonitorOnce,
} from "../scripts/codex-injector-runtime.mjs";

const directories = [];
const actor = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-coordination-"));
  directories.push(directory);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "capstone-dev", name: "Capstone Dev", workspacePath: null });
  database.upsertAgentLaneProject("capstone-dev", {
    rootTaskId: "root",
    tasks: [{
      id: "root", label: "Capstone Root", owner: "Codex", source: "codex",
      threadId: "root-thread", taskType: "root_task",
    }],
    adapters: [],
  });
  const rootBinding = {
    threadId: "root-thread",
    codexProjectId: "capstone-dev",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/tmp/agent-coordination-worktree",
  };
  const developmentContext = {
    type: "worktree",
    path: rootBinding.workspacePath,
    branch: "codex/agent-coordination",
  };
  const task = database.createTask({
    projectId: "capstone-dev", title: "验证真实交接", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: rootBinding.threadId, threadBinding: rootBinding,
    actor, assignee: actor, workflowId: null, developmentContext, startDate: null, dueDate: null, recurrence: null,
  });
  const sessionsDirectory = path.join(directory, "sessions", "2026", "08", "24");
  await mkdir(sessionsDirectory, { recursive: true });
  const rootFile = path.join(sessionsDirectory, "rollout-root-thread.jsonl");
  await writeFile(rootFile, `${JSON.stringify({ timestamp: "2026-08-24T01:00:00.000Z", type: "session_meta", payload: { session_id: "root-thread" } })}\n`);
  const makeProvider = (db) => createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => db.getAgentLaneProject(projectId),
    listTasks: (projectId) => db.listTasks({ projectId, archived: "false" }),
    getClaim: (taskId) => db.getAgentTaskClaim(taskId),
    getTaskCapsule: (taskId) => db.getTaskCapsule(taskId),
    listComments: (taskId) => db.listComments(taskId),
    recordProgress: (progress) => db.recordAgentTaskProgress(task.id, { ...progress, actor }),
    recordCompletion: (completion) => db.completeAgentTask(task.id, { ...completion, actor }),
  });
  return { database, databasePath, task, rootFile, rootBinding, developmentContext, makeProvider };
}

test("uses durable Taskboard To-Dos and persists one complete Sub-Agent handoff", async () => {
  const fixture = await setup();
  let provider = fixture.makeProvider(fixture.database);
  let snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.deepEqual(snapshot.todos.map((todo) => todo.id), [fixture.task.identifier]);
  assert.equal(snapshot.todos[0].state, "blocked");

  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/agent-lane-snapshot.mjs"],
  });
  assert.equal(claimed.task.status, "in_progress");
  await appendFile(fixture.rootFile, [
    JSON.stringify({ timestamp: "2098-01-01T01:01:00.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "acceptance-thread", agent_path: "/root/acceptance", kind: "started" } }),
    JSON.stringify({ timestamp: "2098-01-01T01:01:30.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/acceptance", recipient: "/root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nPayload: Focused checks are running. token=progress-secret" }] } }),
  ].join("\n") + "\n");

  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 1 });
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  let comments = fixture.database.listComments(fixture.task.id);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^Sub-Agent 进展：/);
  assert.match(comments[0].body, /Focused checks are running/);
  assert.doesNotMatch(comments[0].body, /progress-secret/);
  assert.equal(fixture.database.listCommentsAfter(fixture.task.id, { revision: 0 }).length, 1);
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_progress");

  await appendFile(fixture.rootFile, [
    JSON.stringify({ timestamp: "2098-01-01T01:02:00.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/acceptance", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload: Focused checks passed. token=must-not-leak AKIAABCDEFGHIJKLMNOP https://user:password@example.com/ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] } }),
  ].join("\n") + "\n");

  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 1 });
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.rootSubagents[0].lifecycleStatus, "completed");
  assert.equal(snapshot.todos[0].state, "validating");
  comments = fixture.database.listComments(fixture.task.id);
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /^Sub-Agent 完成：/);
  assert.match(comments[1].body, /Focused checks passed/);
  assert.doesNotMatch(comments[1].body, /must-not-leak/);
  assert.doesNotMatch(comments[1].body, /AKIA|user:password|ABCDEFGHIJKLMNOPQRSTUVWXYZ|b{40}/);
  assert.equal(comments[1].threadId, "acceptance-thread");
  assert.equal(fixture.database.listCommentsAfter(fixture.task.id, { revision: 0 }).length, 2);

  fixture.database.close();
  const reopened = new TaskboardDatabase(fixture.databasePath);
  provider = fixture.makeProvider(reopened);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  assert.equal(reopened.listComments(fixture.task.id).length, 2);
  assert.equal(reopened.getTask(fixture.task.id).status, "in_review");
  reopened.close();
});

test("legacy bootstrap receipts migrate fail-closed instead of becoming reclaimable", async () => {
  const fixture = await setup();
  const token = "9".repeat(64);
  fixture.database.close();
  const legacy = new DatabaseSync(fixture.databasePath);
  legacy.exec("DROP TABLE task_safe_action_receipts");
  legacy.exec(`
    CREATE TABLE task_safe_action_receipts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      resume_token TEXT NOT NULL,
      safe_action_id TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      UNIQUE(task_id, resume_token)
    )
  `);
  legacy.prepare(`
    INSERT INTO task_safe_action_receipts (
      id, task_id, project_id, resume_token, safe_action_id, root_thread_id, claimed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-receipt", fixture.task.id, "capstone-dev", token, "test", "root-thread", "2026-08-30T00:00:00.000Z");
  legacy.close();

  const migrated = new TaskboardDatabase(fixture.databasePath);
  const row = migrated.database.prepare(`
    SELECT status, reservation_lease_id, lease_expires_at
    FROM task_safe_action_receipts WHERE id = ?
  `).get("legacy-receipt");
  assert.equal(row.status, "legacy");
  assert.equal(row.reservation_lease_id, null);
  assert.equal(row.lease_expires_at, null);
  migrated.close();
});

test("legacy fixed-root receipt cannot cross into a later same-thread Global lease", async () => {
  const fixture = await setup();
  const legacyTask = fixture.database.createTask({
    projectId: "capstone-dev", title: "Legacy transition", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: fixture.rootBinding.threadId,
    threadBinding: fixture.rootBinding, actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: fixture.developmentContext, startDate: null, dueDate: null, recurrence: null,
  });
  fixture.database.createComment(legacyTask.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "authorized", kind: "test", state: "authorized", scope: "legacy transition",
        approver: "Owner", approvalRequest: "同意", evidence: "Owner resumed", receipt: "turn:legacy",
      }],
      actions: [{ id: "execute", order: 10, text: "Legacy transition", gate: "authorized", target: "candidate", status: "pending" }],
    })}\n\`\`\``,
    threadId: fixture.rootBinding.threadId, threadBinding: fixture.rootBinding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });
  const capsule = fixture.database.getTaskCapsule(legacyTask.id);
  const reservation = fixture.database.claimTaskSafeAction(legacyTask.id, {
    rootThreadId: fixture.rootBinding.threadId, expectedResumeToken: capsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "legacy-reservation",
  });
  assert.equal(reservation.receipt.globalCoordinatorLeaseId, null);
  const receiptBefore = fixture.database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(reservation.receipt.id);
  const taskBefore = fixture.database.getTask(legacyTask.id);
  fixture.database.upsertAgentLaneProject("capstone-dev", {
    tasks: [{
      id: "root", label: "Capstone Root", owner: "Codex", source: "codex",
      threadId: fixture.rootBinding.threadId, taskType: "root_task",
      codexHostId: fixture.rootBinding.codexHostId, workspacePath: fixture.rootBinding.workspacePath,
    }],
    adapters: [],
    coordinatorLease: {
      id: "global-after-legacy", holderTaskId: "root",
      holderThreadId: fixture.rootBinding.threadId,
      holderCodexHostId: fixture.rootBinding.codexHostId,
      holderWorkspacePath: fixture.rootBinding.workspacePath,
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  assert.throws(() => fixture.database.confirmTaskSafeActionDelivery(legacyTask.id, {
    rootThreadId: fixture.rootBinding.threadId, expectedResumeToken: capsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "legacy-reservation",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.throws(() => fixture.database.claimTaskSafeAction(legacyTask.id, {
    rootThreadId: fixture.rootBinding.threadId, expectedResumeToken: capsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "global-reservation",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.deepEqual(fixture.database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(reservation.receipt.id), receiptBefore);
  assert.deepEqual(fixture.database.getTask(legacyTask.id), taskBefore);
  assert.equal(fixture.database.getAgentTaskClaim(legacyTask.id), null);
  assert.equal(fixture.database.getActiveTaskAgentRun(legacyTask.id), null);
  fixture.database.close();
});

test("active Global and domain leases fail closed after their configured window bindings drift", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lease-route-drift-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "route-drift", name: "Route drift", workspacePath: null });
  const acquiredAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const ownerBinding = {
    threadId: "owner-thread", codexProjectId: "route-drift", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/route-drift-owner",
  };
  const configured = {
    rootTaskId: "global",
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/route-drift-owner" },
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/route-drift-global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/route-drift-frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "route-global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/route-drift-global",
      acquiredAt, expiresAt,
    },
    coordinationDomains: [{
      id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
    }],
    domainCoordinatorLeases: {
      frontend: {
        id: "route-frontend-lease", domainId: "frontend", holderTaskId: "frontend",
        holderThreadId: "frontend-thread", holderCodexHostId: "local",
        holderWorkspacePath: "/tmp/route-drift-frontend", acquiredAt, expiresAt,
        writeScope: ["web"],
      },
    },
  };
  const invalidExpiredAt = new Date(Date.now() - 60_000).toISOString();
  const invalidLifetime = {
    ...configured,
    coordinatorLease: {
      ...configured.coordinatorLease,
      id: "invalid-global-lifetime",
      acquiredAt: invalidExpiredAt,
      expiresAt: invalidExpiredAt,
    },
    domainCoordinatorLeases: {
      frontend: {
        ...configured.domainCoordinatorLeases.frontend,
        id: "invalid-domain-lifetime",
        acquiredAt: invalidExpiredAt,
        expiresAt: invalidExpiredAt,
      },
    },
  };
  database.upsertAgentLaneProject("route-drift", invalidLifetime);
  assert.throws(() => database.claimAgentLaneCoordinator("route-drift", {
    holderTaskId: "global", holderThreadId: "global-thread", holderCodexHostId: "local",
    holderWorkspacePath: "/tmp/route-drift-global", expectedLeaseId: "invalid-global-lifetime",
    leaseDurationSeconds: 120, renewOnly: false, recoverOnly: true,
  }), (error) => error?.code === "COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE");
  assert.throws(() => database.claimAgentLaneDomainCoordinator("route-drift", "frontend", {
    holderTaskId: "frontend", holderThreadId: "frontend-thread", holderCodexHostId: "local",
    holderWorkspacePath: "/tmp/route-drift-frontend", expectedLeaseId: "invalid-domain-lifetime",
    leaseDurationSeconds: 120, renewOnly: false, recoverOnly: true,
  }), (error) => error?.code === "DOMAIN_COORDINATOR_LEASE_RECOVERY_NOT_AVAILABLE");
  const futureAcquiredAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const futureExpiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const futureConfig = {
    ...configured,
    coordinatorLease: {
      ...configured.coordinatorLease,
      id: "future-global-lease",
      acquiredAt: futureAcquiredAt,
      expiresAt: futureExpiresAt,
    },
    domainCoordinatorLeases: {
      frontend: {
        ...configured.domainCoordinatorLeases.frontend,
        id: "future-domain-lease",
        acquiredAt: futureAcquiredAt,
        expiresAt: futureExpiresAt,
      },
    },
  };
  database.upsertAgentLaneProject("route-drift", futureConfig);
  assert.throws(() => database.claimAgentLaneCoordinator("route-drift", {
    holderTaskId: "global", holderThreadId: "global-thread",
    expectedLeaseId: "future-global-lease", leaseDurationSeconds: 120,
  }), (error) => error?.code === "COORDINATOR_BINDING_MISMATCH");
  assert.throws(() => database.claimAgentLaneDomainCoordinator("route-drift", "frontend", {
    holderTaskId: "frontend", holderThreadId: "frontend-thread",
    expectedLeaseId: "future-domain-lease", leaseDurationSeconds: 120,
  }), (error) => error?.code === "DOMAIN_COORDINATOR_BINDING_MISMATCH");
  assert.equal(database.listAgentLaneCoordinatorReceipts("route-drift").length, 0);
  assert.equal(database.listAgentLaneDomainCoordinatorReceipts("route-drift", "frontend").length, 0);
  database.upsertAgentLaneProject("route-drift", configured);
  const createTodo = (title) => database.createTask({
    projectId: "route-drift", title, description: "", status: "todo", priority: "high",
    labels: ["agent-todo"], workflowProfile: "vibe", threadId: ownerBinding.threadId,
    threadBinding: ownerBinding, actor, assignee: actor,
    developmentContext: { type: "worktree", path: "/tmp/route-drift-product", branch: "codex/route-drift" },
    workingLog: null, startDate: null, dueDate: null, recurrence: null,
  });
  const assignedTodo = createTodo("Assigned before drift");
  database.setAgentTaskDomain("route-drift", assignedTodo.id, {
    taskVersion: assignedTodo.version, domainId: "frontend",
    holderTaskId: "global", holderThreadId: "global-thread",
    expectedCoordinatorLeaseId: "route-global-lease",
  });
  const unassignedTodo = createTodo("Protected after drift");
  database.createComment(unassignedTodo.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{ id: "test", kind: "test", state: "authorized", scope: "route drift", approver: "Owner", approvalRequest: "同意", evidence: "Owner turn", receipt: "turn:route-drift" }],
      actions: [{ id: "test", order: 10, text: "Run protected test", gate: "test", target: "candidate", status: "pending" }],
    })}\n\`\`\``,
    threadId: ownerBinding.threadId, threadBinding: ownerBinding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });
  database.recordProjectOwnerIntent("route-drift", {
    intentId: "route-drift-intent", deliveryId: "route-drift-delivery", kind: "append",
    goal: "Preserve the exact lease route", constraints: [], targetIntentId: null,
    ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
    ownerTurnId: "owner-turn", rootCaptureTurnId: "capture-turn", evidence: "synthetic",
  }, ownerBinding, actor);
  const exactLeaseCapsule = database.getTaskCapsule(unassignedTodo.id);

  database.upsertAgentLaneProject("route-drift", {
    ...configured,
    tasks: configured.tasks.map((lane) => lane.id === "global"
      ? { ...lane, threadId: "global-drifted", codexHostId: "host-drifted", workspacePath: "/tmp/global-drifted" }
      : lane.id === "frontend"
        ? { ...lane, threadId: "frontend-drifted", codexHostId: "host-drifted", workspacePath: "/tmp/frontend-drifted" }
        : lane),
  });

  assert.equal(database.getAgentTaskDomainRoute(assignedTodo.id).status, "needs_coordinator");
  assert.throws(() => database.setAgentTaskDomain("route-drift", unassignedTodo.id, {
    taskVersion: unassignedTodo.version, domainId: "frontend",
    holderTaskId: "global", holderThreadId: "global-drifted",
    expectedCoordinatorLeaseId: "route-global-lease",
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.claimProjectOwnerIntentAdoption("route-drift", "route-drift-intent", {
    coordinatorTaskId: "global", coordinatorThreadId: "global-drifted",
    coordinatorEpoch: "lease:route-global-lease",
  }), (error) => error?.code === "COORDINATOR_ROUTE_STALE");
  const capsule = database.getTaskCapsule(unassignedTodo.id);
  assert.notEqual(capsule.resumeToken, exactLeaseCapsule.resumeToken);
  assert.throws(() => database.claimTaskSafeAction(unassignedTodo.id, {
    rootThreadId: "global-drifted", expectedResumeToken: capsule.resumeToken,
    safeActionId: "test", reservationLeaseId: "drifted-reservation",
  }), (error) => error?.code === "GLOBAL_COORDINATOR_BINDING_REQUIRED");
  assert.equal(database.database.prepare(
    "SELECT COUNT(*) AS count FROM owner_intent_adoptions",
  ).get().count, 0);
  assert.equal(database.database.prepare(
    "SELECT COUNT(*) AS count FROM task_safe_action_receipts WHERE task_id = ?",
  ).get(unassignedTodo.id).count, 0);
  const { coordinatorLease: _removedLease, ...configuredWithoutLease } = configured;
  database.upsertAgentLaneProject("route-drift", {
    ...configuredWithoutLease,
    tasks: configured.tasks.map((lane) => lane.id === "global"
      ? { ...lane, codexHostId: null, workspacePath: null }
      : lane),
  });
  assert.throws(() => database.claimProjectOwnerIntentAdoption("route-drift", "route-drift-intent", {
    coordinatorTaskId: "global", coordinatorThreadId: "global-thread",
    coordinatorEpoch: "configured:global",
  }), (error) => error?.code === "COORDINATOR_ROUTE_STALE");
  assert.equal(database.database.prepare(
    "SELECT COUNT(*) AS count FROM owner_intent_adoptions",
  ).get().count, 0);
  database.close();
});

test("Global Coordinator arbitrates unassigned Todo scope before any Sub-Agent spawn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "global-arbitration-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "arbitration", name: "Arbitration", workspacePath: null });
  const expiresAt = "2099-01-01T00:00:00.000Z";
  database.upsertAgentLaneProject("arbitration", {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
      { id: "backend", label: "Backend", owner: "Codex", source: "codex", threadId: "backend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/backend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global",
      holderThreadId: "global-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      holderThreadId: "global-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt,
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["backend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease", holderTaskId: "frontend",
        holderThreadId: "frontend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        holderThreadId: "frontend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt,
      },
      backend: {
        id: "backend-lease", holderTaskId: "backend",
        holderThreadId: "backend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/backend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt,
      },
    },
  });
  const ownerBinding = {
    threadId: "owner-talking-thread", codexProjectId: "arbitration", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner-talking",
  };
  const createReadyTodo = (title, gateKind = "test") => {
    const task = database.createTask({
      projectId: "arbitration", title, description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], threadId: ownerBinding.threadId,
      threadBinding: ownerBinding, actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
      developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/arbitration" },
      startDate: null, dueDate: null, recurrence: null,
    });
    database.createComment(task.id, {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        gates: [{
          id: "authorized", kind: gateKind, state: "authorized", scope: title,
          approver: "Owner", approvalRequest: "同意", evidence: "Owner resumed", receipt: `turn:${title}`,
        }],
        actions: [{
          id: "execute", order: 10, text: title, gate: "authorized",
          target: "candidate", status: "pending",
        }],
      })}\n\`\`\``,
      threadId: ownerBinding.threadId, threadBinding: ownerBinding,
      actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
    });
    return task;
  };
  const reserve = (task, suffix) => {
    const capsule = database.getTaskCapsule(task.id);
    const reservation = database.claimTaskSafeAction(task.id, {
      rootThreadId: "global-thread", expectedResumeToken: capsule.resumeToken,
      safeActionId: "execute", reservationLeaseId: `lease-${suffix}`,
    });
    database.confirmTaskSafeActionDelivery(task.id, {
      rootThreadId: "global-thread", expectedResumeToken: capsule.resumeToken,
      safeActionId: "execute", reservationLeaseId: `lease-${suffix}`,
    });
    return { capsule, reservation };
  };

  const frontendTask = createReadyTodo("Frontend work");
  const provider = createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => database.getAgentLaneProject(projectId),
    listTasks: (projectId) => database.listTasks({ projectId, archived: "false" }),
    getTaskCapsule: (taskId) => database.getTaskCapsule(taskId),
    getTaskDomainAssignment: (taskId) => database.getAgentTaskDomainAssignment(taskId),
    getTask: (identifier) => database.getTask(identifier),
    listComments: (taskId) => database.listComments(taskId),
  });
  const before = await provider.getProjectSnapshot("arbitration");
  assert.equal(before.todos[0].dispatchTarget.rootThreadId, "global-thread");
  assert.notEqual(before.todos[0].dispatchTarget.rootThreadId, ownerBinding.threadId);

  const first = reserve(frontendTask, "frontend");
  assert.throws(() => database.prepareTaskSafeActionAdmission(frontendTask.id, {
    rootThreadId: ownerBinding.threadId, expectedResumeToken: first.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: first.reservation.receipt.id,
    admissionAttemptId: first.reservation.receipt.admissionAttemptId, writeScope: ["web/src"],
  }), (error) => error?.code === "ADMISSION_ATTEMPT_MISMATCH");
  const rerouted = database.prepareTaskSafeActionAdmission(frontendTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: first.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: first.reservation.receipt.id,
    admissionAttemptId: first.reservation.receipt.admissionAttemptId, writeScope: ["web/src"],
  });
  assert.equal(rerouted.rerouted, true);
  assert.equal(rerouted.receipt.admissionState, "deferred");
  assert.equal(rerouted.assignment.domainId, "frontend");
  assert.equal(database.getAgentTaskClaim(frontendTask.id), null);
  const replay = database.prepareTaskSafeActionAdmission(frontendTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: first.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: first.reservation.receipt.id,
    admissionAttemptId: first.reservation.receipt.admissionAttemptId, writeScope: ["web/src"],
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.rerouted, true);
  assert.throws(() => database.prepareTaskSafeActionAdmission(frontendTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: first.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: first.reservation.receipt.id,
    admissionAttemptId: first.reservation.receipt.admissionAttemptId, writeScope: ["web/other"],
  }), (error) => error?.code === "ADMISSION_WRITE_SCOPE_MISMATCH");

  const after = await provider.getProjectSnapshot("arbitration");
  const projected = after.todos.find((todo) => todo.taskId === frontendTask.id);
  assert.equal(projected.domainAssignment.domainId, "frontend");
  assert.equal(projected.dispatchTarget.rootThreadId, "frontend-thread");
  const nextCapsule = database.getTaskCapsule(frontendTask.id);
  assert.notEqual(nextCapsule.resumeToken, first.capsule.resumeToken);
  const nextAttempt = database.claimTaskSafeAction(frontendTask.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: nextCapsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "lease-frontend-next",
  });
  assert.notEqual(
    nextAttempt.receipt.admissionAttemptId,
    first.reservation.receipt.admissionAttemptId,
  );

  const crossDomainTask = createReadyTodo("Cross-domain work");
  const crossDomain = reserve(crossDomainTask, "cross-domain");
  const globalPrepared = database.prepareTaskSafeActionAdmission(crossDomainTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: crossDomain.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: crossDomain.reservation.receipt.id,
    admissionAttemptId: crossDomain.reservation.receipt.admissionAttemptId,
    writeScope: ["web/src", "server/api"],
  });
  assert.equal(globalPrepared.rerouted, undefined);
  assert.equal(globalPrepared.receipt.admissionState, "prepared");
  assert.equal(database.getAgentTaskDomainAssignment(crossDomainTask.id), null);

  const recoveryTask = createReadyTodo("Global admission recovery");
  const recovery = reserve(recoveryTask, "recovery-epoch");
  const recoveryPrepared = database.prepareTaskSafeActionAdmission(recoveryTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: recovery.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: recovery.reservation.receipt.id,
    admissionAttemptId: recovery.reservation.receipt.admissionAttemptId,
    writeScope: ["web/src", "server/api"],
  });
  database.markTaskSafeActionAdmissionUncertain(recoveryTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: recovery.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: recovery.reservation.receipt.id,
    admissionAttemptId: recovery.reservation.receipt.admissionAttemptId,
  }, "2099-01-01T00:00:00.000Z");
  const recoveryProbe = database.claimTaskSafeActionAdmissionProbe(recoveryTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: recovery.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: recovery.reservation.receipt.id,
    admissionAttemptId: recovery.reservation.receipt.admissionAttemptId,
  });
  const deferredTask = createReadyTodo("Deferred Global admission");
  const deferred = reserve(deferredTask, "deferred-epoch");
  database.deferTaskSafeActionAdmission(deferredTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: deferred.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: deferred.reservation.receipt.id,
    admissionAttemptId: deferred.reservation.receipt.admissionAttemptId,
  });

  const crossDomainVersionBeforeEpochChange = database.getTask(crossDomainTask.id).version;
  const crossDomainReceiptBeforeEpochChange = database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(crossDomain.reservation.receipt.id);
  const recoveryReceiptBeforeEpochChange = database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(recovery.reservation.receipt.id);
  const deferredReceiptBeforeEpochChange = database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(deferred.reservation.receipt.id);
  const globalConfig = database.getAgentLaneProject("arbitration");
  database.upsertAgentLaneProject("arbitration", {
    ...globalConfig,
    coordinatorLease: {
      ...globalConfig.coordinatorLease,
      expiresAt: globalConfig.coordinatorLease.acquiredAt,
    },
  });
  database.upsertAgentLaneProject("arbitration", {
    ...database.getAgentLaneProject("arbitration"),
    coordinatorLease: {
      id: "global-lease-b", holderTaskId: "global",
      holderThreadId: "global-thread", holderCodexHostId: "local",
      holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:30:00.000Z", expiresAt,
    },
  });
  assert.throws(() => database.claimAgentTask(crossDomainTask.id, crossDomainTask.version, {
    agentPath: globalPrepared.receipt.admissionAgentPath,
    agentThreadId: "old-epoch-agent", rootThreadId: "global-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z",
    writeScope: ["web/src", "server/api"],
    admissionReceiptId: crossDomain.reservation.receipt.id,
    admissionAttemptId: crossDomain.reservation.receipt.admissionAttemptId,
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.deferTaskSafeActionAdmission(crossDomainTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: crossDomain.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: crossDomain.reservation.receipt.id,
    admissionAttemptId: crossDomain.reservation.receipt.admissionAttemptId,
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.markTaskSafeActionAdmissionUncertain(crossDomainTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: crossDomain.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: crossDomain.reservation.receipt.id,
    admissionAttemptId: crossDomain.reservation.receipt.admissionAttemptId,
  }, "2099-01-02T00:00:00.000Z"), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.claimTaskSafeActionAdmissionProbe(recoveryTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: recovery.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: recovery.reservation.receipt.id,
    admissionAttemptId: recovery.reservation.receipt.admissionAttemptId,
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.reconcileTaskSafeActionAdmission(recoveryTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: recovery.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: recovery.reservation.receipt.id,
    admissionAttemptId: recovery.reservation.receipt.admissionAttemptId,
    admissionProbeId: recoveryProbe.receipt.admissionProbeId,
    registryObservation: {
      source: "list_agents", complete: true, observedAt: "2099-01-03T00:00:00.000Z", agents: [],
    },
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.throws(() => database.claimTaskSafeAction(deferredTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: deferred.capsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "lease-b-deferred",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.throws(() => database.claimTaskSafeAction(crossDomainTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: crossDomain.capsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "lease-b-recovery",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.equal(database.getTask(crossDomainTask.id).version, crossDomainVersionBeforeEpochChange);
  assert.equal(database.getAgentTaskClaim(crossDomainTask.id), null);
  assert.equal(database.getActiveTaskAgentRun(crossDomainTask.id), null);
  assert.deepEqual(database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(crossDomain.reservation.receipt.id), crossDomainReceiptBeforeEpochChange);
  assert.deepEqual(database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(recovery.reservation.receipt.id), recoveryReceiptBeforeEpochChange);
  assert.deepEqual(database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(deferred.reservation.receipt.id), deferredReceiptBeforeEpochChange);
  assert.throws(() => database.prepareTaskSafeActionAdmission(frontendTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: first.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: first.reservation.receipt.id,
    admissionAttemptId: first.reservation.receipt.admissionAttemptId, writeScope: ["web/src"],
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");

  const sharedRuntimeTask = createReadyTodo("Shared runtime work", "shared_runtime");
  const sharedRuntime = reserve(sharedRuntimeTask, "shared-runtime");
  const sharedPrepared = database.prepareTaskSafeActionAdmission(sharedRuntimeTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: sharedRuntime.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: sharedRuntime.reservation.receipt.id,
    admissionAttemptId: sharedRuntime.reservation.receipt.admissionAttemptId,
    writeScope: ["web/src"],
  });
  assert.equal(sharedPrepared.rerouted, undefined);
  assert.equal(sharedPrepared.receipt.admissionState, "prepared");
  assert.equal(database.getAgentTaskDomainAssignment(sharedRuntimeTask.id), null);

  const leaseDriftTask = createReadyTodo("Lease epoch drift");
  const leaseDrift = reserve(leaseDriftTask, "lease-drift");
  const versionBeforeLeaseDrift = database.getTask(leaseDriftTask.id).version;
  const receiptBeforeLeaseDrift = database.database.prepare(`
    SELECT * FROM task_safe_action_receipts WHERE id = ?
  `).get(leaseDrift.reservation.receipt.id);
  const configBeforeLeaseDrift = database.getAgentLaneProject("arbitration");
  database.upsertAgentLaneProject("arbitration", {
    ...configBeforeLeaseDrift,
    coordinatorLease: {
      ...configBeforeLeaseDrift.coordinatorLease,
      expiresAt: configBeforeLeaseDrift.coordinatorLease.acquiredAt,
    },
  });
  database.upsertAgentLaneProject("arbitration", {
    ...database.getAgentLaneProject("arbitration"),
    coordinatorLease: {
      id: "global-lease-next", holderTaskId: "global",
      holderThreadId: "global-thread", holderCodexHostId: "local",
      holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T01:00:00.000Z", expiresAt,
    },
  });
  assert.throws(() => database.prepareTaskSafeActionAdmission(leaseDriftTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: leaseDrift.capsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: leaseDrift.reservation.receipt.id,
    admissionAttemptId: leaseDrift.reservation.receipt.admissionAttemptId,
    writeScope: ["web/src"],
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_MISMATCH");
  assert.equal(database.getAgentTaskDomainAssignment(leaseDriftTask.id), null);
  assert.equal(database.getTask(leaseDriftTask.id).version, versionBeforeLeaseDrift);
  assert.deepEqual(
    database.database.prepare("SELECT * FROM task_safe_action_receipts WHERE id = ?")
      .get(leaseDrift.reservation.receipt.id),
    receiptBeforeLeaseDrift,
  );

  database.upsertAgentLaneProject("arbitration", {
    ...database.getAgentLaneProject("arbitration"),
    coordinatorLease: {
      id: "global-lease-released", holderTaskId: "global",
      acquiredAt: "2026-08-31T02:00:00.000Z", expiresAt: "2026-08-31T02:00:00.000Z",
    },
  });
  const noGlobalTask = createReadyTodo("Wait for Global Coordinator");
  const noGlobalCapsule = database.getTaskCapsule(noGlobalTask.id);
  const unavailable = await provider.getProjectSnapshot("arbitration");
  assert.equal(
    unavailable.todos.find((todo) => todo.taskId === noGlobalTask.id).dispatchTarget,
    null,
  );
  assert.throws(() => database.claimTaskSafeAction(noGlobalTask.id, {
    rootThreadId: ownerBinding.threadId, expectedResumeToken: noGlobalCapsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "owner-bypass",
  }), (error) => error?.code === "GLOBAL_COORDINATOR_LEASE_REQUIRED");
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM task_safe_action_receipts WHERE task_id = ?
  `).get(noGlobalTask.id).count, 0);

  const incompleteConfig = database.getAgentLaneProject("arbitration");
  database.upsertAgentLaneProject("arbitration", {
    ...incompleteConfig,
    tasks: incompleteConfig.tasks.map((lane) => lane.id === "global"
      ? { ...lane, codexHostId: null, workspacePath: null }
      : lane),
    coordinatorLease: {
      id: "global-lease-incomplete", holderTaskId: "global",
      acquiredAt: "2026-08-31T03:00:00.000Z", expiresAt,
    },
  });
  const incompleteTask = createReadyTodo("Wait for bound Global Coordinator");
  const incompleteCapsule = database.getTaskCapsule(incompleteTask.id);
  const incompleteSnapshot = await provider.getProjectSnapshot("arbitration");
  assert.equal(
    incompleteSnapshot.todos.find((todo) => todo.taskId === incompleteTask.id).dispatchTarget,
    null,
  );
  assert.throws(() => database.claimTaskSafeAction(incompleteTask.id, {
    rootThreadId: "global-thread", expectedResumeToken: incompleteCapsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "incomplete-bypass",
  }), (error) => error?.code === "GLOBAL_COORDINATOR_BINDING_REQUIRED");
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM task_safe_action_receipts WHERE task_id = ?
  `).get(incompleteTask.id).count, 0);
  database.close();
});

test("Domain Coordinator holders are fully-bound Codex peer windows at every boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "domain-peer-boundary-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "domain-peer-boundary", name: "Domain peer boundary", workspacePath: null });
  const config = {
    rootTaskId: "global",
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinationDomains: [{
      id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["owner"],
    }],
  };
  assert.throws(() => database.upsertAgentLaneProject("domain-peer-boundary", config), (error) => (
    error?.code === "COORDINATION_DOMAIN_BINDING_MISMATCH"
  ));

  database.database.prepare(`
    INSERT INTO agent_lane_projects (project_id, config_json, updated_at)
    VALUES (?, ?, ?)
  `).run("domain-peer-boundary", JSON.stringify(config), new Date().toISOString());
  assert.throws(() => database.claimAgentLaneDomainCoordinator("domain-peer-boundary", "frontend", {
    holderTaskId: "owner", holderThreadId: "owner-thread",
    expectedLeaseId: null, leaseDurationSeconds: 120,
  }), (error) => [
    "COORDINATION_DOMAIN_BINDING_MISMATCH",
    "DOMAIN_COORDINATOR_BINDING_MISMATCH",
  ].includes(error?.code));

  const provider = createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => database.getAgentLaneProject(projectId),
    listTasks: () => [],
  });
  await assert.rejects(() => provider.getProjectSnapshot("domain-peer-boundary"), (error) => (
    error?.code === "AGENT_LANES_NOT_CONFIGURED"
  ));

  const omittedTaskTypeConfig = {
    rootTaskId: "global",
    tasks: [{
      id: "global", label: "Global", owner: "Codex", source: "codex",
      threadId: "global-thread", codexHostId: "local", workspacePath: "/tmp/global",
    }],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-09-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    coordinationDomains: [{
      id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["global"],
    }],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease", holderTaskId: "global", holderThreadId: "global-thread",
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
        acquiredAt: "2026-09-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  };
  database.database.prepare(`
    UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
  `).run(JSON.stringify(omittedTaskTypeConfig), new Date().toISOString(), "domain-peer-boundary");
  await assert.rejects(() => provider.getProjectSnapshot("domain-peer-boundary"), (error) => (
    error?.code === "AGENT_LANES_NOT_CONFIGURED"
  ));

  const whitespaceBindingConfig = {
    rootTaskId: "global",
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task" },
      {
        id: "frontend", label: "Frontend", owner: "Codex", source: "codex",
        threadId: "frontend-thread", taskType: "peer_task", codexHostId: "   ",
        workspacePath: "/tmp/frontend",
      },
    ],
    adapters: [],
    coordinationDomains: [{
      id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
    }],
  };
  database.database.prepare(`
    UPDATE agent_lane_projects SET config_json = ?, updated_at = ? WHERE project_id = ?
  `).run(JSON.stringify(whitespaceBindingConfig), new Date().toISOString(), "domain-peer-boundary");
  await assert.rejects(() => provider.getProjectSnapshot("domain-peer-boundary"), (error) => (
    error?.code === "AGENT_LANES_NOT_CONFIGURED"
  ));
  database.close();
});

test("Owner Intent replay is bound to its Taskboard project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owner-intent-project-binding-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const config = {
    rootTaskId: "coordinator",
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex", threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/coordinator" },
    ],
    adapters: [],
  };
  for (const projectId of ["intent-project-a", "intent-project-b"]) {
    database.createProject({ id: projectId, name: projectId, workspacePath: null });
    database.upsertAgentLaneProject(projectId, config);
  }
  const sourceBinding = {
    threadId: "owner-thread", codexProjectId: "shared-codex-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner",
  };
  const input = {
    intentId: "shared-intent", deliveryId: "shared-delivery", kind: "append",
    goal: "Same Owner turn", constraints: [], targetIntentId: null,
    ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
    ownerTurnId: "shared-owner-turn", rootCaptureTurnId: "shared-capture-turn", evidence: "synthetic",
  };
  database.recordProjectOwnerIntent("intent-project-a", input, sourceBinding, actor);
  assert.throws(() => database.recordProjectOwnerIntent(
    "intent-project-b", input, sourceBinding, actor,
  ), (error) => error?.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(database.listProjectOwnerIntents("intent-project-b").length, 0);

  const adoption = database.claimProjectOwnerIntentAdoption("intent-project-a", input.intentId, {
    coordinatorTaskId: "coordinator", coordinatorThreadId: "coordinator-thread",
    coordinatorEpoch: "configured:coordinator",
  });
  database.confirmProjectOwnerIntentAdoption("intent-project-a", input.intentId, {
    adoptionId: adoption.receipt.id, deliveryTurnId: "shared-plan-turn",
  });
  const adoptedIntent = database.listProjectOwnerIntents("intent-project-a")[0];
  const planInput = {
    revisionId: "shared-plan-revision", intentVersion: adoptedIntent.version,
    adoptionId: adoption.receipt.id, coordinatorTaskId: "coordinator",
    coordinatorThreadId: "coordinator-thread", coordinatorEpoch: "configured:coordinator",
    classification: "bounded_delivery", summary: "Scoped plan", parentTaskId: null,
    items: [],
  };
  database.applyProjectOwnerIntentPlan("intent-project-a", input.intentId, planInput);
  assert.throws(() => database.applyProjectOwnerIntentPlan(
    "intent-project-b", input.intentId, planInput,
  ), (error) => error?.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(database.listProjectOwnerIntentPlan("intent-project-b").length, 0);
  database.close();
});

test("Owner Root lease, cancel plans, and plan-owned task moves fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owner-intent-authority-boundary-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "authority-a", name: "Authority A", workspacePath: null });
  database.createProject({ id: "authority-b", name: "Authority B", workspacePath: null });
  database.upsertAgentLaneProject("authority-a", {
    rootTaskId: "coordinator", ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex", threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/coordinator" },
    ],
    adapters: [],
  });
  assert.throws(() => database.claimAgentLaneCoordinator("authority-a", {
    holderTaskId: "owner", holderThreadId: "owner-thread", holderCodexHostId: "local",
    holderWorkspacePath: "/tmp/owner", expectedLeaseId: null, leaseDurationSeconds: 60,
  }), (error) => error?.code === "OWNER_ROOT_COORDINATOR_CONFLICT");

  const binding = {
    threadId: "owner-thread", codexProjectId: "authority", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner",
  };
  const adopt = (intentId, kind, targetIntentId, suffix) => {
    database.recordProjectOwnerIntent("authority-a", {
      intentId, deliveryId: `delivery-${suffix}`, kind, goal: `${kind} goal`, constraints: [],
      targetIntentId, ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
      ownerTurnId: `owner-${suffix}`, rootCaptureTurnId: `capture-${suffix}`, evidence: "synthetic",
    }, binding, actor);
    const receipt = database.claimProjectOwnerIntentAdoption("authority-a", intentId, {
      coordinatorTaskId: "coordinator", coordinatorThreadId: "coordinator-thread",
      coordinatorEpoch: "configured:coordinator",
    });
    database.confirmProjectOwnerIntentAdoption("authority-a", intentId, {
      adoptionId: receipt.receipt.id, deliveryTurnId: `turn-${suffix}`,
    });
    return {
      intent: database.listProjectOwnerIntents("authority-a").find((item) => item.id === intentId),
      adoption: receipt,
    };
  };
  const apply = ({ intent, adoption }, revisionId, items) => database.applyProjectOwnerIntentPlan(
    "authority-a", intent.id, {
      revisionId, intentVersion: intent.version, adoptionId: adoption.receipt.id,
      coordinatorTaskId: "coordinator", coordinatorThreadId: "coordinator-thread",
      coordinatorEpoch: "configured:coordinator", classification: "bounded_delivery",
      summary: revisionId, parentTaskId: null, items,
    },
  );
  const target = adopt("target-intent", "append", null, "target");
  const targetPlan = apply(target, "target-plan", [{
    outcomeKey: "target-outcome", title: "Target work", description: "Target work",
    priority: "high", blockedByOutcomeKeys: [],
  }]);
  const plannedTask = targetPlan.revision.items[0].task;
  assert.throws(() => database.updateTask(
    plannedTask.id, plannedTask.version, { projectId: "authority-b" },
    "owner-thread", binding, actor,
  ), (error) => error?.code === "OWNER_INTENT_PLAN_PROJECT_MOVE_CONFLICT");

  const cancellation = adopt("cancel-intent", "cancel", "target-intent", "cancel");
  assert.throws(() => apply(cancellation, "cancel-plan", [{
    outcomeKey: "contrary-work", title: "Contrary work", description: "Must not run",
    priority: "high", blockedByOutcomeKeys: [],
  }]), (error) => error?.code === "CANCEL_PLAN_MUST_NOT_EXECUTE");
  database.database.prepare("UPDATE tasks SET project_id = ? WHERE id = ?")
    .run("authority-b", plannedTask.id);
  assert.throws(() => apply(cancellation, "cancel-plan", []), (error) => (
    error?.code === "OWNER_INTENT_PLAN_PROJECT_MISMATCH"
  ));
  assert.equal(database.getTask(plannedTask.id).projectId, "authority-b");
  assert.equal(database.getTask(plannedTask.id).status, "todo");
  assert.equal(database.listProjectOwnerIntentPlan("authority-a").length, 1);
  database.close();
});

test("domain-assigned Todo routes and claims only inside the active domain scope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-domain-todo-"));
  directories.push(directory);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const databaseOptions = { isPathCaseSensitive: () => true };
  const database = new TaskboardDatabase(databasePath, databaseOptions);
  database.createProject({ id: "domain-project", name: "Domain project", workspacePath: null });
  const coordinatorExpiresAt = "2099-01-01T00:00:00.000Z";
  database.upsertAgentLaneProject("domain-project", {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
      { id: "frontend-next", label: "Frontend next", owner: "Codex", source: "codex", threadId: "frontend-next-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend-next" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global",
      holderThreadId: "global-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: coordinatorExpiresAt,
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend", "frontend-next"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease", holderTaskId: "frontend",
        holderThreadId: "frontend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: coordinatorExpiresAt,
      },
    },
  });
  const binding = {
    threadId: "global-thread", codexProjectId: "domain-project", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/global",
  };
  const task = database.createTask({
    projectId: "domain-project", title: "Frontend Todo", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
    actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain" },
    startDate: null, dueDate: null, recurrence: null,
  });
  database.createComment(task.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "local", kind: "test", state: "authorized", scope: "local tests",
        approver: "Owner", approvalRequest: "同意本地测试", evidence: "Owner resumed", receipt: "turn:resume",
      }],
      actions: [{ id: "test", order: 10, text: "Run local acceptance", gate: "local", target: "candidate", status: "pending" }],
    })}\n\`\`\``,
    threadId: binding.threadId, threadBinding: binding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });

  assert.throws(() => database.setAgentTaskDomain("domain-project", task.id, {
    domainId: "frontend", taskVersion: task.version,
    holderTaskId: "global", holderThreadId: "wrong-thread", expectedCoordinatorLeaseId: "global-lease",
  }), (error) => error?.code === "GLOBAL_COORDINATOR_BINDING_MISMATCH");
  assert.equal(database.getAgentTaskDomainAssignment(task.id), null);
  assert.equal(database.getTask(task.id).version, task.version);

  const assigned = database.setAgentTaskDomain("domain-project", task.id, {
    domainId: "frontend", taskVersion: task.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  assert.equal(assigned.assignment.domainId, "frontend");
  const replayed = database.setAgentTaskDomain("domain-project", task.id, {
    domainId: "frontend", taskVersion: assigned.task.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  assert.equal(replayed.task.version, assigned.task.version);
  const firstToken = database.getTaskCapsule(task.id).resumeToken;
  const firstReservation = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "frontend-reservation",
  });
  assert.equal(firstReservation.reused, false);
  const competingReservation = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "competing-reservation",
  });
  assert.equal(competingReservation.available, false);
  database.database.prepare(`
    UPDATE task_safe_action_receipts SET lease_expires_at = ? WHERE id = ?
  `).run("2000-01-01T00:00:00.000Z", firstReservation.receipt.id);
  const reclaimedReservation = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "reclaimed-reservation",
  });
  assert.equal(reclaimedReservation.available, true);
  assert.equal(reclaimedReservation.reclaimed, true);
  assert.equal(database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "reclaimed-reservation",
  }).receipt.status, "delivering");
  const concurrentRecovery = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "concurrent-recovery",
  });
  assert.equal(concurrentRecovery.available, false);
  assert.equal(concurrentRecovery.recovering, false);
  assert.equal(concurrentRecovery.awaitingAdmission, true);
  const firstConfig = database.getAgentLaneProject("domain-project");
  database.upsertAgentLaneProject("domain-project", {
    ...firstConfig,
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-next-lease", holderTaskId: "frontend-next",
        holderThreadId: "frontend-next-thread", holderCodexHostId: "local",
        holderWorkspacePath: "/tmp/frontend-next",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: coordinatorExpiresAt,
      },
    },
  });
  const takeoverCapsule = database.getTaskCapsule(task.id);
  assert.notEqual(takeoverCapsule.resumeToken, firstToken);
  assert.deepEqual(takeoverCapsule.domainRoute, {
    domainId: "frontend", leaseId: "frontend-next-lease",
    holderTaskId: "frontend-next", holderThreadId: "frontend-next-thread", status: "active",
  });
  const blockedDuringDelivery = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-next-thread", expectedResumeToken: takeoverCapsule.resumeToken, safeActionId: "test",
    reservationLeaseId: "frontend-next-reservation",
  });
  assert.equal(blockedDuringDelivery.available, false);
  assert.equal(blockedDuringDelivery.recovering, false);
  assert.equal(blockedDuringDelivery.coordinatorLeaseChanged, true);
  assert.equal(blockedDuringDelivery.awaitingAdmission, undefined);
  assert.equal(blockedDuringDelivery.receipt.status, "delivering");
  database.upsertAgentLaneProject("domain-project", firstConfig);
  database.createProject({ id: "other-project", name: "Other project", workspacePath: null });
  assert.throws(() => database.updateTask(
    task.id,
    assigned.task.version,
    { projectId: "other-project" },
    binding.threadId,
    binding,
    actor,
  ), (error) => error?.code === "DOMAIN_TODO_PROJECT_MOVE_CONFLICT");
  assert.equal(database.getTask(task.id).projectId, "domain-project");
  const stableDomainConfig = database.getAgentLaneProject("domain-project");
  assert.throws(() => database.upsertAgentLaneProject("domain-project", {
    ...stableDomainConfig,
    coordinationDomains: stableDomainConfig.coordinationDomains.map((domain) => (
      domain.id === "frontend" ? { ...domain, writeScope: ["WEB"] } : domain
    )),
  }), (error) => error?.code === "ASSIGNED_COORDINATION_DOMAIN_CHANGE");
  assert.throws(() => database.upsertAgentLaneProject("domain-project", {
    ...stableDomainConfig,
    coordinationDomains: stableDomainConfig.coordinationDomains.map((domain) => (
      domain.id === "frontend" ? { ...domain, writeScope: ["server"] } : domain
    )),
  }), (error) => error?.code === "ASSIGNED_COORDINATION_DOMAIN_CHANGE");
  assert.deepEqual(
    database.getAgentLaneProject("domain-project").coordinationDomains[0].writeScope,
    ["web"],
  );
  const mixedCaseClaimTask = database.createTask({
    projectId: "domain-project", title: "Case-sensitive domain claim", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
    actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain" },
    startDate: null, dueDate: null, recurrence: null,
  });
  const mixedCaseAssigned = database.setAgentTaskDomain("domain-project", mixedCaseClaimTask.id, {
    domainId: "frontend", taskVersion: mixedCaseClaimTask.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  assert.throws(() => database.claimAgentTask(mixedCaseClaimTask.id, mixedCaseAssigned.task.version, {
    agentPath: "/root/mixed-case", agentThreadId: "mixed-case-thread", rootThreadId: "frontend-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z", writeScope: ["WEB/src"],
  }), (error) => error?.code === "DOMAIN_WRITE_SCOPE_VIOLATION");
  assert.equal(database.getTask(mixedCaseClaimTask.id).status, "todo");
  database.close();

  const reopened = new TaskboardDatabase(databasePath, databaseOptions);
  assert.equal(reopened.getAgentTaskDomainAssignment(task.id).domainId, "frontend");
  const persistedAdmission = reopened.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: firstToken, safeActionId: "test",
    reservationLeaseId: "after-reopen-reservation",
  });
  assert.equal(persistedAdmission.available, false);
  assert.equal(persistedAdmission.awaitingAdmission, true);
  assert.equal(persistedAdmission.receipt.admissionAttemptId, firstReservation.receipt.admissionAttemptId);
  const admissionBinding = {
    admissionReceiptId: persistedAdmission.receipt.id,
    admissionAttemptId: persistedAdmission.receipt.admissionAttemptId,
  };
  const snapshot = await createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => reopened.getAgentLaneProject(projectId),
    listTasks: (projectId) => reopened.listTasks({ projectId, archived: "false" }),
    getClaim: (taskId) => reopened.getAgentTaskClaim(taskId),
    getTaskCapsule: (taskId) => reopened.getTaskCapsule(taskId),
    getTaskDomainAssignment: (taskId) => reopened.getAgentTaskDomainAssignment(taskId),
    getTask: (identifier) => reopened.getTask(identifier),
    listComments: (taskId) => reopened.listComments(taskId),
  }).getProjectSnapshot("domain-project");
  assert.deepEqual(snapshot.todos[0].domainAssignment, {
    domainId: "frontend", status: "active", coordinatorTaskId: "frontend", leaseId: "frontend-lease",
  });
  assert.equal(snapshot.coordination.domainCoordinators[0].durableWorkPending, false);
  assert.deepEqual(snapshot.coordination.domainCoordinators[0].durableWorkTaskIds, []);
  assert.deepEqual(snapshot.todos[0].dispatchTarget, {
    rootThreadId: "frontend-thread", codexHostId: "local",
    rootWorkspacePath: "/tmp/frontend", worktreePath: "/tmp/product",
  });
  const laneConfig = reopened.getAgentLaneProject("domain-project");
  reopened.upsertAgentLaneProject("domain-project", {
    ...laneConfig,
    domainCoordinatorLeases: {
      frontend: {
        ...laneConfig.domainCoordinatorLeases.frontend,
        acquiredAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:00:00.000Z",
      },
    },
  });
  const unavailable = await createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => reopened.getAgentLaneProject(projectId),
    listTasks: (projectId) => reopened.listTasks({ projectId, archived: "false" }),
    getTaskCapsule: (taskId) => reopened.getTaskCapsule(taskId),
    getTaskDomainAssignment: (taskId) => reopened.getAgentTaskDomainAssignment(taskId),
    getTask: (identifier) => reopened.getTask(identifier),
    listComments: (taskId) => reopened.listComments(taskId),
  }).getProjectSnapshot("domain-project");
  assert.equal(unavailable.todos[0].domainAssignment.status, "needs_coordinator");
  assert.equal(unavailable.todos[0].dispatchTarget, null);
  assert.equal(unavailable.coordination.domainCoordinators[0].durableWorkPending, true);
  assert.deepEqual(
    unavailable.coordination.domainCoordinators[0].durableWorkTaskIds,
    [mixedCaseClaimTask.identifier, task.identifier],
  );
  const { holderThreadId, holderCodexHostId, holderWorkspacePath, ...legacyDomainLease } = (
    laneConfig.domainCoordinatorLeases.frontend
  );
  reopened.upsertAgentLaneProject("domain-project", {
    ...laneConfig,
    domainCoordinatorLeases: { frontend: legacyDomainLease },
  });
  const legacyUnavailable = await createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => reopened.getAgentLaneProject(projectId),
    listTasks: (projectId) => reopened.listTasks({ projectId, archived: "false" }),
    getTaskCapsule: (taskId) => reopened.getTaskCapsule(taskId),
    getTaskDomainAssignment: (taskId) => reopened.getAgentTaskDomainAssignment(taskId),
    getTask: (identifier) => reopened.getTask(identifier),
    listComments: (taskId) => reopened.listComments(taskId),
  }).getProjectSnapshot("domain-project");
  assert.equal(legacyUnavailable.todos[0].domainAssignment.status, "needs_coordinator");
  assert.equal(legacyUnavailable.todos[0].dispatchTarget, null);
  assert.equal(legacyUnavailable.coordination.domainCoordinators[0].durableWorkPending, true);
  assert.deepEqual(
    legacyUnavailable.coordination.domainCoordinators[0].durableWorkTaskIds,
    [mixedCaseClaimTask.identifier, task.identifier],
  );
  reopened.upsertAgentLaneProject("domain-project", laneConfig);
  assert.throws(() => reopened.prepareTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: persistedAdmission.receipt.resumeToken,
    safeActionId: persistedAdmission.receipt.safeActionId, writeScope: ["WEB/src"], ...admissionBinding,
  }), (error) => error?.code === "DOMAIN_WRITE_SCOPE_VIOLATION");
  assert.throws(() => reopened.prepareTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: persistedAdmission.receipt.resumeToken,
    safeActionId: persistedAdmission.receipt.safeActionId, writeScope: ["server"], ...admissionBinding,
  }), (error) => error?.code === "DOMAIN_WRITE_SCOPE_VIOLATION");
  assert.equal(reopened.getTask(task.id).status, "todo");
  assert.equal(reopened.getAgentTaskClaim(task.id), null);
  const preparedAdmission = reopened.prepareTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: persistedAdmission.receipt.resumeToken,
    safeActionId: persistedAdmission.receipt.safeActionId, writeScope: ["web/src"], ...admissionBinding,
  });
  const preparedAgentPath = preparedAdmission.receipt.admissionAgentPath;
  assert.throws(() => reopened.claimAgentTask(task.id, assigned.task.version, {
    agentPath: preparedAgentPath, agentThreadId: "frontend-agent", rootThreadId: "global-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z", writeScope: ["web/src"], ...admissionBinding,
  }), (error) => error?.code === "DOMAIN_COORDINATOR_THREAD_MISMATCH");
  assert.equal(reopened.getTask(task.id).status, "todo");
  assert.throws(() => reopened.claimAgentTask(task.id, assigned.task.version, {
    agentPath: preparedAgentPath, agentThreadId: "frontend-agent", rootThreadId: "frontend-thread",
    leaseExpiresAt: "2100-01-01T00:00:00.000Z", writeScope: ["web/src"], ...admissionBinding,
  }), (error) => error?.code === "DOMAIN_LEASE_BOUNDARY");
  assert.equal(reopened.getTask(task.id).status, "todo");
  const claimed = reopened.claimAgentTask(task.id, assigned.task.version, {
    agentPath: preparedAgentPath, agentThreadId: "frontend-agent", rootThreadId: "frontend-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z", writeScope: ["web/src"], ...admissionBinding,
  });
  assert.equal(claimed.run.rootThreadId, "frontend-thread");
  assert.equal(claimed.run.worktree.path, "/tmp/product");
  reopened.close();

  const caseInsensitive = new TaskboardDatabase(databasePath, { isPathCaseSensitive: () => false });
  const insensitiveTask = caseInsensitive.getTask(mixedCaseClaimTask.id);
  const insensitiveClaim = caseInsensitive.claimAgentTask(insensitiveTask.id, insensitiveTask.version, {
    agentPath: "/root/mixed-case", agentThreadId: "mixed-case-thread", rootThreadId: "frontend-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z", writeScope: ["WEB/src"],
  });
  assert.deepEqual(insensitiveClaim.run.writeScope, ["WEB/src"]);
  caseInsensitive.close();
});

test("completed and canceled domain Todos can clear assignments while active work stays fenced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-domain-clear-lifecycle-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "domain-clear", name: "Domain clear", workspacePath: null });
  database.upsertAgentLaneProject("domain-clear", {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
    ],
  });
  const binding = {
    threadId: "global-thread", codexProjectId: "domain-clear", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/global",
  };
  const createAssigned = (title) => {
    const task = database.createTask({
      projectId: "domain-clear", title, description: "", status: "todo",
      priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
      actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
      developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain-clear" },
      startDate: null, dueDate: null, recurrence: null,
    });
    return database.setAgentTaskDomain("domain-clear", task.id, {
      domainId: "frontend", taskVersion: task.version,
      holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
    }).task;
  };
  const clear = (task) => database.setAgentTaskDomain("domain-clear", task.id, {
    domainId: null, taskVersion: task.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  const timestamp = new Date().toISOString();

  let canceled = createAssigned("Owner canceled queued Todo");
  database.database.prepare("UPDATE tasks SET status = 'canceled', version = version + 1 WHERE id = ?").run(canceled.id);
  canceled = database.getTask(canceled.id);
  const clearedCanceled = clear(canceled);
  assert.equal(clearedCanceled.assignment, null);
  database.createProject({ id: "domain-clear-other", name: "Other", workspacePath: null });
  assert.throws(() => database.updateTask(
    canceled.id, clearedCanceled.task.version, { projectId: "domain-clear-other" },
    binding.threadId, binding, actor,
  ), (error) => error?.code === "DOMAIN_TODO_PROJECT_MOVE_CONFLICT");
  assert.equal(database.getTask(canceled.id).projectId, "domain-clear");

  let completed = createAssigned("Completed domain Todo");
  database.database.prepare("UPDATE tasks SET status = 'in_review', version = version + 1 WHERE id = ?").run(completed.id);
  database.database.prepare(`
    INSERT INTO agent_task_claims (
      task_id, project_id, agent_path, agent_thread_id, status,
      claimed_at, lease_expires_at, write_scope_json, completed_at
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)
  `).run(completed.id, "domain-clear", "/root/frontend", "completed-thread", timestamp, timestamp, '["web"]', timestamp);
  completed = database.getTask(completed.id);
  assert.equal(clear(completed).assignment, null);

  const active = createAssigned("Active domain Todo");
  database.database.prepare(`
    INSERT INTO agent_task_claims (
      task_id, project_id, agent_path, agent_thread_id, status,
      claimed_at, lease_expires_at, write_scope_json, completed_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
  `).run(active.id, "domain-clear", "/root/frontend", "active-thread", timestamp, "2099-01-01T00:00:00.000Z", '["web"]');
  assert.throws(() => clear(active), (error) => error?.code === "DOMAIN_TODO_ACTIVE");
  assert.equal(database.getAgentTaskDomainAssignment(active.id).domainId, "frontend");

  let admitting = createAssigned("Admission in progress");
  database.database.prepare(`
    INSERT INTO task_safe_action_receipts (
      id, task_id, project_id, resume_token, safe_action_id, root_thread_id,
      claimed_at, status, admission_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'delivering', 'awaiting_admission')
  `).run("admission-receipt", admitting.id, "domain-clear", "resume", "execute", "frontend-thread", timestamp);
  assert.throws(() => clear(admitting), (error) => error?.code === "DOMAIN_TODO_ADMISSION_ACTIVE");
  assert.equal(database.getAgentTaskDomainAssignment(admitting.id).domainId, "frontend");
  database.database.prepare(`
    UPDATE task_safe_action_receipts SET status = 'delivered', admission_state = 'admitted' WHERE id = ?
  `).run("admission-receipt");
  admitting = database.getTask(admitting.id);
  assert.equal(clear(admitting).assignment, null);
  database.close();
});

test("default domain containment fails closed for a symlinked case-sensitive target", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-domain-case-probe-"));
  directories.push(directory);
  const target = "/dev";
  const lowerLink = path.join(directory, "mount");
  const upperLink = path.join(directory, "Mount");
  try {
    await symlink(target, lowerLink, "dir");
    try {
      await symlink(target, upperLink, "dir");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } catch {
    t.skip("This host cannot create a local symlink to the case-sensitive /dev target");
    return;
  }
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "case-probe", name: "Case probe", workspacePath: null });
  database.upsertAgentLaneProject("case-probe", {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease", holderTaskId: "frontend", holderThreadId: "frontend-thread",
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  });
  const binding = {
    threadId: "global-thread", codexProjectId: "case-probe", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/global",
  };
  const task = database.createTask({
    projectId: "case-probe", title: "Case probe Todo", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
    actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: { type: "worktree", path: lowerLink, branch: "codex/case-probe" },
    startDate: null, dueDate: null, recurrence: null,
  });
  const assigned = database.setAgentTaskDomain("case-probe", task.id, {
    domainId: "frontend", taskVersion: task.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  assert.throws(() => database.claimAgentTask(task.id, assigned.task.version, {
    agentPath: "/root/case-probe", agentThreadId: "case-probe-thread", rootThreadId: "frontend-thread",
    leaseExpiresAt: "2098-01-01T00:00:00.000Z", writeScope: ["WEB/src"],
  }), (error) => error?.code === "DOMAIN_WRITE_SCOPE_VIOLATION");
  database.close();
});

test("default case probe treats case-distinct hardlink names as case-sensitive", () => {
  const directoryStat = {
    isSymbolicLink: () => false,
    isDirectory: () => true,
  };
  const hardlinkStat = { dev: 1, ino: 2 };
  assert.equal(defaultIsPathCaseSensitive("/worktree", {
    lstat: (value) => value === "/worktree" ? directoryStat : hardlinkStat,
    readdir: () => [{ name: "probe" }, { name: "Probe" }],
  }), true);
});

test("domain safe-action receipts are fenced across same-holder lease recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-domain-recovery-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "domain-recovery", name: "Domain recovery", workspacePath: null });
  const activeUntil = "2099-01-01T00:00:00.000Z";
  const binding = {
    threadId: "global-thread", codexProjectId: "domain-recovery", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/global",
  };
  database.upsertAgentLaneProject("domain-recovery", {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: activeUntil,
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease-a", holderTaskId: "frontend", holderThreadId: "frontend-thread",
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: activeUntil,
      },
    },
  });
  const task = database.createTask({
    projectId: "domain-recovery", title: "Frontend recovery Todo", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
    actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/domain-recovery" },
    startDate: null, dueDate: null, recurrence: null,
  });
  database.createComment(task.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "local", kind: "test", state: "authorized", scope: "local tests",
        approver: "Owner", approvalRequest: "同意本地测试", evidence: "Owner resumed", receipt: "turn:resume",
      }],
      actions: [{ id: "test", order: 10, text: "Run local acceptance", gate: "local", target: "candidate", status: "pending" }],
    })}\n\`\`\``,
    threadId: binding.threadId, threadBinding: binding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });
  const assigned = database.setAgentTaskDomain("domain-recovery", task.id, {
    domainId: "frontend", taskVersion: task.version,
    holderTaskId: "global", holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  });
  const tokenA = database.getTaskCapsule(task.id).resumeToken;
  const reservationA = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: tokenA, safeActionId: "test",
    reservationLeaseId: "reservation-a",
  });
  assert.equal(reservationA.receipt.domainCoordinatorLeaseId, "frontend-lease-a");
  assert.equal(database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: tokenA, safeActionId: "test",
    reservationLeaseId: "reservation-a",
  }).receipt.status, "delivering");

  const configA = database.getAgentLaneProject("domain-recovery");
  database.upsertAgentLaneProject("domain-recovery", {
    ...configA,
    domainCoordinatorLeases: {
      frontend: {
        ...configA.domainCoordinatorLeases.frontend,
        expiresAt: new Date(
          Date.parse(configA.domainCoordinatorLeases.frontend.acquiredAt) + 1_000,
        ).toISOString(),
      },
    },
  });
  const recovered = database.claimAgentLaneDomainCoordinator("domain-recovery", "frontend", {
    holderTaskId: "frontend", holderThreadId: "frontend-thread",
    holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
    expectedLeaseId: "frontend-lease-a", leaseDurationSeconds: 120, recoverOnly: true,
  });
  assert.notEqual(recovered.lease.id, "frontend-lease-a");
  assert.throws(() => database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: tokenA, safeActionId: "test",
    reservationLeaseId: "reservation-a",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.equal(database.getTask(task.id).version, assigned.task.version);

  const tokenB = database.getTaskCapsule(task.id).resumeToken;
  assert.notEqual(tokenB, tokenA);
  const fenced = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: tokenB, safeActionId: "test",
    reservationLeaseId: "reservation-b",
  });
  assert.equal(fenced.available, false);
  assert.equal(fenced.coordinatorLeaseChanged, true);
  assert.equal(fenced.receipt.domainCoordinatorLeaseId, "frontend-lease-a");
  assert.equal(fenced.receipt.status, "delivering");
  database.close();
});

test("Owner Intent supersede reopens outcomes and reconciles plan-owned dependencies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owner-intent-plan-revision-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "plan-revision", name: "Plan revision", workspacePath: null });
  database.upsertAgentLaneProject("plan-revision", {
    rootTaskId: "coordinator",
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex", threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/coordinator" },
    ],
    adapters: [],
  });
  const ownerBinding = {
    threadId: "owner-thread", codexProjectId: "plan-revision", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner",
  };
  const adopt = (intentId, kind, targetIntentId, sequence) => {
    const input = {
      intentId,
      deliveryId: `delivery-${sequence}`,
      kind,
      goal: `Plan revision ${sequence}`,
      constraints: ["local only"],
      targetIntentId,
      ownerRootTaskId: "owner",
      ownerRootThreadId: "owner-thread",
      ownerTurnId: `owner-turn-${sequence}`,
      rootCaptureTurnId: `capture-turn-${sequence}`,
      evidence: `synthetic Owner turn ${sequence}`,
    };
    database.recordProjectOwnerIntent("plan-revision", input, ownerBinding, actor);
    const adoption = database.claimProjectOwnerIntentAdoption("plan-revision", intentId, {
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "coordinator-thread",
      coordinatorEpoch: "configured:coordinator",
    });
    database.confirmProjectOwnerIntentAdoption("plan-revision", intentId, {
      adoptionId: adoption.receipt.id,
      deliveryTurnId: `coordinator-turn-${sequence}`,
    });
    const intent = database.listProjectOwnerIntents("plan-revision")
      .find((candidate) => candidate.id === intentId);
    return { intent, adoption };
  };
  const applyPlan = ({ intent, adoption }, revisionId, items) => database.applyProjectOwnerIntentPlan(
    "plan-revision",
    intent.id,
    {
      revisionId,
      intentVersion: intent.version,
      adoptionId: adoption.receipt.id,
      coordinatorTaskId: "coordinator",
      coordinatorThreadId: "coordinator-thread",
      coordinatorEpoch: "configured:coordinator",
      classification: "bounded_delivery",
      summary: revisionId,
      parentTaskId: null,
      items,
    },
  );
  const outcomes = (titles, dependencies) => ["a", "b", "c", "d"].map((key) => ({
    outcomeKey: `outcome-${key}`,
    title: titles[key],
    description: `${titles[key]} description`,
    priority: "high",
    blockedByOutcomeKeys: dependencies[key] ?? [],
  }));

  const first = adopt("intent-first", "append", null, 1);
  const firstPlan = applyPlan(first, "revision-first", outcomes(
    { a: "A v1", b: "B v1", c: "C v1", d: "D v1" },
    { b: ["outcome-a"], d: ["outcome-c"] },
  ));
  const firstTasks = Object.fromEntries(firstPlan.revision.items.map((item) => [
    item.outcomeKey.replace("outcome-", ""), item.task,
  ]));
  database.removeTaskRelation(
    firstTasks.c.id, firstTasks.c.version, "blocks", firstTasks.d.id,
    "owner-thread", ownerBinding, actor,
  );
  const manuallyRebuiltSource = database.getTask(firstTasks.c.id);
  database.addTaskRelation(
    manuallyRebuiltSource.id, manuallyRebuiltSource.version, "blocks", firstTasks.d.id,
    "owner-thread", ownerBinding, actor,
  );
  const manual = database.createTask({
    projectId: "plan-revision", title: "Manual dependency", description: "", status: "todo",
    priority: "medium", labels: [], threadId: "owner-thread", threadBinding: ownerBinding,
    actor, assignee: actor, workflowId: null, developmentContext: null,
    startDate: null, dueDate: null, recurrence: null,
  });
  database.addTaskRelation(
    manual.id, manual.version, "blocks", firstTasks.a.id,
    "owner-thread", ownerBinding, actor,
  );

  const second = adopt("intent-second", "supersede", first.intent.id, 2);
  const secondPlan = applyPlan(second, "revision-second", outcomes(
    { a: "A v2", b: "B v2", c: "C v2", d: "D v2" },
    { a: ["outcome-b"] },
  ));
  const secondTasks = Object.fromEntries(secondPlan.revision.items.map((item) => [
    item.outcomeKey.replace("outcome-", ""), database.getTask(item.task.id),
  ]));
  assert.deepEqual(Object.fromEntries(secondPlan.revision.items.map((item) => [
    item.outcomeKey.replace("outcome-", ""), item.task.id,
  ])), Object.fromEntries(Object.entries(firstTasks).map(([key, task]) => [key, task.id])));
  assert.equal(Object.values(secondTasks).every((task) => task.status === "todo"), true);
  assert.deepEqual(Object.fromEntries(Object.entries(secondTasks).map(([key, task]) => [key, task.title])), {
    a: "A v2", b: "B v2", c: "C v2", d: "D v2",
  });
  assert.deepEqual(secondTasks.a.relations.blockedBy.map((task) => task.id).sort(), [
    firstTasks.b.id,
    manual.id,
  ].sort());
  assert.deepEqual(secondTasks.b.relations.blockedBy, []);
  assert.deepEqual(secondTasks.d.relations.blockedBy.map((task) => task.id), [secondTasks.c.id]);

  const third = adopt("intent-third", "supersede", second.intent.id, 3);
  assert.throws(
    () => applyPlan(third, "revision-third", outcomes(
      { a: "A v3", b: "B v3", c: "C v3", d: "D v3" },
      { c: ["outcome-d"] },
    )),
    (error) => error?.code === "PLAN_DEPENDENCY_CYCLE",
  );
  assert.equal(database.getTask(secondTasks.a.id).title, "A v2");
  assert.equal(database.getTask(secondTasks.c.id).status, "todo");
  assert.deepEqual(database.getTask(secondTasks.d.id).relations.blockedBy.map((task) => task.id), [
    secondTasks.c.id,
  ]);
  database.close();
});

test("headless control plane survives capacity defer and coordinator recovery without duplicate work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-control-plane-e2e-"));
  directories.push(directory);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "control-plane", name: "Control plane", workspacePath: null });
  const activeUntil = "2099-01-01T00:00:00.000Z";
  const ownerBinding = {
    threadId: "owner-thread", codexProjectId: "control-plane", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner",
  };
  database.upsertAgentLaneProject("control-plane", {
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner Root", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread",
      holderCodexHostId: "local", holderWorkspacePath: "/tmp/global",
      acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: activeUntil,
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease-a", holderTaskId: "frontend", holderThreadId: "frontend-thread",
        holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt: activeUntil,
      },
    },
  });

  const intentInput = {
    intentId: "intent-control-plane", deliveryId: "delivery-control-plane", kind: "append",
    goal: "Implement one bounded frontend outcome", constraints: ["local only"], targetIntentId: null,
    ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
    ownerTurnId: "owner-turn", rootCaptureTurnId: "capture-turn", evidence: "synthetic Owner turn",
  };
  assert.equal(database.recordProjectOwnerIntent(
    "control-plane", intentInput, ownerBinding, actor,
  ).applied, true);
  assert.equal(database.recordProjectOwnerIntent(
    "control-plane", intentInput, ownerBinding, actor,
  ).applied, false);
  const adoption = database.claimProjectOwnerIntentAdoption(
    "control-plane", intentInput.intentId, {
      coordinatorTaskId: "global", coordinatorThreadId: "global-thread",
      coordinatorEpoch: "lease:global-lease",
    },
  );
  database.confirmProjectOwnerIntentAdoption("control-plane", intentInput.intentId, {
    adoptionId: adoption.receipt.id, deliveryTurnId: "coordinator-plan-turn",
  });
  const adoptedIntent = database.listProjectOwnerIntents("control-plane")[0];
  const planInput = {
    revisionId: "revision-control-plane", intentVersion: adoptedIntent.version,
    adoptionId: adoption.receipt.id, coordinatorTaskId: "global",
    coordinatorThreadId: "global-thread", coordinatorEpoch: "lease:global-lease",
    classification: "bounded_delivery", summary: "One frontend Todo", parentTaskId: null,
    items: [{
      outcomeKey: "frontend-outcome", title: "Bounded frontend Todo",
      description: "Change only web/src", priority: "high", blockedByOutcomeKeys: [],
    }],
  };
  const planned = database.applyProjectOwnerIntentPlan(
    "control-plane", intentInput.intentId, planInput,
  );
  assert.equal(planned.applied, true);
  assert.equal(database.applyProjectOwnerIntentPlan(
    "control-plane", intentInput.intentId, planInput,
  ).applied, false);
  assert.equal(database.listProjectOwnerIntentPlan("control-plane").length, 1);
  const task = database.getTask(planned.revision.items[0].task.id);
  database.updateTask(task.id, task.version, {
    developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/control-plane" },
  }, ownerBinding.threadId, ownerBinding, actor);
  database.createComment(task.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "local", kind: "test", state: "authorized", scope: "local implementation and tests",
        approver: "Owner", approvalRequest: "同意本地实现", evidence: "Owner goal", receipt: "turn:owner-turn",
      }],
      actions: [{ id: "execute", order: 10, text: "Implement bounded frontend outcome", gate: "local", target: "candidate", status: "pending" }],
    })}\n\`\`\``,
    threadId: ownerBinding.threadId, threadBinding: ownerBinding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });

  const globalCapsule = database.getTaskCapsule(task.id);
  const globalReservation = database.claimTaskSafeAction(task.id, {
    rootThreadId: "global-thread", expectedResumeToken: globalCapsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "global-reservation",
  });
  database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "global-thread", expectedResumeToken: globalCapsule.resumeToken,
    safeActionId: "execute", reservationLeaseId: "global-reservation",
  });
  const rerouted = database.prepareTaskSafeActionAdmission(task.id, {
    rootThreadId: "global-thread", expectedResumeToken: globalCapsule.resumeToken,
    safeActionId: "execute", admissionReceiptId: globalReservation.receipt.id,
    admissionAttemptId: globalReservation.receipt.admissionAttemptId, writeScope: ["web/src"],
  });
  assert.equal(rerouted.rerouted, true);
  assert.equal(rerouted.assignment.domainId, "frontend");

  const domainCapsuleA = database.getTaskCapsule(task.id);
  const domainReservationA = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-reservation-a",
  });
  database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-reservation-a",
  });
  const deferred = database.deferTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", admissionReceiptId: domainReservationA.receipt.id,
    admissionAttemptId: domainReservationA.receipt.admissionAttemptId,
  });
  assert.equal(deferred.receipt.admissionState, "deferred");
  assert.equal(deferred.receipt.admissionDeferredReason, "model_capacity");
  assert.equal(deferred.receipt.admissionRetryCount, 1);
  assert.ok(Date.parse(deferred.receipt.admissionRetryAfter) > Date.now());
  assert.equal(
    database.getTaskSafeActionAdmission(task.id).admissionDeferredReason,
    "model_capacity",
  );
  const deferredReplay = database.deferTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", admissionReceiptId: domainReservationA.receipt.id,
    admissionAttemptId: domainReservationA.receipt.admissionAttemptId,
  });
  assert.equal(deferredReplay.applied, false);
  assert.equal(deferredReplay.receipt.admissionRetryCount, 1);
  assert.equal(deferredReplay.receipt.admissionRetryAfter, deferred.receipt.admissionRetryAfter);
  const retryReservation = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-capacity-retry",
  });
  assert.equal(retryReservation.available, true);
  assert.equal(retryReservation.receipt.admissionRetryCount, 1);
  assert.equal(retryReservation.receipt.admissionDeferredReason, null);
  assert.equal(retryReservation.receipt.admissionRetryAfter, null);
  database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-capacity-retry",
  });
  const secondDeferred = database.deferTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", admissionReceiptId: retryReservation.receipt.id,
    admissionAttemptId: retryReservation.receipt.admissionAttemptId,
  });
  assert.equal(secondDeferred.receipt.admissionRetryCount, 2);
  assert.ok(Date.parse(secondDeferred.receipt.admissionRetryAfter) >= Date.now() + 29_000);
  const deferredRow = database.database.prepare(
    "SELECT * FROM task_safe_action_receipts WHERE id = ?",
  ).get(domainReservationA.receipt.id);

  const configA = database.getAgentLaneProject("control-plane");
  database.upsertAgentLaneProject("control-plane", {
    ...configA,
    domainCoordinatorLeases: {
      frontend: {
        ...configA.domainCoordinatorLeases.frontend,
        expiresAt: new Date(
          Date.parse(configA.domainCoordinatorLeases.frontend.acquiredAt) + 1_000,
        ).toISOString(),
      },
    },
  });
  const recovered = database.claimAgentLaneDomainCoordinator("control-plane", "frontend", {
    holderTaskId: "frontend", holderThreadId: "frontend-thread",
    holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
    expectedLeaseId: "frontend-lease-a", leaseDurationSeconds: 120, recoverOnly: true,
  });
  assert.notEqual(recovered.lease.id, "frontend-lease-a");
  const recoveredCapsule = database.getTaskCapsule(task.id);
  assert.notEqual(recoveredCapsule.resumeToken, domainCapsuleA.resumeToken);
  assert.equal(database.getTaskSafeActionAdmission(task.id), null);
  assert.throws(() => database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleA.resumeToken,
    safeActionId: "execute", reservationLeaseId: "stale-retry",
  }), (error) => error?.code === "RESUME_TOKEN_MISMATCH");
  assert.deepEqual(database.database.prepare(
    "SELECT * FROM task_safe_action_receipts WHERE id = ?",
  ).get(domainReservationA.receipt.id), deferredRow);

  const domainCapsuleB = database.getTaskCapsule(task.id);
  const domainReservationB = database.claimTaskSafeAction(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleB.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-reservation-b",
  });
  database.confirmTaskSafeActionDelivery(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleB.resumeToken,
    safeActionId: "execute", reservationLeaseId: "domain-reservation-b",
  });
  const prepared = database.prepareTaskSafeActionAdmission(task.id, {
    rootThreadId: "frontend-thread", expectedResumeToken: domainCapsuleB.resumeToken,
    safeActionId: "execute", admissionReceiptId: domainReservationB.receipt.id,
    admissionAttemptId: domainReservationB.receipt.admissionAttemptId, writeScope: ["web/src"],
  });
  const claimed = database.claimAgentTask(task.id, database.getTask(task.id).version, {
    agentPath: prepared.receipt.admissionAgentPath, agentThreadId: "frontend-agent",
    rootThreadId: "frontend-thread",
    leaseExpiresAt: new Date(Date.parse(recovered.lease.expiresAt) - 1_000).toISOString(),
    writeScope: ["web/src"], admissionReceiptId: prepared.receipt.id,
    admissionAttemptId: prepared.receipt.admissionAttemptId,
  });
  assert.equal(claimed.task.status, "in_progress");
  assert.equal(database.completeAgentTask(task.id, {
    eventId: "frontend-complete", agentThreadId: "frontend-agent",
    summary: "Bounded frontend outcome complete", actor,
  }).applied, true);
  database.close();

  const reopened = new TaskboardDatabase(databasePath);
  assert.equal(reopened.listProjectOwnerIntents("control-plane").length, 1);
  assert.equal(reopened.listProjectOwnerIntentPlan("control-plane").length, 1);
  assert.equal(reopened.getTask(task.id).status, "in_review");
  assert.equal(reopened.listComments(task.id).filter((comment) => (
    comment.body.startsWith("Sub-Agent 完成：")
  )).length, 1);
  reopened.close();
});

test("Owner Intent replanning is durably bounded after three invalid coordinator plans", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owner-intent-retry-limit-"));
  directories.push(directory);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "retry-limit", name: "Retry limit", workspacePath: null });
  database.upsertAgentLaneProject("retry-limit", {
    rootTaskId: "coordinator",
    ownerRootTaskId: "owner",
    tasks: [
      { id: "owner", label: "Owner", owner: "Codex", source: "codex", threadId: "owner-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/owner" },
      { id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex", threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/coordinator" },
    ],
    adapters: [],
  });
  const ownerBinding = {
    threadId: "owner-thread", codexProjectId: "retry-limit", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/owner",
  };
  database.recordProjectOwnerIntent("retry-limit", {
    intentId: "retry-intent", deliveryId: "retry-delivery", kind: "append",
    goal: "Derive one bounded plan", constraints: [], targetIntentId: null,
    ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
    ownerTurnId: "owner-turn", rootCaptureTurnId: "capture-turn", evidence: "synthetic",
  }, ownerBinding, actor);

  let lastFailureKey;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const adoption = database.claimProjectOwnerIntentAdoption("retry-limit", "retry-intent", {
      coordinatorTaskId: "coordinator", coordinatorThreadId: "coordinator-thread",
      coordinatorEpoch: "configured:coordinator",
    });
    const deliveryTurnId = `invalid-plan-turn-${attempt}`;
    database.confirmProjectOwnerIntentAdoption("retry-limit", "retry-intent", {
      adoptionId: adoption.receipt.id, deliveryTurnId,
    });
    const request = {
      intentId: "retry-intent",
      version: attempt,
      adoptionReceipt: { ...adoption.receipt, deliveryTurnId },
      route: {
        coordinatorTaskId: "coordinator",
        coordinatorThreadId: "coordinator-thread",
        codexHostId: "local",
        coordinatorWorkspacePath: "/tmp/coordinator",
      },
    };
    const terminalStatus = attempt === 2 ? "interrupted" : "failed";
    let retried;
    const monitorResult = await runOwnerIntentPlanningMonitorOnce({
      policy: { enabled: true, projectId: "retry-limit" },
      readSnapshot: async () => ({
        projectId: "retry-limit",
        coordination: { pendingOwnerIntentPlan: request },
      }),
      observePlan: (current) => observeTaskboardOwnerIntentPlan(current, async () => ({
        thread: {
          id: "coordinator-thread",
          cwd: "/tmp/coordinator",
          turns: [{ id: deliveryTurnId, status: terminalStatus, items: [] }],
        },
      })),
      applyPlan: async () => assert.fail("terminal planning turns cannot apply a plan"),
      scheduleRetry: async (current, failure) => {
        lastFailureKey = `${current.adoptionReceipt.id}:${failure.reason}`;
        retried = database.retryProjectOwnerIntentPlan("retry-limit", "retry-intent", {
          adoptionId: current.adoptionReceipt.id,
          coordinatorEpoch: current.adoptionReceipt.coordinatorEpoch,
          failureKey: lastFailureKey,
        });
        const replay = database.retryProjectOwnerIntentPlan("retry-limit", "retry-intent", {
          adoptionId: current.adoptionReceipt.id,
          coordinatorEpoch: current.adoptionReceipt.coordinatorEpoch,
          failureKey: lastFailureKey,
        });
        assert.equal(replay.applied, false);
        assert.equal(replay.intent.planRetryCount, retried.intent.planRetryCount);
        return retried;
      },
    });
    assert.deepEqual(monitorResult, {
      applied: false,
      reason: attempt === 3 ? "plan-retry-exhausted" : "plan-retry-scheduled",
    });
    assert.equal(retried.intent.planRetryCount, attempt);
    assert.equal(retried.exhausted, attempt === 3);
    assert.equal(retried.intent.status, attempt === 3 ? "needs_decision" : "queued");
  }
  const exhausted = database.listProjectOwnerIntents("retry-limit")[0];
  assert.equal(exhausted.status, "needs_decision");
  assert.equal(exhausted.planRetryCount, 3);
  assert.equal(database.getPendingProjectOwnerIntent("retry-limit"), null);
  const replay = database.retryProjectOwnerIntentPlan("retry-limit", "retry-intent", {
    adoptionId: "already-removed", coordinatorEpoch: "configured:coordinator",
    failureKey: lastFailureKey,
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.exhausted, true);
  database.close();

  const reopened = new TaskboardDatabase(databasePath);
  assert.equal(reopened.listProjectOwnerIntents("retry-limit")[0].planRetryCount, 3);
  assert.equal(reopened.getPendingProjectOwnerIntent("retry-limit"), null);
  reopened.close();
});

test("Agent Lane snapshot stays readable while an adopted Owner Intent waits for coordinator recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owner-intent-lease-recovery-"));
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "intent-recovery", name: "Intent recovery", workspacePath: null });
  const activeLease = {
    id: "coordinator-lease-a",
    holderTaskId: "coordinator",
    holderThreadId: "coordinator-thread",
    holderCodexHostId: "local",
    holderWorkspacePath: "/tmp/intent-recovery-coordinator",
    acquiredAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    releasedAt: null,
  };
  const config = {
    rootTaskId: "coordinator",
    ownerRootTaskId: "owner",
    tasks: [
      {
        id: "owner", label: "Owner", owner: "Codex", source: "codex",
        threadId: "owner-thread", taskType: "root_task", codexHostId: "local",
        workspacePath: "/tmp/intent-recovery-owner",
      },
      {
        id: "coordinator", label: "Coordinator", owner: "Codex", source: "codex",
        threadId: "coordinator-thread", taskType: "root_task", codexHostId: "local",
        workspacePath: "/tmp/intent-recovery-coordinator",
      },
    ],
    adapters: [],
    coordinatorLease: activeLease,
  };
  database.upsertAgentLaneProject("intent-recovery", config);
  const ownerBinding = {
    threadId: "owner-thread", codexProjectId: "intent-recovery", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/intent-recovery-owner",
  };
  database.recordProjectOwnerIntent("intent-recovery", {
    intentId: "recoverable-intent", deliveryId: "recoverable-delivery", kind: "append",
    goal: "Resume planning after the next Coordinator acquires a valid lease.", constraints: [],
    targetIntentId: null, ownerRootTaskId: "owner", ownerRootThreadId: "owner-thread",
    ownerTurnId: "owner-turn", rootCaptureTurnId: "capture-turn", evidence: "synthetic",
  }, ownerBinding, actor);
  const adoption = database.claimProjectOwnerIntentAdoption("intent-recovery", "recoverable-intent", {
    coordinatorTaskId: "coordinator", coordinatorThreadId: "coordinator-thread",
    coordinatorEpoch: "lease:coordinator-lease-a",
  });
  database.confirmProjectOwnerIntentAdoption("intent-recovery", "recoverable-intent", {
    adoptionId: adoption.receipt.id, deliveryTurnId: "adopted-turn",
  });
  const provider = createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    getLaneConfig: (projectId) => database.getAgentLaneProject(projectId),
    listTasks: (projectId) => database.listTasks({ projectId, archived: "false" }),
    getTaskCapsule: (taskId) => database.getTaskCapsule(taskId),
    listComments: (taskId) => database.listComments(taskId),
    getPendingOwnerIntent: (projectId) => database.getPendingProjectOwnerIntent(projectId),
    getPendingOwnerIntentPlan: (projectId) => database.getPendingProjectOwnerIntentPlan(projectId),
  });

  const invalidLeases = [
    {
      ...activeLease,
      id: "expired-lease",
      acquiredAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-08-31T00:01:00.000Z",
    },
    {
      ...activeLease,
      id: "released-lease",
      releasedAt: "2026-08-31T00:01:00.000Z",
    },
    {
      ...activeLease,
      id: "future-lease",
      acquiredAt: "2098-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    {
      ...activeLease,
      id: "binding-drift-lease",
      holderThreadId: "stale-coordinator-thread",
    },
  ];
  for (const coordinatorLease of invalidLeases) {
    database.upsertAgentLaneProject("intent-recovery", { ...config, coordinatorLease });
    const snapshot = await provider.getProjectSnapshot("intent-recovery");
    assert.equal(snapshot.coordination.coordinatorTaskId, null);
    assert.equal(snapshot.coordination.pendingOwnerIntent, null);
    assert.equal(snapshot.coordination.pendingOwnerIntentPlan, null);
  }

  database.upsertAgentLaneProject("intent-recovery", {
    ...config,
    coordinatorLease: { ...activeLease, id: "coordinator-lease-b" },
  });
  const recovered = await provider.getProjectSnapshot("intent-recovery");
  assert.equal(recovered.coordination.pendingOwnerIntent.intentId, "recoverable-intent");
  assert.equal(recovered.coordination.pendingOwnerIntent.status, "adopted");
  assert.equal(recovered.coordination.pendingOwnerIntent.coordinatorEpoch, "lease:coordinator-lease-b");
  assert.equal(recovered.coordination.pendingOwnerIntentPlan, null);
  database.close();
});

test("cross-domain dependencies require exact target coordinator clearance and reject cycles", async () => {
  const directory = path.join(os.tmpdir(), `cross-domain-clearance-${Date.now()}`);
  directories.push(directory);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "cross-domain", name: "Cross domain", workspacePath: null });
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const config = {
    tasks: [
      { id: "global", label: "Global", owner: "Codex", source: "codex", threadId: "global-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/global" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "frontend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/frontend" },
      { id: "backend", label: "Backend", owner: "Codex", source: "codex", threadId: "backend-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/backend" },
      { id: "backend-next", label: "Backend next", owner: "Codex", source: "codex", threadId: "backend-next-thread", taskType: "peer_task", codexHostId: "local", workspacePath: "/tmp/backend-next" },
    ],
    adapters: [],
    coordinatorLease: { id: "global-lease", holderTaskId: "global", holderThreadId: "global-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/global", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["backend", "backend-next"] },
    ],
    domainCoordinatorLeases: {
      frontend: { id: "frontend-lease", holderTaskId: "frontend", holderThreadId: "frontend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
      backend: { id: "backend-lease", holderTaskId: "backend", holderThreadId: "backend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/backend", acquiredAt: "2026-08-31T00:00:00.000Z", expiresAt },
    },
  };
  database.upsertAgentLaneProject("cross-domain", config);
  const binding = {
    threadId: "global-thread", codexProjectId: "cross-domain", codexProjectKind: "local",
    codexHostId: "local", workspacePath: "/tmp/global",
  };
  const createTodo = (title) => database.createTask({
    projectId: "cross-domain", title, description: "", status: "todo", priority: "high",
    labels: ["agent-todo"], threadId: binding.threadId, threadBinding: binding,
    actor, assignee: actor, workflowId: null, workflowProfile: "vibe",
    developmentContext: { type: "worktree", path: "/tmp/product", branch: "codex/cross-domain" },
    startDate: null, dueDate: null, recurrence: null,
  });
  let source = createTodo("Frontend artifact");
  let target = createTodo("Backend consumer");
  source = database.setAgentTaskDomain("cross-domain", source.id, {
    domainId: "frontend", taskVersion: source.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }).task;
  target = database.setAgentTaskDomain("cross-domain", target.id, {
    domainId: "backend", taskVersion: target.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }).task;
  source = database.addTaskRelation(
    source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  assert.ok(database.getTaskCapsule(target.id).readyWork.reasonCodes.includes("BLOCKED_BY_INCOMPLETE"));
  const directClaim = () => database.claimAgentTask(target.id, target.version, {
    agentPath: "/root/backend-worker", agentThreadId: "backend-worker-thread",
    rootThreadId: "backend-thread", leaseExpiresAt: "2098-01-01T00:00:00.000Z",
    writeScope: ["server/cross-domain.mjs"],
  });
  assert.throws(directClaim, (error) => error?.code === "TASK_DEPENDENCY_NOT_READY");

  source = database.moveTask(source.id, source.version, "done", undefined, binding.threadId, binding, actor);
  let targetCapsule = database.getTaskCapsule(target.id);
  assert.ok(targetCapsule.readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));
  assert.deepEqual(
    {
      sourceAssignedByTaskId: targetCapsule.dependencyClearances[0].sourceAssignedByTaskId,
      sourceAssignedByThreadId: targetCapsule.dependencyClearances[0].sourceAssignedByThreadId,
      targetAssignedByTaskId: targetCapsule.dependencyClearances[0].targetAssignedByTaskId,
      targetAssignedByThreadId: targetCapsule.dependencyClearances[0].targetAssignedByThreadId,
    },
    {
      sourceAssignedByTaskId: "global", sourceAssignedByThreadId: "global-thread",
      targetAssignedByTaskId: "global", targetAssignedByThreadId: "global-thread",
    },
  );
  assert.throws(directClaim, (error) => error?.code === "TASK_DEPENDENCY_NOT_READY");
  let pendingFrontier = targetCapsule.dependencyClearances[0];
  const snapshotProvider = createAgentLaneSnapshotProvider({
    sessionsDirectory: path.join(directory, "sessions"),
    now: () => new Date("2026-08-31T02:00:00.000Z"),
    getLaneConfig: (projectId) => database.getAgentLaneProject(projectId),
    listTasks: (projectId) => database.listTasks({ projectId, archived: "false" }),
    getClaim: (taskId) => database.getAgentTaskClaim(taskId),
    getTaskCapsule: (taskId) => database.getTaskCapsule(taskId),
    listComments: (taskId) => database.listComments(taskId),
    getTaskDomainAssignment: (taskId) => database.getAgentTaskDomainAssignment(taskId),
  });
  const pendingSnapshot = await snapshotProvider.getProjectSnapshot("cross-domain");
  assert.deepEqual(
    {
      sourceTaskId: pendingSnapshot.coordination.pendingCrossDomainHandoff.sourceTaskId,
      targetTaskId: pendingSnapshot.coordination.pendingCrossDomainHandoff.targetTaskId,
      targetThreadId: pendingSnapshot.coordination.pendingCrossDomainHandoff.route.targetThreadId,
      fingerprint: pendingSnapshot.coordination.pendingCrossDomainHandoff.fingerprint,
    },
    {
      sourceTaskId: source.id,
      targetTaskId: target.id,
      targetThreadId: "backend-thread",
      fingerprint: pendingFrontier.fingerprint,
    },
  );
  let secondSource = createTodo("Second frontend artifact");
  secondSource = database.setAgentTaskDomain("cross-domain", secondSource.id, {
    domainId: "frontend", taskVersion: secondSource.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }).task;
  secondSource = database.addTaskRelation(
    secondSource.id, secondSource.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  secondSource = database.moveTask(
    secondSource.id, secondSource.version, "done", undefined, binding.threadId, binding, actor,
  );
  const multiBlockerSnapshot = await snapshotProvider.getProjectSnapshot("cross-domain");
  assert.equal(multiBlockerSnapshot.coordination.pendingCrossDomainHandoff.sourceTaskId, source.id);
  secondSource = database.removeTaskRelation(
    secondSource.id, secondSource.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  target = database.moveTask(target.id, target.version, "in_progress", undefined, binding.threadId, binding, actor);
  assert.equal((await snapshotProvider.getProjectSnapshot("cross-domain")).coordination.pendingCrossDomainHandoff, null);
  target = database.moveTask(target.id, target.version, "todo", undefined, binding.threadId, binding, actor);
  targetCapsule = database.getTaskCapsule(target.id);
  pendingFrontier = targetCapsule.dependencyClearances[0];
  const deliveryRequest = {
    projectId: "cross-domain",
    sourceTaskId: source.id,
    targetTaskId: target.id,
    fingerprint: pendingFrontier.fingerprint,
    expectedTargetDomainLeaseId: "backend-lease",
    targetHolderTaskId: "backend",
    route: {
      targetThreadId: "backend-thread",
      codexHostId: "local",
      targetWorkspacePath: "/tmp/backend",
    },
  };
  const deliveryClaim = database.claimCrossDomainHandoffDelivery("cross-domain", deliveryRequest);
  assert.equal(deliveryClaim.claimed, true);
  const deliveryReplay = database.claimCrossDomainHandoffDelivery("cross-domain", deliveryRequest);
  assert.equal(deliveryReplay.claimed, false);
  assert.equal(deliveryReplay.reason, "reserved");
  assert.equal(deliveryReplay.receipt.id, deliveryClaim.receipt.id);
  database.upsertAgentLaneProject("cross-domain", {
    ...config,
    domainCoordinatorLeases: {
      ...config.domainCoordinatorLeases,
      backend: { ...config.domainCoordinatorLeases.backend, expiresAt: "2020-01-01T00:00:00.000Z" },
    },
  });
  assert.throws(() => database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "backend-handoff-turn",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE");
  database.upsertAgentLaneProject("cross-domain", {
    ...config,
    tasks: config.tasks.map((lane) => lane.id === "backend"
      ? { ...lane, workspacePath: "/tmp/backend-moved" }
      : lane),
  });
  assert.throws(() => database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "backend-handoff-turn",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE");
  database.upsertAgentLaneProject("cross-domain", config);
  const deliveryConfirmation = database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "backend-handoff-turn",
  });
  assert.equal(deliveryConfirmation.confirmed, true);
  assert.equal(database.getTaskCapsule(target.id).dependencyClearances[0].status, "awaiting_handoff");
  database.upsertAgentLaneProject("cross-domain", {
    ...config,
    tasks: config.tasks.map((lane) => lane.id === "backend"
      ? { ...lane, workspacePath: "/tmp/backend-after-delivery" }
      : lane),
  });
  assert.throws(() => database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "backend-handoff-turn",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE");
  database.upsertAgentLaneProject("cross-domain", config);
  assert.equal(database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "backend-handoff-turn",
  }).reused, true);
  assert.throws(() => database.confirmCrossDomainHandoffDelivery("cross-domain", {
    deliveryId: deliveryClaim.receipt.id,
    deliveryTurnId: "another-turn",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_DELIVERY_CONFLICT");
  assert.throws(() => database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-1", holderTaskId: "frontend",
    holderThreadId: "frontend-thread", expectedTargetDomainLeaseId: "frontend-lease",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_ROUTE_MISMATCH");
  assert.throws(() => database.setAgentTaskDomain("cross-domain", source.id, {
    domainId: null, taskVersion: source.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }), (error) => error?.code === "DOMAIN_TODO_OUTBOUND_DEPENDENCY");
  assert.equal(database.getAgentTaskDomainAssignment(source.id).domainId, "frontend");

  const accepted = database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-1", holderTaskId: "backend",
    holderThreadId: "backend-thread", expectedTargetDomainLeaseId: "backend-lease",
  });
  assert.equal(accepted.applied, true);
  assert.equal(database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-1", holderTaskId: "backend",
    holderThreadId: "backend-thread", expectedTargetDomainLeaseId: "backend-lease",
  }).applied, false);
  targetCapsule = database.getTaskCapsule(target.id);
  assert.ok(!targetCapsule.readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));

  database.upsertAgentLaneProject("cross-domain", {
    ...config,
    domainCoordinatorLeases: {
      ...config.domainCoordinatorLeases,
      backend: {
        id: "backend-next-lease", holderTaskId: "backend-next",
        holderThreadId: "backend-next-thread", holderCodexHostId: "local",
        holderWorkspacePath: "/tmp/backend-next",
        acquiredAt: "2026-08-31T01:00:00.000Z", expiresAt,
      },
    },
  });
  assert.throws(
    () => database.claimCrossDomainHandoffDelivery("cross-domain", deliveryRequest),
    (error) => error?.code === "CROSS_DOMAIN_HANDOFF_DELIVERY_STALE",
  );
  assert.ok(database.getTaskCapsule(target.id).readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));
  assert.throws(() => database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-1", holderTaskId: "backend-next",
    holderThreadId: "backend-next-thread", expectedTargetDomainLeaseId: "backend-next-lease",
  }), (error) => error?.code === "CROSS_DOMAIN_HANDOFF_IDEMPOTENCY_CONFLICT");
  assert.equal(database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-2", holderTaskId: "backend-next",
    holderThreadId: "backend-next-thread", expectedTargetDomainLeaseId: "backend-next-lease",
  }).applied, true);
  source = database.removeTaskRelation(
    source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  source = database.addTaskRelation(
    source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  assert.ok(database.getTaskCapsule(target.id).readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));
  assert.throws(() => database.addTaskRelation(
    target.id, target.version, "blocks", source.id, binding.threadId, binding, actor,
  ), (error) => error?.code === "DEPENDENCY_CYCLE");
  assert.equal(database.acceptCrossDomainDependencyClearance(target.id, {
    sourceTaskId: source.id, idempotencyKey: "clearance-3", holderTaskId: "backend-next",
    holderThreadId: "backend-next-thread", expectedTargetDomainLeaseId: "backend-next-lease",
  }).applied, true);
  assert.throws(() => database.setAgentTaskDomain("cross-domain", source.id, {
    domainId: null, taskVersion: source.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }), (error) => error?.code === "DOMAIN_TODO_OUTBOUND_DEPENDENCY");
  source = database.removeTaskRelation(
    source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  source = database.setAgentTaskDomain("cross-domain", source.id, {
    domainId: null, taskVersion: source.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }).task;
  assert.equal(database.getAgentTaskDomainAssignment(source.id), null);
  assert.equal(database.getAgentTaskDomainProvenance(source.id).domainId, "frontend");
  source = database.addTaskRelation(
    source.id, source.version, "blocks", target.id, binding.threadId, binding, actor,
  ).task;
  const rebuiltFrontier = database.getTaskCapsule(target.id).dependencyClearances.find(
    (frontier) => frontier.sourceTaskId === source.id,
  );
  assert.equal(rebuiltFrontier.sourceDomainId, "frontend");
  assert.equal(rebuiltFrontier.status, "awaiting_handoff");
  assert.ok(database.getTaskCapsule(target.id).readyWork.reasonCodes.includes("CROSS_DOMAIN_HANDOFF_REQUIRED"));

  let unassignedSource = createTodo("Completed source before target routing");
  const unassignedTarget = createTodo("Unassigned future consumer");
  unassignedSource = database.setAgentTaskDomain("cross-domain", unassignedSource.id, {
    domainId: "frontend", taskVersion: unassignedSource.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }).task;
  unassignedSource = database.addTaskRelation(
    unassignedSource.id, unassignedSource.version, "blocks", unassignedTarget.id,
    binding.threadId, binding, actor,
  ).task;
  unassignedSource = database.moveTask(
    unassignedSource.id, unassignedSource.version, "done", undefined, binding.threadId, binding, actor,
  );
  assert.throws(() => database.setAgentTaskDomain("cross-domain", unassignedSource.id, {
    domainId: null, taskVersion: unassignedSource.version, holderTaskId: "global",
    holderThreadId: "global-thread", expectedCoordinatorLeaseId: "global-lease",
  }), (error) => error?.code === "DOMAIN_TODO_OUTBOUND_DEPENDENCY");
  database.close();
});

test("one Sub-Agent thread cannot hold two active claims in a project", async () => {
  const fixture = await setup();
  const second = fixture.database.createTask({
    projectId: "capstone-dev", title: "第二个任务", description: "", status: "todo",
    priority: "medium", labels: ["agent-todo"], threadId: fixture.rootBinding.threadId,
    threadBinding: fixture.rootBinding, actor, assignee: actor,
    developmentContext: fixture.developmentContext, startDate: null, dueDate: null, recurrence: null,
  });
  fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/database.mjs"],
  });
  assert.throws(
    () => fixture.database.claimAgentTask(second.id, second.version, {
      agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/database.mjs"],
    }),
    (error) => error?.code === "AGENT_ALREADY_CLAIMED",
  );
  assert.equal(fixture.database.getTask(second.id).status, "todo");
  fixture.database.close();
});

test("projects Capsule eligibility, dispatch targets, Working Logs, and durable runs into Agent Todos", async () => {
  const fixture = await setup();
  const readyTask = fixture.database.createTask({
    projectId: "capstone-dev", title: "Capsule-ready task", description: "", status: "todo",
    priority: "medium", labels: [], threadId: fixture.rootBinding.threadId, threadBinding: fixture.rootBinding,
    actor, assignee: actor, developmentContext: fixture.developmentContext,
    workingLog: {
      path: `${fixture.rootBinding.workspacePath}/CAP-READY-WORKING-LOG.md`,
      status: "planned",
    },
    startDate: null, dueDate: null, recurrence: null,
  });
  const legacyBacklog = fixture.database.createTask({
    projectId: "capstone-dev", title: "Legacy backlog", description: "", status: "backlog",
    priority: "low", labels: ["agent-todo"], threadId: fixture.rootBinding.threadId,
    threadBinding: fixture.rootBinding, actor, assignee: actor, developmentContext: fixture.developmentContext,
    startDate: null, dueDate: null, recurrence: null,
  });
  let snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  const readyTodo = snapshot.todos.find((todo) => todo.id === readyTask.identifier);
  const legacyTodo = snapshot.todos.find((todo) => todo.id === legacyBacklog.identifier);
  assert.equal(readyTodo?.readyWork.eligible, true);
  assert.equal(readyTodo?.state, "ready");
  assert.equal(readyTodo?.claimedBy, null);
  assert.equal(readyTodo?.claim, null);
  assert.deepEqual(readyTodo?.continuation, { route: "ready_for_agent", attention: "ready" });
  assert.equal(readyTodo?.recovery.eligible, false);
  assert.deepEqual(readyTodo?.dispatchTarget, {
    rootThreadId: fixture.rootBinding.threadId,
    codexHostId: fixture.rootBinding.codexHostId,
    rootWorkspacePath: fixture.rootBinding.workspacePath,
    worktreePath: fixture.developmentContext.path,
  });
  assert.equal(readyTodo?.workingLog?.path, `${fixture.rootBinding.workspacePath}/CAP-READY-WORKING-LOG.md`);
  assert.equal(readyTodo?.workingLog?.status, "planned");
  assert.match(readyTodo?.workingLog?.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readyTodo?.run, null);
  assert.equal(legacyTodo?.readyWork.eligible, false);
  assert.match(legacyTodo?.readyWork.reasonCodes.join(",") ?? "", /BACKLOG_NOT_ELIGIBLE/);
  assert.equal(legacyTodo?.state, "blocked");
  assert.notEqual(legacyTodo?.continuation.attention, "ready");
  assert.equal(legacyTodo?.continuation.route, "blocked");
  assert.equal(legacyTodo?.recovery.eligible, false);

  const claimed = fixture.database.claimAgentTask(readyTask.id, readyTask.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/agent-lane-snapshot.mjs"],
  });
  snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  const runningTodo = snapshot.todos.find((todo) => todo.id === readyTask.identifier);
  assert.equal(runningTodo?.readyWork.eligible, false);
  assert.equal(runningTodo?.run?.id, claimed.run.id);
  assert.equal(runningTodo?.run?.state, "active");
  assert.equal(runningTodo?.run?.durable, true);
  fixture.database.close();
});

test("keeps a non-Git Root workspace separate from the Git execution target", async () => {
  const fixture = await setup();
  const coordinationBinding = {
    ...fixture.rootBinding,
    workspacePath: "/Users/owner/capstone-coordination",
  };
  const executionTarget = {
    type: "worktree",
    path: "/tmp/capstone-execution-worktree",
    branch: "codex/capstone-e2e",
  };
  const task = fixture.database.createTask({
    projectId: "capstone-dev", title: "Separated Root and execution target", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: coordinationBinding.threadId,
    threadBinding: coordinationBinding, actor, assignee: actor, developmentContext: executionTarget,
    workingLog: {
      path: `${executionTarget.path}/CAPSTONE-WORKING-LOG.md`,
      status: "planned",
    },
    startDate: null, dueDate: null, recurrence: null,
  });

  const snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  const todo = snapshot.todos.find((candidate) => candidate.id === task.identifier);
  assert.equal(todo?.readyWork.eligible, true);
  assert.doesNotMatch(todo?.readyWork.reasonCodes.join(",") ?? "", /ROOT_WORKTREE_MISMATCH/);
  assert.deepEqual(todo?.dispatchTarget, {
    rootThreadId: coordinationBinding.threadId,
    codexHostId: coordinationBinding.codexHostId,
    rootWorkspacePath: coordinationBinding.workspacePath,
    worktreePath: executionTarget.path,
  });

  const claimed = fixture.database.claimAgentTask(task.id, task.version, {
    agentPath: "/root/capstone_e2e", agentThreadId: "capstone-e2e-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["test/e2e"],
  });
  assert.equal(claimed.run.worktree.path, executionTarget.path);
  assert.equal(claimed.run.rootThreadId, coordinationBinding.threadId);
  fixture.database.close();
});

test("projects safe continuation and one exact authorization gate into Agent Todos", async () => {
  const fixture = await setup();
  const gatedTask = fixture.database.createTask({
    projectId: "capstone-dev", title: "Authorization-aware task", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: fixture.rootBinding.threadId, threadBinding: fixture.rootBinding,
    actor, assignee: actor, developmentContext: fixture.developmentContext,
    workingLog: {
      path: `${fixture.rootBinding.workspacePath}/CAP-4-WORKING-LOG.md`,
      status: "active",
    },
    startDate: null, dueDate: null, recurrence: null,
  });
  fixture.database.createComment(gatedTask.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [
        {
          id: "local", kind: "test", state: "authorized", scope: "local tests",
          approver: "Owner", approvalRequest: "同意执行本地测试",
          evidence: "Owner resumed", receipt: "turn:resume",
        },
        { id: "push", kind: "push", state: "approval_required", scope: "exact commit", approver: "Owner", approvalRequest: "同意推送 exact commit" },
      ],
      actions: [
        { id: "test", order: 10, text: "Run local acceptance", gate: "local", target: "candidate", status: "pending" },
        { id: "push", order: 20, text: "Push exact commit", gate: "push", target: "origin", status: "pending" },
      ],
    })}\n\`\`\``,
    threadId: fixture.rootBinding.threadId,
    threadBinding: fixture.rootBinding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });

  let snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  let todo = snapshot.todos.find((entry) => entry.id === gatedTask.identifier);
  assert.deepEqual(todo?.readyWork.safeActions.map((action) => action.id), ["test"]);
  assert.deepEqual(todo?.readyWork.deferredActions.map((action) => action.id), ["push"]);
  assert.equal(todo?.readyWork.approvalRequest, null);
  assert.equal(todo?.readyWork.eligible, true);

  const comment = fixture.database.listComments(gatedTask.id)[0];
  fixture.database.updateComment(comment.id, comment.version, `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
    gates: [
      { id: "push", kind: "push", state: "approval_required", scope: "exact commit", approver: "Owner", approvalRequest: "同意推送 exact commit" },
    ],
    actions: [
      { id: "push", order: 20, text: "Push exact commit", gate: "push", target: "origin", status: "pending" },
    ],
  })}\n\`\`\``, fixture.rootBinding.threadId, fixture.rootBinding);

  const urgentTask = fixture.database.createTask({
    projectId: "capstone-dev", title: "Urgent Root-only decision", description: "", status: "todo",
    priority: "urgent", labels: [], workflowProfile: "vibe",
    threadId: fixture.rootBinding.threadId, threadBinding: fixture.rootBinding,
    actor, assignee: actor, developmentContext: fixture.developmentContext,
    workingLog: null, startDate: null, dueDate: null, recurrence: null,
  });
  fixture.database.createComment(urgentTask.id, {
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
      gates: [{
        id: "deploy", kind: "deploy", state: "approval_required", scope: "exact environment",
        approver: "Owner", approvalRequest: "同意 exact deployment",
      }],
      actions: [{
        id: "deploy", order: 10, text: "Deploy exact candidate", gate: "deploy",
        target: "environment", status: "pending",
      }],
    })}\n\`\`\``,
    threadId: fixture.rootBinding.threadId,
    threadBinding: fixture.rootBinding,
    actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
  });

  snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  todo = snapshot.todos.find((entry) => entry.id === gatedTask.identifier);
  assert.equal(todo?.readyWork.eligible, false);
  assert.equal(todo?.readyWork.approvalRequest?.message, "同意推送 exact commit");
  assert.match(todo?.readyWork.approvalRequest?.expectedResumeToken ?? "", /^[a-f0-9]{64}$/);
  assert.equal(snapshot.coordination.ownerDecisionRequest.identifier, urgentTask.identifier);
  assert.equal(snapshot.coordination.ownerDecisionRequest.message, "同意 exact deployment");
  assert.equal(snapshot.coordination.ownerDecisionRequest.route.rootThreadId, fixture.rootBinding.threadId);
  fixture.database.close();
});

test("projects a durable legacy claim without treating the Root binding as ownership", async () => {
  const fixture = await setup();
  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/agent-lane-snapshot.mjs"],
  });
  fixture.database.database.prepare("DELETE FROM task_agent_runs WHERE task_id = ?").run(fixture.task.id);

  const snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
  const todo = snapshot.todos.find((entry) => entry.id === fixture.task.identifier);
  assert.equal(todo?.claimedBy, claimed.claim.agentPath);
  assert.equal(todo?.claim?.ownerLabel, claimed.claim.agentPath);
  assert.equal(todo?.claim?.leaseState, "active");
  assert.equal(todo?.run?.durable, false);
  assert.equal(todo?.run?.state, "active");
  assert.deepEqual(todo?.continuation, { route: "wait", attention: "watch" });
  assert.equal(todo?.recovery.eligible, false);
  fixture.database.close();
});

test("persists lease and write scope, renews the same claim, and rejects stale claim events", async () => {
  const fixture = await setup();
  assert.throws(
    () => fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
      agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    }),
    (error) => error?.code === "INVALID_AGENT_LEASE",
  );

  const first = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    writeScope: ["server/database.mjs"],
  });
  assert.equal(first.claim.leaseExpiresAt, "2099-01-01T00:00:00.000Z");
  assert.deepEqual(first.claim.writeScope, ["server/database.mjs"]);

  const renewed = fixture.database.claimAgentTask(fixture.task.id, first.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-02T00:00:00.000Z",
    writeScope: ["server/database.mjs", "test/agent-lane-coordination.test.mjs"],
  });
  assert.equal(renewed.task.version, first.task.version);
  assert.equal(renewed.claim.leaseExpiresAt, "2099-01-02T00:00:00.000Z");

  fixture.database.database.prepare(
    "UPDATE agent_task_claims SET lease_expires_at = ? WHERE task_id = ?",
  ).run("2000-01-01T00:00:00.000Z", fixture.task.id);
  assert.deepEqual(fixture.database.recordAgentTaskProgress(fixture.task.id, {
    eventId: "late-progress", agentThreadId: "acceptance-thread", summary: "too late", actor,
  }), { applied: false, reason: "claim_expired" });
  assert.deepEqual(fixture.database.completeAgentTask(fixture.task.id, {
    eventId: "late-completion", agentThreadId: "acceptance-thread", summary: "too late", actor,
  }), { applied: false, reason: "claim_expired" });

  fixture.database.close();
  const reopened = new TaskboardDatabase(fixture.databasePath);
  assert.equal(reopened.getAgentTaskClaim(fixture.task.id).leaseExpiresAt, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(reopened.getAgentTaskClaim(fixture.task.id).writeScope, [
    "server/database.mjs", "test/agent-lane-coordination.test.mjs",
  ]);
  reopened.close();
});

test("manual move interrupts an active claim and expired projection remains manual-only", async () => {
  const fixture = await setup();
  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/database.mjs"],
  });
  fixture.database.database.prepare(
    "UPDATE agent_task_claims SET lease_expires_at = ? WHERE task_id = ?",
  ).run(null, fixture.task.id);
  const provider = fixture.makeProvider(fixture.database);
  const expired = (await provider.getProjectSnapshot("capstone-dev")).todos[0];
  assert.equal(expired.continuation.route, "replan_required");
  assert.equal(expired.continuation.attention, "needs_coordinator");
  assert.equal(expired.recovery.mode, "manual_only");
  assert.equal(expired.recovery.eligible, true);
  const actionId = expired.recovery.actionId;
  assert.equal((await provider.getProjectSnapshot("capstone-dev")).todos[0].recovery.actionId, actionId);

  fixture.database.moveTask(
    fixture.task.id, claimed.task.version, "todo", undefined, null, undefined, actor,
  );
  assert.equal(fixture.database.getAgentTaskClaim(fixture.task.id).status, "interrupted");
  assert.deepEqual(fixture.database.recordAgentTaskProgress(fixture.task.id, {
    eventId: "stale-agent", agentThreadId: "acceptance-thread", summary: "stale", actor,
  }), { applied: false, reason: "task_not_in_progress" });
  fixture.database.close();
});

test("leaving in-progress and archiving atomically interrupt open runs so a claim can be retried", async () => {
  const fixture = await setup();
  const first = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["./server/database.mjs"],
  });
  const blocked = fixture.database.checkpointTaskAgentRun(first.run.id, first.run.version, {
    agentThreadId: "acceptance-thread", status: "blocked", summary: "waiting", nextAction: "resume",
  });
  assert.equal(blocked.run.status, "blocked");
  const blockedTodo = (await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev"))
    .todos.find((candidate) => candidate.id === fixture.task.identifier);
  assert.equal(blockedTodo?.run?.state, "blocked");

  const moved = fixture.database.updateTask(
    fixture.task.id, first.task.version, { status: "todo" }, undefined, undefined, actor,
  );
  assert.equal(moved.status, "todo");
  assert.equal(fixture.database.getAgentTaskClaim(fixture.task.id).status, "interrupted");
  assert.equal(fixture.database.getLatestTaskAgentRun(fixture.task.id).status, "interrupted");
  assert.equal(fixture.database.getOpenTaskAgentRun(fixture.task.id), null);

  const retried = fixture.database.claimAgentTask(fixture.task.id, moved.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/./database.mjs"],
  });
  assert.deepEqual(retried.claim.writeScope, ["server/database.mjs"]);
  assert.deepEqual(retried.run.writeScope, ["server/database.mjs"]);

  fixture.database.archiveTask(retried.task.id, retried.task.version, undefined, undefined, actor);
  assert.equal(fixture.database.getAgentTaskClaim(fixture.task.id).status, "interrupted");
  assert.equal(fixture.database.getLatestTaskAgentRun(fixture.task.id).status, "interrupted");
  assert.equal(fixture.database.getOpenTaskAgentRun(fixture.task.id), null);
  fixture.database.close();
});

test("reopened Todos ignore completed or interrupted historical next actions and dispatch once", async () => {
  for (const finalState of ["interrupted", "completed"]) {
    const fixture = await setup();
    fixture.rootBinding.threadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
    fixture.database.upsertAgentLaneProject("capstone-dev", {
      rootTaskId: "root",
      tasks: [{
        id: "root", label: "Capstone Root", owner: "Codex", source: "codex",
        threadId: fixture.rootBinding.threadId, taskType: "root_task",
        codexHostId: fixture.rootBinding.codexHostId, workspacePath: fixture.rootBinding.workspacePath,
      }],
      adapters: [],
    });
    const actionId = `retry-${finalState}`;
    const readyTask = fixture.database.createTask({
      projectId: "capstone-dev", title: `Retry ${finalState} work`, description: "", status: "todo",
      priority: "medium", labels: [], threadId: fixture.rootBinding.threadId,
      threadBinding: fixture.rootBinding, actor, assignee: actor,
      developmentContext: fixture.developmentContext,
      workingLog: {
        path: `${fixture.rootBinding.workspacePath}/CAP-RETRY-${finalState}-WORKING-LOG.md`,
        status: "planned",
      },
      startDate: null, dueDate: null, recurrence: null,
    });
    fixture.database.createComment(readyTask.id, {
      body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify({
        gates: [{
          id: "retry-authorized", kind: "test", state: "authorized", scope: "retry historical work",
          approver: "Owner", approvalRequest: "同意", evidence: "existing authority", receipt: "turn:retry",
        }],
        actions: [{
          id: actionId, order: 10, text: `Retry ${finalState} work`, gate: "retry-authorized",
          target: "candidate", status: "pending",
        }],
      })}\n\`\`\``,
      threadId: fixture.rootBinding.threadId, threadBinding: fixture.rootBinding,
      actor: { type: "user", id: "owner", name: "Owner", avatarUrl: null },
    });
    const claimed = fixture.database.claimAgentTask(readyTask.id, readyTask.version, {
      agentPath: "/root/retry", agentThreadId: "retry-thread",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/agent-lane-snapshot.mjs"],
    });
    fixture.database.checkpointTaskAgentRun(claimed.run.id, claimed.run.version, {
      agentThreadId: "retry-thread", status: "active", summary: "checkpoint",
      nextAction: "Historical next action must not replace the reopened authorization",
    });
    const transitioned = finalState === "completed"
      ? fixture.database.completeAgentTask(readyTask.id, {
          eventId: `complete-${finalState}`, agentThreadId: "retry-thread", summary: "completed", actor,
        }).task
      : claimed.task;
    const reopened = fixture.database.updateTask(
      readyTask.id, transitioned.version, { status: "todo" }, undefined, undefined, actor,
    );
    assert.equal(fixture.database.getLatestTaskAgentRun(readyTask.id).status, finalState);
    assert.equal(fixture.database.getOpenTaskAgentRun(readyTask.id), null);

    const snapshot = await fixture.makeProvider(fixture.database).getProjectSnapshot("capstone-dev");
    const todo = snapshot.todos.find((candidate) => candidate.id === reopened.identifier);
    assert.equal(todo?.readyWork.eligible, true);
    assert.equal(todo?.readyWork.safeActions[0]?.id, actionId);
    assert.equal(todo?.run, null);

    let deliveries = 0;
    const reservationLeaseId = `retry-reservation-${finalState}`;
    const monitorOptions = {
      policy: { enabled: true, projectId: "capstone-dev" },
      readSnapshot: async () => snapshot,
      claimReceipt: async (authorization) => fixture.database.claimTaskSafeAction(readyTask.id, {
        rootThreadId: authorization.rootThreadId,
        expectedResumeToken: authorization.expectedResumeToken,
        safeActionId: authorization.safeActionId,
        reservationLeaseId,
      }),
      confirmDelivery: async (authorization) => {
        fixture.database.confirmTaskSafeActionDelivery(readyTask.id, {
          rootThreadId: authorization.rootThreadId,
          expectedResumeToken: authorization.expectedResumeToken,
          safeActionId: authorization.safeActionId,
          reservationLeaseId,
        });
        return { worktreePath: fixture.developmentContext.path, branch: fixture.developmentContext.branch };
      },
      deliver: async () => {
        deliveries += 1;
        return { delivery: "started", turnId: `retry-root-turn-${finalState}` };
      },
      completeDelivery: async () => ({ completed: false, awaitingAdmission: true }),
    };
    assert.deepEqual(await runTaskboardContinuationMonitorOnce(monitorOptions), {
      delivered: true, todoId: reopened.identifier, actionId,
    });
    assert.deepEqual(await runTaskboardContinuationMonitorOnce(monitorOptions), {
      delivered: false, reason: "reservation-unavailable",
    });
    assert.equal(deliveries, 1);
    fixture.database.close();
  }
});

test("open runs protect bindings and require worktree-relative normalized write scopes", async () => {
  const fixture = await setup();
  const claimInput = {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  for (const writeScope of [["/etc/passwd"], ["../outside"], ["server/../../outside"]]) {
    assert.throws(
      () => fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, { ...claimInput, writeScope }),
      (error) => error?.code === "INVALID_AGENT_WRITE_SCOPE",
    );
  }

  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    ...claimInput,
    writeScope: ["./server/database.mjs", "server/agent-lane-snapshot.mjs"],
  });
  assert.deepEqual(claimed.run.writeScope, ["server/database.mjs", "server/agent-lane-snapshot.mjs"]);
  const blocked = fixture.database.checkpointTaskAgentRun(claimed.run.id, claimed.run.version, {
    agentThreadId: claimInput.agentThreadId, status: "blocked", summary: "waiting", nextAction: "resume",
  });
  assert.equal(blocked.run.status, "blocked");
  fixture.database.createProject({ id: "other-project", name: "Other", workspacePath: null });
  const otherBinding = { ...fixture.rootBinding, threadId: "other-root" };
  const otherWorktree = { ...fixture.developmentContext, path: "/tmp/other-worktree" };
  for (const changes of [
    { projectId: "other-project" },
    { developmentContext: otherWorktree },
  ]) {
    assert.throws(
      () => fixture.database.updateTask(
        fixture.task.id, claimed.task.version, changes, undefined, undefined, actor,
      ),
      (error) => error?.code === "RUN_REBIND_CONFLICT",
    );
  }
  assert.throws(
    () => fixture.database.updateTask(
      fixture.task.id, claimed.task.version, {}, undefined, otherBinding, actor,
    ),
    (error) => error?.code === "RUN_REBIND_CONFLICT",
  );

  fixture.database.database.prepare(
    "UPDATE task_agent_runs SET project_id = ? WHERE id = ?",
  ).run("other-project", claimed.run.id);
  assert.throws(
    () => fixture.database.claimAgentTask(fixture.task.id, claimed.task.version, {
      ...claimInput, writeScope: ["server/database.mjs"],
    }),
    (error) => error?.code === "RUN_BINDING_STALE",
  );
  fixture.database.close();
});

test("migrates legacy active and blocked runs to one open writer", async () => {
  const fixture = await setup();
  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/database.mjs"],
  });
  fixture.database.database.exec("DROP INDEX task_agent_runs_one_open_per_task");
  fixture.database.database.prepare(
    "UPDATE task_agent_runs SET status = 'blocked', updated_at = ? WHERE id = ?",
  ).run("2001-01-01T00:00:00.000Z", claimed.run.id);
  fixture.database.database.prepare(`
    INSERT INTO task_agent_runs (
      id, task_id, project_id, role, status, version, root_thread_id, agent_path, agent_thread_id,
      worktree_path, worktree_branch, write_scope_json, started_at, updated_at,
      finished_at, summary, next_action
    )
    SELECT ?, task_id, project_id, role, 'active', version, root_thread_id, '/root/rogue', 'rogue-thread',
      worktree_path, worktree_branch, write_scope_json, started_at, ?,
      NULL, summary, next_action
    FROM task_agent_runs WHERE id = ?
  `).run("legacy-active-run", "2099-01-01T00:00:00.000Z", claimed.run.id);
  fixture.database.close();

  const reopened = new TaskboardDatabase(fixture.databasePath);
  const openRuns = reopened.database.prepare(`
    SELECT id, status FROM task_agent_runs
    WHERE task_id = ? AND status IN ('active', 'blocked')
  `).all(fixture.task.id);
  assert.deepEqual(openRuns.map((run) => ({ id: run.id, status: run.status })), [
    { id: claimed.run.id, status: "blocked" },
  ]);
  assert.equal(reopened.getTaskAgentRun("legacy-active-run").status, "interrupted");
  const renewed = reopened.claimAgentTask(fixture.task.id, claimed.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["server/database.mjs"],
  });
  assert.equal(renewed.run.id, claimed.run.id);
  assert.equal(renewed.run.status, "active");
  reopened.close();
});

test("reconciliation requires a fresh Sub-Agent turn after the current claim", async () => {
  const fixture = await setup();
  await appendFile(fixture.rootFile, `${JSON.stringify({
    timestamp: "2020-01-01T00:00:00.000Z",
    type: "event_msg",
    payload: { type: "sub_agent_activity", agent_thread_id: "acceptance-thread", agent_path: "/root/acceptance", kind: "interacted" },
  })}\n${JSON.stringify({
    timestamp: "2020-01-01T00:01:00.000Z",
    type: "response_item",
    payload: { type: "agent_message", author: "/root/acceptance", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload: stale completion" }] },
  })}\n`);
  fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z", writeScope: ["test/agent-lane-coordination.test.mjs"],
  });
  const provider = fixture.makeProvider(fixture.database);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_progress");

  await appendFile(fixture.rootFile, `${JSON.stringify({
    timestamp: "2098-01-01T00:01:00.000Z",
    type: "response_item",
    payload: { type: "agent_message", author: "/root/acceptance", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload: late stale completion" }] },
  })}\n`);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_progress");

  await appendFile(fixture.rootFile, `${JSON.stringify({
    timestamp: "2098-01-01T00:02:00.000Z",
    type: "event_msg",
    payload: { type: "sub_agent_activity", agent_thread_id: "acceptance-thread", agent_path: "/root/acceptance", kind: "interacted" },
  })}\n`);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_progress");

  await appendFile(fixture.rootFile, `${JSON.stringify({
    timestamp: "2098-01-01T00:03:00.000Z",
    type: "response_item",
    payload: { type: "agent_message", author: "/root/acceptance", content: [{ type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "opaque" }] },
  })}\n`);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 1 });
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_progress");
  assert.match(fixture.database.listComments(fixture.task.id).at(-1).body, /Sub-Agent reported progress/);

  await appendFile(fixture.rootFile, `${JSON.stringify({
    timestamp: "2098-01-01T00:04:00.000Z",
    type: "response_item",
    payload: { type: "agent_message", author: "/root/acceptance", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload: current completion" }] },
  })}\n`);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 1 });
  assert.equal(fixture.database.getTask(fixture.task.id).status, "in_review");
  assert.match(fixture.database.listComments(fixture.task.id).at(-1).body, /current completion/);
  fixture.database.close();
});
