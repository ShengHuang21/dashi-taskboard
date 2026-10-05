# Local Taskboard → Symphony

This optional integration uses immutable Taskboard releases as the native Symphony
scheduler's work source. Ordinary Todo steps and other tracker providers keep their
existing behavior. It does not activate an installed Taskboard or Symphony service.

The owner publishes one selected package with `taskctl symphony release TASK --file
package.json --if-version VERSION`; `taskctl symphony context RELEASE` reads its
frozen context and receipts. Both use the existing protected runtime descriptor.
The package has an explicit model/effort, stable Todo/step/package IDs, execution
version, inputs/hashes, workspace/write scope, authority, required artifacts and
Done conditions. A changed execution requires a new version. Exact re-publication
returns the original release even after its card has progressed.

`serve.mjs ABS_CONFIG_JSON` starts a **new loopback-only service**. The configuration
requires `projectId`, `dataDirectory`, `stateRoot`, `workspaceRoot`, `inputRoot`,
`capabilityFile`, and optionally `port` (default: a free port). Use separately
prepared directories and read-only input snapshots. `stateRoot` contains private
owner/scheduler credentials, the persistent signing key, and the protected
`launcher-runtime.json` descriptor. Never replace existing state or credentials to
recover an unknown attempt. The database binds the signing fingerprint and static
scope; missing/different configuration or signing key prevents startup.

The scheduler receives only its independent token and unprefixed loopback base URL.
It can read releases, claim once and finalize results/stops, and cannot publish or
use owner routes. Native/legacy guards check the configured project and main
workspace. Native thread RPC checks both persisted project bindings and the
same adapter's native thread ID/cwd, including caller cwd overrides, at the final
dispatch transaction. Ambiguous requests fail individually.

These guards do not yet cover every legacy writable scope: additional writable
directories and a legacy workspace containing the Local root remain open gaps
(R9-02) before general same-instance coexistence. This dedicated `serve.mjs` sets
the local legacy executable to `/usr/bin/false`; it does not disable the remote
channel registry. A limited trial must also verify no replacement adapter, active
remote channel or old Worker. Do not treat this mitigation as complete legacy
isolation or enable it in an ordinary daily instance on that basis.

## Symphony configuration

Apply `symphony.patch` to the exact source verified by `source-manifest.json` using
`python3 apply-patch.py ABS_SOURCE_ROOT`. It first checks every affected baseline
file hash and patch applicability. The upstream archive is OpenAI Symphony commit
`1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb`; its archive checksum is recorded in the
manifest. The old archive's `3efccfe` root label is not a Git revision. Two existing
local changes in `dashboard_live.ex` and `extensions_test.exs` are outside this
feature patch and must be retained separately if reproducing that local baseline.
The upstream Apache-2.0 license is included as `LICENSE.symphony`.

Use `WORKFLOW.local.example.md` with explicit absolute local paths. Set the named
scheduler token environment variable from the isolated `scheduler-token` file.
The configured Python and supervisor paths are explicit. Set the concurrency
appropriate to the owner-authorized packages; no default is changed globally.
Local rejects workspace hooks and SSH workers. Worktrees/input preparation belongs
to the owner before publication.

The supervisor validates the capability receipt's actual executable hash and
model/effort pair immediately before spawn. It passes both values as Codex process
configuration; it does not mutate global defaults. The receipt uses the model/list
probe shape: `entry`, `binary_sha256`, `observed_at`, and `result.models` with
`model` and `supportedReasoningEfforts[].reasoningEffort`.

## Local tool permissions

Local requires the verified Codex native named permission-profile API. The logical
package authority remains workspace-write. A per-process profile permits writes
only in the package workspace, leaves frozen inputs read-only, and denies reads
and writes to the actual Taskboard database/state/config, Symphony attempt state,
workflow, original Todo and effective CODEX_HOME. These paths must exist and remain
separate from input/workspace roots. The trusted controller and app-server reuse
existing authentication; no login secrets are copied or supplied to the model.
The profile governs Codex-managed tools and descendants, not the trusted entire
app-server process or an all-machine read allowlist.

`writeScope` is the task contract and artifact-validation scope, not an OS-level
per-file write allowlist inside the workspace. `authorized-git` enables profile
network access; it is not a Git-protocol-only network filter. Use the existing
`model-only` authority for the limited trial.

