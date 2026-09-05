#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import { normalizeRepository } from "../server/standing-authority.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import {
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";
import {
  classifyOwnerIntentPlanHttpFailure,
  classifyCoordinatorProvisioningActiveThread,
  classifyCoordinatorProvisioningDeliveryTurns,
  buildCoordinatorProvisioningDeliveryTurnStartParams,
  coordinatorProvisioningTurnStartParams,
  planCoordinatorProvisioningDeliveryRetry,
  selectCoordinatorProvisioningFallbackModel,
  coordinatorProvisioningInspectionDiagnosticReason,
  coordinatorProvisioningThreadListData,
  findCoordinatorProvisioningThreadAcrossPages,
  coordinatorThreadSelectionConfirmed,
  createDisposableMonitorTimer,
  createOpenGenerationRouteResolver,
  createSerializedMonitorTick,
  deliverTaskboardAdmissionRecovery,
  deliverTaskboardCoordination,
  deliverTaskboardCrossDomainHandoff,
  deliverTaskboardOwnerDecision,
  deliverTaskboardOwnerIntent,
  findResidentInjectorPids,
  handleHostBindingPayload,
  readCoordinatorProvisioningDeliveryThread,
  readCoordinatorProvisioningAttemptThread,
  resumeCoordinatorProvisioningDeliveryThread,
  loadResidentCoordinatorMonitorProjects,
  reconcileInjectionRuntime,
  restartResidentInjector,
  observeTaskboardOwnerDecision,
  observeTaskboardOwnerIntentCapture,
  observeTaskboardOwnerIntentPlan,
  runOwnerDecisionMonitorOnce,
  runOwnerIntentAdoptionMonitorOnce,
  runOwnerIntentCaptureMonitorOnce,
  runOwnerIntentPlanningMonitorOnce,
  runBackgroundCoordinatorIdentityHandshakeMonitorOnce,
  runCoordinatorIdentityHandshakeFastLane,
  runCoordinatorProvisioningMonitorOnce,
  runDomainCoordinatorProvisioningMonitorOnce,
  runDomainCoordinatorShutdownMonitorOnce,
  runCoordinatorShutdownMonitorOnce,
  runCoordinatorLeaseKeepaliveMonitorOnce,
  runCoordinatorLeaseRecoveryMonitorOnce,
  runCrossDomainHandoffMonitorOnce,
  runTaskboardProjectMonitorSequence,
  runTaskboardContinuationMonitorOnce,
  selectLaunchCoordinatorRoute,
} from "./codex-injector-runtime.mjs";
import { createNativeTaskboardPanelOpener } from "./taskboard-panel-open.mjs";
import { readCodexQuotaStatus } from "./codex-rate-limits.mjs";
import { createTaskboardSupervisor } from "./taskboard-supervisor.mjs";
import {
  CdpPipeBrowser,
  validatedLoopbackCdpWebSocketUrl,
} from "./codex-cdp-pipe.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const defaultCodexDebuggingPort = 9229;
const independentCodexProfilePath = process.env.CODEX_TASKBOARD_CODEX_PROFILE
  ? path.resolve(process.env.CODEX_TASKBOARD_CODEX_PROFILE)
  : process.platform === "linux"
    ? path.join(os.tmpdir(), "codex-taskboard-independent-profile-v2")
    : "/private/tmp/codex-taskboard-independent-profile-v2";
const sourceCodexProfilePath = process.env.CODEX_TASKBOARD_CODEX_SOURCE_PROFILE
  ? path.resolve(process.env.CODEX_TASKBOARD_CODEX_SOURCE_PROFILE)
  : null;
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const taskboardDataDirectory = process.env.CODEX_TASKBOARD_DATA_DIR
  ? path.resolve(process.env.CODEX_TASKBOARD_DATA_DIR)
  : path.join(projectRoot, ".data");
const taskboardRuntimeFile = process.env.CODEX_TASKBOARD_RUNTIME_FILE
  ? path.resolve(process.env.CODEX_TASKBOARD_RUNTIME_FILE)
  : path.join(taskboardDataDirectory, "launcher-runtime.json");
const taskboardListenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
  ? null
  : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
if (taskboardListenFd !== null && (
  !Number.isInteger(taskboardListenFd)
  || taskboardListenFd < 3
  || taskboardListenFd > 255
)) {
  throw new Error("CODEX_TASKBOARD_LISTEN_FD must be an inherited file descriptor");
}
const coordinatorProvisioningDiagnosticReasons = new Map();

function reportCoordinatorProvisioningDiagnostic(projectId, result) {
  const reason = typeof result?.reason === "string" && result.reason
    ? result.reason
    : "unknown";
  const inspectionReason = coordinatorProvisioningInspectionDiagnosticReason(
    result?.inspectionReason,
  );
  const diagnosticKey = `${reason}:${inspectionReason}`;
  if (coordinatorProvisioningDiagnosticReasons.get(projectId) === diagnosticKey) return;
  coordinatorProvisioningDiagnosticReasons.set(projectId, diagnosticKey);
  console.error(JSON.stringify({
    event: "taskboard.coordinator.provisioning",
    projectId,
    provisioned: result?.provisioned === true,
    reason,
    attemptPresent: typeof result?.attemptId === "string" && result.attemptId.length > 0,
    ...(reason === "window-inspection-unavailable" ? { inspectionReason } : {}),
  }));
}
const automationPoliciesPath = path.join(
  taskboardDataDirectory,
  "codex-automation-policies.json",
);
const taskboardInstanceToken = (
  process.env.CODEX_TASKBOARD_INSTANCE_TOKEN?.trim() || randomUUID()
);
process.env.CODEX_TASKBOARD_INSTANCE_TOKEN = taskboardInstanceToken;
const taskboardInstanceSecret = (
  process.env.CODEX_TASKBOARD_INSTANCE_SECRET?.trim() || randomBytes(32).toString("hex")
);
process.env.CODEX_TASKBOARD_INSTANCE_SECRET = taskboardInstanceSecret;
const taskboardVersion = process.env.CODEX_TASKBOARD_VERSION?.trim() || "development";
process.env.CODEX_TASKBOARD_VERSION = taskboardVersion;
const taskboardOrigin = `http://127.0.0.1:${resolvePort()}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const taskboardBaseUrl = `${taskboardOrigin}/${encodeURIComponent(taskboardInstanceToken)}`;
const taskboardPageUrl = `${taskboardBaseUrl}/?host=codex`;
const hostBindingName = "__codexTaskboardHostV1";
const hostRequestMessage = "__codexTaskboardHostRequestV1";
const hostResponseMessage = "__codexTaskboardHostResponseV1";
const hostHeartbeatMessage = "__codexTaskboardHostHeartbeatV1";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV1";
const hostCapability = randomUUID();
const hostRequestQueueGlobalName = "__CODEX_TASKBOARD_HOST_REQUEST_QUEUE_V1__";
const hostRequestQueueName = `${hostBindingName}_queue_${randomBytes(16).toString("hex")}`;
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const codexAutomationMethods = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);
let codexAutomationRequestSequence = 0;
let codexAppServerRequestSequence = 0;
const taskConversationOperations = new Map();
const taskConversationFailureTtlMs = 120_000;
const backgroundContinuationPolicyPrefix = "taskboard:background-continuation:policy:";
const backgroundContinuationIntervalMs = 15_000;
const coordinatorIdentityHandshakeIntervalMs = 2_000;
const coordinatorLeaseRenewWindowMs = 45_000;
const coordinatorLeaseDurationSeconds = 120;
const coordinatorShutdownIdleGraceMs = 60_000;
const configuredMaxActiveAgents = (() => {
  const value = Number(process.env.CODEX_TASKBOARD_MAX_ACTIVE_AGENTS ?? "4");
  return Number.isSafeInteger(value) && value >= 1 && value <= 64 ? value : 4;
})();
const capacityObservationMaxAgeMs = 60_000;
const quotaPolicyTimers = new Map();
const quotaPolicyRecords = new Map();
const quotaPolicyQueues = new Map();
const quotaPolicyCdps = new Set();
const restoredQuotaPolicyCdps = new WeakSet();
const quotaPolicyRestorePromises = new WeakMap();
let quotaPoliciesLoadPromise = null;
let quotaPoliciesWritePromise = Promise.resolve();
const taskConversationAppServerTimeoutMs = 30_000;

function parseArgs(argv) {
  const options = {
    port: defaultCodexDebuggingPort,
    portExplicit: false,
    cdpPipe: false,
    launch: false,
    watch: false,
    open: false,
    refresh: false,
    refreshIfRunning: false,
    attachExisting: false,
    startupToken: null,
    daemon: false,
    screenshot: null,
    appPath: process.platform === "linux" ? "/usr/bin/chatgpt" : "/Applications/ChatGPT.app",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--cdp-pipe") options.cdpPipe = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--startup-token") {
      options.startupToken = argv[++index];
      if (!/^[a-z0-9-]{1,100}$/i.test(options.startupToken || "")) {
        throw new Error("--startup-token must be an identifier");
      }
    }
    else if (arg === "--daemon") options.daemon = true;
    else if (arg === "--port") {
      options.port = Number(argv[++index]);
      options.portExplicit = true;
    }
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (process.platform === "linux" && options.launch) options.cdpPipe = true;

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (options.cdpPipe && !options.launch) {
    throw new Error("--cdp-pipe requires --launch");
  }
  return options;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isTaskboardReachable() {
  const challenge = randomBytes(32).toString("hex");
  try {
    const response = await fetch(taskboardHealthUrl, {
      headers: { "x-codex-taskboard-challenge": challenge },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    const proof = createHmac("sha256", taskboardInstanceSecret)
      .update(challenge)
      .digest("hex");
    return body?.status === "ok"
      && body.product === "codex-taskboard"
      && body.version === taskboardVersion
      && body.proof === proof;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url, timeoutMs, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    if (await isReachable(url)) return;
    if (shouldStop()) throw new Error(`Stopped waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntilTaskboardReachable(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTaskboardReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for authenticated ${taskboardHealthUrl}`);
}

function startTaskboard({ detached }) {
  const stdio = taskboardListenFd === null
    ? (detached ? "ignore" : "inherit")
    : Array.from(
      { length: taskboardListenFd + 1 },
      (_, fd) => (fd === taskboardListenFd ? "inherit" : (fd < 3 && !detached ? "inherit" : "ignore")),
    );
  return spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    stdio,
  });
}

async function publishTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  const temporaryPath = `${taskboardRuntimeFile}.${process.pid}.tmp`;
  await mkdir(path.dirname(taskboardRuntimeFile), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, pid: process.pid, url: taskboardBaseUrl })}\n`,
    { mode: 0o600 },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, taskboardRuntimeFile);
  await chmod(taskboardRuntimeFile, 0o600);
}

