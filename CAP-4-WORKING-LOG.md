# CAP-4 Working Log

## Objective

Let a Taskboard ticket distinguish safe local continuation from closed delivery or runtime gates, and expose one exact Owner request only when no safe action remains.

## Current state

- Branch: `codex/task-capsule-ready-work-20260825`
- Parent: `CAP-3`
- Task: `CAP-4`
- Implementation: strict comment-backed `Task Authorization Envelope V1`; safe and deferred action projection; deterministic structural repair actions; complete resolved-gate audit fields; trusted decision provenance; explicit renewable expiry policy; Agent Lanes status/UI projection
- Current focused verification: authorization plus Agent Lane coordination `34/34` after the Talking Window binding projection repair. The final independent reviewer previously ran the pre-repair lanes as `33/33`, bootstrap frontier `1/1`, TypeScript typecheck, and `git diff --check`.
- Historical broader verification: server `34/34`; full Node suite `427 passed / 1 skipped`; dedicated browser `1/1`; components `9/9`; production web build passed. These results predate the final binding projection repair and are not presented as current-head proof.
- Independent review: the complete CAP-4 review returned `CHANGES_REQUIRED` for this Working Log, the cumulative commit boundary, and duplicate legacy/confirmed projection. The duplicate projection is now covered by a RED-then-GREEN regression; final re-review remains pending.
- Record synchronization: the Working Log is registered as active; the CAP-4 Root binding is confirmed; protected CAP-4 checkpoints and reviewer verdicts are written only through `taskctl`.
- Working tree: intentional cumulative Phase 1 Taskboard changes remain; no commit, push, PR, merge, deploy, or canonical runtime restart has been performed from the current dirty tree.

## Current authorization frontier

- Authorized by exact user-authored comment `56033af6-34ee-49c6-9574-9b18e4873fd9` version `2` on the confirmed Root thread: bounded local Taskboard inspect/edit/test, commit, ordinary push to `origin/codex/task-capsule-ready-work-20260825`, PR create/update, exact-head merge after independent review and required checks, and deployment of the exact reviewed CAP-4 candidate to the current Owner-scoped Taskboard environment.
- Not authorized: force-push, unrelated repositories/environments, or an unreviewed cumulative dirty tree. Restart/replacement of `com.sboai.taskboard.capstone-dev` on canonical `127.0.0.1:47823` remains separately `approval_required`.
- Current remediation boundary: canonical service/data was not directly edited or restarted during this repair; all record synchronization used the protected `taskctl` path. Historical canonical activation is preserved as earlier evidence and is not evidence that the current dirty source is loaded.

## Evidence boundary

The current implementation recognizes an envelope only when the standalone marker is followed by a JSON code fence. Ordinary checkpoint prose mentioning the envelope name is ignored. Malformed, duplicate, unknown, or structurally incomplete envelopes fail closed. An `authorized` or `denied` gate is trusted only from a user-authored comment bound to the task's exact Root thread. Taskboard records explicit authorization evidence and receipts but never grants its own authority.

Historical invalid envelopes remain retained as audit evidence. The current trusted user-authored envelope explicitly supersedes every historical marker and is bound to the confirmed CAP-4 Root thread. `authorized`, `denied`, and `forbidden` decisions preserve approver, exact approval request, evidence, and receipt. A bounded authorization with `expiresAt` must also declare `renewable`; expiry becomes `approval_required` only when renewable, otherwise `forbidden`. Structural blockers suppress Owner approval requests and expose one deterministic AI repair action.

## Exact review and delivery boundary

CAP-4 is not allowed to relabel the entire cumulative dirty tree as one reviewed CAP-4 commit. Its direct implementation/review surface is exactly:

- `CAP-4-WORKING-LOG.md`
- `server/task-capsule.mjs`
- `server/agent-lane-snapshot.mjs`
- `web/src/types.ts`
- `web/src/components/AgentLaneBoard.tsx`
- `test/task-capsule-authorization.test.mjs`
- `test/agent-lane-coordination.test.mjs`
- `test/agent-lane-ui.test.mjs`

The remaining modified/untracked paths contain previously completed Project Inbox, planning/lease, durable delivery receipt, injector, native-panel, and shared storage/API slices. They are preserved, but they are outside a standalone CAP-4 review. A delivery commit may proceed only after either (a) those cumulative paths receive an independent whole-diff review as one explicitly named Phase 1 candidate, or (b) CAP-4 is extracted to an isolated clean-base patch without losing user changes. Until then, stored commit/push/PR/merge/deploy authorization is authority only, not readiness evidence.

## Next executable action

Request one fresh independent CAP-4 reviewer against the current source, RED/GREEN regression, verification results, Working Log, and explicit runtime boundary. The source repair is reviewable now; protected canonical `47823` still runs pre-repair code, so live single-`confirmed` projection verification is deferred until an exact separately authorized canonical restart/deploy or an isolated candidate-runtime acceptance. Do not commit the cumulative dirty tree until the exact delivery-boundary condition above is satisfied.
