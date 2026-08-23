#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { TaskboardDatabase } from "../server/database.mjs";

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
    for (const [projectId, project] of Object.entries(parsed.projects)) {
      database.upsertAgentLaneProject(projectId, {
        rootTaskId: project.rootTaskId,
        tasks: project.tasks ?? [],
        adapters: project.adapters ?? [],
      });
      console.log(`Migrated Agent Lanes identity for ${projectId}`);
    }
  } finally {
    database.close();
  }
}
