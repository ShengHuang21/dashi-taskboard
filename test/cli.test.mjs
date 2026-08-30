import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { main, parseArgs } from "../cli/taskctl.mjs";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    json() { return JSON.parse(value); },
    text() { return value; },
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(argv, fetchImplementation, overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    fetch: fetchImplementation,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { CODEX_THREAD_ID: "thread-current" },
    ...overrides,
  });
  return {
    exitCode,
    stdout: exitCode === 0 ? stdout.json() : null,
    stderr: exitCode === 0 ? null : stderr.json(),
  };
}

test("parseArgs supports equals syntax and boolean --json", () => {
  assert.deepEqual(parseArgs(["issue", "list", "--project=local", "--json"]), {
    resource: "issue",
    action: "list",
    operands: [],
    options: { project: "local", json: true },
  });
});

test("built-in help leads fresh windows through complete Capsule bootstrap", async () => {
  for (const argv of [["--help"], ["issue", "--help"]]) {
    const stdout = capture();
    const exitCode = await main(argv, {
      stdout: stdout.stream,
      stderr: capture().stream,
      fetch: async () => assert.fail("help must not call the service"),
    });

    assert.equal(exitCode, 0);
    assert.match(stdout.text(), /taskctl issue bootstrap LOCAL-275 --json/);
    assert.doesNotMatch(stdout.text(), /taskctl issue get LOCAL-275 --json/);
  }
});

test("project list uses the default local service and adds schemaVersion", async () => {
  const calls = [];
  const result = await run(["project", "list"], async (url, init) => {
    calls.push({ url: url.toString(), init });
    return response({ projects: [{ id: "local", name: "Local" }] });
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, {
    projects: [{ id: "local", name: "Local" }],
    schemaVersion: 2,
  });
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/projects");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "taskctl");
});

test("standing authority CLI normalizes a narrow grant and supports list and revoke", async () => {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url: url.toString(), init, body: init.body ? JSON.parse(init.body) : null });
    return response({ ok: true });
  };

  const grant = await run([
    "authority", "grant", "personal",
    "--repository", "HTTPS://GitHub.com/Owner/Repo.git",
    "--actions", "edit,test,ordinary_push,draft_pr",
    "--source-task", "CAP-8",
    "--source-thread-id", "root-thread",
    "--evidence", "Owner standing instruction",
    "--receipt", "owner-turn:1",
    "--granted-at", "2026-08-30T00:00:00.000Z",
  ], fetchImplementation);
  assert.equal(grant.exitCode, 0);
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/projects/personal/standing-authorities");
  assert.deepEqual(calls[0].body, {
    repository: "github.com/owner/repo",
    actions: ["draft_pr", "edit", "ordinary_push", "test"],
    sourceTaskId: "CAP-8",
    sourceThreadId: "root-thread",
    evidence: "Owner standing instruction",
    receipt: "owner-turn:1",
    grantedAt: "2026-08-30T00:00:00.000Z",
  });

  assert.equal((await run(["authority", "list", "personal"], fetchImplementation)).exitCode, 0);
  assert.equal(calls[1].init.method, "GET");
  assert.equal((await run([
    "authority", "revoke", "personal", "authority-1",
    "--evidence", "Owner revoked it",
    "--receipt", "owner-turn:2",
  ], fetchImplementation)).exitCode, 0);
  assert.equal(calls[2].url, "http://127.0.0.1:47823/api/projects/personal/standing-authorities/authority-1/revoke");
});

test("standing authority CLI rejects unknown and duplicate actions before network access", async () => {
  let called = false;
  for (const actions of ["edit,deploy", "edit,edit"]) {
    const result = await run([
      "authority", "grant", "personal",
      "--repository", "github.com/owner/repo",
      "--actions", actions,
      "--source-task", "CAP-8",
      "--source-thread-id", "root-thread",
      "--evidence", "Owner standing instruction",
      "--receipt", "owner-turn:1",
      "--granted-at", "2026-08-30T00:00:00.000Z",
    ], async () => { called = true; return response({}); });
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr.error.code, "USAGE_ERROR");
  }
  assert.equal(called, false);
});

