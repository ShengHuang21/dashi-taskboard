import { useEffect, useState } from "react";

import { ApiError, getAgentLaneSnapshot } from "../api";
import type {
  AgentLaneSnapshot,
  AgentTaskLaneSnapshot,
  CoordinationDispatchTarget,
  CoordinationTodoSnapshot,
  RootSubagentSnapshot,
} from "../types";

interface AgentLaneBoardProps {
  projectId: string;
  projectName: string;
  onOpenCodexThread: (threadId: string) => Promise<boolean>;
  onCoordinateTodo: (
    todoId: string,
    target: CoordinationDispatchTarget,
    safeActionId: string,
    resumeToken: string,
  ) => Promise<boolean>;
}

const STATUS_LABELS = {
  running: "运行中",
  idle: "空闲",
  unavailable: "不可用",
} as const;

const SUBAGENT_STATUS_LABELS = {
  running: "运行中",
  idle: "已结束",
  completed: "已完成",
  interrupted: "已中断",
} as const;

const TODO_STATUS_LABELS = {
  ready: "待领取",
  claimed: "执行中",
  waiting_user: "等待你",
  blocked: "阻塞",
  validating: "验证中",
  completed: "已完成",
} as const;

const LEASE_LABELS = { active: "有效", expired: "已过期", completed: "已完成" } as const;
const RUN_STATE_LABELS = {
  active: "执行中",
  blocked: "已阻塞",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  expired: "已过期",
  expired_unresolved: "租约待处理",
} as const;
const ATTENTION_LABELS = {
  needs_user: "需要你", needs_coordinator: "需要 Root", blocked: "已阻塞",
  ready: "可领取", watch: "进行中", done: "已完成",
} as const;

function activityKeyword(value: string | null, fallback: string) {
  const text = value ?? "";
  const matches: Array<[RegExp, string]> = [
    [/KYC|身份.*(?:验证|核验)|verification/i, "KYC 核验"],
    [/account.*status|账户.*状态|钱包.*状态/i, "账户状态"],
    [/wallet.*balance|钱包.*余额|可用资金/i, "钱包余额"],
    [/currency|币种/i, "交易币种"],
    [/transaction.*kind|交易.*类型|P2P.*merchant/i, "交易类型"],
    [/occurrence.*time|发生.*时间|交易.*时间/i, "交易时间"],
    [/reference|交易.*编号/i, "交易编号"],
    [/instrument|银行卡|支付工具/i, "支付工具"],
    [/counterparty|交易对手|收款人|付款人/i, "交易对象"],
    [/Taskboard|面板|Sub-Agent/i, "简化面板"],
    [/Visual|证据同步|Q01/i, "同步证据"],
    [/Support|RAG/i, "客服功能"],
  ];
  return matches.find(([pattern]) => pattern.test(text))?.[1] ?? fallback;
}

function readableSubagentName(value: string) {
  const words: Record<string, string> = {
    accepted: "回执",
    ack: "确认",
    archive: "归档",
    ci: "CI",
    definite: "确定性",
    error: "错误",
    frontend: "前端",
    independent: "独立",
    refresh: "刷新",
    retry: "重试",
    safety: "安全",
    scope: "范围",
    security: "安全",
    testing: "测试",
    review: "审查",
  };
  const translated = value.split("_").map((part) => words[part] ?? part).filter((part, index, all) => all.indexOf(part) === index);
  return translated.join(" ");
}

function completedWorkCategory(agent: RootSubagentSnapshot) {
  const text = `${agent.label} ${agent.lastActualAction ?? ""}`;
  const categories: Array<[RegExp, string]> = [
    [/review|audit|审查|审核|检查.*绕过|bypass/i, "代码审查"],
    [/test|validation|verify|oracle|CI|测试|验证/i, "测试验证"],
    [/Taskboard|面板|frontend|UI|界面/i, "界面优化"],
    [/Visual|presentation|图片|演讲|证据同步/i, "视觉材料"],
    [/Support|RAG|retrieval|客服|检索/i, "客服功能"],
  ];
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? "其他工作";
}

