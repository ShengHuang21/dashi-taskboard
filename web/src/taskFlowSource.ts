import type { Task } from "./types";

// Labels are data, never Mermaid syntax. Use Mermaid's numeric entity escaping.
const label = (value: string) => [...value].map((char) => /[\p{L}\p{N} 、，。·：:／/ _｜（）→-]/u.test(char) ? char : `#${char.codePointAt(0)};`).join("");

export function taskFlowSource(root: Task, tasks: Task[]) {
  const project = tasks.filter((task) => task.projectId === root.projectId);
  const byId = new Map(project.map((task) => [task.id, task]));
  const children = (id: string) => project.filter((task) => task.relations.parent?.id === id || byId.get(id)?.relations.subIssues.some((child) => child.id === task.id));
  const groups = children(root.id);
  const scope = new Set<string>();
  const membership = new Map<string, string>();
  for (const group of groups) {
    const pending = [group.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (scope.has(id)) continue;
      scope.add(id);
      membership.set(id, group.id);
      pending.push(...children(id).map((task) => task.id));
    }
  }
  const pairs = project.flatMap((target) => target.relations.blockedBy
    .filter((source) => byId.has(source.id) && (scope.has(source.id) || scope.has(target.id)))
    .map((source) => ({ from: source.id, to: target.id })));
  const shown = new Set([...scope].filter((id) => children(id).length === 0));
  for (const pair of pairs) { shown.add(pair.from); shown.add(pair.to); }
  const nodes = [...shown].map((id) => byId.get(id)!).filter(Boolean);
  const ids = new Map(nodes.map((task, index) => [task.id, `n${index}`]));
  const status: Record<string, string> = { done: "完成", in_review: "已交付 · 审查中", in_progress: "处理中", blocked: "阻塞", canceled: "取消", todo: "待开始", backlog: "待安排" };
  const nodeLine = (task: Task) => `${ids.get(task.id)}["${label(task.externalKey ?? task.identifier)} · ${label(task.title)}<br/>${label(status[task.status] ?? task.status)}"]`;
  const lines = ["flowchart TB"];
  for (const [index, group] of groups.entries()) {
    const members = nodes.filter((task) => membership.get(task.id) === group.id);
    if (!members.length) continue;
    if (members.length > 1) lines.push(`subgraph g${index}["${label(group.title)}"]`, "direction TB");
    lines.push(...members.map(nodeLine));
    if (members.length > 1) lines.push("end");
  }
  const external = nodes.filter((task) => !scope.has(task.id));
  lines.push(...external.map(nodeLine));
  for (const pair of pairs) lines.push(`${ids.get(pair.from)} --> ${ids.get(pair.to)}`);
  lines.push("classDef boundary fill:#f1f5f9,stroke:#64748b,stroke-dasharray:5 3");
  if (external.length) lines.push(`class ${external.map((task) => ids.get(task.id)).join(",")} boundary`);
  return { source: lines.join("\n"), nodes, nodeIds: ids };
}

export function approvedTaskFlow(description: string): string | null {
  // Only the current description's explicitly confirmed flow; never historical comments.
  for (const section of description.matchAll(/^#{1,3}\s+([^\n]+)\n([\s\S]*?)(?=\n#{1,3}\s|(?![\s\S]))/gm)) {
    if (!/确认/.test(section[1]) || !/流程图|步骤方块图|协作流程/.test(section[1])) continue;
    const source = section[2].match(/```mermaid\s*\n([\s\S]*?)```/)?.[1]?.trim();
    if (source) return source;
  }
  return null;
}
