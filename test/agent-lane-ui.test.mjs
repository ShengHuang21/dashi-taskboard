import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardSource = await readFile(new URL("../web/src/components/AgentLaneBoard.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");

test("every configured project opens its own Agent Lanes view", () => {
  assert.match(appSource, /type BoardView = [^;]*"lanes"/);
  assert.match(appSource, /selectedProject\?\.agentLanesConfigured/);
  assert.match(appSource, /listAgentLaneProjectIds/);
  assert.match(appSource, /readProjectBoardView\(routeProjectId, routeProject\?\.agentLanesConfigured\)/);
  assert.match(appSource, />\s*Agent Lanes\s*<\/button>/);
  assert.match(appSource, /boardView === "lanes" && selectedProject[\s\S]*?<AgentLaneBoard projectId=\{selectedProject\.id\} projectName=\{selectedProject\.name\}/);
  assert.match(apiSource, /getAgentLaneSnapshot[\s\S]*?\/api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
  assert.match(apiSource, /listAgentLaneProjectIds[\s\S]*?\/api\/local\/agent-lane-projects/);
  assert.doesNotMatch(appSource, /capstone-dev/);
  assert.doesNotMatch(boardSource, /Capstone Dev/);
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
