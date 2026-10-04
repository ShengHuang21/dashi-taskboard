import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "./database.mjs";

const fail = (code, message, status = 409) => { throw new ApiError(status, code, message); };
const now = () => new Date().toISOString();
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) fail("SYMPHONY_INVALID_INPUT", "Non-JSON value", 400);
  return JSON.stringify(value);
}
function fields(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) fail("SYMPHONY_INVALID_INPUT", "Unexpected or missing field", 400);
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 20000 || value.includes("\0")) fail("SYMPHONY_INVALID_INPUT", `Invalid ${label}`, 400);
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail("SYMPHONY_INVALID_INPUT", `Invalid ${label}`, 400);
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("SYMPHONY_INVALID_INPUT", "Invalid SHA-256", 400);
}
function within(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
function caseSensitive(existingPath) {
  // Probe an existing path's own name, not its changing/possibly empty contents.
  const name = path.basename(existingPath);
  const alternate = name.replace(/[A-Za-z]/, (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  if (alternate === name) return path.dirname(existingPath) === existingPath ? true : caseSensitive(path.dirname(existingPath));
  try {
    const original = statSync(existingPath); const other = statSync(path.join(path.dirname(existingPath), alternate));
    return original.dev !== other.dev || original.ino !== other.ino;
  } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
function relative(value) {
  text(value, "relative path");
  if (path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) fail("SYMPHONY_INVALID_PATH", "Expected a bounded relative path", 400);
  return value;
}
function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("SYMPHONY_INVALID_PATH", "Expected an absolute existing path", 400);
  try { return realpathSync(value); } catch { fail("SYMPHONY_INVALID_PATH", "Owner must prepare the existing path before publication", 400); }
}
function strings(value, label, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail("SYMPHONY_INVALID_INPUT", `Invalid ${label}`, 400);
  value.forEach((v) => text(v, label));
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? "")); const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
function processIdentity(value) {
  fields(value, ["wrapperPid", "childPid", "processGroupId", "birth"]);
  integer(value.wrapperPid, "wrapperPid");
  for (const key of ["childPid", "processGroupId"]) if (value[key] !== null) integer(value[key], key);
  if ((value.childPid === null) !== (value.processGroupId === null)) fail("SYMPHONY_INVALID_INPUT", "Child and process group identity must agree", 400);
  text(value.birth, "process birth");
}

/** One local project, immutable releases, one durable attempt per release. */
export class SymphonyLocalStore {
  constructor(taskboard, config) {
    this.taskboard = taskboard;
    this.db = taskboard.database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symphony_scope (project_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, secret_fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symphony_releases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), todo_id TEXT NOT NULL,
        package_id TEXT NOT NULL, execution_version INTEGER NOT NULL, execution_json TEXT NOT NULL,
        execution_hash TEXT NOT NULL, provenance_json TEXT NOT NULL, published_at TEXT NOT NULL,
        UNIQUE(project_id,todo_id,package_id,execution_version));
      CREATE TABLE IF NOT EXISTS symphony_current (task_id TEXT PRIMARY KEY REFERENCES tasks(id), release_id TEXT NOT NULL REFERENCES symphony_releases(id));
      CREATE TABLE IF NOT EXISTS symphony_publish_requests (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, release_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symphony_attempts (
        id TEXT PRIMARY KEY, release_id TEXT NOT NULL UNIQUE REFERENCES symphony_releases(id),
        claim_request_id TEXT NOT NULL, claim_payload_hash TEXT NOT NULL, scheduler_id TEXT NOT NULL,
        token_hash TEXT NOT NULL, claimed_at TEXT NOT NULL, result_json TEXT, stopped_at TEXT, stop_json TEXT);
      CREATE TABLE IF NOT EXISTS symphony_occupancy (
        workspace_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES symphony_attempts(id), acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symphony_receipts (
        attempt_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL, PRIMARY KEY(attempt_id,kind), UNIQUE(attempt_id,request_id));
    `);
    const stored = this.db.prepare("SELECT * FROM symphony_scope").all();
    if (!config) {
      if (stored.length) fail("SYMPHONY_SCOPE_REQUIRED", "Persisted Symphony scope requires its original local configuration");
      this.enabled = false;
      taskboard.symphonyLocal = this;
      return;
    }
    fields(config, ["projectId", "workspaceRoot", "inputRoot", "signingSecretFile", "schedulerToken", "capabilityFile", "protectedPaths"], ["projectId", "workspaceRoot", "inputRoot", "signingSecretFile", "schedulerToken", "capabilityFile"]);
    text(config.projectId, "projectId"); text(config.schedulerToken, "schedulerToken");
    if (config.schedulerToken.length < 32) fail("SYMPHONY_INVALID_CONFIG", "Scheduler token must contain at least 32 characters");
    this.scope = { projectId: config.projectId, workspaceRoot: absolute(config.workspaceRoot), inputRoot: absolute(config.inputRoot) };
    this.scope.caseSensitive = caseSensitive(this.scope.workspaceRoot);
    if (within(this.scope.workspaceRoot, this.scope.inputRoot) || within(this.scope.inputRoot, this.scope.workspaceRoot)) fail("SYMPHONY_INVALID_CONFIG", "Input and worker roots must be separate");
    if (!path.isAbsolute(config.signingSecretFile)) fail("SYMPHONY_INVALID_CONFIG", "Signing secret file must be absolute");
    const databaseFile = this.db.prepare("PRAGMA database_list").all().find((entry) => entry.name === "main")?.file;
    if (!databaseFile) fail("SYMPHONY_INVALID_CONFIG", "Local execution requires a persistent database path");
    if (!Array.isArray(config.protectedPaths ?? [])) fail("SYMPHONY_INVALID_CONFIG", "Protected paths must be an array");
    this.scope.deniedPaths = [...new Set([absolute(path.dirname(databaseFile)), absolute(path.dirname(config.signingSecretFile)), ...(config.protectedPaths ?? []).map(absolute)])].sort();
    for (const denied of this.scope.deniedPaths) {
      for (const allowed of [this.scope.workspaceRoot, this.scope.inputRoot]) {
        if (within(denied, allowed) || within(allowed, denied)) fail("SYMPHONY_INVALID_CONFIG", "Private state and worker/input paths must be separate");
      }
    }
    if (!existsSync(config.signingSecretFile)) {
      if (stored.length || this.db.prepare("SELECT 1 FROM symphony_attempts LIMIT 1").get()) fail("SYMPHONY_SECRET_MISSING", "Restore the original signing secret; it cannot be regenerated");
      writeFileSync(config.signingSecretFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    const secretStat = lstatSync(config.signingSecretFile);
    if (!secretStat.isFile() || (secretStat.mode & 0o077) !== 0) fail("SYMPHONY_INVALID_CONFIG", "Signing secret must be a private regular file");
    this.secret = readFileSync(config.signingSecretFile);
    if (this.secret.length !== 32) fail("SYMPHONY_INVALID_CONFIG", "Invalid signing secret length");
    this.schedulerToken = config.schedulerToken;
    this.capabilityFile = absolute(config.capabilityFile);
    const fingerprint = sha256(this.secret);
    const configJson = canonicalJson({ ...this.scope, schedulerTokenHash: sha256(config.schedulerToken) });
    if (stored.length && (stored.length !== 1 || stored[0].project_id !== config.projectId || stored[0].config_json !== configJson || stored[0].secret_fingerprint !== fingerprint)) fail("SYMPHONY_SCOPE_CHANGED", "Restore the persisted Symphony scope and credentials");
    this.enabled = true;
    if (!stored.length) {
      this.assertNoLegacyWork();
      this.db.prepare("INSERT INTO symphony_scope VALUES (?,?,?)").run(config.projectId, configJson, fingerprint);
    }
    taskboard.symphonyLocal = this;
  }

  context(id) { return { release: this.get(id), protection: { deniedPaths: [...this.scope.deniedPaths], inputRoot: this.scope.inputRoot } }; }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  requireEnabled() { if (!this.enabled) fail("SYMPHONY_DISABLED", "Local Symphony scope is not configured"); }
  authenticate(token) { this.requireEnabled(); if (!safeEqual(token, this.schedulerToken)) fail("SYMPHONY_UNAUTHORIZED", "Invalid scheduler credentials", 401); }
  workspaceKey(workspace) { const p = absolute(workspace); return this.scope.caseSensitive ? p : p.toLowerCase(); }
  inScope({ projectId, taskId, workspacePath, threadId } = {}) {
    if (!this.enabled) return false;
    const task = taskId ? this.taskboard.getTask(taskId) : null;
    if (projectId === this.scope.projectId || task?.projectId === this.scope.projectId) return true;
    if (threadId && this.nativeBindings(threadId).some((binding) => this.inScope(binding))) return true;
    if (!workspacePath) return false;
    // Resolve the longest existing prefix without creating anything.
    let p = path.resolve(workspacePath); const rest = [];
    while (!existsSync(p) && p !== path.dirname(p)) { rest.unshift(path.basename(p)); p = path.dirname(p); }
    const candidate = path.join(realpathSync(p), ...rest);
    const sensitive = this.scope.caseSensitive;
    return within(sensitive ? this.scope.workspaceRoot : this.scope.workspaceRoot.toLowerCase(), sensitive ? candidate : candidate.toLowerCase());
  }
  assertLegacyAllowed(context) {
    if (this.inScope(context)) fail("SYMPHONY_EXCLUSIVE_SCOPE", "This project/workspace is exclusively dispatched by Symphony");
  }
  nativeBindings(threadId) {
    // Re-read trusted persisted identities at the final transaction, after thread/read.
    const rows = this.db.prepare(`
      SELECT project_id, id task_id, thread_workspace_path workspace_path FROM tasks
        WHERE thread_id=? AND (thread_codex_host_id IS NULL OR thread_codex_host_id='local')
      UNION ALL SELECT origin_project_id, origin_issue_id, origin_workspace_path FROM ai_chat_threads
        WHERE codex_thread_id=?
      UNION ALL SELECT project_id, task_id, worktree_path FROM task_agent_runs
        WHERE agent_thread_id=? OR root_thread_id=?
      UNION ALL SELECT project_id, task_id, worktree_path FROM task_safe_action_receipts
        WHERE root_thread_id=? AND (root_host_id IS NULL OR root_host_id='local')
      UNION ALL SELECT project_id, task_id, NULL FROM agent_coordination_window_receipts WHERE thread_id=?
      UNION ALL SELECT project_id, task_id, workspace_path FROM agent_coordinator_provisioning_attempts
        WHERE thread_id=? AND codex_host_id='local'
      UNION ALL SELECT project_id, task_id, workspace_path FROM agent_domain_coordinator_provisioning_attempts
        WHERE thread_id=? AND codex_host_id='local'
    `).all(threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId);
    return rows.map((row) => ({ projectId: row.project_id, taskId: row.task_id, workspacePath: row.workspace_path }));
  }
  assertNativeReceiptAllowed(ordinaryDelivery) {
    if (!ordinaryDelivery) return;
    const row = this.db.prepare("SELECT project_id,task_id,worktree_path FROM task_safe_action_receipts WHERE id=?").get(ordinaryDelivery.receiptId);
    if (row) this.assertLegacyAllowed({ projectId: row.project_id, taskId: row.task_id, workspacePath: row.worktree_path });
  }
  assertTaskMutation(task, changes) {
    if (!this.enabled) return;
    const current = this.db.prepare("SELECT release_id FROM symphony_current WHERE task_id=?").get(task.id);
    if ((current || this.inScope({ projectId: task.projectId }) || this.inScope({ projectId: changes.projectId, workspacePath: changes.developmentContext?.path }))
      && ["projectId", "developmentContext", "threadBinding"].some((key) => Object.hasOwn(changes, key))) fail("SYMPHONY_SCOPE_FROZEN", "Published task execution bindings are frozen");
  }
  async resolveRpcContexts(operations, readThread) {
    const contexts = [];
    for (const { method, params } of operations) {
      const scopes = [];
      if (method === "thread/start") {
        if (!path.isAbsolute(params?.cwd ?? "")) fail("SYMPHONY_RPC_SCOPE_UNKNOWN", "thread/start requires an explicit absolute cwd");
        scopes.push({ workspacePath: params.cwd });
      } else {
        if (typeof params?.threadId !== "string" || !params.threadId) fail("SYMPHONY_RPC_SCOPE_UNKNOWN", "Native RPC requires a thread id");
        let response;
        try { response = await readThread(params.threadId); }
        catch { fail("SYMPHONY_RPC_SCOPE_UNKNOWN", "Cannot verify this native thread's ownership"); }
        if (response?.thread?.id !== params.threadId || !path.isAbsolute(response?.thread?.cwd ?? "")) fail("SYMPHONY_RPC_SCOPE_UNKNOWN", "Native thread id/cwd could not be verified");
        scopes.push({ threadId: params.threadId, workspacePath: response.thread.cwd });
        if (Object.hasOwn(params, "cwd")) {
          if (!path.isAbsolute(params.cwd ?? "")) fail("SYMPHONY_RPC_SCOPE_UNKNOWN", "Native RPC cwd override must be absolute");
          scopes.push({ workspacePath: params.cwd });
        }
      }
      for (const scope of scopes) this.assertLegacyAllowed(scope);
      contexts.push(scopes);
    }
    return contexts;
  }
  assertNoLegacyWork() {
    const checks = [
      ["SELECT t.project_id,t.id task_id,r.worktree_path workspace_path FROM task_agent_runs r JOIN tasks t ON t.id=r.task_id WHERE r.status IN ('active','waiting','blocked','interrupted')"],
      ["SELECT origin_project_id project_id,origin_issue_id task_id,origin_workspace_path workspace_path FROM ai_chat_threads t JOIN ai_chat_runs r ON r.thread_id=t.id WHERE r.status IN ('running','interrupted')"],
      ["SELECT project_id,task_id,worktree_path workspace_path FROM task_safe_action_receipts WHERE status IN ('reserved','delivering','legacy')"]
    ];
    for (const [sql] of checks) for (const row of this.db.prepare(sql).all()) {
      if (this.inScope({ projectId: row.project_id, taskId: row.task_id, workspacePath: row.workspace_path })) fail("SYMPHONY_LEGACY_UNRESOLVED", "Existing legacy work must be reconciled before enabling this scope");
    }
    // Unknown native deliveries cannot establish a safe initial ownership boundary.
    if (this.db.prepare("SELECT 1 FROM host_executor_effects WHERE codex_host_id='local' AND status IN ('dispatched','uncertain') LIMIT 1").get()) fail("SYMPHONY_LEGACY_UNRESOLVED", "Reconcile unresolved native deliveries before enabling Symphony");
  }
  checkCapability(execution) {
    let evidence;
    try { evidence = JSON.parse(readFileSync(this.capabilityFile, "utf8")); } catch { fail("SYMPHONY_CAPABILITY_UNAVAILABLE", "Capability evidence is unavailable"); }
    const model = evidence.result?.models?.find((m) => m.model === execution.model);
    if (!model?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === execution.effort)
      || !evidence.entry?.[0] || sha256(readFileSync(evidence.entry[0])) !== evidence.binary_sha256) fail("SYMPHONY_UNSUPPORTED_MODEL", "Requested model/effort lacks evidence for the current executable");
    return { executable: evidence.entry[0], binarySha256: evidence.binary_sha256, capabilityObservedAt: evidence.observed_at };
  }
  normalizeExecution(input) {
    fields(input, ["schemaVersion","projectId","taskId","todoId","stepIds","workPackageId","executionVersion","backend","title","objective","done","workspace","inputs","dependencies","model","effort","limits","authority","artifacts","git"]);
    const e = structuredClone(input);
    if (e.schemaVersion !== "taskboard.symphony.v1" || e.backend !== "symphony" || e.projectId !== this.scope.projectId) fail("SYMPHONY_INVALID_INPUT", "Invalid schema, backend or project", 400);
    for (const key of ["taskId","todoId","workPackageId","title","objective","model","effort"]) text(e[key], key);
    integer(e.executionVersion, "executionVersion"); strings(e.stepIds, "stepIds"); strings(e.done, "done");
    fields(e.workspace, ["path","writeScope"]); e.workspace.path = absolute(e.workspace.path);
    if (!statSync(e.workspace.path).isDirectory() || !within(this.scope.workspaceRoot, e.workspace.path) || e.workspace.path === this.scope.workspaceRoot) fail("SYMPHONY_INVALID_PATH", "Worker must use a dedicated workspace below its root");
    strings(e.workspace.writeScope, "writeScope"); e.workspace.writeScope.forEach(relative);
    fields(e.limits, ["maxTurns"]); integer(e.limits.maxTurns, "maxTurns");
    fields(e.authority, ["sandbox","network","stopOn"]); strings(e.authority.stopOn, "stopOn");
    if (e.authority.sandbox !== "workspace-write" || !["model-only","authorized-git"].includes(e.authority.network)) fail("SYMPHONY_INVALID_INPUT", "Unsupported local authority", 400);
    if (!Array.isArray(e.inputs) || !Array.isArray(e.dependencies) || !Array.isArray(e.artifacts) || !e.artifacts.length) fail("SYMPHONY_INVALID_INPUT", "Expected input, dependency and artifact arrays", 400);
    for (const item of e.inputs) {
      fields(item, ["path","sha256"]); digest(item.sha256); item.path = absolute(item.path);
      if (!within(this.scope.inputRoot, item.path) || !statSync(item.path).isFile() || (statSync(item.path).mode & 0o222)) fail("SYMPHONY_INVALID_PATH", "Inputs must be read-only snapshots in the input root");
    }
    for (const dep of e.dependencies) {
      fields(dep, ["workPackageId","executionVersion","releaseId","attemptId","artifactPath","sha256"]);
      for (const key of ["workPackageId","releaseId","attemptId"]) text(dep[key], key);
      integer(dep.executionVersion, "dependency version"); relative(dep.artifactPath); digest(dep.sha256);
    }
    for (const artifact of e.artifacts) {
      fields(artifact, ["path","required"]); relative(artifact.path);
      if (typeof artifact.required !== "boolean" || !e.workspace.writeScope.some((scope) => artifact.path === scope || artifact.path.startsWith(`${scope}/`))) fail("SYMPHONY_INVALID_INPUT", "Artifact must be inside the declared write scope", 400);
    }
    if (e.git !== null) { fields(e.git, ["repository","branch","baseCommit"]); Object.values(e.git).forEach((v) => text(v, "git baseline")); }
    return e;
  }
  verifyInputs(e) {
    if (absolute(e.workspace.path) !== e.workspace.path || !statSync(e.workspace.path).isDirectory()
      || !within(this.scope.workspaceRoot, e.workspace.path)) fail("SYMPHONY_WORKSPACE_CHANGED", "Frozen workspace path changed");
    for (const item of e.inputs) if (sha256(readFileSync(item.path)) !== item.sha256) fail("SYMPHONY_INPUT_CHANGED", "Frozen input hash changed");
    for (const dep of e.dependencies) {
      const release = this.get(dep.releaseId); const attempt = release.attempt;
      if (release.execution.workPackageId !== dep.workPackageId || release.execution.executionVersion !== dep.executionVersion
        || attempt?.id !== dep.attemptId || attempt.result?.status !== "in_review"
        || !attempt.result.artifacts?.some((a) => a.path === dep.artifactPath && a.sha256 === dep.sha256)) fail("SYMPHONY_DEPENDENCY_MISMATCH", "Dependency must identify a verified result artifact");
    }
  }
  publish(taskRef, input) {
    this.requireEnabled(); fields(input, ["requestId","expectedTaskVersion","execution","provenance"]);
    text(input.requestId, "requestId"); integer(input.expectedTaskVersion, "expectedTaskVersion");
    fields(input.provenance, ["todoPath","todoSha256","owner","note"], ["todoPath","todoSha256","owner"]);
    text(input.provenance.todoPath, "todoPath"); digest(input.provenance.todoSha256); text(input.provenance.owner, "owner");
    const e = this.normalizeExecution(input.execution); const json = canonicalJson(e); const hash = sha256(json);
    const task = this.taskboard.getTask(taskRef);
    if (!task || task.id !== e.taskId || task.projectId !== e.projectId) fail("SYMPHONY_TASK_MISMATCH", "Publication must identify the original task");
    return this.transaction(() => {
      const keyed = this.db.prepare("SELECT * FROM symphony_publish_requests WHERE request_id=?").get(input.requestId);
      if (keyed && keyed.request_hash !== hash) fail("SYMPHONY_IDEMPOTENCY_CONFLICT", "Publication request changed");
      const existing = this.db.prepare("SELECT * FROM symphony_releases WHERE project_id=? AND todo_id=? AND package_id=? AND execution_version=?").get(e.projectId,e.todoId,e.workPackageId,e.executionVersion);
      if (existing) {
        if (existing.execution_json !== json) fail("SYMPHONY_VERSION_CONFLICT", "Execution version already contains different content");
        if (!keyed) this.db.prepare("INSERT INTO symphony_publish_requests VALUES (?,?,?)").run(input.requestId,hash,existing.id);
        return { ...this.get(existing.id), replayed: true };
      }
      const currentTask = this.taskboard.getTask(task.id);
      if (currentTask.version !== input.expectedTaskVersion || currentTask.archivedAt) fail("VERSION_CONFLICT", "Refresh the original card before publishing a new execution version");
      const old = this.db.prepare("SELECT r.*,a.id attempt_id,a.stopped_at FROM symphony_current c JOIN symphony_releases r ON r.id=c.release_id LEFT JOIN symphony_attempts a ON a.release_id=r.id WHERE c.task_id=?").get(task.id);
      if (old && (old.todo_id !== e.todoId || old.package_id !== e.workPackageId || e.executionVersion <= old.execution_version)) fail("SYMPHONY_VERSION_CONFLICT", "New execution must advance the same work package");
      if (old?.attempt_id && !old.stopped_at) fail("SYMPHONY_EXECUTION_UNRESOLVED", "Previous execution has not been proved stopped");
      this.assertNoLegacyWork(); this.checkCapability(e); this.verifyInputs(e);
      const id = randomUUID(); const timestamp = now();
      this.db.prepare("INSERT INTO symphony_releases VALUES (?,?,?,?,?,?,?,?,?,?)").run(id,e.projectId,e.taskId,e.todoId,e.workPackageId,e.executionVersion,json,hash,canonicalJson(input.provenance),timestamp);
      this.db.prepare("INSERT INTO symphony_current VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET release_id=excluded.release_id").run(task.id,id);
      this.db.prepare("INSERT INTO symphony_publish_requests VALUES (?,?,?)").run(input.requestId,hash,id);
      this.db.prepare("UPDATE tasks SET status='todo',version=version+1,updated_at=? WHERE id=?").run(timestamp,task.id);
      return { ...this.get(id), replayed: false };
    });
  }
  get(id) {
    this.requireEnabled(); const r = this.db.prepare("SELECT * FROM symphony_releases WHERE id=? AND project_id=?").get(id,this.scope.projectId);
    if (!r) fail("SYMPHONY_NOT_FOUND", "Release is unavailable", 404);
    const a = this.db.prepare("SELECT * FROM symphony_attempts WHERE release_id=?").get(id);
    const current = this.db.prepare("SELECT 1 FROM symphony_current WHERE task_id=? AND release_id=?").get(r.task_id,id);
    const task = this.taskboard.getTask(r.task_id);
    const result = a?.result_json ? JSON.parse(a.result_json) : null;
    const state = !current ? "superseded" : result?.status ?? (task.archivedAt || task.status === "canceled" ? "canceled" : a ? a.stopped_at ? "failed" : "running" : task.status === "todo" ? "ready" : "blocked");
    return { releaseId:id, taskId:r.task_id, identifier:task.identifier, executionHash:r.execution_hash, execution:JSON.parse(r.execution_json), provenance:JSON.parse(r.provenance_json), publishedAt:r.published_at, state, current:Boolean(current), executable:state === "ready" && !a, attempt:a ? { id:a.id, schedulerInstanceId:a.scheduler_id, claimedAt:a.claimed_at, processState:a.stopped_at ? "stopped" : "unknown", stoppedAt:a.stopped_at, stopEvidence:a.stop_json ? JSON.parse(a.stop_json) : null, result } : null };
  }
  list({ projectId, ids, states, candidates = false }) {
    this.requireEnabled(); if (projectId !== this.scope.projectId) fail("SYMPHONY_SCOPE_MISMATCH", "Only the configured project is available", 403);
    return this.db.prepare("SELECT id FROM symphony_releases WHERE project_id=? ORDER BY published_at,id").all(projectId).map((r) => this.get(r.id)).filter((r) => (!ids || ids.includes(r.releaseId)) && (!states || states.includes(r.state)) && (!candidates || r.executable));
  }
  token(release, attempt) {
    return createHmac("sha256",this.secret).update(canonicalJson({ protocol:"symphony-claim.v1",projectId:release.execution.projectId,releaseId:release.releaseId,attemptId:attempt.id,claimRequestId:attempt.claim_request_id,schedulerInstanceId:attempt.scheduler_id,executionHash:release.executionHash })).digest("base64url");
  }
  claim(id, input) {
    fields(input,["requestId","executionHash","schedulerInstanceId"]); text(input.requestId,"requestId"); text(input.schedulerInstanceId,"schedulerInstanceId"); digest(input.executionHash);
    return this.transaction(() => {
      const release = this.get(id); const payloadHash = sha256(canonicalJson(input));
      let attempt = this.db.prepare("SELECT * FROM symphony_attempts WHERE release_id=?").get(id);
      if (attempt) {
        if (attempt.claim_payload_hash !== payloadHash) fail("SYMPHONY_ALREADY_CLAIMED", "Release has already consumed its single attempt");
        return { releaseId:id,attemptId:attempt.id,claimToken:this.token(release,attempt),executionHash:release.executionHash,replayed:true };
      }
      if (!release.executable || input.executionHash !== release.executionHash) fail("SYMPHONY_NOT_READY", "Release is not the current ready execution");
      this.checkCapability(release.execution); this.verifyInputs(release.execution);
      const workspaceKey = this.workspaceKey(release.execution.workspace.path);
      if (this.db.prepare("SELECT 1 FROM symphony_occupancy WHERE workspace_key=?").get(workspaceKey)) fail("SYMPHONY_WORKSPACE_BUSY", "Another unresolved attempt occupies this checkout");
      attempt = { id:randomUUID(),claim_request_id:input.requestId,scheduler_id:input.schedulerInstanceId };
      const token = this.token(release,attempt); const timestamp = now();
      this.db.prepare("INSERT INTO symphony_attempts (id,release_id,claim_request_id,claim_payload_hash,scheduler_id,token_hash,claimed_at) VALUES (?,?,?,?,?,?,?)").run(attempt.id,id,input.requestId,payloadHash,input.schedulerInstanceId,sha256(token),timestamp);
      this.db.prepare("INSERT INTO symphony_occupancy VALUES (?,?,?)").run(workspaceKey,attempt.id,timestamp);
      this.db.prepare("UPDATE tasks SET status='in_progress',version=version+1,updated_at=? WHERE id=?").run(timestamp,release.taskId);
      return { releaseId:id,attemptId:attempt.id,claimToken:token,executionHash:release.executionHash,replayed:false };
    });
  }
  claimReceipt(id, requestId, schedulerInstanceId) {
    const release=this.get(id); const a=this.db.prepare("SELECT * FROM symphony_attempts WHERE release_id=? AND claim_request_id=? AND scheduler_id=?").get(id,requestId,schedulerInstanceId);
    if (!a) fail("SYMPHONY_NOT_FOUND","Claim receipt is unavailable",404);
    return {releaseId:id,attemptId:a.id,claimToken:this.token(release,a),executionHash:release.executionHash,replayed:true};
  }
  finalize(id,input) {
    fields(input,["requestId","attemptId","claimToken","executionHash","kind","payload"]);
    text(input.requestId,"requestId"); if (!["result","stop"].includes(input.kind)) fail("SYMPHONY_INVALID_INPUT","Invalid finalize kind",400);
    return this.transaction(() => {
      const release=this.get(id); const a=this.db.prepare("SELECT * FROM symphony_attempts WHERE release_id=?").get(id);
      if (!a || a.id!==input.attemptId || release.executionHash!==input.executionHash || !safeEqual(sha256(String(input.claimToken)),a.token_hash)) fail("SYMPHONY_STALE_ATTEMPT","Result does not belong to this exact attempt",403);
      const hash=sha256(canonicalJson(input.payload)); const prior=this.db.prepare("SELECT * FROM symphony_receipts WHERE attempt_id=? AND (kind=? OR request_id=?)").get(a.id,input.kind,input.requestId);
      if (prior) {
        if(prior.kind!==input.kind || prior.request_id!==input.requestId || prior.payload_hash!==hash) fail("SYMPHONY_IDEMPOTENCY_CONFLICT","Finalization receipt changed");
        return {...JSON.parse(prior.receipt_json),replayed:true};
      }
      if(!release.current) fail("SYMPHONY_SUPERSEDED","Old execution cannot update the current card");
      const p=input.payload; const timestamp=now();
      if(input.kind==="result") {
        fields(p,["status","summary","artifacts","verification","requested","observed","sessionId","process","stopReason"]);
        if(!["in_review","failed","canceled"].includes(p.status)) fail("SYMPHONY_INVALID_INPUT","Workers cannot accept tasks",400);
        text(p.summary,"summary"); strings(p.verification,"verification",false);
        if(canonicalJson(p.requested)!==canonicalJson({model:release.execution.model,effort:release.execution.effort})) fail("SYMPHONY_RESULT_MISMATCH","Requested execution configuration changed");
        fields(p.observed,["model","effort"]); processIdentity(p.process);
        for (const key of ["model", "effort"]) if (p.observed[key] !== null) text(p.observed[key], `observed ${key}`);
        if (p.sessionId !== null) text(p.sessionId, "sessionId");
        text(p.stopReason, "stopReason");
        if(!Array.isArray(p.artifacts)) fail("SYMPHONY_INVALID_INPUT","Invalid artifacts",400);
        for(const artifact of p.artifacts) {
          fields(artifact,["path","sha256"]); relative(artifact.path); digest(artifact.sha256);
          if(!release.execution.artifacts.some((expected)=>expected.path===artifact.path)) fail("SYMPHONY_RESULT_MISMATCH","Unexpected artifact");
          const file=absolute(path.join(release.execution.workspace.path,artifact.path));
          if(!within(release.execution.workspace.path,file) || sha256(readFileSync(file))!==artifact.sha256) fail("SYMPHONY_RESULT_MISMATCH","Artifact content or scope changed");
        }
        if(p.status==="in_review" && (!p.verification.length || release.execution.artifacts.some((expected)=>expected.required&&!p.artifacts.some((artifact)=>artifact.path===expected.path)))) fail("SYMPHONY_RESULT_INCOMPLETE","Required artifacts and verification must be present");
        if(a.stop_json && canonicalJson(JSON.parse(a.stop_json).process)!==canonicalJson(p.process)) fail("SYMPHONY_PROCESS_MISMATCH","Result and stop refer to different processes");
        this.db.prepare("UPDATE symphony_attempts SET result_json=? WHERE id=?").run(canonicalJson(p),a.id);
        this.db.prepare("UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=?").run(p.status==="failed"?"blocked":p.status,timestamp,release.taskId);
        this.taskboard.appendSymphonyResultComment(release.taskId,`Symphony ${id} / attempt ${a.id}\nTodo ${release.execution.todoId} / steps ${release.execution.stepIds.join(", ")} / v${release.execution.executionVersion}\n${p.summary}\nRequested: ${p.requested.model} / ${p.requested.effort}; observed: ${p.observed.model??"unknown"} / ${p.observed.effort??"unknown"}\nSession: ${p.sessionId??"unknown"}\nProcess: wrapper ${p.process.wrapperPid}, child ${p.process.childPid??"not started"}, group ${p.process.processGroupId??"none"}; stopped: ${Boolean(a.stopped_at)} (separate stop receipt)\nArtifacts:\n${p.artifacts.map((artifact)=>`${path.join(release.execution.workspace.path,artifact.path)} (sha256 ${artifact.sha256})`).join("\n")}\nVerification: ${p.verification.join("; ")}\nStatus: ${p.status}; user acceptance pending.`);
      } else {
        fields(p,["state","observedAt","process","groupEmpty","descendants"]); processIdentity(p.process);
        if(p.state!=="stopped" || p.groupEmpty!==true || !Number.isFinite(Date.parse(p.observedAt)) || !Array.isArray(p.descendants) || p.descendants.some((d)=>d.alive!==false)) fail("SYMPHONY_STOP_UNPROVEN","Stop requires process group and descendant observations");
        for (const descendant of p.descendants) {
          fields(descendant, ["pid", "birth", "alive"]); integer(descendant.pid, "descendant pid"); text(descendant.birth, "descendant birth");
        }
        if(a.result_json && canonicalJson(JSON.parse(a.result_json).process)!==canonicalJson(p.process)) fail("SYMPHONY_PROCESS_MISMATCH","Result and stop refer to different processes");
        this.db.prepare("UPDATE symphony_attempts SET stopped_at=?,stop_json=? WHERE id=?").run(timestamp,canonicalJson(p),a.id);
        this.db.prepare("DELETE FROM symphony_occupancy WHERE attempt_id=?").run(a.id);
      }
      const receipt={releaseId:id,attemptId:a.id,kind:input.kind,requestId:input.requestId,payloadHash:hash,receivedAt:timestamp};
      this.db.prepare("INSERT INTO symphony_receipts VALUES (?,?,?,?,?)").run(a.id,input.kind,input.requestId,hash,canonicalJson(receipt));
      return {...receipt,replayed:false};
    });
  }
}
