# CAP-6 Working Log

## Objective

Repair the three concrete P1 findings from the final Phase 1 whole-diff review without changing the accepted Phase 1 product model.

## Confirmed findings

- `project-inbox` lacks a structural non-dispatchable Ready Work guard.
- Completion reconciliation ignores configured peer-window Sub-Agents.
- Repeated host-bridge install replaces the pending request queue.

## Current evidence

- Fixed cumulative base: `5a420160c505f6daa1b68d87aa812e23ec6cb72e`.
- Each finding was reproduced with a focused RED regression before its repair.
- `project-inbox` now returns only `PROJECT_INBOX_NON_DISPATCHABLE` after all other execution gates are satisfied, with no safe action.
- Reconciliation now considers Sub-Agents from every configured Talking Window while `rootSubagents` retains its coordinator-only compatibility projection.
- The first scoped review found one remaining ambiguity when two windows reuse the same `agentPath`; a second RED proved only one completion reconciled. Claim lookup now matches both `agentPath` and `agentThreadId`, and the two-window same-path regression passes.
- Reinstalling the CDP host bridge initializes a missing queue but preserves already queued requests.
- Focused authorization/snapshot/injector verification: 46/46 passed.
- Cumulative Node checks passed (including the three new regressions); dedicated browser 1/1, components 9/9, typecheck, `build:web`, and diff-check passed.
- CAP-5 binary attachment P1 is independently closed; canonical `47823` remains pre-repair and is not current-source evidence.

## Next action

Complete the independent scoped CAP-6 re-review. On PASS, request a fresh independent whole-diff Phase 1 review against the fixed base before any commit or delivery action.

## Whole-diff re-review remediation

The fresh cumulative Phase 1 review returned `CHANGES_REQUIRED` for one P1 and two P2 findings while preserving the earlier scoped CAP-6 PASS:

- Agent Lane now projects both the readable Todo identifier and internal task UUID. The background continuation monitor reserves by identifier, validates the returned receipt against the UUID, and delivers the selected safe action exactly once.
- Talking Window Inbox idempotency now binds a delivery key to body, source thread, full thread binding, and actor. An identical replay remains idempotent; a conflicting replay returns `IDEMPOTENCY_CONFLICT` without replacing the original comment or receipt.
- Native panel opening now holds a short opening lease after LaunchServices returns. Requests arriving before presence heartbeat reuse the pending opening; if presence never arrives, the lease expires and a later request may open a replacement.

Each confirmed finding received a focused RED before its production repair. The initial focused run failed in all three expected mechanisms: missing internal `taskId`, conflicting Inbox payload returning HTTP 200, and delayed presence producing a second `opened` result. After repair:

- exact RED/GREEN paths: 4/4 passed;
- Agent Lane, background host runtime, and panel suites: 36/36 passed;
- direct related Server, Agent Lane, host runtime, Injector, and panel suites: 85/85 passed;
- TypeScript typecheck, changed-module syntax checks, and `git diff --check` passed.

The cumulative `npm test` chain also passed with exit code 0, covering Node, browser-injection, and component suites. `build:web` passed under the resource envelope (exit code 0; peak 586 MiB and 1.63 CPU cores). The required fresh independent whole-diff re-review remains pending. Canonical `127.0.0.1:47823`, SQLite data, LaunchAgent configuration, and unrelated Keycloak remain untouched.
