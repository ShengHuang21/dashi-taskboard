import { describe, expect, it } from "vitest";
import { taskDependencyGraph } from "./taskDependencyGraph";
import type { Task } from "./types";

function task(id: string, parent: Task | null = null, blockedBy: Task[] = [], labels: string[] = []): Task {
  return { id, identifier: id, projectId: "project", labels, relations: { parent, subIssues: [], blockedBy, blocks: [], related: [] } } as unknown as Task;
}
describe("visible task dependency projection", () => {
  it("uses real dependencies, never plan numbering or containment, for depth", () => {
    const a = task("A", null, [], ["plan-group:1"]), b = task("B", null, [], ["plan-group:2"]);
    const independent = taskDependencyGraph([a, b], [a, b]);
    expect(independent.edges).toHaveLength(0);
    expect(independent.layers).toHaveLength(1);
    b.relations.blockedBy = [a];
    const graph = taskDependencyGraph([b, a], [a, b]);
    expect(graph.layers.map(([, nodes]) => nodes.map((node) => node.id))).toEqual([["A"], ["B"]]);
    expect(graph.edges[0].partial).toBe(false);
  });
  it("projects exact leaf dependencies without making an entire stage a gate", () => {
    const a = task("stage02"), b = task("stage03");
    const producer = task("leaf15", a), consumer = task("leaf22", b, [producer]);
    const graph = taskDependencyGraph([a, b], [a, b, producer, consumer]);
    expect(graph.edges).toEqual([{ from: "stage02", to: "stage03", partial: true, evidence: [{ from: "leaf15", to: "leaf22" }] }]);
    expect(graph.layers.map(([, nodes]) => nodes.map((node) => node.id))).toEqual([["stage02", "stage03"]]);
  });
  it("retains crossed partial dependencies and every visible node without fake stage ordering", () => {
    const a = task("A"), b = task("B"), x = task("x", a), y = task("y", b, [x]), z = task("z", a, [y]);
    const graph = taskDependencyGraph([a, b], [a, b, x, y, z]);
    expect(graph.crossed).toBe(true);
    expect(graph.edges).toHaveLength(2);
    expect(graph.layers).toHaveLength(1);
    expect(graph.layers[0][1]).toHaveLength(2);
  });
  it("does not omit prerequisites outside the displayed siblings", () => {
    const outside = task("external"), a = task("A", null, [outside]);
    expect(taskDependencyGraph([a], [a, outside]).external).toEqual([{ task: "A", prerequisite: "external" }]);
  });
});