test("Owner decisions cannot be forged through taskctl", async () => {
  let called = false;
  const result = await run(["decision", "record", "CAP-10"], async () => {
    called = true;
    return response({});
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr.error.code, "USAGE_ERROR");
  assert.equal(called, false);
});

test("CODEX_TASKBOARD_URL overrides the service origin", async () => {
  let requestedUrl;
  const result = await run(
    ["project", "list", "--json"],
    async (url) => {
      requestedUrl = url;
      return response({ projects: [] });
    },
    { env: { CODEX_TASKBOARD_URL: "https://tasks.example.test/" } },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.toString(), "https://tasks.example.test/api/projects");
});

test("--runtime-file reads the launcher endpoint without a leading environment assignment", async () => {
  let requestedUrl;
  const result = await run(
    ["project", "list", "--runtime-file", "/tmp/taskboard-runtime.json"],
    async (url) => {
      requestedUrl = url;
      return response({ projects: [] });
    },
    {
      env: {},
      readFile: async (filePath) => {
        assert.equal(filePath, "/tmp/taskboard-runtime.json");
        return JSON.stringify({ version: 1, url: "http://127.0.0.1:51550/token" });
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.toString(), "http://127.0.0.1:51550/token/api/projects");
});

test("project create sends id, name, and an absolute workspace path", async () => {
  let requestBody;
  const result = await run(
    ["project", "create", "--id", "docs", "--name", "Docs", "--workspace-path", "./docs"],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ project: { id: "docs", name: "Docs" } }, 201);
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestBody.id, "docs");
  assert.equal(requestBody.name, "Docs");
  assert.equal(requestBody.workspacePath, path.resolve("./docs"));
});

test("issue list serializes project and status filters", async () => {
  let requestedUrl;
  const result = await run(
    ["issue", "list", "--project", "local", "--status", "todo"],
    async (url) => {
      requestedUrl = url;
      return response({ tasks: [] });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.searchParams.get("projectId"), "local");
  assert.equal(requestedUrl.searchParams.get("status"), "todo");
});

test("issue bootstrap recovers the complete Task Capsule through one direct request", async () => {
  const capsule = {
    task: { identifier: "TASK/1", version: 7 },
    comments: [{ id: "comment-1" }],
    attachments: [{ id: "attachment-1" }],
    inbox: { pendingCount: 1, latestReceipt: { id: "delivery-1" } },
    handoffs: { pendingAcknowledgementCount: 1, latestEvent: { eventId: "handoff-1" } },
    resumeToken: "a".repeat(64),
  };
  let request;
  const result = await run(["issue", "bootstrap", "TASK/1"], async (url, init) => {
    request = { url, init };
    return response({ capsule });
  });

  assert.equal(result.exitCode, 0);
  assert.equal(request.url.pathname, "/api/tasks/TASK%2F1/capsule");
  assert.equal(request.init.method, "GET");
  assert.deepEqual(result.stdout.capsule, capsule);
});

test("issue commands accept in-review, blocked, and canceled statuses", async () => {
  for (const status of ["in_review", "blocked", "canceled"]) {
    let requestedUrl;
    const listResult = await run(["issue", "list", "--status", status], async (url) => {
      requestedUrl = url;
      return response({ tasks: [] });
    });
    assert.equal(listResult.exitCode, 0);
    assert.equal(requestedUrl.searchParams.get("status"), status);
  }

  let createBody;
  const createResult = await run(
    ["issue", "create", "--project", "local", "--title", "Review me", "--status", "in_review"],
    async (_url, init) => {
      createBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...createBody, version: 1 } }, 201);
    },
  );
  assert.equal(createResult.exitCode, 0);
  assert.equal(createBody.status, "in_review");

  let moveBody;
  const moveResult = await run(
    ["issue", "move", "TASK-1", "--status", "blocked", "--if-version", "1"],
    async (_url, init) => {
      moveBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", status: "blocked", version: 2 } });
    },
  );
  assert.equal(moveResult.exitCode, 0);
  assert.equal(moveBody.status, "blocked");

  let updateBody;
  const updateResult = await run(
    ["issue", "update", "TASK-1", "--status", "canceled", "--if-version", "2"],
    async (_url, init) => {
      updateBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", status: "canceled", version: 3 } });
    },
  );
  assert.equal(updateResult.exitCode, 0);
  assert.equal(updateBody.status, "canceled");
});

