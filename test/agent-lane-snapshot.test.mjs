import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  AGENT_LANE_SNAPSHOT_VERSION,
  createAgentLaneSnapshotProvider,
} from "../server/agent-lane-snapshot.mjs";
import { runTaskboardContinuationMonitorOnce } from "../scripts/codex-injector-runtime.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function fixture(projectConfig = null) {
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
    JSON.stringify({ timestamp: "2026-08-23T08:02:39.000Z", type: "response_item", payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "list-agents-1", arguments: "{}" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:02:40.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "list-agents-1", output: JSON.stringify({ agents: [{ agent_name: "/root", agent_id: "root-thread", agent_status: "running" }, { agent_name: "/root/ui_review", agent_id: "ui-thread", agent_status: "running" }, { agent_name: "/root/retrieval_review", agent_status: { completed: "PASS" } }] }) } }),
  ].join("\n"));
  await writeFile(visualPath, [
    JSON.stringify({ timestamp: "2026-08-23T08:00:00.000Z", type: "session_meta", payload: { session_id: "visual-thread" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:03:00.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Visual evidence recorded; browser remains target." } }),
  ].join("\n"));
  const configPath = path.join(directory, "agent-lanes.json");
  await writeFile(configPath, JSON.stringify({
    version: 2,
    projects: {
      "capstone-dev": projectConfig ?? {
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

async function assertInvalidCapacityBlocksContinuation(tree) {
  const rootThreadId = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const continuation = await runTaskboardContinuationMonitorOnce({
    policy: {
      enabled: true,
      projectId: "capstone-dev",
      maxActiveAgents: 4,
      capacityObservationMaxAgeMs: 60_000,
    },
    now: () => Date.parse("2026-08-23T08:03:30.000Z"),
    readSnapshot: async () => ({
      projectId: "capstone-dev",
      todos: [{
        id: "CAP-21",
        taskId: "capacity-task-uuid",
        run: null,
        dispatchTarget: {
          rootThreadId,
          codexHostId: "local",
          rootWorkspacePath: "/tmp/visual",
          worktreePath: "/tmp/visual",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "continue", text: "Continue safely" }],
          deferredActions: [],
          resumeToken: "b".repeat(64),
        },
      }],
      windowSubagentTrees: [{ ...tree, rootThreadId }],
    }),
    claimReceipt: async () => assert.fail("invalidated capacity must prevent a bootstrap claim"),
    confirmDelivery: async () => assert.fail("invalidated capacity must prevent confirmation"),
    deliver: async () => assert.fail("invalidated capacity must prevent delivery"),
    completeDelivery: async () => assert.fail("invalidated capacity must prevent completion"),
  });
  assert.deepEqual(continuation, { delivered: false, reason: "capacity-unobserved" });
}

test("separates configured Codex tasks from discovered Root-internal subagents", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  const snapshot = await provider.getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.version, AGENT_LANE_SNAPSHOT_VERSION);
  assert.equal(snapshot.projectId, "capstone-dev");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.automaticRecoveryEnabled, false);
  assert.equal(snapshot.version, 7);
  assert.deepEqual(snapshot.coordination, {
    model: "peer_windows_with_configured_coordinator",
    coordinatorTaskId: "root",
    coordinatorStableIdentity: "capstone-dev:task:root",
    ownerRootTaskId: "root",
    ownerRootStableIdentity: "capstone-dev:task:root",
    ownerRootRoute: null,
    assignment: "configured",
    replaceable: false,
    scope: "project",
    crossWindowProtocol: "task_capsule_claim_checkpoint_receipt",
    subagentAuthority: "window_root",
    stateAuthority: "self_learning_checkpoint",
    workAuthority: "todo_claim_lease",
    runtimeOwnership: "single_writer",
    domainCoordinators: [],
    pendingOwnerIntent: null,
    pendingOwnerIntentPlan: null,
    ownerDecisionRequest: null,
    pendingCrossDomainHandoff: null,
    durableWorkPending: true,
    shutdownAttempt: null,
  });
  assert.deepEqual(snapshot.taskLanes.map((lane) => lane.id), ["root", "visual", "taskboard"]);
  assert.deepEqual(snapshot.adapters.map((lane) => lane.id), ["claude", "pi"]);
  assert.deepEqual(snapshot.rootSubagents.map((agent) => agent.agentPath), ["/root/ui_review", "/root/retrieval_review"]);
  assert.equal(snapshot.subagentSummary.observed, 2);
  assert.equal(snapshot.subagentSummary.active, 1);
  assert.equal(snapshot.subagentSummary.complete, true);
  assert.deepEqual(snapshot.windowSubagentTrees[0].capacityObservation, {
    source: "list_agents",
    observedAt: "2026-08-23T08:02:40.000Z",
  });
  assert.deepEqual(snapshot.windowSubagentTrees[0].registryObservation, {
    source: "list_agents",
    observedAt: "2026-08-23T08:02:40.000Z",
    complete: true,
    agents: [
      { agentPath: "/root/ui_review", agentThreadId: "ui-thread", status: "running" },
      { agentPath: "/root/retrieval_review", agentThreadId: "review-thread", status: "completed" },
    ],
  });
  assert.equal(snapshot.windowSubagentTrees[1].capacityObservation, null);

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
  assert.deepEqual(snapshot.adapters[0].adapterContract, {
    version: 1,
    providerId: "claude",
    state: "disabled",
    reasonCode: "ADAPTER_NOT_CONFIGURED",
    transport: null,
    capabilities: {
      inspect: false,
      dispatch: false,
      wait: false,
      checkpointReceipt: false,
    },
  });
});

test("reuses an unchanged Codex task observation and refreshes it after replace or append", async () => {
  const paths = await fixture();
  const fixedTime = new Date("2026-08-23T08:04:00.000Z");
  await utimes(paths.rootPath, fixedTime, fixedTime);
  const provider = createAgentLaneSnapshotProvider(paths);
  const initial = await provider.getProjectSnapshot("capstone-dev");
  assert.match(initial.taskLanes.find((lane) => lane.id === "root").lastActualAction, /Running focused checks/);

  await chmod(paths.rootPath, 0o000);
  const cached = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    cached.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    initial.taskLanes.find((lane) => lane.id === "root").lastActualAction,
  );

  await chmod(paths.rootPath, 0o600);
  const original = await readFile(paths.rootPath, "utf8");
  const replacementPath = `${paths.rootPath}.replacement`;
  await writeFile(replacementPath, original.replace("Running focused checks", "Changed focused checks"));
  await utimes(replacementPath, fixedTime, fixedTime);
  const beforeReplace = await stat(paths.rootPath);
  const replacement = await stat(replacementPath);
  assert.equal(replacement.size, beforeReplace.size);
  assert.equal(replacement.mtimeMs, beforeReplace.mtimeMs);
  assert.notEqual(replacement.ino, beforeReplace.ino);
  await rename(replacementPath, paths.rootPath);
  const replaced = await provider.getProjectSnapshot("capstone-dev");
  assert.match(
    replaced.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    /Changed focused checks/,
  );

  await appendFile(paths.rootPath, `\n${JSON.stringify({
    timestamp: "2026-08-23T08:04:30.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "Fresh lane observation after append." },
  })}`);
  const refreshed = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    refreshed.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "Fresh lane observation after append.",
  );

  const splitSignal = Buffer.from(`\n${JSON.stringify({
    timestamp: "2026-08-23T08:04:35.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "拆分写入后的新状态。" },
  })}`);
  const splitAt = splitSignal.indexOf(Buffer.from("拆")) + 1;
  await appendFile(paths.rootPath, splitSignal.subarray(0, splitAt));
  const partial = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    partial.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "Fresh lane observation after append.",
  );
  await appendFile(paths.rootPath, Buffer.concat([splitSignal.subarray(splitAt), Buffer.from("\n")]));
  const completed = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    completed.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "拆分写入后的新状态。",
  );

  const oversizedPrefix = Buffer.from(`\n{"timestamp":"2026-08-23T08:04:36.000Z","type":"event_msg","payload":{"type":"agent_message","message":"`);
  await appendFile(paths.rootPath, Buffer.concat([oversizedPrefix, Buffer.alloc(200 * 1024, 0x78)]));
  await provider.getProjectSnapshot("capstone-dev");
  await appendFile(paths.rootPath, Buffer.alloc(200 * 1024, 0x78));
  await provider.getProjectSnapshot("capstone-dev");
  await appendFile(paths.rootPath, Buffer.alloc(200 * 1024, 0x78));
  const oversizedPartial = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    oversizedPartial.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "拆分写入后的新状态。",
  );
  const afterOversized = JSON.stringify({
    timestamp: "2026-08-23T08:04:37.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "Oversized record was bounded." },
  });
  await appendFile(paths.rootPath, Buffer.from(`"}}\n${afterOversized}\n`));
  const bounded = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(
    bounded.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "Oversized record was bounded.",
  );
});

