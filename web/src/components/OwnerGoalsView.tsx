import { useMemo } from "react";
import { useTaskboardI18n } from "../i18n";
import type { TaskCardPresentation } from "../taskConversations";
import { createTaskProgressModel } from "../taskProgress";
import type { Task } from "../types";
import { TaskExecutionStatus } from "./TaskExecutionStatus";
import { TaskProgress } from "./TaskProgress";
import "./OwnerGoalsView.css";

interface OwnerGoalsViewProps {
  referenceTasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  onOpenTask: (task: Task) => void;
  onOpenAgentDetails: () => void;
}

export function OwnerGoalsView({
  referenceTasks,
  presentations,
  onOpenTask,
  onOpenAgentDetails,
}: OwnerGoalsViewProps) {
  const { text } = useTaskboardI18n();
  const progressModel = useMemo(() => createTaskProgressModel(referenceTasks), [referenceTasks]);
  const goals = useMemo(() => referenceTasks
    .filter((task) => task.labels.includes("owner-goal"))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
  [referenceTasks]);
  const childrenById = useMemo(() => {
    const children = new Map(referenceTasks.map((task) => [
      task.id,
      new Set(task.relations.subIssues.map((child) => child.id)),
    ]));
    for (const task of referenceTasks) {
      const parentId = task.relations.parent?.id;
      if (parentId) children.get(parentId)?.add(task.id);
    }
    return children;
  }, [referenceTasks]);

  function hasRunningActivity(goalId: string) {
    const pending = [goalId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (presentations[id]?.processing.running) return true;
      pending.push(...(childrenById.get(id) ?? []));
    }
    return false;
  }

  return (
    <section className="owner-goals-view" aria-label={text("我的任务", "My tasks")}>
      <div className="owner-goals-content">
        <header className="owner-goals-heading">
          <div>
            <h1>{text("我的任务", "My tasks")}</h1>
            <p>{text("你提出的任务，每项进度单独看。", "Your requested tasks, each with its own progress.")}</p>
          </div>
          <button className="button secondary" type="button" onClick={onOpenAgentDetails}>
            {text("Agent 内部明细", "Agent details")}
          </button>
        </header>
        {goals.length > 0 ? (
          <div className="owner-goals-grid">
            {goals.map((goal) => (
              <article className="owner-goal-card" key={goal.id}>
                <h2>
                  <button type="button" onClick={() => onOpenTask(goal)}>{goal.title}</button>
                </h2>
                <TaskProgress
                  progress={progressModel.forTask(goal.id)}
                  label={text(`${goal.title}的总进度`, `Overall progress for ${goal.title}`)}
                />
                <p className="owner-goal-activity">
                  {hasRunningActivity(goal.id) ? (
                    <span data-execution-state="running">{text("正在推进此任务", "Work is underway on this task")}</span>
                  ) : (
                    <TaskExecutionStatus state={presentations[goal.id]?.execution ?? "uncertain"} />
                  )}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="owner-goals-empty">
            <h2>{text("你提出的任务尚未整理", "Your requested tasks have not been organized yet")}</h2>
            <p>{text(
              "由 Agent 根据你的原始要求整理；内部子任务不会混进来。",
              "Agents organize this view from your original requests; internal subtasks stay separate.",
            )}</p>
          </div>
        )}
      </div>
    </section>
  );
}
