import assert from "node:assert/strict";
import test from "node:test";

import { createTaskCapsule } from "../server/task-capsule.mjs";

const WORKTREE = "/tmp/taskboard-cap-4";

function task(overrides = {}) {
  return {
    id: "task-1",
    identifier: "CAP-4",
    projectId: "capstone-dev",
    title: "Coordinate authorization gates",
    description: "Keep safe local work moving while delivery gates remain closed.",
    labels: [],
    status: "todo",
    version: 7,
    archivedAt: null,
    threadBinding: {
      threadId: "root-thread",
      codexProjectId: "local-project",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: WORKTREE,
    },
    legacyLocalThreadId: null,
    conversationRefs: [],
    developmentContext: { type: "worktree", path: WORKTREE, branch: "codex/cap-4" },
    workingLog: { path: `${WORKTREE}/CAP-4-WORKING-LOG.md`, status: "active", updatedAt: "2026-08-26T00:00:00.000Z" },
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    ...overrides,
  };
}

test("projects a project Talking Window inbox without granting execution authority", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [gate("local", "edit", "authorized", {
      evidence: "Owner authorized local work",
      receipt: "turn:project-inbox",
    })],
    actions: [action("edit-inbox", 10, "local", "Edit the project inbox")],
  }))], {
    labels: ["project-inbox"],
    conversationRefs: [
      {
        threadId: "project-talk",
        codexProjectId: "project-a",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "/tmp/project-a",
        source: "task",
        sourceId: "task-1",
        title: "Initial project conversation",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      {
        threadId: "project-talk",
        codexProjectId: "project-a",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "/tmp/project-a",
        source: "comment",
        sourceId: "comment-newer",
        title: "Latest project conversation",
        updatedAt: "2026-08-26T00:05:00.000Z",
      },
      {
        threadId: "second-talk",
        legacyLocal: true,
        source: "comment",
        sourceId: "comment-legacy",
        title: "Second talking window",
        updatedAt: "2026-08-26T00:04:00.000Z",
      },
    ],
  });

  assert.deepEqual(result.conversation, {
    scope: { type: "project", projectId: "capstone-dev" },
    talkingWindows: [
      {
        threadId: "project-talk",
        bindingState: "confirmed",
        codexProjectId: "project-a",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: "/tmp/project-a",
        latestSource: { type: "comment", id: "comment-newer" },
        updatedAt: "2026-08-26T00:05:00.000Z",
      },
      {
        threadId: "second-talk",
        bindingState: "legacy_local",
        codexProjectId: null,
        codexProjectKind: null,
        codexHostId: null,
        workspacePath: null,
        latestSource: { type: "comment", id: "comment-legacy" },
        updatedAt: "2026-08-26T00:04:00.000Z",
      },
    ],
  });
  assert.equal(result.readyWork.eligible, false);
  assert.deepEqual(result.readyWork.reasonCodes, ["PROJECT_INBOX_NON_DISPATCHABLE"]);
  assert.deepEqual(result.readyWork.safeActions, []);
});

test("projects an ordinary Feature or Task conversation at work-item scope", () => {
  const result = capsule([], { labels: ["feature"] });

  assert.deepEqual(result.conversation, {
    scope: {
      type: "work_item",
      projectId: "capstone-dev",
      taskId: "task-1",
      identifier: "CAP-4",
    },
    talkingWindows: [],
  });
});

test("confirmed binding supersedes legacy references for the same Talking Window", () => {
  const result = capsule([], {
    conversationRefs: [
      {
        threadId: "root-thread",
        codexProjectId: "local-project",
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: WORKTREE,
        source: "task",
        sourceId: "task-1",
        title: "Confirmed Root binding",
        updatedAt: "2026-08-26T00:01:00.000Z",
      },
      {
        threadId: "root-thread",
        legacyLocal: true,
        source: "comment",
        sourceId: "comment-legacy",
        title: "Older legacy reference",
        updatedAt: "2026-08-26T00:02:00.000Z",
      },
    ],
  });

  assert.deepEqual(result.conversation.talkingWindows, [{
    threadId: "root-thread",
    bindingState: "confirmed",
    codexProjectId: "local-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: WORKTREE,
    latestSource: { type: "task", id: "task-1" },
    updatedAt: "2026-08-26T00:01:00.000Z",
  }]);
});

