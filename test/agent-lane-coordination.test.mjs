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
  const task = database.createTask({
    projectId: "capstone-dev", title: "验证真实交接", description: "", status: "todo",
    priority: "high", labels: ["agent-todo"], threadId: null, actor, assignee: actor,
    workflowId: null, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
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
    listComments: (taskId) => db.listComments(taskId),
    recordCompletion: (completion) => db.completeAgentTask(task.id, { ...completion, actor }),
  });
  return { database, databasePath, task, rootFile, makeProvider };
}

test("uses durable Taskboard To-Dos and persists one complete Sub-Agent handoff", async () => {
  const fixture = await setup();
  let provider = fixture.makeProvider(fixture.database);
  let snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.deepEqual(snapshot.todos.map((todo) => todo.id), [fixture.task.identifier]);
  assert.equal(snapshot.todos[0].state, "ready");

  const claimed = fixture.database.claimAgentTask(fixture.task.id, fixture.task.version, {
    agentPath: "/root/acceptance", agentThreadId: "acceptance-thread",
  });
  assert.equal(claimed.task.status, "in_progress");
  await appendFile(fixture.rootFile, [
    JSON.stringify({ timestamp: "2026-08-24T01:01:00.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "acceptance-thread", agent_path: "/root/acceptance", kind: "started" } }),
    JSON.stringify({ timestamp: "2026-08-24T01:02:00.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/acceptance", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload: Focused checks passed. token=must-not-leak AKIAABCDEFGHIJKLMNOP https://user:password@example.com/ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef" }] } }),
  ].join("\n") + "\n");

  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 1 });
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.rootSubagents[0].lifecycleStatus, "completed");
  assert.equal(snapshot.todos[0].state, "validating");
  const comments = fixture.database.listComments(fixture.task.id);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^Sub-Agent 完成：/);
  assert.match(comments[0].body, /Focused checks passed/);
  assert.doesNotMatch(comments[0].body, /must-not-leak/);
  assert.doesNotMatch(comments[0].body, /AKIA|user:password|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.equal(comments[0].threadId, "acceptance-thread");

  fixture.database.close();
  const reopened = new TaskboardDatabase(fixture.databasePath);
  provider = fixture.makeProvider(reopened);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });
  assert.equal(reopened.listComments(fixture.task.id).length, 1);
  assert.equal(reopened.getTask(fixture.task.id).status, "in_review");
  reopened.close();
});
