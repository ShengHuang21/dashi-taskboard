import { useTaskboardI18n } from "../i18n";
import type { DeliveryProgress } from "../taskProgress";
import type { TaskStatus } from "../types";
import "./TaskProgress.css";

export function TaskProgress({ progress, label, showStages = false, reviewReceipt = null, leafStatus }: {
  progress: DeliveryProgress;
  label: string;
  showStages?: boolean;
  leafStatus?: TaskStatus;
  reviewReceipt?: { status: "changes_requested" | "pass"; reviewerThreadId: string; model: string; reasoningEffort: string; sourceRef: string } | null;
}) {
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
  const changeDate = change && changeLabel
    ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(change.createdAt))
    : null;
  return (
    <span className={`task-progress${progress.percent === null ? " is-unestimated" : ""}`}>
      <span
        className="task-progress-track"
        role="progressbar"
        aria-label={text(`${label}（用户验收）`, `${label} (user acceptance)`)}
        title={text("此进度条表示用户验收完成度", "This progress bar represents user acceptance")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent ?? undefined}
        aria-valuetext={[value, detail, changeLabel, changeDate].filter(Boolean).join(" · ")}
      >
        <span style={{ width: `${progress.percent ?? 0}%` }} />
      </span>
      {showStages ? <span className="task-progress-stages" aria-label={text("交付阶段", "Delivery stages")}>
        <span>{text("实现", "Implementation")} · {progress.reason === "canceled"
          ? text("已取消", "Canceled") : leafStatus ? (["in_review", "done"].includes(leafStatus) ? text("已交付", "Delivered") : text("尚未交付", "Not delivered")) : progress.percent === null ? text("未记录", "Not recorded")
            : text(`已交付 ${progress.implemented ?? 0}/${progress.implementationTotal ?? progress.total}`, `Delivered ${progress.implemented ?? 0}/${progress.implementationTotal ?? progress.total}`)}</span>
        <span>{text("AI 审查", "AI review")} · {reviewReceipt
          ? reviewReceipt.status === "changes_requested" ? text("已登记：要求修改", "Registered: changes requested")
            : text("已登记：通过（非平台验证）", "Registered: pass (not platform-verified)")
          : text("已验证收据未记录", "Verified receipt not recorded")}</span>
        <span>{text("用户验收", "User acceptance")} · {progress.reason === "canceled"
          ? text("已取消", "Canceled") : leafStatus ? (leafStatus === "done" ? text("已验收", "Accepted") : text("未验收", "Not accepted")) : progress.percent === null ? text("未记录", "Not recorded")
            : text(`已验收 ${progress.completed}/${progress.total}`, `Accepted ${progress.completed}/${progress.total}`)}</span>
      </span> : null}
    </span>
  );
}
