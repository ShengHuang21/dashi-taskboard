import { useTaskboardI18n } from "../i18n";
import type { DeliveryProgress } from "../taskProgress";
import "./TaskProgress.css";

export function TaskProgress({ progress, label }: { progress: DeliveryProgress; label: string }) {
  const { text, locale } = useTaskboardI18n();
  const value = progress.reason === "canceled"
    ? text("已取消 · 不计入完成度", "Canceled · excluded from completion")
    : progress.percent === null
      ? text("待评估", "Not yet estimated")
      : `${progress.percent}%`;
  const detail = progress.reason === "incomplete"
    ? text("交付项资料不完整", "Deliverable details are incomplete")
    : progress.reason === "unplanned"
      ? text("尚无可计算的交付项", "No measurable deliverable plan yet")
      : progress.reason === "canceled"
        ? ""
        : text(`已完成 ${progress.completed}/${progress.total} 项`, `${progress.completed}/${progress.total} deliverables complete`);
  const change = progress.latestChange;
  const changeLabel = change?.kind === "reopened"
    ? text("最近重新打开", "Last reopened")
    : change
      ? text("最近范围调整", "Last scope change") + " · " + {
        created: text("新增任务", "Task added"),
        canceled: text("取消任务", "Task canceled"),
        restored: text("恢复任务", "Task restored"),
        parent: text("调整子任务", "Subtasks changed"),
      }[change.kind]
      : null;
  return (
    <span className={`task-progress${progress.percent === null ? " is-unestimated" : ""}`}>
      <span className="task-progress-text"><b>{value}</b>{detail ? <span>{detail}</span> : null}</span>
      <span
        className="task-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent ?? undefined}
        aria-valuetext={[value, detail].filter(Boolean).join(" · ")}
      >
        <span style={{ width: `${progress.percent ?? 0}%` }} />
      </span>
      {change && changeLabel ? (
        <span className="task-progress-change">
          <span>{changeLabel}</span>
          <time dateTime={change.createdAt}>
            {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(change.createdAt))}
          </time>
        </span>
      ) : null}
    </span>
  );
}