test("projects a truthful Feature milestone and child Workstream rollup", () => {
  const child = (id, status, labels = ["workstream"]) => ({
    id,
    identifier: id.toUpperCase(),
    version: 1,
    externalKey: null,
    projectId: "capstone-dev",
    title: `${id} title`,
    status,
    priority: "medium",
    labels,
    startDate: null,
    dueDate: null,
    assignee: { type: "agent", id: "codex", name: "Codex", avatarUrl: null },
    archivedAt: null,
  });
  const result = capsule([], {
    labels: ["feature"],
    startDate: "2026-08-20",
    dueDate: "2026-08-31",
    relations: {
      parent: null,
      subIssues: [
        child("work-1", "done"),
        child("work-2", "in_progress"),
        child("work-3", "blocked"),
        child("supporting-task", "todo", []),
      ],
      blockedBy: [],
      blocks: [],
      related: [],
    },
  });

  assert.deepEqual(result.planning, {
    role: "feature",
    milestone: { startDate: "2026-08-20", dueDate: "2026-08-31" },
    parentFeature: null,
    childWorkstreams: ["WORK-1", "WORK-2", "WORK-3"],
    rollup: {
      totalChildren: 4,
      workstreams: 3,
      unclassifiedChildren: 1,
      completed: 1,
      active: 1,
      blocked: 1,
      remaining: 3,
      state: "blocked",
    },
  });

  const workstream = capsule([], {
    labels: ["workstream"],
    startDate: null,
    dueDate: "2026-08-29",
    relations: {
      parent: child("feature-1", "in_progress", ["feature"]),
      subIssues: [],
      blockedBy: [],
      blocks: [],
      related: [],
    },
  });
  assert.deepEqual(workstream.planning, {
    role: "workstream",
    milestone: { startDate: null, dueDate: "2026-08-29" },
    parentFeature: "FEATURE-1",
    childWorkstreams: [],
    rollup: null,
  });
});

