import { useEffect, useState } from "react";

import { ApiError, getAgentLaneSnapshot } from "../api";
import type {
  AgentLaneSnapshot,
  AgentTaskLaneSnapshot,
  CoordinationTodoSnapshot,
  RootSubagentSnapshot,
} from "../types";

interface AgentLaneBoardProps {
  projectId: string;
  projectName: string;
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

function TaskLaneCard({ lane, root = false }: { lane: AgentTaskLaneSnapshot; root?: boolean }) {
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
    </article>
  );
}

function TodoCard({ todo }: { todo: CoordinationTodoSnapshot }) {
  return (
    <article className={`agent-todo-card is-${todo.state}`} role="listitem">
      <div className="agent-lane-card-heading">
        <h4>{todo.title}</h4>
        <span className="agent-lane-status">{TODO_STATUS_LABELS[todo.state]}</span>
      </div>
      <p className="agent-lane-current-work"><span>现在</span>{todo.nextAction ?? "等待任务"}</p>
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

export function AgentLaneBoard({ projectId, projectName }: AgentLaneBoardProps) {
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

  return (
    <section className="agent-lanes" aria-labelledby="agent-lanes-title">
      <header className="agent-lanes-heading">
        <div>
          <span className="agent-lanes-eyebrow">开发状态</span>
          <h2 id="agent-lanes-title">{projectName}</h2>
          <p>谁在工作、正在做什么、Sub-Agent 是否运行。</p>
        </div>
        <div className="agent-lanes-policy" aria-label="安全状态">
          <span>自动同步</span>
        </div>
      </header>

      <section className="agent-lane-section" aria-labelledby="root-status-title">
        <div className="agent-lane-section-heading">
          <h3 id="root-status-title">当前工作</h3>
        </div>
        {rootLane && <div className="agent-lane-grid" role="list"><TaskLaneCard lane={rootLane} root /></div>}
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
          {peerLanes.map((lane) => <TaskLaneCard key={lane.id} lane={lane} />)}
        </div>
      </section>

      <section className="agent-lane-section" aria-labelledby="agent-todos-title">
        <div className="agent-lane-section-heading">
          <h3 id="agent-todos-title">待办</h3>
        </div>
        {snapshot.todos.length > 0 ? (
          <div className="agent-todo-grid" role="list">
            {snapshot.todos.map((todo) => <TodoCard key={todo.id} todo={todo} />)}
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
