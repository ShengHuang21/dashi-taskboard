import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  deliverTaskboardCoordination,
  deliverTaskboardOwnerDecision,
  findResidentInjectorPids,
  handleHostBindingPayload,
  observeTaskboardOwnerDecision,
  reconcileInjectionRuntime,
  runOwnerDecisionMonitorOnce,
  runTaskboardContinuationMonitorOnce,
  restartResidentInjector,
} from "../scripts/codex-injector-runtime.mjs";

const coordinationAuthorization = {
  safeActionId: "safe-action",
  expectedResumeToken: "a".repeat(64),
  rootWorkspacePath: "/tmp/taskboard/project",
};
const deliverCoordination = (request, rpc, validateExecutionTarget = async () => {}) => (
  deliverTaskboardCoordination(request, rpc, validateExecutionTarget)
);
const confirmedIdentity = {
  worktreePath: "/tmp/taskboard/project",
  branch: "codex/test",
  repository: null,
};

test("background continuation delivers one eligible first safe action without a mounted view", async () => {
  const deliveries = [];
  const receipts = new Set();
  const todo = {
    id: "TASKBOARD-BACKGROUND",
    taskId: "8e0aa41d-8ffd-4dfa-9efe-9a80c976615e",
    run: null,
    dispatchTarget: {
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/project",
      worktreePath: "/tmp/taskboard/project",
    },
    readyWork: {
      eligible: true,
      safeActions: [{ id: "safe-first", text: "Run focused tests" }],
      deferredActions: [{ id: "push", text: "Push later" }],
      resumeToken: "b".repeat(64),
    },
  };
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", todos: [todo] }),
    claimReceipt: async (claim) => {
      assert.deepEqual(claim, {
        todoId: todo.id,
        taskId: todo.taskId,
        rootThreadId: todo.dispatchTarget.rootThreadId,
        safeActionId: "safe-first",
        expectedResumeToken: "b".repeat(64),
      });
      const key = `${claim.todoId}:${claim.expectedResumeToken}`;
      if (receipts.has(key)) return false;
      receipts.add(key);
      return true;
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async (request) => {
      deliveries.push(request);
      return { delivery: "started", turnId: "turn-background" };
    },
  };

  const first = await runTaskboardContinuationMonitorOnce(options);
  const duplicate = await runTaskboardContinuationMonitorOnce(options);

  assert.deepEqual(first, { delivered: true, todoId: todo.id, actionId: "safe-first" });
  assert.deepEqual(duplicate, { delivered: false, reason: "reservation-unavailable" });
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0], {
    projectId: "taskboard-core",
    todoId: todo.id,
    rootThreadId: todo.dispatchTarget.rootThreadId,
    codexHostId: "local",
    rootWorkspacePath: "/tmp/taskboard/project",
    targetRoot: "/tmp/taskboard/project",
    safeActionId: "safe-first",
    expectedResumeToken: "b".repeat(64),
    executionIdentity: { ...confirmedIdentity, standingAuthority: false },
  });
});

test("one project Owner decision is delivered only to its exact confirmed Root window", async () => {
  const request = {
    requestId: "d".repeat(64),
    expectedResumeToken: "e".repeat(64),
    identifier: "CAP-10",
    actionId: "push",
    message: "同意 ordinary push exact commit",
    coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root",
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const calls = [];
  const deliver = (current) => deliverTaskboardOwnerDecision(current, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns: [{ id: "turn-active", status: "inProgress" }] } };
    }
    if (method === "turn/steer") return {};
    throw new Error(`Unexpected method: ${method}`);
  });
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      coordination: { ownerDecisionRequest: request },
    }),
    claimDelivery: async () => ({
      claimed: true,
      receipt: { id: "delivery-1" },
    }),
    confirmDelivery: async () => ({ confirmed: true }),
    deliver,
    observeDecision: async () => null,
    recordDecision: async () => assert.fail("no Owner decision was observed"),
  };

  assert.deepEqual(await runOwnerDecisionMonitorOnce(options), {
    delivered: true,
    requestId: request.requestId,
    delivery: "steered",
    awaitingOwner: true,
  });
  assert.equal(calls[0][0], "thread/read");
  assert.equal(calls[1][0], "turn/steer");
  assert.match(calls[1][1].input[0].text, /Ask the Owner exactly this one question in this Root window/);
  assert.match(calls[1][1].input[0].text, /Do not approve it yourself/);
  assert.match(calls[1][1].input[0].text, /delivery-1/);
  assert.doesNotMatch(calls[1][1].input[0].text, /attestation token/i);
});

