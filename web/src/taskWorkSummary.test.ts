import { describe, expect, it } from "vitest";
import type { TaskChangeActivity } from "./types";
import { compactWorkExcerpt, projectTaskWork, taskDescriptionHistory } from "./taskWorkSummary";

const task = (description: string, version = 1) => ({ id: "task", description, version, updatedAt: "2026-09-26T00:00:00Z" });
const stage = `## 当前执行状态：示例组件审查通过，待固定候选提交及QA
示例协调者负责核对；示例集成者负责交付。
- 下一顺序：示例作者固定候选commit→示例QA验证→示例集成者集成。
下方为历史架构与授权背景；当前执行状态以上述段落为准。
## 最新执行调整
旧版准备
## 当前 Demo 主线
旧主线`;

describe("task-local work projection", () => {
  it("keeps the current next step separate from its explicit historical boundary", () => {
    const view = projectTaskWork(task(stage, 21));
    expect(compactWorkExcerpt(view.current)).toContain("待固定候选提交及QA");
    expect(view.next?.text).toContain("示例作者固定候选commit");
    expect(view.historyLine).toBe(4);
    expect(view.sections.some((section) => section.text.includes("旧版准备"))).toBe(false);
  });

  it("projects Input/Output and self-reported evidence without inventing acceptance", () => {
    const view = projectTaskWork(task(`# 当前固定候选：示例组件，待示例协调者安排QA
## Input / Output
Input：fixture-input；示例共享契约
Output：示例产出 **fixture-output**
## 固定证据
测试与manifest列表
## QA领取与交回
示例QA验证产出后交回示例集成者，当前无新QA结论。
历史范围和原验收保留，最新阶段以上方为准：
## Output
旧版产出`, 19));
    expect(view.input?.text).toContain("fixture-input");
    expect(view.output?.text).toContain("fixture-output");
    expect(view.output?.text).not.toContain("旧版产出");
    expect(view.evidence?.text).toBe("测试与manifest列表");
    expect(view.next).toBeUndefined();
    expect(view.handoff?.text).toContain("当前无新QA结论");
  });

  it("retains an explicit waiting reason and responsible follow-up without assigning anyone", () => {
    const view = projectTaskWork(task(`# 示例后台任务
## 当前范围与状态
本范围是示例后台组件，目前保留原绑定及工作区。

当前 blocked：给示例前台组件的验证和交接让出执行槽。属于资源与验收顺序等待，不是产品审批，也不是取消或完成。示例协调者确认验证结果和空闲资源后，复用已有执行者继续，不另建重复作者。
## 后续验证与交接
实现完成后冻结候选，再按既有安排验证并交回示例协调者。
## 历史连续性
旧任务安排`, 8));
    expect(view.current?.text).toContain("资源与验收顺序等待");
    expect(view.current?.text).toContain("示例协调者确认");
    expect(compactWorkExcerpt(view.current)).toContain("当前 blocked");
    expect(compactWorkExcerpt(view.current)).not.toContain("本范围是");
    expect(view.next).toBeUndefined();
    expect(view.handoff?.text).toContain("实现完成后冻结候选");
    expect(compactWorkExcerpt(view.current)!.length).toBeLessThanOrEqual(111);
  });

  it("shows a description update as current while keeping before/after in history; comments cannot replace it", () => {
    const before = "## 当前状态\n旧计划\n- 下一步：先实现";
    const after = "## 当前状态\n新计划\n- 下一步：交现有QA";
    const activity = { id: "change-1", taskId: "task", actorName: "记录修改者", createdAt: "2026-09-26T01:00:00Z",
      changes: [{ field: "description", before, after }] } as TaskChangeActivity;
    const snapshot = { ...task(after, 2), comments: [{ body: "sub-agent：改为全局新计划", updatedAt: "2026-09-27T00:00:00Z" }] };
    const current = projectTaskWork(snapshot);
    const history = taskDescriptionHistory(snapshot.id, [activity]);
    expect(current.current?.text).toContain("新计划");
    expect(current.current?.text).not.toContain("全局新计划");
    expect(current.source.version).toBe(2);
    expect(history[0]).toMatchObject({ activityId: "change-1", actorName: "记录修改者", before, after });
    expect(history[0].headings).toContain("当前状态");
    expect(taskDescriptionHistory("another-task", [activity])).toEqual([]);
  });

  it("leaves missing fields unknown and ignores field-like lines inside code fences", () => {
    const view = projectTaskWork(task("普通描述\n```text\n下一步：不要当作实际安排\n```"));
    expect(view.next).toBeUndefined();
    expect(view.current).toBeUndefined();
    expect(view.evidence).toBeUndefined();
  });
});
