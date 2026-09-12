import { useMemo, type Ref } from "react";
import { useTaskboardI18n } from "../i18n";
import type { TaskCardPresentation } from "../taskConversations";
import { createTaskProgressModel } from "../taskProgress";
import type { Task } from "../types";
import { TaskExecutionStatus } from "./TaskExecutionStatus";
import { TaskProgress } from "./TaskProgress";
import "./OwnerGoalsView.css";

interface OwnerGoalsViewProps {
  scrollRef?: Ref<HTMLElement>;
  projectName: string | null;
  referenceTasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  onOpenTask: (task: Task) => void;
  onOpenAgentDetails: () => void;
}

export function OwnerGoalsView({
  scrollRef,
  projectName,
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
    <section ref={scrollRef} className="owner-goals-view" aria-label={text("我的任务", "My tasks")}>
      <div className="owner-goals-content">
        <header className="owner-goals-heading">
          <div>
            <h1>{text("我的任务", "My tasks")}</h1>
            <p>{projectName === null
              ? text("所有项目 · 只看你提出的任务，每项进度单独看。", "All projects · Only your requests, each with its own progress.")
              : text(`${projectName} · 只看你提出的任务，每项进度单独看。`, `${projectName} · Only your requests, each with its own progress.`)}</p>
          </div>
          <button className="button secondary" type="button" onClick={onOpenAgentDetails}>
            {text("查看执行明细", "View execution details")}
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
            <h2>{referenceTasks.length > 0
              ? text("暂时没有可显示的「我的任务」", "No requests to show here yet")
              : text("这里还没有任务", "No tasks here yet")}</h2>
            <p>{referenceTasks.length > 0 ? text(
              "已有执行记录，但还未关联到你提出的任务。这一步由 Agent 补齐，你无需整理。",
              "Execution records exist, but are not yet linked to your requests. Agents handle this step; you do not need to organize them.",
            ) : text(
              "当前范围还没有任务记录。你只需在聊天窗口说出目标，不用在这里手动建卡。",
              "There are no task records in this scope. Share your goal in the chat; you do not need to create cards here.",
            )}</p>
          </div>
        )}
      </div>
    </section>
  );
}
