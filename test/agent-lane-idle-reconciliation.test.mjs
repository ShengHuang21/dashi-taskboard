import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { actor, agentThreadId, idleFixture, projectId, statusCounts } from "./helpers/agent-lane-idle-fixture.mjs";

const baseline = process.env.TASKBOARD_IDLE_BASELINE === "1";

test("idle admission reads current project claims and avoids 74 full Capsules", async () => {
  const f = await idleFixture({ baseline });
  try {
    const provider = f.makeProvider();
    const before = f.observe();
    assert.deepEqual(Object.fromEntries(Object.keys(statusCounts).map((status) => [status,
      f.tasks.filter((task) => task.status === status).length])), statusCounts);
    assert.equal(f.probe(projectId), false);
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 0 });
    const idleCounts = { ...f.stats };
    assert.deepEqual(f.observe(), before);

    f.claim();
    assert.equal(f.probe(projectId), true);
    assert.equal(f.probe("other-project"), false);
    // Deliberate synthetic legacy/expired rows exercise the conservative read;
    // they never touch the real Taskboard database.
    const sql = f.database.database;
    sql.prepare("UPDATE agent_task_claims SET lease_expires_at = ? WHERE task_id = ?")
      .run("2000-01-01T00:00:00.000Z", f.activeTask.id);
    assert.equal(f.probe(projectId), true, "expired stored-active claims must still take old guards");
    await f.event();
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 0 });
    assert.equal(f.observe().receipts.length, 0);
    sql.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(f.activeTask.id);
    assert.equal(f.probe(projectId), true);
    for (const status of ["done", "backlog", "canceled", "todo"]) {
      sql.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, f.activeTask.id);
      assert.equal(f.probe(projectId), false, status);
    }
    sql.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(f.activeTask.id);
    for (const status of ["completed", "interrupted"]) {
      sql.prepare("UPDATE agent_task_claims SET status = ? WHERE task_id = ?").run(status, f.activeTask.id);
      assert.equal(f.probe(projectId), false, status);
      assert.deepEqual(await provider.reconcileProject(projectId), { applied: 0 });
    }
    sql.prepare("UPDATE agent_task_claims SET status = 'active' WHERE task_id = ?").run(f.activeTask.id);
    sql.prepare("UPDATE tasks SET archived_at = '2026-01-01' WHERE id = ?").run(f.activeTask.id);
    assert.equal(f.probe(projectId), false);
    sql.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?").run(f.activeTask.id);
    f.database.createProject({ id: "other-project", name: "Other synthetic project", workspacePath: null });
    sql.prepare("UPDATE agent_task_claims SET project_id = 'other-project' WHERE task_id = ?").run(f.activeTask.id);
    assert.equal(f.probe(projectId), false);
    assert.equal(f.probe("other-project"), false, "task and claim projects must agree");
    assert.equal(f.observe().receipts.length, 0);
    console.log("C01 idle observed", JSON.stringify(idleCounts));
    assert.equal(idleCounts.snapshots, 0, "idle tick must not build a full project snapshot");
    assert.equal(idleCounts.capsules, 0, "idle tick must not build 74 Capsules");
  } finally { await f.close(); }
});