test("accepts task signal JSON fields in any object order", async () => {
  const paths = await fixture();
  const source = await readFile(paths.rootPath, "utf8");
  const reordered = JSON.stringify({
    timestamp: "2026-08-23T08:04:40.000Z",
    payload: { message: "Reordered task lane signal.", phase: "commentary", type: "agent_message" },
    type: "event_msg",
  });
  await writeFile(paths.rootPath, `${source}\n${reordered}`);
  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  assert.equal(
    snapshot.taskLanes.find((lane) => lane.id === "root").lastActualAction,
    "Reordered task lane signal.",
  );
});

test("cold subagent recovery ignores history outside the bounded session tail", async () => {
  const paths = await fixture();
  const stale = JSON.stringify({
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: "stale-thread",
      agent_path: "/root/stale_agent",
      kind: "started",
    },
  });
  const padding = JSON.stringify({ padding: "x".repeat(11 * 1024 * 1024) });
  const recent = JSON.stringify({
    timestamp: "2026-08-23T08:02:30.000Z",
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: "recent-thread",
      agent_path: "/root/recent_agent",
      kind: "started",
    },
  });
  await writeFile(paths.rootPath, `${stale}\n${padding}\n${recent}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.deepEqual(
    snapshot.rootSubagents.map((agent) => agent.agentPath),
    ["/root/recent_agent"],
  );
  assert.equal(snapshot.subagentSummary.complete, false);
});

test("cold subagent recovery anchors a silent active agent from the latest complete registry", async () => {
  const paths = await fixture();
  const started = JSON.stringify({
    timestamp: "2026-08-23T08:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: "silent-thread",
      agent_path: "/root/silent_agent",
      kind: "started",
    },
  });
  const call = JSON.stringify({
    timestamp: "2026-08-23T08:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "list_agents",
      namespace: "collaboration",
      call_id: "silent-registry",
      arguments: "{}",
    },
  });
  const output = JSON.stringify({
    timestamp: "2026-08-23T08:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "silent-registry",
      output: JSON.stringify({
        agents: [
          { agent_name: "/root", agent_id: "root-thread", agent_status: "running" },
          { agent_name: "/root/silent_agent", agent_id: "silent-thread", agent_status: "running" },
        ],
      }),
    },
  });
  const padding = JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) });
  await writeFile(paths.rootPath, `${started}\n${call}\n${output}\n${padding}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.subagentSummary.complete, true);
  assert.deepEqual(
    snapshot.rootSubagents.map((agent) => [agent.agentPath, agent.lifecycleStatus]),
    [["/root/silent_agent", "running"]],
  );
});