test("invalid status errors list every accepted status", async () => {
  const result = await run(
    ["issue", "list", "--status", "started"],
    async () => assert.fail("fetch should not be called"),
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.error.message, /in_review/);
  assert.match(result.stderr.error.message, /blocked/);
  assert.match(result.stderr.error.message, /canceled/);
});

test("issue create reads a description file and parses labels", async () => {
  let requestBody;
  const result = await run(
    [
      "issue",
      "create",
      "--project",
      "local",
      "--title",
      "Fix auth",
      "--description-file",
      "issue.md",
      "--labels",
      "bug, auth,bug",
    ],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...requestBody, version: 1 } }, 201);
    },
    { readFile: async () => "Acceptance criteria" },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    projectId: "local",
    title: "Fix auth",
    description: "Acceptance criteria",
    status: "backlog",
    priority: "none",
    labels: ["bug", "auth"],
    threadId: "thread-current",
  });
});

test("issue update sends an explicit optimistic concurrency version", async () => {
  const calls = [];
  const result = await run(
    ["issue", "update", "TASK/1", "--title", "New title", "--if-version", "7"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ task: { id: "TASK/1", title: "New title", version: 8 } });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "New title",
    version: 7,
  });
});

test("issue create and update accept an explicit workflow profile", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response({ task: { id: "TASK-1", version: bodies.length } }, bodies.length === 1 ? 201 : 200);
  };
  const created = await run([
    "issue", "create", "--project", "local", "--title", "Personal skill", "--workflow-profile", "vibe",
  ], fetchImpl);
  const updated = await run([
    "issue", "update", "TASK-1", "--workflow-profile", "formal", "--if-version", "1",
  ], fetchImpl);

  assert.equal(created.exitCode, 0);
  assert.equal(updated.exitCode, 0);
  assert.equal(bodies[0].workflowProfile, "vibe");
  assert.deepEqual(bodies[1], { workflowProfile: "formal", version: 1 });
});

test("issue update binds one worktree context", async () => {
  let requestBody;
  const repositoryPath = path.resolve("/work/repo");
  const worktreePath = path.resolve(repositoryPath, "../taskboard-worktree");
  const result = await run(
    [
      "issue", "update", "TASK-1",
      "--worktree-path", "../taskboard-worktree",
      "--worktree-branch", "worktree/taskboard",
      "--if-version", "4",
    ],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...requestBody, version: 5 } });
    },
    { cwd: repositoryPath },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    developmentContext: {
      type: "worktree",
      path: worktreePath,
      branch: "worktree/taskboard",
    },
    version: 4,
  });
});

test("issue update rejects simultaneous branch and worktree bindings", async () => {
  let called = false;
  const result = await run(
    ["issue", "update", "TASK-1", "--git-branch", "feature/taskboard", "--worktree-path", "../taskboard-worktree"],
    async () => {
      called = true;
      return response({});
    },
    { cwd: "/work/repo" },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, false);
  assert.match(result.stderr.error.message, /either --git-branch or --worktree-path/);
});

test("issue move fetches the current version when --if-version is omitted", async () => {
  const calls = [];
  const result = await run(["issue", "move", "TASK-1", "--status", "done"], async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return response({ task: { id: "TASK-1", version: 3 } });
    return response({ task: { id: "TASK-1", status: "done", version: 4 } });
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    status: "done",
    threadId: "thread-current",
    version: 3,
  });
});

test("issue move separates controller attribution from the task thread binding", async () => {
  let requestBody;
  const windowsWorkspacePath = String.raw`C:\Users\admin\Documents\dashi-taskboard`;
  const result = await run([
    "issue", "move", "TASK-1", "--status", "blocked", "--if-version", "3",
    "--binding-thread-id", "remote-thread",
    "--binding-codex-project-id", "remote-project",
    "--binding-codex-project-kind", "remote",
    "--binding-codex-host-id", "remote-host",
    "--binding-workspace-path", windowsWorkspacePath,
  ], async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return response({ task: { id: "TASK-1", version: 4 } });
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    status: "blocked",
    threadId: "thread-current",
    threadBinding: {
      threadId: "remote-thread",
      codexProjectId: "remote-project",
      codexProjectKind: "remote",
      codexHostId: "remote-host",
      workspacePath: windowsWorkspacePath,
    },
    version: 3,
  });
});

