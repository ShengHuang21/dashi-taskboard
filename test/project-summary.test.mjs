import assert from "node:assert/strict";
import { test } from "node:test";

import { ProjectSummaryService } from "../server/project-summary.mjs";

test("a recent project summary using the retired Owner-review label is hidden and refreshed", () => {
  const active = new Map();
  let refreshCount = 0;
  let summary = {
    projectId: "project-1",
    summary: "还有 1 项等你确认",
    generatedAt: new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    error: null,
  };
  const service = {
    active,
    database: {
      getProject: () => ({ id: "project-1" }),
      getProjectSummary: () => summary,
    },
    refresh: () => {
      refreshCount += 1;
      active.set("project-1", { promise: Promise.resolve() });
      return Promise.resolve();
    },
  };

  const result = ProjectSummaryService.prototype.get.call(service, "project-1");

  assert.equal(result.summary, null);
  assert.equal(result.updatedAt, null);
  assert.equal(result.refreshing, true);
  assert.equal(refreshCount, 1);

  active.clear();
  summary = {
    ...summary,
    attemptedAt: new Date().toISOString(),
    error: "Selected model is at capacity",
  };
  const throttled = ProjectSummaryService.prototype.get.call(service, "project-1");
  assert.equal(throttled.summary, null);
  assert.equal(throttled.refreshing, false);
  assert.equal(refreshCount, 1);

  summary = {
    ...summary,
    attemptedAt: new Date(Date.now() - (25 * 60 * 60 * 1_000)).toISOString(),
  };
  ProjectSummaryService.prototype.get.call(service, "project-1");
  assert.equal(refreshCount, 2);

  active.clear();
  summary = {
    ...summary,
    summary: "TASKBOARD_SUMMARY_V2\n已将“等你确认”改为新的状态说明",
    attemptedAt: new Date().toISOString(),
    error: null,
  };
  const current = ProjectSummaryService.prototype.get.call(service, "project-1");
  assert.equal(current.summary, "已将“AI 审查中”改为新的状态说明");
  assert.equal(current.refreshing, false);
  assert.equal(refreshCount, 2);
});
