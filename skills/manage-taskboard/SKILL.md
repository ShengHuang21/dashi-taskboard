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
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, run `issue bootstrap` and consume its complete Task Capsule. Treat its task, relations, comments, attachments, inbox, handoffs, active/latest run, Ready Work, authorization, and resume token as the recovery frontier. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue as a Root Sub-Agent, use `issue claim`; it atomically records the durable claim, moves the issue to `in_progress`, and requires `--if-version` with the latest version. Pass `--agent-path /root/<name> --thread-id <agentThreadId> --lease-minutes 30 --write-scope <comma-separated-paths>`. Renew only the exact same task/agent/thread claim before its lease expires. For ordinary non-Sub-Agent work, move it to `in_progress` with the same optimistic version guard. On a version or claim conflict, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For a durable Sub-Agent-to-Root transfer, use `handoff add` only after the execution task has an active exact claim for that Sub-Agent. Use `handoff list` to recover ordered events and `handoff ack` only from the parent Root identity. A handoff appends a compact Task Comment and structured event; it does not replace Working Log evidence, change task status, finish a run, or grant Git authority. Reusing the same idempotency key must describe the same event.

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

## Other operations

- Run `taskctl project readme get [PROJECT_ID]` to inspect project architecture, constraints, and conventions before planning or executing complex tasks.
- Keep the project README focused on root overview and conventions; store detailed multi-page documentation in the local repository's `docs/` folder.
- Preserve existing issue scope when adding requirements or acceptance details.
- Add only relations that the work requires. Use parent for contained work, blocks or blocked_by for dependencies, and related for close association.
- Let `taskctl` read `CODEX_THREAD_ID` for writes. Outside Codex, pass the exact conversation ID with `--thread-id`.
- Use the latest returned `version` with `--if-version` for concurrent updates. On conflict, read the issue again and reconcile before retrying.
- Download and inspect an inline `![alt](api/attachments/<id>/content)` image only when it is needed to understand the requirement.
