---
name: manage-taskboard
description: Manage Codex Taskboard / e-taskboard work with taskctl. Use for taskboard issue IDs, status sync, comments, or taskctl cloud setup—not for unrelated product docs.
---

# Manage Taskboard

Use `taskctl` for every project, issue, relation, comment, and structured handoff operation. Consume its JSON output. Use the exact issue identifier returned by the taskboard or supplied in the prompt. Never assume, derive, or rewrite an identifier prefix.

Open only the relevant section of [references/cli.md](references/cli.md) when command syntax is needed.

## Select the CLI and active service

## Work with issues safely

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - For an Owner-facing project roadmap, use one parent issue for the overall goal and its direct sub-issues for the visible feature list. Write those titles in the Owner's language as short outcomes (for example, `读取 PDF 与股东信`), not implementation mechanisms. Keep commands, receipts, review mechanics, and detailed recovery evidence in descriptions or comments. Append newly requested features as new children without renaming or replacing existing children, keep each status truthful, and set a due date only when there is evidence for one; otherwise let the roadmap report that completion cannot yet be estimated reliably.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, run `issue bootstrap` and consume its complete Task Capsule. Treat its task, relations, comments, attachments, inbox, handoffs, active/latest run, Ready Work, authorization, and resume token as the recovery frontier. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue as a Root Sub-Agent, use `issue claim`; it atomically records the durable claim, moves the issue to `in_progress`, and requires `--if-version` with the latest version. Pass `--agent-path /root/<name> --thread-id <agentThreadId> --lease-minutes 30 --write-scope <comma-separated-paths>`. Renew only the exact same task/agent/thread claim before its lease expires. For ordinary non-Sub-Agent work, move it to `in_progress` with the same optimistic version guard. On a version or claim conflict, skip the issue and do not implement it.
6. Before a project can separate Owner conversation from execution coordination, each live Codex window registers itself through protected Taskboard state. Read `coordinator windows PROJECT_ID`, then run `coordinator register-window` with that exact revision, a unique idempotency key, and role `owner_root` or `coordinator`. The service derives host and workspace identity from the fresh authenticated Codex runtime; never invent or copy those bindings. The Owner Root and active Global Coordinator must remain distinct. A replacement Root then uses `coordinator status`, followed by `coordinator acquire` only when the project is unassigned or the prior lease expired. The current holder uses `coordinator renew` with the exact lease id; it uses `coordinator release` only after its durable checkpoint/handoff is persisted. Coordinator lease ownership never grants task execution ownership, so the new Root must still bootstrap and claim the exact Ready Work separately.
   - The active Global Coordinator owns the durable domain routing map. Read `domain-coordinator domains PROJECT_ID`, then use `domain-coordinator configure` or `domain-coordinator remove` with the exact current config revision, Global lease identity, and a unique idempotency key. Keep write scopes disjoint and use only configured peer task ids. Taskboard rejects a policy change while the domain has assigned Todos or a reserved coordinator lease; clear/release them first. Never edit SQLite or the Agent Lane config directly.
7. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
8. Before requesting review, verify the requested work and acceptance criteria.
9. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
10. Taskboard comments are Agent recovery records; never ask the Owner to read or verify them. Sub-Agents never contact the Owner directly. When a Capsule exposes `readyWork.ownerDecisionRequest`, only the authenticated host Injector may reserve and surface the project-level request in the active confirmed Root window. Root must not self-approve: after an actual Owner reply, bootstrap again and, only when the request id and resume token remain exact, include the injected `TASKBOARD_OWNER_DECISION_V1` marker in that Root turn. The Injector records it only when it follows a real Owner input in the exact Root thread; there is no copyable bearer token or Taskboard comment workflow.
   - When `coordinator status PROJECT_ID --json` confirms that the current `CODEX_THREAD_ID` is the exact `coordination.ownerRootRoute.rootThreadId`, the Owner-facing Root is the producer for typed Owner Intent capture. Before its final response to every ordinary Owner request, read `owner-intent list PROJECT_ID --json`, classify the request as `append`, `clarify`, `supersede`, or `cancel`, and select the exact existing `intentId` for every non-append kind. Do not ask the Owner for an intent id or protocol syntax.
   - End the final response with exactly one invisible HTML comment and no content after it: `<!-- TASKBOARD_OWNER_INTENT_ROUTE_V1 {"kind":"append","targetIntentId":null,"constraints":[]} -->`. Replace the JSON values with the classified kind, exact target intent id, and only constraints stated by the Owner. This final-only marker is Agent control evidence, not user-facing content; never put it in commentary, quote it, explain it, or ask the Owner to copy it. If the exact Owner Root route or required target cannot be proven, omit the marker so capture fails closed; do not guess, default a non-append request to append, or mutate Taskboard directly.
11. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
12. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

## Difficulty-selected execution model

Before a Root reserves or delivers a planned Safe Action, write its explicit routing plan as one Task Comment with `taskctl comment add --body-file`, then run `taskctl issue bootstrap` again. The comment must contain one `Task Model Routing V1` marker immediately followed by a `json` code fence whose body has this shape:

```json
{
  "workflow": "ai-coding-end-to-end",
  "profiles": {
    "fast": { "model": "<current-host-model>", "reasoningEffort": "<supported-effort>" },
    "balanced": { "model": "<current-host-model>", "reasoningEffort": "<supported-effort>" },
    "capable": { "model": "<current-host-model>", "reasoningEffort": "<supported-effort>" }
  },
  "profileSource": "explicit planner source and current Host catalog",
  "planningProfile": "capable",
  "validationProfile": "capable",
  "execution": {
    "safeActionId": "exact-current-safe-action-id",
    "difficulty": "simple",
    "profile": "fast",
    "reason": "short action-specific explanation"
  }
}
```

The only execution mappings are `simple -> fast`, `standard -> balanced`, and `complex -> capable`. `profileSource` is a non-empty provenance explanation, not a bearer token or a fixed literal. Do not invent a model ranking or use a model/effort that the target Host does not currently advertise.

`issue bootstrap` returns `modelRouting`, including the source comment id/version and the selected execution only when its `safeActionId` still matches the current Safe Action. A supplied malformed plan or action mismatch is a stop condition, never a reason to fall back to an unpinned child. Unconfigured tasks retain the existing model-dispatch behavior.

After `issue admission-prepare`, do not spawn when `rerouted=true`. Otherwise consume its `spawnConfig`: when it is present, invoke `collaboration.spawn_agent` with the exact task name, model, reasoning effort, and `fork_turns: "none"`; when it is null, preserve the unconfigured behavior without a model override while still using `fork_turns: "none"`. On capacity rejection, retain that exact model/effort and use the existing defer/retry path; do not select another profile or model. The child must make the exact prepared claim before work. Only after that claim, add the existing Taskboard comment recording requested parameters and real spawn/claim tool-call evidence; never fabricate Host-observed or session-collector evidence.

For a durable Sub-Agent-to-Root transfer during execution, use `handoff add` only while the task has an active exact claim for that Sub-Agent. For the final completion transfer, first complete `run finish`, then immediately append exactly one final handoff from that same Sub-Agent with `--causation-id` set to the completed Run id. This narrow post-finish exception exists only while the task remains `in_review`; it rejects a different sender, Run, or second final event. Use `handoff list` to recover ordered events and `handoff ack` only from the parent Root identity. A handoff appends a compact Task Comment and structured event; it does not replace Working Log evidence, change task status, finish a run, or grant Git authority. Reusing the same idempotency key must describe the same event.

An Owner decision receipt is different from a comment or handoff. It is an immutable host-observed binding among the exact Root thread, the actual Owner input turn, the Root decision turn, and the current Taskboard delivery. The authenticated Injector records it automatically; `taskctl` cannot create one. After delivery, Taskboard protects that exact Root coordinator route for a bounded human-response window until the decision is recorded; never describe this as Agent approval or self-approval.

