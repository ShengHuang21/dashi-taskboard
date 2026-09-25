// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Comment } from "../types";
import { GoalWindowMap, latestGoalWindowMap } from "./GoalWindowMap";

afterEach(cleanup);

describe("GoalWindowMap", () => {
  it("counts only four complete main bindings, keeps A/B in one layer, and opens the exact binding", () => {
    const onOpenThread = vi.fn();
    render(<GoalWindowMap comments={[windowMapComment()]} onOpenThread={onOpenThread} tasks={[]} onOpenTask={vi.fn()} />);

    expect(screen.getByText("4 registered main windows")).toBeTruthy();
    const a = screen.getByRole("button", { name: /A delivery/i });
    const b = screen.getByRole("button", { name: /B delivery/i });
    expect(a.parentElement?.parentElement).toBe(b.parentElement?.parentElement);
    expect(b.closest("article")?.textContent).toContain("B review");
    expect(screen.queryByText("5 registered main windows")).toBeNull();

    fireEvent.click(a);
    fireEvent.click(screen.getByRole("button", { name: "Open window" }));
    expect(onOpenThread).toHaveBeenCalledWith(binding("a-thread"));
  });

  it("does not fall back to an older map when the newer declaration is invalid", () => {
    const valid = windowMapComment("old", "2026-09-25T00:00:00.000Z");
    const invalid = { ...windowMapComment("new", "2026-09-26T00:00:00.000Z"), body: "```taskboard-window-map v1\n{}\n```" };
    expect(latestGoalWindowMap([valid, invalid])).toBeNull();
  });

  it("rejects a declared main binding when any required identity is blank", () => {
    const comment = windowMapComment();
    const declaration = JSON.parse(comment.body.match(/\n(\{.*\})\n/)![1]);
    declaration.nodes[0].threadBinding.threadId = "   ";
    comment.body = `\`\`\`taskboard-window-map v1\n${JSON.stringify(declaration)}\n\`\`\``;
    expect(latestGoalWindowMap([comment])).toBeNull();
  });

  it("rejects a two-node directed cycle instead of inventing a layer", () => {
    const comment = windowMapComment();
    const declaration = JSON.parse(comment.body.match(/\n(\{.*\})\n/)![1]);
    declaration.nodes = declaration.nodes.slice(0, 2);
    declaration.edges = [
      { from: "main", to: "coord", kind: "coordination" },
      { from: "coord", to: "main", kind: "coordination" },
    ];
    comment.body = `\`\`\`taskboard-window-map v1\n${JSON.stringify(declaration)}\n\`\`\``;
    expect(latestGoalWindowMap([comment])).toBeNull();
  });
});

function binding(threadId: string) {
  return { threadId, codexProjectId: "project", codexProjectKind: "local" as const, codexHostId: "local", workspacePath: "/workspace" };
}

function windowMapComment(id = "map", updatedAt = "2026-09-26T00:00:00.000Z"): Comment {
  const nodes = [
    node("main", "Main coordination", "main", binding("main-thread")),
    node("coord", "02 coordination", "main", binding("coord-thread")),
    node("a", "A delivery", "main", binding("a-thread")),
    node("b", "B delivery", "main", binding("b-thread")),
    node("b-review", "B review", "reviewer", null),
  ];
  return {
    id, taskId: "goal", body: `\`\`\`taskboard-window-map v1\n${JSON.stringify({ sourceRef: `record-${id}`, observedAt: updatedAt, nodes, edges: [
      { from: "main", to: "coord", kind: "coordination" }, { from: "coord", to: "a", kind: "coordination" },
      { from: "coord", to: "b", kind: "coordination" }, { from: "b", to: "b-review", kind: "review" },
    ] })}\n\`\`\``, authorType: "agent", authorId: "a", authorName: "A", authorAvatarUrl: null,
    threadId: null, threadBinding: null, legacyLocalThreadId: null, attachments: [], version: 1, createdAt: updatedAt, updatedAt,
  };
}

function node(id: string, title: string, kind: "main" | "reviewer", threadBinding: ReturnType<typeof binding> | null) {
  return { id, roleLabel: title, title, kind, threadBinding, scope: "scope", recordedState: "recorded", latestOutput: "output", nextAction: "next" };
}