function envelopeComment(envelope, overrides = {}) {
  return {
    id: "comment-envelope",
    taskId: "task-1",
    body: `Task Authorization Envelope V1\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``,
    threadId: "root-thread",
    authorType: "user",
    authorId: "owner",
    authorName: "Owner",
    authorAvatarUrl: null,
    attachments: [],
    version: 1,
    createdAt: "2026-08-26T00:01:00.000Z",
    updatedAt: "2026-08-26T00:01:00.000Z",
    ...overrides,
  };
}

function envelope({ actions, gates, ...extra }) {
  return { gates, actions, ...extra };
}

function gate(id, kind, state, extra = {}) {
  const resolvedLifecycle = ["authorized", "denied", "forbidden"].includes(state)
    ? { approver: "Owner", approvalRequest: `Approve ${kind} scope` }
    : {};
  return { id, kind, state, scope: `${kind} scope`, ...resolvedLifecycle, ...extra };
}

function action(id, order, gateId, text, extra = {}) {
  return { id, order, text, gate: gateId, target: `${id} target`, status: "pending", ...extra };
}

function capsule(comments, overrides = {}, inputs = {}) {
  return createTaskCapsule({
    task: task(overrides),
    comments,
    attachments: [],
    currentClaim: null,
    now: new Date("2026-08-26T01:00:00.000Z"),
    ...inputs,
  });
}

test("projects pending handoff acknowledgements with deterministic latest-event ordering", () => {
  const event = (eventId, requiresAck, acknowledgements = []) => ({
    eventId,
    createdAt: "2026-08-26T00:30:00.000Z",
    envelope: {
      timestamp: "2026-08-26T00:20:00.000Z",
      requiresAck,
    },
    acknowledgements,
  });
  const olderId = event("handoff-a", true);
  const latestId = event("handoff-b", true, [{ acknowledgementId: "ack-b" }]);
  const result = capsule([], {}, { coordinationEvents: [olderId, latestId] });
  const acknowledged = capsule([], {}, {
    coordinationEvents: [
      { ...olderId, acknowledgements: [{ acknowledgementId: "ack-a" }] },
      latestId,
    ],
  });

  assert.equal(result.handoffs.pendingAcknowledgementCount, 1);
  assert.deepEqual(result.handoffs.latestEvent, latestId);
  assert.equal(acknowledged.handoffs.pendingAcknowledgementCount, 0);
  assert.notEqual(result.resumeToken, acknowledged.resumeToken);
});

test("authorized local work stays ready while push approval is deferred", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [
      gate("local", "edit", "authorized", { evidence: "Owner resumed local work", receipt: "turn:resume" }),
      gate("push", "push", "approval_required", { approver: "Owner", approvalRequest: "同意推送 Capstone exact commit" }),
    ],
    actions: [
      action("verify-demo", 10, "local", "Run the local authenticated Demo acceptance"),
      action("push-head", 20, "push", "Push the exact reviewed commit"),
    ],
  }))]);

  assert.equal(result.readyWork.eligible, true);
  assert.deepEqual(result.readyWork.safeActions.map((item) => item.id), ["verify-demo"]);
  assert.deepEqual(result.readyWork.deferredActions.map((item) => item.id), ["push-head"]);
  assert.equal(result.readyWork.approvalRequest, null);
  assert.equal(result.readyWork.nextAction.text, "Run the local authenticated Demo acceptance");
});

test("one deterministic approval request is emitted after safe work is exhausted", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [
      gate("push", "push", "approval_required", { approver: "Owner", approvalRequest: "同意推送 exact commit" }),
      gate("deploy", "deploy", "approval_required", { approver: "Owner", approvalRequest: "同意部署 exact commit" }),
    ],
    actions: [
      action("deploy", 20, "deploy", "Deploy the reviewed commit"),
      action("push", 10, "push", "Push the reviewed commit"),
    ],
  }))]);

  assert.equal(result.readyWork.eligible, false);
  assert.deepEqual(result.readyWork.safeActions, []);
  assert.equal(result.readyWork.approvalRequest.actionId, "push");
  assert.equal(result.readyWork.approvalRequest.message, "同意推送 exact commit");
  assert.match(result.readyWork.approvalRequest.expectedResumeToken, /^[a-f0-9]{64}$/);
  assert.equal(result.readyWork.approvalRequest.expectedResumeToken, result.resumeToken);
});

test("structural blockers suppress approval requests", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [gate("push", "push", "approval_required", { approver: "Owner", approvalRequest: "同意推送" })],
    actions: [action("push", 10, "push", "Push")],
  }))], { threadBinding: null, legacyLocalThreadId: "legacy-root" });

  assert.equal(result.readyWork.eligible, false);
  assert.match(result.readyWork.reasonCodes.join(","), /LEGACY_THREAD_BINDING_ONLY/);
  assert.equal(result.readyWork.approvalRequest, null);
  assert.deepEqual(result.readyWork.nextAction, {
    text: "将 legacy Root thread 迁移为带 host、project 和 workspace 的确认绑定，然后重新生成 Capsule。",
    source: { type: "structural_blocker", reasonCode: "LEGACY_THREAD_BINDING_ONLY" },
  });
});

test("duplicate or malformed authorization envelopes fail closed", () => {
  const valid = envelopeComment(envelope({
    gates: [gate("local", "edit", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 10, "local", "Test")],
  }));
  const duplicate = envelopeComment(JSON.parse(valid.body.match(/```json\n(.+)\n```/s)[1]), {
    id: "comment-envelope-2",
    createdAt: "2026-08-26T00:02:00.000Z",
    updatedAt: "2026-08-26T00:02:00.000Z",
  });
  const duplicated = capsule([valid, duplicate]);
  assert.equal(duplicated.readyWork.eligible, false);
  assert.deepEqual(duplicated.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);
  assert.equal(duplicated.readyWork.approvalRequest, null);
  assert.deepEqual(duplicated.readyWork.nextAction, {
    text: "修复无效的 Task Authorization Envelope V1；在验证通过前不要派发工作或请求 Owner 授权。",
    source: { type: "structural_blocker", reasonCode: "AUTHORIZATION_ENVELOPE_INVALID" },
  });

  const malformed = capsule([envelopeComment({
    gates: [gate("mystery", "unknown-kind", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 10, "mystery", "Test")],
  })]);
  assert.equal(malformed.readyWork.eligible, false);
  assert.deepEqual(malformed.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);
});

test("a complete user envelope can explicitly supersede retained invalid history", () => {
  const retainedInvalid = envelopeComment(envelope({
    gates: [{
      id: "local", kind: "test", state: "authorized", scope: "local tests",
      evidence: "historical agent claim", receipt: "historical:invalid",
    }],
    actions: [action("old-test", 10, "local", "Old test action")],
  }), {
    id: "comment-envelope-old",
    authorType: "agent",
    authorId: "codex-agent",
    authorName: "Codex Agent",
  });
  const replacement = envelopeComment(envelope({
    supersedesCommentIds: [retainedInvalid.id],
    gates: [gate("local", "test", "authorized", {
      evidence: "Owner approved local validation",
      receipt: "turn:local-validation",
    })],
    actions: [action("test", 10, "local", "Run local validation")],
  }), {
    id: "comment-envelope-replacement",
    createdAt: "2026-08-26T00:03:00.000Z",
    updatedAt: "2026-08-26T00:03:00.000Z",
  });

  const result = capsule([retainedInvalid, replacement]);
  assert.equal(result.authorization.state, "valid");
  assert.deepEqual(result.authorization.source, {
    commentId: replacement.id,
    commentVersion: replacement.version,
  });
  assert.deepEqual(result.readyWork.safeActions.map((item) => item.id), ["test"]);

  const unknownHistory = capsule([envelopeComment(envelope({
    supersedesCommentIds: ["missing-comment"],
    gates: [gate("local", "test", "authorized", {
      evidence: "Owner approved local validation",
      receipt: "turn:local-validation",
    })],
    actions: [action("test", 10, "local", "Run local validation")],
  }))]);
  assert.equal(unknownHistory.authorization.state, "invalid");

  const userAuthorized = envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", {
      evidence: "Owner approved local validation",
      receipt: "turn:owner-approved",
    })],
    actions: [action("test", 10, "local", "Run local validation")],
  }), { id: "comment-envelope-user-authorized" });
  const approvalReplacement = envelope({
    supersedesCommentIds: [userAuthorized.id],
    gates: [gate("local", "test", "approval_required", {
      approver: "Owner",
      approvalRequest: "请重新批准本地验证",
    })],
    actions: [action("test", 10, "local", "Run local validation")],
  });
  const agentReplacement = capsule([
    userAuthorized,
    envelopeComment(approvalReplacement, {
      id: "comment-envelope-agent-replacement",
      authorType: "agent",
      authorId: "codex-agent",
      authorName: "Codex Agent",
      createdAt: "2026-08-26T00:04:00.000Z",
      updatedAt: "2026-08-26T00:04:00.000Z",
    }),
  ]);
  assert.equal(agentReplacement.authorization.state, "invalid");

  const wrongThreadReplacement = capsule([
    userAuthorized,
    envelopeComment(approvalReplacement, {
      id: "comment-envelope-wrong-thread-replacement",
      threadId: "other-root-thread",
      createdAt: "2026-08-26T00:04:00.000Z",
      updatedAt: "2026-08-26T00:04:00.000Z",
    }),
  ]);
  assert.equal(wrongThreadReplacement.authorization.state, "invalid");
});

test("legacy thread binding is repaired before an invalid authorization envelope", () => {
  const valid = envelopeComment(envelope({
    gates: [gate("local", "edit", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 10, "local", "Test")],
  }));
  const duplicate = envelopeComment(JSON.parse(valid.body.match(/```json\n(.+)\n```/s)[1]), {
    id: "comment-envelope-2",
    createdAt: "2026-08-26T00:02:00.000Z",
    updatedAt: "2026-08-26T00:02:00.000Z",
  });
  const result = capsule([valid, duplicate], {
    threadBinding: null,
    legacyLocalThreadId: "legacy-root",
  });

  assert.match(result.readyWork.reasonCodes.join(","), /LEGACY_THREAD_BINDING_ONLY/);
  assert.match(result.readyWork.reasonCodes.join(","), /AUTHORIZATION_ENVELOPE_INVALID/);
  assert.equal(result.readyWork.approvalRequest, null);
  assert.deepEqual(result.readyWork.nextAction, {
    text: "将 legacy Root thread 迁移为带 host、project 和 workspace 的确认绑定，然后重新生成 Capsule。",
    source: { type: "structural_blocker", reasonCode: "LEGACY_THREAD_BINDING_ONLY" },
  });
});

test("resolved authorization gates preserve their complete audit lifecycle", () => {
  const authorized = gate("local", "test", "authorized", {
    evidence: "Owner approved the bounded test",
    receipt: "turn:test-approved",
  });
  const { approver: _authorizedApprover, ...authorizedWithoutApprover } = authorized;
  const denied = gate("push", "push", "denied", {
    evidence: "Owner denied the push",
    receipt: "turn:push-denied",
  });
  const { approvalRequest: _deniedRequest, ...deniedWithoutRequest } = denied;
  const forbidden = gate("deploy", "deploy", "forbidden", {
    evidence: "Policy forbids deployment in this lane",
    receipt: "policy:local-only",
  });
  const { receipt: _forbiddenReceipt, ...forbiddenWithoutReceipt } = forbidden;

  for (const incompleteGate of [
    authorizedWithoutApprover,
    deniedWithoutRequest,
    forbiddenWithoutReceipt,
  ]) {
    const result = capsule([envelopeComment(envelope({
      gates: [incompleteGate],
      actions: [action("guarded", 10, incompleteGate.id, "Guarded action")],
    }))]);
    assert.equal(result.authorization.state, "invalid");
    assert.deepEqual(result.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);
  }

  const complete = capsule([envelopeComment(envelope({
    gates: [authorized, denied, forbidden],
    actions: [
      action("test", 10, "local", "Test"),
      action("push", 20, "push", "Push"),
      action("deploy", 30, "deploy", "Deploy"),
    ],
  }))]);
  assert.equal(complete.authorization.state, "valid");

  const missingRenewalPolicy = capsule([envelopeComment(envelope({
    gates: [gate("bounded", "test", "authorized", {
      evidence: "Owner approved a bounded test",
      receipt: "turn:bounded-test",
      expiresAt: "2026-08-26T02:00:00.000Z",
    })],
    actions: [action("bounded-test", 10, "bounded", "Run bounded test")],
  }))]);
  assert.equal(missingRenewalPolicy.authorization.state, "invalid");
});

test("checkpoint prose that mentions the envelope name is not parsed as an envelope", () => {
  const prose = envelopeComment({ unexpected: true }, {
    id: "checkpoint",
    body: "Agent Checkpoint\nNext action: implement the Task Authorization Envelope V1 design and tests.",
  });
  const valid = envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 10, "local", "Test")],
  }));
  const result = capsule([prose, valid]);
  assert.equal(result.authorization.state, "valid");
  assert.equal(result.readyWork.eligible, true);
});

test("a standalone envelope marker without a JSON body fails closed", () => {
  const result = capsule([envelopeComment({}, {
    body: "Agent Checkpoint\n\nTask Authorization Envelope V1\n\nJSON pending",
  })]);
  assert.equal(result.authorization.state, "invalid");
  assert.deepEqual(result.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);
});

test("duplicate JSON keys and two envelope blocks fail closed", () => {
  const duplicateKey = capsule([envelopeComment({}, {
    body: "Task Authorization Envelope V1\n\n```json\n{\"gates\":[{\"id\":\"push\",\"kind\":\"push\",\"state\":\"denied\",\"state\":\"authorized\",\"scope\":\"push\",\"evidence\":\"fake\",\"receipt\":\"fake\"}],\"actions\":[{\"id\":\"push\",\"order\":1,\"text\":\"Push\",\"gate\":\"push\",\"target\":\"origin\",\"status\":\"pending\"}]}\n```",
  })]);
  assert.deepEqual(duplicateKey.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);

  const block = envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 1, "local", "Test")],
  })).body;
  const twoBlocks = capsule([envelopeComment({}, { body: `${block}\n\n${block}` })]);
  assert.deepEqual(twoBlocks.readyWork.reasonCodes, ["AUTHORIZATION_ENVELOPE_INVALID"]);
});