test("cold subagent recovery reports incomplete when a registry call is outside bounded lookback", async () => {
  const paths = await fixture();
  const call = JSON.stringify({
    timestamp: "2026-08-23T08:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "list_agents",
      namespace: "collaboration",
      call_id: "outside-lookback",
      arguments: "{}",
    },
  });
  const padding = JSON.stringify({ padding: "x".repeat(11 * 1024 * 1024) });
  const output = JSON.stringify({
    timestamp: "2026-08-23T08:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "outside-lookback",
      output: JSON.stringify({
        agents: [{ agent_name: "/root", agent_id: "root-thread", agent_status: "running" }],
      }),
    },
  });
  await writeFile(paths.rootPath, `${call}\n${padding}\n${output}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.subagentSummary.complete, false);
  assert.equal(snapshot.windowSubagentTrees[0].registryObservation, null);
});

test("cold subagent recovery preserves file order across the registry lookback boundary", async () => {
  const paths = await fixture();
  const call = JSON.stringify({
    timestamp: "2026-08-23T08:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "list_agents",
      namespace: "collaboration",
      call_id: "split-registry",
      arguments: "{}",
    },
  });
  const padding = JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) });
  const started = JSON.stringify({
    timestamp: "2026-08-23T08:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: "late-thread",
      agent_path: "/root/late_agent",
      kind: "started",
    },
  });
  const output = JSON.stringify({
    timestamp: "2026-08-23T08:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "split-registry",
      output: JSON.stringify({
        agents: [{ agent_name: "/root", agent_id: "root-thread", agent_status: "running" }],
      }),
    },
  });
  await writeFile(paths.rootPath, `${call}\n${padding}\n${started}\n${output}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.subagentSummary.complete, true);
  assert.equal(snapshot.subagentSummary.active, 0);
  assert.equal(snapshot.rootSubagents.some((agent) => agent.agentPath === "/root/late_agent"), false);
});

test("cold registry lookback uses the newest complete registry as its anchor", async () => {
  const paths = await fixture();
  const registryLines = (callId, agents, second) => [
    JSON.stringify({
      timestamp: `2026-08-23T08:00:0${second}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "list_agents",
        namespace: "collaboration",
        call_id: callId,
        arguments: "{}",
      },
    }),
    JSON.stringify({
      timestamp: `2026-08-23T08:00:0${second + 1}.000Z`,
      type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ agents }) },
    }),
  ];
  const root = { agent_name: "/root", agent_id: "root-thread", agent_status: "running" };
  const oldAgent = { agent_name: "/root/old_agent", agent_id: "old-thread", agent_status: { completed: "done" } };
  const older = registryLines("older-registry", [root, oldAgent], 1);
  const newer = registryLines("newer-registry", [root], 3);
  const padding = JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) });
  await writeFile(paths.rootPath, `${[...older, padding, ...newer].join("\n")}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.subagentSummary.complete, true);
  assert.equal(snapshot.rootSubagents.some((agent) => agent.agentPath === "/root/old_agent"), false);
});

test("a later valid registry preserves a known agent thread id when the optional id is omitted", async () => {
  const paths = await fixture();
  const registry = (callId, agent, second) => [
    JSON.stringify({
      timestamp: `2026-08-23T08:00:0${second}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "list_agents",
        namespace: "collaboration",
        call_id: callId,
        arguments: "{}",
      },
    }),
    JSON.stringify({
      timestamp: `2026-08-23T08:00:0${second + 1}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          agents: [
            { agent_name: "/root", agent_id: "root-thread", agent_status: "running" },
            agent,
          ],
        }),
      },
    }),
  ];
  await writeFile(paths.rootPath, `${[
    ...registry("registry-with-id", {
      agent_name: "/root/worker",
      agent_id: "worker-thread",
      agent_status: "running",
    }, 1),
    ...registry("registry-without-id", {
      agent_name: "/root/worker",
      agent_status: "running",
    }, 3),
  ].join("\n")}\n`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const worker = snapshot.rootSubagents.find((agent) => agent.agentPath === "/root/worker");

  assert.equal(worker?.agentThreadId, "worker-thread");
  assert.equal(worker?.stableIdentity, "capstone-dev:subagent:worker-thread");
});

test("concurrent readers share one in-flight project snapshot", async () => {
  const paths = await fixture();
  let capsuleReads = 0;
  let releaseCapsule;
  let markCapsuleStarted;
  const capsuleGate = new Promise((resolve) => { releaseCapsule = resolve; });
  const capsuleStarted = new Promise((resolve) => { markCapsuleStarted = resolve; });
  const task = {
    id: "capsule-task-id",
    identifier: "CAP-100",
    title: "Concurrent snapshot task",
    priority: "medium",
    status: "todo",
    labels: ["agent-todo"],
    archivedAt: null,
  };
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    listTasks: () => [task],
    getTaskCapsule: async () => {
      capsuleReads += 1;
      markCapsuleStarted();
      await capsuleGate;
      return null;
    },
  });

  const snapshots = [
    provider.getProjectSnapshot("capstone-dev"),
    provider.getProjectSnapshot("capstone-dev"),
    provider.getProjectSnapshot("capstone-dev"),
  ];
  const startTimeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("snapshot did not reach Capsule projection")), 2_000);
    timer.unref?.();
  });
  await Promise.race([capsuleStarted, startTimeout]);

  const readsBeforeRelease = capsuleReads;
  releaseCapsule();
  const resolved = await Promise.all(snapshots);
  assert.equal(readsBeforeRelease, 1);
  assert.equal(resolved[0], resolved[1]);
  assert.equal(resolved[1], resolved[2]);
});

