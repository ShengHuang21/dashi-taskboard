import { useTaskboardI18n } from "../i18n";
import type { CodexThreadBinding, TaskGoalWindows } from "../types";
import "./OwnerGoalsView.css";

interface GoalWindowsProps {
  declaration: TaskGoalWindows | null | undefined;
  onOpenThread: (binding: CodexThreadBinding) => void;
}

export function GoalWindows({ declaration, onOpenThread }: GoalWindowsProps) {
  const { text } = useTaskboardI18n();
  if (!declaration) return null;
  return (
    <details className="goal-windows">
      <summary>{text("协作窗口", "Collaborating windows")}</summary>
      {declaration.state !== "declared" ? (
        <p>{text("待关联 · 最新窗口记录需核实", "Association pending · latest window record needs verification")}</p>
      ) : (
        <>
          <ul className="goal-windows-members">
            {declaration.windows.map((member) => (
              <li key={member.threadId}>
                <div>
                  <span className="goal-window-title">{member.title}</span>
                  <span className="goal-window-role">{member.role === "coding"
                    ? text("代码处理", "Coding") : text("图文说明", "Illustrated guide")}</span>
                </div>
                {member.threadBinding ? (
                  <button
                    className="button secondary"
                    type="button"
                    aria-label={text(`打开 ${member.title}`, `Open ${member.title}`)}
                    onClick={() => onOpenThread(member.threadBinding!)}
                  >{text("打开", "Open")}</button>
                ) : <span className="goal-window-location">{text("定位待核实", "Location unverified")}</span>}
              </li>
            ))}
          </ul>
          {declaration.resourceRefs.length > 0 ? (
            <div className="goal-windows-resources">
              <p>{text("共享环境记录已关联 · 状态未接入", "Shared environment record linked · state not connected")}</p>
              <ul>
                {declaration.resourceRefs.map((ref) => (
                  <li key={ref.allocationId}>
                    <code>{ref.allocationId}</code>
                    <small>{ref.taskId} / {ref.stepId}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </details>
  );
}
