---
tracker:
  kind: local
  active_states: [ready, running]
  terminal_states: [in_review, failed, canceled, superseded]
  provider:
    url: http://127.0.0.1:43120
    project_id: local
    instance_id: owner-prepared-local-scheduler
    token_env: TASKBOARD_LOCAL_SCHEDULER_TOKEN
    state_root: /ABS/LOCAL/attempts
    supervisor: /ABS/TASKBOARD/integrations/symphony-local/supervisor.py
    python: /ABS/python3
    capability_file: /ABS/LOCAL/capabilities.json
workspace:
  root: /ABS/LOCAL/workspaces
agent:
  max_concurrent_agents: 2
polling:
  interval_ms: 2000
codex:
  command: /usr/bin/false
hooks: {}
---

Local package instructions and per-process settings come only from the immutable
release. This global command is deliberately unusable: Local supplies its frozen
supervisor command to the native app-server session.
