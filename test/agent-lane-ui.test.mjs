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
  assert.match(appSource, /boardView === "lanes" && selectedProject[\s\S]*?<AgentLaneBoard[\s\S]*?projectId=\{selectedProject\.id\}[\s\S]*?projectName=\{selectedProject\.name\}/);
  assert.match(apiSource, /getAgentLaneSnapshot[\s\S]*?\/api\/local\/projects\/\$\{encodeURIComponent\(projectId\)\}\/agent-lanes/);
  assert.match(apiSource, /listAgentLaneProjectIds[\s\S]*?\/api\/local\/agent-lane-projects/);
  assert.doesNotMatch(appSource, /capstone-dev/);
  assert.doesNotMatch(boardSource, /Capstone Dev/);
});

test("connected Codex lanes use the local launcher instead of browser protocol navigation", () => {
  assert.match(boardSource, /打开 Codex 对话/);
  assert.match(boardSource, /已在 Codex 打开/);
  assert.match(appSource, /onOpenCodexThread=\{openLegacyLocalThread\}/);
  assert.match(apiSource, /openCodexThread[\s\S]*?\/api\/local\/codex-threads\/\$\{encodeURIComponent\(threadId\)\}\/open/);
  assert.match(appSource, /await openCodexThreadRequest\(threadId\.trim\(\)\)/);
});

test("a ready Agent Todo can be delivered to the configured Root coordinator", () => {
  assert.match(boardSource, /交给 Root 协调/);
  assert.match(boardSource, /Root 已收到/);
  assert.match(boardSource, /todo\.state === "ready" && rootThreadId !== null/);
  assert.match(appSource, /type: "taskboard:coordinate-todo"/);
  assert.match(appSource, /onCoordinateTodo=\{coordinateAgentTodo\}/);
  assert.match(appSource, /taskboard:coordination-response/);
});

test("Todo cards expose compact DB-backed ownership and attention without Working Log", () => {
  for (const label of ["认领", "租约", "写入范围", "关注", "下一步"]) {
    assert.match(boardSource, new RegExp(label));
  }
  assert.match(boardSource, /todo\.claim\?\.ownerLabel/);
  assert.match(boardSource, /todo\.claim\.leaseState/);
  assert.match(boardSource, /todo\.writeScope/);
  assert.match(boardSource, /todo\.continuation\.attention/);
  assert.match(boardSource, /snapshot\.attentionQueue/);
  assert.match(boardSource, /setDeliveryState\("idle"\)/);
  assert.doesNotMatch(boardSource, /todo\.evidenceRef|latestWorkingLog/);
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
