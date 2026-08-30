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
  assert.match(boardSource, /todo\.readyWork\.eligible[\s\S]*?todo\.dispatchTarget !== null[\s\S]*?safeAction !== null[\s\S]*?!hasOpenRun/);
  assert.match(boardSource, /todo\.dispatchTarget!/);
  assert.match(appSource, /type: "taskboard:coordinate-todo"/);
  assert.match(appSource, /onCoordinateTodo=\{coordinateAgentTodo\}/);
  assert.match(appSource, /taskboard:coordination-response/);
  const coordinateSource = appSource.slice(
    appSource.indexOf("async function coordinateAgentTodo"),
    appSource.indexOf("function openTaskConversation"),
  );
  assert.match(coordinateSource, /rootThreadId: target\.rootThreadId/);
  assert.match(coordinateSource, /codexHostId: target\.codexHostId/);
  assert.match(coordinateSource, /rootWorkspacePath: target\.rootWorkspacePath/);
  assert.match(coordinateSource, /targetRoot: target\.worktreePath/);
  assert.match(coordinateSource, /safeActionId/);
  assert.match(coordinateSource, /expectedResumeToken: resumeToken/);
  assert.match(boardSource, /safeAction\?\.id/);
  assert.match(boardSource, /todo\.readyWork\.resumeToken/);
  assert.doesNotMatch(coordinateSource, /automationProjectContext/);
});

test("automatic continuation is opt-in, embedded-only, and resume-token deduplicated", () => {
  assert.match(boardSource, /自动衔接/);
  assert.match(boardSource, /coordinationAvailable/);
  assert.match(boardSource, /autoCoordinationEnabled/);
  assert.match(boardSource, /localStorage/);
  assert.match(boardSource, /readyWork\.safeActions\[0\]/);
  assert.match(boardSource, /readyWork\.resumeToken/);
  assert.match(boardSource, /autoCoordinationLastKeyRef/);
  assert.match(boardSource, /onCoordinateTodo\(/);
  assert.match(appSource, /coordinationAvailable=\{embedded && window\.parent !== window\}/);
});

test("a legacy Agent Todo backlog is not made dispatchable by its Root binding", () => {
  const todoCardSource = boardSource.slice(
    boardSource.indexOf("function TodoCard"),
    boardSource.indexOf("function SubagentCard"),
  );
  assert.match(todoCardSource, /const safeAction = todo\.readyWork\.safeActions\[0\]/);
  assert.match(todoCardSource, /const canCoordinate = todo\.readyWork\.eligible[\s\S]*?safeAction !== null[\s\S]*?!hasOpenRun/);
  assert.match(todoCardSource, /todo\.readyWork\.eligible \? "等待领取" : "等待条件满足"/);
  assert.doesNotMatch(todoCardSource, /todo\.state === "ready"/);
});

test("Todo cards expose Capsule-backed eligibility, Working Log, and durable Run state", () => {
  for (const label of ["认领", "租约", "写入范围", "工作日志", "执行", "关注", "消息排队", "交接待确认", "下一步"]) {
    assert.match(boardSource, new RegExp(label));
  }
  assert.match(boardSource, /todo\.claim\?\.ownerLabel/);
  assert.match(boardSource, /todo\.claim\.leaseState/);
  assert.match(boardSource, /todo\.writeScope/);
  assert.match(boardSource, /todo\.workingLog/);
  assert.match(boardSource, /todo\.run/);
  assert.match(boardSource, /RUN_STATE_LABELS/);
  assert.match(boardSource, /执行中/);
  assert.match(boardSource, /交付回执/);
  assert.match(boardSource, /todo\.continuation\.attention/);
  assert.match(boardSource, /todo\.inbox\.pendingCount/);
  assert.match(boardSource, /todo\.handoffs\.pendingAcknowledgementCount/);
  assert.match(boardSource, /当前工作继续/);
  assert.match(boardSource, /snapshot\.attentionQueue/);
  assert.match(boardSource, /setDeliveryState\("idle"\)/);
  assert.doesNotMatch(boardSource, /todo\.evidenceRef|latestWorkingLog/);
});

test("Todo cards expose safe continuation and exactly one authorization request", () => {
  assert.match(boardSource, /todo\.readyWork\.safeActions\.length/);
  assert.match(boardSource, /todo\.readyWork\.deferredActions\.length/);
  assert.match(boardSource, /todo\.readyWork\.approvalRequest\?\.message/);
  assert.match(boardSource, /授权请求/);
  assert.match(boardSource, /安全工作/);
});

test("the lane board keeps the owner view concise while synchronization stays automatic", () => {
  for (const label of ["当前工作", "Sub-Agent", "最近完成", "其他任务", "待办", "自动同步"]) {
    assert.match(boardSource, new RegExp(label));
  }
  assert.doesNotMatch(boardSource, /latestWorkingLog|Owner|Branch|SHA|Continuity|最后一次实际动作/);
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