test("projects a provider-neutral disabled adapter contract and rejects unimplemented connected adapters", async () => {
  const base = {
    rootTaskId: "root",
    tasks: [{
      id: "root",
      label: "Project coordinator",
      owner: "Codex",
      source: "codex",
      threadId: "root-thread",
      taskType: "root_task",
    }],
  };
  const paths = await fixture({
    ...base,
    adapters: [{
      id: "future",
      label: "Future provider",
      owner: "External",
      source: "future-provider",
      connection: "not_connected",
    }],
  });
  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.adapters[0].source, "future-provider");
  assert.equal(snapshot.adapters[0].connection, "not_connected");
  assert.deepEqual(snapshot.adapters[0].adapterContract, {
    version: 1,
    providerId: "future-provider",
    state: "disabled",
    reasonCode: "ADAPTER_NOT_CONFIGURED",
    transport: null,
    capabilities: {
      inspect: false,
      dispatch: false,
      wait: false,
      checkpointReceipt: false,
    },
  });

  const unsafePaths = await fixture({
    ...base,
    adapters: [{
      id: "future",
      label: "Future provider",
      owner: "External",
      source: "future-provider",
      connection: "connected",
    }],
  });
  await assert.rejects(
    createAgentLaneSnapshotProvider(unsafePaths).getProjectSnapshot("capstone-dev"),
    (error) => error?.code === "AGENT_LANES_NOT_CONFIGURED",
  );
});

test("projects one isolated Sub-Agent tree per configured Codex window", async () => {
  const paths = await fixture();
  await appendFile(paths.visualPath, `\n${JSON.stringify({
    timestamp: "2026-08-23T08:03:30.000Z",
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      agent_thread_id: "visual-review-thread",
      agent_path: "/root/visual_review",
      kind: "started",
    },
  })}`);
  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.deepEqual(snapshot.windowSubagentTrees.map((tree) => ({
    windowTaskId: tree.windowTaskId,
    observed: tree.observed,
    agents: tree.subagents.map((agent) => agent.agentPath),
  })), [
    { windowTaskId: "root", observed: true, agents: ["/root/ui_review", "/root/retrieval_review"] },
    { windowTaskId: "visual", observed: true, agents: ["/root/visual_review"] },
    { windowTaskId: "taskboard", observed: false, agents: [] },
  ]);
  assert.equal(snapshot.windowSubagentTrees[0].stableIdentity, "capstone-dev:window:root");
  assert.equal(snapshot.windowSubagentTrees[1].subagents[0].parentTaskId, "visual");
  assert.deepEqual(snapshot.rootSubagents.map((agent) => agent.agentPath), [
    "/root/ui_review",
    "/root/retrieval_review",
  ]);
});

test("advances an authoritative capacity observation when an observed child completes", async () => {
  const paths = await fixture();
  await appendFile(paths.rootPath, `\n${JSON.stringify({
    timestamp: "2026-08-23T08:04:00.000Z",
    type: "response_item",
    payload: {
      type: "agent_message",
      author: "/root/ui_review",
      recipient: "/root",
      content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nUI review passed." }],
    },
  })}`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const rootTree = snapshot.windowSubagentTrees.find((tree) => tree.rootThreadId === "root-thread");
  assert.equal(rootTree.summary.active, 0);
  assert.deepEqual(rootTree.capacityObservation, {
    source: "list_agents",
    observedAt: "2026-08-23T08:04:00.000Z",
  });
  assert.equal(rootTree.registryObservation.observedAt, "2026-08-23T08:02:40.000Z");
  assert.deepEqual(rootTree.registryObservation.agents, [
    { agentPath: "/root/ui_review", agentThreadId: "ui-thread", status: "running" },
    { agentPath: "/root/retrieval_review", agentThreadId: "review-thread", status: "completed" },
  ]);
});

test("a malformed paired collaboration registry fails closed instead of asserting complete absence", async () => {
  const paths = await fixture();
  await appendFile(paths.visualPath, `\n${[
    JSON.stringify({
      timestamp: "2026-08-23T08:03:10.000Z", type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "malformed-registry", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:11.000Z", type: "response_item",
      payload: { type: "function_call_output", call_id: "malformed-registry", output: JSON.stringify({ agents: [{ agent_status: "running" }] }) },
    }),
  ].join("\n")}`);
  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const visualTree = snapshot.windowSubagentTrees.find((tree) => tree.rootThreadId === "visual-thread");
  assert.equal(visualTree.capacityObservation, null);
  assert.equal(visualTree.registryObservation, null);
});

test("a split collaboration registry output fails closed until its UTF-8 tail is complete", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  const initial = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(initial.windowSubagentTrees[0].summary.complete, true);

  const callId = "split-registry-output";
  const call = JSON.stringify({
    timestamp: "2026-08-23T08:04:40.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: callId, arguments: "{}" },
  });
  const output = Buffer.from(JSON.stringify({
    timestamp: "2026-08-23T08:04:41.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({
        note: "恢复容量",
        agents: [
          { agent_name: "/root", agent_id: "root-thread", agent_status: "running" },
          { agent_name: "/root/recovered", agent_id: "recovered-thread", agent_status: "running" },
        ],
      }),
    },
  }));
  const splitAt = output.indexOf(Buffer.from("恢")) + 1;
  await appendFile(paths.rootPath, Buffer.concat([Buffer.from(`\n${call}\n`), output.subarray(0, splitAt)]));
  const incomplete = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(incomplete.windowSubagentTrees[0].summary.complete, false);
  assert.equal(incomplete.windowSubagentTrees[0].capacityObservation, null);

  await appendFile(paths.rootPath, Buffer.concat([output.subarray(splitAt), Buffer.from("\n")]));
  const recovered = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(recovered.windowSubagentTrees[0].summary.complete, true);
  assert.deepEqual(recovered.windowSubagentTrees[0].capacityObservation, {
    source: "list_agents",
    observedAt: "2026-08-23T08:04:41.000Z",
  });
  assert.equal(
    recovered.rootSubagents.find((agent) => agent.agentPath === "/root/recovered")?.agentThreadId,
    "recovered-thread",
  );
});

