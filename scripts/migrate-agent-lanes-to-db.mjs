#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { TaskboardDatabase } from "../server/database.mjs";

const MIGRATION_ACTOR = {
  type: "agent",
  id: "agent-lane-migration",
  name: "Agent Lane Migration",
  avatarUrl: null,
};

function migratedStatus(state) {
  if (state === "waiting_user" || state === "blocked") return "blocked";
  if (state === "validating") return "in_review";
  if (state === "completed") return "done";
  return "todo";
}

const [databaseArgument, configArgument] = process.argv.slice(2);
if (!databaseArgument || !configArgument) {
  console.error("Usage: migrate-agent-lanes-to-db <taskboard.sqlite> <agent-lanes.json>");
  process.exitCode = 2;
} else {
  const database = new TaskboardDatabase(path.resolve(databaseArgument));
  try {
    const parsed = JSON.parse(await readFile(path.resolve(configArgument), "utf8"));
    if (parsed?.version !== 2 || !parsed.projects || typeof parsed.projects !== "object") {
      throw new Error("Expected Agent Lanes configuration version 2");
    }
    const projects = Object.entries(parsed.projects);
    for (const [projectId, project] of projects) {
      if (!project || typeof project !== "object" || !project.rootTaskId || !Array.isArray(project.tasks)) {
        throw new Error(`Invalid Agent Lanes project '${projectId}'`);
      }
      for (const todo of project.todos ?? []) {
        if (!todo?.id || !todo?.title) throw new Error(`Invalid legacy To-Do in '${projectId}'`);
      }
    }
    for (const [projectId, project] of projects) {
      if (!database.getProject(projectId)) {
        database.createProject({
          id: projectId,
          name: project.name ?? projectId,
          workspacePath: null,
        });
      }
      const existing = database.listTasks({ projectId, archived: "all" });
      for (const todo of project.todos ?? []) {
        const marker = `[agent-lane-legacy-id:${todo.id}]`;
        if (existing.some((task) => task.description.includes(marker))) continue;
        database.createTask({
          projectId,
          title: todo.title,
          description: `${marker}\nMigrated from the version 2 Agent Lanes configuration.`,
          status: migratedStatus(todo.state),
          priority: "medium",
          labels: ["agent-todo"],
          threadId: null,
          actor: MIGRATION_ACTOR,
          assignee: MIGRATION_ACTOR,
          developmentContext: null,
          startDate: null,
          dueDate: null,
          recurrence: null,
        });
      }
      database.upsertAgentLaneProject(projectId, {
        rootTaskId: project.rootTaskId,
        tasks: project.tasks ?? [],
        adapters: project.adapters ?? [],
      });
      console.log(`Migrated Agent Lanes identity and To-Dos for ${projectId}`);
    }
  } finally {
    database.close();
  }
}
