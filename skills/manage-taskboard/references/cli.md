# taskctl CLI

`taskctl` emits JSON for normal commands. Add `--json` when making the output contract explicit. Built-in help is the only successful stdout exception: it writes plain text, exits with code `0`, and does not request the Taskboard service.

Use built-in help for the current command tree or a specific supported level:

```bash
taskctl --help
taskctl issue --help
taskctl comment list --help
```

## Terminology: local companion

**Companion** here is a product term for the **device-local loopback HTTP service** that `taskctl` talks to in cloud mode. It applies Basic Authentication, stores device-only project path mappings, and keeps Codex/Git/Skill/MCP capabilities on the machine. It is not a chat persona and not a separate public “companion product API”.

| English | Prefer in Chinese | Do not use |
| --- | --- | --- |
| local companion / loopback companion | 本地 companion、本地配套服务、环回代理 | 伴侣、伴侣 API |
| Taskboard HTTP API (`/api/tasks`, `/api/comments`, `/api/attachments`, …) | Taskboard HTTP API、本地服务 API、附件上传接口 | companion API、伴侣 API |

Env and files that refer to this service: `CODEX_TASKBOARD_COMPANION_URL`, `CODEX_TASKBOARD_URL` (loopback origin), `.data/cloud-companion.json`. Error code `LOCAL_COMPANION_REQUIRED` means a capability needs that **local loopback service**, not a different API surface.

## Context and projects

```bash
taskctl context current [--cwd PATH] [--json]
taskctl project list [--json]
taskctl project create --name NAME [--id ID] [--workspace-path PATH] [--json]
taskctl project map PROJECT_ID --workspace-path PATH [--json]
taskctl project readme get [PROJECT_ID] [--json]
taskctl project readme set [PROJECT_ID] (--content TEXT | --file PATH) [--if-version N] [--json]
```

Use `--workspace-path` to associate a project with a local repository. `context current` chooses the most specific project whose workspace contains the current directory, then falls back to the `local` project.

Use `project readme get` and `project readme set` to read and update the project's single root README document. Detailed multi-page documentation belongs in the project's local `docs/` folder.

Set `CODEX_TASKBOARD_URL` to override the default local API origin, `http://127.0.0.1:47823`.

For a shared cloud board, keep `taskctl` pointed at the **loopback companion** (local loopback service; see Terminology above) and configure the upstream HTTPS origin through it:

```bash
taskctl cloud login --url HTTPS_ORIGIN --actor-name NAME [--json]
taskctl cloud status [--json]
taskctl project list [--json]
taskctl project map PROJECT_ID --workspace-path /absolute/local/path [--json]
taskctl cloud logout [--json]
```

`cloud login` reads the shared password from a private `Shared key:` prompt. The actor name is the display attribution sent through Basic Authentication. The local companion stores its configuration with mode `0600`; project mappings stay on the current device and can differ between collaborators. In cloud mode, failed upstream writes fail rather than falling back to or double-writing the local SQLite database.

Every issue or comment write must be attributed to a Codex conversation. In Codex, `taskctl` reads the current conversation from `CODEX_THREAD_ID`. Outside Codex, pass `--thread-id ID` explicitly. An explicit option takes precedence over the environment. Read commands do not require a conversation id.

Except for built-in help, every successful command writes one JSON object with `schemaVersion` to stdout. The current schema version is `2`. Errors write one JSON object to stderr. Exit codes are `0` for success, `2` for invalid input, `3` when the service is unavailable, `4` for API or response errors, and `5` for conflicts.

## Read issues

```bash
taskctl issue list [--project PROJECT_ID] [--status STATUS] [--archived true|false|all] [--json]
taskctl issue get ID [--json]
taskctl issue bootstrap ISSUE_ID [--json]
```

For a replaceable project coordinator, inspect and mutate only the exact configured Agent Lane task/thread binding:

