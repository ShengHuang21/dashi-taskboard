# CAP-3 Working Log

## Objective

Make a Taskboard ticket sufficient for a stateless Codex Root or peer window to recover context, identify the next executable action, and continue safely from the ticket's Task Capsule.

## Current state

- Foundation: `4b29c8194364d7a89922d5928185e8cbe7168d57`
- Branch: `codex/task-capsule-ready-work-20260825`
- Task: `CAP-3`
- Implementation: `TaskCapsuleV1` read path, structured Working Log metadata, deterministic readiness and resume token, Root binding preservation, durable `task_agent_runs` checkpoint/handoff lifecycle
- Verification: isolated service lifecycle `PASS`; focused CLI/Agent Lane tests `39/39`; focused durable Agent Run API test `1/1`
- Commit/push/PR: not performed

## Evidence boundary

The candidate has passed isolated local service verification. The persistent service at `127.0.0.1:47823` still runs the foundation worktree until the Owner explicitly authorizes replacing its user-level launchd job.

The verified Agent Run path used a temporary SQLite directory only: fresh bootstrap ready -> claim returned an active durable run without changing the Root binding -> blocked checkpoint persisted its next action -> service restart -> fresh `run get` and `issue bootstrap` recovered that run -> completed finish moved the task to `in_review` -> an identical finish retry returned `applied: false`.

`completed` is the only Agent Run finish that changes a task status (to `in_review`, never `done`). `failed` and `interrupted` close the run and claim but intentionally leave task routing to a coordinator. Existing migrated claims without a durable run retain the legacy capsule projection.

The open-run gate is atomic: leaving `in_progress` or archiving interrupts the active claim and every active/blocked run in the same transaction. Root, worktree, and project rebinding are rejected while such a run exists; claim reuse rechecks the persisted run binding. Write scopes are normalized as relative paths within the run worktree, with absolute or traversal inputs rejected. A startup migration collapses legacy active-plus-blocked duplicates to the most-recent open writer before applying the open-run unique index.

## Next executable action

Owner review of this isolated implementation. After explicit authorization, repeat the same acceptance against the persistent loopback service; no launchd replacement, commit, push, PR, merge, or deployment has been performed.
