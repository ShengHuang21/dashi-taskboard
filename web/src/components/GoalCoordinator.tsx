import { useEffect, useRef, useState } from "react";
import {
  ApiError, getAiChatCatalog, getGoalCoordinator, interruptAiChatRun,
  resolveTaskboardUrl, startGoalCoordinator, startGoalTeamRound, subscribeAiChatThread,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { AiChatModel, GoalCoordinatorSnapshot, GoalCoordinatorStart, GoalTeamStart, Task } from "../types";
import "./GoalCoordinator.css";

interface GoalCoordinatorProps {
  task: Task;
  onOpenConversation: (threadId: string) => void;
  onRefreshTree: () => void;
}

export function GoalCoordinator({ task, onOpenConversation, onRefreshTree }: GoalCoordinatorProps) {
  const { text } = useTaskboardI18n();
  const [snapshot, setSnapshot] = useState<GoalCoordinatorSnapshot | null>(null);
  const [models, setModels] = useState<AiChatModel[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<GoalCoordinatorStart | null>(null);
  const pendingTeamRequest = useRef<GoalTeamStart | null>(null);
  const observedTerminal = useRef<string | null>(null);
  const refreshTree = useRef(onRefreshTree);
  refreshTree.current = onRefreshTree;
  const thread = snapshot?.thread;
  const run = snapshot?.latestRun;
  const selectedModel = models.find((candidate) => candidate.slug === model);
  const teamResult = snapshot?.teamResult;
  const admission = snapshot?.teamAdmission;

  useEffect(() => {
    const controller = new AbortController();
    void getGoalCoordinator(task.id, controller.signal).then((next) => {
      setSnapshot(next);
      setError(null);
      if (!next.thread) {
        void getAiChatCatalog(task.projectId, controller.signal).then((catalog) => {
          setModels(catalog.models);
        }).catch((failure: Error) => {
          if (failure.name !== "AbortError") setError(failure.message);
        });
      }
    }).catch((failure: Error) => {
      if (failure.name !== "AbortError") setError(failure.message);
    });
    return () => controller.abort();
  }, [task.id, task.projectId, task.version]);

  useEffect(() => {
    if (!thread) return;
    let active = true;
    let firstHint = true;
    const unsubscribe = subscribeAiChatThread(thread.id, (type) => {
      if (type !== "ai.run" && !firstHint) return;
      firstHint = false;
      void getGoalCoordinator(task.id).then((next) => {
        if (!active) return;
        setSnapshot(next);
        if (next.latestRun && next.latestRun.status !== "running"
          && observedTerminal.current !== next.latestRun.id) {
          observedTerminal.current = next.latestRun.id;
          refreshTree.current();
        }
      }).catch((failure: Error) => { if (active) setError(failure.message); });
    });
    return () => { active = false; unsubscribe(); };
  }, [thread?.id, task.id]);

  async function start() {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    const input = pendingRequest.current ?? {
      version: snapshot.goal.version,
      resumeToken: snapshot.goal.resumeToken,
      requestId: crypto.randomUUID(),
      model: thread?.model ?? model,
      reasoningEffort: thread?.reasoningEffort ?? effort,
    };
    pendingRequest.current = input;
    try {
      const next = await startGoalCoordinator(task.id, input);
      setSnapshot(next);
      pendingRequest.current = null;
      if (next.thread) onOpenConversation(next.thread.id);
      if (next.run && next.run.status !== "running") onRefreshTree();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("未能开始协调", "Could not start planning"));
      if (failure instanceof ApiError && failure.status > 0 && failure.status < 500) {
        pendingRequest.current = null;
        const next = await getGoalCoordinator(task.id).catch(() => null);
        if (next) setSnapshot(next);
      }
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!run || run.status !== "running") return;
    setBusy(true);
    setError(null);
    try {
      await interruptAiChatRun(run.id);
      setSnapshot(await getGoalCoordinator(task.id));
      onRefreshTree();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("未能停止执行", "Could not stop this run"));
    } finally {
      setBusy(false);
    }
  }

  async function executeNext() {
    if (!snapshot || !admission?.available || !admission.requestId
      || !admission.authorizationReference || !admission.resourceAdmissionReference) return;
    setBusy(true);
    setError(null);
    const input = pendingTeamRequest.current ?? {
      version: snapshot.goal.version, resumeToken: snapshot.goal.resumeToken,
      requestId: admission.requestId, authorizationReference: admission.authorizationReference,
      resourceAdmissionReference: admission.resourceAdmissionReference,
    };
    pendingTeamRequest.current = input;
    try {
      const next = await startGoalTeamRound(task.id, input);
      setSnapshot(next);
      pendingTeamRequest.current = null;
      if (next.thread) onOpenConversation(next.thread.id);
      if (next.run?.status !== "running") onRefreshTree();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("未能执行下一项", "Could not execute the next deliverable"));
      if (failure instanceof ApiError && failure.status > 0 && failure.status < 500) {
        pendingTeamRequest.current = null;
        const next = await getGoalCoordinator(task.id).catch(() => null);
        if (next) setSnapshot(next);
      }
    } finally {
      setBusy(false);
    }
  }

  const stateLabel = !run ? text("尚未执行", "Not started")
    : run.status === "running" ? snapshot?.activity === "team"
      ? text("本轮开发与独立验证协调中", "Coordinating development and independent validation")
      : text("协调执行中", "Planning in progress")
      : run.status === "completed" ? snapshot?.activity === "team"
        ? text("本轮协调已结束 · 交付结果见下方", "Team coordination ended · see the delivery result below")
        : text("本次协调已结束 · 不代表目标完成", "Planning turn finished · goal is not complete")
        : run.status === "interrupted" ? text("本次执行已停止", "This run was stopped")
          : text("本次执行失败 · 请查看对话", "This run failed · inspect the conversation");
  const canStart = snapshot && !snapshot.blocker && (!run || run.status === "completed")
    && (thread || (model && effort));
  const canExecute = !snapshot?.blocker && thread?.codexThreadId && run?.status === "completed"
    && run.exitCode === 0 && admission?.available;

  return (
    <section className="goal-coordinator" aria-label={text("目标协调", "Goal coordination")}>
      <div className="goal-coordinator-heading">
        <strong>{text("目标协调", "Goal coordination")}</strong>
        <span role="status">{snapshot ? stateLabel : text("读取协调状态…", "Loading coordination state…")}</span>
      </div>
      <p>{text(
        "“开始拆解 / 继续协调”只维护子任务与依赖。“执行下一项”单独安排一个就绪子项的开发和独立验证；原有工作窗口不受影响。",
        "Planning maintains deliverables and dependencies only. Execute next separately coordinates one ready deliverable through development and independent validation; existing work windows stay unchanged.",
      )}</p>
      {!thread && snapshot && !snapshot.blocker ? (
        <div className="goal-coordinator-settings">
          <label>{text("协调模型", "Coordinator model")}
            <select value={model} disabled={busy} onChange={(event) => {
              const next = models.find((candidate) => candidate.slug === event.target.value);
              setModel(event.target.value);
              setEffort(next?.defaultReasoningEffort ?? "");
            }}>
              <option value="">{text("选择当前协调任务使用的模型", "Select your current coordinator's model")}</option>
              {models.map((candidate) => <option key={candidate.slug} value={candidate.slug}>{candidate.displayName}</option>)}
            </select>
          </label>
          <label>{text("推理级别", "Reasoning effort")}
            <select value={effort} disabled={busy || !selectedModel} onChange={(event) => setEffort(event.target.value)}>
              {!selectedModel ? <option value="">—</option> : null}
              {selectedModel?.supportedReasoningEfforts.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      {thread ? <p>{text("独立托管协调任务", "Dedicated hosted coordinator")} · {thread.model} · {thread.reasoningEffort}</p> : null}
      {run ? <details><summary>{text("执行记录", "Run receipt")}</summary><code>{run.id}</code><p>{run.status}{run.finishedAt ? ` · ${run.finishedAt}` : ""}</p></details> : null}
      {snapshot?.blocker ? <p role="status">{snapshot.blocker.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="goal-coordinator-actions">
        {(!run || run.status === "completed") ? <button className="button primary" type="button" disabled={busy || !canStart} onClick={() => void start()}>
          {busy ? text("正在提交…", "Submitting…") : run ? text("继续协调", "Continue planning") : text("开始拆解", "Start planning")}
        </button> : null}
        {thread ? <button className="button secondary" type="button" onClick={() => onOpenConversation(thread.id)}>
          {text("查看协调对话", "Open coordinator")}
        </button> : null}
        {thread?.codexThreadId ? <button className="button secondary" type="button" disabled={busy || !canExecute} onClick={() => void executeNext()}>
          {text("执行下一项", "Execute next")}
        </button> : null}
        {run?.status === "running" && snapshot?.activity !== "team" ? <button className="button secondary" type="button" disabled={busy} onClick={() => void stop()}>
          {text("停止本次执行", "Stop this run")}
        </button> : null}
      </div>
      {thread?.codexThreadId && admission?.used ? <p>{text(
        "本轮执行记录已保留；下一轮尚未安排。",
        "This round's execution receipt is retained; another round has not been scheduled.",
      )}</p> : thread?.codexThreadId && !admission?.available ? <p>{text(
        "本机尚未提供此目标本轮的授权与资源准入证据，暂不可派发执行。规划仍可使用。",
        "Execution is unavailable until this goal has current operator-provided authorization and resource admission. Planning remains available.",
      )}</p> : null}
      {teamResult ? (
        <section className="goal-team-result" aria-label={text("最近交付结果", "Latest team result")}>
          <strong>{teamResult.verification === "verified" && teamResult.status === "review_pass"
            ? text("实现和独立验证已完成，等待最终验收", "Implementation and independent validation complete; awaiting acceptance")
            : teamResult.verification === "verified" && teamResult.status === "needs_fix"
              ? text("独立验证发现待修正项", "Independent validation found changes needed")
              : text("本轮尚未确认完成", "This round is not confirmed complete")}</strong>
          <p>{teamResult.childIdentifier ? `${teamResult.childIdentifier} · ` : ""}{teamResult.summary}</p>
          {teamResult.developerStatus && teamResult.validatorStatus ? <p>{text(
            "开发执行已结束 · 独立验证执行已结束 · 子项保持待验收",
            "Developer run finished · independent validator run finished · deliverable remains in review",
          )}</p> : null}
          <div className="goal-coordinator-actions">
            {teamResult.artifact ? <a className="button secondary" href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(teamResult.artifact.id)}/download`)} download={teamResult.artifact.filename}>
              {text("查看产物", "View artifact")}
            </a> : null}
            {teamResult.report ? <a className="button secondary" href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(teamResult.report.id)}/download`)} download={teamResult.report.filename}>
              {text("独立验证报告", "Validation report")}
            </a> : null}
          </div>
        </section>
      ) : snapshot?.activity === "team" && run?.status === "completed" ? <p>{text(
        "协调执行虽已结束，但还没有可核实的产物与独立验证记录；未认定交付完成。",
        "The coordinator ended without a verifiable artifact and independent report; delivery is not confirmed.",
      )}</p> : null}
    </section>
  );
}
