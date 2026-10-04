import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskboardDatabase } from "../server/database.mjs";
import { SymphonyLocalStore, sha256 } from "../server/symphony-local.mjs";
import { createTaskboardServer } from "../server/app.mjs";

const actor = { type: "user", id: "owner", name: "Owner", avatarUrl: null };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "symphony-local-"));
  const filename = path.join(directory, "data/taskboard.sqlite");
  const roots = { workspaceRoot: path.join(directory, "workspaces"), inputRoot: path.join(directory, "inputs") };
  for (const name of [path.join(directory, "data"), path.join(directory, "state"), roots.workspaceRoot, roots.inputRoot, path.join(roots.workspaceRoot, "A"), path.join(roots.workspaceRoot, "B")]) mkdirSync(name, { recursive: true });
  const input = path.join(roots.inputRoot, "input.txt");
  writeFileSync(input, "fixed input", { mode: 0o444 });
  const capabilityFile = path.join(directory, "capabilities.json");
  writeFileSync(capabilityFile, JSON.stringify({ entry: ["/usr/bin/false"], binary_sha256: sha256(readFileSync("/usr/bin/false")), observed_at: new Date().toISOString(), result: { models: [{ model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] } }));
  const config = { projectId: "local", ...roots, signingSecretFile: path.join(directory, "state/signing.key"), schedulerToken: "scheduler-test-token-".repeat(3), capabilityFile };
  let db = new TaskboardDatabase(filename);
  let store = new SymphonyLocalStore(db, config);
  return {
    directory, filename, config, input,
    get db() { return db; }, get store() { return store; },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
    reopen() { db.close(); db = new TaskboardDatabase(filename); store = new SymphonyLocalStore(db, config); },
    task(title = "Local work") {
      return db.createTask({ projectId: "local", title, description: "", status: "backlog", priority: "none", labels: [], actor, assignee: actor, startDate: null, dueDate: null });
    },
    payload(task, workPackageId = "A", workspace = "A") {
      return {
        requestId: `publish-${task.id}-1`, expectedTaskVersion: task.version,
        provenance: { todoPath: "/source/todo.md", todoSha256: "a".repeat(64), owner: "Owner" },
        execution: { schemaVersion: "taskboard.symphony.v1", projectId: "local", taskId: task.id, todoId: "todo-1", stepIds: [`step-${workPackageId}`], workPackageId, executionVersion: 1, backend: "symphony", title: "Local work", objective: "Read input and write output", done: ["Artifact exists"], workspace: { path: path.join(roots.workspaceRoot, workspace), writeScope: ["output.md"] }, inputs: [{ path: input, sha256: sha256("fixed input") }], dependencies: [], model: "test-model", effort: "medium", limits: { maxTurns: 2 }, authority: { sandbox: "workspace-write", network: "model-only", stopOn: ["scope expansion"] }, artifacts: [{ path: "output.md", required: true }], git: null },
      };
    },
  };
}
const claimBody = (release, requestId = "claim-1") => ({ requestId, executionHash: release.executionHash, schedulerInstanceId: "scheduler-1" });
const processIdentity = { wrapperPid: 91001, childPid: 91002, processGroupId: 91002, birth: "fixture-process-birth" };
function finalBody(claim, kind, payload) {
  return { requestId: `${claim.attemptId}:${kind}:1`, attemptId: claim.attemptId, claimToken: claim.claimToken, executionHash: claim.executionHash, kind, payload };
}
function resultPayload(f) {
  writeFileSync(path.join(f.config.workspaceRoot, "A/output.md"), "verified output");
  return { status: "in_review", summary: "Output ready for owner review", artifacts: [{ path: "output.md", sha256: sha256("verified output") }], verification: ["Compared output with input"], requested: { model: "test-model", effort: "medium" }, observed: { model: null, effort: null }, sessionId: "test-session", process: processIdentity, stopReason: "completed" };
}
const stopPayload = () => ({ state: "stopped", observedAt: new Date().toISOString(), process: processIdentity, groupEmpty: true, descendants: [{ pid: 91002, birth: "child-birth", alive: false }] });

