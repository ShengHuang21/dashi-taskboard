// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createTaskProgressModel, type DeliveryProgress } from "../taskProgress";
import type { Comment, Task, TaskRelationSummary } from "../types";
import { latestRegisteredReviewReceipt } from "./TaskDetail";
import { TaskProgress } from "./TaskProgress";

afterEach(cleanup);

describe("TaskProgress compact presentation", () => {
  it("shows only the progress track while retaining detailed accessible evidence", () => {
    const progress: DeliveryProgress = {
      completed: 2,
      total: 4,
      percent: 50,
      reason: null,
      latestChange: {
        id: "change-1",
        kind: "created",
        createdAt: "2026-09-25T12:00:00.000Z",
      },
    };

    render(<TaskProgress progress={progress} label="CAP-49 delivery completion" />);

    const track = screen.getByRole("progressbar", { name: "CAP-49 delivery completion (user acceptance)" });
    expect(track.getAttribute("aria-valuenow")).toBe("50");
    expect(track.getAttribute("aria-valuetext")).toMatch(/50%/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/2\/4 deliverables complete/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/Last scope change/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/Sep 25/);
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("2/4 deliverables complete")).toBeNull();
    expect(screen.queryByText(/Last scope change/)).toBeNull();
    expect(screen.queryByText(/Sep 25/)).toBeNull();
  });

  it("separates 3/4 delivered implementation from 0/4 user acceptance and never treats changes_requested as pass", () => {
    const parent = task("parent", "in_review");
    const leaves = [task("one", "in_review"), task("two", "in_review"), task("three", "in_review"), task("four", "backlog", ["progress-stage:acceptance"])];
    parent.relations.subIssues = leaves.map(summary);
    const progress = createTaskProgressModel([parent, ...leaves]).forTask(parent.id);
    expect(progress).toMatchObject({ implemented: 3, implementationTotal: 3, completed: 0, total: 4, percent: 0 });
    const oldReceipt = receipt("old", "2026-09-25T00:00:00.000Z", "pass");
    const newReceipt = receipt("new", "2026-09-26T00:00:00.000Z", "changes_requested", { threadId: "bound-thread", model: "gpt-6-astra", reasoningEffort: "medium" });
    const selected = latestRegisteredReviewReceipt([oldReceipt, newReceipt]);
    expect(selected?.status).toBe("changes_requested");
    expect(selected?.sourceRef).toBe("new-report");
    expect(selected?.implementation).toEqual({ threadId: "bound-thread", model: "gpt-6-astra", reasoningEffort: "medium" });
    render(<TaskProgress progress={progress} label="CAP-ETH3" showStages reviewReceipt={selected} />);
    expect(screen.getByText("Implementation · Delivered 3/3")).toBeTruthy();
    expect(screen.getByText("AI review · Registered: changes requested")).toBeTruthy();
    expect(screen.getByText("User acceptance · Accepted 0/4")).toBeTruthy();
    expect(screen.queryByText(/Registered: pass/)).toBeNull();
  });
});

function task(id: string, status: Task["status"], labels: string[] = []): Task {
  return {
    id, identifier: `ETH-${id}`, projectId: "eth", title: id, status, labels,
    createdAt: "2026-09-25T00:00:00.000Z", relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  } as unknown as Task;
}

function summary(task: Task): TaskRelationSummary {
  return { id: task.id, identifier: task.identifier, projectId: task.projectId, title: task.title,
    status: task.status, priority: "none", assignee: { type: "agent", id: "a", name: "A", avatarUrl: null }, archivedAt: null };
}

function receipt(id: string, updatedAt: string, status: "changes_requested" | "pass", implementation?: { threadId: string; model: string; reasoningEffort: string }): Comment {
  return {
    id, taskId: "parent", body: `\`\`\`taskboard-review-receipt v1\n${JSON.stringify({
      status, reviewerThreadId: "reviewer", model: "gpt-6-astra", reasoningEffort: "medium", sourceRef: `${id}-report`, candidate: { digest: "abc" }, ...(implementation ? { implementation } : {}),
    })}\n\`\`\``, authorType: "agent", authorId: "a", authorName: "A", authorAvatarUrl: null,
    threadId: null, threadBinding: null, legacyLocalThreadId: null, attachments: [], version: 1, createdAt: updatedAt, updatedAt,
  };
}