test("issue move can clear an unconfirmed task binding", async () => {
  let requestBody;
  const result = await run([
    "issue", "move", "TASK-1", "--status", "todo", "--if-version", "3",
    "--clear-binding-thread",
  ], async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return response({ task: { id: "TASK-1", version: 4 } });
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    status: "todo",
    threadId: "thread-current",
    threadBinding: null,
    version: 3,
  });
});

test("Root Sub-Agent claims a real To-Do with durable identity", async () => {
  const calls = [];
  const result = await run([
    "issue", "claim", "TASK-1", "--agent-path", "/root/review",
    "--thread-id", "agent-thread", "--if-version", "3",
    "--lease-minutes", "30", "--write-scope", "server/database.mjs,test/cli.test.mjs",
  ], async (url, init) => {
    calls.push({ url, init });
    return response({ task: { id: "TASK-1", status: "in_progress", version: 4 } });
  });

  assert.equal(result.exitCode, 0);
  assert.equal(String(calls[0].url), "http://127.0.0.1:47823/api/tasks/TASK-1/claim");
  const claimBody = JSON.parse(calls[0].init.body);
  assert.match(claimBody.leaseExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...claimBody, leaseExpiresAt: "future" }, {
    agentPath: "/root/review",
    agentThreadId: "agent-thread",
    leaseExpiresAt: "future",
    writeScope: ["server/database.mjs", "test/cli.test.mjs"],
    version: 3,
  });
});

test("run commands use durable lifecycle endpoints and agent thread attribution", async () => {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url, init });
    return response({ run: { id: "RUN/1", version: 2 }, task: { id: "TASK-1" }, applied: true });
  };

  const checkpoint = await run(
    [
      "run", "checkpoint", "RUN/1", "--summary", "Checkpoint", "--next-action", "Resume",
      "--status", "blocked", "--if-version", "1",
    ],
    fetchImplementation,
  );
  const finish = await run(
    [
      "run", "finish", "RUN/1", "--status", "completed", "--summary", "Finished",
      "--next-action", "Review", "--if-version", "2",
    ],
    fetchImplementation,
  );
  const get = await run(["run", "get", "RUN/1"], fetchImplementation);

  assert.equal(checkpoint.exitCode, 0);
  assert.equal(finish.exitCode, 0);
  assert.equal(get.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/runs/RUN%2F1/checkpoint");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agentThreadId: "thread-current",
    summary: "Checkpoint",
    nextAction: "Resume",
    status: "blocked",
    version: 1,
  });
  assert.equal(calls[1].url.pathname, "/api/runs/RUN%2F1/finish");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    agentThreadId: "thread-current",
    summary: "Finished",
    nextAction: "Review",
    status: "completed",
    version: 2,
  });
  assert.equal(calls[2].url.pathname, "/api/runs/RUN%2F1");
  assert.equal(calls[2].init.method, "GET");
});