```bash
taskctl coordinator windows PROJECT_ID [--json]
taskctl coordinator register-window PROJECT_ID --role owner_root|coordinator --task TASK --label LABEL --thread-id THREAD --expected-revision SHA256 --idempotency-key KEY [--json]
taskctl coordinator status PROJECT_ID [--json]
taskctl coordinator acquire PROJECT_ID --holder-task TASK --holder-thread-id THREAD --expected-lease-id none|LEASE_ID --lease-seconds 300 [--json]
taskctl coordinator renew PROJECT_ID --holder-task TASK --holder-thread-id THREAD --expected-lease-id LEASE_ID --lease-seconds 300 [--json]
taskctl coordinator release PROJECT_ID --holder-task TASK --holder-thread-id THREAD --expected-lease-id LEASE_ID [--json]
taskctl coordinator receipts PROJECT_ID [--json]
```

Register the Owner-facing Root and replaceable coordinator from their respective live Codex windows. Registration is protected, optimistic, and idempotent: Taskboard derives host/workspace identity from the fresh authenticated Codex runtime, and the caller supplies only the semantic role plus exact current thread id. Do not reuse one task id for both roles or mutate SQLite/config files directly.

Acquire requires an explicit expected identity: use `none` only when status has no stored lease, or pass the expired lease id when replacing an expired coordinator. Renew/release require the exact active lease id. Conflicts fail closed. Persist a checkpoint or handoff before release, and remember that coordinator ownership never grants execution ownership.

The active Global Coordinator may create the durable disjoint routing map through protected Taskboard state:

```bash
taskctl domain-coordinator domains PROJECT_ID [--json]
taskctl domain-coordinator configure PROJECT_ID DOMAIN_ID --label LABEL --write-scope PATH[,PATH] --eligible-task TASK[,TASK] --holder-task GLOBAL_TASK --holder-thread-id GLOBAL_THREAD --expected-lease-id GLOBAL_LEASE --expected-revision SHA256 --idempotency-key KEY [--json]
taskctl domain-coordinator remove PROJECT_ID DOMAIN_ID --holder-task GLOBAL_TASK --holder-thread-id GLOBAL_THREAD --expected-lease-id GLOBAL_LEASE --expected-revision SHA256 --idempotency-key KEY [--json]
```

Read the current revision immediately before every configuration write. Scopes must be relative and disjoint, and eligible task ids must name configured peer windows. Taskboard rejects policy changes while a Todo remains assigned or a domain lease is reserved; release the lease and clear assignments first. Do not edit SQLite or the Agent Lane config directly.

Use `issue bootstrap` as the first read for a fresh or memoryless window. It performs one direct Task Capsule read and returns the recovery state together, including the issue, relations, comments, attachments, inbox, handoffs, active/latest execution run, authorization state, and `resumeToken`. Use the returned `resumeToken` and execution frontier when claiming or resuming work; `issue bootstrap` itself is read-only.

For a difficulty-selected child model, plan before reservation/delivery by adding one structured comment through the existing command, then bootstrap again:

```bash
taskctl comment add ISSUE_ID --body-file /absolute/path/task-model-routing-v1.md [--thread-id ROOT_THREAD] [--json]
taskctl issue bootstrap ISSUE_ID [--json]
```

The body file contains one `Task Model Routing V1` marker immediately followed by a `json` code fence. Its JSON requires `workflow: "ai-coding-end-to-end"`; `fast`, `balanced`, and `capable` profiles, each with a Host-advertised `model` and `reasoningEffort`; a non-empty `profileSource`; `planningProfile` and `validationProfile` both `capable`; plus one execution `{ safeActionId, difficulty, profile, reason }`. The only mappings are `simple -> fast`, `standard -> balanced`, and `complex -> capable`.

The re-bootstrapped Capsule exposes `modelRouting` with the source comment id/version and `selectedExecution` only when the configured `safeActionId` equals the current Safe Action. A malformed supplied route or mismatch stops routing; it must not degrade to an unpinned model choice. When no routing marker is supplied, existing dispatch behavior remains unchanged.