test("an oversized split registry record stays bounded and fail closed until a later registry", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  await provider.getProjectSnapshot("capstone-dev");
  const oversizedCallId = "oversized-registry-output";
  const oversizedCall = JSON.stringify({
    timestamp: "2026-08-23T08:04:45.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: oversizedCallId, arguments: "{}" },
  });
  const oversizedPrefix = Buffer.from(`\n${oversizedCall}\n{"timestamp":"2026-08-23T08:04:46.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"${oversizedCallId}","output":"`);
  await appendFile(paths.rootPath, Buffer.concat([oversizedPrefix, Buffer.alloc(200 * 1024, 0x78)]));
  let snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.windowSubagentTrees[0].summary.complete, false);
  assert.equal(snapshot.windowSubagentTrees[0].capacityObservation, null);
  for (let index = 0; index < 3; index += 1) {
    await appendFile(paths.rootPath, Buffer.alloc(200 * 1024, 0x78));
    snapshot = await provider.getProjectSnapshot("capstone-dev");
    assert.equal(snapshot.windowSubagentTrees[0].summary.complete, false);
    assert.equal(snapshot.windowSubagentTrees[0].capacityObservation, null);
  }
  await appendFile(paths.rootPath, Buffer.from('"}}\n'));
  snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.windowSubagentTrees[0].summary.complete, false);
  assert.equal(snapshot.windowSubagentTrees[0].capacityObservation, null);

  const recoveredCallId = "registry-after-oversized";
  const recoveredCall = JSON.stringify({
    timestamp: "2026-08-23T08:04:47.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: recoveredCallId, arguments: "{}" },
  });
  const recoveredOutput = JSON.stringify({
    timestamp: "2026-08-23T08:04:48.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: recoveredCallId,
      output: JSON.stringify({ agents: [
        { agent_name: "/root", agent_id: "root-thread", agent_status: "running" },
        { agent_name: "/root/recovered", agent_id: "recovered-thread", agent_status: "running" },
      ] }),
    },
  });
  await appendFile(paths.rootPath, `\n${recoveredCall}\n${recoveredOutput}\n`);
  snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.windowSubagentTrees[0].summary.complete, true);
  assert.equal(snapshot.windowSubagentTrees[0].capacityObservation.observedAt, "2026-08-23T08:04:48.000Z");
});

