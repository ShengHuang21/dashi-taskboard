import { useEffect, useRef, useState } from "react";
import {
  ApiError, getAiChatCatalog, getGoalCoordinator, interruptAiChatRun,
  resolveTaskboardUrl, startGoalCoordinator, startGoalTeamRound, subscribeAiChatThread,
  controlGoalSupervision, queueGoalIdea,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { AiChatModel, GoalCoordinatorSnapshot, GoalCoordinatorStart, GoalTeamStart, Task } from "../types";
import "./GoalCoordinator.css";

export interface GoalAdoptedInputs {
  goalId: string;
  inputs: NonNullable<GoalCoordinatorSnapshot["adoptedInputs"]>;
  hasCoordinatorHistory: boolean;
}

interface GoalCoordinatorProps {
  task: Task;
  onOpenConversation: (threadId: string) => void;
  onRefreshTree: () => void;
  onAdoptedInputsChange: (projection: GoalAdoptedInputs | null) => void;
}

export function GoalCoordinator({ task, onOpenConversation, onRefreshTree, onAdoptedInputsChange }: GoalCoordinatorProps) {
  const { text } = useTaskboardI18n();
  const [snapshot, setSnapshot] = useState<GoalCoordinatorSnapshot | null>(null);
  const [models, setModels] = useState<AiChatModel[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [ideaBusy, setIdeaBusy] = useState(false);
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const pendingIdea = useRef<{ deliveryId: string; body: string } | null>(null);
  const pendingControl = useRef<{ action: "enable" | "pause"; requestId: string } | null>(null);
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
  const supervision = snapshot?.supervision;
  const continuing = supervision?.state === "active";
  const queuedIdeaMessage = continuing
    ? text("已收到，将在下一安全边界协调处理", "Received; will be handled at the next safe boundary")
    : text("已收到，等待再次继续协调；尚未处理", "Received; awaiting continued coordination, not yet handled");

  function invalidateAdoptedInputs() {
    setSnapshot((previous) => previous ? { ...previous, adoptedInputs: undefined } : null);
  }

  function setError(message: string | null) {
    setErrorState(message);
    if (message) invalidateAdoptedInputs();
  }

  useEffect(() => {
    onAdoptedInputsChange(snapshot?.goal.id === task.id
      ? { goalId: task.id, inputs: snapshot.adoptedInputs ?? [],
        hasCoordinatorHistory: Boolean(snapshot.latestRun || snapshot.supervision) } : null);
    return () => onAdoptedInputsChange(null);
  }, [snapshot, task.id, onAdoptedInputsChange]);

  useEffect(() => {
    pendingIdea.current = null;
    pendingControl.current = null;
    pendingRequest.current = null;
    pendingTeamRequest.current = null;
    setIdea("");
    setIdeaError(null);
  }, [task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    void getGoalCoordinator(task.id, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
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
        const terminalRevision = JSON.stringify([next.latestRun?.id, next.supervision?.state,
          next.adoptedInputs?.map((input) => input.adoptionId), next.ideas?.map((item) => [item.deliveryId, item.status])]);
        if (next.latestRun && next.latestRun.status !== "running"
          && observedTerminal.current !== terminalRevision) {
          observedTerminal.current = terminalRevision;
          refreshTree.current();
        }
      }).catch((failure: Error) => { if (active) setError(failure.message); });
    });
    return () => { active = false; unsubscribe(); };
  }, [thread?.id, task.id]);

  useEffect(() => {
    if (admission?.state !== "resources_checking") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void getGoalCoordinator(task.id, controller.signal).then(setSnapshot).catch((failure: Error) => {
        if (failure.name !== "AbortError") setError(failure.message);
      });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [task.id, admission?.state]);

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
    if (!snapshot || (!admission?.available && !pendingTeamRequest.current)) return;
    setBusy(true);
    setError(null);
    const input = pendingTeamRequest.current ?? {
      version: snapshot.goal.version, resumeToken: snapshot.goal.resumeToken,
      requestId: crypto.randomUUID(),
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

  async function control(action: "enable" | "pause") {
    setBusy(true);
    setError(null);
    const input = pendingControl.current?.action === action
      ? pendingControl.current : { action, requestId: crypto.randomUUID() };
    pendingControl.current = input;
    try {
      setSnapshot(await controlGoalSupervision(task.id, input));
      pendingControl.current = null;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("未能更新持续推进", "Could not update continuation"));
      if (failure instanceof ApiError && failure.status > 0 && failure.status < 500) pendingControl.current = null;
    } finally { setBusy(false); }
  }

  async function submitIdea() {
    if (!idea.trim() && !pendingIdea.current) return;
    setIdeaBusy(true);
    setIdeaError(null);
    const input = pendingIdea.current ?? { deliveryId: crypto.randomUUID(), body: idea.trim() };
    pendingIdea.current = input;
    try {
      await queueGoalIdea(task.id, input);
      pendingIdea.current = null;
      setIdea("");
      setSnapshot(await getGoalCoordinator(task.id));
    } catch (failure) {
      setIdeaError(failure instanceof Error ? failure.message : text("未能保存想法", "Could not save the idea"));
      invalidateAdoptedInputs();
      if (failure instanceof ApiError && failure.status > 0 && failure.status < 500) pendingIdea.current = null;
    } finally { setIdeaBusy(false); }
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
  const canStart = snapshot && !continuing && !snapshot.blocker && (!run || run.status === "completed")
    && (thread || (model && effort));
  const canExecute = !continuing && !snapshot?.blocker && thread?.codexThreadId && run?.status === "completed"
    && run.exitCode === 0 && (admission?.available || pendingTeamRequest.current);

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
        {thread?.codexThreadId ? <button className="button primary" type="button" disabled={busy}
          onClick={() => void control(continuing ? "pause" : "enable")}>
          {continuing ? text("暂停后续推进", "Pause future work") : text("持续推进此目标", "Keep advancing this goal")}
        </button> : null}
        {thread?.codexThreadId && supervision?.state === "blocked" ? <button className="button secondary" type="button" disabled={busy}
          onClick={() => void control("pause")}>
          {text("暂停后续推进", "Pause future work")}
        </button> : null}
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
      {supervision ? <p role="status" aria-live="polite">{supervision.message}</p> : null}
      <form className="goal-idea-form" onSubmit={(event) => { event.preventDefault(); void submitIdea(); }}>
        <label htmlFor={`goal-idea-${task.id}`}>{text("补充想法", "Add an idea")}</label>
        <textarea id={`goal-idea-${task.id}`} value={idea} rows={3} maxLength={100000}
          disabled={ideaBusy || Boolean(pendingIdea.current)} onChange={(event) => setIdea(event.target.value)}
          aria-describedby={`goal-idea-hint-${task.id}`} />
        <p id={`goal-idea-hint-${task.id}`}>{continuing
          ? text("想法只入队，当前工作不会被打断；下一安全边界由协调者处理。", "Ideas are queued without interrupting current work; the coordinator handles them at the next safe boundary.")
          : text("想法只入队，等待下一次继续协调；不会自动启动工作。", "Ideas are queued for the next continued coordination; no work starts automatically.")}</p>
        <button className="button secondary" disabled={ideaBusy || (!idea.trim() && !pendingIdea.current)} type="submit">
          {ideaBusy ? text("保存中…", "Saving…") : pendingIdea.current ? text("重试保存同一想法", "Retry saving this idea") : text("提交想法", "Submit idea")}
        </button>
        {ideaError ? <p role="alert">{ideaError}</p> : null}
      </form>
      {snapshot?.ideas?.length ? <ul className="goal-idea-list" aria-label={text("想法处置", "Idea dispositions")}>
        {snapshot.ideas.map((item) => <li key={item.deliveryId}>
          <p>{item.body}</p><span>{item.status === "queued" ? queuedIdeaMessage
            : item.status === "applied" ? text("已纳入计划", "Applied to the plan")
              : item.status === "deferred" ? text("已延期，尚未落实", "Deferred, not implemented") : text("需要新的决定", "Needs a decision")}</span>
          {item.disposition ? <p>{item.disposition.action} · {item.disposition.revision}</p> : null}
        </li>)}
      </ul> : null}
      {snapshot?.adoptedInputs?.map((input) => <section className="goal-team-result" key={input.adoptionId}>
        <strong>{input.consumerTitle} · {input.fullCoverage ? text("既有独立验证成果已复用，待最终验收", "Existing independent evidence reused; awaiting acceptance")
          : text("已采用精确产物输入（该次采纳未覆盖全部验收）", "Exact artifact input adopted (that adoption did not cover all acceptance criteria)")}</strong>
        <p>{text("只表示此目标内的产物输入可用，不代表原任务已获最终接受。", "This input is usable within this goal; it does not mean the source has final acceptance.")}</p>
        <div className="goal-coordinator-actions">
          <a className="button secondary" href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(input.artifactAttachmentId)}/download`)}>{text("查看产物", "View artifact")}</a>
          <a className="button secondary" href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(input.reportAttachmentId)}/download`)}>{text("独立验证报告", "Validation report")}</a>
        </div>
      </section>)}
      {thread?.codexThreadId && admission ? <p role="status">{admission.message}</p> : null}
      {thread?.codexThreadId && !admission?.available && run?.status !== "running" ? (
        <button className="button secondary" type="button" disabled={busy} onClick={() => {
          setBusy(true);
          void getGoalCoordinator(task.id).then(setSnapshot).catch((failure: Error) => setError(failure.message))
            .finally(() => setBusy(false));
        }}>{text("重新检查执行条件", "Recheck execution readiness")}</button>
      ) : null}
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
      ) : snapshot?.activity === "team" && run?.status === "completed" && !snapshot.adoptedInputs?.length
        && supervision?.state !== "endpoint_reached" ? <p>{text(
        "协调执行虽已结束，但还没有可核实的产物与独立验证记录；未认定交付完成。",
        "The coordinator ended without a verifiable artifact and independent report; delivery is not confirmed.",
      )}</p> : null}
    </section>
  );
}