test("empty or fully completed authorization frontiers are never dispatchable", () => {
  const empty = capsule([envelopeComment(envelope({ gates: [], actions: [] }))]);
  assert.equal(empty.readyWork.eligible, false);
  assert.deepEqual(empty.readyWork.reasonCodes, ["AUTHORIZATION_ACTIONS_EXHAUSTED"]);

  const completed = capsule([envelopeComment(envelope({
    gates: [gate("push", "push", "approval_required", { approver: "Owner", approvalRequest: "同意推送" })],
    actions: [action("push", 1, "push", "Push", { status: "completed" })],
  }))]);
  assert.equal(completed.readyWork.eligible, false);
  assert.deepEqual(completed.readyWork.reasonCodes, ["AUTHORIZATION_ACTIONS_EXHAUSTED"]);
  assert.equal(completed.readyWork.approvalRequest, null);
});

test("envelope comment version changes the resume token", () => {
  const value = envelope({
    gates: [gate("local", "test", "authorized", { evidence: "ok", receipt: "receipt" })],
    actions: [action("test", 10, "local", "Test")],
  });
  const first = capsule([envelopeComment(value)]);
  const second = capsule([envelopeComment(value, { version: 2 })]);
  assert.notEqual(first.resumeToken, second.resumeToken);
});

