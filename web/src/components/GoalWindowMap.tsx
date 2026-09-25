import { useEffect, useMemo, useRef, useState } from "react";

import { useTaskboardI18n } from "../i18n";
import type { CodexThreadBinding, Comment, Task, TaskRelationSummary } from "../types";
import "./OwnerGoalsView.css";

export interface GoalWindowMapNode {
  id: string;
  roleLabel: string;
  title: string;
  kind: "main" | "reviewer";
  threadBinding: CodexThreadBinding | null;
  scope: string;
  recordedState: string;
  latestOutput: string;
  nextAction: string;
  model?: { model: string; reasoningEffort: string };
  issueRefs?: { taskId: string; identifier: string; role: "stage" | "owned" | "current" }[];
}

export interface GoalWindowMapDeclaration {
  sourceRef: string;
  observedAt: string;
  sourceCommentId: string;
  sourceCommentVersion: number;
  nodes: GoalWindowMapNode[];
  edges: { from: string; to: string; kind: "coordination" | "review" }[];
}

function isBinding(value: unknown): value is CodexThreadBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  const hasText = (field: unknown) => typeof field === "string" && field.trim().length > 0;
  return hasText(binding.threadId) && hasText(binding.codexProjectId)
    && (binding.codexProjectKind === "local" || binding.codexProjectKind === "remote")
    && hasText(binding.codexHostId) && hasText(binding.workspacePath);
}

function hasDirectedCycle(ids: ReadonlySet<string>, edges: GoalWindowMapDeclaration["edges"]) {
  const inbound = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const ready = [...ids].filter((id) => inbound.get(id) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (inbound.get(target) ?? 0) - 1;
      inbound.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  return visited !== ids.size;
}

function parseDeclaration(body: string): GoalWindowMapDeclaration | null {
  const match = body.match(/```taskboard-window-map\s+v1\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (typeof value.sourceRef !== "string" || typeof value.observedAt !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
    const ids = new Set<string>();
    const nodes: GoalWindowMapNode[] = [];
    for (const candidate of value.nodes) {
      if (!candidate || typeof candidate !== "object") return null;
      const node = candidate as Record<string, unknown>;
      if (typeof node.id !== "string" || ids.has(node.id) || typeof node.roleLabel !== "string" || typeof node.title !== "string"
        || (node.kind !== "main" && node.kind !== "reviewer") || (node.threadBinding !== null && !isBinding(node.threadBinding))
        || typeof node.scope !== "string" || typeof node.recordedState !== "string" || typeof node.latestOutput !== "string" || typeof node.nextAction !== "string") return null;
      if (node.model !== undefined && (!node.model || typeof node.model !== "object" || typeof (node.model as { model?: unknown }).model !== "string" || typeof (node.model as { reasoningEffort?: unknown }).reasoningEffort !== "string")) return null;
      ids.add(node.id);
      const issueRefs = node.issueRefs;
      if (issueRefs !== undefined && (!Array.isArray(issueRefs) || issueRefs.some((reference) => !reference || typeof reference !== "object" || typeof (reference as { taskId?: unknown }).taskId !== "string" || !(reference as { taskId: string }).taskId.trim() || typeof (reference as { identifier?: unknown }).identifier !== "string" || !(reference as { identifier: string }).identifier.trim() || !["stage", "owned", "current"].includes((reference as { role?: string }).role ?? "")))) return null;
      nodes.push({ id: node.id, roleLabel: node.roleLabel, title: node.title, kind: node.kind, threadBinding: node.threadBinding as CodexThreadBinding | null, scope: node.scope, recordedState: node.recordedState, latestOutput: node.latestOutput, nextAction: node.nextAction, ...(node.model ? { model: node.model as GoalWindowMapNode["model"] } : {}), ...(issueRefs ? { issueRefs: issueRefs as GoalWindowMapNode["issueRefs"] } : {}) });
    }
    const edges: GoalWindowMapDeclaration["edges"] = [];
    for (const candidate of value.edges) {
      if (!candidate || typeof candidate !== "object") return null;
      const edge = candidate as Record<string, unknown>;
      if (typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || (edge.kind !== "coordination" && edge.kind !== "review")) return null;
      edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
    }
    if (hasDirectedCycle(ids, edges)) return null;
    return { sourceRef: value.sourceRef, observedAt: value.observedAt, sourceCommentId: "", sourceCommentVersion: 0, nodes, edges };
  } catch { return null; }
}

export function latestGoalWindowMap(comments: Comment[]): GoalWindowMapDeclaration | null {
  for (const comment of [...comments].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))) {
    if (/```taskboard-window-map\s+v1\s*\n/i.test(comment.body)) {
      const declaration = parseDeclaration(comment.body);
      return declaration ? { ...declaration, sourceCommentId: comment.id, sourceCommentVersion: comment.version } : null;
    }
  }
  return null;
}

