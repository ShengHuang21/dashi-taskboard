#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTaskboardServer } from "../../server/app.mjs";

const configFile = process.argv[2];
if (!configFile || !path.isAbsolute(configFile)) throw new Error("Provide an explicit absolute local configuration file");
const config = JSON.parse(readFileSync(configFile, "utf8"));
for (const field of ["dataDirectory", "stateRoot", "workspaceRoot", "inputRoot", "capabilityFile"]) {
  if (!path.isAbsolute(config[field] ?? "")) throw new Error(`An absolute ${field} is required`);
}
for (const directory of [config.dataDirectory, config.stateRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
function privateValue(filename, size) {
  if (!existsSync(filename)) writeFileSync(filename, randomBytes(size).toString("hex"), { flag: "wx", mode: 0o600 });
  const stat = lstatSync(filename);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("Local credentials must be private regular files");
  return readFileSync(filename, "utf8").trim();
}
// Only this isolated launcher identity is created. No installed/live launcher is touched.
const instanceToken = privateValue(path.join(config.stateRoot, "owner-token"), 24);
const instanceSecret = privateValue(path.join(config.stateRoot, "owner-secret"), 32);
const schedulerToken = privateValue(path.join(config.stateRoot, "scheduler-token"), 32);
const app = createTaskboardServer({
  dataDirectory: config.dataDirectory,
  codexStatePath: path.join(config.stateRoot, "unused-owner-codex-state"),
  codexSessionsDirectory: path.join(config.stateRoot, "unused-owner-sessions"),
  codexExecutable: "/usr/bin/false",
  instanceToken, instanceSecret, projectSummaryEnabled: false,
  symphonyLocal: { projectId: config.projectId, workspaceRoot: config.workspaceRoot,
    inputRoot: config.inputRoot, capabilityFile: config.capabilityFile,
    signingSecretFile: path.join(config.stateRoot, "signing.key"), protectedPaths: [configFile], schedulerToken },
});
const address = await app.listen({ host: "127.0.0.1", port: config.port ?? 0 });
const baseUrl = `http://127.0.0.1:${address.port}`;
const descriptor = path.join(config.stateRoot, "launcher-runtime.json");
writeFileSync(descriptor, JSON.stringify({ version: 1, url: `${baseUrl}/${instanceToken}` }, null, 2) + "\n", { mode: 0o600 });
chmodSync(descriptor, 0o600);
console.log(JSON.stringify({ schedulerUrl: baseUrl, runtimeFile: descriptor, processId: process.pid }));
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
