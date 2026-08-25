import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createAgentLaneSnapshotProvider } from "../server/agent-lane-snapshot.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

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
    SELECT ?, task_id, project_id, role, 'active', version, root_thread_id, agent_path, agent_thread_id,
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
    { id: "legacy-active-run", status: "active" },
  ]);
  assert.equal(reopened.getTaskAgentRun(claimed.run.id).status, "interrupted");
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