- Use the exact `taskctl` binary and Taskboard URL supplied by the task or injected runtime. Do not replace them with a global CLI, the default port, or another board.
- On macOS, when no binary is injected and the desktop app is installed, use `'/Applications/Codex Taskboard.app/Contents/Resources/bin/taskctl' issue bootstrap ID --json`. Keep the single quotes because the path contains a space. The packaged wrapper reads the active launcher runtime; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- On macOS, when the packaged macOS wrapper is absent but the task supplies an explicit runtime descriptor, first require `taskctl --help` to succeed. Then use `taskctl issue bootstrap ID --runtime-file /absolute/launcher-runtime.json --json`. This source-linked fallback is allowed only with that exact supplied descriptor. Never fall back to the default port, another board, or a reconstructed tokenized URL.
- On Linux, when no binary is injected and Codex was started by the desktop app, use `taskctl issue bootstrap ID --json`. The desktop app adds its packaged wrapper to the managed Codex `PATH`; do not search the filesystem for another CLI or reconstruct the tokenized URL.
- If that exact command reaches a sandbox restriction on the loopback service, retry the same command with the required permission. Do not switch binaries or endpoints.

## Terminology: local companion

In this product, **companion** means the **device-local loopback service** used for cloud mode (Codex/Git/Skill/MCP, path mapping, Basic Auth proxy). Related names: `local companion`, `loopback companion`, `CODEX_TASKBOARD_COMPANION_URL`, `cloud-companion.json`, `LOCAL_COMPANION_REQUIRED`.

When writing Chinese, keep the English word or use **本地 companion** / **本地配套服务** / **环回代理**. Never translate as **伴侣** or invent **伴侣 API**. Ordinary task/comment/attachment HTTP routes (`/api/tasks`, `/api/comments`, `/api/attachments`, …) are the **Taskboard HTTP API** (or local server API)—not “companion API”.

## Core workflow

1. For an existing issue, first run `issue bootstrap` and recover from one Task Capsule containing the task, relations, comments, attachments, inbox, and handoffs plus execution/authorization state. A fresh memoryless window must not depend on another window retelling this state. Read the description and latest comments before deciding whether to start. Treat comments as current requirements, including returned work. If they say to wait, not execute, or not start now, stop and report without changing the status. In a retained window, `comment list --after` and `attachment list --after` may reduce later incremental reads, but they never replace a fresh bootstrap after handoff, restart, conflict, or uncertainty.
2. Treat `backlog` as not approved for execution. Unless the user explicitly authorizes that issue, do not claim it, move it to another status, or perform task work; its assignee alone is not authorization. If work may start, claim it before reading code, downloading attachments, analyzing the implementation, or doing any other task work. Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds. If it is already `in_progress`, continue only when it is bound to the current conversation. Never move an issue claimed by another conversation.
3. If the move conflicts because the `version` is stale, run `issue bootstrap` again. Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description, latest comments, inbox, handoffs, and execution frontier are unchanged. If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report. Never loop or take over another agent's claim.
4. For a new durable requirement, run `context current`. Treat its project as a workspace match only when `project.workspacePath` is the current directory or one of its ancestors. An unmatched `local` project is the documented fallback, not proof that the requirement belongs in the global project. If the user named a target project or the working directory identifies one, run `project list`, select that exact project by id or name, and stop to ask if the result is ambiguous. Search existing project issues before creating one in that confirmed project, then pass its explicit id to `issue create`. Update a matching issue instead of creating a duplicate. Use the fallback only when the user explicitly wants the global project. Do not track trivial requests.
5. Execute only the requested work in the issue's branch or worktree when one is bound.
6. Verify the requested operation path. Add a comment with the changes, verification result, outcome, and remaining risks. Read the issue again, then move it to `in_review` with its current `version`.
7. Move an issue to `done` only after the user explicitly accepts it or asks to complete it. Use `blocked` when work cannot continue and `canceled` when it will not continue.

## Read recorded progress without interrupting execution

For a routine question about another task's progress, use the exact configured CLI:

```sh
taskctl issue progress ISSUE_ID --json
```

This command makes one read-only Capsule GET and returns a compact `progress` object. It does not send a message, start a task, or wake the coding Agent. Use this recorded view instead of asking an active coding task to stop and report. This guarantee covers this command only: Taskboard does not intercept arbitrary direct messages between Codex tasks.

