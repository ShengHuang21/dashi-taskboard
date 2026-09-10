import type { Task } from "./types";

export interface DeliveryProgress {
  completed: number;
  total: number;
  percent: number | null;
  reason: "unplanned" | "incomplete" | "canceled" | null;
}

export function createTaskProgressModel(referenceTasks: Task[]) {
  const taskById = new Map(referenceTasks.map((task) => [task.id, task]));
  const tasks = [...taskById.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.identifier.localeCompare(right.identifier)
  ));
  const childIds = new Map(tasks.map((task) => [
    task.id,
    new Set(task.relations.subIssues.map((child) => child.id)),
  ]));
  const relationById = new Map(tasks.flatMap((task) => (
    task.relations.subIssues.map((child) => [child.id, child] as const)
  )));
  for (const task of tasks) {
    const parentId = task.relations.parent?.id;
    if (parentId) childIds.get(parentId)?.add(task.id);
  }

  function progressFor(ids: string[]): DeliveryProgress {
    const visited = new Set<string>();
    const leaves = new Map<string, Task>();
    let incomplete = false;
    function visit(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      const task = taskById.get(id);
      if (!task) {
        if (relationById.get(id)?.status !== "canceled") incomplete = true;
        return;
      }
      const children = childIds.get(id)!;
      if (children.size > 0) {
        children.forEach(visit);
      } else if (task.status !== "canceled") {
        leaves.set(id, task);
      }
    }
    ids.forEach(visit);
    const total = leaves.size;
    const completed = [...leaves.values()].filter((task) => task.status === "done").length;
    return {
      completed,
      total,
      percent: incomplete || total === 0 ? null
        : completed === total ? 100 : Math.min(99, Math.round((completed / total) * 100)),
      reason: incomplete ? "incomplete" : total === 0 ? "unplanned" : null,
    };
  }

  function forTask(id: string): DeliveryProgress {
    const task = taskById.get(id);
    if (!task) return { completed: 0, total: 0, percent: null, reason: "incomplete" };
    if (task.status === "canceled") {
      return { completed: 0, total: 0, percent: null, reason: "canceled" };
    }
    if (childIds.get(id)!.size === 0 && task.status !== "done") {
      return { completed: 0, total: 0, percent: null, reason: "unplanned" };
    }
    return progressFor([id]);
  }

  const roadmap: { task: Task; depth: number }[] = [];
  const listed = new Set<string>();
  function list(task: Task, depth: number) {
    if (listed.has(task.id)) return;
    listed.add(task.id);
    roadmap.push({ task, depth });
    tasks.filter((child) => childIds.get(task.id)!.has(child.id))
      .forEach((child) => list(child, depth + 1));
  }
  tasks.filter((task) => !task.relations.parent || !taskById.has(task.relations.parent.id))
    .forEach((task) => list(task, 0));
  tasks.forEach((task) => list(task, 0));

  return { project: progressFor(tasks.map((task) => task.id)), forTask, roadmap };
}
