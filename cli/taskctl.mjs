#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCloudUrl } from "../server/cloud-config.mjs";
import { normalizeRepository, normalizeStandingActions } from "../server/standing-authority.mjs";
import {
  DEFAULT_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
  isWorkingLogStatus,
} from "../shared/domain.mjs";

export const SCHEMA_VERSION = 2;
export const DEFAULT_API_URL = "http://127.0.0.1:47823";

const sourceRuntimeFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".data",
  "launcher-runtime.json",
);
const BOOLEAN_OPTIONS = new Set(["json", "clear-binding-thread", "clear-working-log", "help"]);
const GLOBAL_OPTIONS = new Set(["runtime-file"]);

const COMMAND_OPTIONS = new Map([
  ["project list", new Set(["json"])],
  ["project create", new Set(["id", "name", "workspace-path", "json"])],
  ["project map", new Set(["workspace-path", "json"])],
  ["project readme", new Set(["content", "file", "if-version", "json"])],
  ["authority list", new Set(["json"])],
  ["authority grant", new Set([
    "repository", "actions", "source-task", "source-thread-id", "evidence", "receipt",
    "granted-at", "expires-at", "json",
  ])],
  ["authority revoke", new Set(["evidence", "receipt", "json"])],
  ["coordinator status", new Set(["json"])],
  ["coordinator windows", new Set(["json"])],
  ["coordinator register-window", new Set([
    "role", "task", "label", "thread-id", "expected-revision", "idempotency-key", "json",
  ])],
  ["coordinator acquire", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "lease-seconds", "json",
  ])],
  ["coordinator renew", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "lease-seconds", "json",
  ])],
  ["coordinator release", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "json",
  ])],
  ["coordinator repair-binding", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "if-version", "json",
  ])],
  ["coordinator receipts", new Set(["json"])],
  ["owner-intent list", new Set(["json"])],
  ["domain-coordinator status", new Set(["json"])],
  ["domain-coordinator domains", new Set(["json"])],
  ["domain-coordinator configure", new Set([
    "label", "write-scope", "eligible-task", "holder-task", "holder-thread-id",
    "expected-lease-id", "expected-revision", "idempotency-key", "json",
  ])],
  ["domain-coordinator remove", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "expected-revision",
    "idempotency-key", "json",
  ])],
  ["domain-coordinator acquire", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "lease-seconds", "json",
  ])],
  ["domain-coordinator renew", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "lease-seconds", "json",
  ])],
  ["domain-coordinator release", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "json",
  ])],
  ["domain-coordinator receipts", new Set(["json"])],
  ["domain-todo status", new Set(["json"])],
  ["domain-todo assign", new Set([
    "domain", "holder-task", "holder-thread-id", "expected-lease-id", "if-version", "json",
  ])],
  ["domain-todo clear", new Set([
    "holder-task", "holder-thread-id", "expected-lease-id", "if-version", "json",
  ])],
  ["dependency-handoff status", new Set(["json"])],
  ["dependency-handoff accept", new Set([
    "source", "idempotency-key", "holder-task", "holder-thread-id", "expected-lease-id", "json",
  ])],
  ["activation audit", new Set(["json"])],
  ["activation apply-workflow-profile", new Set(["if-version", "json"])],
  ["cloud login", new Set(["url", "actor-name", "json"])],
  ["cloud status", new Set(["json"])],
  ["cloud logout", new Set(["json"])],
  ["issue list", new Set(["project", "status", "archived", "json"])],
  ["issue get", new Set(["json"])],
  ["issue bootstrap", new Set(["json"])],
  [
    "issue create",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "thread-id",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "working-log-path",
      "working-log-status",
      "workflow-profile",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "json",
    ]),
  ],
  [
    "issue update",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "working-log-path",
      "working-log-status",
      "clear-working-log",
      "workflow-profile",
      "binding-thread-id",
      "binding-codex-project-id",
      "binding-codex-project-kind",
      "binding-codex-host-id",
      "binding-workspace-path",
      "clear-binding-thread",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "if-version",
      "json",
    ]),
  ],
  ["issue move", new Set([
    "status",
    "thread-id",
    "binding-thread-id",
    "binding-codex-project-id",
    "binding-codex-project-kind",
    "binding-codex-host-id",
    "binding-workspace-path",
    "clear-binding-thread",
    "if-version",
    "json",
  ])],
  ["issue claim", new Set([
    "agent-path", "thread-id", "root-thread-id", "if-version", "lease-minutes", "write-scope",
    "admission-receipt-id", "admission-attempt-id", "json",
  ])],
  ["issue admission-defer", new Set([
    "root-thread-id", "expected-resume-token", "safe-action-id",
    "admission-receipt-id", "admission-attempt-id", "json",
  ])],
  ["issue admission-prepare", new Set([
    "root-thread-id", "expected-resume-token", "safe-action-id", "admission-receipt-id",
    "admission-attempt-id", "write-scope", "json",
  ])],
  ["issue archive", new Set(["thread-id", "if-version", "json"])],
  ["issue restore", new Set(["thread-id", "if-version", "json"])],
  ["issue relation", new Set(["type", "issue", "thread-id", "if-version", "json"])],
  ["run get", new Set(["json"])],
  ["run checkpoint", new Set(["summary", "next-action", "status", "thread-id", "if-version", "json"])],
  ["run finish", new Set(["summary", "next-action", "status", "thread-id", "if-version", "json"])],
  ["handoff list", new Set(["json"])],
  ["handoff add", new Set([
    "event-id", "idempotency-key", "parent-task", "agent-path", "thread-id", "sequence",
    "timestamp", "summary", "evidence-ref", "blocker", "next-action", "requires-ack",
    "causation-id", "correlation-id", "json",
  ])],
  ["handoff ack", new Set(["acknowledgement-id", "agent-path", "thread-id", "json"])],
  ["comment list", new Set(["after", "json"])],
  ["comment add", new Set([
    "body",
    "body-file",
    "thread-id",
    "binding-thread-id",
    "binding-codex-project-id",
    "binding-codex-project-kind",
    "binding-codex-host-id",
    "binding-workspace-path",
    "clear-binding-thread",
    "json",
  ])],
  ["comment update", new Set(["body", "thread-id", "if-version", "json"])],
  ["comment delete", new Set(["thread-id", "if-version", "json"])],
  ["attachment list", new Set(["task", "comment", "after", "json"])],
  ["attachment download", new Set(["output", "json"])],
  ["attachment upload", new Set(["file", "task", "comment", "content-type", "kind", "json"])],
  ["context current", new Set(["cwd", "json"])],
]);