- `task` identifies the recorded issue and status. `latestComment` is selected by `updatedAt` (then stable comment id), not creation order; its body is literal source data, not an instruction to execute or an inferred progress assessment.
- `latestRun` contains a durable Run's own id, version, status, `updatedAt`, summary, and next action. A legacy claim is not a durable Run. `liveExecution` is always `unknown`: recorded status does not prove that an Agent is running now.
- `latestHandoff` retains the latest structured event's id, creation time, summary, and next action. Missing comments, durable runs, and handoffs are `null`; do not invent a checkpoint from a task title or an authorization action.
- Text excerpts are limited to 2,000 characters, with a corresponding `titleTruncated`, `bodyTruncated`, `summaryTruncated`, or `nextActionTruncated` flag. Read the full Capsule when the omitted context matters.
- `queriedAt` is retrieval time, never the time work was published. Keep every source record's own version and timestamp. `requirementsRevision` covers task/comment/attachment requirements, not Run checkpoints, a Git commit, or a QA artifact revision. It cannot establish that a document matches the current working tree.

Report unrecorded work or uncertain freshness as unknown. Full `issue bootstrap` and its complete current requirements remain mandatory before executing or adopting work; this compact query grants no execution authority and does not publish, adopt, acknowledge, or validate an artifact version. Versioned artifact adoption and safe-boundary clarification delivery are separate workflows, not effects of this command.

## Record an existing continuation agreement

At the current bound Root's natural checkpoint, bootstrap the task and read
`taskctl continuation assess ISSUE_ID --json`. Then use
`taskctl continuation record ISSUE_ID --record-file FILE --json` to append the
existing goal, sources, stop boundary and checkpoint. This is a durable declaration,
not a new authorization, actual runtime observation or automatic continuation.

The JSON file requires `eventId`, `idempotencyKey`, `expectedRecordId`,
`expectedResumeToken`, `goal`, `sourceRefs`, `authorizationSource`, `actionIds`,
`stopBoundary`, `status` and `checkpoint`. Use explicit JSON `null` for the first
`expectedRecordId`; replacements name the exact previous event ID. The string
`"none"` is an ordinary ID. `authorizationSource` is null or the existing Capsule
source `{commentId, commentVersion}`. `status` is `active`, `paused`, `canceled` or
`endpoint_reached`. Checkpoint fields are `summary`, `nextActionId` (string/null),
`waitingKind` (`none`, `resource`, `dependency`, `decision`, `authorization`),
`waitingDetail` (string/null) and `retryAt` (ISO time/null). All nullable fields
must be present. Text/reference order is preserved; never store secrets or customer data.
The CLI always attributes the sender to actual `CODEX_THREAD_ID`, not file contents.

Assessment reads the latest committed event and current task/source/authorization.
Missing structured evidence asks Root to reconcile evidence, not Owner to approve
ordinary work again. Resource waiting stays a queue; reaching `retryAt` means
capacity needs observation, not that capacity is available. A recorded endpoint
does not complete the task. Binding or requirements changes require reconciliation.
Existing pending-action and effective gate evidence is necessary but never proves
runtime idle, readiness, review/CI or merge eligibility. Every assessment returns
`liveExecution: "unknown"` and `eligibleForDispatch: false`.

This protected local-only path does not poll, send/start/steer, claim, acknowledge,
change status or authorization, merge, or activate a runtime. Writes append only
`continuation_record` receipts; they do not add comments or invalidate their own
Capsule revision/token. On uncertain transport retry the exact original request;
historical replay does not revive older state. On conflict, reread and reconcile
before making a new explicit record. Records follow existing task/project retention.

## Publish and adopt a text result without interrupting another task

Use `handoff publish SOURCE --consumer TARGET` from the producer task's current bound Root at its chosen checkpoint, then `handoff read SOURCE --consumer TARGET` from the consumer. These three new commands use the protected local Taskboard HTTP API; they do not add cloud support. Both tasks must currently share a project. The service stores exact UTF-8 text (1–65,536 bytes, including whitespace), its SHA-256, server time, source task version, and the exact task UUID pair. Optional evidence references are producer declarations, not frozen files, images, Git trees, review, or deployment proof. Never publish credentials or sensitive customer data.