Use the existing `issue admission-prepare` command with the exact re-bootstrapped token and action. If its response is not rerouted, it includes `spawnConfig`: use its `taskName`, `model`, `reasoningEffort`, and `forkTurns: "none"` exactly for the child spawn. A null `spawnConfig` means the task is unconfigured, so retain the existing no-model-override dispatch behavior while using the returned admission agent identity. On capacity rejection, retain the requested model and effort through the existing defer/retry path; do not reselect a profile or model. After the child makes the exact prepared claim, use the existing comment command to record requested parameters and real spawn/claim tool-call evidence only.

If the Capsule returns `readyWork.ownerDecisionRequest`, do not send the Owner to Taskboard and do not let a Sub-Agent ask them. The authenticated host Injector reserves the exact current request and Root route atomically, delivers the question once, and reads the delivery id back from the exact Root thread after uncertain transport. Once delivery is confirmed, Taskboard keeps that exact Root coordinator route protected for a bounded human-response window until the decision is recorded. After the Owner replies, Root bootstraps again and follows the injected instruction to emit one `TASKBOARD_OWNER_DECISION_V1` marker only when the request remains current. The Injector accepts that marker only after a real Owner input in the exact Root thread and records the immutable receipt through its host-authenticated route. `taskctl` has no Owner-decision mutation command. This is Root-attested Owner provenance, not Agent self-approval.

## Create issues

```bash
taskctl issue create \
  --project PROJECT_ID \
  --title TITLE \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--json]
```

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, and `canceled`. Priorities are `none`, `urgent`, `high`, `medium`, and `low`.

Issues created through `taskctl` are assigned to Codex Agent by default. Other CLI writes preserve the existing assignee.

## Update issues

Read the issue immediately before a write and pass its `version` with `--if-version`.

```bash
taskctl issue update ID \
  [--project PROJECT_ID] \
  [--title TITLE] \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--start-date YYYY-MM-DD] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--if-version N] \
  [--json]

taskctl issue move ID --status STATUS [--thread-id ID] [--if-version N] [--json]

taskctl issue claim ID --agent-path /root/NAME --thread-id AGENT_THREAD_ID --lease-minutes N --write-scope PATH[,PATH] [--if-version N] [--json]
taskctl issue archive ID [--thread-id ID] [--if-version N] [--json]
taskctl issue restore ID [--thread-id ID] [--if-version N] [--json]
```

Use `issue move` to set `in_progress` before implementation and `in_review` after implementation and self-verification. Codex must not move work directly from `in_progress` to `done`; use `done` only after the user explicitly confirms acceptance or explicitly asks to mark the issue complete. Use `blocked` when work cannot continue and `canceled` when it will not continue. On a version conflict, fetch the issue again and reconcile before retrying.

Use `issue claim` for a Root Sub-Agent. It records the Sub-Agent identity and moves a real `todo` issue to `in_progress` atomically; the completion reconciler later appends one short result comment and moves it to `in_review`.

Use either `--git-branch` or `--worktree-path`/`--worktree-branch`; an issue has only one development context. Issue JSON stores it as `developmentContext`, either `{ "type": "branch", "branch": "..." }` or `{ "type": "worktree", "path": "...", "branch": "..." }`. Its singular `threadId` is the Codex conversation that most recently created or changed the issue itself. Recurrence requires a due date.

Changing only `--project` preserves the issue's existing linked conversation.

## Issue relations

Read the anchor issue immediately before adding or removing a relation and use its current version. Relation writes require Codex conversation attribution like every other issue write.

```bash
taskctl issue relation add ISSUE_ID \
  --type parent \
  --issue PARENT_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

taskctl issue relation add ISSUE_ID \
  --type blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

taskctl issue relation remove ISSUE_ID \
  --type parent|blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]
```

For `--type parent`, `ISSUE_ID` is the child and `PARENT_ISSUE_ID` is its parent. Adding another parent replaces the child's current parent atomically. To add an existing issue as a sub-issue, anchor the command on the child and pass the exact parent identifier with `--issue PARENT_ISSUE_ID`.