test("handoff commands append, replay, and acknowledge structured coordination events", async () => {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return response({ events: [] });
    if (url.pathname.endsWith("/acknowledgements")) {
      return response({ applied: true, acknowledgement: { id: "ack-receipt-1" } }, 201);
    }
    return response({ applied: true, event: { eventId: "handoff-1" } }, 201);
  };

  const add = await run([
    "handoff", "add", "TASK/1",
    "--event-id", "handoff-1",
    "--idempotency-key", "handoff-key-1",
    "--agent-path", "/root/backend",
    "--sequence", "3",
    "--timestamp", "2026-08-29T05:00:00.000Z",
    "--summary", "Backend complete",
    "--evidence-ref", "test/server.test.mjs#handoff,artifact://focused-result",
    "--next-action", "Root reviews evidence",
    "--requires-ack", "true",
    "--causation-id", "claim-1",
    "--correlation-id", "feature-1",
  ], fetchImplementation);
  const list = await run(["handoff", "list", "TASK/1"], fetchImplementation);
  const ack = await run([
    "handoff", "ack", "handoff-1",
    "--acknowledgement-id", "root-ack-1",
    "--agent-path", "/root",
  ], fetchImplementation);

  assert.equal(add.exitCode, 0);
  assert.equal(list.exitCode, 0);
  assert.equal(ack.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1/coordination-events");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eventId: "handoff-1",
    idempotencyKey: "handoff-key-1",
    parentTaskId: null,
    senderThreadId: "thread-current",
    senderAgentPath: "/root/backend",
    eventType: "handoff",
    sequence: 3,
    timestamp: "2026-08-29T05:00:00.000Z",
    summary: "Backend complete",
    evidenceRefs: ["test/server.test.mjs#handoff", "artifact://focused-result"],
    blocker: null,
    nextAction: "Root reviews evidence",
    requiresAck: true,
    causationId: "claim-1",
    correlationId: "feature-1",
  });
  assert.equal(calls[1].url.pathname, "/api/tasks/TASK%2F1/coordination-events");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[2].url.pathname, "/api/coordination-events/handoff-1/acknowledgements");
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    acknowledgementId: "root-ack-1",
    senderThreadId: "thread-current",
    senderAgentPath: "/root",
  });
});

test("handoff commands reject unsafe acknowledgement and boolean shapes before fetch", async () => {
  const neverFetch = async () => assert.fail("fetch should not be called");
  const invalidAck = await run([
    "handoff", "ack", "handoff-1",
    "--acknowledgement-id", "root-ack-1",
    "--agent-path", "/root/backend",
  ], neverFetch);
  const invalidBoolean = await run([
    "handoff", "add", "TASK-1",
    "--event-id", "handoff-1",
    "--idempotency-key", "handoff-key-1",
    "--agent-path", "/root/backend",
    "--sequence", "1",
    "--summary", "Backend complete",
    "--next-action", "Root reviews evidence",
    "--requires-ack", "yes",
  ], neverFetch);

  assert.equal(invalidAck.exitCode, 2);
  assert.match(invalidAck.stderr.error.message, /must be \/root/);
  assert.equal(invalidBoolean.exitCode, 2);
  assert.match(invalidBoolean.stderr.error.message, /must be true or false/);
});

test("issue update rebinds only with explicit binding identity", async () => {
  let requestBody;
  const result = await run(
    [
      "issue", "update", "TASK-1", "--title", "Rebound", "--if-version", "2",
      "--binding-thread-id", "thread-9",
      "--binding-codex-project-id", "project-9",
      "--binding-codex-project-kind", "local",
      "--binding-codex-host-id", "local",
      "--binding-workspace-path", "/work/rebound",
    ],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", threadBinding: requestBody.threadBinding, version: 3 } });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    title: "Rebound",
    threadBinding: {
      threadId: "thread-9",
      codexProjectId: "project-9",
      codexProjectKind: "local",
      codexHostId: "local",
      workspacePath: "/work/rebound",
    },
    version: 2,
  });
  assert.equal(result.stdout.task.threadBinding.threadId, "thread-9");
});

test("issue restore uses the mutation thread and optimistic version", async () => {
  let requestBody;
  const result = await run(
    ["issue", "restore", "TASK-1", "--if-version", "5"],
    async (url, init) => {
      assert.equal(url.pathname, "/api/tasks/TASK-1/restore");
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", threadId: "thread-current", version: 6 } });
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, { threadId: "thread-current", version: 5 });
});

test("issue relation add and remove use typed relation endpoints", async () => {
  const calls = [];
  const addResult = await run(
    [
      "issue", "relation", "add", "TASK/1",
      "--type", "blocked_by",
      "--issue", "TASK/2",
      "--if-version", "4",
    ],
    async (url, init) => {
      calls.push({ url, init });
      return response({
        task: { id: "TASK/1", version: 5 },
        relatedTask: { id: "TASK/2", version: 2 },
      });
    },
  );
  const removeResult = await run(
    [
      "issue", "relation", "remove", "TASK/1",
      "--type", "related",
      "--issue", "TASK/3",
      "--if-version", "5",
    ],
    async (url, init) => {
      calls.push({ url, init });
      return response({
        task: { id: "TASK/1", version: 6 },
        relatedTask: { id: "TASK/3", version: 1 },
      });
    },
  );

  assert.equal(addResult.exitCode, 0);
  assert.equal(removeResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1/relations/blocked_by/TASK%2F2");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    threadId: "thread-current",
    version: 4,
  });
  assert.equal(calls[1].url.pathname, "/api/tasks/TASK%2F1/relations/related/TASK%2F3");
  assert.equal(calls[1].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    threadId: "thread-current",
    version: 5,
  });
});

