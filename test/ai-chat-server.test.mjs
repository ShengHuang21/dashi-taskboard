import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { main as taskctl } from "../cli/taskctl.mjs";

async function createServerFixture(host = "127.0.0.1", options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-server-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-real","display_name":"GPT Real","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer="";
  process.stdin.on("data", chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf("\\n"))>=0) { const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
      if (!line.trim()) continue; const message=JSON.parse(line);
      if (message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id===2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":null}]}]}}\\n');
    }
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.resume();
  process.stdin.on("end", () => {
    const workspace = args[args.indexOf("-C") + 1];
    process.chdir(workspace);
    appendFileSync(path.join(workspace, "fixture-dispatches.jsonl"), JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");
    if (prompt.includes("fixture-run-failure")) process.exit(7);
    process.stdout.write('{"type":"thread.started","thread_id":"session-1"}\\n');
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
    if (prompt.includes("fixture-hold-predecessor")) {
      const timer = setInterval(() => {
        if (existsSync(path.join(workspace, "fixture-release"))) clearInterval(timer);
      }, 10);
    }
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    skillPath: "/fixture/manage-taskboard/SKILL.md",
    ...options,
  });
  const address = await app.listen({ host, port: 0 });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    workspace,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitUntil(check) {
  for (let index = 0; index < 200; index += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Fixture did not reach the expected state");
}

async function backgroundContinuationFixture(options = {}) {
  const instance = { instanceToken: "fixture-next-token", instanceSecret: "c".repeat(64) };
  const fixture = await createServerFixture("127.0.0.1", { ...options, ...instance });
  fixture.instance = instance;
  const runtimePath = path.join(fixture.directory, "fixture-runtime.json");
  await writeFile(runtimePath, JSON.stringify({ version: 1, url: `${fixture.baseUrl}/${instance.instanceToken}` }));
  fixture.runtimePath = runtimePath;
  fixture.cli = async (args, expectedCode = 0) => {
    let output = "";
    const stream = { write(value) { output += value; } };
    const code = await taskctl([...args, "--runtime-file", runtimePath, "--json"], {
      env: {}, stdout: stream, stderr: stream,
    });
    if (expectedCode === 0) assert.equal(code, 0, output);
    else assert.notEqual(code, 0, output);
    return JSON.parse(output);
  };
  fixture.createThread = async () => (await fixture.cli([
    "background", "create", "--project", "local", "--model", "gpt-real",
    "--reasoning-effort", "high", "--sandbox", "read-only",
  ])).thread;
  fixture.dispatches = async (workspace = fixture.workspace) => (await readFile(path.join(workspace, "fixture-dispatches.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return fixture;
}

test("issue worktree background threads pin their origin through card changes and successors", async (context) => {
  const fixture = await backgroundContinuationFixture();
  try {
    const worktree = path.join(fixture.directory, "worktree");
    const changedWorktree = path.join(fixture.directory, "changed-worktree");
    const worktreeLink = path.join(fixture.directory, "worktree-link");
    await mkdir(worktree); await mkdir(changedWorktree);
    await symlink(worktree, worktreeLink, process.platform === "win32" ? "junction" : "dir");
    const canonicalWorktree = await realpath(worktree);
    const statePath = path.join(fixture.directory, "codex-state.json");
    const stateBefore = await readFile(statePath, "utf8");
    const { task } = await fixture.cli(["issue", "create", "--project", "local", "--title", "Pinned worktree",
      "--thread-id", "fixture-owner"]);
    const createArgs = ["background", "create", "--project", "local", "--issue", task.identifier,
      "--model", "gpt-real", "--reasoning-effort", "high", "--sandbox", "read-only"];
    const { thread: oldThread } = await fixture.cli(createArgs);
    assert.equal(oldThread.origin.workspacePath, fixture.workspace);
    await fixture.cli(["issue", "update", task.identifier, "--worktree-path", worktreeLink]);
    const { thread: worktreeThread } = await fixture.cli(createArgs);
    assert.equal(worktreeThread.origin.workspacePath, canonicalWorktree);
    await fixture.cli(["issue", "update", task.identifier, "--worktree-path", changedWorktree]);
    const { run: oldRun } = await fixture.cli(["background", "start", oldThread.id,
      "--request-id", "old-project", "--message", "existing project origin"]);
    await waitUntil(() => fixture.app.database.getAiChatRun(oldRun.id).status === "completed");
    const { run: first } = await fixture.cli(["background", "start", worktreeThread.id,
      "--request-id", "first-worktree", "--message", "pinned worktree origin"]);
    await waitUntil(() => fixture.app.database.getAiChatRun(first.id).status === "completed");
    await fixture.cli(["background", "continue", worktreeThread.id, "--after-run", first.id,
      "--request-id", "next-worktree", "--message", "same worktree successor"]);
    const completed = await waitUntil(async () => {
      const snapshot = await fixture.cli(["background", "get", worktreeThread.id]);
      return snapshot.runs.length === 2 && snapshot.runs.every((run) => run.status === "completed") && snapshot;
    });
    assert.equal(completed.thread.origin.workspacePath, canonicalWorktree);
    assert.equal(completed.continuations[0].state, "dispatched");
    const worktreeDispatches = await fixture.dispatches(canonicalWorktree);
    assert.equal(worktreeDispatches.length, 2);
    for (const dispatch of worktreeDispatches) {
      assert.equal(dispatch.args[dispatch.args.indexOf("-C") + 1], canonicalWorktree);
      assert.equal(dispatch.cwd, canonicalWorktree);
      assert.equal(dispatch.args.includes("--add-dir"), false);
    }
    const projectDispatches = await fixture.dispatches();
    assert.equal(projectDispatches.length, 1);
    assert.equal(projectDispatches[0].cwd, fixture.workspace);
    assert.equal((await fixture.createThread()).origin.workspacePath, fixture.workspace);
    await fixture.cli(["issue", "update", task.identifier, "--git-branch", "metadata-only-branch"]);
    assert.equal((await fixture.cli(createArgs)).thread.origin.workspacePath, fixture.workspace);
    assert.equal(await readFile(statePath, "utf8"), stateBefore);
    await rename(worktree, path.join(fixture.directory, "retired-worktree"));
    const unavailable = await fixture.cli(["background", "start", worktreeThread.id,
      "--request-id", "unavailable", "--message", "must not fall back"], 1);
    assert.equal(unavailable.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
    assert.deepEqual(await fixture.cli(["background", "get", worktreeThread.id]), completed);
    context.diagnostic(JSON.stringify({ contract: "CAP71-ISSUE-WORKTREE-v1", proof: "fake-executable-cwd",
      oldOrigin: fixture.workspace, newOrigin: canonicalWorktree, successorOrigin: worktreeDispatches[1].cwd,
      worktreeDispatches: worktreeDispatches.length, addedWriteRoots: 0, mappingUnchanged: true }));
  } finally {
    await fixture.close();
  }
});

test("issue worktree creation rejects unavailable directories and known remote bindings", async () => {
  const fixture = await backgroundContinuationFixture();
  try {
    const missingPath = path.join(fixture.directory, "missing");
    const { task } = await fixture.cli(["issue", "create", "--project", "local", "--title", "Unavailable worktree",
      "--thread-id", "fixture-owner", "--worktree-path", missingPath]);
    const createArgs = ["background", "create", "--project", "local", "--issue", task.identifier,
      "--model", "gpt-real", "--reasoning-effort", "high", "--sandbox", "read-only"];
    assert.equal((await fixture.cli(createArgs, 1)).error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
    await fixture.cli(["issue", "update", task.identifier, "--worktree-path", fixture.workspace,
      "--binding-thread-id", "fixture-remote", "--binding-codex-project-id", "remote-project",
      "--binding-codex-project-kind", "remote", "--binding-codex-host-id", "remote-host",
      "--binding-workspace-path", fixture.workspace]);
    assert.equal((await fixture.cli(createArgs, 1)).error.code, "AI_CHAT_REMOTE_ISSUE_UNSUPPORTED");
    assert.equal((await fixture.app.aiChat.listThreads()).length, 0);
  } finally {
    await fixture.close();
  }
});

test("issue worktree cloud selection uses the existing localized branch counterpart", async (context) => {
  const cloudState = { remoteUrl: null, projectMappings: {} };
  const calls = [];
  let cloudTask;
  const fixture = await backgroundContinuationFixture({
    cloudConfigStore: { async read() { return { ...cloudState }; } },
    remoteFetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, method: init.method });
      const value = pathname === "/api/projects"
        ? { projects: [{ id: "cloud-project", name: "Cloud project", workspacePath: "/remote/project" }] }
        : pathname === "/api/tasks/cloud-issue" ? { task: cloudTask } : null;
      assert.ok(value, pathname);
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const execute = promisify(execFile);
    const gitConfigPath = path.join(fixture.directory, "empty-gitconfig");
    await writeFile(gitConfigPath, "");
    const git = (args) => execute("git", ["-c", `core.hooksPath=${path.join(fixture.directory, "no-hooks")}`, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    const worktree = path.join(fixture.directory, "cloud-local-worktree");
    const remotePath = path.join(fixture.directory, "remote-path-that-also-exists");
    await mkdir(remotePath);
    await git(["init", "--quiet", fixture.workspace]);
    await git(["-C", fixture.workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--allow-empty", "-m", "isolated fixture"]);
    await git(["-C", fixture.workspace, "worktree", "add", "--quiet", "-b", "fixture-cloud-worktree", worktree]);
    const canonicalWorktree = await realpath(worktree);
    cloudTask = { id: "cloud-issue", identifier: "CLOUD-1", projectId: "cloud-project", title: "Cloud worktree",
      archivedAt: null, developmentContext: { type: "worktree", path: remotePath, branch: "fixture-cloud-worktree" } };
    Object.assign(cloudState, { remoteUrl: "https://tasks.example.test", actorName: "Fixture",
      sharedKey: "synthetic-fixture-key", projectMappings: { "cloud-project": fixture.workspace } });
    const mappingBefore = JSON.stringify(cloudState.projectMappings);
    const createArgs = ["background", "create", "--project", "cloud-project", "--issue", "cloud-issue",
      "--model", "gpt-real", "--reasoning-effort", "high", "--sandbox", "read-only"];
    const { thread } = await fixture.cli(createArgs);
    assert.equal(thread.origin.workspacePath, canonicalWorktree);
    const { run } = await fixture.cli(["background", "start", thread.id, "--request-id", "cloud-local",
      "--message", "localized worktree only"]);
    await waitUntil(() => fixture.app.database.getAiChatRun(run.id).status === "completed");
    const [dispatch] = await fixture.dispatches(canonicalWorktree);
    assert.equal(dispatch.cwd, canonicalWorktree);
    assert.equal(dispatch.args.includes(remotePath), false);
    assert.equal(dispatch.args.includes("--add-dir"), false);
    cloudTask.developmentContext.branch = "no-local-counterpart";
    assert.equal((await fixture.cli(createArgs, 1)).error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
    assert.equal((await fixture.app.aiChat.listThreads()).length, 1);
    assert.equal(JSON.stringify(cloudState.projectMappings), mappingBefore);
    assert.ok(calls.every((call) => call.method === "GET"));
    context.diagnostic(JSON.stringify({ contract: "CAP71-ISSUE-WORKTREE-v1", proof: "fake-cloud-localized-cwd",
      selected: dispatch.cwd, upstreamPathDiscarded: true, unresolvedWorktreeRejected: true,
      projectMappingUnchanged: true, fixtureCloudReads: calls.length }));
  } finally {
    await fixture.close();
  }
});

function holdNextPreparation(service) {
  const original = service.resolveContext;
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let armed = true;
  service.resolveContext = async (...args) => {
    const resolved = await original(...args);
    if (armed) {
      armed = false;
      entered.resolve();
      await gate.promise;
    }
    return resolved;
  };
  return { entered: entered.promise, release: () => gate.resolve() };
}

async function registerHeldSuccessor(fixture) {
  const thread = await fixture.createThread();
  const { run } = await fixture.cli(["background", "start", thread.id, "--request-id", "first",
    "--message", "fixture-hold-predecessor"]);
  await waitUntil(() => fixture.app.database.listAiChatEvents(thread.id)
    .some((event) => event.type === "turn.completed"));
  const command = ["background", "continue", thread.id, "--after-run", run.id,
    "--request-id", "next", "--message", "bounded next action"];
  await fixture.cli(command);
  return { thread, run, command };
}

test("background continuation waits for owned close and dispatches the registered next message once", async (context) => {
  const fixture = await backgroundContinuationFixture();
  try {
    const { task } = await fixture.cli(["issue", "create", "--project", "local", "--title", "Managed next",
      "--thread-id", "fixture-owner"]);
    const { thread } = await fixture.cli([
      "background", "create", "--project", "local", "--issue", task.identifier, "--model", "gpt-real",
      "--reasoning-effort", "high", "--sandbox", "read-only",
    ]);
    const { run: first } = await fixture.cli([
      "background", "start", thread.id, "--request-id", "first", "--message", "fixture-hold-predecessor",
    ]);
    await waitUntil(() => fixture.app.database.listAiChatEvents(thread.id)
      .some((event) => event.type === "turn.completed"));
    assert.equal(fixture.app.database.getAiChatRun(first.id).status, "running");
    const messagePath = path.join(fixture.directory, "next-message.txt");
    await writeFile(messagePath, "bounded next action");
    const command = ["background", "continue", thread.id, "--after-run", first.id,
      "--request-id", "next", "--message-file", messagePath];
    const [accepted, replay] = await Promise.all([fixture.cli(command), fixture.cli(command)]);
    assert.deepEqual(replay.continuation, accepted.continuation);
    assert.equal(accepted.continuation.state, "pending");
    assert.equal(accepted.continuation.waitingReason, "predecessor_running");
    assert.equal((await fixture.dispatches()).length, 1);
    await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
    const completed = await waitUntil(async () => {
      const snapshot = await fixture.cli(["background", "get", thread.id]);
      return snapshot.runs.length === 2 && snapshot.runs.every((run) => run.status === "completed") && snapshot;
    });
    const next = completed.continuations[0];
    assert.equal(next.state, "dispatched");
    assert.equal(completed.events.filter((event) => event.type === "user_message").length, 2);
    assert.equal((await fixture.dispatches()).filter((entry) => entry.prompt.includes("bounded next action")).length, 1);
    const successorDispatch = (await fixture.dispatches())[1];
    assert.ok(successorDispatch.args.includes("resume"));
    assert.ok(successorDispatch.args.includes("session-1"));
    assert.equal((await fixture.cli(command)).continuation.runId, next.runId);
    assert.equal((await fixture.cli(["background", "start", thread.id,
      "--request-id", "next", "--message", "bounded next action"])).run.id, next.runId);
    const beforeConflict = await fixture.cli(["background", "get", thread.id]);
    assert.equal((await fixture.cli([...command.slice(0, -2), "--message", "different"], 1))
      .error.code, "AI_CHAT_REQUEST_CONFLICT");
    assert.deepEqual(await fixture.cli(["background", "get", thread.id]), beforeConflict);
    const progress = await fixture.cli(["issue", "progress", task.identifier]);
    assert.equal(progress.backgroundProgress.threads[0].latestRun.runId, next.runId);
    assert.equal(progress.backgroundProgress.threads[0].latestRun.recordedStatus, "completed");
    context.diagnostic(JSON.stringify({ observation: "CAP71-NEXT-OWNED-CLOSE", firstRun: first.id,
      nextRun: next.runId, nextDispatches: 1, rawCompletedDidNotStartNext: true, codexThreadId: "session-1" }));
  } finally {
    await fixture.close();
  }
});

test("background continuation pause and resume leave the predecessor untouched", async () => {
  const fixture = await backgroundContinuationFixture();
  try {
    const { thread, run, command } = await registerHeldSuccessor(fixture);
    const beforePause = fixture.app.database.getAiChatRun(run.id);
    assert.equal((await fixture.cli(["background", "pause", thread.id, "--request-id", "next"]))
      .continuation.state, "paused");
    assert.deepEqual(fixture.app.database.getAiChatRun(run.id), beforePause);
    assert.equal((await fixture.cli(command)).continuation.state, "paused");
    await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
    await waitUntil(() => fixture.app.database.getAiChatRun(run.id).status === "completed");
    await Promise.all([...fixture.app.aiChat.continuationAttempts]);
    assert.equal(fixture.app.database.listAiChatRuns(thread.id).length, 1);
    assert.equal((await fixture.dispatches()).length, 1);
    await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
    await waitUntil(() => fixture.app.database.listAiChatRuns(thread.id)
      .filter((entry) => entry.status === "completed").length === 2);
    assert.equal((await fixture.dispatches()).length, 2);
    assert.equal((await fixture.cli(["background", "cancel", thread.id, "--request-id", "next"], 1))
      .error.code, "AI_CHAT_CONTINUATION_STATE");
  } finally {
    await fixture.close();
  }
});

test("background continuation cancellation during preparation wins before reservation", async (context) => {
  const fixture = await backgroundContinuationFixture();
  let preparation;
  try {
    const { thread, run, command } = await registerHeldSuccessor(fixture);
    preparation = holdNextPreparation(fixture.app.aiChat);
    // Suppress a second eligible handler at the same barrier by pausing while A is still open.
    await fixture.cli(["background", "pause", thread.id, "--request-id", "next"]);
    await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
    await waitUntil(() => fixture.app.database.getAiChatRun(run.id).status === "completed");
    await Promise.all([...fixture.app.aiChat.continuationAttempts]);
    await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
    await preparation.entered;
    assert.equal((await fixture.cli(["background", "cancel", thread.id, "--request-id", "next"]))
      .continuation.state, "canceled");
    preparation.release();
    await Promise.all([...fixture.app.aiChat.continuationAttempts]);
    const canceled = await fixture.cli(["background", "get", thread.id]);
    assert.equal(canceled.runs.length, 1);
    assert.equal(canceled.continuations[0].runId, null);
    assert.equal((await fixture.cli(command)).continuation.state, "canceled");
    assert.equal((await fixture.cli(["background", "start", thread.id,
      "--request-id", "next", "--message", "bounded next action"], 1)).error.code, "AI_CHAT_REQUEST_CONFLICT");
    assert.equal((await fixture.cli(["background", "resume", thread.id, "--request-id", "next"], 1))
      .error.code, "AI_CHAT_CONTINUATION_STATE");
    assert.equal((await fixture.cli(["background", "continue", thread.id, "--after-run", run.id,
      "--request-id", "first", "--message", "bounded next action"], 1)).error.code, "AI_CHAT_REQUEST_CONFLICT");
    assert.deepEqual(await fixture.cli(["background", "get", thread.id]), canceled);
    assert.equal((await fixture.dispatches()).length, 1);
    context.diagnostic(JSON.stringify({ observation: "CAP71-NEXT-CANCEL", state: "canceled",
      successorRuns: 0, firstRunStatus: fixture.app.database.getAiChatRun(run.id).status }));
  } finally {
    preparation?.release();
    await fixture.close();
  }
});

test("background continuation rechecks settings and exact predecessor after asynchronous preparation", async () => {
  for (const change of ["settings", "newer-run"]) {
    const fixture = await backgroundContinuationFixture();
    let preparation;
    try {
      const { thread, run } = await registerHeldSuccessor(fixture);
      await fixture.cli(["background", "pause", thread.id, "--request-id", "next"]);
      await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
      await waitUntil(() => fixture.app.database.getAiChatRun(run.id).status === "completed");
      await Promise.all([...fixture.app.aiChat.continuationAttempts]);
      preparation = holdNextPreparation(fixture.app.aiChat);
      await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
      await preparation.entered;
      if (change === "settings") {
        const changed = await request(`${fixture.baseUrl}/${fixture.instance.instanceToken}`,
          `/api/local/ai/threads/${thread.id}`, { method: "PATCH", body: { sandbox: "workspace-write" } });
        assert.equal(changed.response.status, 200);
      } else {
        const { run: newer } = await fixture.cli(["background", "start", thread.id,
          "--request-id", "newer", "--message", "explicit newer work"]);
        await waitUntil(() => fixture.app.database.getAiChatRun(newer.id).status === "completed");
      }
      preparation.release();
      await Promise.all([...fixture.app.aiChat.continuationAttempts]);
      const snapshot = await fixture.cli(["background", "get", thread.id]);
      assert.equal(snapshot.continuations[0].state, "pending");
      assert.equal(snapshot.continuations[0].runId, null);
      assert.equal(snapshot.continuations[0].waitingReason,
        change === "settings" ? "settings_changed" : "stale_predecessor");
      assert.equal((await fixture.dispatches()).filter((entry) => entry.prompt.includes("bounded next action")).length, 0);
    } finally {
      preparation?.release();
      await fixture.close();
    }
  }
});

test("background continuation close drains preparation and restart waits for explicit resume", async (context) => {
  const fixture = await backgroundContinuationFixture();
  let preparation;
  let app = fixture.app;
  try {
    const { thread, run } = await registerHeldSuccessor(fixture);
    await fixture.cli(["background", "pause", thread.id, "--request-id", "next"]);
    await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
    await waitUntil(() => app.database.getAiChatRun(run.id).status === "completed");
    await Promise.all([...app.aiChat.continuationAttempts]);
    preparation = holdNextPreparation(app.aiChat);
    await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
    await preparation.entered;
    const closing = app.close();
    await waitUntil(() => app.aiChat.closing);
    assert.equal(app.database.listAiChatRuns(thread.id).length, 1);
    preparation.release();
    await closing;
    app = createTaskboardServer({
      dataDirectory: fixture.directory, codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: "/fixture/manage-taskboard/SKILL.md", ...fixture.instance,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await writeFile(fixture.runtimePath, JSON.stringify({ version: 1,
      url: `http://127.0.0.1:${address.port}/${fixture.instance.instanceToken}` }));
    const reopened = await fixture.cli(["background", "get", thread.id]);
    assert.equal(reopened.continuations[0].state, "pending");
    assert.equal(reopened.runs.length, 1);
    assert.equal(app.aiChat.continuationAttempts.size, 0);
    assert.equal((await fixture.dispatches()).length, 1);
    await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
    await waitUntil(() => app.database.listAiChatRuns(thread.id)
      .filter((entry) => entry.status === "completed").length === 2);
    const once = await fixture.cli(["background", "get", thread.id]);
    await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
    assert.deepEqual(await fixture.cli(["background", "get", thread.id]), once);
    assert.equal((await fixture.dispatches()).length, 2);
    context.diagnostic(JSON.stringify({ observation: "CAP71-NEXT-RESTART", startupDispatches: 0,
      explicitResumeDispatches: 1, closePreparationDispatches: 0 }));
  } finally {
    preparation?.release();
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("background continuation registration and resume share the whole finalization barrier", async () => {
  for (const outcome of ["fulfilled", "rejected"]) {
    const fixture = await backgroundContinuationFixture();
    const gate = Promise.withResolvers();
    let releaseFinalization;
    try {
      const thread = await fixture.createThread();
      const { run } = await fixture.cli(["background", "start", thread.id, "--request-id", "first",
        "--message", "fixture-hold-predecessor"]);
      const completions = fixture.app.aiChat.completions;
      const ownedCompletion = completions.get(run.id);
      // Hold the shared promise seam after real owner close to model pending attachment cleanup.
      const wholeFinalization = ownedCompletion.then(async (finished) => {
        await gate.promise;
        return finished;
      });
      void wholeFinalization.catch(() => {});
      completions.set(run.id, wholeFinalization);
      const remove = completions.delete.bind(completions);
      completions.delete = (id) => id === run.id ? false : remove(id);
      releaseFinalization = () => { completions.delete = remove; remove(run.id); };
      await writeFile(path.join(fixture.workspace, "fixture-release"), "release");
      await ownedCompletion;
      assert.equal(fixture.app.aiChat.active.size, 0);
      assert.equal(fixture.app.database.getAiChatRun(run.id).status, "completed");
      const command = ["background", "continue", thread.id, "--after-run", run.id,
        "--request-id", "next", "--message", "bounded next action"];
      await fixture.cli(command);
      await fixture.cli(["background", "resume", thread.id, "--request-id", "next"]);
      assert.equal((await fixture.cli(["background", "get", thread.id])).runs.length, 1);
      assert.equal((await fixture.dispatches()).length, 1);
      if (outcome === "fulfilled") gate.resolve();
      else gate.reject(new Error("fixture cleanup failure"));
      await Promise.all([...fixture.app.aiChat.continuationAttempts]);
      releaseFinalization();
      if (outcome === "fulfilled") {
        await waitUntil(() => fixture.app.database.listAiChatRuns(thread.id)
          .filter((entry) => entry.status === "completed").length === 2);
        assert.equal((await fixture.dispatches()).length, 2);
      } else {
        await fixture.cli(command);
        await Promise.all([...fixture.app.aiChat.continuationAttempts]);
        const snapshot = await fixture.cli(["background", "get", thread.id]);
        assert.equal(snapshot.runs.length, 1);
        assert.equal(snapshot.continuations[0].waitingReason, "finalization_failed");
      }
    } finally {
      gate.resolve();
      releaseFinalization?.();
      await fixture.close();
    }
  }
});

test("background continuation never retries interrupted predecessors or linked failed runs", async () => {
  const fixture = await backgroundContinuationFixture();
  let app = fixture.app;
  try {
    const held = await registerHeldSuccessor(fixture);
    const interrupted = await request(`${fixture.baseUrl}/${fixture.instance.instanceToken}`,
      `/api/local/ai/runs/${held.run.id}/interrupt`, { method: "POST" });
    assert.equal(interrupted.response.status, 200);
    await Promise.all([...app.aiChat.continuationAttempts]);
    await fixture.cli(["background", "resume", held.thread.id, "--request-id", "next"]);
    assert.equal((await fixture.cli(["background", "get", held.thread.id])).continuations[0]
      .waitingReason, "predecessor_interrupted");
    assert.equal(app.database.listAiChatRuns(held.thread.id).length, 1);

    const thread = await fixture.createThread();
    const { run: first } = await fixture.cli(["background", "start", thread.id,
      "--request-id", "first", "--message", "hello"]);
    await waitUntil(() => app.database.getAiChatRun(first.id).status === "completed");
    await fixture.cli(["background", "continue", thread.id, "--after-run", first.id,
      "--request-id", "next-failure", "--message", "fixture-run-failure"]);
    const failed = await waitUntil(() => app.database.listAiChatRuns(thread.id)
      .find((entry) => entry.status === "failed"));
    await app.close();
    app = createTaskboardServer({
      dataDirectory: fixture.directory, codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: "/fixture/manage-taskboard/SKILL.md", ...fixture.instance,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await writeFile(fixture.runtimePath, JSON.stringify({ version: 1,
      url: `http://127.0.0.1:${address.port}/${fixture.instance.instanceToken}` }));
    assert.equal((await fixture.cli(["background", "resume", thread.id, "--request-id", "next-failure"]))
      .continuation.runId, failed.id);
    assert.equal(app.database.listAiChatRuns(thread.id).length, 2);
    assert.equal((await fixture.dispatches()).filter((entry) => entry.prompt.includes("fixture-run-failure")).length, 1);
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("issue progress observes the linked background run without changing Capsule or claims", async (context) => {
  const instance = { instanceToken: "fixture-progress-token", instanceSecret: "b".repeat(64) };
  const cloudState = { remoteUrl: null, projectMappings: {} };
  const upstreamCalls = [];
  let capsuleBefore;
  const fixture = await createServerFixture("127.0.0.1", {
    ...instance,
    cloudConfigStore: { async read() { return { ...cloudState }; } },
    remoteFetch: async (url, init) => {
      upstreamCalls.push({ url: url.toString(), method: init.method, body: init.body });
      return new Response(JSON.stringify({ capsule: capsuleBefore }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const baseUrl = `${fixture.baseUrl}/${instance.instanceToken}`;
  async function cli(args) {
    let output = "";
    const stream = { write(value) { output += value; } };
    const code = await taskctl([...args, "--json"], {
      env: { CODEX_TASKBOARD_URL: baseUrl }, stdout: stream, stderr: stream,
    });
    assert.equal(code, 0, output);
    return JSON.parse(output);
  }
  try {
    const { task } = await cli(["issue", "create", "--project", "local", "--title", "Background observation",
      "--thread-id", "fixture-owner", "--status", "in_progress"]);
    const createThread = ["background", "create", "--project", task.projectId, "--issue", task.identifier,
      "--model", "gpt-real", "--reasoning-effort", "high", "--sandbox", "read-only"];
    const { thread } = await cli(createThread);
    const { run } = await cli(["background", "start", thread.id, "--request-id", "progress-observation",
      "--message", "hello"]);
    for (let index = 0; index < 100; index += 1) {
      if (fixture.app.database.getAiChatRun(run.id).status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const recordedRun = fixture.app.database.getAiChatRun(run.id);
    assert.equal(recordedRun.status, "completed");
    const { thread: noRunThread } = await cli(createThread);
    capsuleBefore = (await cli(["issue", "bootstrap", task.identifier])).capsule;
    const taskBefore = fixture.app.database.getTask(task.id);
    const claimBefore = fixture.app.database.getAgentTaskClaim(task.id);
    const agentRunBefore = fixture.app.database.getLatestTaskAgentRun(task.id);
    Object.assign(cloudState, {
      remoteUrl: "https://tasks.example.test", actorName: "Fixture", sharedKey: "synthetic-fixture-key",
    });

    const result = await cli(["issue", "progress", task.identifier]);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.progress.liveExecution, "unknown");
    assert.equal(result.progress.task.id, task.id);
    assert.equal(result.progress.task.version, taskBefore.version);
    assert.deepEqual(result.backgroundProgress, {
      availability: "available", source: "local-ai-chat", projectId: task.projectId, taskId: task.id,
      queriedAt: result.backgroundProgress.queriedAt,
      threads: [
        { threadId: thread.id, latestRun: {
          runId: run.id, recordedStatus: "completed", startedAt: recordedRun.startedAt,
          finishedAt: recordedRun.finishedAt,
        } },
        { threadId: noRunThread.id, latestRun: null },
      ],
      truncated: false,
    });
    assert.ok(Number.isFinite(Date.parse(result.backgroundProgress.queriedAt)));
    assert.deepEqual(upstreamCalls, [{
      url: `https://tasks.example.test/api/tasks/${task.identifier}/capsule`, method: "GET", body: undefined,
    }]);
    assert.deepEqual(fixture.app.database.getTask(task.id), taskBefore);
    assert.deepEqual(fixture.app.database.getAgentTaskClaim(task.id), claimBefore);
    assert.deepEqual(fixture.app.database.getLatestTaskAgentRun(task.id), agentRunBefore);
    const capsuleAfter = fixture.app.database.getTaskCapsule(task.id);
    for (const key of ["task", "requirementsRevision", "resumeToken", "activeRun", "latestRun", "execution",
      "comments", "handoffs", "conversation", "relations"]) {
      assert.deepEqual(capsuleAfter[key], capsuleBefore[key], key);
    }
    assert.deepEqual(fixture.app.database.getAiChatRun(run.id), recordedRun);
    context.diagnostic(JSON.stringify({
      observation: "CAP71-PROGRESS-W1-OBS1", taskId: task.id, threadId: thread.id, runId: run.id,
      recordedStatus: recordedRun.status, taskAndCapsuleAndClaimUnchanged: true,
      cloudRequests: upstreamCalls.length, localMetadataCloudRequests: 0,
    }));
  } finally {
    await fixture.close();
  }
});

test("background taskctl retries preserve one durable run through completion and restart", async () => {
  const instance = { instanceToken: "fixture-background-token", instanceSecret: "a".repeat(64) };
  const fixture = await createServerFixture("127.0.0.1", instance);
  let app = fixture.app;
  let baseUrl = `${fixture.baseUrl}/${instance.instanceToken}`;
  const runtimePath = path.join(fixture.directory, "fixture-runtime.json");
  const messagePath = path.join(fixture.directory, "message.txt");
  await writeFile(messagePath, "hello");
  await writeFile(runtimePath, JSON.stringify({ version: 1, url: baseUrl }));
  async function cli(args) {
    let output = "";
    const stream = { write(value) { output += value; } };
    const code = await taskctl([...args, "--runtime-file", runtimePath, "--json"], {
      env: {}, stdout: stream, stderr: stream,
    });
    return { code, body: JSON.parse(output) };
  }
  try {
    const created = await cli(["background", "create", "--project", "local", "--model", "gpt-real",
      "--reasoning-effort", "high", "--sandbox", "read-only"]);
    assert.equal(created.code, 0);
    const threadId = created.body.thread.id;
    const command = ["background", "start", threadId, "--request-id", "owner-request-1", "--message", "hello"];
    const [first, replay] = await Promise.all([
      cli(["background", "start", threadId, "--request-id", "owner-request-1", "--message-file", messagePath]),
      cli(command),
    ]);
    assert.equal(first.code, 0);
    assert.equal(replay.code, 0);
    assert.equal(replay.body.run.id, first.body.run.id);
    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await cli(["background", "get", threadId]);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.runs.length, 1);
    assert.equal(snapshot.body.runs[0].status, "completed");
    assert.equal(snapshot.body.events.filter((event) => event.type === "user_message").length, 1);
    assert.equal((await cli(command)).body.run.id, first.body.run.id);
    const conflict = await cli([...command.slice(0, -1), "different message"]);
    assert.notEqual(conflict.code, 0);
    assert.equal(conflict.body.error.code, "AI_CHAT_REQUEST_CONFLICT");
    assert.deepEqual((await cli(["background", "get", threadId])).body, snapshot.body);
    const composer = await request(baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST", body: { contractVersion: "composer.v1", requestId: "owner-request-1" },
    });
    assert.equal(composer.response.status, 400);
    assert.deepEqual((await cli(["background", "get", threadId])).body, snapshot.body);

    // A settings change or service restart must not turn an old request into new work.
    await request(baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH", body: { sandbox: "danger-full-access" },
    });
    await app.close();
    app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: "/fixture/manage-taskboard/SKILL.md", ...instance,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}/${instance.instanceToken}`;
    await writeFile(runtimePath, JSON.stringify({ version: 1, url: baseUrl }));
    const restartedReplay = await cli(command);
    assert.equal(restartedReplay.code, 0);
    assert.equal(restartedReplay.body.run.id, first.body.run.id);
    assert.equal(restartedReplay.body.run.status, "completed");
    assert.equal((await cli(["background", "get", threadId])).body.runs.length, 1);

    // A confirmed synchronous failure after reservation remains terminal on retry.
    const failedThread = await app.aiChat.createThread({ projectId: "local", model: "gpt-real" });
    const insert = app.database.insertAiChatEvent;
    app.database.insertAiChatEvent = () => { throw new Error("fixture pre-spawn failure"); };
    const failedInput = { requestId: "failure-request", message: "hello" };
    await assert.rejects(app.aiChat.startTurn(failedThread.id, failedInput), /fixture pre-spawn failure/);
    app.database.insertAiChatEvent = insert;
    const failedRun = await app.aiChat.startTurn(failedThread.id, failedInput);
    assert.equal(failedRun.status, "failed");
    assert.equal(app.database.listAiChatRuns(failedThread.id).length, 1);

    app.database.insertAiChatEvent = function (event) {
      if (event.type === "error") throw new Error("fixture error-event write failure");
      return insert.call(this, event);
    };
    const terminalInput = { requestId: "terminal-request", message: "fixture-run-failure" };
    const terminalRun = await app.aiChat.startTurn(failedThread.id, terminalInput);
    for (let index = 0; index < 100; index += 1) {
      if (app.aiChat.getRun(terminalRun.id).status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    app.database.insertAiChatEvent = insert;
    assert.equal(app.aiChat.getRun(terminalRun.id).status, "failed");
    assert.equal((await app.aiChat.startTurn(failedThread.id, terminalInput)).id, terminalRun.id);
    assert.equal(app.database.listAiChatRuns(failedThread.id).length, 2);
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function privateLanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => {
      if (entry?.family !== "IPv4" || entry.internal) return false;
      const [first, second] = entry.address.split(".").map(Number);
      return first === 10
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254);
    })?.address;
}

async function requestFrom(address, port, pathname) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: address,
      port,
      path: pathname,
      headers: { host: `${address}:${port}` },
    }, (response) => {
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

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("loopback AI API freezes server-owned origin and rejects injected execution fields", async () => {
  const fixture = await createServerFixture();
  try {
    const meta = await request(fixture.baseUrl, "/api/meta");
    assert.equal(meta.body.capabilities.localAiChat, true);
    const catalog = await request(fixture.baseUrl, "/api/local/ai/catalog?projectId=local");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.models[0].slug, "gpt-real");
    assert.equal(catalog.body.skills[0].id, "real-skill");

    const injected = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", workspacePath: "/tmp/evil", argv: ["--dangerously-bypass-approvals-and-sandbox"] },
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "high",
        sandbox: "read-only",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.workspace);
    const threadId = created.body.thread.id;

    const invalidSkill = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["invented-skill"] },
    });
    assert.equal(invalidSkill.response.status, 400);
    assert.equal(invalidSkill.body.error.code, "INVALID_SKILL");

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["real-skill"] },
    });
    assert.equal(turn.response.status, 202);
    assert.equal(turn.body.run.threadId, threadId);

    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.thread.codexThreadId, "session-1");
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
  } finally {
    await fixture.close();
  }
});

test("non-local AI threads reject projects without an available workspace", async () => {
  const fixture = await createServerFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "missing-workspace",
        name: "Missing workspace",
        workspacePath: path.join(fixture.directory, "missing-workspace"),
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "missing-workspace" },
    });
    assert.equal(created.response.status, 409);
    assert.equal(created.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("non-local AI turns reject a workspace that became unavailable", async () => {
  const fixture = await createServerFixture();
  try {
    const workspaceLink = path.join(fixture.directory, "project-workspace");
    await symlink(
      path.resolve(import.meta.dirname, ".."),
      workspaceLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "disconnected-workspace",
        name: "Disconnected workspace",
        workspacePath: workspaceLink,
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "disconnected-workspace" },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    await rm(workspaceLink);

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 409);
    assert.equal(turn.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");

    const snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.deepEqual(snapshot.body.runs, []);
  } finally {
    await fixture.close();
  }
});

test("the local AI project falls back to the Taskboard workspace", async () => {
  const fixture = await createServerFixture();
  try {
    await writeFile(
      path.join(fixture.directory, "codex-state.json"),
      JSON.stringify({ "local-projects": {} }),
    );

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, path.resolve(import.meta.dirname, ".."));
  } finally {
    await fixture.close();
  }
});

test("danger-full-access requires confirmation on every turn and thread settings are validated", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "low",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const denied = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error.code, "DANGER_CONFIRMATION_REQUIRED");
    const allowed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello", dangerFullAccessConfirmed: true },
    });
    assert.equal(allowed.response.status, 202);

    const invalidModel = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { model: "invented-model", reasoningEffort: "high" },
    });
    assert.equal(invalidModel.response.status, 400);
    assert.equal(invalidModel.body.error.code, "INVALID_MODEL");
  } finally {
    await fixture.close();
  }
});

test("thread management, interrupt and query contracts stay narrow", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", title: "Original" },
    });
    const threadId = created.body.thread.id;

    const list = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.threads.some((thread) => thread.id === threadId), true);

    const unknownQuery = await request(fixture.baseUrl, "/api/local/ai/threads?projectId=local");
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const updated = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { title: "Renamed", sandbox: "workspace-write" },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.title, "Renamed");

    const interruptedMissing = await request(fixture.baseUrl, "/api/local/ai/runs/missing/interrupt", {
      method: "POST",
    });
    assert.equal(interruptedMissing.response.status, 404);

    const removed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 204);
    const missing = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(missing.response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("local AI routes reject private-LAN clients while ordinary API routes remain available", async (context) => {
  const address = privateLanAddress();
  if (!address) {
    context.skip("No private LAN interface is available");
    return;
  }
  const fixture = await createServerFixture("0.0.0.0");
  const port = fixture.app.server.address().port;
  try {
    const projects = await requestFrom(address, port, "/api/projects");
    assert.equal(projects.status, 200);
    const metadata = await requestFrom(address, port, "/api/meta");
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.capabilities.localAiChat, false);
    const ai = await requestFrom(address, port, "/api/local/ai/threads");
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("AI SSE is live-only and thread snapshots remain the durable source", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    const threadId = created.body.thread.id;
    const controller = new AbortController();
    const response = await fetch(`${fixture.baseUrl}/api/local/ai/threads/${threadId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let connected = "";
    while (!connected.includes("event: ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      connected += new TextDecoder().decode(chunk.value);
    }
    assert.match(connected, /connected/);
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 202);
    let streamed = "";
    while (!streamed.includes("ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, /event: ai\.(event|run)/);
    controller.abort();
  } finally {
    await fixture.close();
  }
});

test("server close stops accepting requests before AI shutdown completes", async () => {
  const fixture = await createServerFixture();
  let appClosed = false;
  try {
    let releaseAiClose;
    const aiCloseGate = new Promise((resolve) => {
      releaseAiClose = resolve;
    });
    fixture.app.aiChat.close = () => aiCloseGate;

    const closing = fixture.app.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const acceptedDuringClose = await fetch(`${fixture.baseUrl}/health`)
      .then(() => true, () => false);
    releaseAiClose();
    await closing;
    appClosed = true;

    assert.equal(acceptedDuringClose, false);
  } finally {
    if (appClosed) {
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      await fixture.close();
    }
  }
});
