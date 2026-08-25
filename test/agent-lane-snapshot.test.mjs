import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  AGENT_LANE_SNAPSHOT_VERSION,
  createAgentLaneSnapshotProvider,
} from "../server/agent-lane-snapshot.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-lanes-"));
  directories.push(directory);
  const sessionsDirectory = path.join(directory, "sessions", "2026", "08", "23");
  await mkdir(sessionsDirectory, { recursive: true });
  const rootPath = path.join(sessionsDirectory, "rollout-root-thread.jsonl");
  const visualPath = path.join(sessionsDirectory, "rollout-visual-thread.jsonl");
  await writeFile(rootPath, [
    JSON.stringify({ timestamp: "2026-08-23T08:00:00.000Z", type: "session_meta", payload: { session_id: "root-thread" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:00.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Running focused checks on branch codex/support at commit: 87e24ccd55a9b241e87d57204c94a856c0ef5726. Unlabeled secret aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. api_key=must-not-leak" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:10.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "review-thread", agent_path: "/root/retrieval_review", kind: "started" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:20.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/retrieval_review", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nRetrieval review passed." }] } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:30.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "ui-thread", agent_path: "/root/ui_review", kind: "started" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:40.000Z", type: "response_item", payload: { type: "function_call_output", output: JSON.stringify({ agents: [{ agent_name: "/root", agent_status: "running" }, { agent_name: "/root/ui_review", agent_status: "running" }] }) } }),
  ].join("\n"));
  await writeFile(visualPath, [
    JSON.stringify({ timestamp: "2026-08-23T08:00:00.000Z", type: "session_meta", payload: { session_id: "visual-thread" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:03:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Visual evidence recorded; browser remains target." } }),
  ].join("\n"));
  const configPath = path.join(directory, "agent-lanes.json");
  await writeFile(configPath, JSON.stringify({
    version: 2,
    projects: {
      "capstone-dev": {
        rootTaskId: "root",
        tasks: [
          { id: "root", label: "Capstone Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
          { id: "visual", label: "Capstone Visual", owner: "Codex Visual", source: "codex", threadId: "visual-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1" },
          { id: "taskboard", label: "Taskboard / Self Learning", owner: "Codex Taskboard", source: "codex", threadId: "taskboard-thread", taskType: "infrastructure_task", issueIdentifier: "CAPSTONEDEV-1" },
        ],
        adapters: [
          { id: "claude", label: "Claude", owner: "Claude", source: "claude", connection: "not_connected" },
          { id: "pi", label: "Pi", owner: "Pi", source: "pi", connection: "not_connected" },
        ],
      },
    },
  }));
  return {
    configPath,
    rootPath,
    sessionsDirectory: path.join(directory, "sessions"),
    visualPath,
    now: () => new Date("2026-08-23T08:05:00.000Z"),
    getTask: (identifier) => identifier === "CAPSTONEDEV-1" ? {
      id: "task-1",
      identifier,
      title: "Capstone development coordination",
      status: "in_progress",
      relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    } : null,
    listComments: () => [{
      body: "Working log: focused checks passed.\nNext action: connect the next Codex sub-agent lane.",
      threadId: "root-thread",
      createdAt: "2026-08-23T08:04:00.000Z",
    }],
  };
}

test("separates configured Codex tasks from discovered Root-internal subagents", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  const snapshot = await provider.getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.version, AGENT_LANE_SNAPSHOT_VERSION);
  assert.equal(snapshot.projectId, "capstone-dev");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.automaticRecoveryEnabled, false);
  assert.equal(snapshot.version, 3);
  assert.deepEqual(snapshot.taskLanes.map((lane) => lane.id), ["root", "visual", "taskboard"]);
  assert.deepEqual(snapshot.adapters.map((lane) => lane.id), ["claude", "pi"]);
  assert.deepEqual(snapshot.rootSubagents.map((agent) => agent.agentPath), ["/root/ui_review", "/root/retrieval_review"]);
  assert.equal(snapshot.subagentSummary.observed, 2);
  assert.equal(snapshot.subagentSummary.active, 1);

  const root = snapshot.taskLanes[0];
  assert.equal(root.connection, "connected");
  assert.equal(root.status, "running");
  assert.equal(root.sha, "87e24ccd55a9b241e87d57204c94a856c0ef5726");
  assert.equal(root.stableIdentity, "capstone-dev:task:root");
  assert.equal(root.taskType, "root_task");
  assert.equal(root.continuity.state, "healthy");
  assert.match(root.actionId, /^[0-9a-f]{16}$/);
  assert.equal(root.workItem.identifier, "CAPSTONEDEV-1");
  assert.equal(root.workItem.commentCount, 1);
  assert.match(root.workItem.latestWorkingLog, /focused checks passed/);
  assert.equal(root.nextAction, "connect the next Codex sub-agent lane.");
  assert.doesNotMatch(root.lastActualAction, /must-not-leak/);
  assert.doesNotMatch(root.lastActualAction, /a{40}/);
  assert.match(root.lastActualAction, /\[redacted\]/);

  const active = snapshot.rootSubagents[0];
  assert.equal(active.agentThreadId, "ui-thread");
  assert.equal(active.parentTaskId, "root");
  assert.equal(active.lifecycleStatus, "running");
  assert.equal(active.stableIdentity, "capstone-dev:subagent:ui-thread");
  const completed = snapshot.rootSubagents[1];
  assert.equal(completed.lifecycleStatus, "completed");
  assert.match(completed.lastActualAction, /Retrieval review passed/);

  assert.equal(snapshot.adapters[0].connection, "not_connected");
  assert.equal(snapshot.adapters[0].continuity.state, "adapter_off");
});

test("reconciliation processes completed Sub-Agents beyond the display limit", async () => {
  const paths = await fixture();
  const events = [];
  for (let index = 0; index < 13; index += 1) {
    events.push(
      JSON.stringify({ timestamp: `2026-08-23T08:${String(10 + index).padStart(2, "0")}:00.000Z`, type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: `batch-${index}`, agent_path: `/root/batch_${index}`, kind: "started" } }),
      JSON.stringify({ timestamp: `2026-08-23T08:${String(10 + index).padStart(2, "0")}:30.000Z`, type: "response_item", payload: { type: "agent_message", author: `/root/batch_${index}`, recipient: "/root", content: [{ type: "input_text", text: `Message Type: FINAL_ANSWER\nPayload: batch ${index} complete` }] } }),
    );
  }
  await appendFile(paths.rootPath, `\n${events.join("\n")}`);
  const completed = [];
  const tasks = Array.from({ length: 13 }, (_, index) => ({
    id: `batch-task-${index}`,
    identifier: `BATCH-${index}`,
    title: `Batch ${index}`,
    status: "in_progress",
    labels: ["agent-todo"],
    archivedAt: null,
    threadId: `batch-${index}`,
  }));
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    listTasks: async () => tasks,
    getClaim: async (taskId) => {
      const index = Number(taskId.replace("batch-task-", ""));
      return {
        agentPath: `/root/batch_${index}`,
        agentThreadId: `batch-${index}`,
        status: "active",
        claimedAt: "2026-08-23T08:09:00.000Z",
        leaseExpiresAt: "2026-08-23T09:00:00.000Z",
        writeScope: [`test/batch-${index}.test.mjs`],
      };
    },
    listComments: async () => [],
    recordCompletion: async (event) => {
      if (event.agentPath.startsWith("/root/batch_")) completed.push(event.agentPath);
      return { applied: event.agentPath.startsWith("/root/batch_") };
    },
  });
  const snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.rootSubagents.length, 12);
  await provider.reconcileProject("capstone-dev");
  assert.equal(completed.length, 13);
});

test("marks a configured Codex lane disconnected when its session evidence disappears", async () => {
  const paths = await fixture();
  await rm(paths.visualPath);
  const provider = createAgentLaneSnapshotProvider(paths);
  const snapshot = await provider.getProjectSnapshot("capstone-dev");

  const visual = snapshot.taskLanes.find((lane) => lane.id === "visual");
  assert.equal(visual.status, "unavailable");
  assert.equal(visual.continuity.state, "disconnected");
  assert.match(visual.continuity.reason, /session was not found/);
});

test("rejects projects that have no configured lane mapping", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  await assert.rejects(
    provider.getProjectSnapshot("other-project"),
    (error) => error?.code === "AGENT_LANES_NOT_CONFIGURED",
  );
});