test("issue relation validates its action and relation type before fetching", async () => {
  for (const argv of [
    ["issue", "relation", "replace", "TASK-1", "--type", "related", "--issue", "TASK-2"],
    ["issue", "relation", "add", "TASK-1", "--type", "duplicate", "--issue", "TASK-2"],
    ["issue", "relation", "add", "TASK-1", "--type", "related"],
  ]) {
    const result = await run(argv, async () => assert.fail("fetch should not be called"));
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr.error.code, "USAGE_ERROR");
  }
});

test("comment list and add use the issue comments endpoint", async () => {
  const calls = [];
  const listResult = await run(["comment", "list", "TASK/1"], async (url, init) => {
    calls.push({ url, init });
    return response({ comments: [] });
  });
  const addResult = await run(
    ["comment", "add", "TASK/1", "--body", "Verified locally"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ comment: { id: "comment-1", body: "Verified locally", version: 1 } }, 201);
    },
  );

  assert.equal(listResult.exitCode, 0);
  assert.equal(addResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1/comments");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url.pathname, "/api/tasks/TASK%2F1/comments");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    body: "Verified locally",
    threadId: "thread-current",
  });
});

test("comment update and delete require an explicit version", async () => {
  const calls = [];
  const updateResult = await run(
    ["comment", "update", "comment/1", "--body", "Updated", "--if-version", "3"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ comment: { id: "comment/1", body: "Updated", version: 4 } });
    },
  );
  const deleteResult = await run(
    ["comment", "delete", "comment/1", "--if-version", "4"],
    async (url, init) => {
      calls.push({ url, init });
      return response({});
    },
  );

  assert.equal(updateResult.exitCode, 0);
  assert.equal(deleteResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/comments/comment%2F1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    body: "Updated",
    threadId: "thread-current",
    version: 3,
  });
  assert.equal(calls[1].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1].init.body), { threadId: "thread-current", version: 4 });

  const missingVersion = await run(
    ["comment", "delete", "comment-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(missingVersion.exitCode, 2);
  assert.match(missingVersion.stderr.error.message, /--if-version/);
});

test("context current selects the project with the most specific matching workspace", async () => {
  const repositoryPath = path.resolve("/work/repo");
  const appPath = path.join(repositoryPath, "packages", "app");
  const result = await run(
    ["context", "current", "--cwd", appPath],
    async () => response({ projects: [
      { id: "local", name: "Local", workspacePath: null },
      { id: "repo", workspacePath: repositoryPath },
      { id: "app", workspacePath: appPath },
    ] }),
    { cwd: path.resolve("/unused") },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.cwd, appPath);
  assert.deepEqual(result.stdout.project, { id: "app", workspacePath: appPath });
});

test("context current falls back to the local project", async () => {
  const result = await run(
    ["context", "current", "--cwd", "/unmatched"],
    async () => response({ projects: [
      { id: "other", workspacePath: "/work/other" },
      { id: "local", name: "Local", workspacePath: null },
    ] }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.project.id, "local");
});

test("issue updates preserve the existing binding while comment writes require attribution", async () => {
  let issueBody;
  const issueResult = await run(
    ["issue", "update", "TASK-1", "--title", "No attribution", "--if-version", "1"],
    async (_url, init) => {
      issueBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...issueBody, version: 2 } });
    },
    { env: {} },
  );
  assert.equal(issueResult.exitCode, 0);
  assert.deepEqual(issueBody, { title: "No attribution", version: 1 });

  const commentResult = await run(
    ["comment", "add", "TASK-1", "--body", "No attribution"],
    async () => assert.fail("fetch should not be called"),
    { env: {} },
  );
  assert.equal(commentResult.exitCode, 2);
  assert.match(commentResult.stderr.error.message, /--thread-id or CODEX_THREAD_ID/);
});