For `blocks`, the anchor issue blocks the related issue. For `blocked_by`, the related issue blocks the anchor. `related` is symmetric. Self-relations, duplicates, parent cycles, and relations between different projects are rejected.

## Issue comments

Use the issue id to read or append comments. Comment updates and deletes require the latest comment `version` returned by `comment list`.

```bash
taskctl comment list ISSUE_ID [--after CURSOR] [--json]
taskctl comment add ISSUE_ID (--body TEXT | --body-file FILE) [--thread-id ID] [--json]
taskctl comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID] [--json]
taskctl comment delete COMMENT_ID --if-version N [--thread-id ID] [--json]
```

Without `--after`, `comment list` returns the full list. Its response includes `nextCursor`; keep that value and pass it to the next read of the same issue to return only comments created or modified after that cursor. `--body-file` reads the UTF-8 file and passes its contents directly to the existing comment write path.

Each comment JSON object independently records the most recent conversation that created or changed that comment as `threadId`. Comment operations never change the parent issue's `threadId`.

## Versioned text result handoffs

```bash
taskctl handoff publish SOURCE --consumer TARGET \
  --event-id PUBLICATION_ID --idempotency-key KEY \
  (--content TEXT | --content-file PATH) \
  [--evidence-ref REF[,REF]] [--thread-id PRODUCER_ROOT] [--json]
taskctl handoff read SOURCE --consumer TARGET [--version PUBLICATION_ID] [--json]
taskctl handoff adopt SOURCE --consumer TARGET --version PUBLICATION_ID \
  --expected-adoption none|ADOPTION_ID --event-id ADOPTION_ID --idempotency-key KEY \
  --boundary TEXT [--thread-id CONSUMER_ROOT] [--json]
```

Publish/read/adopt resolve the configured protected local service; legacy list/add/ack routing is unchanged. They use `POST`/`GET /api/local/tasks/:source/result-handoffs/:consumer` and `POST .../adoptions`. Both tasks must exist in the same current project. Publish requires the current producer Root, adopt the current consumer Root; writes use `CODEX_THREAD_ID` unless `--thread-id` is explicit. These are the existing caller/thread checks, not a new host-attestation mechanism. Reads do not require a thread identity or create adoption authority.

Publish stores the exact text, including leading/trailing whitespace, with a limit of 65,536 UTF-8 bytes (non-empty). `--content-file` reads only the caller's explicit path as UTF-8; the server receives text, never a path to open. The event includes `contentSha256`, `createdAt`, `sourceTaskVersion`, `previousPublicationId`, and resolved producer/consumer task UUIDs. At most 32 unique evidence references (each up to 2,048 characters) are declarations; the service does not fetch or freeze their files/URLs. Do not include credentials or sensitive customer data.

Read returns `queriedAt`, `latestPublication`, `selectedPublication`, `currentAdoption`, `adoptedPublication`, and `syncStatus`. Without `--version`, selected equals latest; with it, the exact retained publication must belong to this pair. The statuses are `no_publication` (none currently retained), `awaiting_adoption` (published, no adoption), `pending_sync` (latest differs from adopted), or `adopted` (same exact publication). Read creates no receipt/comment/run/claim/status change and never messages, starts, wakes, or steers a task.

Adopt requires an exact publication id and explicit expected current adoption id (`none` only when absent). Its boundary is a non-empty statement up to 2,000 characters, not server proof of an idle thread or completed document update. A replacement appends another adoption; publishing P2 does not rewrite A1 → P1. An explicit adoption may select an older publication and remain `pending_sync` against latest. On CAS conflict, reread and reconcile before choosing again.

Publish/adopt return `{ applied, event }`. An identical event id, key, and normalized input returns the original event with `applied: false`; a conflicting input or event/key collision fails without another record. After uncertain transport, authoritative readback or the exact same request can determine the recorded outcome. Generated time, content hash, and captured source version are not new replay inputs.