test("Owner decision observation requires an actual Owner turn in the exact Root thread", async () => {
  const request = {
    requestId: "9".repeat(64), expectedResumeToken: "8".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  const receipt = { id: "delivery-observe", deliveryTurnId: "delivery-turn" };
  const marker = `TASKBOARD_OWNER_DECISION_V1 ${JSON.stringify({
    requestId: request.requestId,
    outcome: "authorized",
    evidence: "Owner explicitly approved",
  })}`;
  const read = (turns) => observeTaskboardOwnerDecision(request, receipt, async () => ({
    thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns },
  }));
  assert.equal(await read([{
    id: "delivery-turn",
    input: [{ type: "text", text: `Taskboard Owner decision delivery id: ${receipt.id}` }],
    items: [{ type: "agent_message", role: "assistant", content: marker }],
  }]), null);
  assert.deepEqual(await read([
    {
      id: "delivery-turn",
      input: [{ type: "text", text: `Taskboard Owner decision delivery id: ${receipt.id}` }],
    },
    {
      id: "owner-turn",
      input: [{ type: "text", text: "Yes, approve this exact action" }],
      items: [{ type: "agent_message", role: "assistant", content: marker }],
    },
  ]), {
    outcome: "authorized",
    evidence: "Owner explicitly approved",
    ownerTurnId: "owner-turn",
    rootDecisionTurnId: "owner-turn",
    rootThreadId: request.route.rootThreadId,
  });
});

test("an uncertain Owner delivery is read back by id before any retry side effect", async () => {
  const request = {
    requestId: "7".repeat(64), expectedResumeToken: "6".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
    deliveryReceipt: { id: "delivery-uncertain" },
  };
  const activeTurn = { id: "active-turn", status: "inProgress", input: [] };
  let steerCalls = 0;
  const rpc = async (method, params) => {
    if (method === "thread/read") {
      return { thread: { id: request.route.rootThreadId, cwd: request.route.rootWorkspacePath, turns: [activeTurn] } };
    }
    if (method === "turn/steer") {
      steerCalls += 1;
      activeTurn.input = params.input;
      throw new Error("confirmation channel lost after Root accepted the steer");
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  await assert.rejects(deliverTaskboardOwnerDecision(request, rpc), /confirmation channel lost/);
  assert.deepEqual(await deliverTaskboardOwnerDecision(request, rpc), {
    delivery: "observed",
    turnId: "active-turn",
  });
  assert.equal(steerCalls, 1);
});

test("Owner decision delivery uses an atomic durable reservation before any Root call", async () => {
  const request = {
    requestId: "a".repeat(64), expectedResumeToken: "b".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let claims = 0;
  let deliveries = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
    claimDelivery: async () => {
      claims += 1;
      if (claims > 1) return { claimed: false, reason: "reserved" };
      return { claimed: true, receipt: { id: "delivery-atomic" } };
    },
    deliver: async () => { deliveries += 1; await barrier; return { delivery: "steered", turnId: "turn-1" }; },
    confirmDelivery: async () => ({ confirmed: true }),
    observeDecision: async () => null,
    recordDecision: async () => assert.fail("no Owner decision was observed"),
  };
  const first = runOwnerDecisionMonitorOnce(options);
  const second = runOwnerDecisionMonitorOnce(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries, 1);
  release();
  assert.equal((await first).delivered, true);
  assert.equal((await second).delivered, true);
});

test("Owner decision monitor stops when the service rejects a stale coordinator route", async () => {
  const request = {
    requestId: "3".repeat(64), expectedResumeToken: "4".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "lease:old",
    route: {
      rootTaskId: "old-root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/old-root",
    },
  };
  let delivered = 0;
  const result = await runOwnerDecisionMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
    claimDelivery: async () => ({ claimed: false, reason: "stale-route" }),
    deliver: async () => { delivered += 1; },
    confirmDelivery: async () => assert.fail("stale route must not confirm"),
    observeDecision: async () => assert.fail("stale route must not be observed"),
    recordDecision: async () => assert.fail("stale route must not record"),
  });
  assert.deepEqual(result, { delivered: false, reason: "stale-route" });
  assert.equal(delivered, 0);
});

