import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);
const cliReference = await readFile(
  new URL("../skills/manage-taskboard/references/cli.md", import.meta.url),
  "utf8",
);
const readmeSource = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("the taskboard skill disambiguates companion terminology for agents", () => {
  assert.match(skillSource, /## Terminology: local companion/i);
  assert.match(skillSource, /device-local loopback service/i);
  assert.match(skillSource, /Never translate as \*\*伴侣\*\*/i);
  assert.match(skillSource, /not “companion API”/i);

  assert.match(cliReference, /## Terminology: local companion/i);
  assert.match(cliReference, /Do not use/i);
  assert.match(cliReference, /伴侣 API/i);
  assert.match(cliReference, /Taskboard HTTP API/i);
  assert.match(cliReference, /local loopback service/i);
});

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(
    readmeSource,
    /fresh or memoryless[\s\S]*taskctl issue bootstrap ISSUE_ID --json/i,
  );
  assert.match(readmeSource, /Task Capsule includes[\s\S]*comments, attachments, inbox, handoffs[\s\S]*resumeToken/i);
  assert.match(
    skillSource,
    /Codex Taskboard\.app\/Contents\/Resources\/bin\/taskctl' issue bootstrap ID --json/i,
  );
  assert.match(
    skillSource,
    /On Linux[\s\S]*use `taskctl issue bootstrap ID --json`/i,
  );
  assert.match(
    skillSource,
    /packaged macOS wrapper is absent[\s\S]*explicit runtime descriptor[\s\S]*`taskctl --help`[\s\S]*`taskctl issue bootstrap ID --runtime-file \/absolute\/launcher-runtime\.json --json`[\s\S]*Never fall back to the default port/i,
  );
  assert.match(cliReference, /taskctl issue bootstrap ISSUE_ID \[--json\]/i);
  assert.match(
    cliReference,
    /one direct Task Capsule read[\s\S]*comments, attachments, inbox, handoffs[\s\S]*resumeToken/i,
  );
  assert.match(
    skillSource,
    /first run `issue bootstrap`[\s\S]*one Task Capsule[\s\S]*comments, attachments, inbox, and handoffs[\s\S]*Read the description and latest comments before deciding whether to start[\s\S]*If they say to wait, not execute, or not start now, stop and report without changing the status/i,
  );
  assert.match(skillSource, /Treat comments as current requirements, including returned work/i);
  assert.match(
    skillSource,
    /If work may start[\s\S]*before reading code, downloading attachments, analyzing the implementation, or doing any other task work[\s\S]*Move a claimable `todo` to `in_progress` with its current `version`; do not continue until the move succeeds/i,
  );
  assert.match(
    skillSource,
    /If the move conflicts because the `version` is stale[\s\S]*run `issue bootstrap` again[\s\S]*Retry once with the latest `version` only when the issue is still a claimable `todo`, is not bound to another conversation, is not archived, and its description, latest comments, inbox, handoffs, and execution frontier are unchanged[\s\S]*If it was claimed, its status or requirements changed, it is archived, the service is unavailable, a permanent API error occurs, or the retry fails, stop and report[\s\S]*Never loop or take over another agent's claim/i,
  );

  assert.match(
    skillSource,
    /Verify the requested operation path[\s\S]*Add a comment with the changes, verification result, outcome, and remaining risks[\s\S]*Read the issue again, then move it to `in_review` with its current `version`/i,
  );
});

test("the taskboard skill produces hidden final-only typed Owner Intent markers", () => {
  assert.match(skillSource, /coordinator windows PROJECT_ID/);
  assert.match(skillSource, /coordinator register-window/);
  assert.match(skillSource, /Owner Root and active Global Coordinator must remain distinct/);
  assert.match(cliReference, /Registration is protected, optimistic, and idempotent/);
  assert.match(skillSource, /coordinator status PROJECT_ID --json/);
  assert.match(skillSource, /owner-intent list PROJECT_ID --json/);
  assert.match(skillSource, /Do not ask the Owner for an intent id or protocol syntax/);
  assert.match(skillSource, /exactly one invisible HTML comment and no content after it/);
  assert.match(skillSource, /TASKBOARD_OWNER_INTENT_ROUTE_V1/);
  assert.match(skillSource, /never put it in commentary, quote it, explain it, or ask the Owner to copy it/);
  assert.match(skillSource, /omit the marker so capture fails closed/);
});
