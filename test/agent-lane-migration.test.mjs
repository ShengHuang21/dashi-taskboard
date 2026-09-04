import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const execFileAsync = promisify(execFile);
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("version 2 migration creates missing projects and durable To-Dos idempotently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-lane-migration-"));
  directories.push(directory);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const configPath = path.join(directory, "agent-lanes.json");
  await writeFile(configPath, JSON.stringify({
    version: 2,
    projects: {
      "capstone-dev": {
        rootTaskId: "root",
        tasks: [{ id: "root", label: "Root", owner: "Codex", source: "codex", threadId: "root-thread", taskType: "root_task" }],
        todos: [{ id: "acceptance", title: "本机验收", state: "waiting_user" }],
        adapters: [],
      },
    },
  }));
  const script = new URL("../scripts/migrate-agent-lanes-to-db.mjs", import.meta.url);
  const scriptPath = fileURLToPath(script);
  await execFileAsync(process.execPath, [scriptPath, databasePath, configPath]);
  await execFileAsync(process.execPath, [scriptPath, databasePath, configPath]);
  const database = new TaskboardDatabase(databasePath);
  assert.equal(database.getProject("capstone-dev").name, "capstone-dev");
  const tasks = database.listTasks({ projectId: "capstone-dev", archived: "all" });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "blocked");
  assert.deepEqual(tasks[0].labels, ["agent-todo"]);
  assert.ok(database.getAgentLaneProject("capstone-dev"));
  database.close();
});