test("a durable delivered request is recorded only from the exact Root observation", async () => {
  const request = {
    requestId: "5".repeat(64), expectedResumeToken: "4".repeat(64), identifier: "CAP-10",
    actionId: "push", message: "Ask Owner", coordinatorEpoch: "configured:root",
    route: {
      rootTaskId: "root", rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local", rootWorkspacePath: "/tmp/taskboard/root",
    },
  };
  let recorded;
  const result = await runOwnerDecisionMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({ projectId: "taskboard-core", coordination: { ownerDecisionRequest: request } }),
    claimDelivery: async () => ({
      claimed: false,
      reason: "already-delivered",
      receipt: { id: "delivery-record", deliveryTurnId: "delivery-turn" },
    }),
    deliver: async () => assert.fail("delivered receipt must not deliver again"),
    confirmDelivery: async () => assert.fail("delivered receipt must not confirm again"),
    observeDecision: async () => ({
      outcome: "authorized",
      evidence: "Owner approved exact scope",
      ownerTurnId: "owner-turn",
      rootDecisionTurnId: "root-decision-turn",
      rootThreadId: request.route.rootThreadId,
    }),
    recordDecision: async (value) => { recorded = value; return { applied: true }; },
  });
  assert.equal(result.decisionRecorded, true);
  assert.equal(result.delivered, false);
  assert.deepEqual(recorded, {
    taskId: "CAP-10",
    requestId: request.requestId,
    expectedResumeToken: request.expectedResumeToken,
    deliveryId: "delivery-record",
    outcome: "authorized",
    evidence: "Owner approved exact scope",
    ownerTurnId: "owner-turn",
    rootDecisionTurnId: "root-decision-turn",
    rootThreadId: request.route.rootThreadId,
  });
});

test("background continuation fails closed for disabled, open-run, or malformed work", async () => {
  let delivered = 0;
  const base = {
    policy: { enabled: false, projectId: "taskboard-core" },
    readSnapshot: async () => assert.fail("disabled monitor must not read"),
    claimReceipt: async () => assert.fail("must not claim a receipt"),
    confirmDelivery: async () => assert.fail("must not confirm delivery"),
    deliver: async () => { delivered += 1; },
  };
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce(base),
    { delivered: false, reason: "disabled" },
  );

  const unsafeTodos = [
    {
      id: "OPEN-RUN", run: { state: "active" },
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [{ id: "safe" }], resumeToken: "c".repeat(64) },
    },
    {
      id: "NO-TOKEN", run: null,
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [{ id: "safe" }], resumeToken: null },
    },
    {
      id: "NO-SAFE-ACTION", run: null,
      dispatchTarget: { rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local", worktreePath: "/tmp/project" },
      readyWork: { eligible: true, safeActions: [], resumeToken: "d".repeat(64) },
    },
  ];
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce({
      ...base,
      policy: { enabled: true, projectId: "taskboard-core" },
      readSnapshot: async () => ({ projectId: "taskboard-core", todos: unsafeTodos }),
    }),
    { delivered: false, reason: "no-eligible-work" },
  );
  assert.equal(delivered, 0);
});

test("background continuation reserves the durable receipt before an uncertain delivery", async () => {
  let claimed = false;
  const options = {
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "UNCERTAIN",
        taskId: "36e47e0e-77f3-41ca-b569-0125788288c4",
        run: null,
        dispatchTarget: {
          rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first" }],
          resumeToken: "e".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    confirmDelivery: async () => confirmedIdentity,
    deliver: async () => { throw new Error("receipt unknown"); },
  };
  await assert.rejects(runTaskboardContinuationMonitorOnce(options), /receipt unknown/);
  assert.deepEqual(
    await runTaskboardContinuationMonitorOnce(options),
    { delivered: false, reason: "reservation-unavailable" },
  );
});

test("background continuation fails closed when the authoritative reservation is rejected", async () => {
  let delivered = false;
  const result = await runTaskboardContinuationMonitorOnce({
    policy: { enabled: true, projectId: "taskboard-core" },
    readSnapshot: async () => ({
      projectId: "taskboard-core",
      todos: [{
        id: "STALE",
        taskId: "f727e1f4-e4da-44d3-9c55-4f4d8b487955",
        run: null,
        dispatchTarget: {
          rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
          codexHostId: "local",
          rootWorkspacePath: "/tmp/taskboard/project",
          worktreePath: "/tmp/taskboard/project",
        },
        readyWork: {
          eligible: true,
          safeActions: [{ id: "safe-first" }],
          resumeToken: "f".repeat(64),
        },
      }],
    }),
    claimReceipt: async () => false,
    confirmDelivery: async () => assert.fail("rejected reservations must not confirm delivery"),
    deliver: async () => { delivered = true; },
  });

  assert.deepEqual(result, { delivered: false, reason: "reservation-unavailable" });
  assert.equal(delivered, false);
});

test("the resident authenticated host polls durable opt-in policies without the Agent Lanes view", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(source, /taskboard:background-continuation:policy:/);
  assert.match(source, /api\/client-storage/);
  assert.match(source, /api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-claim/);
  assert.match(source, /api\/tasks\/\$\{encodeURIComponent\(claim\.todoId\)\}\/bootstrap-delivery/);
  assert.match(source, /validateGitExecutionTarget/);
  assert.match(source, /runTaskboardContinuationMonitorOnce/);
  assert.match(source, /deliverTaskboardCoordination/);
  assert.doesNotMatch(source, /background-continuation-receipts/);
  assert.match(source, /setInterval\(\(\) => void tick\(\), backgroundContinuationIntervalMs\)/);
});