Inherited MCP servers are individually disabled with process-only overrides and
checked again in the same app-server's effective configuration. Plugins, apps,
browsers, image tools, optional code mode, memory/skill search, extra agents and other
unneeded optional tool surfaces in the verified executable are disabled locally;
web search is disabled. No online issue dynamic tools are provided. The exact
fixed feature set is in `supervisor.py` and is verified by the session startup.
The required `code_mode_host` bridge is explicitly enabled and verified so the
model can invoke managed commands; `code_mode` and the other 26 optional features
remain disabled. Global configuration, Skills and other trackers are unchanged.

Startup checks the actual allowed profile, full effective profile (ignoring only
null optional defaults), required bridge/disabled feature/MCP configuration and empty MCP runtime
resources/tools. Thread and every turn explicitly select that profile, omitting
legacy sandbox fields. Unknown/changed executable capabilities or ineffective
permissions fail closed before a model turn. `permissions.json` records only the
profile and MCP names/enabled states inside private attempt state, never endpoint,
header or environment values. Result and stop recovery remain independent.

## Attempts, results and recovery

SQLite claims precede task-related directory writes or thread creation. There is
one durable attempt per release. Canonical workspaces that are equal or contain
one another are mutually exclusive, including different cards. The claim transaction
checks both parent/child directions before creating an attempt. Sibling workspaces
remain parallel; `A` and `A2` do not overlap. Attempt directories and the
exclusive `launch.guard` are retained. Normal/error exit, cancellation, stall and
restart never create another Worker for that version. A live Worker may use its
package's allowed turn count.

`supervisor.py` owns a separate OS session and a separate app-server process group.
It observes descendants, removes scheduler/owner credentials from the child
environment, and on transport loss terminates the group and observed descendants.
The scheduler verifies that the wrapper, child group and observed process identities
are absent before submitting the immutable stop receipt. PID reuse or incomplete
observation remains unknown. Only currently matching process identities seed new
descendants or group ownership; a reused historical PID cannot adopt an unrelated
family. Observed identity uncertainty remains latched even if that PID later exits.
This does not claim to detect arbitrary unobserved
process escape. Local hooks are disabled so they cannot introduce another process
tree outside this boundary.

Worker final output is a JSON object containing `summary` and `verification`;
artifacts are checked independently from their actual files. A valid result moves
the original card to `in_review` and adds one comment with Todo steps, attempt,
configuration/session/process information and artifact hashes. Owner `canceled`
or `done` status is preserved: the release exposes that terminal status while the
attempt retains its immutable execution result, even if the result arrives later.
The native Local scheduler stops any running release whose state is no longer
`running`. Nonterminal card status still follows the execution result. Workers
never mark user acceptance. Result and stop use separate fixed idempotency keys. Result alone never
releases occupancy. Pending envelopes are replayed unchanged after service recovery,
with no new claim or launch. Result and stop are prepared and sent independently:
missing evidence, an invalid envelope or a failed send on one side does not block
the other. A saved envelope is replayed without rereading its original payload;
a new stop envelope still requires verified process-stop evidence. The delivered
marker requires both acknowledgements. Workspaces and artifacts are not auto-deleted.

Service GET routes do not claim or launch. Tracker `Local.Client.fetch`, however,
first replays pending envelopes and may POST an old finalize receipt; the whole
fetch operation is not strictly read-only.

## Local verification

- `node --test test/symphony-local.test.mjs` covers actual SQLite contention,
  receipt restart/replay, validation and protected service/fence paths.
- `python3 integrations/symphony-local/supervisor_test.py` uses controlled fake
  executables to verify process configuration, credential removal, descendants,
  stop observation and launch guards. It makes zero model calls.
- `node integrations/symphony-local/native-smoke.mjs ABS_ELIXIR_DIR ABS_EVIDENCE_DIR`
  joins isolated Taskboard/SQLite, the actual native scheduler, and controlled fake
  app-server processes; it tests normal completion and abrupt scheduler loss.
- Symphony retains its required `make all` checks and existing coverage threshold.
  Taskboard checks are `npm run typecheck`, `npm run build:web` and `npm test`.
  Do not use an injector-refreshing build to test this isolated candidate.

These checks establish local plumbing. Real Codex configuration acceptance and a
real model run are distinct evidence. Installation, daily activation, publication
and user acceptance are separate decisions.
