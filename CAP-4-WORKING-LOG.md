# CAP-4 Working Log

## Objective

Let a Taskboard ticket distinguish safe local continuation from closed delivery or runtime gates, and expose one exact Owner request only when no safe action remains.

## Current state

- Branch: `codex/task-capsule-ready-work-20260825`
- Parent: `CAP-3`
- Task: `CAP-4`
- Implementation: strict comment-backed `Task Authorization Envelope V1`; safe and deferred action projection; deterministic approval request; denied and expired authorization handling; Agent Lanes status/UI projection
- Verification: authorization, Agent Lanes, injector runtime, and userscript bridge focused tests `73/73`; TypeScript typecheck passed; production web build passed; `git diff --check` passed
- Baseline boundary: four `test/server.test.mjs` failures reproduce unchanged from exact `HEAD` in an isolated archive and are not caused by the CAP-4 diff
- Independent review: final `PASS`; no remaining P1/P2 findings after userscript bridge and delivery-state reset fixes
- Record synchronization: canonical `127.0.0.1:47823` was unavailable during the final checkpoint attempt, so no CAP-4 comment was written and the service was not restarted
- Local commit: authorized by Owner on 2026-08-26; the resulting SHA is reported in the external handoff rather than self-referenced in this committed file
- Push/PR/canonical cutover: not performed

## Current authorization frontier

- Authorized: read-only independent review; local focused tests, typecheck, build, and isolated acceptance
- Authorized: local commit
- Approval required: push; replacement of `com.sboai.taskboard.capstone-dev` on canonical `127.0.0.1:47823`
- Canonical service: unchanged; the candidate is validated from a snapshot copy of canonical SQLite data

## Evidence boundary

The current implementation recognizes an envelope only when the standalone marker is followed by a JSON code fence. Ordinary checkpoint prose mentioning the envelope name is ignored. Malformed, duplicate, unknown, or structurally incomplete envelopes fail closed. An `authorized` or `denied` gate is trusted only from a user-authored comment bound to the task's exact Root thread. Taskboard records explicit authorization evidence and receipts but never grants its own authority.

The existing CAP-4 envelope comment was written through the agent CLI and is therefore intentionally invalid under the hardened provenance rule. It is retained as historical evidence, not treated as authorization. A trusted user-authored envelope bound to the CAP-4 Root thread is required before live dispatch can become eligible. Structural blockers such as an active claim continue to suppress approval requests.

## Next executable action

Create one local candidate commit containing the reviewed CAP-4 files and excluding the untracked `node_modules` symlink. After canonical Taskboard is available again, synchronize this final checkpoint without restarting or replacing its launchd job; do not impersonate the Owner or rewrite the existing agent-authored envelope as trusted authorization.