test("the authenticated network proxy signs host-runtime publications", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /method === "PUT" && requestUrl === `\$\{taskboardBaseUrl\}\/api\/local\/host-runtime`[\s\S]{0,500}requestedHeaders\.push\(\.\.\.Object\.entries\(injectorProofHeaders\(\)\)\)/,
  );
});

test("Agent Todo coordination steers an active Root turn", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-17",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return {
        thread: {
          id: request.rootThreadId,
          cwd: request.rootWorkspacePath,
          turns: [{ id: "turn-active", status: "inProgress" }],
        },
      };
    }
    return {};
  });

  assert.deepEqual(result, { delivery: "steered", turnId: "turn-active" });
  assert.equal(calls[1][0], "turn/steer");
  assert.equal(calls[1][1].expectedTurnId, "turn-active");
  assert.match(calls[1][1].input[0].text, /^taskctl issue bootstrap TASKBOARD-17 --json/);
  assert.match(calls[1][1].input[0].text, /readyWork\.eligible/);
  assert.match(calls[1][1].input[0].text, /safeActions\[0\]\.id/);
  assert.match(calls[1][1].input[0].text, /Never execute any readyWork\.deferredActions/);
  assert.match(calls[1][1].input[0].text, /Todo: TASKBOARD-17/);
  assert.match(calls[1][1].input[0].text, /spawn the smallest useful Sub-Agent/);
});

test("Agent Todo coordination starts an idle Root turn", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-18",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-new" } };
    return {};
  });

  assert.deepEqual(result, { delivery: "started", turnId: "turn-new" });
  assert.deepEqual(calls.map(([method]) => method), ["thread/read", "thread/resume", "turn/start"]);
});

test("the authenticated host binding accepts one bounded Agent Todo request", async () => {
  const calls = [];
  const result = await handleHostBindingPayload({
    executionContextId: 12,
    payload: JSON.stringify({
      id: "coordinate-1",
      action: "coordinate-agent-todo",
      rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
      codexHostId: "local",
      projectId: "taskboard-core",
      todoId: "TASKBOARD-19",
      targetRoot: "/tmp/taskboard/project",
      ...coordinationAuthorization,
    }),
  }, {
    isAuthorizedContext: (id) => id === 12,
    parseAutomationRequest: () => null,
    coordinateAgentTodo: async (request) => {
      calls.push(["coordinate", request.todoId]);
      return { delivery: "started" };
    },
    sendResponse: async (_id, response) => calls.push(["response", response]),
  });

  assert.deepEqual(result, { responded: true, accepted: true });
  assert.deepEqual(calls, [
    ["coordinate", "TASKBOARD-19"],
    ["response", { id: "coordinate-1", ok: true, delivery: "started" }],
  ]);
});

test("Agent Todo coordination rejects a Root cwd that is not exactly the coordination workspace", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-WRONG", targetRoot: "/tmp/other/project",
    ...coordinationAuthorization,
  };
  await assert.rejects(
    deliverCoordination(request, async (method) => {
      calls.push(method);
      return { thread: { id: request.rootThreadId, cwd: "/tmp/taskboard", turns: [] } };
    }),
    /exactly match/i,
  );
  assert.deepEqual(calls, ["thread/read"]);
});