test("expired authorization asks for renewal only after safe work is exhausted", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", {
      evidence: "Owner approved a bounded window",
      receipt: "turn:bounded",
      expiresAt: "2026-08-26T00:30:00.000Z",
      renewable: true,
      approver: "Owner",
      approvalRequest: "重新授权本地验收",
    })],
    actions: [action("test", 10, "local", "Run local acceptance")],
  }))]);

  assert.equal(result.readyWork.eligible, false);
  assert.deepEqual(result.readyWork.safeActions, []);
  assert.equal(result.readyWork.approvalRequest?.message, "重新授权本地验收");
  assert.match(result.readyWork.reasonCodes.join(","), /AUTHORIZATION_REQUIRED/);
});

test("an expired non-renewable authorization becomes forbidden", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", {
      evidence: "Owner approved one bounded test window",
      receipt: "turn:one-window",
      expiresAt: "2026-08-26T00:30:00.000Z",
      renewable: false,
    })],
    actions: [action("test", 10, "local", "Run local acceptance")],
  }))]);

  assert.equal(result.authorization.state, "valid");
  assert.equal(result.readyWork.eligible, false);
  assert.deepEqual(result.readyWork.reasonCodes, ["AUTHORIZATION_FORBIDDEN"]);
  assert.equal(result.readyWork.approvalRequest, null);
});

