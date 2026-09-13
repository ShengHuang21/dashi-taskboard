import { useEffect, useState } from "react";
import { ApiError, getResourceStep } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { CodexThreadBinding, ResourceAllocationRecord, ResourceStepRecord, TaskGoalWindows } from "../types";
import "./OwnerGoalsView.css";

interface GoalWindowsProps {
  declaration: TaskGoalWindows | null | undefined;
  onOpenThread: (binding: CodexThreadBinding) => void;
}

export function GoalWindows({ declaration, onOpenThread }: GoalWindowsProps) {
  return declaration ? <DeclaredGoalWindows key={declaration.sourceCommentId} declaration={declaration} onOpenThread={onOpenThread} /> : null;
}

function DeclaredGoalWindows({ declaration, onOpenThread }: GoalWindowsProps & { declaration: TaskGoalWindows }) {
  const { text } = useTaskboardI18n();
  const [opened, setOpened] = useState(false);
  return (
    <details className="goal-windows" onToggle={(event) => {
      if (event.target === event.currentTarget) setOpened(event.currentTarget.open);
    }}>
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
              <p>{text("共享环境记录 · 不代表整机空闲或启动许可", "Shared environment records · not host availability or permission to start")}</p>
              <ul>
                {declaration.resourceRefs.map((ref) => (
                  <GoalResourceRecord
                    key={`${declaration.sourceCommentId}:${declaration.sourceCommentVersion}:${ref.taskId}:${ref.stepId}:${ref.allocationId}`}
                    reference={ref}
                    windows={declaration.windows}
                    opened={opened}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </details>
  );
}

const WAITING_REASONS: Record<string, [string, string]> = {
  waiting_checkpoint: ["等待原窗口安全检查点", "Waiting for the original window's safe checkpoint"],
  waiting_resource_allocation_release: ["等待既有占用交还", "Waiting for an existing allocation to be returned"],
  waiting_host_resources: ["等待 CPU / 内存余量", "Waiting for CPU / memory headroom"],
  waiting_ordinary_start_observation: ["等待普通启动结果对账", "Waiting for ordinary startup reconciliation"],
  resource_host_observation_required: ["等待主机资源观察", "Waiting for a host resource observation"],
  resource_post_start_observation_required: ["等待启动后的新观察", "Waiting for a fresh post-start observation"],
  resource_slot_observation_required: ["等待 Agent 槽位观察", "Waiting for an agent-slot observation"],
  environment_observation_required: ["等待环境所有者声明", "Waiting for an environment owner declaration"],
  resource_step_no_ready_waiter: ["等待原执行方登记检查点", "Waiting for the original executor's checkpoint"],
  ordinary_candidate_precedes: ["优先处理队列中的其他任务", "Another queued task takes precedence"],
  resource_step_authorization_required: ["授权记录待核实", "Authorization record needs verification"],
  resource_step_action_scope_required: ["执行动作范围待核实", "Action scope needs verification"],
  resource_step_current_scope_blocked: ["当前任务范围待核实", "Current task scope needs verification"],
  resource_step_run_binding_required: ["本轮执行身份待核实", "Execution identity needs verification"],
};

type Text = (chinese: string, english: string) => string;

function stepLabel(record: ResourceStepRecord, text: Text) {
  const { step, executionOutcome } = record;
  if (executionOutcome === "start_uncertain" || step.result?.outcome === "start_uncertain") {
    return text("启动结果待对账", "Startup outcome needs reconciliation");
  }
  if (step.state === "queued") return text("排队记录", "Queued record");
  if (step.state === "reserved") return text("已预留 · 等待原执行方确认", "Reserved · waiting for the original executor");
  if (step.state === "result_recorded" && step.result) {
    if (step.result.outcome === "no_start") return text("已记录未启动结果", "No-start outcome recorded");
    if (step.result.outcome === "exited") return step.result.exitCode === null
      ? text("退出结果已记录 · 退出码未知", "Exit outcome recorded · exit code unknown")
      : text(`退出结果已记录 · 退出码 ${step.result.exitCode}`, `Exit outcome recorded · exit code ${step.result.exitCode}`);
  }
  return text("本轮状态待核实", "Step state needs verification");
}

function environmentLabel(environment: ResourceAllocationRecord | null, queriedAt: string, text: Text) {
  if (environment?.kind !== "environment" || environment.source !== "owner_declaration") {
    return text("当前状态未知 · 缺少环境所有者声明", "Current state unknown · no environment owner declaration");
  }
  if (environment.state === "released" && environment.releasedAt) {
    return text("该份占用已明确交还（记录）", "This allocation was explicitly returned (record)");
  }
  const readAt = Date.parse(queriedAt);
  if (!(Date.parse(environment.declaredAt ?? "") <= readAt && readAt < Date.parse(environment.validUntil ?? ""))) {
    return environment.state === "held" && !environment.releasedAt
      ? text("当前状态未知 · 占用尚无交还记录", "Current state unknown · no return recorded for the held allocation")
      : text("当前状态未知 · 声明已过期或时间待核实", "Current state unknown · declaration expired or time unverified");
  }
  if (environment.state === "available") return text("读取时所有者已声明可用", "Owner had declared availability at read time");
  if (environment.state === "held") return text("读取时记录为占用 · 未交还", "Recorded as held at read time · not returned");
  return text("当前状态未知", "Current state unknown");
}

function GoalResourceRecord({ reference, windows, opened }: {
  reference: TaskGoalWindows["resourceRefs"][number];
  windows: TaskGoalWindows["windows"];
  opened: boolean;
}) {
  const { text } = useTaskboardI18n();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<
    { status: "idle" | "loading" | "missing" | "local_only" | "error" | "mismatch" }
    | { status: "loaded"; record: ResourceStepRecord; queriedAt: string }
  >({ status: "idle" });
  const { taskId, stepId, allocationId } = reference;
  useEffect(() => {
    if (!opened) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    setState({ status: "loading" });
    getResourceStep(taskId, stepId, controller.signal).then((record) => {
      if (controller.signal.aborted) return;
      if (record.step?.id !== stepId || record.step.taskId !== taskId
        || (record.environment?.id !== allocationId && record.allocation?.id !== allocationId)) {
        setState({ status: "mismatch" });
      } else {
        setState({ status: "loaded", record, queriedAt: new Date().toISOString() });
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({ status: error instanceof ApiError && error.status === 404 ? "missing"
        : error instanceof ApiError && error.code === "LOCAL_ONLY" ? "local_only" : "error" });
    });
    return () => controller.abort();
  }, [opened, revision, taskId, stepId, allocationId]);

  const owner = (threadId: string) => windows.find((member) => member.threadId === threadId)?.title ?? threadId;
  const record = state.status === "loaded" ? state.record : null;
  const reason = record?.waitingReason ? WAITING_REASONS[record.waitingReason] : null;
  return (
    <li className="goal-resource-record">
      <div className="goal-resource-heading">
        <code title={allocationId}>{allocationId.slice(0, 12)}</code>
        <button type="button" className="button secondary" disabled={!opened || state.status === "loading"} onClick={() => setRevision((value) => value + 1)}>
          {text("刷新记录", "Refresh record")}
        </button>
      </div>
      {state.status === "loaded" && record ? (
        <>
          <p>{text("本轮记录：", "Step record: ")}{record.step.actionId} · {stepId.slice(0, 8)} — {stepLabel(record, text)}
            {record.allocation?.kind === "heavy" ? <small>{record.allocation.releasedAt
              ? text("本轮预留已明确交还", "This step's reservation was explicitly returned")
              : text("本轮预留尚未交还", "This step's reservation has not been returned")}</small> : null}
          </p>
          <p>{text("最近队列等待原因：", "Last recorded queue wait reason: ")}{reason ? text(...reason)
            : record.waitingReason ? text(`原因待核实（${record.waitingReason}）`, `Reason unverified (${record.waitingReason})`)
              : text("无等待原因记录", "No wait reason recorded")}</p>
          <p>{text("共享环境声明：", "Environment declaration: ")}{environmentLabel(record.environment, state.queriedAt, text)}
            {record.environment?.kind === "environment" && record.environment.source === "owner_declaration"
              ? <small>{text("所有者：", "Owner: ")}{owner(record.environment.ownerThreadId)}</small> : null}
          </p>
          <small>{text("读取于：", "Read at: ")}<time dateTime={state.queriedAt}>{state.queriedAt}</time></small>
        </>
      ) : <p role="status">{state.status === "missing" ? text("记录未找到", "Record not found")
        : state.status === "local_only" ? text("仅本机可读", "Local-only record")
          : state.status === "mismatch" ? text("引用待核实", "Reference needs verification")
            : state.status === "error" ? text("暂无法读取", "Temporarily unable to read")
              : text("读取记录中…", "Reading record…")}</p>}
      <details className="goal-resource-reference">
        <summary>{text("引用与时间", "References and times")}</summary>
        <small>{text("引用：", "Reference: ")}{taskId} / {stepId} / {allocationId}</small>
        {record ? <>
          <small>{text("本轮所有者：", "Step owner: ")}{owner(record.step.ownerThreadId)} · {record.step.ownerThreadId} / {record.step.runId}</small>
          <small>{text("建立于：", "Created at: ")}{record.step.createdAt}</small>
          {record.step.waiter ? <small>{text("检查点：", "Checkpoint: ")}{record.step.waiter.observedAt} → {record.step.waiter.validUntil}</small> : null}
          {record.step.grantedAt ? <small>{text("预留于：", "Reserved at: ")}{record.step.grantedAt}</small> : null}
          {record.step.consumedAt ? <small>{text("启动消费于：", "Start consumed at: ")}{record.step.consumedAt}</small> : null}
          {record.step.resultRecordedAt ? <small>{text("结果记录于：", "Result recorded at: ")}{record.step.resultRecordedAt}</small> : null}
          {record.environment ? <small>{text("环境来源：", "Environment source: ")}{record.environment.source} / {record.environment.sourceRef} · v{record.environment.sourceVersion ?? "?"}
            <br />{record.environment.ownerThreadId} · {record.environment.declaredAt ?? "?"} → {record.environment.validUntil ?? "?"}
            {record.environment.releasedAt ? <><br />{text("交还于：", "Returned at: ")}{record.environment.releasedAt}</> : null}</small> : null}
          {record.allocation ? <small>{text("本轮预留：", "Step allocation: ")}{record.allocation.id} · {record.allocation.source} / {record.allocation.ownerThreadId}
            {record.allocation.releasedAt ? <><br />{text("交还于：", "Returned at: ")}{record.allocation.releasedAt}</> : null}</small> : null}
        </> : null}
      </details>
    </li>
  );
}
