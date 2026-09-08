import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const chineseReadme = await readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");
const packagedTaskctlVerifier = await readFile(
  new URL("../scripts/verify-packaged-taskctl.mjs", import.meta.url),
  "utf8",
);

test("the macOS launcher preserves the visible Codex app and serializes lifecycle changes", () => {
  assert.match(launcherSource, /libc::flock/);
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(launcherSource, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/);
  assert.equal(launcherSource.match(/TcpListener::bind/g)?.length, 1);
  assert.match(launcherSource, /codex_port: Mutex<Option<u16>>/);
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "macos"\)\]\s+command\.args\(\["--launch", "--watch", "--port", &codex_port\]\);/,
  );
  assert.equal(launcherSource.match(/"--open"/g)?.length, 1);
  assert.match(
    launcherSource,
    /"open-taskboard" =>[\s\S]*?open_taskboard\(&state\)/,
  );
  assert.match(
    launcherSource,
    /RunEvent::Reopen \{ \.\. \}[\s\S]*?start_launcher\(app_handle, &state\)[\s\S]*?open_taskboard\(&state\)/,
  );
  assert.doesNotMatch(
    launcherSource,
    /#\[cfg\(target_os = "macos"\)\]\s+let ordinary_codex_pid = ordinary_codex_process/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(any\(target_os = "windows", target_os = "linux"\)\)\]\s+if let Some\(codex_pid\) = ordinary_codex_pid/,
  );
  assert.match(launcherSource, /reusedTaskboardInExistingCodex/);
  assert.doesNotMatch(launcherSource, /const LAUNCHER_PORT/);
});

test("the Chinese guide promises the same quiet single-visible macOS lifecycle", () => {
  assert.match(chineseReadme, /### 旧版\/手动：使用专用 CDP 端口/);
  assert.match(chineseReadme, /### 推荐：一个可见 Codex 与无界面协调器/);
  assert.match(chineseReadme, /后台启动和崩溃恢复不会打开或前置 Codex/);
  assert.match(chineseReadme, /只有选择.*打开任务面板.*或重新打开 Taskboard App/);
});

test("release signing is tag-only and PR CI builds the real unsigned app bundle", () => {
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
  assert.match(releaseWorkflow, /package\.json/);
  assert.match(releaseWorkflow, /Cargo\.toml/);
  assert.match(releaseWorkflow, /tauri\.conf\.json/);
  assert.match(releaseWorkflow, /TAG_FORCED/);
  assert.match(releaseWorkflow, /sign-macos-app\.mjs/);
  assert.match(releaseWorkflow, /notarytool submit/);
  assert.match(releaseWorkflow, /stapler validate/);
  assert.match(checkWorkflow, /tauri -- build/);
  assert.match(checkWorkflow, /--bundles app/);
  assert.match(checkWorkflow, /--no-sign/);
});

test("Windows CI runs the Node suite and the unsigned launcher skips unsupported updates", () => {
  assert.match(
    checkWorkflow,
    /windows-launcher:[\s\S]*?run: npm test[\s\S]*?run: npm run app:build:windows/,
  );
  assert.match(
    launcherSource,
    /cfg!\(target_os = "windows"\)[\s\S]*?Windows 版本暂不支持自动更新/,
  );
});

test("ordinary CI verifies installers without retaining disposable artifacts", () => {
  assert.match(
    checkWorkflow,
    /name: Build the unsigned NSIS installer[\s\S]*?run: npm run app:build:windows/,
  );
  assert.match(checkWorkflow, /name: Verify the Ubuntu 24\.04 x64 package contents/);
  assert.doesNotMatch(checkWorkflow, /actions\/upload-artifact@/);
  assert.match(releaseWorkflow, /actions\/upload-artifact@/);
});

test("the packaged taskctl preflight attributes issue updates through its environment", () => {
  const updateStart = packagedTaskctlVerifier.indexOf("const updated = runTaskctl");
  const updateEnd = packagedTaskctlVerifier.indexOf("const comment =", updateStart);
  assert.notEqual(updateStart, -1);
  assert.notEqual(updateEnd, -1);
  const updateInvocation = packagedTaskctlVerifier.slice(updateStart, updateEnd);
  assert.doesNotMatch(updateInvocation, /--thread-id/);
  assert.match(packagedTaskctlVerifier, /CODEX_THREAD_ID:/);
});

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, "14.0");
});