test("denied authorization remains deferred without inventing an approval request", () => {
  const result = capsule([envelopeComment(envelope({
    gates: [gate("deploy", "deploy", "denied", {
      approver: "Owner",
      evidence: "Owner denied deployment",
      receipt: "turn:deny",
    })],
    actions: [action("deploy", 10, "deploy", "Deploy")],
  }))]);

  assert.equal(result.readyWork.eligible, false);
  assert.equal(result.readyWork.approvalRequest, null);
  assert.match(result.readyWork.reasonCodes.join(","), /AUTHORIZATION_DENIED/);
});

test("authorization evidence changes the resume token even before comment persistence increments", () => {
  const first = capsule([envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", { evidence: "first", receipt: "receipt-1" })],
    actions: [action("test", 10, "local", "Test")],
  }))]);
  const second = capsule([envelopeComment(envelope({
    gates: [gate("local", "test", "authorized", { evidence: "second", receipt: "receipt-2" })],
    actions: [action("test", 10, "local", "Test")],
  }))]);
  assert.notEqual(first.resumeToken, second.resumeToken);
});

test("an Agent or wrong thread cannot record its own authorization decision", () => {
  const value = envelope({
    gates: [gate("deploy", "deploy", "authorized", { evidence: "invented", receipt: "invented" })],
    actions: [action("deploy", 10, "deploy", "Deploy")],
  });
  const agent = capsule([envelopeComment(value, {
    authorType: "agent",
    authorId: "subagent",
    authorName: "Sub-Agent",
  })]);
  assert.equal(agent.authorization.state, "invalid");
  assert.equal(agent.readyWork.eligible, false);

  const wrongThread = capsule([envelopeComment(value, { threadId: "subagent-thread" })]);
  assert.equal(wrongThread.authorization.state, "invalid");
  assert.equal(wrongThread.readyWork.eligible, false);

  const agentForbidden = capsule([envelopeComment(envelope({
    gates: [gate("deploy", "deploy", "forbidden", {
      evidence: "Agent invented a prohibition",
      receipt: "invented:forbidden",
    })],
    actions: [action("deploy", 10, "deploy", "Deploy")],
  }), {
    authorType: "agent",
    authorId: "codex-agent",
    authorName: "Codex Agent",
  })]);
  assert.equal(agentForbidden.authorization.state, "invalid");
  assert.equal(agentForbidden.readyWork.eligible, false);
});