async function removeTaskboardRuntime() {
  if (!taskboardRuntimeFile) return;
  try {
    const descriptor = JSON.parse(await readFile(taskboardRuntimeFile, "utf8"));
    if (descriptor.pid === process.pid && descriptor.url === taskboardBaseUrl) {
      await unlink(taskboardRuntimeFile);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function importCodexBrowserProfile() {
  if (!sourceCodexProfilePath || sourceCodexProfilePath === independentCodexProfilePath) return;
  const markerPath = path.join(
    independentCodexProfilePath,
    ".codex-taskboard-browser-profile-imported-v1",
  );
  try {
    await stat(markerPath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const databasePaths = [
    "Default/Partitions/codex-browser-app/Cookies",
    "Default/Partitions/codex-browser-app/Login Data",
    "Default/Partitions/codex-browser-app/Login Data For Account",
  ];
  const sources = [];
  for (const relativePath of databasePaths) {
    const sourcePath = path.join(sourceCodexProfilePath, relativePath);
    try {
      await stat(sourcePath);
      sources.push({ relativePath, sourcePath });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (sources.length === 0) return;

  const { DatabaseSync, backup } = await import("node:sqlite");
  for (const { relativePath, sourcePath } of sources) {
    const destinationPath = path.join(independentCodexProfilePath, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(sourceDatabase, destinationPath);
    } finally {
      sourceDatabase.close();
    }
  }
  if (sources.length === databasePaths.length) {
    await writeFile(markerPath, "1\n");
  }
}

function codexExecutablePath(appPath) {
  if (process.platform === "linux") {
    return appPath === "/usr/bin/chatgpt" ? "/usr/lib/chatgpt/ChatGPT" : appPath;
  }
  if (process.platform !== "darwin") return appPath;
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(appPath, ".app"),
  );
}

function codexAppProcesses(appPath) {
  const processes = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) throw new Error("Unable to inspect the launched Codex process");

  const executable = codexExecutablePath(appPath);
  const matches = [];
  for (const line of processes.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (
      match
      && (match[2] === executable || match[2].startsWith(`${executable} `))
    ) {
      matches.push({ pid: Number(match[1]), command: match[2] });
    }
  }
  return matches;
}

function managedCodexProcesses(appPath) {
  const profileArgument = `--user-data-dir=${independentCodexProfilePath}`;
  return codexAppProcesses(appPath).filter((record) => (
    record.command.includes(` ${profileArgument} `)
  ));
}

function managedCodexProcess(appPath) {
  const processes = managedCodexProcesses(appPath);
  if (processes.length > 1) throw new Error("Multiple managed Codex processes are running");
  return processes[0] ?? null;
}

function codexProcessDebuggingPort(record) {
  const match = record.command.match(/ --remote-debugging-port=(\d+)(?: |$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function managedCodexUsesPort(record, port) {
  return record.command.includes(` --remote-debugging-port=${port} `);
}

function isManagedCodexRunning(record) {
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-p", String(record.pid), "-o", "command="],
    {
      encoding: "utf8",
      env: withoutTaskboardLauncherEnvironment(process.env),
    },
  );
  return result.status === 0 && result.stdout.trimEnd() === record.command;
}

async function launchCodexWithLaunchServices(appPath, port, shouldStop = () => false) {
  const existing = managedCodexProcess(appPath);
  if (existing && managedCodexUsesPort(existing, port)) return existing;
  if (existing) await stopManagedCodex(existing);
  if (shouldStop()) throw new Error("Managed Codex launch stopped");
  if (await isReachable(`http://127.0.0.1:${port}/json/version`)) {
    throw new Error(`Codex CDP port ${port} is already in use`);
  }
  if (shouldStop()) throw new Error("Managed Codex launch stopped");

  const launcher = spawn(
    "/usr/bin/open",
    [
      "-n",
      "-a",
      appPath,
      "--args",
      `--user-data-dir=${independentCodexProfilePath}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ],
    {
      env: withoutTaskboardLauncherEnvironment(process.env),
      stdio: "ignore",
    },
  );
  await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`LaunchServices failed to start Codex (${signal || code})`));
    });
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const launched = managedCodexProcess(appPath);
    if (launched && managedCodexUsesPort(launched, port)) return launched;
    if (launched) throw new Error("LaunchServices started Codex on an unexpected CDP port");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("LaunchServices did not start the managed Codex process");
}

async function stopManagedCodex(record) {
  if (!isManagedCodexRunning(record)) return;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isManagedCodexRunning(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!isManagedCodexRunning(record)) return;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    if (!isManagedCodexRunning(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isManagedCodexRunning(record)) {
    throw new Error("Unable to stop the managed Codex process");
  }
}

function activateCodexApp(pid) {
  if (process.platform !== "darwin") return;
  const activation = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!app || !app.activateWithOptions(1)) throw new Error("Unable to activate Codex");`,
  ], {
    env: withoutTaskboardLauncherEnvironment(process.env),
    stdio: "ignore",
  });
  if (activation.status !== 0) throw new Error("Unable to activate the Codex app");
}

async function launchCodexWithPipe(appPath) {
  const child = spawn(
    codexExecutablePath(appPath),
    [
      `--user-data-dir=${independentCodexProfilePath}`,
      "--remote-debugging-pipe",
    ],
    {
      env: withoutTaskboardLauncherEnvironment(process.env),
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  const browser = new CdpPipeBrowser(child);
  try {
    await browser.open();
    return { child, browser };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closeHandlers = new Set();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleFailure);
        this.socket.removeEventListener("close", handleFailure);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleFailure = () => {
        cleanup();
        this.closed = true;
        reject(new Error("CDP WebSocket connection failed"));
      };
      this.socket.addEventListener("open", handleOpen, { once: true });
      this.socket.addEventListener("error", handleFailure, { once: true });
      this.socket.addEventListener("close", handleFailure, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method) || [];
        this.eventWaiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        const handlers = this.eventHandlers.get(message.method) || [];
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(message.params)).catch((error) => {
              console.error(`CDP ${message.method} handler failed: ${error.message}`);
            });
          } catch (error) {
            console.error(`CDP ${message.method} handler failed: ${error.message}`);
          }
        });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
      const closeHandlers = [...this.closeHandlers];
      this.closeHandlers.clear();
      closeHandlers.forEach((handler) => {
        try {
          handler();
        } catch (error) {
          console.error(`CDP close handler failed: ${error.message}`);
        }
      });
    });
  }

  send(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket closed"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  onClose(handler) {
    if (typeof handler !== "function") throw new Error("CDP close handler must be a function");
    if (this.closed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(isCodexTarget).map((target) => {
    return {
      ...target,
      webSocketDebuggerUrl: validatedLoopbackCdpWebSocketUrl(
        target.webSocketDebuggerUrl,
        port,
      ),
    };
  });
}

function isCodexTarget(target) {
  return (
      target.type === "page" &&
      !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
      !target.url?.includes("initialRoute=%2Favatar-overlay") &&
      (target.url?.startsWith("app://") || target.title === "Codex")
  );
}

function tcpCdpRuntime(port) {
  return {
    targets: () => codexTargets(port),
    connect: async (target) => {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      await connection.open();
      return connection;
    },
    close: () => {},
  };
}

function pipeCdpRuntime(browser) {
  return {
    targets: async () => (await browser.targets())
      .filter(isCodexTarget)
      .map((target) => ({ ...target, id: target.targetId })),
    connect: (target) => browser.connect(target.id),
    isHealthy: () => !browser.closed,
    close: () => browser.close(),
  };
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

function processCwd(pid) {
  const result = spawnSync("/usr/sbin/lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function residentInjectorPids(port) {
  const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    env: withoutTaskboardLauncherEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [];
  return findResidentInjectorPids({
    processList: processes.stdout,
    currentPid: process.pid,
    injectorPath,
    projectRoot,
    port,
    defaultPort: defaultCodexDebuggingPort,
    cwdForPid: processCwd,
  });
}

function startResidentInjector(
  port,
  shouldOpen,
  attachExisting = false,
  startupToken = null,
) {
  const [existingPid] = residentInjectorPids(port);
  if (existingPid) return { pid: existingPid, started: false };
  const args = [injectorPath, "--watch", "--port", String(port)];
  if (shouldOpen) args.push("--open");
  if (attachExisting) args.push("--attach-existing");
  if (startupToken) args.push("--startup-token", startupToken);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, started: true };
}

async function stopResidentInjector(pid) {
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out stopping resident Taskboard injector ${pid}`);
}

async function waitForResidentInjectorReady(port, pid, startupToken, expectedSourceHash) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      const targets = await codexTargets(port);
      for (const target of targets) {
        const cdp = new CdpConnection(target.webSocketDebuggerUrl);
        await cdp.open();
        try {
          const readiness = await cdp.send("Runtime.evaluate", {
            expression: `({
              token: window[${JSON.stringify(hostStartupTokenName)}],
              taskboardEntryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
              sourceHash: window.__codexTaskboardInjection__?.sourceHash || null
            })`,
            returnByValue: true,
          });
          if (
            readiness.result.value?.token === startupToken
            && readiness.result.value.taskboardEntryMounted
            && readiness.result.value.sourceHash === expectedSourceHash
          ) return;
        } finally {
          cdp.close();
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for resident Taskboard injector ${pid}`);
}

async function restartResidentInjectorForRefresh(port) {
  const { sourceHash } = await currentInjectionSource();
  return restartResidentInjector(port, {
    findResidents: residentInjectorPids,
    stopResident: stopResidentInjector,
    createStartupToken: randomUUID,
    startResident: (targetPort, startupToken) => (
      startResidentInjector(targetPort, false, true, startupToken)
    ),
    waitUntilReady: (targetPort, pid, startupToken) => (
      waitForResidentInjectorReady(targetPort, pid, startupToken, sourceHash)
    ),
  });
}

async function refreshTaskboardFrames(port) {
  const targets = await codexTargets(port);
  const results = [];

  for (const target of targets) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await cdp.send("Runtime.enable");
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.reloadFrame === "function") {
            return { refreshed: taskboard.reloadFrame(), via: "injection" };
          }
          const frame = document.getElementById("codex-taskboard-frame");
          if (!frame) return { refreshed: false, via: "not-mounted" };
          const url = new URL(frame.getAttribute("src") || frame.src);
          url.searchParams.set("__codex_taskboard_refresh", Date.now().toString(36));
          frame.setAttribute("src", url.href);
          return { refreshed: true, via: "fallback", frameUrl: url.href };
        })()`,
        returnByValue: true,
      });
      if (evaluation.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description || "Taskboard frame refresh failed",
        );
      }
      results.push({
        targetId: target.id,
        title: target.title,
        url: target.url,
        ...evaluation.result.value,
      });
    } finally {
      cdp.close();
    }
  }

  return results;
}

function frameTreeContains(frameTree, expectedUrl) {
  if (frameTree.frame?.url === expectedUrl) return true;
  return frameTree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree"),
    ]);
    if (
      targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) ||
      frameTreeContains(frameTree, expectedUrl)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function findFrameByName(frameTree, frameName) {
  if (frameTree.frame?.name === frameName) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByName(child, frameName);
    if (match) return match;
  }
  return null;
}

async function verifiedTaskboardDocument(frameCapability) {
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(taskboardPageUrl, {
    cache: "no-store",
    headers: {
      origin: "app://-",
      "x-codex-taskboard-challenge": challenge,
    },
  });
  if (!response.ok) throw new Error(`Taskboard HTTP ${response.status}`);
  const proof = response.headers.get("x-codex-taskboard-proof") ?? "";
  const expectedProof = createHmac("sha256", taskboardInstanceSecret)
    .update(challenge)
    .digest("hex");
  if (proof !== expectedProof) throw new Error("Taskboard service identity check failed");
  const html = await response.text();
  const head = "<head>";
  if (!html.includes(head)) throw new Error("Taskboard document has no head element");
  return html.replace(
    head,
    `${head}<base href=${JSON.stringify(taskboardPageUrl)}><script>globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__=${JSON.stringify(frameCapability)};</script>`,
  );
}

async function loadTaskboardFrameViaCdp(cdp, frameName, frameCapability) {
  const html = await verifiedTaskboardDocument(frameCapability);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const targetFrame = findFrameByName(frameTree, frameName);
    if (targetFrame) {
      await cdp.send("Page.setDocumentContent", {
        frameId: targetFrame.id,
        html,
      });
      return { loaded: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the isolated Taskboard frame");
}

async function openWithDefaultApplication(target) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32"
        ? "explorer.exe"
        : process.platform === "linux" ? "xdg-open" : "/usr/bin/open",
      [target],
      {
        detached: true,
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function revealAttachmentInFinder(attachmentPath, directory) {
  if (process.platform === "linux") {
    await openWithDefaultApplication(directory);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-R", attachmentPath], {
        env: withoutTaskboardLauncherEnvironment(process.env),
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Finder could not reveal the attachment"));
      });
    });
  } catch {
    await openWithDefaultApplication(directory);
  }
}

async function openExternalUrl(request) {
  await openWithDefaultApplication(request.url);
  return { opened: true };
}

async function openAttachment(request) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/attachments/${encodeURIComponent(request.attachmentId)}/content`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Attachment content returned HTTP ${response.status}`);
  const directory = path.join(
    taskboardDataDirectory,
    "opened-attachments",
    request.attachmentId,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachmentPath = path.join(directory, request.filename);
  await writeFile(attachmentPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  await revealAttachmentInFinder(attachmentPath, directory);
  return { opened: true };
}

async function requestCodexAutomationViaCdp(cdp, executionContextId, method, params) {
  if (!codexAutomationMethods.has(method)) {
    throw new Error(`Unsupported Codex automation method: ${method}`);
  }
  const requestId = [
    "taskboard-automation",
    process.pid,
    Date.now().toString(36),
    (++codexAutomationRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const method = ${JSON.stringify(method)};
      const params = ${JSON.stringify(params)};
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        finish({
          ok: true,
          responseType: message.responseType,
          status: message.status,
          bodyJsonString: message.bodyJsonString,
        });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
        10_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: \`vscode://codex/${method}\`,
        body: JSON.stringify(params),
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex automation request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex automation request failed");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Codex automation request returned HTTP ${response.status}`);
  }
  if (typeof response.bodyJsonString !== "string" || response.bodyJsonString.length === 0) {
    return {};
  }
  try {
    return JSON.parse(response.bodyJsonString);
  } catch {
    throw new Error("Codex automation request returned invalid JSON");
  }
}

async function requestCodexAppServerViaCdp(
  cdp,
  executionContextId,
  hostId,
  method,
  params,
  timeoutMs = taskConversationAppServerTimeoutMs,
) {
  const requestId = [
    "taskboard-thread",
    process.pid,
    Date.now().toString(36),
    (++codexAppServerRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "Codex App Server bridge is unavailable" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage, true);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "mcp-response"
          || message.hostId !== ${JSON.stringify(hostId)}
          || message.message?.id !== requestId
        ) return;
        event.stopImmediatePropagation();
        if (message.message.error) {
          finish({
            ok: false,
            error: message.message.error.message || "Codex App Server request failed",
          });
          return;
        }
        finish({ ok: true, result: message.message.result });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex App Server request timed out" }),
        ${JSON.stringify(timeoutMs)},
      );
      window.addEventListener("message", onMessage, true);
      Promise.resolve(bridge.sendMessageFromView({
        type: "mcp-request",
        hostId: ${JSON.stringify(hostId)},
        request: {
          id: requestId,
          method: ${JSON.stringify(method)},
          params: ${JSON.stringify(params)},
        },
        priority: "interactive",
        source: "taskboard_thread_create",
        timeoutMs: ${JSON.stringify(timeoutMs)},
        expiresAtMs: Date.now() + ${JSON.stringify(timeoutMs)},
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex App Server request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex App Server request failed");
  return response.result;
}

function initializeHostRequestQueueExpression(queueName) {
  return `(() => {
    const queueName = ${JSON.stringify(queueName)};
    if (!Array.isArray(window[queueName])) window[queueName] = [];
    return window[queueName].length;
  })()`;
}

async function applyTaskboardAutomationPolicy(
  request,
  rpc,
  stillCurrent = () => true,
  { explicit = false, previousQuotaState } = {},
) {
  const quota = request.quotaAware
    ? await readCodexQuotaStatus(request.model)
    : null;
  if (!stillCurrent()) return { quota, stale: true };
  let listed = null;
  let currentItem;
  if (!explicit && request.enabledByUser) {
    listed = await reconcileTaskboardAutomation({ ...request, operation: "list" }, rpc);
    const items = Array.isArray(listed.items) ? listed.items : [];
    currentItem = (
      request.automationId
        ? items.find((item) => item.id === request.automationId)
        : null
    ) ?? items[0];
  }
  const operation = taskboardAutomationPolicyOperation(request, {
    explicit,
    previousQuotaState,
    quotaState: quota?.state,
    currentStatus: currentItem?.status,
  });
  const result = operation === "list"
    ? { item: currentItem, items: listed.items }
    : await reconcileTaskboardAutomation({ ...request, operation }, rpc);
  if (result?.error === "not-found") {
    return { operation, ...(quota ? { quota } : {}) };
  }
  return { ...result, operation, ...(quota ? { quota } : {}) };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    codexProjectKind: request.codexProjectKind,
    codexHostId: request.codexHostId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
    remoteProjects: request.remoteProjects ?? [],
    skillPath: request.skillPath,
    ...(request.automationId ? { automationId: request.automationId } : {}),
    enabledByUser: request.enabledByUser,
    quotaAware: request.quotaAware,
    intervalMinutes: request.intervalMinutes,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

function restoredAutomationPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { quota, ...stored } = value;
  const request = parseTaskboardAutomationHostRequest({
    ...stored,
    id: "restored-policy",
    action: "automation",
    requestId: "restored-policy",
    operation: "apply-policy",
  });
  return request ? { request, ...(quota ? { quota } : {}) } : null;
}

async function ensureQuotaPoliciesLoaded() {
  if (quotaPoliciesLoadPromise) return quotaPoliciesLoadPromise;
  quotaPoliciesLoadPromise = (async () => {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(automationPoliciesPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const value of Object.values(stored)) {
      const restored = restoredAutomationPolicy(value);
      if (!restored) continue;
      quotaPolicyRecords.set(restored.request.taskboardProjectId, {
        version: 1,
        ...restored,
      });
    }
  })();
  return quotaPoliciesLoadPromise;
}

function persistQuotaPolicies() {
  const data = Object.fromEntries(
    [...quotaPolicyRecords.entries()].map(([projectId, record]) => [
      projectId,
      {
        ...storedAutomationPolicy(record.request),
        ...(record.quota ? { quota: record.quota } : {}),
      },
    ]),
  );
  quotaPoliciesWritePromise = quotaPoliciesWritePromise
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(automationPoliciesPath), { recursive: true });
      await writeFile(automationPoliciesPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  return quotaPoliciesWritePromise;
}

function registerQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
  quotaPolicyCdps.add(cdp);
}

function unregisterQuotaPolicyCdp(cdp) {
  quotaPolicyCdps.delete(cdp);
}

function currentQuotaPolicyCdp() {
  const candidates = [...quotaPolicyCdps].reverse();
  for (const cdp of candidates) {
    if (!cdp.closed) return cdp;
    quotaPolicyCdps.delete(cdp);
  }
  throw new Error("No live Codex renderer is available for quota automation");
}

function scheduleQuotaPolicyCheck(record, result) {
  const { request, version } = record;
  const key = request.taskboardProjectId;
  const previous = quotaPolicyTimers.get(key);
  if (previous) clearTimeout(previous);
  quotaPolicyTimers.delete(key);
  if (!request.enabledByUser || !request.quotaAware) return;

  const nextRunAt = Number(result.item?.nextRunAt);
  const nextRunDelay = Number.isFinite(nextRunAt) && nextRunAt > Date.now()
    ? Math.max(1_000, nextRunAt - Date.now() - 15_000)
    : 60_000;
  const resetDelay = result.quota?.state === "blocked"
    && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  const timer = setTimeout(async () => {
    if (quotaPolicyRecords.get(key)?.version !== version) return;
    try {
      await enqueueCurrentQuotaPolicy(key);
    } catch (error) {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      const current = quotaPolicyRecords.get(key);
      if (current?.version === version) {
        scheduleQuotaPolicyCheck(current, { quota: { state: "unknown" } });
      }
    }
  }, Math.min(nextRunDelay, resetDelay));
  timer.unref();
  quotaPolicyTimers.set(key, timer);
}

function enqueueQuotaPolicyMutation(record, rpc, { explicit = false } = {}) {
  const key = record.request.taskboardProjectId;
  const previous = quotaPolicyQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = quotaPolicyRecords.get(key);
      if (!current || current.version !== record.version) return { stale: true };
      const result = await applyTaskboardAutomationPolicy(
        current.request,
        rpc,
        () => quotaPolicyRecords.get(key)?.version === current.version,
        {
          explicit,
          previousQuotaState: current.quota?.state,
        },
      );
      if (result.stale) return result;
      if (!explicit && result.operation === "list" && result.item?.status === "PAUSED") {
        current.version += 1;
        current.request = { ...current.request, enabledByUser: false };
      }
      if (result.item?.id) {
        current.request = { ...current.request, automationId: result.item.id };
      }
      if (current.request.quotaAware && result.quota) current.quota = result.quota;
      else delete current.quota;
      await persistQuotaPolicies();
      scheduleQuotaPolicyCheck(current, result);
      return result;
    });
  const tracked = run.finally(() => {
    if (quotaPolicyQueues.get(key) === tracked) quotaPolicyQueues.delete(key);
  });
  quotaPolicyQueues.set(key, tracked);
  return tracked;
}