Before adopting, bootstrap the consumer's current requirements and read the publication. At a consumer-chosen boundary, its current bound Root explicitly runs `handoff adopt` with the exact publication event id, `--expected-adoption none` for the first adoption or the current adoption event id for a replacement, and `--boundary TEXT`. The boundary is the consumer's declaration, not proof that a thread is idle or a document was updated. See [references/cli.md](references/cli.md) for full syntax.

`handoff read` is observer-only: no receipt, comment, status, run, claim, message, wake, or steer. It returns latest and selected publication separately from current adoption and adopted publication. Later publication P2 leaves adoption A1 → P1 unchanged (`pending_sync`) until an explicit adoption. Historical selection does not change adoption. On a conflict, reread and reconcile; on uncertain transport, read back or retry the same exact event id, key, and input. Replays return the original record; changed input conflicts.

These result records are separate from legacy `handoff list/add/ack`, Capsule handoffs, and Ready Work. They remain append-only only while retained under the existing task/project deletion lifecycle; project moves and later deletion of the original project can remove receipts. `no_publication` means no currently retained publication, not that none ever existed. No permanent retention or artifact recovery is promised.

## Queue missing information at a natural safe point

Use `clarification enqueue PRODUCER --consumer CONSUMER` from the consumer task's current bound Root to retain a missing-information question without interrupting the producer. Use the protected local service, existing tasks in the same current project, a unique `--event-id` and `--idempotency-key`, `--question TEXT`, and exactly one of `--basis-publication PUBLICATION_EVENT_ID` or `--no-published-basis`. The basis must belong to that exact producer-consumer pair. The string `none` is an ordinary publication id, never null. Optional `--evidence-ref REF[,REF]` preserves reference order. Keep summaries minimal; never copy full chats, credentials, or raw customer material.

Enqueue returns a delivery `receipt` and a separate server-assigned `canonicalRequestId`. Identical producer, consumer, explicit basis, original question text, and ordered references share one canonical request, even after it is handled. Whitespace or reference-order differences are distinct; no fuzzy merging or silent replacement occurs. Each additional delivery is durably retained as an alias. Retry uncertain transport with the same exact event, key, sender, and payload; changed input conflicts. New writes must use the current Root binding.

At its next natural safe point, the producer bootstraps and checks the independent `clarifications` pending counts, then runs `taskctl clarification list ISSUE_ID --json`. Either task may list the canonical queue without consuming or acknowledging anything. The list shows incoming/outgoing direction, queued/handled state, request, retained resolution, explicit basis, latest publication for the same pair, relevance, and retrieval time. Pending counts exclude aliases and handled requests. Capsule metadata contains no question body and does not change requirementsRevision, resumeToken, Ready Work, claims, runs, inbox, or old handoffs.

Only the producer's current bound Root may run `clarification resolve CANONICAL_REQUEST_ID --event-id ID --idempotency-key KEY (--observed-publication ID | --no-observed-publication) --outcome answered|needs_reconfirmation --result TEXT --boundary TEXT`. First read the current pair-scoped latest publication; resolve atomically compares that exact observation. If it changed, reread and reconcile explicitly—never automatically retry against a newer version. A null basis with no publication may be answered using explicit null observation. A newer publication makes a null or older basis `needs_reconfirmation`; record that outcome instead of answering the stale request.

The safe boundary is a caller declaration, not proof of idle, progress, or execution authority. Enqueue/list/resolve never send, start, steer, poll, wake, or comment on a task. Continue independent work while waiting. Each request has one immutable terminal resolution; later publications update displayed relevance but never rewrite handling, reopen the request, or adopt a result for the consumer. A changed version/question is a new logical request. Restart recovery uses bootstrap/list and exact alias replay while receipts remain retained under existing task/project deletion rules; this is not a permanent-retention guarantee. Use `taskctl clarification --help` for complete syntax.

## Other operations

- Run `taskctl project readme get [PROJECT_ID]` to inspect project architecture, constraints, and conventions before planning or executing complex tasks.
- Keep the project README focused on root overview and conventions; store detailed multi-page documentation in the local repository's `docs/` folder.
- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
