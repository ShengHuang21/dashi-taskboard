import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardSource = await readFile(new URL("../web/src/components/AgentLaneBoard.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");

test("capstone-dev opens a dedicated Agent Lanes view", () => {
  assert.match(appSource, /type BoardView = [^;]*"lanes"/);
  assert.match(appSource, /selectedProjectId === "capstone-dev"/);
  assert.match(appSource, /routeProjectId === "capstone-dev"[\s\S]*?"lanes"/);
  assert.match(appSource, />\s*Agent Lanes\s*<\/button>/);
  assert.match(appSource, /boardView === "lanes"[\s\S]*?<AgentLaneBoard/);
  assert.match(apiSource, /getAgentLaneSnapshot[\s\S]*?\/api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
});

test("the lane board keeps the owner view concise while synchronization stays automatic", () => {
  for (const label of ["当前工作", "Sub-Agent", "最近完成", "其他任务", "待办", "自动同步"]) {
    assert.match(boardSource, new RegExp(label));
  }
  assert.doesNotMatch(boardSource, /Working Log|latestWorkingLog|Owner|Branch|SHA|Continuity|最后一次实际动作/);
  assert.match(boardSource, /snapshot\.taskLanes/);
  assert.match(boardSource, /snapshot\.rootSubagents/);
  assert.match(boardSource, /Root 现在没有启动 Sub-Agent/);
  assert.doesNotMatch(boardSource, /onRecover|sendMessage|startThread|restartAgent/i);
});

test("completed sub-agent work is grouped once by human-readable category", () => {
  for (const category of ["代码审查", "测试验证", "界面优化", "视觉材料", "客服功能", "其他工作"]) {
    assert.match(boardSource, new RegExp(category));
  }
  assert.match(boardSource, /groupCompletedSubagents/);
  assert.match(boardSource, /lifecycleStatus === "running"/);
  assert.match(boardSource, /lifecycleStatus === "completed"/);
  assert.match(boardSource, /<details className="agent-completed-group">/);
  assert.match(boardSource, /<span>\{agents\.length\} 项<\/span>/);
  assert.doesNotMatch(boardSource, /visibleSubagents/);
});
