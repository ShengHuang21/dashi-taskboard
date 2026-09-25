import type { Task, TaskRelationSummary } from "./types";

export interface DependencyEdge {
  from: string;
  to: string;
  partial: boolean;
  evidence: { from: string; to: string }[];
}

// Containment locates an endpoint; only blockedBy creates an execution edge.
export function taskDependencyGraph(children: TaskRelationSummary[], tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const descendants = new Map<string, Set<string>>();
  for (const child of children) {
    const found = new Set<string>();
    const pending = [child.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (found.has(id)) continue;
      found.add(id);
      pending.push(...(byId.get(id)?.relations.subIssues.map((item) => item.id) ?? []));
      pending.push(...tasks.filter((item) => item.relations.parent?.id === id).map((item) => item.id));
    }
    descendants.set(child.id, found);
  }
  const owner = (id: string) => {
    const matches = children.filter((child) => descendants.get(child.id)?.has(id));
    return matches.length === 1 ? matches[0].id : null;
  };
  const edges = new Map<string, DependencyEdge>();
  const external: { task: string; prerequisite: string }[] = [];
  for (const target of tasks) {
    const to = owner(target.id);
    if (!to) continue;
    for (const dependency of target.relations.blockedBy) {
      const from = owner(dependency.id);
      if (!from) {
        external.push({ task: target.externalKey ?? target.identifier, prerequisite: dependency.externalKey ?? dependency.identifier });
        continue;
      }
      if (from === to) continue;
      const key = `${from}\0${to}`;
      const edge = edges.get(key) ?? { from, to, partial: true, evidence: [] };
      edge.partial &&= from !== dependency.id || to !== target.id;
      const pair = { from: dependency.externalKey ?? dependency.identifier, to: target.externalKey ?? target.identifier };
      if (!edge.evidence.some((item) => item.from === pair.from && item.to === pair.to)) edge.evidence.push(pair);
      edges.set(key, edge);
    }
  }
  // Only whole-card prerequisites determine vertical ordering. Leaf projections
  // remain visible evidence, but must not serialize their containing stages.
  const orderingEdges = [...edges.values()].filter((edge) => !edge.partial);
  // Aggregate edges may cycle even when leaf dependencies do not. Keep each
  // mutually reachable group on one level rather than inventing a stage gate.
  const reachable = (id: string) => {
    const result = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (result.has(next)) continue;
      result.add(next);
      pending.push(...orderingEdges.filter((edge) => edge.from === next).map((edge) => edge.to));
    }
    return result;
  };
  const reach = new Map(children.map((child) => [child.id, reachable(child.id)]));
  const groups: string[][] = [];
  for (const child of children) {
    if (groups.some((group) => group.includes(child.id))) continue;
    groups.push(children.filter((other) => reach.get(child.id)!.has(other.id) && reach.get(other.id)!.has(child.id)).map((other) => other.id));
  }
  const groupOf = (id: string) => groups.findIndex((group) => group.includes(id));
  const depth = groups.map(() => 0);
  for (let pass = 0; pass < groups.length; pass++) {
    for (const edge of orderingEdges) {
      const from = groupOf(edge.from), to = groupOf(edge.to);
      if (from !== to) depth[to] = Math.max(depth[to], depth[from] + 1);
    }
  }
  const order = (item: TaskRelationSummary) => Number(byId.get(item.id)?.labels.find((label) => /^plan-group:\d+$/.test(label))?.split(":")[1] ?? 0);
  const layers = new Map<number, TaskRelationSummary[]>();
  for (const child of [...children].sort((a, b) => order(a) - order(b) || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
    const level = depth[groupOf(child.id)];
    layers.set(level, [...(layers.get(level) ?? []), child]);
  }
  return { layers: [...layers].sort(([a], [b]) => a - b), edges: [...edges.values()], external, crossed: [...edges.values()].some((edge) => edges.has(`${edge.to}\0${edge.from}`)) || groups.some((group) => group.length > 1) };
}
