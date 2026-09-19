import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const projectId = "idle-synthetic";
export const statusCounts = { done: 62, in_review: 8, in_progress: 2, backlog: 1, canceled: 1 };
export const actor = { type: "agent", id: "synthetic-agent", name: "Synthetic Agent", avatarUrl: null };
export const agentPath = "/root/idle-worker";
export const agentThreadId = "idle-worker-thread";
const baselineStatements = new WeakMap();

// Only the pre-implementation baseline uses this read-only equivalent. Production
// and candidate tests use the real database method, never this fallback.
export function baselineProbe(database, id) {
  let statement = baselineStatements.get(database);
  if (!statement) {
    statement = database.database.prepare(`
    SELECT 1 FROM agent_task_claims AS claim
    JOIN tasks AS task ON task.id = claim.task_id AND task.project_id = claim.project_id
    WHERE claim.project_id = ? AND claim.status = 'active'
      AND task.archived_at IS NULL AND task.status IN ('in_progress', 'in_review')
    LIMIT 1
    `);
    baselineStatements.set(database, statement);
  }
  return Boolean(statement.get(id));
}

export async function idleFixture({ sourceRoot, baseline = false } = {}) {
  const root = sourceRoot ? pathToFileURL(`${path.resolve(sourceRoot)}/`) : new URL("../../", import.meta.url);
  const { TaskboardDatabase } = await import(new URL("server/database.mjs", root));
  const { createAgentLaneSnapshotProvider } = await import(new URL("server/agent-lane-snapshot.mjs", root));
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-idle-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  let database = new TaskboardDatabase(databasePath);
  database.createProject({ id: projectId, name: "Synthetic idle project", workspacePath: null });
  const binding = {
    threadId: "idle-root-thread", codexProjectId: projectId, codexProjectKind: "local",
    codexHostId: "local", workspacePath: path.join(directory, "worktree"),
  };
  database.upsertAgentLaneProject(projectId, {
    rootTaskId: "root",
    tasks: [{ id: "root", label: "Synthetic Root", owner: "Codex", source: "codex",
      taskType: "root_task", ...binding }],
    adapters: [],
  });
  const tasks = [];
  for (const [status, count] of Object.entries(statusCounts)) {
    for (let index = 0; index < count; index += 1) {
      const task = database.createTask({
        projectId, title: `Synthetic ${status} ${index}`, description: "Synthetic measurement only.",
        status, priority: "medium", labels: ["agent-todo"],
        threadId: binding.threadId, threadBinding: binding, actor, assignee: actor,
        workflowId: null, startDate: null, dueDate: null, recurrence: null,
        developmentContext: { type: "worktree", path: binding.workspacePath, branch: "codex/idle-fixture" },
      });
      database.createComment(task.id, {
        body: "Synthetic history.", threadId: binding.threadId, threadBinding: binding, actor,
      });
      tasks.push(task);
    }
  }
  const sessionsDirectory = path.join(directory, "sessions");
  await mkdir(sessionsDirectory);
  const rootFile = path.join(sessionsDirectory, "rollout-idle-root-thread.jsonl");
  await writeFile(rootFile, `${JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z",
    type: "session_meta", payload: { session_id: binding.threadId } })}\n`);
  const stats = { snapshots: 0, capsules: 0, capsuleMs: 0, probes: 0 };
  const probe = (id) => {
    stats.probes += 1;
    return baseline ? baselineProbe(database, id) : database.hasAgentTaskReconciliationWork(id);
  };
  const record = (method, event) => {
    // Match app.mjs: refresh exact project/path/thread candidates before commit.
    const candidates = database.listTasks({ projectId: event.projectId, archived: "false" }).filter((task) => {
      const claim = database.getAgentTaskClaim(task.id);
      return claim?.status === "active" && claim.projectId === event.projectId
        && claim.agentThreadId === event.agentThreadId && claim.agentPath === event.agentPath;
    });
    return candidates.length === 1
      ? database[method](candidates[0].id, { ...event, actor })
      : { applied: false, reason: "claim_not_unique" };
  };
  const makeProvider = (overrides = {}) => createAgentLaneSnapshotProvider({
    sessionsDirectory,
    getLaneConfig: (id) => database.getAgentLaneProject(id),
    listTasks: (id) => {
      stats.snapshots += 1;
      return database.listTasks({ projectId: id, archived: "false" });
    },
    getClaim: (id) => database.getAgentTaskClaim(id),
    getTaskCapsule: (id) => {
      stats.capsules += 1;
      const started = performance.now();
      try { return database.getTaskCapsule(id); }
      finally { stats.capsuleMs += performance.now() - started; }
    },
    listComments: (id) => database.listComments(id),
    hasReconciliationWork: probe,
    recordProgress: (event) => record("recordAgentTaskProgress", event),
    recordCompletion: (event) => record("completeAgentTask", event),
    ...overrides,
  });
  const activeTask = tasks.find((task) => task.status === "in_progress");
  return {
    get database() { return database; },
    databasePath, tasks, activeTask, stats, probe, makeProvider,
    resetStats() { Object.assign(stats, { snapshots: 0, capsules: 0, capsuleMs: 0, probes: 0 }); },
    claim() {
      const current = database.getTask(activeTask.id);
      const ready = database.moveTask(current.id, current.version, "todo", undefined, null, undefined, actor);
      return database.claimAgentTask(ready.id, ready.version, {
        agentPath, agentThreadId, leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        writeScope: ["server/agent-lane-snapshot.mjs"],
      });
    },
    async event(completed = false) {
      const rows = completed ? [] : [{ timestamp: "2098-01-01T01:01:00.000Z", type: "event_msg",
        payload: { type: "sub_agent_activity", agent_thread_id: agentThreadId, agent_path: agentPath, kind: "started" } }];
      rows.push({ timestamp: completed ? "2098-01-01T01:02:00.000Z" : "2098-01-01T01:01:30.000Z",
        type: "response_item", payload: { type: "agent_message", author: agentPath, recipient: "/root",
          content: [{ type: "input_text", text: `Message Type: ${completed ? "FINAL_ANSWER" : "MESSAGE"}\nPayload: Synthetic ${completed ? "completion" : "progress"}.` }] } });
      await appendFile(rootFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    },
    observe() {
      const task = database.getTask(activeTask.id);
      const claim = database.getAgentTaskClaim(task.id);
      const run = database.getLatestTaskAgentRun(task.id);
      return {
        taskStatus: task.status, taskVersion: task.version, claimStatus: claim?.status ?? null,
        claimThread: claim?.agentThreadId ?? null, runStatus: run?.status ?? null, runVersion: run?.version ?? null,
        comments: database.listComments(task.id).map((comment) => ({ body: comment.body, threadId: comment.threadId })),
        receipts: database.database.prepare("SELECT event_id FROM agent_event_receipts WHERE task_id = ? ORDER BY event_id")
          .all(task.id).map((row) => row.event_id),
      };
    },
    reopen() { database.close(); database = new TaskboardDatabase(databasePath); },
    async close() { database.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
