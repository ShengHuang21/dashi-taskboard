import { useTaskboardI18n } from "../i18n";
import type { DeliveryProgress } from "../taskProgress";
import "./TaskProgress.css";

export function TaskProgress({ progress, label }: { progress: DeliveryProgress; label: string }) {
  const { text } = useTaskboardI18n();
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
    </span>
  );
}