const HELP_TEXT = new Map([
  ["", `Usage: taskctl RESOURCE ACTION [options]

Commands:
  context current [--cwd PATH] [--json]
  project list
  project create --name NAME [--id ID] [--workspace-path PATH]
  project map PROJECT_ID --workspace-path PATH
  project readme get [PROJECT_ID]
  project readme set [PROJECT_ID] (--content TEXT | --file FILE) [--if-version N]
  authority list PROJECT_ID
  authority grant PROJECT_ID --repository HOST/OWNER/REPO --actions ACTION[,ACTION]
    --source-task ISSUE_ID --source-thread-id ID --evidence TEXT --receipt ID
    --granted-at ISO [--expires-at ISO]
  authority revoke PROJECT_ID AUTHORITY_ID --evidence TEXT --receipt ID
  coordinator status PROJECT_ID
  coordinator windows PROJECT_ID
  coordinator register-window PROJECT_ID --role owner_root|coordinator --task TASK
    --label LABEL --thread-id THREAD --expected-revision SHA256 --idempotency-key KEY
  coordinator acquire PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id none|ID --lease-seconds N
  coordinator renew PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --lease-seconds N
  coordinator release PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID
  coordinator repair-binding PROJECT_ID ISSUE_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --if-version N
  coordinator receipts PROJECT_ID
  owner-intent list PROJECT_ID
  domain-coordinator status PROJECT_ID DOMAIN_ID
  domain-coordinator domains PROJECT_ID
  domain-coordinator configure PROJECT_ID DOMAIN_ID --label LABEL --write-scope PATH[,PATH]
    --eligible-task TASK[,TASK] --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --expected-revision SHA256 --idempotency-key KEY
  domain-coordinator remove PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --expected-revision SHA256 --idempotency-key KEY
  domain-coordinator acquire PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id none|ID --lease-seconds N
  domain-coordinator renew PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --lease-seconds N
  domain-coordinator release PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID
  domain-coordinator receipts PROJECT_ID DOMAIN_ID
  domain-todo status PROJECT_ID ISSUE_ID
  domain-todo assign PROJECT_ID ISSUE_ID --domain DOMAIN_ID
    --holder-task TASK --holder-thread-id THREAD --expected-lease-id ID --if-version N
  domain-todo clear PROJECT_ID ISSUE_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --if-version N
  activation audit
  activation apply-workflow-profile ISSUE_ID --if-version N
  cloud login --url URL --actor-name NAME
  cloud status|logout
  issue list|get|bootstrap|create|update|move|archive|restore|relation
  dependency-handoff status PROJECT_ID TARGET_ISSUE_ID
  dependency-handoff accept PROJECT_ID TARGET_ISSUE_ID --source SOURCE_ISSUE_ID
    --idempotency-key KEY --holder-task ID --holder-thread-id ID --expected-lease-id ID
  handoff list ISSUE_ID
  handoff add ISSUE_ID --event-id ID --idempotency-key KEY --agent-path /root/NAME
    --sequence N --summary TEXT --next-action TEXT --requires-ack true|false
  handoff ack EVENT_ID --acknowledgement-id ID --agent-path /root
  comment list ISSUE_ID [--after CURSOR]
  comment add ISSUE_ID (--body TEXT | --body-file FILE) [--thread-id ID]
  comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID]
  comment delete COMMENT_ID --if-version N [--thread-id ID]
  attachment list (--task ISSUE_ID | --comment COMMENT_ID) [--after CURSOR]
  attachment download ATTACHMENT_ID --output PATH
  attachment upload --file PATH (--task ISSUE_ID | --comment COMMENT_ID)

Global options:
  --runtime-file FILE  Use an explicit launcher runtime descriptor
  --json               Make the JSON output contract explicit
  --help               Show help for a supported command level

Examples:
  taskctl issue bootstrap LOCAL-275 --json
  taskctl run get RUN_ID --json
  taskctl comment list LOCAL-275 --json

Run taskctl issue --help, taskctl coordinator --help, taskctl activation --help, or taskctl run --help for command arguments.`],
  ["issue", `Usage: taskctl issue ACTION [arguments] [options]

Actions:
  list [--project PROJECT_ID] [--status STATUS] [--archived true|false|all] [--json]
  get ISSUE_ID [--json]
  bootstrap ISSUE_ID [--json]
  create --project PROJECT_ID --title TITLE
    [--description TEXT | --description-file FILE]
    [--status STATUS] [--priority PRIORITY] [--labels a,b]
    [--thread-id ID]
    [--git-branch BRANCH | --worktree-path PATH [--worktree-branch BRANCH]]
    [--working-log-path PATH --working-log-status planned|active|blocked|complete]
    [--workflow-profile formal|vibe]
    [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]
    [--recurrence-interval N --recurrence-unit day|week|month|year] [--json]
  update ISSUE_ID
    [--project PROJECT_ID] [--title TITLE]
    [--description TEXT | --description-file FILE]
    [--status STATUS] [--priority PRIORITY] [--labels a,b]
    [--git-branch BRANCH | --worktree-path PATH [--worktree-branch BRANCH]]
    [--working-log-path PATH --working-log-status planned|active|blocked|complete
     | --clear-working-log]
    [--workflow-profile formal|vibe]
    [--binding-thread-id ID
      [--binding-codex-project-id ID --binding-codex-project-kind local|remote
       --binding-codex-host-id ID --binding-workspace-path PATH]
     | --clear-binding-thread]
    [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]
    [--recurrence-interval N --recurrence-unit day|week|month|year]
    [--if-version N] [--json]
  move ISSUE_ID --status STATUS [--thread-id ID]
    [--binding-thread-id ID
      [--binding-codex-project-id ID --binding-codex-project-kind local|remote
       --binding-codex-host-id ID --binding-workspace-path PATH]
     | --clear-binding-thread]
    [--if-version N] [--json]
  archive ISSUE_ID [--thread-id ID] [--if-version N] [--json]
  claim ISSUE_ID --agent-path /root/NAME --thread-id ID
    --lease-minutes N --write-scope path[,path] [--root-thread-id ID]
    [--admission-receipt-id ID --admission-attempt-id ID]
    [--if-version N] [--json]
  admission-prepare ISSUE_ID --root-thread-id ID --expected-resume-token TOKEN
    --safe-action-id ID --admission-receipt-id ID --admission-attempt-id ID
    --write-scope path[,path] [--json]
  admission-defer ISSUE_ID --root-thread-id ID --expected-resume-token TOKEN
    --safe-action-id ID --admission-receipt-id ID --admission-attempt-id ID [--json]
  restore ISSUE_ID [--thread-id ID] [--if-version N] [--json]
  relation add|remove ISSUE_ID --type parent|blocks|blocked_by|related
    --issue RELATED_ISSUE_ID [--thread-id ID] [--if-version N] [--json]

Statuses: backlog, todo, in_progress, in_review, blocked, done, canceled
Priorities: none, urgent, high, medium, low

Example:
  taskctl issue bootstrap LOCAL-275 --json`],
  ["run", `Usage: taskctl run ACTION [arguments] [options]

Actions:
  get RUN_ID [--json]
  checkpoint RUN_ID --summary TEXT --next-action TEXT
    [--status active|blocked] --thread-id ID --if-version N [--json]
  finish RUN_ID --status completed|failed|interrupted --summary TEXT --next-action TEXT
    --thread-id ID --if-version N [--json]

Examples:
  taskctl run get RUN_ID --json
  taskctl run checkpoint RUN_ID --summary "Focused checks passed" --next-action "Open the capsule" --if-version 2 --json`],
  ["authority", `Usage: taskctl authority ACTION [arguments] [options]

Actions:
  list PROJECT_ID [--json]
  grant PROJECT_ID --repository HOST/OWNER/REPO --actions ACTION[,ACTION]
    --source-task ISSUE_ID --source-thread-id ID --evidence TEXT --receipt ID
    --granted-at ISO [--expires-at ISO] [--json]
  revoke PROJECT_ID AUTHORITY_ID --evidence TEXT --receipt ID [--json]

Actions: edit, test, scoped_delete, commit, ordinary_push, draft_pr`],
  ["coordinator", `Usage: taskctl coordinator ACTION PROJECT_ID [options]

Actions:
  status PROJECT_ID [--json]
  windows PROJECT_ID [--json]
  register-window PROJECT_ID --role owner_root|coordinator --task TASK --label LABEL
    --thread-id THREAD --expected-revision SHA256 --idempotency-key KEY [--json]
  acquire PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id none|ID --lease-seconds 30..3600 [--json]
  renew PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --lease-seconds 30..3600 [--json]
  release PROJECT_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID [--json]
  repair-binding PROJECT_ID ISSUE_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --if-version N [--json]
  receipts PROJECT_ID [--json]

Register-window derives host identity from the protected current Codex runtime; callers never supply it.
The holder task and thread must already be one exact configured Agent Lane binding.
Binding repair derives host identity from the protected current Codex runtime; callers never supply it.
Coordinator ownership does not grant task execution ownership.`],
  ["domain-coordinator", `Usage: taskctl domain-coordinator ACTION PROJECT_ID DOMAIN_ID [options]

Actions:
  status PROJECT_ID DOMAIN_ID [--json]
  domains PROJECT_ID [--json]
  configure PROJECT_ID DOMAIN_ID --label LABEL --write-scope PATH[,PATH]
    --eligible-task TASK[,TASK] --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --expected-revision SHA256 --idempotency-key KEY [--json]
  remove PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --expected-revision SHA256 --idempotency-key KEY [--json]
  acquire PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id none|ID --lease-seconds 30..3600 [--json]
  renew PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --lease-seconds 30..3600 [--json]
  release PROJECT_ID DOMAIN_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID [--json]
  receipts PROJECT_ID DOMAIN_ID [--json]

A domain lease delegates one configured disjoint source scope. It does not replace
the Global Coordinator, claim a Todo, grant mutation authority, or own shared runtime state.`],
  ["domain-todo", `Usage: taskctl domain-todo ACTION PROJECT_ID ISSUE_ID [options]

Actions:
  status PROJECT_ID ISSUE_ID [--json]
  assign PROJECT_ID ISSUE_ID --domain DOMAIN_ID --holder-task TASK
    --holder-thread-id THREAD --expected-lease-id ID --if-version N [--json]
  clear PROJECT_ID ISSUE_ID --holder-task TASK --holder-thread-id THREAD
    --expected-lease-id ID --if-version N [--json]

Only the exact active Global Coordinator lease may assign an unclaimed Agent Todo.
Assigned claims must pass --root-thread-id for the current domain coordinator route.`],
  ["activation", `Usage: taskctl activation ACTION [arguments] [options]

Actions:
  audit [--json]
  apply-workflow-profile ISSUE_ID --if-version N [--json]

Audit is read-only. Apply accepts only one recorded legacy candidate and is
optimistic and idempotent. Legacy Root bindings remain a separate coordinator
repair-binding action.`],
  ["handoff", `Usage: taskctl handoff ACTION [arguments] [options]

Actions:
  list ISSUE_ID [--json]
  add ISSUE_ID --event-id ID --idempotency-key KEY --agent-path /root/NAME
    --sequence N [--timestamp ISO] --summary TEXT [--evidence-ref REF[,REF]]
    [--blocker TEXT] --next-action TEXT --requires-ack true|false
    [--parent-task ISSUE_ID] [--causation-id ID] [--correlation-id ID]
    [--thread-id ID] [--json]
  ack EVENT_ID --acknowledgement-id ID --agent-path /root [--thread-id ID] [--json]

Handoff add uses CODEX_THREAD_ID unless --thread-id is explicit. Omit --parent-task
when the durable task has no parent relation.`],
  ["comment list", `Usage: taskctl comment list ISSUE_ID [--after CURSOR] [--json]

Options:
  --after CURSOR  Return comments created or modified after a prior nextCursor
  --json          Make the JSON output contract explicit
  --help          Show this help

The response always includes nextCursor. Omit --after for the full list.

Example:
  taskctl comment list LOCAL-275 --after CURSOR --json`],
]);