test("release replay ignores later card versions/provenance, rejects content changes and supersedes unclaimed release", () => {
  const f = fixture();
  try {
    const task = f.task(); const body = f.payload(task); const first = f.store.publish(task.id, body);
    f.db.createComment(task.id, { body: "Owner note", actor });
    const replay = f.store.publish(task.id, { ...body, provenance: { ...body.provenance, todoSha256: "b".repeat(64) } });
    assert.equal(replay.releaseId, first.releaseId);
    assert.throws(() => f.store.publish(task.id, { ...body, execution: { ...body.execution, objective: "changed" } }), { code: "SYMPHONY_IDEMPOTENCY_CONFLICT" });
    const second = f.store.publish(task.id, { ...body, requestId: "publish-v2", expectedTaskVersion: f.db.getTask(task.id).version, execution: { ...body.execution, executionVersion: 2 } });
    assert.equal(f.store.get(first.releaseId).state, "superseded");
    assert.throws(() => f.store.claim(first.releaseId, claimBody(first)), { code: "SYMPHONY_NOT_READY" });
    assert.equal(f.store.list({ projectId: "local", candidates: true })[0].releaseId, second.releaseId);
  } finally { f.close(); }
});

test("claim receipt survives database reopen; result and stop have independent idempotency and occupancy", () => {
  const f = fixture();
  try {
    const task = f.task(); const body = f.payload(task); const release = f.store.publish(task.id, body);
    const claim = f.store.claim(release.releaseId, claimBody(release));
    f.reopen();
    assert.equal(f.store.claimReceipt(release.releaseId, "claim-1", "scheduler-1").claimToken, claim.claimToken);
    assert.equal(f.store.claim(release.releaseId, claimBody(release)).attemptId, claim.attemptId);
    assert.throws(() => f.store.claim(release.releaseId, claimBody(release, "new-claim")), { code: "SYMPHONY_ALREADY_CLAIMED" });
    const other = f.task(); const otherRelease = f.store.publish(other.id, f.payload(other, "other", "A"));
    const result = finalBody(claim, "result", resultPayload(f));
    f.store.finalize(release.releaseId, result);
    assert.equal(f.db.getTask(task.id).status, "in_review");
    assert.equal(f.db.listComments(task.id).length, 1);
    assert.equal(f.store.finalize(release.releaseId, result).replayed, true);
    assert.throws(() => f.store.claim(otherRelease.releaseId, claimBody(otherRelease)), { code: "SYMPHONY_WORKSPACE_BUSY" });
    const stop = finalBody(claim, "stop", stopPayload());
    f.store.finalize(release.releaseId, stop);
    assert.equal(f.store.finalize(release.releaseId, stop).replayed, true);
    assert.equal(f.db.listComments(task.id).length, 1);
    assert.ok(f.store.claim(otherRelease.releaseId, claimBody(otherRelease)).attemptId);
    const next = f.store.publish(task.id, { ...body, requestId: "v2", expectedTaskVersion: f.db.getTask(task.id).version, execution: { ...body.execution, executionVersion: 2 } });
    assert.equal(f.store.finalize(release.releaseId, result).replayed, true);
    assert.equal(f.store.get(next.releaseId).state, "ready");
  } finally { f.close(); }
});

test("scope and signing identity survive restart and cannot silently fall back to legacy", () => {
  const f = fixture();
  try {
    assert.throws(() => new SymphonyLocalStore(f.db), { code: "SYMPHONY_SCOPE_REQUIRED" });
    assert.throws(() => new SymphonyLocalStore(f.db, { ...f.config, schedulerToken: "other".repeat(10) }), { code: "SYMPHONY_SCOPE_CHANGED" });
    unlinkSync(f.config.signingSecretFile);
    assert.throws(() => new SymphonyLocalStore(f.db, f.config), { code: "SYMPHONY_SECRET_MISSING" });
  } finally { f.close(); }
});

test("strict package validation checks actual executable capability, inputs and authority", () => {
  const f = fixture();
  try {
    const task = f.task(); const body = f.payload(task);
    assert.throws(() => f.store.publish(task.id, { ...body, execution: { ...body.execution, effort: "high" } }), { code: "SYMPHONY_UNSUPPORTED_MODEL" });
    assert.throws(() => f.store.publish(task.id, { ...body, execution: { ...body.execution, unknown: true } }), { code: "SYMPHONY_INVALID_INPUT" });
    assert.throws(() => f.store.publish(task.id, { ...body, execution: { ...body.execution, executionVersion: 1.1 } }), { code: "SYMPHONY_INVALID_INPUT" });
    chmodSync(f.input, 0o644); writeFileSync(f.input, "changed"); chmodSync(f.input, 0o444);
    assert.throws(() => f.store.publish(task.id, body), { code: "SYMPHONY_INPUT_CHANGED" });
    assert.equal(f.store.list({ projectId: "local", candidates: true }).length, 0);
  } finally { f.close(); }
});