Result publications/adoptions are not legacy handoffs, acknowledgements, Capsule execution-frontier entries, or Ready Work. Existing task/project cascading deletion controls retention; even after a task moves, deletion of its original project can delete its receipts. No permanent-retention, crash-recovery, cloud deployment, or frozen-artifact claim follows from these records.

## Structured handoffs

Append a compact, durable Sub-Agent-to-Root handoff from the Sub-Agent that holds the task's active exact claim. For a final completion handoff, first complete `run finish`, then use the same Sub-Agent identity and pass the returned Run id as `--causation-id`; Taskboard permits exactly one such final event while the task remains `in_review`. Read events to replay/recover them, then acknowledge a `requiresAck` event from the parent Root identity:

```bash
taskctl handoff add ISSUE_ID \
  --event-id EVENT_ID \
  --idempotency-key KEY \
  --agent-path /root/NAME \
  --sequence N \
  [--timestamp ISO] \
  --summary TEXT \
  [--evidence-ref REF[,REF]] \
  [--blocker TEXT] \
  --next-action TEXT \
  --requires-ack true|false \
  [--parent-task TASK_ID] \
  [--causation-id ID] \
  [--correlation-id ID] \
  [--thread-id ID] \
  [--json]

taskctl handoff list ISSUE_ID [--json]

taskctl handoff ack EVENT_ID \
  --acknowledgement-id ID \
  --agent-path /root \
  [--thread-id ID] \
  [--json]
```

`handoff add` reads the sender conversation from `CODEX_THREAD_ID` unless `--thread-id` is explicit. `--parent-task` is the exact durable parent task id and must be omitted when the task has no parent. `--evidence-ref` accepts at most 32 unique comma-separated references; store only compact pointers, never credentials, complete prompts, or sensitive payloads.

The service persists the structured event and its compact Task Comment atomically. Repeating an idempotency key with the identical envelope returns the same receipt; changing the envelope conflicts. The post-finish final event is accepted only when the task is still `in_review`, the latest Run and claim are both completed at the same instant, their agent path/thread match the sender, `causationId` equals that exact Run id, and no final event already exists for the Run. Handoffs and acknowledgements are append-only and do not change the task version/status, active run, claim, coordinator lease, Ready Work, or authorization boundary. `handoff ack` accepts only the `/root` agent path and the exact parent Root conversation for an event that requires acknowledgement.

## Attachments

Issue descriptions and comments may contain inline images at exact positions in their Markdown:

```markdown
![alt text](api/attachments/ATTACHMENT_ID/content)
```

Upload a local file to a task or a comment. Provide exactly one of `--task` or `--comment`:

```bash
taskctl attachment list (--task TASK_ID | --comment COMMENT_ID) [--after CURSOR] [--json]
taskctl attachment upload --task TASK_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
taskctl attachment upload --comment COMMENT_ID --file PATH [--content-type TYPE] [--kind inline|attachment] [--json]
```

Without `--after`, `attachment list` returns the full list for that task or comment. Its response includes `nextCursor`; keep a separate cursor for every attachment list target and pass it to the next read to return only later attachments.

The command sends the file bytes to:

- `POST /api/tasks/:id/attachments`, or
- `POST /api/comments/:id/attachments`

with the same headers as the web UI (`Content-Type`, `X-Taskboard-Filename`, `X-Taskboard-Attachment-Kind`). If `--content-type` is omitted, the CLI guesses from the file extension and falls back to `application/octet-stream`. If `--kind` is omitted, images use `inline` and other files use `attachment`. Use `--kind attachment` for an image that must appear in the attachment list. An inline upload returns the attachment id; use that id in the task description or comment Markdown at the required position.

Download an attachment to an explicit local path:

```bash
taskctl attachment download ATTACHMENT_ID --output PATH [--json]
```

The command writes the response body as binary data and returns the absolute output path, content type, and size in its JSON result. Choose the output filename yourself; `taskctl` does not infer or append an extension.