function nodeLevels(nodes: GoalWindowMapNode[], edges: GoalWindowMapDeclaration["edges"]) {
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const next = Math.max(levels.get(edge.to) ?? 0, (levels.get(edge.from) ?? 0) + 1);
      if (next !== levels.get(edge.to)) { levels.set(edge.to, next); changed = true; }
    }
    if (!changed) break;
  }
  const rows = new Map<number, GoalWindowMapNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    rows.set(level, [...(rows.get(level) ?? []), node]);
  }
  return [...rows.entries()].sort(([left], [right]) => left - right).map(([, nodes]) => nodes);
}

function matchingTasks(node: GoalWindowMapNode, tasks: Task[]) {
  return (node.issueRefs ?? []).map((reference) => ({ reference, task: tasks.find((task) => task.id === reference.taskId && (task.externalKey ?? task.identifier) === reference.identifier) ?? null }));
}

export function GoalWindowAssignments({ declarations, task, tasks }: { declarations: GoalWindowMapDeclaration[]; task: Task; tasks: Task[] }) {
  const { text } = useTaskboardI18n();
  const owners = declarations.flatMap((declaration) => declaration.nodes.filter((node) => matchingTasks(node, tasks).some(({ reference, task: candidate }) => reference.role !== "stage" && candidate?.id === task.id)).map((node) => ({ node, declaration })));
  if (owners.length === 0) return null;
  return <section className="goal-window-assignment"><h2>{text("负责窗口与子 Agent", "Responsible window and sub-agents")}</h2>{owners.map(({ node, declaration }) => <div key={`${declaration.sourceCommentId}:${node.id}`}><p>{node.roleLabel} · {node.title}{node.model ? ` · ${node.model.model} / ${node.model.reasoningEffort}` : ""}</p>{declaration.edges.filter((edge) => edge.kind === "review" && edge.from === node.id).map((edge) => {
    const reviewer = declaration.nodes.find((item) => item.id === edge.to);
    return reviewer ? <p key={edge.to}>{text("独立审查", "Independent review")} · {reviewer.title}{reviewer.model ? ` · ${reviewer.model.model} / ${reviewer.model.reasoningEffort}` : ""} · {reviewer.recordedState}</p> : null;
  })}</div>)}{task.labels.filter((label) => label.startsWith("测试:")).map((label) => <p key={label}>{text("独立测试（已登记）", "Independent testing (registered)")} · {label.slice(3)} · {task.labels.find((item) => item.startsWith("测试模型:"))?.slice(5) ?? text("模型未登记", "Model not recorded")}{task.labels.includes("协作:测试审查并行") ? text(" · 测试与代码审查并行，最终审查等待测试报告", " · Testing and code review run in parallel; final review awaits test results") : ""}</p>)}</section>;
}