test("manual linked-thread options and commands are no longer accepted", async () => {
  const optionResult = await run(
    ["issue", "update", "TASK-1", "--title", "Invalid", "--linked-thread-id", "thread-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(optionResult.exitCode, 2);
  assert.match(optionResult.stderr.error.message, /Unknown option --linked-thread-id/);

  const commandResult = await run(
    ["issue", "link-thread", "TASK-1", "--thread-id", "thread-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(commandResult.exitCode, 2);
  assert.match(commandResult.stderr.error.message, /Expected one of:[\s\S]*issue list\/get\/bootstrap\/create/);
});

test("API conflicts produce stable JSON on stderr and exit code 5", async () => {
  const result = await run(
    ["issue", "archive", "TASK-1", "--if-version", "1"],
    async () => response({ error: { code: "VERSION_CONFLICT", message: "Task changed" } }, 409),
  );

  assert.equal(result.exitCode, 5);
  assert.deepEqual(result.stderr, {
    schemaVersion: 2,
    error: { code: "VERSION_CONFLICT", message: "Task changed" },
  });
});

test("usage errors are stable and never call the service", async () => {
  const result = await run(
    ["issue", "create", "--project", "local"],
    async () => assert.fail("fetch should not be called"),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr.error.code, "USAGE_ERROR");
  assert.match(result.stderr.error.message, /--title/);
});

test("attachment upload posts file bytes to a task with filename headers", async () => {
  const calls = [];
  const fileBytes = Buffer.from("hello attachment", "utf8");
  const result = await run(
    ["attachment", "upload", "--task", "TASK-1", "--file", "notes.md", "--json"],
    async (url, init) => {
      calls.push({ url: url.toString(), init });
      return response({
        attachment: {
          id: "att-1",
          taskId: "TASK-1",
          filename: "notes.md",
          contentType: "text/markdown",
          size: fileBytes.byteLength,
        },
      }, 201);
    },
    {
      readFile: async () => fileBytes,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.attachment.id, "att-1");
  assert.equal(result.stdout.target.type, "task");
  assert.equal(result.stdout.target.id, "TASK-1");
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/tasks/TASK-1/attachments");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "text/markdown");
  assert.equal(calls[0].init.headers["x-taskboard-filename"], encodeURIComponent("notes.md"));
  assert.equal(calls[0].init.headers["x-taskboard-client"], "taskctl");
  assert.deepEqual(Buffer.from(calls[0].init.body), fileBytes);
});

test("attachment upload requires exactly one target and can target comments", async () => {
  const missing = await run(
    ["attachment", "upload", "--file", "a.txt"],
    async () => assert.fail("fetch should not be called"),
    { readFile: async () => Buffer.from("x") },
  );
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr.error.message, /exactly one of --task or --comment/);

  const both = await run(
    ["attachment", "upload", "--task", "T1", "--comment", "C1", "--file", "a.txt"],
    async () => assert.fail("fetch should not be called"),
    { readFile: async () => Buffer.from("x") },
  );
  assert.equal(both.exitCode, 2);
  assert.match(both.stderr.error.message, /exactly one of --task or --comment/);

  let commentUrl;
  const commentResult = await run(
    ["attachment", "upload", "--comment", "COMMENT-1", "--file", "shot.png", "--content-type", "image/png"],
    async (url, init) => {
      commentUrl = url.toString();
      assert.equal(init.headers["content-type"], "image/png");
      return response({
        attachment: {
          id: "att-2",
          commentId: "COMMENT-1",
          filename: "shot.png",
          contentType: "image/png",
          size: 1,
        },
      }, 201);
    },
    { readFile: async () => Buffer.from([1]) },
  );
  assert.equal(commentResult.exitCode, 0);
  assert.equal(commentUrl, "http://127.0.0.1:47823/api/comments/COMMENT-1/attachments");
  assert.equal(commentResult.stdout.target.type, "comment");
});