async function updateAndApplyQuotaPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const previous = quotaPolicyRecords.get(request.taskboardProjectId);
  const record = {
    version: (previous?.version ?? 0) + 1,
    request,
    ...(request.quotaAware && previous?.quota ? { quota: previous.quota } : {}),
  };
  quotaPolicyRecords.set(request.taskboardProjectId, record);
  try {
    await persistQuotaPolicies();
    const result = await enqueueQuotaPolicyMutation(record, rpc, { explicit: true });
    const current = quotaPolicyRecords.get(request.taskboardProjectId);
    return {
      ...result,
      policy: storedAutomationPolicy(current.request),
      ...(current.quota ? { quota: current.quota } : {}),
    };
  } catch (error) {
    if (quotaPolicyRecords.get(request.taskboardProjectId)?.version === record.version) {
      if (previous) quotaPolicyRecords.set(request.taskboardProjectId, previous);
      else quotaPolicyRecords.delete(request.taskboardProjectId);
      await persistQuotaPolicies();
    }
    throw error;
  }
}

async function reconcileStoredAutomationPolicy(request, rpc) {
  await ensureQuotaPoliciesLoaded();
  const projectId = request.taskboardProjectId;
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return null;
  if (
    record.request.codexProjectId !== request.codexProjectId
    || record.request.codexProjectKind !== request.codexProjectKind
    || record.request.codexHostId !== request.codexHostId
    || record.request.workspacePath !== request.workspacePath
    || JSON.stringify(record.request.remoteProjects ?? []) !== JSON.stringify(request.remoteProjects ?? [])
  ) {
    return updateAndApplyQuotaPolicy({
      ...request,
      automationId: record.request.automationId,
      enabledByUser: record.request.enabledByUser,
      quotaAware: record.request.quotaAware,
      intervalMinutes: record.request.intervalMinutes,
      model: record.request.model,
      reasoningEffort: record.request.reasoningEffort,
    }, rpc);
  }
  const result = await enqueueQuotaPolicyMutation(record, rpc);
  const current = quotaPolicyRecords.get(projectId);
  return {
    ...result,
    policy: storedAutomationPolicy(current.request),
    ...(current.quota ? { quota: current.quota } : {}),
  };
}

async function enqueueCurrentQuotaPolicy(projectId) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return { stale: true };
  return enqueueQuotaPolicyMutation(
    record,
    (method, body) => requestCodexAutomationViaCdp(
      currentQuotaPolicyCdp(),
      undefined,
      method,
      body,
    ),
  );
}

async function restoreQuotaPolicies(cdp) {
  registerQuotaPolicyCdp(cdp);
  if (restoredQuotaPolicyCdps.has(cdp)) return;
  const pending = quotaPolicyRestorePromises.get(cdp);
  if (pending) return pending;
  const restoring = (async () => {
    await ensureQuotaPoliciesLoaded();
    for (const [projectId, record] of quotaPolicyRecords) {
      if (record.request.enabledByUser && record.request.quotaAware) {
        await enqueueCurrentQuotaPolicy(projectId);
      }
    }
    restoredQuotaPolicyCdps.add(cdp);
  })();
  quotaPolicyRestorePromises.set(cdp, restoring);
  try {
    await restoring;
  } finally {
    quotaPolicyRestorePromises.delete(cdp);
  }
}

async function startTaskConversationViaCdp(cdp, executionContextId, request) {
  const {
    codexHostId,
    instruction,
    previousThreadId,
    projectless,
    targetRoot,
    title,
  } = request;
  const normalizeWorkspaceRoot = (value) => {
    const root = String(value || "").trim();
    if (!root) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(root) || root.includes("\\");
    const normalizedSlashes = windowsPath ? root.replace(/\\/g, "/") : root;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  };
  const normalizedTargetRoot = normalizeWorkspaceRoot(targetRoot);
  const deadline = Date.now() + 8_000;
  let submitted = false;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const root = Array.from(document.querySelectorAll(
          '[data-codex-composer-root][data-composer-placement="home"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const conversationId = root
          ?.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id')
          ?.trim() || "";
        const editor = Array.from(root?.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        ) || []).find((candidate) => candidate.getClientRects().length > 0);
        if (
          !root
          || conversationId
          || !editor
          || (editor.innerText || "") !== ${JSON.stringify(instruction)}
        ) return false;
        editor.focus();
        return true;
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (prepared.result.value !== true) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    submitted = true;
    break;
  }
  if (!submitted) throw new Error("Codex new conversation composer did not become ready");

  const threadDeadline = Date.now() + 12_000;
  let discoveredThreadId = "";
  try {
    while (Date.now() < threadDeadline) {
      const started = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const root = Array.from(document.querySelectorAll(
            '[data-codex-composer-root][data-composer-placement="thread"]'
          )).find((candidate) => candidate.getClientRects().length > 0);
          const threadId = root
            ?.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id')
            ?.trim() || "";
          return threadId.replace(/^(?:local|cloud):/i, "");
        })()`,
        contextId: executionContextId,
        returnByValue: true,
      });
      const threadId = typeof started.result.value === "string" ? started.result.value : "";
      if (threadId && threadId !== previousThreadId) {
        discoveredThreadId = threadId;
        const readyDeadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < readyDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (
              result?.thread?.id === threadId
              && (
                projectless
                || normalizeWorkspaceRoot(result.thread.cwd) === normalizedTargetRoot
              )
            ) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (!ready) {
          throw new Error(projectless
            ? "Codex did not confirm the projectless task conversation"
            : "Codex did not confirm the task conversation workspace root");
        }

        try {
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message.toLowerCase()
            : String(error).toLowerCase();
          if (!message.includes("rollout") || !message.includes("is empty")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await requestCodexAppServerViaCdp(
            cdp,
            executionContextId,
            codexHostId,
            "thread/name/set",
            { threadId, name: title },
            10_000,
          );
        }

        const titleDeadline = Date.now() + 10_000;
        while (Date.now() < titleDeadline) {
          try {
            const result = await requestCodexAppServerViaCdp(
              cdp,
              executionContextId,
              codexHostId,
              "thread/read",
              { threadId, includeTurns: false },
              10_000,
            );
            if (result?.thread?.id === threadId && result.thread.name === title) {
              return { threadId, title };
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error("Codex did not confirm the task conversation title");
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error("Timed out while starting the Codex conversation");
  } catch (error) {
    if (error && typeof error === "object") {
      if (discoveredThreadId) error.threadId = discoveredThreadId;
      else if (submitted) error.uncertain = true;
    }
    throw error;
  }
}

function getOrStartTaskConversation(cdp, executionContextId, request) {
  const existing = taskConversationOperations.get(request.taskId);
  if (existing) return existing.promise;

  const operation = { promise: null };
  const promise = Promise.resolve().then(() => (
    startTaskConversationViaCdp(cdp, executionContextId, request)
  ));
  operation.promise = promise;
  taskConversationOperations.set(request.taskId, operation);
  const clearSettledOperation = () => {
    if (taskConversationOperations.get(request.taskId) === operation) {
      taskConversationOperations.delete(request.taskId);
    }
  };
  const retainCreatedOrUncertainFailure = (error) => {
    if (!(
      error
      && typeof error === "object"
      && (typeof error.threadId === "string" || error.uncertain === true)
    )) {
      clearSettledOperation();
      return;
    }
    const timer = setTimeout(() => {
      clearSettledOperation();
    }, taskConversationFailureTtlMs);
    timer.unref?.();
  };
  void promise.then(clearSettledOperation, retainCreatedOrUncertainFailure);
  return promise;
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.postMessage({
      type: ${JSON.stringify(hostResponseMessage)},
      capability: ${JSON.stringify(hostCapability)},
      response: ${JSON.stringify(response)}
    }, window.location.origin)`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

async function readTaskboardClientStorageEntries() {
  const response = await fetch(`${taskboardBaseUrl}/api/client-storage`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Taskboard client storage returned HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.entries && typeof payload.entries === "object" ? payload.entries : {};
}

async function listResidentCoordinatorMonitorProjects() {
  const pathname = "/api/local/coordinator-monitor-projects";
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    headers: coordinatorRenewProofHeaders(pathname, null, "GET"),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Taskboard Coordinator monitor projects returned HTTP ${response.status}`);
  }
  const result = await response.json();
  if (!Array.isArray(result?.projectIds)) {
    throw new Error("Taskboard returned invalid Coordinator monitor projects");
  }
  return result.projectIds;
}

async function readTaskboardAgentLaneSnapshot(projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/agent-lanes`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Taskboard Agent Lanes returned HTTP ${response.status}`);
  return response.json();
}

async function readLaunchCoordinatorRoute() {
  const entries = await readTaskboardClientStorageEntries();
  const projectIds = Object.entries(entries)
    .filter(([key, value]) => key.startsWith(backgroundContinuationPolicyPrefix) && value === "enabled")
    .map(([key]) => key.slice(backgroundContinuationPolicyPrefix.length))
    .filter(Boolean)
    .sort();
  const snapshots = [];
  for (const projectId of projectIds) {
    snapshots.push(await readTaskboardAgentLaneSnapshot(projectId));
  }
  return selectLaunchCoordinatorRoute(snapshots);
}

async function coordinatorThreadIsSelected(cdp, threadId) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const normalize = (value) => String(value || "").trim().replace(/^(?:local|cloud):/i, "");
      const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
      const active = rows.find((row) => (
        row.getAttribute("data-app-action-sidebar-thread-active") === "true"
        || ["page", "true"].includes(row.getAttribute("aria-current"))
      ));
      const routeThreadId = window.location.pathname.match(
        /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
      )?.[1];
      return {
        activeThreadId: normalize(active?.getAttribute("data-app-action-sidebar-thread-id")) || null,
        routeThreadId: normalize(routeThreadId) || null,
      };
    })()`,
    returnByValue: true,
  });
  const selection = evaluation.result.value;
  return selection?.activeThreadId === threadId && coordinatorThreadSelectionConfirmed({
    expectedThreadId: threadId,
    ...selection,
  });
}

async function requestCoordinatorThreadSelection(cdp, threadId) {
  const navigation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const expected = ${JSON.stringify(threadId)};
      const taskboard = window.__codexTaskboardInjection__;
      if (typeof taskboard?.selectNativeThread !== "function") return false;
      if (
        document.documentElement.hasAttribute("data-codex-taskboard-open")
        && typeof taskboard.close === "function"
      ) {
        taskboard.close(false);
      }
      return taskboard.selectNativeThread(expected) === true;
    })()`,
    returnByValue: true,
  });
  return navigation.result.value === true;
}

async function waitForCoordinatorThreadSelection(
  cdp,
  threadId,
  timeoutMs = 90_000,
  stabilityMs = 35_000,
  pollMs = 100,
  renavigationIntervalMs = 5_000,
  isCurrent = () => true,
) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  let navigationRequired = true;
  let nextNavigationAt = 0;
  while (Date.now() < deadline) {
    if (cdp.closed || !isCurrent()) return false;
    if (navigationRequired && Date.now() >= nextNavigationAt) {
      if (!(await requestCoordinatorThreadSelection(cdp, threadId))) return false;
      if (!isCurrent()) return false;
      navigationRequired = false;
      nextNavigationAt = Date.now() + renavigationIntervalMs;
    }
    try {
      const selected = await coordinatorThreadIsSelected(cdp, threadId);
      if (!isCurrent()) return false;
      if (selected) {
        const observedAt = Date.now();
        navigationRequired = false;
        if (stableSince === null) stableSince = observedAt;
        if (observedAt - stableSince >= stabilityMs) return true;
      } else if (stableSince !== null) {
        stableSince = null;
        navigationRequired = true;
      }
    } catch (_) {
      stableSince = null;
      navigationRequired = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (!isCurrent()) return false;
  }
  return false;
}

async function requestInjectedTaskboardOpen(cdp) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const taskboard = window.__codexTaskboardInjection__;
      if (typeof taskboard?.open !== "function") return false;
      taskboard.open();
      return true;
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value === true;
}

async function prepareInjectedNativeOpen(cdp, threadId) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const taskboard = window.__codexTaskboardInjection__;
      if (typeof taskboard?.prepareNativeThreadOpen !== "function") return null;
      return await taskboard.prepareNativeThreadOpen(${JSON.stringify(threadId)});
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return typeof evaluation.result.value === "string" && evaluation.result.value
    ? evaluation.result.value
    : null;
}

async function commitInjectedNativeOpen(cdp, token) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const taskboard = window.__codexTaskboardInjection__;
      if (typeof taskboard?.commitPreparedNativeOpen !== "function") return false;
      return taskboard.commitPreparedNativeOpen(${JSON.stringify(token)}) === true;
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value === true;
}

async function requestPreparedTaskboardOpen(
  cdp,
  threadId,
  generation,
  currentGeneration,
) {
  if (generation !== currentGeneration()) return false;
  const token = await prepareInjectedNativeOpen(cdp, threadId);
  if (!token || generation !== currentGeneration()) return false;
  return commitInjectedNativeOpen(cdp, token);
}

async function completeSuccessfulTaskboardOpen({
  markOpened,
  bringToFront,
  activate,
  report = (message) => console.error(message),
}) {
  markOpened();
  try {
    await bringToFront();
  } catch (error) {
    report(`Taskboard opened; foreground request was unavailable: ${error.message}`);
  }
  try {
    activate();
  } catch (error) {
    report(`Taskboard opened; app activation was unavailable: ${error.message}`);
  }
  return true;
}

async function renewCoordinatorLease(request) {
  const suffix = request.scope === "domain"
    ? `/domain-coordinator-leases/${encodeURIComponent(request.domainId)}/renew`
    : "/coordinator-lease/renew";
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}${suffix}`;
  const body = {
    holderTaskId: request.holderTaskId,
    holderThreadId: request.holderThreadId,
    holderCodexHostId: request.codexHostId,
    holderWorkspacePath: request.workspacePath,
    expectedLeaseId: request.expectedLeaseId,
    leaseDurationSeconds: request.leaseDurationSeconds,
  };
  const response = await fetch(
    `${taskboardBaseUrl}${pathname}`,
    {
      method: "POST",
      headers: coordinatorRenewProofHeaders(pathname, body),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`Taskboard coordinator lease renewal returned HTTP ${response.status}`);
  return response.json();
}

async function recoverCoordinatorLease(request) {
  const suffix = request.scope === "domain"
    ? `/domain-coordinator-leases/${encodeURIComponent(request.domainId)}/recover`
    : "/coordinator-lease/recover";
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}${suffix}`;
  const body = {
    holderTaskId: request.holderTaskId,
    holderThreadId: request.holderThreadId,
    holderCodexHostId: request.codexHostId,
    holderWorkspacePath: request.workspacePath,
    expectedLeaseId: request.expectedLeaseId,
    leaseDurationSeconds: request.leaseDurationSeconds,
  };
  const response = await fetch(
    `${taskboardBaseUrl}${pathname}`,
    {
      method: "POST",
      headers: coordinatorRenewProofHeaders(pathname, body),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`Taskboard coordinator lease recovery returned HTTP ${response.status}`);
  return response.json();
}

function coordinatorRenewProofHeaders(pathname, body, method = "POST") {
  const nonce = randomBytes(32).toString("hex");
  const issuedAt = String(Date.now());
  return {
    "content-type": "application/json",
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-issued-at": issuedAt,
    "x-codex-taskboard-injector-proof": createHmac("sha256", taskboardInstanceSecret)
      .update(JSON.stringify({ nonce, issuedAt, method, pathname, body }))
      .digest("hex"),
  };
}

async function listCoordinatorIdentityHandshakes(projectId) {
  const pathname = `/api/local/projects/${encodeURIComponent(projectId)}/coordination-identity-handshakes`;
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    headers: coordinatorRenewProofHeaders(pathname, null, "GET"),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Taskboard identity handshakes returned HTTP ${response.status}`);
  return response.json();
}

async function readCoordinatorProvisioningWindows(projectId) {
  const pathname = `/api/local/projects/${encodeURIComponent(projectId)}/coordination-windows`;
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    headers: { "x-taskboard-client": "taskctl" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Taskboard coordination windows returned HTTP ${response.status}`);
  return response.json();
}

async function readCoordinatorProvisioningPreflight(projectId) {
  const pathname = `/api/local/projects/${encodeURIComponent(projectId)}/coordinator-provisioning-preflight`;
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    headers: coordinatorRenewProofHeaders(pathname, null, "GET"),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Taskboard Coordinator provisioning preflight returned HTTP ${response.status}`);
  }
  return response.json();
}