export function GoalWindowMap({ comments, onOpenThread, tasks, onOpenTask, onDeclaration, presentation = "full" }: { comments: Comment[]; onOpenThread: (binding: CodexThreadBinding) => void; tasks: Task[]; onOpenTask: (task: TaskRelationSummary) => void; onDeclaration?: (declaration: GoalWindowMapDeclaration | null) => void; presentation?: "full" | "none" }) {
  const { text } = useTaskboardI18n();
  const [outcomesFirst, setOutcomesFirst] = useState(false);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const reportedDeclaration = useRef<string | null>(null);
  const declaration = useMemo(() => latestGoalWindowMap(comments), [comments]);
  useEffect(() => {
    const key = declaration ? `${declaration.sourceCommentId}:${declaration.sourceCommentVersion}` : "invalid";
    if (reportedDeclaration.current === key) return;
    reportedDeclaration.current = key;
    onDeclaration?.(declaration);
  }, [declaration, onDeclaration]);
  const hasRegisteredMap = comments.some((comment) => /```taskboard-window-map\s+v1\s*\n/i.test(comment.body));
  if (!declaration) return hasRegisteredMap ? <section className="goal-window-map" role="alert">
    {text("最新窗口协作声明无效，未显示旧图。", "The latest window-map declaration is invalid; no older map is shown.")}
  </section> : null;
  if (presentation === "none") return null;
  const nodeById = new Map(declaration.nodes.map((node) => [node.id, node]));
  const reviewersByOwner = new Map<string, GoalWindowMapNode[]>();
  for (const edge of declaration.edges) {
    const owner = nodeById.get(edge.from);
    const reviewer = nodeById.get(edge.to);
    if (edge.kind === "review" && owner?.kind === "main" && reviewer?.kind === "reviewer") {
      reviewersByOwner.set(owner.id, [...(reviewersByOwner.get(owner.id) ?? []), reviewer]);
    }
  }
  const displayedNodes = declaration.nodes.filter((node) => node.kind === "main");
  const displayedNodeIds = new Set(displayedNodes.map((node) => node.id));
  const rows = nodeLevels(displayedNodes, declaration.edges.filter((edge) => (
    edge.kind === "coordination" && displayedNodeIds.has(edge.from) && displayedNodeIds.has(edge.to)
  )));
  const displayedRows = outcomesFirst ? [...rows].reverse() : rows;
  const mainWindowCount = declaration.nodes.filter((node) => node.kind === "main" && node.threadBinding).length;
  const direction = outcomesFirst ? text("提交产物与审查结果", "Submit artifacts and review results") : text("安排工作 / 协调", "Assign work / coordinate");
  const issueRoleLabel = (role: NonNullable<GoalWindowMapNode["issueRefs"]>[number]["role"]) => ({
    stage: text("所属阶段", "Stage"),
    owned: text("负责任务", "Owned task"),
    current: text("当前任务", "Current task"),
  })[role];
  function detailsFor(node: GoalWindowMapNode) {
    return <div className="goal-window-map-node-details"><p>{text("职责", "Scope")} · {node.scope}</p><p>{text("记录状态", "Recorded state")} · {node.recordedState}</p><p>{text("最新产物", "Latest output")} · {node.latestOutput}</p><p>{text("下一步", "Next action")} · {node.nextAction}</p>{node.model ? <p>{text("模型证据", "Model evidence")} · {node.model.model} / {node.model.reasoningEffort}</p> : null}{matchingTasks(node, tasks).map(({ reference, task: candidate }) => candidate ? <button className="button secondary" type="button" key={`${node.id}:${reference.taskId}`} onClick={() => onOpenTask(candidate)}>{issueRoleLabel(reference.role)} · {reference.identifier}</button> : <p key={`${node.id}:${reference.taskId}`}>{issueRoleLabel(reference.role)} · {reference.identifier} · {text("未在当前视图加载", "Not loaded in current view")}</p>)}{node.threadBinding ? <button className="button secondary" type="button" onClick={() => onOpenThread(node.threadBinding!)}>{text("打开窗口", "Open window")}</button> : <p>{text("窗口绑定未登记", "Window binding not recorded")}</p>}</div>;
  }
  return <section className="goal-window-map" aria-labelledby="goal-window-map-heading">
    <header><div><h2 id="goal-window-map-heading">{text("窗口协作图", "Window collaboration map")}</h2><p>{text(`已登记主窗口 ${mainWindowCount}`, `${mainWindowCount} registered main windows`)}</p><p>{text(`登记快照 · ${declaration.observedAt} · 非实时状态`, `Registered snapshot · ${declaration.observedAt} · not live status`)}</p></div><button className="button secondary" type="button" onClick={() => setOutcomesFirst((value) => !value)}>{outcomesFirst ? text("查看协调方向", "Show coordination") : text("查看成果方向", "Show outcomes")}</button></header>
    <div className={`goal-window-map-flow${outcomesFirst ? " is-reversed" : ""}`} aria-label={direction}>
      {displayedRows.map((row, index) => <div className="goal-window-map-row-wrap" key={row.map((node) => node.id).join("/")}>
        {index > 0 ? <div className="goal-window-map-connector" aria-hidden="true"><span>{outcomesFirst ? "↑" : "↓"}</span>{direction}</div> : null}
        <div className="goal-window-map-row">{row.map((node) => {
          const opened = openNodeId === node.id;
          const reviewers = reviewersByOwner.get(node.id) ?? [];
          return <article className="goal-window-map-node" key={node.id}><button type="button" className="goal-window-map-node-toggle" aria-expanded={opened} onClick={() => setOpenNodeId((current) => current === node.id ? null : node.id)}><strong>{node.roleLabel}</strong><span>{node.title}</span><small>{text("主窗口", "Main window")}</small></button>{opened ? detailsFor(node) : null}{reviewers.length > 0 ? <div className="goal-window-map-reviewers"><strong>{text("独立审查 sub-agent", "Independent review sub-agent")}</strong>{reviewers.map((reviewer) => { const reviewerOpened = openNodeId === reviewer.id; return <div key={reviewer.id}><button type="button" className="goal-window-map-reviewer-toggle" aria-expanded={reviewerOpened} onClick={() => setOpenNodeId((current) => current === reviewer.id ? null : reviewer.id)}>{reviewer.roleLabel} · {reviewer.title}</button>{reviewerOpened ? detailsFor(reviewer) : null}</div>; })}</div> : null}</article>;
        })}</div>
      </div>)}
    </div>
    <details className="goal-window-map-source"><summary>{text("登记来源", "Registered source")}</summary><p>{declaration.observedAt}</p><p>{declaration.sourceRef}</p></details>
  </section>;
}