test("fresh claims after idle reconcile once and changed claims cannot commit stale events", async () => {
  const f = await idleFixture({ baseline });
  try {
    const provider = f.makeProvider();
    // C09 A-before-B: an idle observation cannot suppress the next new claim.
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 0 });
    f.claim();
    await f.event();
    // C09 B-before-A: committed acquisition is visible on the next invocation.
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 1 });
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 0 });
    const progress = f.observe();
    assert.equal(progress.taskStatus, "in_progress");
    assert.equal(progress.claimStatus, "active");
    assert.equal(progress.runStatus, "active");
    assert.equal(progress.receipts.length, 1);
    assert.equal(progress.comments.length, 2);
    assert.equal(progress.comments.at(-1).threadId, agentThreadId);
    await f.event(true);
    assert.deepEqual(await provider.reconcileProject(projectId), { applied: 1 });
    const completed = f.observe();
    assert.equal(completed.taskStatus, "in_review");
    assert.equal(completed.claimStatus, "completed");
    assert.equal(completed.runStatus, "completed");
    assert.equal(completed.receipts.length, 2);
    assert.equal(completed.comments.length, 3);
    assert.ok(completed.taskVersion > progress.taskVersion);
    assert.ok(completed.runVersion > progress.runVersion);
    f.reopen();
    assert.deepEqual(await f.makeProvider().reconcileProject(projectId), { applied: 0 });
    assert.deepEqual(f.observe(), completed);

    // C09 overlap: pause the full read after admission and revoke from another
    // actor before that read resumes. The same barrier works on the old path.
    f.claim();
    let resume;
    let reached;
    const barrier = new Promise((resolve) => { resume = resolve; });
    const started = new Promise((resolve) => { reached = resolve; });
    const overlapping = f.makeProvider({ listTasks: async (id) => {
      reached();
      await barrier;
      return f.database.listTasks({ projectId: id, archived: "false" });
    } });
    const pending = overlapping.reconcileProject(projectId);
    await started;
    const claimed = f.database.getTask(f.activeTask.id);
    f.database.moveTask(claimed.id, claimed.version, "todo", undefined, null, undefined, actor);
    resume();
    assert.deepEqual(await pending, { applied: 0 });
    const interrupted = f.observe();
    assert.equal(interrupted.claimStatus, "interrupted");
    assert.equal(interrupted.taskStatus, "todo");
    assert.deepEqual(interrupted.receipts, completed.receipts);
    assert.deepEqual(interrupted.comments, completed.comments);
    console.log("C03/C04/C05/C09 authoritative observations", JSON.stringify({ progress, completed, interrupted }));
  } finally { await f.close(); }
});

test("idle admission leaves UI reads and optional callbacks intact and surfaces query errors", async () => {
  const f = await idleFixture({ baseline });
  try {
    const provider = f.makeProvider({ hasReconciliationWork: () => false });
    await provider.reconcileProject(projectId);
    f.resetStats();
    const ui = await provider.getProjectSnapshot(projectId);
    assert.equal(ui.todos.length, 74);
    assert.equal(f.stats.snapshots, 1);
    assert.equal(f.stats.capsules, 74);
    for (const result of [undefined, null, 0, true]) {
      f.resetStats();
      await f.makeProvider({ hasReconciliationWork: () => result }).reconcileProject(projectId);
      assert.equal(f.stats.capsules, 74, `only explicit false skips, not ${result}`);
    }
    f.resetStats();
    await f.makeProvider({ hasReconciliationWork: null }).reconcileProject(projectId);
    assert.equal(f.stats.capsules, 74, "absent predicate preserves the full path");
    f.resetStats();
    await f.makeProvider({ recordProgress: null, recordCompletion: null,
      hasReconciliationWork: () => { throw new Error("must not query without record callbacks"); },
    }).reconcileProject(projectId);
    assert.equal(f.stats.capsules, 0);
    assert.equal(f.stats.snapshots, 0);
    let fail = true;
    const retrying = f.makeProvider({ hasReconciliationWork: async () => {
      if (fail) throw new Error("synthetic query failure");
      return false;
    } });
    // C10a is a real old-provider defect: it ignores the supplied failing gate.
    await assert.rejects(retrying.reconcileProject(projectId), /synthetic query failure/);
    fail = false;
    assert.deepEqual(await retrying.reconcileProject(projectId), { applied: 0 });
    const app = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
    assert.match(app, /hasReconciliationWork:\s*\(projectId\)\s*=>\s*database\.hasAgentTaskReconciliationWork\(projectId\)/);
  } finally { await f.close(); }
});