async function contender(f, release, requestId) {
  const source = `
    import { TaskboardDatabase } from ${JSON.stringify(new URL("../server/database.mjs", import.meta.url).href)};
    import { SymphonyLocalStore } from ${JSON.stringify(new URL("../server/symphony-local.mjs", import.meta.url).href)};
    const [filename,config,id,input] = JSON.parse(process.argv[1]);
    const db = new TaskboardDatabase(filename); const store = new SymphonyLocalStore(db,config);
    console.log("ready");
    process.stdin.once("data",()=>{try {console.log(JSON.stringify({ok:true,value:store.claim(id,input)}));} catch(e) {console.log(JSON.stringify({ok:false,code:e.code}));} finally {db.close();process.stdin.destroy();}});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify([f.filename, f.config, release.releaseId, claimBody(release, requestId)])], { stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output.trim().split("\n").at(-1))) : reject(new Error(errors)));
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) resolve(); });
    child.once("exit", (code) => { if (!output.includes("ready\n")) reject(new Error(`contender exited ${code}: ${errors}`)); });
  });
  return { go() { child.stdin.end("go"); }, done };
}

for (const sameRelease of [true, false]) test(`SQLite processes compete atomically: ${sameRelease ? "same release" : "different cards, same checkout"}`, async () => {
  const f = fixture();
  try {
    const a = f.task("A"); const first = f.store.publish(a.id, f.payload(a));
    const b = sameRelease ? null : f.task("B");
    const second = b ? f.store.publish(b.id, f.payload(b, "B", "A")) : first;
    const racers = await Promise.all([contender(f, first, "racer-a"), contender(f, second, "racer-b")]);
    racers.forEach((racer) => racer.go()); const results = await Promise.all(racers.map((racer) => racer.done));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok).code, sameRelease ? "SYMPHONY_ALREADY_CLAIMED" : "SYMPHONY_WORKSPACE_BUSY");
    assert.equal(f.db.database.prepare("SELECT COUNT(*) n FROM symphony_attempts").get().n, 1);
  } finally { f.close(); }
});

test("native RPC resolves native id/cwd even with caller override, rejects only ambiguous or owned requests", async () => {
  const f = fixture();
  try {
    const cwd = path.join(f.config.workspaceRoot, "A");
    await assert.rejects(f.store.resolveRpcContexts([{ method: "thread/start", params: {} }], () => {}), { code: "SYMPHONY_RPC_SCOPE_UNKNOWN" });
    await assert.rejects(f.store.resolveRpcContexts([{ method: "turn/start", params: { threadId: "native", cwd: os.tmpdir() } }], async () => ({ thread: { id: "native", cwd } })), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
    await assert.rejects(f.store.resolveRpcContexts([{ method: "turn/start", params: { threadId: "native" } }], async () => ({ thread: { id: "wrong", cwd: os.tmpdir() } })), { code: "SYMPHONY_RPC_SCOPE_UNKNOWN" });
    assert.equal((await f.store.resolveRpcContexts([{ method: "turn/start", params: { threadId: "other" } }], async () => ({ thread: { id: "other", cwd: os.tmpdir() } }))).length, 1);
    const target = f.task("Persisted target project binding");
    f.db.database.prepare("UPDATE tasks SET thread_id=?,thread_workspace_path=?,thread_codex_host_id='local' WHERE id=?").run("known-native", os.tmpdir(), target.id);
    await assert.rejects(f.store.resolveRpcContexts([{ method: "turn/start", params: { threadId: "known-native" } }], async () => ({ thread: { id: "known-native", cwd: os.tmpdir() } })), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
    const contexts = await f.store.resolveRpcContexts([{ method: "turn/start", params: { threadId: "late-native" } }], async () => ({ thread: { id: "late-native", cwd: os.tmpdir() } }));
    f.db.database.prepare("UPDATE tasks SET thread_id=? WHERE id=?").run("late-native", target.id);
    assert.throws(() => f.store.assertLegacyAllowed(contexts[0][0]), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
  } finally { f.close(); }
});

test("protected loopback API separates owner release from scheduler; legacy/composer fence precedes discovery", async () => {
  const f = fixture(); let app;
  try {
    const task = f.task(); const payload = f.payload(task);
    app = createTaskboardServer({ dataDirectory: f.directory, databasePath: f.filename, codexExecutable: "/usr/bin/false", codexStatePath: path.join(f.directory, "codex-state"), codexSessionsDirectory: path.join(f.directory, "sessions"), instanceToken: "owner-test-token-123", instanceSecret: "d".repeat(64), projectSummaryEnabled: false, symphonyLocal: f.config });
    const address = await app.listen({ port: 0 }); const base = `http://127.0.0.1:${address.port}`;
    const route = `/api/local/tasks/${task.id}/symphony/releases`;
    assert.equal((await fetch(`${base}${route}`, { method: "POST", headers: { "x-taskboard-scheduler-token": f.config.schedulerToken } })).status, 404);
    const publication = await fetch(`${base}/owner-test-token-123${route}`, { method: "POST", headers: { "content-type": "application/json", "x-taskboard-client": "taskctl" }, body: JSON.stringify(payload) });
    assert.equal(publication.status, 200, JSON.stringify(await publication.clone().json()));
    const { release } = await publication.json();
    assert.equal((await fetch(`${base}/api/local/symphony/candidates?projectId=local`)).status, 401);
    const candidates = await fetch(`${base}/api/local/symphony/candidates?projectId=local`, { headers: { "x-taskboard-scheduler-token": f.config.schedulerToken } });
    assert.equal((await candidates.json()).releases[0].releaseId, release.releaseId);
    const thread = app.database.createAiChatThread({ id: "legacy-thread", title: "Legacy", status: "idle", origin: { projectId: "local", projectName: "Local", issueId: task.id, workspacePath: payload.execution.workspace.path }, codexThreadId: null, model: "test-model", reasoningEffort: "medium", sandbox: "workspace-write" });
    let discoveries = 0; app.aiChat.getCatalog = async () => { discoveries++; throw new Error("must not discover"); };
    for (const input of [{ message: "Run" }, { contractVersion: "composer.v1", document: { nodes: [{ type: "text", text: "Run" }] } }]) await assert.rejects(app.aiChat.startTurn(thread.id, input), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
    assert.equal(discoveries, 0);
    assert.equal(app.database.listAiChatRuns(thread.id).length, 0);
    assert.throws(() => app.database.claimAgentTask(task.id, 1, {}), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
    assert.throws(() => app.database.claimTaskSafeAction(task.id, {}), { code: "SYMPHONY_EXCLUSIVE_SCOPE" });
    assert.throws(() => app.database.updateTask(task.id, app.database.getTask(task.id).version, { developmentContext: null }, undefined, undefined, actor), { code: "SYMPHONY_SCOPE_FROZEN" });
  } finally { if (app) await app.close(); f.close(); }
});


test("context derives persistent private paths and refuses scope overlap or changed protection", () => {
  const f = fixture();
  try {
    const task = f.task(); const release = f.store.publish(task.id, f.payload(task));
    assert.deepEqual(f.store.context(release.releaseId).protection, {
      inputRoot: f.store.scope.inputRoot,
      deniedPaths: [path.join(f.store.scope.inputRoot, "../data"), path.join(f.store.scope.inputRoot, "../state")].map((p) => path.resolve(p)),
    });
    assert.throws(() => new SymphonyLocalStore(f.db, { ...f.config, protectedPaths: [f.config.inputRoot] }), { code: "SYMPHONY_INVALID_CONFIG" });
    const extra = path.join(f.directory, "private-config.json"); writeFileSync(extra, "{}");
    assert.throws(() => new SymphonyLocalStore(f.db, { ...f.config, protectedPaths: [extra] }), { code: "SYMPHONY_SCOPE_CHANGED" });
    f.reopen();
    assert.equal(f.store.context(release.releaseId).protection.deniedPaths.length, 2);
  } finally { f.close(); }
});
