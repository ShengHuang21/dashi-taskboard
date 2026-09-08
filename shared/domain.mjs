export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];
export const WORKING_LOG_STATUSES = ["planned", "active", "blocked", "complete"];
export const CODEX_HOST_ID_MAX_LENGTH = 256;

export const DEFAULT_PROJECT_ID = "local";
export const JIRA_PROJECT_ID = "jira-my-tasks";
export const DEFAULT_LABEL_NAMES = [
  "缺陷",
  "特性",
  "for-claude",
  "hold",
  "改进",
  "phase-1",
  "phase-2",
  "phase-3",
  "phase-4",
  "phase-5",
  "phase-6",
];

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}

export function isWorkingLogStatus(value) {
  return WORKING_LOG_STATUSES.includes(value);
}

export function isCanonicalCodexHostId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= CODEX_HOST_ID_MAX_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}