test("an unknown collaboration registry status fails closed without idling a known running child", async () => {
  const paths = await fixture();
  await appendFile(paths.visualPath, `\n${[
    JSON.stringify({
      timestamp: "2026-08-23T08:03:08.000Z", type: "event_msg",
      payload: { type: "sub_agent_activity", agent_thread_id: "future-thread", agent_path: "/root/future_worker", kind: "started" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:08.500Z", type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "valid-empty-registry", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:09.000Z", type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "valid-empty-registry",
        output: JSON.stringify({ agents: [{ agent_name: "/root", agent_status: "running" }] }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:10.000Z", type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "unknown-status-registry", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:11.000Z", type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "unknown-status-registry",
        output: JSON.stringify({ agents: [{ agent_name: "/root/future_worker", agent_status: "future_active_status" }] }),
      },
    }),
  ].join("\n")}`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const visualTree = snapshot.windowSubagentTrees.find((tree) => tree.rootThreadId === "visual-thread");
  assert.equal(visualTree.capacityObservation, null);
  assert.equal(visualTree.registryObservation, null);
  assert.equal(visualTree.summary.active, 1);
  assert.equal(visualTree.subagents[0].lifecycleStatus, "running");
  await assertInvalidCapacityBlocksContinuation(visualTree);
});

test("a paired malformed collaboration registry invalidates prior capacity before output parsing", async () => {
  const paths = await fixture();
  await appendFile(paths.visualPath, `\n${[
    JSON.stringify({
      timestamp: "2026-08-23T08:03:08.000Z", type: "event_msg",
      payload: { type: "sub_agent_activity", agent_thread_id: "known-thread", agent_path: "/root/known_worker", kind: "started" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:08.500Z", type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "valid-before-malformed", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:09.000Z", type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "valid-before-malformed",
        output: JSON.stringify({ agents: [{ agent_name: "/root", agent_status: "running" }] }),
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:10.000Z", type: "response_item",
      payload: { type: "function_call", name: "list_agents", namespace: "collaboration", call_id: "malformed-without-status", arguments: "{}" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:11.000Z", type: "response_item",
      payload: { type: "function_call_output", call_id: "malformed-without-status", output: "not-json" },
    }),
  ].join("\n")}`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const visualTree = snapshot.windowSubagentTrees.find((tree) => tree.rootThreadId === "visual-thread");
  assert.equal(visualTree.capacityObservation, null);
  assert.equal(visualTree.registryObservation, null);
  assert.equal(visualTree.summary.active, 1);
  assert.equal(visualTree.subagents[0].lifecycleStatus, "running");
  await assertInvalidCapacityBlocksContinuation(visualTree);
});

test("does not treat an unrelated agents-shaped tool output as a capacity observation", async () => {
  const paths = await fixture();
  await appendFile(paths.visualPath, `\n${[
    JSON.stringify({
      timestamp: "2026-08-23T08:03:10.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "list_agents",
        namespace: "unrelated",
        call_id: "unrelated-agents-call",
        arguments: "{}",
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:03:11.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "unrelated-agents-call",
        output: JSON.stringify({
          agents: [{ agent_name: "/root/fake", agent_status: "running" }],
        }),
      },
    }),
  ].join("\n")}`);

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
  const visualTree = snapshot.windowSubagentTrees.find((tree) => tree.rootThreadId === "visual-thread");
  assert.equal(visualTree.capacityObservation, null);
  assert.equal(visualTree.summary.active, 0);
});

test("assigns project coordination through an active replaceable lease", async () => {
  const paths = await fixture({
    coordinatorLease: {
      id: "lease-1",
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      holderCodexHostId: "local",
      holderWorkspacePath: "/tmp/visual",
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:10:00.000Z",
    },
    tasks: [
      { id: "root", label: "Capstone Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
      { id: "visual", label: "Capstone Visual", owner: "Codex Visual", source: "codex", threadId: "visual-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1", codexHostId: "local", workspacePath: "/tmp/visual" },
    ],
    adapters: [],
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.deepEqual(snapshot.coordination, {
    model: "peer_windows_with_coordinator_lease",
    coordinatorTaskId: "visual",
    coordinatorStableIdentity: "capstone-dev:task:visual",
    ownerRootTaskId: "visual",
    ownerRootStableIdentity: "capstone-dev:task:visual",
    ownerRootRoute: null,
    assignment: "lease",
    replaceable: true,
    scope: "project",
    lease: {
      id: "lease-1",
      holderTaskId: "visual",
      bindingValid: true,
      status: "active",
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:10:00.000Z",
      releasedAt: null,
    },
    crossWindowProtocol: "task_capsule_claim_checkpoint_receipt",
    subagentAuthority: "window_root",
    stateAuthority: "self_learning_checkpoint",
    workAuthority: "todo_claim_lease",
    runtimeOwnership: "single_writer",
    domainCoordinators: [],
    pendingOwnerIntent: null,
    pendingOwnerIntentPlan: null,
    ownerDecisionRequest: null,
    pendingCrossDomainHandoff: null,
    durableWorkPending: true,
    shutdownAttempt: null,
  });
  assert.deepEqual(snapshot.rootSubagents, []);
});

test("an explicit Owner Root invalidates a legacy non-Root Global coordinator lease", async () => {
  const paths = await fixture({
    ownerRootTaskId: "root",
    coordinatorLease: {
      id: "legacy-peer-lease",
      holderTaskId: "visual",
      holderThreadId: "visual-thread",
      holderCodexHostId: "local",
      holderWorkspacePath: "/tmp/visual",
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:10:00.000Z",
    },
    tasks: [
      {
        id: "root", label: "Owner Root", owner: "Codex Owner Root", source: "codex",
        threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1",
        codexHostId: "local", workspacePath: "/tmp/root",
      },
      {
        id: "visual", label: "Legacy peer", owner: "Codex Visual", source: "codex",
        threadId: "visual-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1",
        codexHostId: "local", workspacePath: "/tmp/visual",
      },
    ],
    adapters: [],
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.coordination.ownerRootTaskId, "root");
  assert.equal(snapshot.coordination.coordinatorTaskId, null);
  assert.equal(snapshot.coordination.lease.bindingValid, false);
  assert.equal(snapshot.coordination.lease.status, "expired");
});

test("projects an unbound Codex peer as an eligible domain provisioning template", async () => {
  const paths = await fixture({
    rootTaskId: "root",
    ownerRootTaskId: "root",
    tasks: [
      {
        id: "root", label: "Global", owner: "Codex Root", source: "codex",
        connection: "connected", threadId: "root-thread", taskType: "root_task",
        issueIdentifier: "CAPSTONEDEV-1", codexProjectId: "local-project",
        codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/root",
      },
      {
        id: "coding", label: "Coding", owner: "Codex Coding", source: "codex",
        threadId: "legacy-coding-thread", taskType: "peer_task",
        issueIdentifier: "CAPSTONEDEV-2",
      },
    ],
    adapters: [],
    coordinationDomains: [{
      id: "activation", label: "Activation",
      writeScope: ["tmp/activation"], eligibleTaskIds: ["coding"],
    }],
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.coordination.domainCoordinators[0].domainId, "activation");
  assert.equal(snapshot.coordination.domainCoordinators[0].assignment, "unassigned");
  assert.deepEqual(snapshot.coordination.domainCoordinators[0].eligibleTaskIds, ["coding"]);
});

test("projects concurrent disjoint domain coordinators without replacing the Global Coordinator", async () => {
  const paths = await fixture({
    rootTaskId: "root",
    tasks: [
      { id: "root", label: "Global", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
      { id: "frontend", label: "Frontend", owner: "Codex Frontend", source: "codex", threadId: "visual-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1", codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/frontend" },
      { id: "backend", label: "Backend", owner: "Codex Backend", source: "codex", threadId: "backend-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1", codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/backend" },
    ],
    adapters: [],
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
      { id: "backend", label: "Backend", writeScope: ["server"], eligibleTaskIds: ["backend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "frontend-lease", holderTaskId: "frontend",
        holderThreadId: "visual-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/frontend",
        acquiredAt: "2026-08-23T08:00:00.000Z", expiresAt: "2026-08-23T08:10:00.000Z",
      },
      backend: {
        id: "backend-lease", holderTaskId: "backend",
        holderThreadId: "backend-thread", holderCodexHostId: "local", holderWorkspacePath: "/tmp/backend",
        acquiredAt: "2026-08-23T08:00:00.000Z", expiresAt: "2026-08-23T08:10:00.000Z",
      },
    },
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.coordination.coordinatorTaskId, "root");
  assert.equal(snapshot.coordination.runtimeOwnership, "single_writer");
  assert.deepEqual(snapshot.coordination.domainCoordinators.map((domain) => ({
    domainId: domain.domainId,
    coordinatorTaskId: domain.coordinatorTaskId,
    assignment: domain.assignment,
    writeScope: domain.writeScope,
  })), [
    { domainId: "frontend", coordinatorTaskId: "frontend", assignment: "lease", writeScope: ["web"] },
    { domainId: "backend", coordinatorTaskId: "backend", assignment: "lease", writeScope: ["server"] },
  ]);
});

test("an expired coordinator lease fails closed without restoring fixed authority", async () => {
  const paths = await fixture({
    coordinatorLease: {
      id: "lease-expired",
      holderTaskId: "root",
      acquiredAt: "2026-08-23T07:00:00.000Z",
      expiresAt: "2026-08-23T08:04:59.000Z",
    },
    tasks: [
      { id: "root", label: "Capstone Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
    ],
    adapters: [],
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.coordination.coordinatorTaskId, null);
  assert.equal(snapshot.coordination.coordinatorStableIdentity, null);
  assert.equal(snapshot.coordination.assignment, "unassigned");
  assert.equal(snapshot.coordination.replaceable, true);
  assert.deepEqual(snapshot.coordination.lease, {
    id: "lease-expired",
    holderTaskId: "root",
    bindingValid: false,
    status: "expired",
    acquiredAt: "2026-08-23T07:00:00.000Z",
    expiresAt: "2026-08-23T08:04:59.000Z",
    releasedAt: null,
  });
  assert.deepEqual(snapshot.rootSubagents, []);
});

test("accepts zero-duration released Global and domain leases as unassigned", async () => {
  const releasedAt = "2026-08-23T08:00:00.000Z";
  const paths = await fixture({
    tasks: [
      { id: "root", label: "Global", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
      { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "visual-thread", taskType: "peer_task", issueIdentifier: "CAPSTONEDEV-1", codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/frontend" },
    ],
    adapters: [],
    coordinatorLease: {
      id: "released-global", holderTaskId: "root",
      acquiredAt: releasedAt, expiresAt: releasedAt,
    },
    coordinationDomains: [
      { id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"] },
    ],
    domainCoordinatorLeases: {
      frontend: {
        id: "released-frontend", holderTaskId: "frontend",
        acquiredAt: releasedAt, expiresAt: releasedAt,
      },
    },
  });

  const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");

  assert.equal(snapshot.coordination.assignment, "unassigned");
  assert.equal(snapshot.coordination.coordinatorTaskId, null);
  assert.equal(snapshot.coordination.domainCoordinators[0].assignment, "unassigned");
  assert.equal(snapshot.coordination.domainCoordinators[0].coordinatorTaskId, null);
});

test("future and released exact-bound leases remain unassigned in snapshots", async () => {
  for (const leaseTimes of [
    { acquiredAt: "2026-08-23T08:10:00.000Z", expiresAt: "2026-08-23T08:20:00.000Z" },
    {
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:20:00.000Z",
      releasedAt: "2026-08-23T08:04:00.000Z",
    },
  ]) {
    const paths = await fixture({
      tasks: [
        { id: "root", label: "Global", owner: "Codex", source: "codex", threadId: "root-thread", taskType: "root_task", codexHostId: "local", workspacePath: "/tmp/snapshot-root" },
        { id: "frontend", label: "Frontend", owner: "Codex", source: "codex", threadId: "visual-thread", taskType: "peer_task", codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local", workspacePath: "/tmp/snapshot-frontend" },
      ],
      adapters: [],
      coordinatorLease: {
        id: `global-${leaseTimes.acquiredAt}`, holderTaskId: "root",
        holderThreadId: "root-thread", holderCodexHostId: "local",
        holderWorkspacePath: "/tmp/snapshot-root", ...leaseTimes,
      },
      coordinationDomains: [{
        id: "frontend", label: "Frontend", writeScope: ["web"], eligibleTaskIds: ["frontend"],
      }],
      domainCoordinatorLeases: {
        frontend: {
          id: `frontend-${leaseTimes.acquiredAt}`, holderTaskId: "frontend",
          holderThreadId: "visual-thread", holderCodexHostId: "local",
          holderWorkspacePath: "/tmp/snapshot-frontend", ...leaseTimes,
        },
      },
    });
    const snapshot = await createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev");
    assert.equal(snapshot.coordination.assignment, "unassigned");
    assert.equal(snapshot.coordination.coordinatorTaskId, null);
    assert.equal(snapshot.coordination.domainCoordinators[0].assignment, "unassigned");
    assert.equal(snapshot.coordination.domainCoordinators[0].coordinatorTaskId, null);
  }
});

test("rejects a malformed coordinator lease instead of restoring legacy Root authority", async () => {
  const paths = await fixture({
    rootTaskId: "root",
    coordinatorLease: {
      id: "lease-invalid",
      holderTaskId: "missing-window",
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:10:00.000Z",
    },
    tasks: [
      { id: "root", label: "Capstone Root", owner: "Codex Root", source: "codex", threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1" },
    ],
    adapters: [],
  });

  await assert.rejects(
    createAgentLaneSnapshotProvider(paths).getProjectSnapshot("capstone-dev"),
    (error) => error.code === "AGENT_LANES_NOT_CONFIGURED",
  );
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

test("reconciliation processes completed Sub-Agents from peer Talking Windows", async () => {
  const paths = await fixture();
  await appendFile(paths.rootPath, `\n${[
    JSON.stringify({ timestamp: "2026-08-23T08:05:40.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "root-review-thread", agent_path: "/root/review", kind: "started" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:05:50.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/review", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nRoot review complete" }] } }),
  ].join("\n")}`);
  await appendFile(paths.visualPath, `\n${[
    JSON.stringify({ timestamp: "2026-08-23T08:06:00.000Z", type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "peer-review-thread", agent_path: "/root/review", kind: "started" } }),
    JSON.stringify({ timestamp: "2026-08-23T08:06:30.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/review", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPeer review complete" }] } }),
  ].join("\n")}`);
  const completed = [];
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    listTasks: async () => ["root", "peer"].map((kind) => ({
      id: `${kind}-task`,
      identifier: `${kind.toUpperCase()}-1`,
      title: `${kind} review`,
      status: "in_progress",
      labels: ["agent-todo"],
      archivedAt: null,
      threadId: `${kind}-review-thread`,
    })),
    getClaim: async (taskId) => ({
      agentPath: "/root/review",
      agentThreadId: `${taskId.replace("-task", "")}-review-thread`,
      status: "active",
      claimedAt: "2026-08-23T08:05:30.000Z",
      leaseExpiresAt: "2026-08-23T09:00:00.000Z",
      writeScope: ["test/peer-review.test.mjs"],
    }),
    listComments: async () => [],
    recordCompletion: async (event) => {
      completed.push(event.agentThreadId);
      return { applied: true };
    },
  });

  const snapshot = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(snapshot.rootSubagents.some((agent) => agent.agentThreadId === "peer-review-thread"), false);
  assert.equal(snapshot.windowSubagentTrees.find((tree) => tree.windowTaskId === "visual")
    .subagents.some((agent) => agent.agentThreadId === "peer-review-thread"), true);
  await provider.reconcileProject("capstone-dev");
  assert.deepEqual(completed, ["root-review-thread", "peer-review-thread"]);
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

test("keeps a registered Coordinator snapshot recoverable when its cached rollout disappears", async () => {
  const paths = await fixture({
    rootTaskId: "visual",
    ownerRootTaskId: "visual",
    coordinatorLease: {
      id: "coordinator-lease",
      holderTaskId: "root",
      bindingValid: true,
      holderThreadId: "root-thread",
      holderCodexHostId: "local",
      holderWorkspacePath: "/tmp/coordinator-workspace",
      acquiredAt: "2026-08-23T08:00:00.000Z",
      expiresAt: "2026-08-23T08:10:00.000Z",
    },
    tasks: [
      {
        id: "visual", label: "Owner Root", owner: "Codex", source: "codex",
        threadId: "visual-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1",
        codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
        workspacePath: "/tmp/owner-workspace",
      },
      {
        id: "root", label: "Coordinator", owner: "Codex", source: "codex",
        threadId: "root-thread", taskType: "root_task", issueIdentifier: "CAPSTONEDEV-1",
        codexProjectId: "local-project", codexProjectKind: "local", codexHostId: "local",
        workspacePath: "/tmp/coordinator-workspace",
      },
    ],
    adapters: [],
  });
  let racePath = null;
  let removeAfterStat = false;
  let removeBeforeStatCall = null;
  let raceStatCalls = 0;
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    getCurrentHostIdentity: (threadId) => threadId === "root-thread" ? {
      threadId,
      threadRunning: false,
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/tmp/coordinator-workspace",
    } : null,
    recordProgress: async () => ({ applied: false }),
    statSessionFile: async (filename) => {
      if (filename !== racePath) return stat(filename);
      raceStatCalls += 1;
      if (raceStatCalls === removeBeforeStatCall) await rm(filename);
      const details = await stat(filename);
      if (removeAfterStat && raceStatCalls === 1) await rm(filename);
      return details;
    },
  });

  const initial = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(initial.coordination.lease.bindingValid, true);
  assert.equal(initial.taskLanes.find((lane) => lane.id === "root").status, "running");

  await rm(paths.rootPath);

  const recovered = await provider.getProjectSnapshot("capstone-dev");
  const coordinator = recovered.taskLanes.find((lane) => lane.id === "root");
  assert.equal(recovered.coordination.lease.bindingValid, true);
  assert.equal(coordinator.status, "unavailable");
  assert.equal(coordinator.continuity.state, "disconnected");
  assert.match(coordinator.blocker, /session was not found/);
  assert.deepEqual(await provider.reconcileProject("capstone-dev"), { applied: 0 });

  const replacementContents = [
    JSON.stringify({
      timestamp: "2026-08-23T08:04:30.000Z",
      type: "session_meta",
      payload: { session_id: "root-thread" },
    }),
    JSON.stringify({
      timestamp: "2026-08-23T08:04:40.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Recovered after rollout relocation." },
    }),
  ].join("\n");
  const replacementPath = path.join(path.dirname(paths.rootPath), "rollout-moved-root-thread.jsonl");
  await writeFile(replacementPath, replacementContents);
  const relocated = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(relocated.taskLanes.find((lane) => lane.id === "root").status, "idle");

  await appendFile(replacementPath, `\n${JSON.stringify({
    timestamp: "2026-08-23T08:04:50.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "Race before read." },
  })}`);
  racePath = replacementPath;
  removeAfterStat = true;
  raceStatCalls = 0;
  const readRace = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(readRace.taskLanes.find((lane) => lane.id === "root").status, "unavailable");

  const secondReplacementPath = path.join(
    path.dirname(paths.rootPath),
    "rollout-relocated-root-thread.jsonl",
  );
  await writeFile(secondReplacementPath, replacementContents);
  removeAfterStat = false;
  racePath = secondReplacementPath;
  raceStatCalls = 0;
  const secondRelocation = await provider.getProjectSnapshot("capstone-dev");
  assert.equal(secondRelocation.taskLanes.find((lane) => lane.id === "root").status, "idle");

  removeBeforeStatCall = 2;
  raceStatCalls = 0;
  const subagentRace = await provider.getProjectSnapshot("capstone-dev");
  const coordinatorTree = subagentRace.windowSubagentTrees.find(
    (tree) => tree.windowTaskId === "root",
  );
  assert.equal(coordinatorTree.observed, false);
  assert.equal(coordinatorTree.summary.complete, false);
});

test("does not hide non-ENOENT Codex session read failures", async () => {
  const paths = await fixture();
  const failure = Object.assign(new Error("session access denied"), { code: "EACCES" });
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    statSessionFile: async (filename) => {
      if (filename === paths.rootPath) throw failure;
      return stat(filename);
    },
  });

  await assert.rejects(provider.getProjectSnapshot("capstone-dev"), (error) => error === failure);
});

test("does not hide non-ENOENT Codex session discovery failures", async () => {
  const paths = await fixture();
  const failure = Object.assign(new Error("session directory access denied"), { code: "EACCES" });
  const provider = createAgentLaneSnapshotProvider({
    ...paths,
    readSessionDirectory: async () => {
      throw failure;
    },
  });

  await assert.rejects(provider.getProjectSnapshot("capstone-dev"), (error) => error === failure);
});

test("rejects projects that have no configured lane mapping", async () => {
  const paths = await fixture();
  const provider = createAgentLaneSnapshotProvider(paths);
  await assert.rejects(
    provider.getProjectSnapshot("other-project"),
    (error) => error?.code === "AGENT_LANES_NOT_CONFIGURED",
  );
});
