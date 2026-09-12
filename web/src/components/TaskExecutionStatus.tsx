import type { TaskExecutionState } from "../taskConversations";
import { useTaskboardI18n } from "../i18n";

const labels: Record<TaskExecutionState, readonly [string, string]> = {
  completed: ["已完成", "Completed"],
  canceled: ["已取消", "Canceled"],
  running: ["正在运行", "Running"],
  review: ["等待审核", "Awaiting review"],
  feedback: ["等待反馈", "Awaiting feedback"],
  dependency: ["等待前置任务", "Waiting for dependencies"],
  model_capacity: ["排队 · 等待模型容量", "Queued · waiting for model capacity"],
  uncertain: ["执行状态待确认", "Execution state unconfirmed"],
  interrupted: ["已中断 · 待继续", "Interrupted · awaiting continuation"],
  awaiting_claim: ["待领取", "Awaiting claim"],
  blocked: ["已阻塞", "Blocked"],
  not_running: ["当前未运行", "Not running now"],
  not_planned: ["尚未安排", "Not scheduled"],
  not_started: ["待开始", "Not started"],
};

export function TaskExecutionStatus({
  state,
  className,
  elapsed,
}: {
  state: TaskExecutionState;
  className?: string;
  elapsed?: string;
}) {
  const { text } = useTaskboardI18n();
  const label = text(...labels[state]);
  return <span className={className} data-execution-state={state}>
    {state === "running" && elapsed ? `${label} · ${elapsed}` : label}
  </span>;
}
