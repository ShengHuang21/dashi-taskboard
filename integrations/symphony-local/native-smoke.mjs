#!/usr/bin/env node
// Real isolated Taskboard + native Symphony scheduler + controlled fake app-server.
// This never invokes a model. Run with: node native-smoke.mjs ABS_SYMPHONY_ELIXIR_DIR ABS_EVIDENCE_DIR
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskboardServer } from "../../server/app.mjs";
import { canonicalJson, sha256 } from "../../server/symphony-local.mjs";

const [source, evidence] = process.argv.slice(2);
assert.ok(path.isAbsolute(source ?? "") && path.isAbsolute(evidence ?? ""));
const integration = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(path.join(evidence, "native-controlled-"));
const workspaceRoot = path.join(directory, "workspaces");
const inputRoot = path.join(directory, "inputs");
const stateRoot = path.join(directory, "attempts");
for (const name of [path.join(directory, "state"), workspaceRoot, inputRoot, stateRoot, path.join(workspaceRoot, "A"), path.join(workspaceRoot, "B")]) mkdirSync(name, { mode: 0o700 });
const python = process.env.LOCAL_TEST_PYTHON ?? "/usr/bin/python3";
const fakeBinary = path.join(directory, "fake-codex");
const fakeSource = spawnSync(python, ["-c", "import runpy,sys; m=runpy.run_path(sys.argv[1]); print(m['FAKE'].replace('PYTHON',sys.executable,1))", path.join(integration, "supervisor_test.py")], { encoding: "utf8" });
assert.equal(fakeSource.status, 0, fakeSource.stderr);
writeFileSync(fakeBinary, fakeSource.stdout, { mode: 0o700 });
const input = path.join(inputRoot, "input.txt");
writeFileSync(input, "fixed", { mode: 0o444 });
const capabilityFile = path.join(directory, "capability.json");
writeFileSync(capabilityFile, JSON.stringify({ entry: [fakeBinary], binary_sha256: sha256(readFileSync(fakeBinary)), observed_at: new Date().toISOString(), result: { models: [
  { model: "model-A", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { model: "model-B", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
] } }));
const schedulerToken = "controlled-native-scheduler-token-only";
const app = createTaskboardServer({ dataDirectory: path.join(directory, "data"), codexExecutable: "/usr/bin/false", codexStatePath: path.join(directory, "codex-state"), codexSessionsDirectory: path.join(directory, "sessions"), instanceToken: "controlled-owner-boundary", instanceSecret: "a".repeat(64), projectSummaryEnabled: false,
  symphonyLocal: { projectId: "local", workspaceRoot, inputRoot, signingSecretFile: path.join(directory, "state/signing.key"), schedulerToken, capabilityFile } });
const address = await app.listen({ port: 0 });
const schedulerUrl = `http://127.0.0.1:${address.port}`;
const requests = [];
app.server.on("request", (request) => requests.push({ method: request.method, route: request.url.split("?")[0] }));
const actor = { type: "user", id: "controlled-owner", name: "Controlled owner", avatarUrl: null };
writeFileSync(path.join(directory, "todo.md"), "Controlled original Todo; not a Worker input");
const releases = [];
for (const [name, model, effort] of [["A", "model-A", "medium"], ["B", "model-B", "high"]]) {
  const task = app.database.createTask({ projectId: "local", title: `Controlled ${name}`, description: "No model invocation", status: "backlog", priority: "none", labels: [], actor, assignee: actor, startDate: null, dueDate: null });
  const execution = { schemaVersion: "taskboard.symphony.v1", projectId: "local", taskId: task.id, todoId: "controlled-probe", stepIds: [name], workPackageId: name, executionVersion: 1, backend: "symphony", title: `Controlled ${name}`, objective: "Controlled protocol verification", done: ["output.md exists"], workspace: { path: path.join(workspaceRoot, name), writeScope: ["output.md"] }, inputs: [{ path: input, sha256: sha256("fixed") }], dependencies: [], model, effort, limits: { maxTurns: 2 }, authority: { sandbox: "workspace-write", network: "model-only", stopOn: ["scope change"] }, artifacts: [{ path: "output.md", required: true }], git: null };
  releases.push(app.symphonyLocal.publish(task.id, { requestId: `probe-${name}`, expectedTaskVersion: task.version, execution, provenance: { todoPath: path.join(directory, "todo.md"), todoSha256: "b".repeat(64), owner: "Controlled owner" } }));
}
const workflow = path.join(directory, "WORKFLOW.md");
const config = { tracker: { kind: "local", provider: { url: schedulerUrl, project_id: "local", instance_id: "controlled-native-instance", token_env: "LOCAL_SMOKE_SCHEDULER_TOKEN", state_root: stateRoot, supervisor: path.join(integration, "supervisor.py"), python, capability_file: capabilityFile }, active_states: ["ready", "running"], terminal_states: ["in_review", "failed", "canceled", "superseded"] }, workspace: { root: workspaceRoot }, polling: { interval_ms: 200 }, agent: { max_concurrent_agents: 2 }, codex: { command: "/usr/bin/false", turn_timeout_ms: 15000, read_timeout_ms: 5000, stall_timeout_ms: 15000 }, observability: { enabled: false }, hooks: {} };
writeFileSync(workflow, `---\n${JSON.stringify(config)}\n---\nControlled local probe.\n`);
let scheduler;
const log = createWriteStream(path.join(directory, "scheduler.log"));
function start() {
  scheduler = spawn(process.env.MISE ?? "/opt/homebrew/bin/mise", ["exec", "--", "mix", "run", "--no-start", "-e", 'SymphonyElixir.Workflow.set_workflow_file_path(System.fetch_env!("LOCAL_SMOKE_WORKFLOW")); {:ok, _} = Application.ensure_all_started(:symphony_elixir); Process.sleep(:infinity)'], { cwd: source, detached: true, env: { ...process.env, ERL_FLAGS: "+S 4:4", LOCAL_SMOKE_WORKFLOW: workflow, LOCAL_SMOKE_SCHEDULER_TOKEN: schedulerToken }, stdio: ["ignore", "pipe", "pipe"] });
  scheduler.stdout.pipe(log, { end: false }); scheduler.stderr.pipe(log, { end: false });
}
async function stop(signal = "SIGTERM") {
  if (!scheduler || scheduler.exitCode !== null) return;
  const exited = new Promise((resolve) => scheduler.once("exit", resolve));
  process.kill(-scheduler.pid, signal);
  await exited;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error(message);
}
let appClosed = false;
const startedAt = new Date().toISOString();
try {
  start();
  await until(() => releases.every((r) => app.symphonyLocal.get(r.releaseId).attempt?.processState === "stopped"), "native attempts did not produce proven stop; see scheduler.log and attempts");
  for (const original of releases) {
    const release = app.symphonyLocal.get(original.releaseId);
    assert.equal(release.state, "in_review", canonicalJson(release.attempt));
    assert.equal(release.attempt.result.observed.model, release.execution.model);
    assert.equal(release.attempt.result.observed.effort, release.execution.effort);
    assert.equal(app.database.listComments(release.taskId).length, 1);
    assert.ok(release.attempt.stopEvidence.descendants.length >= 2);
  }
  const guards = () => readdirSync(stateRoot).filter((name) => /^[a-f0-9-]{36}$/.test(name));
  assert.equal(guards().length, 2);
  await stop(); start();
  await until(() => requests.filter((r) => r.method === "GET" && r.route.endsWith("/releases")).length >= 12, "restart polling was not observed");
  await delay(600);
  assert.equal(guards().length, 2);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) n FROM symphony_attempts").get().n, 2);
  // Abrupt controller loss during an active controlled process. Its supervisor
  // survives in its own group, observes EOF and stops the tracked descendants.
  const interruptedTask = app.database.createTask({ projectId: "local", title: "Controlled crash recovery", description: "No model invocation", status: "backlog", priority: "none", labels: [], actor, assignee: actor, startDate: null, dueDate: null });
  const interruptedWorkspace = path.join(workspaceRoot, "interrupted"); mkdirSync(interruptedWorkspace);
  writeFileSync(path.join(interruptedWorkspace, "hold"), "controlled pause");
  const interruptedExecution = { ...releases[0].execution, taskId: interruptedTask.id, workPackageId: "interrupted", stepIds: ["interrupted"], workspace: { path: interruptedWorkspace, writeScope: ["output.md"] } };
  const interrupted = app.symphonyLocal.publish(interruptedTask.id, { requestId: "controlled-interrupt", expectedTaskVersion: interruptedTask.version, execution: interruptedExecution, provenance: { todoPath: path.join(directory, "todo.md"), todoSha256: "b".repeat(64), owner: "Controlled owner" } });
  await until(() => existsSync(path.join(interruptedWorkspace, "descendant.pid")), "controlled interrupted process did not start");
  await delay(350);
  const originalAttempt = app.symphonyLocal.get(interrupted.releaseId).attempt.id;
  await stop("SIGKILL"); start();
  await until(() => app.symphonyLocal.get(interrupted.releaseId).attempt?.processState === "stopped", "interrupted process remained unknown; see supervisor evidence");
  assert.equal(app.symphonyLocal.get(interrupted.releaseId).attempt.id, originalAttempt);
  assert.equal(app.symphonyLocal.get(interrupted.releaseId).state, "failed");
  assert.equal(guards().length, 3);
  await app.close(); appClosed = true;
  await delay(600);
  assert.equal(guards().length, 3);
  await stop();
  const report = { startedAt, finishedAt: new Date().toISOString(), realModelCalls: 0, controlledProcesses: 3, nativeScheduler: true, restartNoSecondAttempt: true, abruptActiveSchedulerLossStoppedTree: true, serviceUnavailableNoFallback: true, directory,
    releases: releases.map((r) => ({ releaseId: r.releaseId, model: r.execution.model, effort: r.execution.effort })), requests };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", report: path.join(directory, "report.json") }));
} finally {
  await stop(); if (!appClosed) await app.close(); log.end();
  chmodSync(directory, 0o700);
}