test("Agent Todo coordination can target a Git worktree outside the Root coordination workspace", async () => {
  const calls = [];
  const validatedTargets = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-SEPARATE",
    rootWorkspacePath: "/Users/owner/capstone-coordination",
    targetRoot: "/tmp/capstone-execution-worktree",
    safeActionId: "safe-action-separate",
    expectedResumeToken: "f".repeat(64),
  };
  const result = await deliverCoordination(request, async (method, params) => {
    calls.push([method, params]);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-separate" } };
    return {};
  }, async (targetRoot) => validatedTargets.push(targetRoot));
  assert.deepEqual(result, { delivery: "started", turnId: "turn-separate" });
  assert.deepEqual(validatedTargets, [request.targetRoot]);
  const instruction = calls.find(([method]) => method === "turn/start")?.[1]?.input?.[0]?.text ?? "";
  assert.match(instruction, /Exact execution worktree: \/tmp\/capstone-execution-worktree/);
  assert.match(instruction, /coordination cwd may be different/);
});

test("Agent Todo coordination fails closed without an execution worktree validator", async () => {
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-NO-VALIDATOR",
    targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  await assert.rejects(
    deliverTaskboardCoordination(request, async () => assert.fail("RPC must not run")),
    /validator is required/i,
  );
});

test("Agent Todo delivery dedupe is scoped to the normalized Todo worktree", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae",
    codexHostId: "local",
    projectId: "taskboard-core",
    todoId: "TASKBOARD-TARGET-IDENTITY",
    targetRoot: "/tmp/right",
    ...coordinationAuthorization,
  };
  const rpc = async (method) => {
    calls.push(method);
    if (method === "thread/read") {
      return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    }
    if (method === "turn/start") return { turn: { id: "turn-right" } };
    return {};
  };

  const first = await deliverCoordination(request, rpc);
  const duplicate = await deliverCoordination({ ...request }, rpc);
  assert.deepEqual(first, { delivery: "started", turnId: "turn-right" });
  assert.deepEqual(duplicate, first);
  assert.equal(calls.filter((method) => method === "thread/read").length, 1);

  assert.deepEqual(
    await deliverCoordination({ ...request, targetRoot: "/tmp/wrong" }, rpc),
    { delivery: "started", turnId: "turn-right" },
  );
  assert.equal(calls.filter((method) => method === "thread/read").length, 2);
  assert.equal(calls.filter((method) => method === "turn/start").length, 2);
});

test("Agent Todo coordination is idempotent and requires a turn receipt", async () => {
  const calls = [];
  const request = {
    rootThreadId: "01a004bd-a749-7b53-81e2-af2d477f93ae", codexHostId: "local",
    projectId: "taskboard-core", todoId: "TASKBOARD-IDEMPOTENT", targetRoot: "/tmp/taskboard/project",
    ...coordinationAuthorization,
  };
  const rpc = async (method) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-once" } };
    return {};
  };
  const [left, right] = await Promise.all([
    deliverCoordination(request, rpc), deliverCoordination(request, rpc),
  ]);
  assert.deepEqual(left, { delivery: "started", turnId: "turn-once" });
  assert.deepEqual(right, left);
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);

  await assert.rejects(
    deliverCoordination({ ...request, todoId: "TASKBOARD-NO-RECEIPT" }, async (method) => (
      method === "thread/read"
        ? { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } }
        : {}
    )),
    /turn receipt/i,
  );

  const retry = await deliverCoordination(
    { ...request, todoId: "TASKBOARD-NO-RECEIPT" },
    async (method) => method === "thread/read"
      ? { thread: { id: request.rootThreadId, cwd: request.rootWorkspacePath, turns: [] } }
      : { turn: { id: "turn-after-retry" } },
  );
  assert.deepEqual(retry, { delivery: "started", turnId: "turn-after-retry" });
});

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  codexProjectKind: "local",
  codexHostId: "local",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a binding call from the wrong execution context cannot reach native actions", async () => {
  const calls = [];
  const result = await handleHostBindingPayload(
    {
      payload: JSON.stringify({ id: "host-request-2", action: "ensure" }),
      executionContextId: 44,
    },
    {
      isAuthorizedContext: (executionContextId) => executionContextId === 12,
      parseAutomationRequest: () => null,
      ensure: async () => calls.push("ensure"),
      runAutomation: async () => calls.push("automation"),
      prefill: async () => calls.push("prefill"),
      sendResponse: async () => calls.push("response"),
    },
  );

  assert.deepEqual(result, { responded: false, accepted: false });
  assert.deepEqual(calls, []);
});