function groupCompletedSubagents(agents: RootSubagentSnapshot[]) {
  const groups = new Map<string, RootSubagentSnapshot[]>();
  for (const agent of agents) {
    const category = completedWorkCategory(agent);
    groups.set(category, [...(groups.get(category) ?? []), agent]);
  }
  return [...groups].map(([category, items]) => ({ category, items }));
}

function TaskLaneCard({
  lane,
  root = false,
  onOpenCodexThread,
}: {
  lane: AgentTaskLaneSnapshot;
  root?: boolean;
  onOpenCodexThread: (threadId: string) => Promise<boolean>;
}) {
  const [openState, setOpenState] = useState<"idle" | "opening" | "opened">("idle");
  const canOpenConversation = lane.source === "codex"
    && lane.connection === "connected"
    && lane.threadId !== null;

  return (
    <article
      className={`agent-lane-card agent-lane-simple-card${root ? " agent-lane-root-card" : ""} is-${lane.status}`}
      role="listitem"
    >
      <div className="agent-lane-card-heading">
        <h3>{lane.label}</h3>
        <span className="agent-lane-status">{STATUS_LABELS[lane.status]}</span>
      </div>
      <p className="agent-lane-current-work"><span>正在做</span>{activityKeyword(lane.lastActualAction, lane.status === "running" ? "处理中" : "等待任务")}</p>
      {canOpenConversation && (
        <button
          className="agent-lane-open-conversation"
          type="button"
          disabled={openState === "opening"}
          onClick={async () => {
            setOpenState("opening");
            setOpenState(await onOpenCodexThread(lane.threadId!) ? "opened" : "idle");
          }}
        >
          {openState === "opening" ? "正在打开…" : openState === "opened" ? "已在 Codex 打开" : "打开 Codex 对话"}
        </button>
      )}
    </article>
  );
}