async function mutateCoordinatorProvisioning(pathname, body) {
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    method: "POST",
    headers: coordinatorRenewProofHeaders(pathname, body),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Taskboard Coordinator provisioning returned HTTP ${response.status}`);
  return response.json();
}

async function requestCoordinatorProvisioningAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/coordinator-provisioning-attempts`;
  const { projectId: _projectId, ...body } = request;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function getCoordinatorProvisioningAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/coordinator-provisioning-attempts/lookup`;
  return mutateCoordinatorProvisioning(pathname, request.idempotencyKey
    ? { idempotencyKey: request.idempotencyKey }
    : {});
}

async function requestDomainCoordinatorProvisioningAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/domain-coordinator-provisioning-attempts/${encodeURIComponent(request.domainId)}`;
  const { projectId: _projectId, domainId: _domainId, ...body } = request;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function getDomainCoordinatorProvisioningAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/domain-coordinator-provisioning-attempts/${encodeURIComponent(request.domainId)}/lookup`;
  return mutateCoordinatorProvisioning(pathname, request.idempotencyKey
    ? { idempotencyKey: request.idempotencyKey }
    : {});
}

async function getCoordinatorShutdownAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/coordinator-shutdown-attempts/lookup`;
  return mutateCoordinatorProvisioning(pathname, {});
}

async function requestCoordinatorShutdownAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/coordinator-shutdown-attempts`;
  const { projectId: _projectId, ...body } = request;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function transitionCoordinatorShutdownAttempt(attemptId, action) {
  const pathname = `/api/local/coordinator-shutdown-attempts/${encodeURIComponent(attemptId)}/${action}`;
  return mutateCoordinatorProvisioning(pathname, {});
}

async function getDomainCoordinatorShutdownAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/domain-coordinator-shutdown-attempts/${encodeURIComponent(request.domainId)}/lookup`;
  return mutateCoordinatorProvisioning(pathname, {});
}

async function requestDomainCoordinatorShutdownAttempt(request) {
  const pathname = `/api/local/projects/${encodeURIComponent(request.projectId)}/domain-coordinator-shutdown-attempts/${encodeURIComponent(request.domainId)}`;
  const {
    projectId: _projectId, domainId: _domainId, fingerprint: _fingerprint, ...body
  } = request;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function transitionDomainCoordinatorShutdownAttempt(attemptId, action) {
  const pathname = `/api/local/domain-coordinator-shutdown-attempts/${encodeURIComponent(attemptId)}/${action}`;
  return mutateCoordinatorProvisioning(pathname, {});
}

async function findArchivedCoordinatorThread(cdp, attempt) {
  const result = await requestCodexAppServerViaCdp(
    cdp,
    undefined,
    attempt.codexHostId,
    "thread/list",
    { cwd: attempt.workspacePath, archived: true, limit: 100 },
    10_000,
  );
  const matches = (Array.isArray(result?.data) ? result.data : []).filter((thread) => (
    thread?.id === attempt.holderThreadId
    && typeof thread.cwd === "string"
    && path.resolve(thread.cwd) === path.resolve(attempt.workspacePath)
  ));
  if (matches.length > 1) throw new Error("Codex returned duplicate archived Coordinator threads");
  return matches[0] ?? null;
}

async function listCoordinatorWindowThread(cdp, window, archived) {
  let cursor = null;
  const matches = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await requestCodexAppServerViaCdp(
      cdp,
      undefined,
      window.codexHostId,
      "thread/list",
      {
        cwd: window.workspacePath,
        archived,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
      10_000,
    );
    for (const thread of coordinatorProvisioningThreadListData(result)) {
      if (thread?.id === window.threadId) matches.push(thread);
    }
    cursor = typeof result?.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : null;
    if (!cursor) return matches;
  }
  throw new Error("Codex Coordinator window inspection exceeded the bounded thread list");
}

async function inspectCoordinatorProvisioningWindow(cdp, window) {
  const protectedWindow = window?.role === "coordinator"
    && typeof window.taskId === "string" && window.taskId
    && typeof window.label === "string" && window.label
    && typeof window.threadId === "string" && window.threadId
    && typeof window.codexProjectId === "string" && window.codexProjectId
    && new Set(["local", "remote"]).has(window.codexProjectKind)
    && typeof window.codexHostId === "string" && window.codexHostId
    && typeof window.workspacePath === "string" && path.isAbsolute(window.workspacePath)
    && ((window.codexProjectKind === "local" && window.codexHostId === "local")
      || (window.codexProjectKind === "remote" && window.codexHostId !== "local"));
  if (!protectedWindow) return { eligibility: "uncertain", reason: "binding-invalid", window };
  let thread = null;
  try {
    thread = (await requestCodexAppServerViaCdp(
      cdp, undefined, window.codexHostId, "thread/read",
      { threadId: window.threadId, includeTurns: true }, 10_000,
    ))?.thread ?? null;
  } catch {}
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (thread?.id === window.threadId
    && turns.some((turn) => turn?.status === "inProgress")) {
    return { eligibility: "eligible", busy: true, reason: "active-turn", window };
  }
  try {
    const active = await listCoordinatorWindowThread(cdp, window, false);
    const activeInspection = classifyCoordinatorProvisioningActiveThread({
      window, thread, activeThreads: active,
    });
    if (activeInspection) return activeInspection;
    const archived = await listCoordinatorWindowThread(cdp, window, true);
    if (archived.length > 1) {
      return { eligibility: "uncertain", reason: "duplicate-archived-thread", window };
    }
    if (archived.length === 1) {
      return { eligibility: "stale", reason: "archived", window };
    }
    return thread?.id === window.threadId
      ? { eligibility: "stale", reason: "inactive-or-drifted", window }
      : { eligibility: "stale", reason: "missing", window };
  } catch {
    return { eligibility: "uncertain", reason: "host-unavailable", window };
  }
}

async function transitionCoordinatorProvisioningAttempt(attemptId, action, body = {}) {
  const pathname = `/api/local/coordinator-provisioning-attempts/${encodeURIComponent(attemptId)}/${action}`;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function transitionDomainCoordinatorProvisioningAttempt(attemptId, action, body = {}) {
  const pathname = `/api/local/domain-coordinator-provisioning-attempts/${encodeURIComponent(attemptId)}/${action}`;
  return mutateCoordinatorProvisioning(pathname, body);
}

async function findCoordinatorProvisioningThread(cdp, attempt, archived = false) {
  return findCoordinatorProvisioningThreadAcrossPages({
    attempt,
    archived,
    listPage: (params) => requestCodexAppServerViaCdp(
      cdp,
      undefined,
      attempt.codexHostId,
      "thread/list",
      params,
      10_000,
    ),
  });
}

async function readDefaultCoordinatorModel(cdp, route) {
  const models = await readCoordinatorModelCatalog(cdp, route.codexHostId);
  const defaults = models.filter(
    (model) => model?.isDefault === true,
  );
  if (defaults.length !== 1
    || typeof defaults[0].id !== "string" || !defaults[0].id
    || typeof defaults[0].defaultReasoningEffort !== "string"
    || !defaults[0].defaultReasoningEffort) {
    throw new Error("Codex did not return one exact default model for Coordinator provisioning");
  }
  return {
    model: defaults[0].id,
    reasoningEffort: defaults[0].defaultReasoningEffort,
  };
}

async function readCoordinatorModelCatalog(cdp, codexHostId) {
  const result = await requestCodexAppServerViaCdp(
    cdp, undefined, codexHostId, "model/list", { includeHidden: false, limit: 100 }, 10_000,
  );
  if (!Array.isArray(result?.data)) {
    throw new Error("Codex did not return one exact model catalog for Coordinator provisioning");
  }
  return result.data;
}

async function deliverCoordinatorProvisioningInstruction(cdp, attempt, threadId, projectId) {
  const rpc = (method, params) => requestCodexAppServerViaCdp(
    cdp, undefined, attempt.codexHostId, method, params, 10_000,
  );
  const thread = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId,
    readThread: (includeTurns) => rpc("thread/read", { threadId, includeTurns }),
  });
  const marker = `TASKBOARD_COORDINATOR_PROVISIONING_V1:${attempt.id}`;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const priorDelivery = classifyCoordinatorProvisioningDeliveryTurns(turns, marker);
  if (priorDelivery.delivery !== "retry") return priorDelivery;
  const retryPlan = planCoordinatorProvisioningDeliveryRetry(turns, marker, {
    defaultModel: attempt.model,
    defaultReasoningEffort: attempt.reasoningEffort,
  });
  if (retryPlan.retryAfterMs > 0) {
    return {
      delivery: "deferred",
      reason: "retry-backoff",
      retryAfterMs: retryPlan.retryAfterMs,
    };
  }
  let selectedModel = {
    model: retryPlan.currentModel,
    reasoningEffort: retryPlan.currentReasoningEffort,
  };
  if (retryPlan.failureKind === "model-unsupported") {
    selectedModel = selectCoordinatorProvisioningFallbackModel(
      await readCoordinatorModelCatalog(cdp, attempt.codexHostId),
      retryPlan.unsupportedModels,
      retryPlan.currentReasoningEffort,
    );
    if (!selectedModel) {
      return { delivery: "deferred", reason: "model-fallback-unavailable" };
    }
  }
  await resumeCoordinatorProvisioningDeliveryThread(
    thread,
    () => rpc("thread/resume", { threadId }),
  );
  const turnStartParams = buildCoordinatorProvisioningDeliveryTurnStartParams({
    attempt,
    threadId,
    projectId,
    taskctlPath: path.join(projectRoot, "cli", "taskctl.mjs"),
    runtimeFile: taskboardRuntimeFile,
    selectedModel,
    workspacePath: attempt.workspacePath,
  });
  const started = await rpc(
    "turn/start",
    turnStartParams,
  );
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a provisioning delivery turn receipt");
  }
  return { delivery: "started", turnId: started.turn.id, model: selectedModel.model };
}

async function deliverDomainCoordinatorProvisioningInstruction(
  cdp, attempt, threadId, projectId, domainId,
) {
  const rpc = (method, params) => requestCodexAppServerViaCdp(
    cdp, undefined, attempt.codexHostId, method, params, 10_000,
  );
  const marker = `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${attempt.id}`;
  const thread = await readCoordinatorProvisioningDeliveryThread({
    attempt,
    threadId,
    marker,
    readThread: (includeTurns) => rpc("thread/read", { threadId, includeTurns }),
  });
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const priorDelivery = classifyCoordinatorProvisioningDeliveryTurns(
    turns, marker, { completedIsSuccess: false },
  );
  if (priorDelivery.delivery !== "retry") return priorDelivery;
  const retryPlan = planCoordinatorProvisioningDeliveryRetry(turns, marker, {
    defaultModel: attempt.model,
    defaultReasoningEffort: attempt.reasoningEffort,
    retryCompleted: true,
  });
  if (retryPlan.retryAfterMs > 0) {
    return {
      delivery: "deferred",
      reason: "retry-backoff",
      retryAfterMs: retryPlan.retryAfterMs,
    };
  }
  let selectedModel = {
    model: retryPlan.currentModel,
    reasoningEffort: retryPlan.currentReasoningEffort,
  };
  if (retryPlan.failureKind === "model-unsupported") {
    selectedModel = selectCoordinatorProvisioningFallbackModel(
      await readCoordinatorModelCatalog(cdp, attempt.codexHostId),
      retryPlan.unsupportedModels,
      retryPlan.currentReasoningEffort,
    );
    if (!selectedModel) {
      return { delivery: "deferred", reason: "model-fallback-unavailable" };
    }
  }
  await resumeCoordinatorProvisioningDeliveryThread(
    thread,
    () => rpc("thread/resume", { threadId }),
  );
  const registrationKey = `${attempt.idempotencyKey}-window`;
  const instruction = [
    marker,
    `TASKBOARD_COORDINATOR_DELIVERY_MODEL_V1:${selectedModel.model}`,
    `TASKBOARD_COORDINATOR_DELIVERY_EFFORT_V1:${selectedModel.reasoningEffort}`,
    `You are the Taskboard Domain Coordinator for ${JSON.stringify(domainId)}. Never become or alter Owner Root or the Global Coordinator.`,
    `Use only node ${path.join(projectRoot, "cli", "taskctl.mjs")} --runtime-file ${taskboardRuntimeFile} for Taskboard reads and writes; never read or expose the runtime token and never edit SQLite directly.`,
    `Register exactly this protected window with task identity ${attempt.taskId}, role coordinator, label ${JSON.stringify(attempt.label)}, exact thread id ${threadId}, and stable idempotency key ${registrationKey}.`,
    "First read protected coordination windows and use their exact current revision. Allow the resident protected host handshake to authenticate the exact project, kind, host, and workspace; do not self-report or bypass host identity.",
    `After exact registration, read domain-coordinator status for project ${projectId} and domain ${domainId}. Acquire one 300-second lease only for that domain if still unassigned, using this same task/thread and the exact expected current lease id (or null). Never acquire the Global lease or another domain lease.`,
    "Replay the same registration after success to verify one receipt; never create a second window, attempt, or lease. Bootstrap the routed Todo before execution, stay inside the domain write scope, and preserve one writer.",
    "On selected-model capacity, retry the same task and thread with the same model. A host-confirmed unsupported model may be replaced while preserving this exact task, thread, and Domain Coordinator identity. On uncertainty, inspect durable state before retrying.",
  ].join("\n");
  const started = await rpc(
    "turn/start",
    coordinatorProvisioningTurnStartParams(
      threadId, instruction, selectedModel, attempt.workspacePath,
    ),
  );
  if (typeof started?.turn?.id !== "string" || !started.turn.id) {
    throw new Error("Codex did not return a Domain Coordinator provisioning delivery receipt");
  }
  return { delivery: "started", turnId: started.turn.id, model: selectedModel.model };
}