test("frame loading and external links require bounded authenticated values", async () => {
  const calls = [];
  const handlers = {
    parseAutomationRequest: () => null,
    ensure: async () => assert.fail("ensure must not run"),
    loadFrame: async (request) => calls.push(["load", request.frameCapability]),
    openExternal: async (request) => calls.push(["open", request.url]),
    runAutomation: async () => assert.fail("automation must not run"),
    prefill: async () => assert.fail("prefill must not run"),
    sendResponse: async (_executionContextId, response) => calls.push(["response", response.ok]),
  };

  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "load-request-1",
      action: "load-frame",
      frameName: "codex-taskboard-8f99fbb3-12d4-48af-8938-89f993fab008",
      frameCapability: "30c3d0c4-aa0f-4169-93c0-bb3da20bc654",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-http",
      action: "open-external",
      url: "http://10.0.203.86:30842/projects",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-1",
      action: "open-external",
      url: "https://example.com/review",
    }),
    executionContextId: 12,
  }, handlers);
  await handleHostBindingPayload({
    payload: JSON.stringify({
      id: "external-request-2",
      action: "open-external",
      url: "javascript:alert(1)",
    }),
    executionContextId: 12,
  }, handlers);

  assert.deepEqual(calls, [
    ["load", "30c3d0c4-aa0f-4169-93c0-bb3da20bc654"],
    ["response", true],
    ["open", "http://10.0.203.86:30842/projects"],
    ["response", true],
    ["open", "https://example.com/review"],
    ["response", true],
    ["response", false],
  ]);
});

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "自动认领配置暂时无法应用，请刷新后重试",
    diagnosticCode: "AUTOMATION_SCHEMA_MISMATCH",
  }]);
});

test("attach replaces an old runtime with the current source and restores an open page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.7",
      sourceHash: null,
      pageVisible: true,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: true,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: true,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
    ["open"],
  ]);
});

test("attach is idempotent for the same source hash and does not open a closed page", async () => {
  const calls = [];
  const result = await reconcileInjectionRuntime({
    currentStatus: {
      version: "0.6.8",
      sourceHash: "current-hash",
      pageVisible: false,
      scriptIdentifier: "old-registration",
    },
    source: "current-source",
    sourceHash: "current-hash",
    removeRegisteredSource: async (identifier) => calls.push(["remove", identifier]),
    registerCurrentSource: async (source) => {
      calls.push(["register", source]);
      return "current-registration";
    },
    evaluateCurrentSource: async (source) => calls.push(["evaluate", source]),
    publishRegistration: async (identifier) => calls.push(["publish", identifier]),
    reopen: async () => calls.push(["open"]),
  });

  assert.deepEqual(result, {
    replaced: false,
    scriptIdentifier: "current-registration",
    shouldRemainOpen: false,
  });
  assert.deepEqual(calls, [
    ["remove", "old-registration"],
    ["register", "current-source"],
    ["evaluate", "current-source"],
    ["publish", "current-registration"],
  ]);
});

test("resident discovery accepts this repository's absolute and relative launch forms only", () => {
  const projectRoot = "/workspace/codex-taskboard";
  const injectorPath = `${projectRoot}/scripts/codex-injector.mjs`;
  const processList = [
    `101 node ${injectorPath} --watch --port 9231`,
    "102 node scripts/codex-injector.mjs --watch",
    "103 node ./scripts/codex-injector.mjs --watch --port=9231",
    "104 node scripts/codex-injector.mjs --watch",
    `105 node ${injectorPath} --watch --port 9229`,
    `106 node ${injectorPath} --port 9231`,
  ].join("\n");
  const cwdByPid = new Map([
    [102, projectRoot],
    [103, projectRoot],
    [104, "/workspace/another-repository"],
  ]);

  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9231,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [101, 103]);
  assert.deepEqual(findResidentInjectorPids({
    processList,
    currentPid: 999,
    injectorPath,
    projectRoot,
    port: 9229,
    defaultPort: 9229,
    cwdForPid: (pid) => cwdByPid.get(pid) ?? null,
  }), [102, 105]);
});

test("refresh stops every stale resident before starting one token-verified replacement", async () => {
  const calls = [];
  const startupToken = "replacement-token";
  const replacement = await restartResidentInjector(9231, {
    findResidents: () => [4321, 5432],
    stopResident: async (pid) => calls.push(["stop", pid]),
    createStartupToken: () => startupToken,
    startResident: (port, token) => {
      calls.push(["start", port, token]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid, token) => calls.push(["ready", port, pid, token]),
  });

  assert.deepEqual(replacement, {
    previousPids: [4321, 5432],
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["stop", 5432],
    ["start", 9231, startupToken],
    ["ready", 9231, 9876, startupToken],
  ]);
});