class TaskctlError extends Error {
  constructor(message, { code = "TASKCTL_ERROR", exitCode = 2, details } = {}) {
    super(message);
    this.name = "TaskctlError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("argv must be an array");
  }

  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!name) {
      throw usageError("Invalid empty option");
    }

    if (Object.hasOwn(options, name)) {
      throw usageError(`Option --${name} may only be specified once`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (equalsIndex !== -1) {
        throw usageError(`Option --${name} does not accept a value`);
      }
      options[name] = true;
      continue;
    }

    if (equalsIndex !== -1) {
      options[name] = token.slice(equalsIndex + 1);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Option --${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  return {
    resource: positionals[0],
    action: positionals[1],
    operands: positionals.slice(2),
    options,
  };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;

  try {
    const parsed = parseArgs(argv);
    if (parsed.options.help) {
      const scope = `${parsed.resource ?? ""} ${parsed.action ?? ""}`.trim();
      const help = HELP_TEXT.get(scope);
      if (!help || parsed.operands.length > 0 || Object.keys(parsed.options).length !== 1) {
        throw usageError("Help is available for taskctl, taskctl authority, taskctl coordinator, taskctl issue, taskctl run, taskctl handoff, and taskctl comment list");
      }
      stdout.write(`${help}\n`);
      return 0;
    }
    const result = await execute(parsed, overrides);
    writeJson(stdout, { ...result, schemaVersion: SCHEMA_VERSION });
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    if (normalized.details !== undefined) {
      payload.error.details = normalized.details;
    }
    writeJson(stderr, payload);
    return normalized.exitCode;
  }
}

async function execute(parsed, overrides) {
  const command = `${parsed.resource ?? ""} ${parsed.action ?? ""}`.trim();
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (!allowedOptions) {
    throw usageError(
      "Expected one of: project list/create/map/readme, authority list/grant/revoke, coordinator status/windows/register-window/acquire/renew/release/repair-binding/receipts, domain-coordinator status/domains/configure/remove/acquire/renew/release/receipts, domain-todo status/assign/clear, activation audit/apply-workflow-profile, cloud login/status/logout, issue list/get/bootstrap/create/update/move/claim/archive/restore/relation, run get/checkpoint/finish, handoff list/add/ack, comment list/add/update/delete, attachment list/download/upload, context current",
    );
  }
  validateOptions(parsed.options, allowedOptions);

  const processEnv = overrides.env ?? process.env;
  const env = parsed.options["runtime-file"] === undefined
    ? processEnv
    : { ...processEnv, CODEX_TASKBOARD_RUNTIME_FILE: parsed.options["runtime-file"] };
  const usesCompanionControl = command.startsWith("cloud ")
    || command === "project map"
    || command.startsWith("owner-intent ")
    || command.startsWith("coordinator ")
    || command.startsWith("domain-coordinator ")
    || command.startsWith("domain-todo ")
    || command.startsWith("dependency-handoff ")
    || command.startsWith("activation ");
  const api = createApiClient(overrides, {
    baseUrl: usesCompanionControl || env.CODEX_TASKBOARD_COMPANION_URL !== undefined
      ? await resolveCompanionUrl(env, overrides)
      : await resolveTaskboardBaseUrl(env, overrides),
  });
  switch (command) {
    case "project list":
      expectOperandCount(parsed, 0);
      return api.request("GET", "/api/projects");
    case "project create":
      expectOperandCount(parsed, 0);
      return api.request("POST", "/api/projects", {
        ...optionalField("id", parsed.options.id),
        name: requiredOption(parsed.options, "name"),
        ...optionalField(
          "workspacePath",
          parsed.options["workspace-path"] === undefined
            ? undefined
            : resolveInputPath(parsed.options["workspace-path"], overrides),
        ),
      });
    case "project map":
      expectOperandCount(parsed, 1);
      return api.request(
        "PUT",
        `/api/local/project-mappings/${encodeURIComponent(parsed.operands[0])}`,
        {
          workspacePath: resolveInputPath(
            requiredOption(parsed.options, "workspace-path"),
            overrides,
          ),
        },
      );
    case "project readme":
      return executeProjectReadme(api, parsed, overrides);
    case "authority list":
      expectOperandCount(parsed, 1);
      return api.request("GET", projectStandingAuthoritiesPath(parsed.operands[0]));
    case "authority grant": {
      expectOperandCount(parsed, 1);
      const repository = normalizeRepository(requiredOption(parsed.options, "repository"));
      const actions = normalizeStandingActions(
        requiredOption(parsed.options, "actions").split(",").map((value) => value.trim()),
      );
      if (!repository || !actions) {
        throw usageError("Standing authority requires a normalized repository and unique supported actions");
      }
      return api.request("POST", projectStandingAuthoritiesPath(parsed.operands[0]), {
        repository,
        actions,
        sourceTaskId: requiredOption(parsed.options, "source-task"),
        sourceThreadId: requiredOption(parsed.options, "source-thread-id"),
        evidence: requiredOption(parsed.options, "evidence"),
        receipt: requiredOption(parsed.options, "receipt"),
        grantedAt: requiredOption(parsed.options, "granted-at"),
        ...optionalField("expiresAt", parsed.options["expires-at"]),
      });
    }
    case "authority revoke":
      expectOperandCount(parsed, 2);
      return api.request(
        "POST",
        `${projectStandingAuthoritiesPath(parsed.operands[0])}/${encodeURIComponent(parsed.operands[1])}/revoke`,
        {
          evidence: requiredOption(parsed.options, "evidence"),
          receipt: requiredOption(parsed.options, "receipt"),
        },
      );
    case "coordinator status": {
      expectOperandCount(parsed, 1);
      const projectId = parsed.operands[0];
      try {
        const snapshot = await api.request("GET", agentLaneProjectPath(projectId));
        return { projectId, coordination: snapshot.coordination ?? null };
      } catch (error) {
        if (!(error instanceof TaskctlError)
          || error.code !== "AGENT_LANES_NOT_CONFIGURED") throw error;
        const windows = await api.request("GET", coordinationWindowsPath(projectId));
        const lease = windows.coordinatorLease ?? null;
        const active = lease && !lease.releasedAt
          && typeof lease.expiresAt === "string"
          && Date.parse(lease.expiresAt) > Date.now();
        if (active) throw error;
        return {
          projectId,
          coordination: {
            assignment: "unassigned",
            coordinatorTaskId: null,
            coordinatorThreadId: null,
            lease: lease ? {
              ...lease,
              status: "expired",
            } : null,
          },
        };
      }
    }
    case "coordinator windows":
      expectOperandCount(parsed, 1);
      return api.request("GET", coordinationWindowsPath(parsed.operands[0]));
    case "coordinator register-window":
      expectOperandCount(parsed, 1);
      return registerCoordinationWindow(api, parsed.operands[0], parsed.options);
    case "owner-intent list": {
      expectOperandCount(parsed, 1);
      return api.request("GET", ownerIntentProjectPath(parsed.operands[0]));
    }
    case "coordinator acquire":
      expectOperandCount(parsed, 1);
      return mutateCoordinatorLease(
        api,
        parsed.operands[0],
        parsed.options,
        expectedCoordinatorLeaseId(parsed.options, { allowNone: true }),
      );
    case "coordinator renew":
      expectOperandCount(parsed, 1);
      return mutateCoordinatorLease(
        api,
        parsed.operands[0],
        parsed.options,
        expectedCoordinatorLeaseId(parsed.options),
      );
    case "coordinator release":
      expectOperandCount(parsed, 1);
      return releaseCoordinatorLease(api, parsed.operands[0], parsed.options);
    case "coordinator repair-binding":
      expectOperandCount(parsed, 2);
      return repairLegacyRootBinding(
        api,
        parsed.operands[0],
        parsed.operands[1],
        parsed.options,
      );
    case "coordinator receipts":
      expectOperandCount(parsed, 1);
      return api.request("GET", `${coordinatorLeasePath(parsed.operands[0])}/receipts`);
    case "domain-coordinator status": {
      expectOperandCount(parsed, 2);
      const snapshot = await api.request("GET", agentLaneProjectPath(parsed.operands[0]));
      return {
        projectId: parsed.operands[0],
        domainId: parsed.operands[1],
        domainCoordinator: snapshot.coordination?.domainCoordinators?.find(
          (domain) => domain.domainId === parsed.operands[1],
        ) ?? null,
      };
    }
    case "domain-coordinator domains":
      expectOperandCount(parsed, 1);
      return api.request("GET", coordinationDomainsPath(parsed.operands[0]));
    case "domain-coordinator configure":
      expectOperandCount(parsed, 2);
      return configureCoordinationDomain(api, parsed.operands[0], parsed.operands[1], parsed.options);
    case "domain-coordinator remove":
      expectOperandCount(parsed, 2);
      return removeCoordinationDomain(api, parsed.operands[0], parsed.operands[1], parsed.options);
    case "domain-coordinator acquire":
      expectOperandCount(parsed, 2);
      return mutateDomainCoordinatorLease(
        api, parsed.operands[0], parsed.operands[1], parsed.options,
        expectedCoordinatorLeaseId(parsed.options, { allowNone: true }),
      );
    case "domain-coordinator renew":
      expectOperandCount(parsed, 2);
      return mutateDomainCoordinatorLease(
        api, parsed.operands[0], parsed.operands[1], parsed.options,
        expectedCoordinatorLeaseId(parsed.options),
      );
    case "domain-coordinator release":
      expectOperandCount(parsed, 2);
      return releaseDomainCoordinatorLease(api, parsed.operands[0], parsed.operands[1], parsed.options);
    case "domain-coordinator receipts":
      expectOperandCount(parsed, 2);
      return api.request("GET", `${domainCoordinatorLeasePath(parsed.operands[0], parsed.operands[1])}/receipts`);
    case "domain-todo status":
      expectOperandCount(parsed, 2);
      return api.request("GET", domainTodoAssignmentPath(parsed.operands[0], parsed.operands[1]));
    case "domain-todo assign":
      expectOperandCount(parsed, 2);
      return api.request("POST", domainTodoAssignmentPath(parsed.operands[0], parsed.operands[1]), {
        domainId: requiredOption(parsed.options, "domain"),
        taskVersion: explicitVersion(parsed.options["if-version"]),
        ...coordinatorHolder(parsed.options),
        expectedCoordinatorLeaseId: expectedCoordinatorLeaseId(parsed.options),
      });
    case "domain-todo clear":
      expectOperandCount(parsed, 2);
      return api.request("DELETE", domainTodoAssignmentPath(parsed.operands[0], parsed.operands[1]), {
        taskVersion: explicitVersion(parsed.options["if-version"]),
        ...coordinatorHolder(parsed.options),
        expectedCoordinatorLeaseId: expectedCoordinatorLeaseId(parsed.options),
      });
    case "dependency-handoff status":
      expectOperandCount(parsed, 2);
      return api.request("GET", crossDomainDependencyClearancePath(parsed.operands[0], parsed.operands[1]));
    case "dependency-handoff accept":
      expectOperandCount(parsed, 2);
      return api.request("POST", crossDomainDependencyClearancePath(parsed.operands[0], parsed.operands[1]), {
        sourceTaskId: requiredOption(parsed.options, "source"),
        idempotencyKey: requiredOption(parsed.options, "idempotency-key"),
        ...coordinatorHolder(parsed.options),
        expectedTargetDomainLeaseId: expectedCoordinatorLeaseId(parsed.options),
      });
    case "activation audit":
      expectOperandCount(parsed, 0);
      return api.request("GET", "/api/local/activation-readiness");
    case "activation apply-workflow-profile":
      expectOperandCount(parsed, 1);
      return api.request(
        "POST",
        `/api/local/activation-readiness/workflow-profiles/${encodeURIComponent(parsed.operands[0])}`,
        { version: explicitVersion(parsed.options["if-version"]) },
      );
    case "cloud login":
      expectOperandCount(parsed, 0);
      return cloudLogin(
        api,
        requiredOption(parsed.options, "url"),
        requiredOption(parsed.options, "actor-name"),
        overrides,
      );
    case "cloud status":
      expectOperandCount(parsed, 0);
      return api.request("GET", "/api/local/cloud-session");
    case "cloud logout":
      expectOperandCount(parsed, 0);
      return api.request("DELETE", "/api/local/cloud-session");
    case "issue list":
      expectOperandCount(parsed, 0);
      return listIssues(api, parsed.options);
    case "issue get":
      expectOperandCount(parsed, 1);
      return api.request("GET", taskPath(parsed.operands[0]));
    case "issue bootstrap":
      expectOperandCount(parsed, 1);
      return api.request("GET", `${taskPath(parsed.operands[0])}/capsule`);
    case "issue create":
      expectOperandCount(parsed, 0);
      return createIssue(api, parsed.options, overrides);
    case "issue update":
      expectOperandCount(parsed, 1);
      return updateIssue(api, parsed.operands[0], parsed.options, overrides);
    case "issue move":
      expectOperandCount(parsed, 1);
      return moveIssue(api, parsed.operands[0], parsed.options, overrides);
    case "issue claim":
      expectOperandCount(parsed, 1);
      return claimIssue(api, parsed.operands[0], parsed.options, overrides);
    case "issue admission-defer":
      expectOperandCount(parsed, 1);
      return deferIssueAdmission(api, parsed.operands[0], parsed.options);
    case "issue admission-prepare":
      expectOperandCount(parsed, 1);
      return prepareIssueAdmission(api, parsed.operands[0], parsed.options);
    case "issue archive":
      expectOperandCount(parsed, 1);
      return archiveIssue(api, parsed.operands[0], parsed.options, overrides, "archive");
    case "issue restore":
      expectOperandCount(parsed, 1);
      return archiveIssue(api, parsed.operands[0], parsed.options, overrides, "restore");
    case "issue relation":
      expectOperandCount(parsed, 2);
      return mutateIssueRelation(
        api,
        parsed.operands[0],
        parsed.operands[1],
        parsed.options,
        overrides,
      );
    case "run get":
      expectOperandCount(parsed, 1);
      return api.request("GET", agentRunPath(parsed.operands[0]));
    case "run checkpoint":
      expectOperandCount(parsed, 1);
      return checkpointAgentRun(api, parsed.operands[0], parsed.options, overrides);
    case "run finish":
      expectOperandCount(parsed, 1);
      return finishAgentRun(api, parsed.operands[0], parsed.options, overrides);
    case "handoff list":
      expectOperandCount(parsed, 1);
      return api.request("GET", `${taskPath(parsed.operands[0])}/coordination-events`);
    case "handoff add":
      expectOperandCount(parsed, 1);
      return addTaskHandoff(api, parsed.operands[0], parsed.options, overrides);
    case "handoff ack":
      expectOperandCount(parsed, 1);
      return acknowledgeTaskHandoff(api, parsed.operands[0], parsed.options, overrides);
    case "comment list": {
      expectOperandCount(parsed, 1);
      const search = new URLSearchParams();
      if (parsed.options.after !== undefined) search.set("after", parsed.options.after);
      const query = search.size > 0 ? `?${search}` : "";
      return api.request("GET", `${taskPath(parsed.operands[0])}/comments${query}`);
    }
    case "comment add": {
      expectOperandCount(parsed, 1);
      if (parsed.options.body !== undefined && parsed.options["body-file"] !== undefined) {
        throw usageError("Use either --body or --body-file, not both");
      }
      let body;
      if (parsed.options["body-file"] === undefined) {
        body = requiredOption(parsed.options, "body");
      } else {
        const read = overrides.readFile ?? readFile;
        try {
          body = await read(parsed.options["body-file"], "utf8");
        } catch (error) {
          throw new TaskctlError(`Cannot read comment body file: ${parsed.options["body-file"]}`, {
            code: "FILE_READ_FAILED",
            exitCode: 2,
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return api.request("POST", `${taskPath(parsed.operands[0])}/comments`, {
        body,
        threadId: resolveThreadId(parsed.options, overrides),
        ...optionalField("threadBinding", threadBindingFromOptions(parsed.options)),
      });
    }
    case "comment update":
      expectOperandCount(parsed, 1);
      return api.request("PATCH", commentPath(parsed.operands[0]), {
        body: requiredOption(parsed.options, "body"),
        threadId: resolveThreadId(parsed.options, overrides),
        version: explicitVersion(parsed.options["if-version"]),
      });
    case "comment delete":
      expectOperandCount(parsed, 1);
      return api.request("DELETE", commentPath(parsed.operands[0]), {
        threadId: resolveThreadId(parsed.options, overrides),
        version: explicitVersion(parsed.options["if-version"]),
      });
    case "attachment list": {
      expectOperandCount(parsed, 0);
      const taskId = parsed.options.task;
      const commentId = parsed.options.comment;
      if (Boolean(taskId) === Boolean(commentId)) {
        throw usageError("attachment list requires exactly one of --task or --comment");
      }
      const search = new URLSearchParams();
      if (parsed.options.after !== undefined) search.set("after", parsed.options.after);
      const query = search.size > 0 ? `?${search}` : "";
      const pathname = taskId
        ? `${taskPath(taskId)}/attachments`
        : `${commentPath(commentId)}/attachments`;
      return api.request("GET", `${pathname}${query}`);
    }
    case "attachment download":
      expectOperandCount(parsed, 1);
      return downloadAttachment(api, parsed.operands[0], parsed.options, overrides);
    case "attachment upload":
      expectOperandCount(parsed, 0);
      return uploadAttachment(api, parsed.options, overrides);
    case "context current":
      expectOperandCount(parsed, 0);
      return currentContext(api, parsed.options, overrides);
    default:
      throw usageError(`Unsupported command: ${command}`);
  }
}

function createApiClient(overrides, { baseUrl: explicitBaseUrl } = {}) {
  const fetchImplementation = overrides.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TaskctlError("fetch is not available", {
      code: "CLIENT_UNAVAILABLE",
      exitCode: 3,
    });
  }

  const env = overrides.env ?? process.env;
  const baseUrl = normalizeBaseUrl(explicitBaseUrl ?? DEFAULT_API_URL);

  return {
    waitForRetry: overrides.waitForRetry ?? ((milliseconds) => (
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    )),
    async request(method, pathname, body) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          method,
          headers: {
            accept: "application/json",
            "x-taskboard-client": "taskctl",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      const payload = await readResponse(response);
      if (!response.ok) {
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TaskctlError("Taskboard service returned an invalid JSON response", {
          code: "INVALID_RESPONSE",
          exitCode: 4,
        });
      }
      return payload;
    },
    async download(pathname) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          headers: {
            accept: "*/*",
            "x-taskboard-client": "taskctl",
          },
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      if (!response.ok) {
        const payload = await readResponse(response);
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        contentType: response.headers.get("content-type"),
        size: Number(response.headers.get("content-length")) || bytes.byteLength,
      };
    },
    async upload(pathname, { body, contentType, filename, kind }) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": contentType,
            "x-taskboard-client": "taskctl",
            "x-taskboard-filename": encodeURIComponent(filename),
            "x-taskboard-attachment-kind": kind,
          },
          body,
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      const payload = await readResponse(response);
      if (!response.ok) {
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TaskctlError("Taskboard service returned an invalid JSON response", {
          code: "INVALID_RESPONSE",
          exitCode: 4,
        });
      }
      return payload;
    },
  };
}

async function downloadAttachment(api, attachmentId, options, overrides) {
  const output = resolveInputPath(requiredOption(options, "output"), overrides);
  const downloaded = await api.download(attachmentContentPath(attachmentId));
  const write = overrides.writeFile ?? writeFile;
  try {
    await write(output, downloaded.bytes);
  } catch (error) {
    throw new TaskctlError(`Cannot write attachment file: ${output}`, {
      code: "FILE_WRITE_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    attachmentId,
    output,
    contentType: downloaded.contentType,
    size: downloaded.size,
  };
}

async function uploadAttachment(api, options, overrides) {
  const taskId = options.task;
  const commentId = options.comment;
  if (Boolean(taskId) === Boolean(commentId)) {
    throw usageError("attachment upload requires exactly one of --task or --comment");
  }

  const filePath = resolveInputPath(requiredOption(options, "file"), overrides);
  const read = overrides.readFile ?? readFile;
  let bytes;
  try {
    bytes = await read(filePath);
  } catch (error) {
    throw new TaskctlError(`Cannot read attachment file: ${filePath}`, {
      code: "FILE_READ_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const filename = path.basename(filePath);
  if (!filename || filename === "." || filename === "..") {
    throw usageError("Attachment --file must include a valid filename");
  }

  const contentType = options["content-type"]
    ? String(options["content-type"]).trim().toLowerCase()
    : guessContentType(filename);
  if (!contentType) {
    throw usageError("--content-type cannot be empty");
  }
  const kind = options.kind ?? (contentType.startsWith("image/") ? "inline" : "attachment");
  if (kind !== "inline" && kind !== "attachment") {
    throw usageError("--kind must be inline or attachment");
  }

  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pathname = taskId
    ? `${taskPath(taskId)}/attachments`
    : `${commentPath(commentId)}/attachments`;
  const payload = await api.upload(pathname, {
    body,
    contentType,
    filename,
    kind,
  });

  return {
    attachment: payload.attachment ?? null,
    file: filePath,
    kind,
    target: taskId
      ? { type: "task", id: taskId }
      : { type: "comment", id: commentId },
  };
}

function guessContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

async function executeProjectReadme(api, parsed, overrides) {
  const operands = parsed.operands;
  const firstOperand = operands[0];
  const isExplicitSet = firstOperand === "set";
  const isExplicitGet = firstOperand === "get";
  const isOptionSet = parsed.options.content !== undefined || parsed.options.file !== undefined;
  const isSet = isExplicitSet || (!isExplicitGet && isOptionSet);

  let rawProjectId;
  if (isExplicitSet || isExplicitGet) {
    if (operands.length > 2) {
      throw usageError(`project readme ${firstOperand} accepts at most 1 positional argument (project id)`);
    }
    rawProjectId = operands[1];
  } else {
    if (operands.length > 1) {
      throw usageError("project readme accepts at most 1 positional argument (project id)");
    }
    rawProjectId = operands[0];
  }

  let projectId = rawProjectId;
  if (!projectId) {
    const context = await currentContext(api, {}, overrides);
    projectId = context.project?.id ?? DEFAULT_PROJECT_ID;
  }

  if (isSet) {
    let content = parsed.options.content;
    if (content !== undefined && parsed.options.file !== undefined) {
      throw usageError("Use either --content or --file, not both");
    }
    if (parsed.options.file !== undefined) {
      const read = overrides.readFile ?? readFile;
      try {
        content = await read(parsed.options.file, "utf8");
      } catch (error) {
        throw new TaskctlError(`Cannot read file: ${parsed.options.file}`, {
          code: "FILE_READ_FAILED",
          exitCode: 2,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (content === undefined) {
      throw usageError("project readme set requires --content or --file");
    }
    const ifVersion = parsed.options["if-version"] !== undefined
      ? explicitVersion(parsed.options["if-version"], { allowZero: true })
      : undefined;
    return api.request("PUT", `/api/projects/${encodeURIComponent(projectId)}/readme`, {
      content,
      ...(ifVersion !== undefined ? { version: ifVersion } : {}),
    });
  }

  if (parsed.options.content !== undefined || parsed.options.file !== undefined || parsed.options["if-version"] !== undefined) {
    throw usageError("project readme get does not accept --content, --file, or --if-version");
  }

  return api.request("GET", `/api/projects/${encodeURIComponent(projectId)}/readme`);
}

async function cloudLogin(api, rawUrl, actorName, overrides) {
  let remoteUrl;
  try {
    remoteUrl = normalizeCloudUrl(rawUrl);
  } catch (error) {
    throw new TaskctlError(error instanceof Error ? error.message : String(error), {
      code: error?.code ?? "INVALID_CLOUD_URL",
      exitCode: 2,
    });
  }
  const sharedKey = overrides.readSecret
    ? await overrides.readSecret()
    : await readSecretFromInput(
      overrides.stdin ?? process.stdin,
      overrides.stderr ?? process.stderr,
    );
  if (typeof sharedKey !== "string" || !sharedKey) {
    throw usageError("Cloud shared key cannot be empty");
  }
  return api.request("PUT", "/api/local/cloud-session", {
    remoteUrl,
    actorName,
    sharedKey,
  });
}

async function readSecretFromInput(input, output) {
  if (!input.isTTY) {
    let value = "";
    for await (const chunk of input) value += chunk;
    return value.replace(/\r?\n$/, "");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") {
          return finish(new TaskctlError("Cloud login canceled", {
            code: "CANCELED",
            exitCode: 2,
          }));
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    output.write("Shared key: ");
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}

async function listIssues(api, options) {
  if (options.status !== undefined) {
    assertStatus(options.status);
  }
  if (options.archived !== undefined && !["true", "false", "all"].includes(options.archived)) {
    throw usageError("--archived must be true, false, or all");
  }
  const search = new URLSearchParams();
  if (options.project !== undefined) search.set("projectId", options.project);
  if (options.status !== undefined) search.set("status", options.status);
  if (options.archived !== undefined) search.set("archived", options.archived);
  const query = search.size > 0 ? `?${search}` : "";
  return api.request("GET", `/api/tasks${query}`);
}

async function createIssue(api, options, overrides) {
  const status = options.status ?? "backlog";
  const priority = options.priority ?? "none";
  assertStatus(status);
  assertPriority(priority);
  if (options["workflow-profile"] !== undefined) assertWorkflowProfile(options["workflow-profile"]);

  const developmentContext = developmentContextFromOptions(options, overrides);
  const workingLog = workingLogFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  const threadId = resolveThreadId(options, overrides);
  return api.request("POST", "/api/tasks", {
    projectId: requiredOption(options, "project"),
    title: requiredOption(options, "title"),
    description: await resolveDescription(options, overrides),
    status,
    priority,
    labels: parseLabels(options.labels),
    ...optionalField("workflowProfile", options["workflow-profile"]),
    threadId,
    ...optionalField("developmentContext", developmentContext),
    ...optionalField("workingLog", workingLog),
    ...optionalField("startDate", options["start-date"]),
    ...optionalField("dueDate", options["due-date"]),
    ...optionalField("recurrence", recurrence),
  });
}

async function updateIssue(api, taskId, options, overrides) {
  if (options.status !== undefined) assertStatus(options.status);
  if (options.priority !== undefined) assertPriority(options.priority);
  if (options["workflow-profile"] !== undefined) assertWorkflowProfile(options["workflow-profile"]);

  const developmentContext = developmentContextFromOptions(options, overrides);
  const workingLog = workingLogFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  const threadBinding = threadBindingFromOptions(options);
  const patch = {
    ...optionalField("projectId", options.project),
    ...optionalField("title", options.title),
    ...optionalField("status", options.status),
    ...optionalField("priority", options.priority),
    ...optionalField("labels", options.labels === undefined ? undefined : parseLabels(options.labels)),
    ...optionalField("developmentContext", developmentContext),
    ...optionalField("workingLog", workingLog),
    ...optionalField("workflowProfile", options["workflow-profile"]),
    ...optionalField("threadBinding", threadBinding),
    ...optionalField("startDate", options["start-date"]),
    ...optionalField("dueDate", options["due-date"]),
    ...optionalField("recurrence", recurrence),
  };
  if (options.description !== undefined || options["description-file"] !== undefined) {
    patch.description = await resolveDescription(options, overrides);
  }

  if (Object.keys(patch).length === 0) {
    throw usageError("issue update requires at least one field to update");
  }
  patch.version = await resolveVersion(api, taskId, options["if-version"]);
  return api.request("PATCH", taskPath(taskId), patch);
}

async function moveIssue(api, taskId, options, overrides) {
  const status = requiredOption(options, "status");
  assertStatus(status);
  const threadId = resolveThreadId(options, overrides);
  const threadBinding = threadBindingFromOptions(options);
  return api.request("POST", `${taskPath(taskId)}/move`, {
    status,
    threadId,
    ...optionalField("threadBinding", threadBinding),
    version: await resolveVersion(api, taskId, options["if-version"]),
  });
}

function threadBindingFromOptions(options) {
  const fields = [
    options["binding-thread-id"],
    options["binding-codex-project-id"],
    options["binding-codex-project-kind"],
    options["binding-codex-host-id"],
    options["binding-workspace-path"],
  ];
  if (options["clear-binding-thread"]) {
    if (fields.some((field) => field !== undefined)) {
      throw usageError("--clear-binding-thread cannot be combined with binding identity options");
    }
    return null;
  }
  if (fields.every((field) => field === undefined)) return undefined;
  const threadId = requiredOption(options, "binding-thread-id").trim();
  if (!threadId || threadId.length > 256) {
    throw usageError("--binding-thread-id must contain 1 to 256 characters");
  }
  const identityFields = fields.slice(1);
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw usageError("Binding identity requires project id, kind, host id, and workspace path");
  }
  const codexProjectId = options["binding-codex-project-id"].trim();
  const codexProjectKind = options["binding-codex-project-kind"];
  const codexHostId = options["binding-codex-host-id"].trim();
  const workspacePath = options["binding-workspace-path"];
  if (!codexProjectId || codexProjectId.length > 256) {
    throw usageError("--binding-codex-project-id must contain 1 to 256 characters");
  }
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw usageError("--binding-codex-project-kind must be local or remote");
  }
  if (
    !codexHostId
    || codexHostId.length > 256
    || (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
  ) {
    throw usageError("--binding-codex-host-id does not match the project kind");
  }
  if (!path.posix.isAbsolute(workspacePath) && !path.win32.isAbsolute(workspacePath)) {
    throw usageError("--binding-workspace-path must be absolute");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

async function claimIssue(api, taskId, options, overrides) {
  const agentPath = requiredOption(options, "agent-path");
  if (!agentPath.startsWith("/root/")) throw usageError("--agent-path must start with /root/");
  const leaseMinutes = Number(requiredOption(options, "lease-minutes"));
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > 1440) {
    throw usageError("--lease-minutes must be an integer from 1 to 1440");
  }
  const writeScope = requiredOption(options, "write-scope")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (writeScope.length === 0 || writeScope.length > 32 || writeScope.some((value) => value.length > 240)) {
    throw usageError("--write-scope must contain 1 to 32 comma-separated paths");
  }
  if (Boolean(options["admission-receipt-id"]) !== Boolean(options["admission-attempt-id"])) {
    throw usageError("--admission-receipt-id and --admission-attempt-id must be supplied together");
  }
  return api.request("POST", `${taskPath(taskId)}/claim`, {
    agentPath,
    agentThreadId: resolveThreadId(options, overrides),
    ...(options["root-thread-id"] ? { rootThreadId: options["root-thread-id"] } : {}),
    leaseExpiresAt: new Date(Date.now() + leaseMinutes * 60_000).toISOString(),
    writeScope,
    ...(options["admission-receipt-id"] ? {
      admissionReceiptId: options["admission-receipt-id"],
    } : {}),
    ...(options["admission-attempt-id"] ? {
      admissionAttemptId: options["admission-attempt-id"],
    } : {}),
    version: await resolveVersion(api, taskId, options["if-version"]),
  });
}

async function deferIssueAdmission(api, taskId, options) {
  return api.request("POST", `${taskPath(taskId)}/admission-defer`, {
    rootThreadId: requiredOption(options, "root-thread-id"),
    expectedResumeToken: requiredOption(options, "expected-resume-token"),
    safeActionId: requiredOption(options, "safe-action-id"),
    admissionReceiptId: requiredOption(options, "admission-receipt-id"),
    admissionAttemptId: requiredOption(options, "admission-attempt-id"),
  });
}

async function prepareIssueAdmission(api, taskId, options) {
  const writeScope = requiredOption(options, "write-scope")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (writeScope.length === 0 || writeScope.length > 32 || writeScope.some((value) => value.length > 240)) {
    throw usageError("--write-scope must contain 1 to 32 comma-separated paths");
  }
  return api.request("POST", `${taskPath(taskId)}/admission-prepare`, {
    rootThreadId: requiredOption(options, "root-thread-id"),
    expectedResumeToken: requiredOption(options, "expected-resume-token"),
    safeActionId: requiredOption(options, "safe-action-id"),
    admissionReceiptId: requiredOption(options, "admission-receipt-id"),
    admissionAttemptId: requiredOption(options, "admission-attempt-id"),
    writeScope,
  });
}

function agentLaneProjectPath(projectId) {
  if (!projectId) throw usageError("Missing project id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/agent-lanes`;
}

function ownerIntentProjectPath(projectId) {
  if (!projectId) throw usageError("Missing project id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/owner-intents`;
}

function coordinatorLeasePath(projectId) {
  if (!projectId) throw usageError("Missing project id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/coordinator-lease`;
}

function coordinationWindowsPath(projectId) {
  if (!projectId) throw usageError("Missing project id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/coordination-windows`;
}

function domainCoordinatorLeasePath(projectId, domainId) {
  if (!projectId) throw usageError("Missing project id");
  if (!domainId) throw usageError("Missing coordination domain id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/domain-coordinator-leases/${encodeURIComponent(domainId)}`;
}

function coordinationDomainsPath(projectId, domainId) {
  if (!projectId) throw usageError("Missing project id");
  const base = `/api/local/projects/${encodeURIComponent(projectId)}/coordination-domains`;
  return domainId ? `${base}/${encodeURIComponent(domainId)}` : base;
}

function coordinationDomainControl(options) {
  const expectedRevision = requiredOption(options, "expected-revision").trim();
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw usageError("--expected-revision must be a lowercase SHA-256 digest");
  }
  return {
    holderTaskId: requiredOption(options, "holder-task"),
    holderThreadId: requiredOption(options, "holder-thread-id"),
    expectedCoordinatorLeaseId: requiredOption(options, "expected-lease-id"),
    expectedRevision,
    idempotencyKey: requiredOption(options, "idempotency-key"),
  };
}

function configureCoordinationDomain(api, projectId, domainId, options) {
  const writeScope = requiredOption(options, "write-scope").split(",").map((entry) => entry.trim()).filter(Boolean);
  const eligibleTaskIds = requiredOption(options, "eligible-task").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (writeScope.length === 0 || eligibleTaskIds.length === 0) {
    throw usageError("--write-scope and --eligible-task must contain comma-separated values");
  }
  return api.request("PUT", coordinationDomainsPath(projectId, domainId), {
    label: requiredOption(options, "label"), writeScope, eligibleTaskIds,
    ...coordinationDomainControl(options),
  });
}

function removeCoordinationDomain(api, projectId, domainId, options) {
  return api.request("DELETE", coordinationDomainsPath(projectId, domainId), coordinationDomainControl(options));
}

function domainTodoAssignmentPath(projectId, taskId) {
  if (!projectId) throw usageError("Missing project id");
  if (!taskId) throw usageError("Missing task id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/domain-todo-assignments/${encodeURIComponent(taskId)}`;
}

function crossDomainDependencyClearancePath(projectId, taskId) {
  if (!projectId) throw usageError("Missing project id");
  if (!taskId) throw usageError("Missing task id");
  return `/api/local/projects/${encodeURIComponent(projectId)}/cross-domain-dependency-clearances/${encodeURIComponent(taskId)}`;
}

function coordinatorHolder(options) {
  const holderTaskId = requiredOption(options, "holder-task").trim();
  const holderThreadId = requiredOption(options, "holder-thread-id").trim();
  if (!holderTaskId || holderTaskId.length > 256) {
    throw usageError("--holder-task must contain 1 to 256 characters");
  }
  if (!holderThreadId || holderThreadId.length > 256) {
    throw usageError("--holder-thread-id must contain 1 to 256 characters");
  }
  return { holderTaskId, holderThreadId };
}

function expectedCoordinatorLeaseId(options, { allowNone = false } = {}) {
  const value = requiredOption(options, "expected-lease-id").trim();
  if (allowNone && value === "none") return null;
  if (!value || value === "none" || value.length > 256) {
    throw usageError(`--expected-lease-id must contain ${allowNone ? "none or " : ""}1 to 256 characters`);
  }
  return value;
}

function mutateCoordinatorLease(api, projectId, options, expectedLeaseId) {
  const leaseDurationSeconds = Number(requiredOption(options, "lease-seconds"));
  if (!Number.isInteger(leaseDurationSeconds)
    || leaseDurationSeconds < 30
    || leaseDurationSeconds > 3600) {
    throw usageError("--lease-seconds must be an integer from 30 to 3600");
  }
  return api.request("POST", coordinatorLeasePath(projectId), {
    ...coordinatorHolder(options),
    expectedLeaseId,
    leaseDurationSeconds,
  });
}

async function registerCoordinationWindow(api, projectId, options) {
  const role = requiredOption(options, "role").trim();
  if (role !== "owner_root" && role !== "coordinator") {
    throw usageError("--role must be owner_root or coordinator");
  }
  const expectedRevision = requiredOption(options, "expected-revision").trim();
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw usageError("--expected-revision must be a lowercase SHA-256 digest");
  }
  const body = {
    role,
    taskId: requiredOption(options, "task"),
    label: requiredOption(options, "label"),
    threadId: requiredOption(options, "thread-id"),
    expectedRevision,
    idempotencyKey: requiredOption(options, "idempotency-key"),
  };
  const pathname = coordinationWindowsPath(projectId);
  for (let attempt = 0; attempt < 81; attempt += 1) {
    const result = await api.request("POST", pathname, body);
    if (result.pending !== true || role !== "coordinator") return result;
    if (attempt < 80) await api.waitForRetry(250);
  }
  throw new TaskctlError("Protected Coordinator identity handshake did not complete", {
    code: "HOST_IDENTITY_UNAVAILABLE",
    exitCode: 5,
  });
}

function releaseCoordinatorLease(api, projectId, options) {
  const expectedLeaseId = expectedCoordinatorLeaseId(options);
  return api.request("POST", `${coordinatorLeasePath(projectId)}/release`, {
    ...coordinatorHolder(options),
    expectedLeaseId,
  });
}

function mutateDomainCoordinatorLease(api, projectId, domainId, options, expectedLeaseId) {
  const leaseDurationSeconds = Number(requiredOption(options, "lease-seconds"));
  if (!Number.isInteger(leaseDurationSeconds)
    || leaseDurationSeconds < 30
    || leaseDurationSeconds > 3600) {
    throw usageError("--lease-seconds must be an integer from 30 to 3600");
  }
  return api.request("POST", domainCoordinatorLeasePath(projectId, domainId), {
    ...coordinatorHolder(options),
    expectedLeaseId,
    leaseDurationSeconds,
  });
}

function releaseDomainCoordinatorLease(api, projectId, domainId, options) {
  return api.request("POST", `${domainCoordinatorLeasePath(projectId, domainId)}/release`, {
    ...coordinatorHolder(options),
    expectedLeaseId: expectedCoordinatorLeaseId(options),
  });
}

function repairLegacyRootBinding(api, projectId, taskId, options) {
  return api.request("POST", `${coordinatorLeasePath(projectId)}/repair-binding`, {
    taskId,
    taskVersion: explicitVersion(options["if-version"]),
    ...coordinatorHolder(options),
    expectedLeaseId: expectedCoordinatorLeaseId(options),
  });
}

function agentRunPath(runId) {
  if (!runId) throw usageError("Missing Agent Run id");
  return `/api/runs/${encodeURIComponent(runId)}`;
}

async function checkpointAgentRun(api, runId, options, overrides) {
  const status = options.status ?? "active";
  if (status !== "active" && status !== "blocked") {
    throw usageError("--status must be active or blocked for run checkpoint");
  }
  return api.request("POST", `${agentRunPath(runId)}/checkpoint`, {
    agentThreadId: resolveThreadId(options, overrides),
    summary: requiredOption(options, "summary"),
    nextAction: requiredOption(options, "next-action"),
    status,
    version: explicitVersion(options["if-version"]),
  });
}

async function finishAgentRun(api, runId, options, overrides) {
  const status = requiredOption(options, "status");
  if (!["completed", "failed", "interrupted"].includes(status)) {
    throw usageError("--status must be completed, failed, or interrupted for run finish");
  }
  return api.request("POST", `${agentRunPath(runId)}/finish`, {
    agentThreadId: resolveThreadId(options, overrides),
    summary: requiredOption(options, "summary"),
    nextAction: requiredOption(options, "next-action"),
    status,
    version: explicitVersion(options["if-version"]),
  });
}

function parsePositiveIntegerOption(options, name) {
  const value = Number(requiredOption(options, name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw usageError(`--${name} must be a positive integer`);
  }
  return value;
}

function parseBooleanOption(options, name) {
  const raw = requiredOption(options, name);
  if (raw !== "true" && raw !== "false") {
    throw usageError(`--${name} must be true or false`);
  }
  return raw === "true";
}

function parseEvidenceRefs(raw) {
  if (raw === undefined || raw === "") return [];
  const references = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (references.length > 32 || new Set(references).size !== references.length) {
    throw usageError("--evidence-ref must contain at most 32 unique comma-separated references");
  }
  return references;
}

async function addTaskHandoff(api, taskId, options, overrides) {
  const agentPath = requiredOption(options, "agent-path");
  if (!agentPath.startsWith("/root/")) {
    throw usageError("--agent-path must identify a Root Sub-Agent and start with /root/");
  }
  const timestamp = options.timestamp ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw usageError("--timestamp must be an ISO timestamp");
  }
  return api.request("POST", `${taskPath(taskId)}/coordination-events`, {
    eventId: requiredOption(options, "event-id"),
    idempotencyKey: requiredOption(options, "idempotency-key"),
    parentTaskId: options["parent-task"] ?? null,
    senderThreadId: resolveThreadId(options, overrides),
    senderAgentPath: agentPath,
    eventType: "handoff",
    sequence: parsePositiveIntegerOption(options, "sequence"),
    timestamp,
    summary: requiredOption(options, "summary"),
    evidenceRefs: parseEvidenceRefs(options["evidence-ref"]),
    blocker: options.blocker ?? null,
    nextAction: requiredOption(options, "next-action"),
    requiresAck: parseBooleanOption(options, "requires-ack"),
    causationId: options["causation-id"] ?? null,
    correlationId: options["correlation-id"] ?? null,
  });
}

async function acknowledgeTaskHandoff(api, eventId, options, overrides) {
  const agentPath = requiredOption(options, "agent-path");
  if (agentPath !== "/root") {
    throw usageError("handoff ack --agent-path must be /root");
  }
  return api.request(
    "POST",
    `/api/coordination-events/${encodeURIComponent(eventId)}/acknowledgements`,
    {
      acknowledgementId: requiredOption(options, "acknowledgement-id"),
      senderThreadId: resolveThreadId(options, overrides),
      senderAgentPath: agentPath,
    },
  );
}

async function archiveIssue(api, taskId, options, overrides, action) {
  const threadId = resolveThreadId(options, overrides);
  return api.request("POST", `${taskPath(taskId)}/${action}`, {
    threadId,
    version: await resolveVersion(api, taskId, options["if-version"]),
  });
}

async function mutateIssueRelation(api, action, taskId, options, overrides) {
  if (action !== "add" && action !== "remove") {
    throw usageError("issue relation action must be add or remove");
  }
  const type = requiredOption(options, "type");
  if (!["parent", "blocks", "blocked_by", "related"].includes(type)) {
    throw usageError("--type must be parent, blocks, blocked_by, or related");
  }
  const relatedTaskId = requiredOption(options, "issue");
  const threadId = resolveThreadId(options, overrides);
  const version = await resolveVersion(api, taskId, options["if-version"]);
  return api.request(
    action === "add" ? "POST" : "DELETE",
    `${taskPath(taskId)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    { threadId, version },
  );
}

async function currentContext(api, options, overrides) {
  const cwd = path.resolve(options.cwd ?? overrides.cwd ?? process.cwd());
  const response = await api.request("GET", "/api/projects");
  const projects = Array.isArray(response.projects) ? response.projects : [];
  const matchingProjects = projects
    .filter((candidate) => workspaceContains(candidate?.workspacePath, cwd))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  const project = matchingProjects[0]
    ?? projects.find((candidate) => candidate?.id === DEFAULT_PROJECT_ID)
    ?? projects[0]
    ?? null;
  return { cwd, project };
}

function workspaceContains(workspacePath, cwd) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return false;
  const relative = path.relative(path.resolve(workspacePath), cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveInputPath(value, overrides) {
  return path.resolve(overrides.cwd ?? process.cwd(), value);
}

async function resolveVersion(api, taskId, rawVersion) {
  if (rawVersion !== undefined) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw usageError("--if-version must be a positive integer");
    }
    return version;
  }

  const response = await api.request("GET", taskPath(taskId));
  const version = response.task?.version;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TaskctlError("Taskboard service returned a task without a valid version", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
  return version;
}

async function resolveDescription(options, overrides) {
  if (options.description !== undefined && options["description-file"] !== undefined) {
    throw usageError("Use either --description or --description-file, not both");
  }
  if (options["description-file"] === undefined) {
    return options.description ?? "";
  }

  const read = overrides.readFile ?? readFile;
  try {
    return await read(options["description-file"], "utf8");
  } catch (error) {
    throw new TaskctlError(`Cannot read description file: ${options["description-file"]}`, {
      code: "FILE_READ_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLabels(rawLabels) {
  if (rawLabels === undefined || rawLabels === "") return [];
  return [...new Set(rawLabels.split(",").map((label) => label.trim()).filter(Boolean))];
}

function developmentContextFromOptions(options, overrides) {
  const branch = options["git-branch"];
  const worktreePath = options["worktree-path"];
  const worktreeBranch = options["worktree-branch"];
  if (branch !== undefined && (worktreePath !== undefined || worktreeBranch !== undefined)) {
    throw usageError("Use either --git-branch or --worktree-path/--worktree-branch, not both");
  }
  if (worktreeBranch !== undefined && worktreePath === undefined) {
    throw usageError("--worktree-branch requires --worktree-path");
  }
  if (branch !== undefined) return { type: "branch", branch };
  if (worktreePath !== undefined) {
    return {
      type: "worktree",
      path: resolveInputPath(worktreePath, overrides),
      branch: worktreeBranch ?? null,
    };
  }
  return undefined;
}

function workingLogFromOptions(options, overrides) {
  const workingLogPath = options["working-log-path"];
  const status = options["working-log-status"];
  if (options["clear-working-log"]) {
    if (workingLogPath !== undefined || status !== undefined) {
      throw usageError("--clear-working-log cannot be combined with working log options");
    }
    return null;
  }
  if (workingLogPath === undefined && status === undefined) return undefined;
  if (workingLogPath === undefined || status === undefined) {
    throw usageError("Use --working-log-path and --working-log-status together");
  }
  if (!isWorkingLogStatus(status)) {
    throw usageError("--working-log-status must be planned, active, blocked, or complete");
  }
  if (!path.isAbsolute(workingLogPath)) {
    throw usageError("--working-log-path must be absolute");
  }
  return { path: path.resolve(workingLogPath), status };
}

function recurrenceFromOptions(options) {
  const rawInterval = options["recurrence-interval"];
  const unit = options["recurrence-unit"];
  if (rawInterval === undefined && unit === undefined) return undefined;
  if (rawInterval === undefined || unit === undefined) {
    throw usageError("Use --recurrence-interval and --recurrence-unit together");
  }
  const interval = Number(rawInterval);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
    throw usageError("--recurrence-interval must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(unit)) {
    throw usageError("--recurrence-unit must be day, week, month, or year");
  }
  return { interval, unit };
}

function resolveThreadId(options, overrides) {
  const env = overrides.env ?? process.env;
  const value = options["thread-id"] ?? env.CODEX_THREAD_ID;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("Codex conversation attribution requires --thread-id or CODEX_THREAD_ID");
  }
  const threadId = value.trim();
  if (threadId.length > 256) {
    throw usageError("--thread-id and CODEX_THREAD_ID cannot exceed 256 characters");
  }
  return threadId;
}

function requiredOption(options, name) {
  const value = options[name];
  if (value === undefined || value === "") {
    throw usageError(`Missing required option --${name}`);
  }
  return value;
}

function optionalField(name, value) {
  return value === undefined ? {} : { [name]: value };
}

function validateOptions(options, allowedOptions) {
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name) && !GLOBAL_OPTIONS.has(name)) {
      throw usageError(`Unknown option --${name}`);
    }
  }
}

function expectOperandCount(parsed, expected) {
  if (parsed.operands.length !== expected) {
    throw usageError(
      expected === 0
        ? `${parsed.resource} ${parsed.action} does not accept positional arguments`
        : `${parsed.resource} ${parsed.action} requires exactly ${expected} positional ${
            expected === 1 ? "argument" : "arguments"
          }`,
    );
  }
}

function assertStatus(status) {
  if (!isTaskStatus(status)) {
    throw usageError(`Invalid status: ${status}. Expected one of: ${TASK_STATUSES.join(", ")}`);
  }
}

function assertPriority(priority) {
  if (!isTaskPriority(priority)) {
    throw usageError(`Invalid priority: ${priority}`);
  }
}

function assertWorkflowProfile(profile) {
  if (profile !== "formal" && profile !== "vibe") {
    throw usageError(`Invalid workflow profile: ${profile}. Expected formal or vibe`);
  }
}

function taskPath(taskId) {
  if (!taskId) throw usageError("Missing issue id");
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

function projectStandingAuthoritiesPath(projectId) {
  if (!projectId) throw usageError("Missing project id");
  return `/api/projects/${encodeURIComponent(projectId)}/standing-authorities`;
}

function commentPath(commentId) {
  if (!commentId) throw usageError("Missing comment id");
  return `/api/comments/${encodeURIComponent(commentId)}`;
}

function attachmentContentPath(attachmentId) {
  if (!attachmentId) throw usageError("Missing attachment id");
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

function explicitVersion(rawVersion, { allowZero = false } = {}) {
  if (rawVersion === undefined) throw usageError("Missing required option --if-version");
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < (allowZero ? 0 : 1)) {
    throw usageError(`--if-version must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return version;
}

function normalizeBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw usageError("CODEX_TASKBOARD_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usageError("CODEX_TASKBOARD_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function resolveApiUrl(baseUrl, pathname) {
  return new URL(pathname.replace(/^\//, ""), `${baseUrl}/`);
}

async function resolveTaskboardBaseUrl(env, overrides) {
  if (env.CODEX_TASKBOARD_URL !== undefined) return env.CODEX_TASKBOARD_URL;
  const configuredDescriptorPath = env.CODEX_TASKBOARD_RUNTIME_FILE;
  const descriptorPath = configuredDescriptorPath ?? sourceRuntimeFile;
  let descriptor;
  try {
    const read = configuredDescriptorPath === undefined
      ? readFile
      : (overrides.readFile ?? readFile);
    descriptor = JSON.parse(await read(descriptorPath, "utf8"));
  } catch (error) {
    if (configuredDescriptorPath === undefined && error?.code === "ENOENT") {
      return DEFAULT_API_URL;
    }
    throw new TaskctlError("Cannot read the active Taskboard launcher endpoint", {
      code: "SERVICE_UNAVAILABLE",
      exitCode: 3,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  if (descriptor?.version !== 1 || typeof descriptor.url !== "string") {
    throw new TaskctlError("The active Taskboard launcher endpoint is invalid", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
  return descriptor.url;
}

async function resolveCompanionUrl(env, overrides) {
  const rawUrl = env.CODEX_TASKBOARD_COMPANION_URL !== undefined
    ? env.CODEX_TASKBOARD_COMPANION_URL
    : await resolveTaskboardBaseUrl(env, overrides);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw usageError("Local companion URL must be a valid URL");
  }
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  const instanceToken = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  const hasValidPathname = url.pathname === "/"
    || (/^[a-z0-9-]{16,128}$/i.test(instanceToken) && !instanceToken.includes("/"));
  if (
    !isLoopback
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || !hasValidPathname
    || url.search
    || url.hash
  ) {
    throw usageError("Local companion URL must be a loopback HTTP or HTTPS endpoint");
  }
  return url.toString().replace(/\/$/, "");
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TaskctlError("Taskboard service returned invalid JSON", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
}

function extractApiError(payload, status) {
  if (payload?.error && typeof payload.error === "object") {
    return {
      code: payload.error.code ?? `HTTP_${status}`,
      message: payload.error.message ?? `Taskboard service returned HTTP ${status}`,
      details: payload.error.details,
    };
  }
  return {
    code: payload?.code ?? `HTTP_${status}`,
    message:
      payload?.message ??
      (typeof payload?.error === "string" ? payload.error : `Taskboard service returned HTTP ${status}`),
    details: payload?.details,
  };
}

function normalizeError(error) {
  if (error instanceof TaskctlError) return error;
  return new TaskctlError(error instanceof Error ? error.message : String(error), {
    code: "INTERNAL_ERROR",
    exitCode: 1,
  });
}

function usageError(message) {
  return new TaskctlError(message, { code: "USAGE_ERROR", exitCode: 2 });
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