function TodoCard({
  todo,
  onCoordinateTodo,
}: {
  todo: CoordinationTodoSnapshot;
  onCoordinateTodo: (
    todoId: string,
    target: CoordinationDispatchTarget,
    safeActionId: string,
    resumeToken: string,
  ) => Promise<boolean>;
}) {
  const [deliveryState, setDeliveryState] = useState<"idle" | "sending" | "sent">("idle");
  const hasOpenRun = todo.run?.state === "active" || todo.run?.state === "blocked";
  const safeAction = todo.readyWork.safeActions[0] ?? null;
  const canCoordinate = todo.readyWork.eligible
    && todo.dispatchTarget !== null
    && safeAction !== null
    && todo.readyWork.resumeToken !== null
    && !hasOpenRun;
  useEffect(() => setDeliveryState("idle"), [
    todo.id,
    todo.readyWork.eligible,
    todo.dispatchTarget?.rootThreadId,
    safeAction?.id,
    todo.readyWork.resumeToken,
    hasOpenRun,
  ]);
  const nextAction = activityKeyword(todo.readyWork.nextAction ?? todo.nextAction, todo.readyWork.eligible ? "等待领取" : "等待条件满足");
  return (
    <article className={`agent-todo-card is-${todo.state}`} role="listitem">
      <div className="agent-lane-card-heading">
        <h4>{todo.title}</h4>
        <span className="agent-lane-status">{TODO_STATUS_LABELS[todo.state]}</span>
      </div>
      <dl className="agent-todo-facts">
        <div><dt>认领</dt><dd>{todo.claim?.ownerLabel ?? "未认领"}</dd></div>
        <div><dt>租约</dt><dd>{todo.claim ? LEASE_LABELS[todo.claim.leaseState] : "未开始"}</dd></div>
        <div><dt>写入范围</dt><dd>{todo.writeScope.length ? todo.writeScope.join("、") : "无"}</dd></div>
        <div><dt>工作日志</dt><dd>{todo.workingLog ? `${todo.workingLog.status}: ${todo.workingLog.path}` : "未记录"}</dd></div>
        <div><dt>执行</dt><dd>{todo.run ? RUN_STATE_LABELS[todo.run.state] : "未启动"}</dd></div>
        <div><dt>关注</dt><dd>{ATTENTION_LABELS[todo.continuation.attention]}</dd></div>
      </dl>
      {(todo.readyWork.safeActions.length > 0 || todo.readyWork.deferredActions.length > 0) && (
        <div className="agent-todo-authorization-summary" aria-label="任务授权状态">
          <span>安全工作 {todo.readyWork.safeActions.length}</span>
          <span>延后动作 {todo.readyWork.deferredActions.length}</span>
        </div>
      )}
      <p className="agent-lane-current-work"><span>下一步</span>{nextAction}</p>
      {todo.readyWork.approvalRequest?.message && (
        <div className="agent-todo-approval-request" role="status">
          <strong>授权请求</strong>
          <p>{todo.readyWork.approvalRequest.message}</p>
          {todo.readyWork.approvalRequest.scope && <small>范围：{todo.readyWork.approvalRequest.scope}</small>}
        </div>
      )}
      {deliveryState === "sent" && !hasOpenRun && (
        <p className="agent-lane-current-work"><span>交付回执</span>Root 已收到；尚未确认 durable Run 执行中。</p>
      )}
      {canCoordinate && (
        <button
          className="agent-todo-coordinate"
          type="button"
          disabled={deliveryState !== "idle"}
          onClick={async () => {
            setDeliveryState("sending");
            setDeliveryState(await onCoordinateTodo(
              todo.id,
              todo.dispatchTarget!,
              safeAction!.id,
              todo.readyWork.resumeToken!,
            ) ? "sent" : "idle");
          }}
        >
          {deliveryState === "sending" ? "正在交给 Root…" : deliveryState === "sent" ? "Root 已收到" : "交给 Root 协调"}
        </button>
      )}
    </article>
  );
}

function SubagentCard({ agent }: { agent: RootSubagentSnapshot }) {
  return (
    <article className={`agent-lane-card agent-subagent-card is-${agent.lifecycleStatus}`} role="listitem">
      <div className="agent-lane-card-heading">
        <h4>{readableSubagentName(agent.label)}</h4>
        <span className="agent-lane-status">{SUBAGENT_STATUS_LABELS[agent.lifecycleStatus]}</span>
      </div>
      <p className="agent-lane-current-work"><span>任务</span>{activityKeyword(agent.lastActualAction, "代码审查")}</p>
    </article>
  );
}

function CompletedWorkGroup({ category, agents }: { category: string; agents: RootSubagentSnapshot[] }) {
  return (
    <details className="agent-completed-group">
      <summary>
        <strong>{category}</strong>
        <span>{agents.length} 项</span>
      </summary>
      <ul>
        {agents.map((agent) => (
          <li key={agent.stableIdentity}>{activityKeyword(agent.lastActualAction, readableSubagentName(agent.label))}</li>
        ))}
      </ul>
    </details>
  );
}