async function confirmCoordinatorIdentityHandshake(handshakeId, registration, threadBinding) {
  const pathname = `/api/local/coordination-identity-handshakes/${encodeURIComponent(handshakeId)}/confirm`;
  const body = { registration, threadBinding };
  const response = await fetch(`${taskboardBaseUrl}${pathname}`, {
    method: "POST",
    headers: coordinatorRenewProofHeaders(pathname, body),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Taskboard identity handshake confirmation returned HTTP ${response.status}`);
  return response.json();
}

function injectorProofHeaders() {
  const nonce = randomBytes(32).toString("hex");
  return {
    "content-type": "application/json",
    "x-codex-taskboard-injector-nonce": nonce,
    "x-codex-taskboard-injector-proof": createHmac("sha256", taskboardInstanceSecret)
      .update(nonce)
      .digest("hex"),
  };
}

async function claimOwnerDecisionDelivery(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-decision-delivery/claim`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { claimed: false, reason: "stale-route" };
  if (!response.ok) throw new Error(`Taskboard Owner decision reservation returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.claimed === false && typeof result.reason === "string") return result;
  if (result?.claimed !== true
    || typeof result?.receipt?.id !== "string") {
    throw new Error("Taskboard returned an invalid Owner decision reservation receipt");
  }
  return result;
}

async function confirmOwnerDecisionDelivery(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-decision-delivery/confirm`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { confirmed: false };
  if (!response.ok) throw new Error(`Taskboard Owner decision confirmation returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.confirmed !== true || result.deliveryId !== request.deliveryId) {
    throw new Error("Taskboard returned an invalid Owner decision confirmation receipt");
  }
  return result;
}

async function claimCrossDomainHandoffDelivery(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/cross-domain-handoff-delivery/claim`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { claimed: false, reason: "stale-route" };
  if (!response.ok) throw new Error(`Taskboard cross-domain handoff reservation returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.claimed === false && typeof result.reason === "string" && typeof result?.receipt?.id === "string") {
    return result;
  }
  if (result?.claimed !== true || typeof result?.receipt?.id !== "string") {
    throw new Error("Taskboard returned an invalid cross-domain handoff reservation receipt");
  }
  return result;
}

async function confirmCrossDomainHandoffDelivery(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/cross-domain-handoff-delivery/confirm`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { confirmed: false };
  if (!response.ok) throw new Error(`Taskboard cross-domain handoff confirmation returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.confirmed !== true || result.deliveryId !== request.deliveryId) {
    throw new Error("Taskboard returned an invalid cross-domain handoff confirmation receipt");
  }
  return result;
}

async function recordOwnerDecision(request) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/tasks/${encodeURIComponent(request.taskId)}/owner-decisions`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify({
        requestId: request.requestId,
        expectedResumeToken: request.expectedResumeToken,
        outcome: request.outcome,
        ownerTurnId: request.ownerTurnId,
        rootDecisionTurnId: request.rootDecisionTurnId,
        rootThreadId: request.rootThreadId,
        evidence: request.evidence,
        deliveryId: request.deliveryId,
        receipt: `owner-decision:${request.deliveryId}:${request.rootDecisionTurnId}`,
        decidedAt: new Date().toISOString(),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`Taskboard Owner decision receipt returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.applied !== "boolean") {
    throw new Error("Taskboard returned an invalid Owner decision receipt");
  }
  return result;
}

async function claimOwnerIntentAdoption(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents/${encodeURIComponent(request.intentId)}/adoption/claim`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify({
        coordinatorTaskId: request.route.coordinatorTaskId,
        coordinatorThreadId: request.route.coordinatorThreadId,
        coordinatorEpoch: request.coordinatorEpoch,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { claimed: false, reason: "stale-route" };
  if (!response.ok) throw new Error(`Taskboard Owner Intent reservation returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.claimed !== "boolean"
    || typeof result?.receipt?.id !== "string"
    || result?.executionIntent?.intentId !== request.intentId
    || !Number.isInteger(result.executionIntent.version)
    || result.executionIntent.version < 1
    || typeof result.executionIntent.goal !== "string"
    || !result.executionIntent.goal.trim()
    || !Array.isArray(result.executionIntent.constraints)
    || result.executionIntent.constraints.some((item) => typeof item !== "string")) {
    throw new Error("Taskboard returned an invalid Owner Intent adoption receipt");
  }
  return result;
}

async function listOwnerIntents(projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents`,
    { cache: "no-store", signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new Error(`Taskboard Owner Intent frontier returned HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result?.intents)) {
    throw new Error("Taskboard returned an invalid Owner Intent frontier");
  }
  return result.intents;
}

async function recordOwnerIntentCapture(request, projectId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) {
    const result = await response.json().catch(() => null);
    if (["HOST_IDENTITY_UNAVAILABLE", "OWNER_ROOT_ROUTE_STALE"].includes(result?.error?.code)) {
      return { applied: false, reason: "owner-root-host-unavailable" };
    }
  }
  if (!response.ok) throw new Error(`Taskboard Owner Intent capture returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.applied !== "boolean" || typeof result?.intent?.intentId !== "string") {
    throw new Error("Taskboard returned an invalid Owner Intent capture receipt");
  }
  return result;
}

async function confirmOwnerIntentAdoption(request, projectId, intentId) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents/${encodeURIComponent(intentId)}/adoption/confirm`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { confirmed: false, reason: "stale-route" };
  if (!response.ok) throw new Error(`Taskboard Owner Intent confirmation returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.confirmed !== "boolean" || result?.receipt?.id !== request.adoptionId) {
    throw new Error("Taskboard returned an invalid Owner Intent confirmation receipt");
  }
  return result;
}

async function applyOwnerIntentPlan(request, plan, projectId) {
  const {
    intentId: markerIntentId,
    adoptionId: markerAdoptionId,
    coordinatorEpoch: markerCoordinatorEpoch,
    ...serverPlan
  } = plan;
  if (markerIntentId !== request.intentId
    || markerAdoptionId !== request.adoptionReceipt.id
    || markerCoordinatorEpoch !== request.adoptionReceipt.coordinatorEpoch) {
    return { applied: false, reason: "stale-plan-marker" };
  }
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents/${encodeURIComponent(request.intentId)}/plan-revisions`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify({
        ...serverPlan,
        intentVersion: request.version,
        adoptionId: request.adoptionReceipt.id,
        coordinatorTaskId: request.route.coordinatorTaskId,
        coordinatorThreadId: request.route.coordinatorThreadId,
        coordinatorEpoch: request.adoptionReceipt.coordinatorEpoch,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 400) return {
    applied: false,
    reason: classifyOwnerIntentPlanHttpFailure(response.status),
  };
  if (response.status === 409) {
    const payload = await response.json().catch(() => null);
    return {
      applied: false,
      reason: classifyOwnerIntentPlanHttpFailure(response.status, payload?.error?.code),
    };
  }
  if (!response.ok) throw new Error(`Taskboard Owner Intent plan returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.applied !== "boolean" || result?.revision?.id !== plan.revisionId) {
    throw new Error("Taskboard returned an invalid Owner Intent plan receipt");
  }
  return result;
}

async function scheduleOwnerIntentPlanRetry(request, failure, projectId) {
  const failureKey = createHash("sha256").update(JSON.stringify({
    adoptionId: request.adoptionReceipt.id,
    reason: failure.reason,
    revisionId: failure.revisionId ?? null,
  })).digest("hex");
  const response = await fetch(
    `${taskboardBaseUrl}/api/local/projects/${encodeURIComponent(projectId)}/owner-intents/${encodeURIComponent(request.intentId)}/plan-retry`,
    {
      method: "POST",
      headers: injectorProofHeaders(),
      body: JSON.stringify({
        adoptionId: request.adoptionReceipt.id,
        coordinatorEpoch: request.adoptionReceipt.coordinatorEpoch,
        failureKey,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return { applied: false, reason: "stale-plan-retry" };
  if (!response.ok) throw new Error(`Taskboard Owner Intent plan retry returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result?.applied !== "boolean" || typeof result?.exhausted !== "boolean") {
    throw new Error("Taskboard returned an invalid Owner Intent plan retry receipt");
  }
  return result;
}

async function claimBackgroundContinuationReceipt(claim) {
  const reservationLeaseId = randomUUID();
  const response = await fetch(
    `${taskboardBaseUrl}/api/tasks/${encodeURIComponent(claim.todoId)}/bootstrap-claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootThreadId: claim.rootThreadId,
        expectedResumeToken: claim.expectedResumeToken,
        safeActionId: claim.safeActionId,
        reservationLeaseId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return false;
  if (!response.ok) {
    throw new Error(`Taskboard bootstrap reservation returned HTTP ${response.status}`);
  }
  const result = await response.json();
  const recovering = result?.recovering === true;
  if (
    result?.receipt?.taskId !== claim.taskId
    || result.receipt.safeActionId !== claim.safeActionId
    || typeof result.receipt.admissionAttemptId !== "string"
    || !result.receipt.admissionAttemptId
    || typeof result.reused !== "boolean"
    || typeof result.available !== "boolean"
    || typeof result.completed !== "boolean"
    || (!recovering && result.receipt.rootThreadId !== claim.rootThreadId)
    || (!recovering && result.receipt.resumeToken !== claim.expectedResumeToken)
    || (!recovering && result.available === true && result.receipt.reservationLeaseId !== reservationLeaseId)
    || (recovering && result.available === true && (
      result.recoveryLeaseId !== reservationLeaseId
      || result.recoveryRoute?.rootThreadId !== result.receipt.rootThreadId
      || result.recoveryRoute?.codexHostId !== result.receipt.rootHostId
      || result.recoveryRoute?.rootWorkspacePath !== result.receipt.rootWorkspacePath
      || result.recoveryRoute?.worktreePath !== result.receipt.worktreePath
      || result.recoveryRoute?.branch !== result.receipt.worktreeBranch
      || result.executionIdentity?.worktreePath !== result.receipt.worktreePath
      || result.executionIdentity?.branch !== result.receipt.worktreeBranch
    ))
  ) {
    throw new Error("Taskboard returned an invalid bootstrap reservation receipt");
  }
  return result;
}

async function confirmBackgroundContinuationDelivery(claim) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/tasks/${encodeURIComponent(claim.todoId)}/bootstrap-delivery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootThreadId: claim.rootThreadId,
        expectedResumeToken: claim.expectedResumeToken,
        safeActionId: claim.safeActionId,
        reservationLeaseId: claim.deliveryReceipt.reservationLeaseId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`Taskboard bootstrap delivery returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.confirmed !== true
    || result?.receipt?.taskId !== claim.taskId
    || result.receipt.rootThreadId !== claim.rootThreadId
    || result.receipt.resumeToken !== claim.expectedResumeToken
    || result.receipt.safeActionId !== claim.safeActionId) {
    throw new Error("Taskboard returned an invalid bootstrap delivery receipt");
  }
  return result.executionIdentity;
}

async function completeBackgroundContinuationDelivery(claim, delivery) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/tasks/${encodeURIComponent(claim.todoId)}/bootstrap-complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootThreadId: claim.rootThreadId,
        expectedResumeToken: claim.expectedResumeToken,
        safeActionId: claim.safeActionId,
        reservationLeaseId: claim.deliveryReceipt.reservationLeaseId,
        recoveryLeaseId: claim.recoveryLeaseId,
        deliveryTurnId: delivery?.turnId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`Taskboard bootstrap completion returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.completed !== true && result?.awaitingAdmission !== true) {
    throw new Error("Taskboard did not return an admission-aware bootstrap completion receipt");
  }
  if (
    result?.receipt?.taskId !== claim.taskId
    || result.receipt.reservationLeaseId !== claim.deliveryReceipt.reservationLeaseId
    || result.receipt.admissionAttemptId !== claim.deliveryReceipt.admissionAttemptId
    || result.receipt.deliveryTurnId !== delivery?.turnId) {
    throw new Error("Taskboard returned an invalid bootstrap completion receipt");
  }
  return result;
}

async function mutateBackgroundAdmission(claim, action) {
  const response = await fetch(
    `${taskboardBaseUrl}/api/tasks/${encodeURIComponent(claim.todoId)}/admission-${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...injectorProofHeaders() },
      body: JSON.stringify({
        rootThreadId: claim.rootThreadId,
        expectedResumeToken: claim.expectedResumeToken,
        safeActionId: claim.safeActionId,
        admissionReceiptId: claim.admissionReceiptId,
        admissionAttemptId: claim.admissionAttemptId,
        ...(claim.admissionProbeId ? { admissionProbeId: claim.admissionProbeId } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`Taskboard admission ${action} returned HTTP ${response.status}`);
  const result = await response.json();
  if (result?.receipt?.id !== claim.admissionReceiptId
    || result.receipt.admissionAttemptId !== claim.admissionAttemptId) {
    throw new Error(`Taskboard returned an invalid admission ${action} receipt`);
  }
  return result;
}

function assertResolvedTargetInsideWorktree(worktreePath, resolvedTarget, message) {
  const relative = path.relative(worktreePath, resolvedTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function validateStandingDeliveryPaths(targetRoot, scope) {
  if (!scope || !["edit", "scoped_delete"].includes(scope.kind)) return;
  const worktreePath = realpathSync(targetRoot);
  for (const relativePath of scope.paths) {
    const targetPath = path.resolve(worktreePath, relativePath);
    if (scope.kind === "scoped_delete") {
      const targetStat = lstatSync(targetPath);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error("Delivery-scoped delete target must be one real worktree file");
      }
      assertResolvedTargetInsideWorktree(
        worktreePath,
        realpathSync(targetPath),
        "Delivery-scoped delete target escaped the exact worktree",
      );
      continue;
    }
    try {
      const targetStat = lstatSync(targetPath);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error("Delivery edit target must be one real worktree file");
      }
      assertResolvedTargetInsideWorktree(
        worktreePath,
        realpathSync(targetPath),
        "Delivery edit target escaped the exact worktree",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      let parent = path.dirname(targetPath);
      while (true) {
        try {
          const parentStat = lstatSync(parent);
          if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
            throw new Error("Delivery edit target requires one real directory parent");
          }
          const resolvedParent = realpathSync(parent);
          if (resolvedParent !== worktreePath) {
            assertResolvedTargetInsideWorktree(
              worktreePath,
              resolvedParent,
              "Delivery edit target parent escaped the exact worktree",
            );
          }
          break;
        } catch (parentError) {
          if (parentError.code !== "ENOENT") throw parentError;
        }
        const next = path.dirname(parent);
        if (next === parent) throw new Error("Delivery edit target has no worktree parent");
        parent = next;
      }
    }
  }
}

function validateGitExecutionTarget(targetRoot, expectedIdentity) {
  const topLevelResult = spawnSync(
    "git",
    ["-C", targetRoot, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", timeout: 3_000 },
  );
  const branchResult = spawnSync(
    "git",
    ["-C", targetRoot, "branch", "--show-current"],
    { encoding: "utf8", timeout: 3_000 },
  );
  const remoteResult = spawnSync(
    "git",
    ["-C", targetRoot, "remote", "get-url", "origin"],
    { encoding: "utf8", timeout: 3_000 },
  );
  const resolvedTopLevel = topLevelResult.status === 0 && typeof topLevelResult.stdout === "string"
    ? path.resolve(topLevelResult.stdout.trim())
    : null;
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const repository = remoteResult.status === 0 ? normalizeRepository(remoteResult.stdout.trim()) : null;
  const standingMismatch = expectedIdentity?.standingAuthority === true
    && (branch !== expectedIdentity.branch || repository !== expectedIdentity.repository);
  const identityPathMismatch = expectedIdentity
    && path.resolve(expectedIdentity.worktreePath ?? "") !== path.resolve(targetRoot);
  if (resolvedTopLevel !== path.resolve(targetRoot)
    || identityPathMismatch
    || standingMismatch) {
    throw new Error("Execution target must match the delivery-verified Git worktree, branch, and origin repository");
  }
  if (expectedIdentity?.standingAuthority === true) {
    validateStandingDeliveryPaths(targetRoot, expectedIdentity.standingScope);
  }
}

async function runBackgroundContinuationMonitor(cdp) {
  await ensureQuotaPoliciesLoaded();
  const projects = await loadResidentCoordinatorMonitorProjects({
    listLifecycleProjects: listResidentCoordinatorMonitorProjects,
    readContinuationPolicyEntries: readTaskboardClientStorageEntries,
    continuationPolicyPrefix: backgroundContinuationPolicyPrefix,
  });
  for (const { projectId, continuationEnabled } of projects) {
    if (!continuationEnabled) {
      reportCoordinatorProvisioningDiagnostic(projectId, {
        provisioned: false,
        reason: "continuation-disabled",
      });
    }
    const automationPolicy = quotaPolicyRecords.get(projectId)?.request ?? null;
    const monitors = [];
    if (continuationEnabled) monitors.push(
      () => runCoordinatorShutdownMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          idleGraceMs: coordinatorShutdownIdleGraceMs,
        },
        now: Date.now,
        readSnapshot: readTaskboardAgentLaneSnapshot,
        readWindows: readCoordinatorProvisioningWindows,
        readThread: (route) => requestCodexAppServerViaCdp(
          cdp,
          undefined,
          route.codexHostId,
          "thread/read",
          { threadId: route.threadId, includeTurns: true },
          10_000,
        ),
        getAttempt: getCoordinatorShutdownAttempt,
        requestAttempt: requestCoordinatorShutdownAttempt,
        releaseAttempt: ({ attemptId }) => transitionCoordinatorShutdownAttempt(
          attemptId, "release",
        ),
        findArchivedThread: (attempt) => findArchivedCoordinatorThread(cdp, attempt),
        archiveThread: ({ threadId, codexHostId }) => requestCodexAppServerViaCdp(
          cdp, undefined, codexHostId, "thread/archive", { threadId }, 10_000,
        ),
        completeAttempt: ({ attemptId }) => transitionCoordinatorShutdownAttempt(
          attemptId, "complete",
        ),
      }),
      () => runDomainCoordinatorShutdownMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          idleGraceMs: coordinatorShutdownIdleGraceMs,
        },
        now: Date.now,
        readSnapshot: readTaskboardAgentLaneSnapshot,
        readWindows: readCoordinatorProvisioningWindows,
        readThread: (route) => requestCodexAppServerViaCdp(
          cdp, undefined, route.codexHostId, "thread/read",
          { threadId: route.threadId, includeTurns: true }, 10_000,
        ),
        getAttempt: getDomainCoordinatorShutdownAttempt,
        requestAttempt: requestDomainCoordinatorShutdownAttempt,
        releaseAttempt: ({ attemptId }) => transitionDomainCoordinatorShutdownAttempt(
          attemptId, "release",
        ),
        authorizeAttempt: ({ attemptId }) => transitionDomainCoordinatorShutdownAttempt(
          attemptId, "authorize",
        ),
        beginArchiveAttempt: ({ attemptId }) => transitionDomainCoordinatorShutdownAttempt(
          attemptId, "begin-archive",
        ),
        cancelAttempt: ({ attemptId }) => transitionDomainCoordinatorShutdownAttempt(
          attemptId, "cancel",
        ),
        findArchivedThread: (attempt) => findArchivedCoordinatorThread(cdp, attempt),
        archiveThread: ({ threadId, codexHostId }) => requestCodexAppServerViaCdp(
          cdp, undefined, codexHostId, "thread/archive", { threadId }, 10_000,
        ),
        completeAttempt: ({ attemptId }) => transitionDomainCoordinatorShutdownAttempt(
          attemptId, "complete",
        ),
      }),
    );
    monitors.push(
      () => runCoordinatorLeaseKeepaliveMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          renewWindowMs: coordinatorLeaseRenewWindowMs,
          leaseDurationSeconds: coordinatorLeaseDurationSeconds,
        },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        readThread: (route) => requestCodexAppServerViaCdp(
          cdp,
          undefined,
          route.codexHostId,
          "thread/read",
          { threadId: route.threadId, includeTurns: true },
          10_000,
        ),
        renewLease: renewCoordinatorLease,
      }),
    );
    if (continuationEnabled) monitors.push(
      () => runCoordinatorLeaseRecoveryMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          leaseDurationSeconds: coordinatorLeaseDurationSeconds,
        },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        readThread: (route) => requestCodexAppServerViaCdp(
          cdp,
          undefined,
          route.codexHostId,
          "thread/read",
          { threadId: route.threadId, includeTurns: true },
          10_000,
        ),
        recoverLease: recoverCoordinatorLease,
      }),
      async () => {
        const result = await runCoordinatorProvisioningMonitorOnce({
          policy: {
            enabled: true,
            projectId,
            model: automationPolicy?.model,
            reasoningEffort: automationPolicy?.reasoningEffort,
          },
          readPreflight: () => readCoordinatorProvisioningPreflight(projectId),
          readWindows: () => readCoordinatorProvisioningWindows(projectId),
          readDefaultModel: (route) => readDefaultCoordinatorModel(cdp, route),
          getAttempt: getCoordinatorProvisioningAttempt,
          rebindAttempt: ({ attemptId, expectedRevision }) => (
            transitionCoordinatorProvisioningAttempt(
              attemptId, "rebind", { expectedRevision },
            )
          ),
          inspectCoordinatorWindow: (window) => inspectCoordinatorProvisioningWindow(cdp, window),
          requestAttempt: requestCoordinatorProvisioningAttempt,
          readThread: (attempt) => readCoordinatorProvisioningAttemptThread({
            attempt,
            readThread: (includeTurns) => requestCodexAppServerViaCdp(
              cdp, undefined, attempt.codexHostId, "thread/read",
              { threadId: attempt.threadId, includeTurns }, 10_000,
            ),
          }),
          findThread: (attempt) => findCoordinatorProvisioningThread(cdp, attempt),
          findArchivedThread: (attempt) => findCoordinatorProvisioningThread(cdp, attempt, true),
          markStarting: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "starting",
          ),
          startThread: ({ codexHostId, ...params }) => requestCodexAppServerViaCdp(
            cdp, undefined, codexHostId, "thread/start", params, 10_000,
          ),
          attachThread: ({ attemptId, threadId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "attach", { threadId },
          ),
          resetAttempt: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "reset",
          ),
          resetMissingAttempt: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "reset-missing",
          ),
          observeMissingAttempt: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "observe-missing",
          ),
          clearMissingAttempt: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "clear-missing",
          ),
          resumeExpiredAttempt: ({ attemptId }) => transitionCoordinatorProvisioningAttempt(
            attemptId, "resume-expired",
          ),
          deliverInstruction: ({ attempt, threadId }) => deliverCoordinatorProvisioningInstruction(
            cdp, attempt, threadId, projectId,
          ),
        });
        reportCoordinatorProvisioningDiagnostic(projectId, result);
        return result;
      },
      () => runDomainCoordinatorProvisioningMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          model: automationPolicy?.model,
          reasoningEffort: automationPolicy?.reasoningEffort,
        },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        readWindows: () => readCoordinatorProvisioningWindows(projectId),
        readDefaultModel: (route) => readDefaultCoordinatorModel(cdp, route),
        getAttempt: getDomainCoordinatorProvisioningAttempt,
        requestAttempt: requestDomainCoordinatorProvisioningAttempt,
        rebindAttempt: ({ attemptId, expectedRevision }) => (
          transitionDomainCoordinatorProvisioningAttempt(
            attemptId, "rebind", { expectedRevision },
          )
        ),
        findThread: (attempt) => findCoordinatorProvisioningThread(cdp, attempt),
        readThread: ({ attempt, threadId }) => readCoordinatorProvisioningDeliveryThread({
          attempt,
          threadId,
          marker: `TASKBOARD_DOMAIN_COORDINATOR_PROVISIONING_V1:${attempt.id}`,
          readThread: (includeTurns) => requestCodexAppServerViaCdp(
            cdp, undefined, attempt.codexHostId, "thread/read",
            { threadId, includeTurns }, 10_000,
          ),
        }),
        markStarting: ({ attemptId }) => transitionDomainCoordinatorProvisioningAttempt(
          attemptId, "starting",
        ),
        startThread: ({ codexHostId, ...params }) => requestCodexAppServerViaCdp(
          cdp, undefined, codexHostId, "thread/start", params, 10_000,
        ),
        attachThread: ({ attemptId, threadId }) => (
          transitionDomainCoordinatorProvisioningAttempt(
            attemptId, "attach", { threadId },
          )
        ),
        resetAttempt: ({ attemptId }) => transitionDomainCoordinatorProvisioningAttempt(
          attemptId, "reset",
        ),
        resumeExpiredAttempt: ({ attemptId }) => transitionDomainCoordinatorProvisioningAttempt(
          attemptId, "resume-expired",
        ),
        deliverInstruction: ({ attempt, threadId, domainId }) => (
          deliverDomainCoordinatorProvisioningInstruction(
            cdp, attempt, threadId, projectId, domainId,
          )
        ),
      }),
      () => runOwnerIntentCaptureMonitorOnce({
        policy: { enabled: true, projectId },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        listIntents: () => listOwnerIntents(projectId),
        observeCapture: (request) => observeTaskboardOwnerIntentCapture(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
        ),
        recordCapture: (request) => recordOwnerIntentCapture(request, projectId),
      }),
      () => runOwnerIntentPlanningMonitorOnce({
        policy: { enabled: true, projectId },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        observePlan: (request) => observeTaskboardOwnerIntentPlan(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
        ),
        applyPlan: (request, plan) => applyOwnerIntentPlan(request, plan, projectId),
        scheduleRetry: (request, failure) => scheduleOwnerIntentPlanRetry(
          request,
          failure,
          projectId,
        ),
      }),
      () => runOwnerIntentAdoptionMonitorOnce({
        policy: { enabled: true, projectId },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        claimAdoption: (request) => claimOwnerIntentAdoption(request, projectId),
        confirmAdoption: (request, intentId) => confirmOwnerIntentAdoption(
          request,
          projectId,
          intentId,
        ),
        deliver: (request, options) => deliverTaskboardOwnerIntent(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
          options,
        ),
      }),
      () => runCrossDomainHandoffMonitorOnce({
        policy: { enabled: true, projectId },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        claimDelivery: (request) => claimCrossDomainHandoffDelivery(request, projectId),
        confirmDelivery: (request) => confirmCrossDomainHandoffDelivery(request, projectId),
        deliver: (request, options) => deliverTaskboardCrossDomainHandoff(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
          options,
        ),
      }),
      () => runTaskboardContinuationMonitorOnce({
        policy: {
          enabled: true,
          projectId,
          maxActiveAgents: configuredMaxActiveAgents,
          capacityObservationMaxAgeMs,
        },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        claimReceipt: claimBackgroundContinuationReceipt,
        confirmDelivery: confirmBackgroundContinuationDelivery,
        completeDelivery: completeBackgroundContinuationDelivery,
        deferAdmission: (request) => mutateBackgroundAdmission(request, "defer"),
        markAdmissionUncertain: (request) => mutateBackgroundAdmission(request, "uncertain"),
        claimAdmissionProbe: (request) => mutateBackgroundAdmission(request, "probe"),
        reconcileAdmission: (request) => mutateBackgroundAdmission(request, "reconcile"),
        deliverAdmissionRecovery: (request) => deliverTaskboardAdmissionRecovery(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.codexHostId,
            method,
            params,
            10_000,
          ),
        ),
        deliver: (request) => deliverTaskboardCoordination(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.codexHostId,
            method,
            params,
            10_000,
          ),
          validateGitExecutionTarget,
        ),
      }),
      () => runOwnerDecisionMonitorOnce({
        policy: { enabled: true, projectId },
        readSnapshot: readTaskboardAgentLaneSnapshot,
        claimDelivery: (request) => claimOwnerDecisionDelivery(request, projectId),
        confirmDelivery: (request) => confirmOwnerDecisionDelivery(request, projectId),
        deliver: (request, options) => deliverTaskboardOwnerDecision(
          request,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
          options,
        ),
        observeDecision: (request, receipt) => observeTaskboardOwnerDecision(
          request,
          receipt,
          (method, params) => requestCodexAppServerViaCdp(
            cdp,
            undefined,
            request.route.codexHostId,
            method,
            params,
            10_000,
          ),
        ),
        recordDecision: recordOwnerDecision,
      }),
    );
    await runTaskboardProjectMonitorSequence(monitors);
  }
}

function installTaskboardHostBinding(cdp, supervisor, startupToken) {
  let activeContextId = null;
  let activeMainContextId = null;
  let installInFlight = null;
  let disposeBackgroundContinuationTimer = null;
  let disposeCoordinatorIdentityHandshakeTimer = null;
  let hostRequestQueueTimer = null;
  let hostRequestQueueInFlight = false;
  let taskboardNetworkProxyInstalled = false;
  const mainContextsByFrame = new Map();

  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.auxData?.isDefault === true && typeof context.auxData.frameId === "string") {
      mainContextsByFrame.set(context.auxData.frameId, context.id);
    }
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    for (const [frameId, contextId] of mainContextsByFrame) {
      if (contextId === executionContextId) mainContextsByFrame.delete(frameId);
    }
  });

  const scheduleBackgroundContinuation = () => {
    if (disposeBackgroundContinuationTimer || cdp.closed) return;
    disposeBackgroundContinuationTimer = createDisposableMonitorTimer(async () => {
      if (cdp.closed) return;
      try {
        await runBackgroundContinuationMonitor(cdp);
      } catch (error) {
        console.error(`Taskboard background continuation check failed: ${error.message}`);
      }
    }, backgroundContinuationIntervalMs);
  };

  const scheduleCoordinatorIdentityHandshakeFastLane = () => {
    if (disposeCoordinatorIdentityHandshakeTimer || cdp.closed) return;
    disposeCoordinatorIdentityHandshakeTimer = createDisposableMonitorTimer(async () => {
      if (cdp.closed) return;
      try {
        const projects = await loadResidentCoordinatorMonitorProjects({
          listLifecycleProjects: listResidentCoordinatorMonitorProjects,
          readContinuationPolicyEntries: readTaskboardClientStorageEntries,
          continuationPolicyPrefix: backgroundContinuationPolicyPrefix,
        });
        await runCoordinatorIdentityHandshakeFastLane({
          projects,
          runHandshake: (projectId) => runBackgroundCoordinatorIdentityHandshakeMonitorOnce({
            projectId,
            listHandshakes: listCoordinatorIdentityHandshakes,
            readThread: (route) => requestCodexAppServerViaCdp(
              cdp,
              undefined,
              route.codexHostId,
              "thread/read",
              { threadId: route.threadId, includeTurns: false },
              10_000,
            ),
            confirmIdentity: confirmCoordinatorIdentityHandshake,
          }),
        });
      } catch (error) {
        console.error(`Taskboard Coordinator identity fast lane failed: ${error.message}`);
      }
    }, coordinatorIdentityHandshakeIntervalMs);
  };

  cdp.onClose(() => {
    disposeCoordinatorIdentityHandshakeTimer?.();
    disposeCoordinatorIdentityHandshakeTimer = null;
    disposeBackgroundContinuationTimer?.();
    disposeBackgroundContinuationTimer = null;
    if (hostRequestQueueTimer) {
      clearInterval(hostRequestQueueTimer);
      hostRequestQueueTimer = null;
    }
  });

  const installTaskboardNetworkProxy = async () => {
    if (taskboardNetworkProxyInstalled) return;
    taskboardNetworkProxyInstalled = true;
    cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
      const requestUrl = typeof request?.url === "string" ? request.url : "";
      if (!(requestUrl === taskboardBaseUrl || requestUrl.startsWith(`${taskboardBaseUrl}/`))) {
        await cdp.send("Fetch.continueRequest", { requestId });
        return;
      }
      try {
        const browserOrigin = request.headers?.Origin || request.headers?.origin;
        const corsOrigin = browserOrigin === "app://-" ? "app://-" : "null";
        let requestedHeaders = Object.entries(request.headers || {}).filter(([name]) => !(
          /^(?:host|connection|content-length|accept-encoding|origin|referer)$/i.test(name)
          || /^sec-fetch-/i.test(name)
        ));
        if (request.method === "OPTIONS") {
          await cdp.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 204,
            responseHeaders: [
              { name: "access-control-allow-origin", value: corsOrigin },
              { name: "access-control-allow-private-network", value: "true" },
              { name: "access-control-allow-methods", value: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" },
              {
                name: "access-control-allow-headers",
                value: request.headers?.["Access-Control-Request-Headers"]
                  || request.headers?.["access-control-request-headers"]
                  || "content-type",
              },
            ],
          });
          return;
        }
        const method = request.method || "GET";
        if (method === "PUT" && requestUrl === `${taskboardBaseUrl}/api/local/host-runtime`) {
          requestedHeaders = requestedHeaders.filter(([name]) => !(
            /^x-codex-taskboard-injector-(?:nonce|proof)$/i.test(name)
          ));
          requestedHeaders.push(...Object.entries(injectorProofHeaders()));
        }
        const response = await proxyTaskboardRequest(requestUrl, request, requestedHeaders);
        const responseHeaders = Array.from(response.headers.entries())
          .filter(([name]) => !/^(?:content-length|content-encoding|transfer-encoding|connection)$/i.test(name))
          .map(([name, value]) => ({ name, value }));
        responseHeaders.push(
          { name: "access-control-allow-origin", value: corsOrigin },
          { name: "access-control-allow-private-network", value: "true" },
        );
        const body = method === "HEAD"
          ? ""
          : Buffer.from(await response.arrayBuffer()).toString("base64");
        await cdp.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: response.status,
          responsePhrase: response.statusText,
          responseHeaders,
          body,
        });
      } catch (_) {
        if (!cdp.closed) {
          try {
            await cdp.send("Fetch.failRequest", {
              requestId,
              errorReason: "Failed",
            });
          } catch {}
        }
      }
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: `${taskboardOrigin}/*`, requestStage: "Request" }],
    });
  };

  const handleAuthorizedHostPayload = (payload, executionContextId = activeContextId) => (
    handleHostBindingPayload({ executionContextId, payload }, {
      isAuthorizedContext: (candidateContextId) => candidateContextId === activeContextId,
      parseAutomationRequest: parseTaskboardAutomationHostRequest,
      ensure: () => supervisor.ensure({ force: true }),
      loadFrame: (request) => loadTaskboardFrameViaCdp(
        cdp,
        request.frameName,
        request.frameCapability,
      ),
      openExternal: openExternalUrl,
      openAttachment,
      runAutomation: (request) => (
        (async () => {
          const rpc = (method, body) => requestCodexAutomationViaCdp(
            cdp,
            undefined,
            method,
            body,
          );
          if (request.operation === "list") {
            const stored = await reconcileStoredAutomationPolicy(
              request,
              rpc,
            );
            return stored ?? reconcileTaskboardAutomation(request, rpc);
          }
          return request.operation === "apply-policy"
            ? updateAndApplyQuotaPolicy(request, rpc)
            : reconcileTaskboardAutomation(request, rpc);
        })()
      ),
      startConversation: (request) => (
        getOrStartTaskConversation(cdp, undefined, request)
      ),
      coordinateAgentTodo: (request) => deliverTaskboardCoordination(
        request,
        (method, params) => requestCodexAppServerViaCdp(
          cdp,
          undefined,
          request.codexHostId,
          method,
          params,
          10_000,
        ),
        validateGitExecutionTarget,
      ),
      sendResponse: (candidateContextId, response) => (
        sendHostResponse(cdp, candidateContextId, response)
      ),
    })
  );

  const pollHostRequestQueue = async () => {
    if (hostRequestQueueInFlight || cdp.closed || !activeMainContextId || !activeContextId) return;
    hostRequestQueueInFlight = true;
    try {
      const drained = await cdp.send("Runtime.evaluate", {
        contextId: activeMainContextId,
        expression: `(() => {
          const queue = window[${JSON.stringify(hostRequestQueueName)}];
          return Array.isArray(queue) ? queue.splice(0, queue.length) : [];
        })()`,
        returnByValue: true,
      });
      const envelopes = Array.isArray(drained.result.value) ? drained.result.value : [];
      for (const envelope of envelopes) {
        if (
          !envelope
          || envelope.capability !== hostCapability
          || !envelope.payload
          || typeof envelope.payload !== "object"
        ) continue;
        await handleAuthorizedHostPayload(JSON.stringify(envelope.payload));
      }
    } catch (error) {
      if (!cdp.closed) console.error(`Taskboard host request queue failed: ${error.message}`);
    } finally {
      hostRequestQueueInFlight = false;
      if (cdp.closed && hostRequestQueueTimer) {
        clearInterval(hostRequestQueueTimer);
        hostRequestQueueTimer = null;
      }
    }
  };

  cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.name !== hostBindingName || params.executionContextId !== activeContextId) return;
    await handleAuthorizedHostPayload(params.payload, params.executionContextId);
  });

  async function install() {
    if (installInFlight) return installInFlight;
    installInFlight = (async () => {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const mainContextDeadline = Date.now() + 3_000;
      while (!mainContextsByFrame.has(frameTree.frame.id) && Date.now() < mainContextDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      activeMainContextId = mainContextsByFrame.get(frameTree.frame.id) ?? null;
      if (!activeMainContextId) {
        throw new Error("Codex main execution context is unavailable");
      }
      const isolatedWorld = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "codex-taskboard-host",
      });
      activeContextId = isolatedWorld.executionContextId;
      await cdp.send("Runtime.addBinding", {
        name: hostBindingName,
        executionContextId: activeContextId,
      });
      await cdp.send("Runtime.evaluate", {
        contextId: activeMainContextId,
        expression: initializeHostRequestQueueExpression(hostRequestQueueName),
        returnByValue: true,
      });
      await installTaskboardNetworkProxy();
      if (!hostRequestQueueTimer) {
        hostRequestQueueTimer = setInterval(() => void pollHostRequestQueue(), 50);
        hostRequestQueueTimer.unref?.();
      }
      await cdp.send("Runtime.evaluate", {
        contextId: activeContextId,
        expression: `(() => {
          const capability = ${JSON.stringify(hostCapability)};
          if (globalThis.__codexTaskboardIsolatedBridgeV1 === capability) return;
          globalThis.__codexTaskboardIsolatedBridgeV1 = capability;
          window.addEventListener("message", (event) => {
            const message = event.data;
            if (
              event.source !== window
              || event.origin !== window.location.origin
              || !message
              || typeof message !== "object"
              || message.type !== ${JSON.stringify(hostRequestMessage)}
              || message.capability !== capability
            ) return;
            globalThis[${JSON.stringify(hostBindingName)}](JSON.stringify(message.payload));
          });
        })()`,
        returnByValue: true,
      });
      await restoreQuotaPolicies(cdp);
      scheduleCoordinatorIdentityHandshakeFastLane();
      scheduleBackgroundContinuation();
      return activeContextId;
    })();
    try {
      return await installInFlight;
    } finally {
      installInFlight = null;
    }
  }

  async function publishHeartbeat() {
    let timeout;
    try {
      await Promise.race([
        (async () => {
          const executionContextId = await install();
          await cdp.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: `window.postMessage({
              type: ${JSON.stringify(hostHeartbeatMessage)},
              capability: ${JSON.stringify(hostCapability)},
              at: Date.now(),
              startupToken: ${JSON.stringify(startupToken)}
            }, window.location.origin)`,
            returnByValue: true,
          });
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            cdp.close();
            reject(new Error("Timed out publishing the Taskboard host heartbeat"));
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { install, publishHeartbeat };
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: document.getElementById("codex-taskboard-page")?.hidden === false,
      frameReady: window.__codexTaskboardInjection__?.ready === true,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

async function waitForHostHeartbeat(cdp, startupToken, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const heartbeat = await cdp.send("Runtime.evaluate", {
      expression: `window[${JSON.stringify(hostStartupTokenName)}] === ${JSON.stringify(startupToken)}`,
      returnByValue: true,
    });
    if (heartbeat.result.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Taskboard host heartbeat");
}

async function waitForInjectionStatus(cdp, shouldOpen, expectedSourceHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && (
      status.sourceHash !== expectedSourceHash
      || !status.entryMounted
      || (shouldOpen && (!status.pageVisible || !status.frameUrl || !status.frameReady))
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await readInjectionStatus(cdp);
  }
  return status;
}

async function evaluateInjectionSource(cdp, source) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description || "Taskboard injection failed",
    );
  }
}

async function publishInjectionScriptIdentifier(cdp, scriptIdentifier) {
  await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(injectionScriptIdentifierName)}] = ${JSON.stringify(scriptIdentifier)}`,
    returnByValue: true,
  });
}

async function registerInjectionSource(cdp, source) {
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${source}\n//# sourceURL=codex-taskboard.user.js`,
  });
  return registration.identifier;
}

function taskboardRequestBody(request, method) {
  if (method === "GET" || method === "HEAD") return undefined;
  if (Array.isArray(request.postDataEntries)) {
    return Buffer.concat(request.postDataEntries.map((entry) => {
      if (typeof entry?.bytes !== "string") {
        throw new Error("Taskboard proxy received an unreadable request body entry");
      }
      return Buffer.from(entry.bytes, "base64");
    }));
  }
  return typeof request.postData === "string"
    ? Buffer.from(request.postData, "utf8")
    : undefined;
}

async function proxyTaskboardRequest(requestUrl, request, requestedHeaders) {
  const method = request.method || "GET";
  return fetch(requestUrl, {
    method,
    headers: Object.fromEntries(requestedHeaders),
    body: taskboardRequestBody(request, method),
    redirect: "follow",
  });
}

async function injectTarget(
  runtime,
  target,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const cdp = await runtime.connect(target);
  let retained = false;
  const hostBridge = keepAlive
    ? installTaskboardHostBinding(cdp, supervisor, startupToken)
    : null;
  cdp.hostBridge = hostBridge;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    if (keepAlive) await hostBridge.install();
    if (keepAlive && attachExisting) {
      const currentStatus = await readInjectionStatus(cdp);
      const reconciled = await reconcileInjectionRuntime({
        currentStatus,
        source,
        sourceHash,
        removeRegisteredSource: (identifier) => cdp.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
        ),
        registerCurrentSource: (currentSource) => registerInjectionSource(cdp, currentSource),
        evaluateCurrentSource: (currentSource) => evaluateInjectionSource(cdp, currentSource),
        publishRegistration: (identifier) => publishInjectionScriptIdentifier(cdp, identifier),
        reopen: async () => {
          await hostBridge.publishHeartbeat();
          await waitForHostHeartbeat(cdp, startupToken);
          return cdp.send("Runtime.evaluate", {
            expression: "window.__codexTaskboardInjection__?.open()",
            returnByValue: true,
          });
        },
      });
      cdp.on("Page.loadEventFired", async () => {
        await hostBridge.install();
        await publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier);
        await hostBridge.publishHeartbeat();
      });
      await hostBridge.publishHeartbeat();
      await waitForHostHeartbeat(cdp, startupToken);
      if (shouldOpen && !reconciled.shouldRemainOpen) {
        await cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        });
      }
      const shouldRemainOpen = shouldOpen || reconciled.shouldRemainOpen;
      let status = await waitForInjectionStatus(
        cdp,
        shouldRemainOpen,
        sourceHash,
        15_000,
      );
      let frameLoaded = status.frameUrl
        ? await waitForFrame(cdp, status.frameUrl, 15_000)
        : false;
      if (shouldRemainOpen && (!status.frameReady || !frameLoaded)) {
        await hostBridge.publishHeartbeat();
        await waitForHostHeartbeat(cdp, startupToken);
        await cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        });
        status = await waitForInjectionStatus(cdp, true, sourceHash, 15_000);
        frameLoaded = status.frameUrl
          ? await waitForFrame(cdp, status.frameUrl, 15_000)
          : false;
      }
      if (shouldRemainOpen && (!status.frameReady || !frameLoaded)) {
        throw new Error("Taskboard frame did not report ready in the Codex renderer");
      }
      retained = true;
      return {
        result: { ...status, cspBypassed: true, frameLoaded },
        connection: cdp,
      };
    }
    const scriptIdentifier = await registerInjectionSource(cdp, source);
    cdp.on("Page.loadEventFired", async () => {
      if (keepAlive) await hostBridge.install();
      await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
      if (keepAlive) await hostBridge.publishHeartbeat();
    });
    await evaluateInjectionSource(cdp, source);
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    if (keepAlive) {
      await hostBridge.publishHeartbeat();
      await waitForHostHeartbeat(cdp, startupToken);
    }
    if (shouldOpen) {
      await waitForInjectionStatus(cdp, false, sourceHash, 60_000);
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          taskboard?.close();
          taskboard?.open();
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    let status = await waitForInjectionStatus(cdp, shouldOpen, sourceHash, 15_000);
    let frameLoaded = status.frameUrl
      ? await waitForFrame(cdp, status.frameUrl, 15_000)
      : false;
    if (shouldOpen && (!status.frameReady || !frameLoaded)) {
      await hostBridge.publishHeartbeat();
      await waitForHostHeartbeat(cdp, startupToken);
      await cdp.send("Runtime.evaluate", {
        expression: "window.__codexTaskboardInjection__?.open()",
        returnByValue: true,
      });
      status = await waitForInjectionStatus(cdp, true, sourceHash, 15_000);
      frameLoaded = status.frameUrl
        ? await waitForFrame(cdp, status.frameUrl, 15_000)
        : false;
    }
    if (shouldOpen && (!status.frameReady || !frameLoaded)) {
      throw new Error("Taskboard frame did not report ready in the Codex renderer");
    }
    const result = {
      ...status,
      cspBypassed: true,
      frameLoaded,
    };
    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }
    retained = keepAlive;
    return { result, connection: retained ? cdp : null };
  } finally {
    if (!retained) {
      unregisterQuotaPolicyCdp(cdp);
      cdp.close();
    }
  }
}

async function injectAll(
  runtime,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
  onConnectionReady = async () => {},
) {
  const targets = await runtime.targets();
  if (targets.length === 0) {
    if (keepAlive) return [];
    throw new Error("No Codex renderer target found");
  }

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      unregisterQuotaPolicyCdp(connection);
      connection.close();
      injectedTargets.delete(id);
    }
  }

  const results = [];
  for (const target of targets) {
    if (injectedTargets.has(target.id)) continue;
    const firstTarget = injectedTargets.size === 0 && results.length === 0;
    const { result, connection } = await injectTarget(
      runtime,
      target,
      source,
      sourceHash,
      shouldOpen && firstTarget,
      firstTarget ? screenshotPath : null,
      keepAlive,
      supervisor,
      attachExisting,
      startupToken,
    );
    if (connection) {
      injectedTargets.set(target.id, connection);
      await onConnectionReady(connection, target, {
        opened: shouldOpen && firstTarget,
      });
    }
    results.push({ targetId: target.id, title: target.title, url: target.url, ...result });
  }
  return results;
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
window.__CODEX_TASKBOARD_HOST_CAPABILITY__ = ${JSON.stringify(hostCapability)};
window[${JSON.stringify(hostRequestQueueGlobalName)}] = ${JSON.stringify(hostRequestQueueName)};
window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
${userScript}`;
  const sourceHash = createHash("sha256").update(runtimeSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};
${runtimeSource}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.startupToken ??= taskboardInstanceToken;
  process.env.CODEX_EXECUTABLE = resolveCodexExecutable({ appPath: options.appPath });
  const cdpVersionUrl = `http://127.0.0.1:${options.port}/json/version`;

  if (options.daemon) {
    let port = options.port;
    if (!options.portExplicit) {
      const candidates = codexDebuggingPorts(options.port);
      const activePort = await Promise.any(candidates.map(async (candidate) => {
        if (!(await isReachable(`http://127.0.0.1:${candidate}/json/version`))) {
          throw new Error("unreachable");
        }
        if ((await codexTargets(candidate)).length === 0) throw new Error("not Codex");
        return candidate;
      })).catch(() => null);
      if (!activePort) throw new Error("No debuggable Codex window found");
      port = activePort;
    }
    console.log(JSON.stringify({ launcher: startResidentInjector(port, options.open), port }, null, 2));
    return;
  }

  if (options.refresh || options.refreshIfRunning) {
    const ports = options.portExplicit
      ? [options.port]
      : codexDebuggingPorts(options.port);
    const refreshed = [];
    for (const port of ports) {
      if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
      if (options.refreshIfRunning) await restartResidentInjectorForRefresh(port);
      const results = await refreshTaskboardFrames(port);
      refreshed.push(...results.map((result) => ({ port, ...result })));
    }
    if (refreshed.length === 0) {
      if (options.refreshIfRunning) {
        console.log(JSON.stringify({ refreshed: [], skipped: "No debuggable Codex window is running" }));
        return;
      }
      throw new Error(`No debuggable Codex window found on ports: ${ports.join(", ")}`);
    }
    console.log(JSON.stringify({ refreshed }, null, 2));
    return;
  }

  let codexProcess = null;
  let managedCodex = null;
  let pendingCodexLaunch = null;
  let cdpRuntime = null;
  let codexAppPid = null;
  let nativeCodexBrowser = false;
  let runtimePublishPromise = null;
  const injectedTargets = new Map();
  let idleAfterNormalExit = false;
  let openRequestGeneration = options.open ? 1 : 0;
  let openedRequestGeneration = 0;
  const nativeTaskboardPanelOpener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => {
      const response = await fetch(`${taskboardBaseUrl}/api/local/taskboard-panel-presence`, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`Taskboard panel presence returned ${response.status}`);
      return (await response.json()).live === true;
    },
    openPanel: async () => {
      const deepLink = new URL("codex://threads/new");
      deepLink.searchParams.set("browserUrl", taskboardPageUrl);
      await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/open", [deepLink.toString()], {
          env: withoutTaskboardLauncherEnvironment(process.env),
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`LaunchServices could not open Taskboard (${code})`));
        });
      });
    },
    focusApp: () => activateCodexApp(codexAppPid),
  });
  const hasOpenPending = () => openedRequestGeneration < openRequestGeneration;
  const resolveLaunchCoordinatorRouteForGeneration = createOpenGenerationRouteResolver(
    async () => {
      const route = await readLaunchCoordinatorRoute();
      if (route) {
        console.log(JSON.stringify({
          selectedCoordinatorTaskId: route.taskId,
          selectedCoordinatorThreadId: route.threadId,
        }));
      }
      return route;
    },
  );
  const queueTaskboardOpen = () => {
    openRequestGeneration += 1;
    console.log(JSON.stringify({ openTaskboardSignalQueued: true }));
    void requestTaskboardOpen();
  };
  let openControl = null;
  const requestTaskboardOpen = async (preferredConnection = null) => {
    const generation = openRequestGeneration;
    if (generation <= openedRequestGeneration) return true;
    let launchCoordinatorRoute;
    try {
      launchCoordinatorRoute = await resolveLaunchCoordinatorRouteForGeneration(generation);
    } catch (error) {
      console.error(`Waiting for registered Execution Coordinator route: ${error.message}`);
      return false;
    }
    if (generation !== openRequestGeneration) return false;
    const connection = preferredConnection && !preferredConnection.closed
      ? preferredConnection
      : injectedTargets.values().next().value;
    if (!nativeCodexBrowser && !connection) return false;
    try {
      if (launchCoordinatorRoute) {
        if (nativeCodexBrowser) return false;
        if (!(await waitForCoordinatorThreadSelection(
          connection,
          launchCoordinatorRoute.threadId,
          undefined,
          undefined,
          undefined,
          undefined,
          () => generation === openRequestGeneration,
        ))) return false;
        if (generation !== openRequestGeneration) return false;
      }
      if (nativeCodexBrowser) {
        const result = await nativeTaskboardPanelOpener.openOrFocus();
        openedRequestGeneration = Math.max(openedRequestGeneration, generation);
        console.log(JSON.stringify(
          result.action === "opened"
            ? { openedTaskboardInExistingCodex: true }
            : result.action === "opening"
              ? { openingTaskboardInExistingCodex: true }
              : { reusedTaskboardInExistingCodex: true },
        ));
        return true;
      }
      const opened = launchCoordinatorRoute
        ? await requestPreparedTaskboardOpen(
            connection,
            launchCoordinatorRoute.threadId,
            generation,
            () => openRequestGeneration,
          )
        : await requestInjectedTaskboardOpen(connection);
      if (!opened) {
        throw new Error("Taskboard injection is not ready");
      }
      return completeSuccessfulTaskboardOpen({
        markOpened: () => {
          openedRequestGeneration = Math.max(openedRequestGeneration, generation);
        },
        bringToFront: () => connection.send("Page.bringToFront"),
        activate: () => activateCodexApp(codexAppPid),
      });
    } catch (error) {
      console.error(`Waiting to open Taskboard: ${error.message}`);
      return false;
    }
  };
  let stopping = false;
  let wakeStop;
  const stopRequested = new Promise((resolve) => {
    wakeStop = resolve;
  });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    wakeStop();
    cleanup().catch((error) => {
      console.error(`Cleanup failed: ${error.message}`);
    });
  };
  if (options.watch) {
    if (process.platform === "win32") {
      openControl = createInterface({ input: process.stdin, terminal: false });
      openControl.on("line", (line) => {
        if (line.trim() === "open") queueTaskboardOpen();
        else if (line.trim() === "stop") requestStop();
      });
    } else {
      process.on("SIGUSR2", queueTaskboardOpen);
    }
    console.log(JSON.stringify({ openTaskboardSignalReady: true }));
  }
  const detached = !options.watch;
  const supervisor = createTaskboardSupervisor({
    detached,
    isReachable: isTaskboardReachable,
    waitUntilReachable: waitUntilTaskboardReachable,
    start: () => startTaskboard({ detached }),
    onProcessError: (error) => {
      console.error(`Taskboard process error: ${error.message}`);
    },
    onUnexpectedExit: (code, signal) => {
      console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
    },
    startupTimeoutMs: 120_000,
    unhealthyChildGraceMs: 120_000,
  });

  const publishRuntime = async () => {
    const pending = publishTaskboardRuntime();
    runtimePublishPromise = pending;
    try {
      await pending;
    } finally {
      if (runtimePublishPromise === pending) runtimePublishPromise = null;
    }
  };

  const startManagedCodex = async () => {
    if (stopping) return false;
    if (!options.cdpPipe) {
      const runningCodex = codexAppProcesses(options.appPath);
      let debuggingCodexFound = false;
      for (const record of runningCodex) {
        const port = codexProcessDebuggingPort(record);
        if (!port) continue;
        debuggingCodexFound = true;
        if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
        try {
          if ((await codexTargets(port)).length === 0) continue;
        } catch {
          continue;
        }
        cdpRuntime = tcpCdpRuntime(port);
        codexAppPid = record.pid;
        options.attachExisting = true;
        console.log(JSON.stringify({ reusedCodexPid: record.pid, cdpPort: port }));
        return true;
      }
      if (runningCodex.length > 0) {
        if (debuggingCodexFound) return false;
        if (!options.launch) {
          nativeCodexBrowser = true;
          return false;
        }
      }
    }
    if (options.launch) {
      await importCodexBrowserProfile();
      if (stopping) return false;
    }
    if (options.cdpPipe) {
      const launchPromise = (async () => {
        const launched = await launchCodexWithPipe(options.appPath);
        codexProcess = launched.child;
        cdpRuntime = pipeCdpRuntime(launched.browser);
      })();
      pendingCodexLaunch = launchPromise;
      try {
        await launchPromise;
      } catch (error) {
        if (!stopping) throw error;
      } finally {
        if (pendingCodexLaunch === launchPromise) pendingCodexLaunch = null;
      }
      return true;
    }
    const launchPromise = launchCodexWithLaunchServices(
      options.appPath,
      options.port,
      () => stopping,
    );
    pendingCodexLaunch = launchPromise;
    try {
      managedCodex = await launchPromise;
      codexAppPid = managedCodex.pid;
    } catch (error) {
      if (!stopping) throw error;
    } finally {
      if (pendingCodexLaunch === launchPromise) pendingCodexLaunch = null;
    }
    if (stopping) return false;
    try {
      await waitUntilReachable(cdpVersionUrl, 30_000, () => stopping);
    } catch (error) {
      if (stopping) return false;
      throw error;
    }
    if (!stopping) cdpRuntime = tcpCdpRuntime(options.port);
    return !stopping;
  };

  let cleanupPromise = null;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      injectedTargets.forEach((connection) => {
        unregisterQuotaPolicyCdp(connection);
        connection.close();
      });
      injectedTargets.clear();
      cdpRuntime?.close();
      cdpRuntime = null;
      const supervisorCleanupPromise = supervisor.stop();
      const runtimeCleanupPromise = (async () => {
        const pendingRuntimePublish = runtimePublishPromise;
        if (pendingRuntimePublish) {
          try {
            await pendingRuntimePublish;
          } catch (_) {}
        }
        await removeTaskboardRuntime();
      })();
      supervisorCleanupPromise.catch(() => {});
      runtimeCleanupPromise.catch(() => {});
      const launchPromise = pendingCodexLaunch;
      if (launchPromise) {
        try {
          await launchPromise;
        } catch (_) {}
        cdpRuntime?.close();
        cdpRuntime = null;
      }
      const launchedCodex = codexProcess;
      let launchedManagedCodex = managedCodex;
      if (!launchedManagedCodex && !options.cdpPipe) {
        const discovered = managedCodexProcess(options.appPath);
        if (discovered && managedCodexUsesPort(discovered, options.port)) {
          launchedManagedCodex = discovered;
        }
      }
      codexProcess = null;
      managedCodex = null;
      if (launchedManagedCodex) await stopManagedCodex(launchedManagedCodex);
      if (
        launchedCodex
        && launchedCodex.exitCode === null
        && launchedCodex.signalCode === null
      ) {
        const codexExitPromise = new Promise((resolve) => {
          launchedCodex.once("exit", () => resolve(true));
        });
        launchedCodex.kill("SIGTERM");
        const codexExited = await Promise.race([
          codexExitPromise,
          new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        if (!codexExited && launchedCodex.exitCode === null) {
          launchedCodex.kill("SIGKILL");
          await Promise.race([
            codexExitPromise,
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
      }
      await Promise.all([supervisorCleanupPromise, runtimeCleanupPromise]);
    })();
    return cleanupPromise;
  };
  if (options.watch) {
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
  }
  try {
    if (stopping) return;
    let cdpReachable = false;
    if (!options.cdpPipe) {
      cdpReachable = await isReachable(cdpVersionUrl);
      if (!cdpReachable && options.watch && !options.launch) {
        await waitUntilReachable(cdpVersionUrl, 60_000);
        cdpReachable = true;
      }
      if (!cdpReachable && !options.launch) {
        throw new Error(`Codex CDP is not listening on 127.0.0.1:${options.port}`);
      }
    }
    if (stopping) return;

    await supervisor.ensure({ force: true });
    if (stopping) return;
    await publishRuntime();
    if (stopping) return;
    let initialLaunchCoordinatorRoute = null;
    let initialLaunchCoordinatorRouteResolved = !hasOpenPending();
    if (hasOpenPending()) {
      try {
        initialLaunchCoordinatorRoute = await resolveLaunchCoordinatorRouteForGeneration(
          openRequestGeneration,
        );
        initialLaunchCoordinatorRouteResolved = true;
      } catch (error) {
        console.error(`Waiting for registered Execution Coordinator route: ${error.message}`);
      }
      if (stopping) return;
    }

    if (options.cdpPipe || !cdpReachable) {
      idleAfterNormalExit = !(await startManagedCodex()) && !nativeCodexBrowser;
    } else {
      if (options.launch) {
        const runningCodex = codexAppProcesses(options.appPath)
          .find((record) => codexProcessDebuggingPort(record) === options.port);
        if (!runningCodex || (await codexTargets(options.port)).length === 0) {
          throw new Error(`Codex CDP port ${options.port} belongs to another process`);
        }
        managedCodex = managedCodexProcesses(options.appPath)
          .find((record) => record.pid === runningCodex.pid) ?? null;
        codexAppPid = runningCodex.pid;
        if (!managedCodex) {
          options.attachExisting = true;
          console.log(JSON.stringify({ reusedCodexPid: runningCodex.pid, cdpPort: options.port }));
        }
      } else {
        codexAppPid = codexAppProcesses(options.appPath)
          .find((record) => codexProcessDebuggingPort(record) === options.port)?.pid ?? null;
      }
      cdpRuntime = tcpCdpRuntime(options.port);
    }
    if (stopping) return;

    const { source, sourceHash } = await currentInjectionSource();
    if (stopping) return;
    let firstResults = [];
    const firstOpenGeneration = openRequestGeneration;
    const shouldOpenFirstTarget = firstOpenGeneration > openedRequestGeneration
      && initialLaunchCoordinatorRouteResolved
      && !initialLaunchCoordinatorRoute;
    if (!idleAfterNormalExit && !nativeCodexBrowser) {
      try {
        firstResults = await injectAll(
          cdpRuntime,
          source,
          sourceHash,
          shouldOpenFirstTarget,
          options.screenshot,
          injectedTargets,
          options.watch,
          supervisor,
          options.attachExisting,
          options.startupToken,
          async (connection, _target, { opened }) => {
            if (opened) {
              openedRequestGeneration = Math.max(
                openedRequestGeneration,
                firstOpenGeneration,
              );
              activateCodexApp(codexAppPid);
            }
            if (hasOpenPending()) await requestTaskboardOpen(connection);
          },
        );
      } catch (error) {
        if (!options.watch) throw error;
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
    if (stopping) return;
    if (firstResults.length > 0) {
      if (shouldOpenFirstTarget && !options.watch) {
        openedRequestGeneration = Math.max(openedRequestGeneration, firstOpenGeneration);
        activateCodexApp(codexAppPid);
      }
      console.log(JSON.stringify({ injected: firstResults }, null, 2));
    }
    if (hasOpenPending()) {
      await requestTaskboardOpen();
    }
    if (!options.watch) {
      if (options.cdpPipe) codexProcess?.unref();
      return;
    }

    while (!stopping) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2_000)),
        stopRequested,
      ]);
      if (stopping) break;
      try {
        const service = await supervisor.ensure();
        if (service.restarted && !stopping) await publishRuntime();
      } catch (error) {
        console.error(`Waiting for Taskboard service: ${error.message}`);
      }
      if (stopping) break;
      for (const connection of injectedTargets.values()) {
        try {
          await connection.hostBridge?.publishHeartbeat();
        } catch (_) {}
      }
      if (nativeCodexBrowser) {
        if (codexAppProcesses(options.appPath).length === 0) {
          nativeCodexBrowser = false;
          idleAfterNormalExit = true;
          console.error(
            "Waiting for Codex after exit; open Codex Taskboard again to restart it.",
          );
          continue;
        }
        if (hasOpenPending()) await requestTaskboardOpen();
        continue;
      }
      if (idleAfterNormalExit) {
        if (!hasOpenPending()) continue;
        try {
          if (!(await startManagedCodex())) {
            if (nativeCodexBrowser) await requestTaskboardOpen();
            continue;
          }
          idleAfterNormalExit = false;
        } catch (restartError) {
          console.error(`Waiting to restart Codex: ${restartError.message}`);
          continue;
        }
      }
      try {
        const pendingOpenGeneration = openRequestGeneration;
        const shouldOpenNewConnection = false;
        const results = await injectAll(
          cdpRuntime,
          source,
          sourceHash,
          shouldOpenNewConnection,
          null,
          injectedTargets,
          true,
          supervisor,
          options.attachExisting,
          options.startupToken,
          async (connection, _target, { opened }) => {
            if (opened) {
              openedRequestGeneration = Math.max(
                openedRequestGeneration,
                pendingOpenGeneration,
              );
              activateCodexApp(codexAppPid);
            }
            if (hasOpenPending()) await requestTaskboardOpen(connection);
          },
        );
        if (results.length > 0) {
          console.log(JSON.stringify({ injected: results }, null, 2));
        }
        if (hasOpenPending()) {
          await requestTaskboardOpen();
        }
      } catch (error) {
        if (stopping) break;
        if (options.cdpPipe && !cdpRuntime.isHealthy()) {
          const launchedCodex = codexProcess;
          if (
            launchedCodex
            && launchedCodex.exitCode === null
            && launchedCodex.signalCode === null
          ) {
            await Promise.race([
              new Promise((resolve) => launchedCodex.once("exit", resolve)),
              new Promise((resolve) => setTimeout(resolve, 250)),
            ]);
          }
          if (launchedCodex?.exitCode === 0) {
            injectedTargets.forEach((connection) => {
              unregisterQuotaPolicyCdp(connection);
              connection.close();
            });
            injectedTargets.clear();
            cdpRuntime.close();
            cdpRuntime = null;
            codexProcess = null;
            idleAfterNormalExit = true;
            console.error(
              "Waiting for Codex after normal exit; open Codex Taskboard again to restart it.",
            );
            continue;
          }
          if (
            !launchedCodex
            || (launchedCodex.exitCode === null && launchedCodex.signalCode === null)
          ) {
            throw error;
          }
        }
        const launchedCodexExited = options.cdpPipe
          ? codexProcess
            && (codexProcess.exitCode !== null || codexProcess.signalCode !== null)
          : codexAppPid && !codexAppProcesses(options.appPath)
            .some((record) => record.pid === codexAppPid);
        if (launchedCodexExited) {
          injectedTargets.forEach((connection) => {
            unregisterQuotaPolicyCdp(connection);
            connection.close();
          });
          injectedTargets.clear();
          cdpRuntime?.close();
          cdpRuntime = null;
          if (options.cdpPipe) {
            const exitCode = codexProcess.exitCode;
            codexProcess = null;
            if (exitCode === 0) {
              idleAfterNormalExit = true;
              console.error(
                "Waiting for Codex after normal exit; open Codex Taskboard again to restart it.",
              );
              continue;
            }
            console.error("Codex exited unexpectedly; restarting it for the taskboard launcher.");
            try {
              await startManagedCodex();
              if (options.open) openRequestGeneration += 1;
            } catch (restartError) {
              console.error(`Waiting to restart Codex: ${restartError.message}`);
            }
            continue;
          }
          managedCodex = null;
          codexAppPid = null;
          idleAfterNormalExit = true;
          console.error(
            "Waiting for Codex after exit; open Codex Taskboard again to restart it.",
          );
          continue;
        }
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
  } finally {
    if (options.watch) {
      process.removeListener("SIGINT", requestStop);
      process.removeListener("SIGTERM", requestStop);
      if (process.platform === "win32") openControl?.close();
      else process.removeListener("SIGUSR2", queueTaskboardOpen);
      await cleanup();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
