import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

function waitForOutput(child, output, errors, pattern, timeoutMs = 15_000) {
  if (pattern.test(output.value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out waiting for ${pattern}: ${output.value}\n${errors.value}`,
      ));
    }, timeoutMs);
    const onData = () => {
      if (!pattern.test(output.value)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `Injector exited before ${pattern} (${signal || code}): ${errors.value}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

test("resident macOS coordination starts and stops without a renderer or second app", {
  skip: process.platform !== "darwin",
  timeout: 30_000,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "taskboard-single-visible-"));
  const fakeCodex = path.join(temporaryRoot, "fake-codex.mjs");
  const fakeApp = path.join(temporaryRoot, "No Visible Codex.app");
  const runtimeFile = path.join(temporaryRoot, "launcher-runtime.json");
  const port = await reserveLoopbackPort();
  await writeFile(fakeCodex, `#!/usr/bin/env node
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf("\\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) {
      const request = JSON.parse(line);
      if (Object.hasOwn(request, "id")) {
        const result = request.method === "initialize"
          ? { platformFamily: "unix", platformOs: "macos", userAgent: "fake" }
          : {};
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
      }
    }
    newline = buffered.indexOf("\\n");
  }
});
`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const output = { value: "" };
  const errors = { value: "" };
  const child = spawn(process.execPath, [
    "scripts/codex-injector.mjs",
    "--launch",
    "--watch",
    "--app-path",
    fakeApp,
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_EXECUTABLE: fakeCodex,
      CODEX_TASKBOARD_DATA_DIR: temporaryRoot,
      CODEX_TASKBOARD_RUNTIME_FILE: runtimeFile,
      CODEX_TASKBOARD_PORT: String(port),
      CODEX_TASKBOARD_VERSION: "single-visible-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { errors.value += chunk; });

  try {
    await waitForOutput(child, output, errors, /"taskboardHeadlessCodexReady":true/);
    await waitForOutput(child, output, errors, /"singleVisibleCodexMode":true/);
    assert.doesNotMatch(output.value, /"injected"/);
    assert.doesNotMatch(output.value, /reusedCodexPid|cdpPort/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit");
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Injector did not stop: ${errors.value}`)),
          10_000,
        );
        timer.unref();
      }),
    ]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0, errors.value);
});