export function AgentLaneBoard({
  projectId,
  projectName,
  onOpenCodexThread,
  onCoordinateTodo,
}: AgentLaneBoardProps) {
  const [snapshot, setSnapshot] = useState<AgentLaneSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getAgentLaneSnapshot(projectId, controller.signal);
        setSnapshot(next);
        setError(null);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(cause instanceof ApiError ? cause.message : "无法读取 Agent Lane 状态。");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [projectId]);

  if (error) {
    return <section className="agent-lanes-error" role="alert"><strong>Agent Lanes unavailable</strong><p>{error}</p></section>;
  }
  if (!snapshot) {
    return <div className="agent-lanes-loading" aria-label="正在读取 Agent Lane 状态" aria-busy="true" />;
  }

  const rootLane = snapshot.taskLanes.find((lane) => lane.id === snapshot.coordination.coordinatorTaskId);
  const peerLanes = snapshot.taskLanes.filter((lane) => lane.id !== snapshot.coordination.coordinatorTaskId);
  const activeSubagents = snapshot.rootSubagents.filter((agent) => agent.lifecycleStatus === "running");
  const completedGroups = groupCompletedSubagents(
    snapshot.rootSubagents.filter((agent) => agent.lifecycleStatus === "completed"),
  );
  const todoById = new Map(snapshot.todos.map((todo) => [todo.id, todo]));
  const orderedTodos = [
    ...snapshot.attentionQueue.flatMap((id) => todoById.get(id) ? [todoById.get(id)!] : []),
    ...snapshot.todos.filter((todo) => !snapshot.attentionQueue.includes(todo.id)),
  ];

  return (
    <section className="agent-lanes" aria-labelledby="agent-lanes-title">
      <header className="agent-lanes-heading">
        <div>
          <span className="agent-lanes-eyebrow">开发状态</span>
          <h2 id="agent-lanes-title">{projectName}</h2>
          <p>由 Root 分工，Sub-Agent 执行，结果自动回到待办。</p>
        </div>
        <div className="agent-lanes-policy" aria-label="安全状态">
          <span>自动同步</span>
        </div>
      </header>

      <section className="agent-lane-section" aria-labelledby="root-status-title">
        <div className="agent-lane-section-heading">
          <h3 id="root-status-title">当前工作</h3>
        </div>
        {rootLane && (
          <div className="agent-lane-grid" role="list">
            <TaskLaneCard lane={rootLane} root onOpenCodexThread={onOpenCodexThread} />
          </div>
        )}
      </section>

      <section className="agent-lane-section agent-subagent-section" aria-labelledby="root-subagents-title">
        <div className="agent-lane-section-heading">
          <h3 id="root-subagents-title">Sub-Agent</h3>
          <p>当前 {snapshot.subagentSummary.active} 个运行中</p>
        </div>
        {activeSubagents.length === 0
          ? <p className="agent-lane-empty">Root 现在没有启动 Sub-Agent。</p>
          : <div className="agent-subagent-grid" role="list">
              {activeSubagents.map((agent) => <SubagentCard key={agent.stableIdentity} agent={agent} />)}
            </div>}
        {completedGroups.length > 0 && (
          <>
            <p className="agent-lane-recent-label">最近完成</p>
            <div className="agent-completed-groups">
              {completedGroups.map((group) => (
                <CompletedWorkGroup key={group.category} category={group.category} agents={group.items} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="agent-lane-section" aria-labelledby="task-lanes-title">
        <div className="agent-lane-section-heading">
          <h3 id="task-lanes-title">其他任务</h3>
        </div>
        <div className="agent-lane-grid" role="list">
          {peerLanes.map((lane) => (
            <TaskLaneCard key={lane.id} lane={lane} onOpenCodexThread={onOpenCodexThread} />
          ))}
        </div>
      </section>

      <section className="agent-lane-section" aria-labelledby="agent-todos-title">
        <div className="agent-lane-section-heading">
          <h3 id="agent-todos-title">待办</h3>
        </div>
        {orderedTodos.length > 0 ? (
          <div className="agent-todo-grid" role="list">
            {orderedTodos.map((todo) => (
              <TodoCard
                key={todo.id}
                todo={todo}
                onCoordinateTodo={onCoordinateTodo}
              />
            ))}
          </div>
        ) : <p className="agent-lane-empty">暂无待办。</p>}
      </section>

      <p className="agent-adapter-summary">
        {snapshot.adapters.length > 0
          ? snapshot.adapters.map((adapter) => `${adapter.label} ${STATUS_LABELS[adapter.status]}`).join(" · ")
          : "未配置外部适配器"}
        {" · 自动恢复关闭"}
      </p>
    </section>
  );
}
