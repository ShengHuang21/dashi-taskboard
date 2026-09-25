import { useState } from "react";
import type { Task, TaskRelationSummary } from "../types";
import { approvedTaskFlow, taskFlowSource } from "../taskFlowSource";
import { MermaidDiagram } from "./MarkdownDocument";

export function TaskFlowCanvas({ task, tasks, onOpenTask }: { task: Task; tasks: Task[]; onOpenTask: (task: TaskRelationSummary) => void }) {
  const [large, setLarge] = useState(false);
  const generated = taskFlowSource(task, tasks);
  const approved = approvedTaskFlow(task.description);
  const source = approved ?? generated.source;
  const linkedTasks = approved ? tasks.filter((item) => item.projectId === task.projectId && approved.split(/[^A-Za-z0-9-]+/).includes(item.externalKey ?? item.identifier)) : generated.nodes;
  return <section className={`task-flow-canvas${large ? " is-expanded" : ""}`} aria-label="任务流程画布" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setLarge(false); } }}>
    <header><strong>{approved ? "已确认的协作流程" : "真实任务依赖流程"}</strong><button type="button" className="button secondary" onClick={() => setLarge(!large)}>{large ? "收起画布" : "放大画布"}</button></header>
    <p>{approved ? "执行步骤与协作安排；检查点不计入功能完成度，不代表历史上每一步都已执行。" : "箭头来自实际前置任务；边框只是所属分组，不是整个阶段的完成门。虚线边框是本层外的关联任务。"}</p>
    <div className="task-flow-scroll" onClick={(event) => {
      const node = (event.target as Element).closest("g.node");
      if (!node) return;
      const content = node.textContent ?? "";
      const candidates = tasks.filter((item) => item.projectId === task.projectId && content.split(/[^A-Za-z0-9-]+/).includes(item.externalKey ?? item.identifier));
      if (candidates.length === 1) onOpenTask(candidates[0]);
    }}><MermaidDiagram source={source} /></div>
    <details><summary>打开图中任务详情</summary><div className="task-flow-links">{linkedTasks.map((node) => <button className="button secondary" type="button" key={node.id} onClick={() => onOpenTask(node)}>{node.externalKey ?? node.identifier} · {node.title}</button>)}</div></details>
  </section>;
}
