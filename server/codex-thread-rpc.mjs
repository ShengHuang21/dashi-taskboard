import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const LOCAL_CODEX_HOST_ID = "local";
const SERVER_REQUEST_NOT_SUPPORTED = -32601;
const RETIRED_TRANSPORT_ERROR_CODES = new Set([
  "CODEX_THREAD_RPC_TIMEOUT",
  "CODEX_APP_SERVER_REQUEST_TIMEOUT",
  "CODEX_APP_SERVER_CLOSED",
  "CODEX_APP_SERVER_EXITED",
  "CODEX_APP_SERVER_PROCESS_ERROR",
  "CODEX_APP_SERVER_INVALID_JSON",
]);

function rpcError(message, code, cause) {
  const error = new CodexThreadRpcTransportError(message, code);
  if (cause !== undefined) error.cause = cause;
  return error;
}

export class CodexThreadRpcTransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CodexThreadRpcTransportError";
    this.code = code;
  }
}

export class LocalCodexThreadRpcTransport {
  constructor({ appServer } = {}) {
    if (typeof appServer?.request !== "function" || typeof appServer?.close !== "function") {
      throw new TypeError("Local Codex thread RPC requires an app-server request and close lifecycle");
    }
    this.appServer = appServer;
    this.closed = false;
    this.closePromise = null;
    this.pending = new Set();
  }

  get pendingRequestCount() {
    return this.pending.size;
  }

  request(codexHostId, method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(new CodexThreadRpcTransportError(
        "Local Codex thread RPC is closed",
        "CODEX_THREAD_RPC_CLOSED",
      ));
    }
    if (codexHostId !== LOCAL_CODEX_HOST_ID) {
      return Promise.reject(new CodexThreadRpcTransportError(
        "Local Codex thread RPC only supports the exact local Codex host",
        "UNSUPPORTED_CODEX_HOST",
      ));
    }
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new TypeError("Local Codex thread RPC method is required"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError("Local Codex thread RPC timeout must be positive"));
    }

    return new Promise((resolve, reject) => {
      const entry = { settled: false, timer: null, reject };
      const settle = (callback, value) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(entry);
        callback(value);
      };
      entry.settle = settle;
      entry.timer = setTimeout(() => {
        settle(reject, new CodexThreadRpcTransportError(
          `Local Codex thread RPC '${method}' timed out`,
          "CODEX_THREAD_RPC_TIMEOUT",
        ));
      }, timeoutMs);
      this.pending.add(entry);

      Promise.resolve()
        .then(() => (entry.settled
          ? undefined
          : this.appServer.request(method, params, timeoutMs)))
        .then(
          (result) => settle(resolve, result),
          (error) => settle(reject, error),
        );
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const error = new CodexThreadRpcTransportError(
      "Local Codex thread RPC is closed",
      "CODEX_THREAD_RPC_CLOSED",
    );
    for (const entry of [...this.pending]) entry.settle(entry.reject, error);
    this.closePromise = Promise.resolve().then(() => this.appServer.close());
    return this.closePromise;
  }
}

export function createLocalCodexThreadRpcTransport(options) {
  return new LocalCodexThreadRpcTransport(options);
}

export function shouldRetireLocalCodexThreadRpcTransport(error) {
  return RETIRED_TRANSPORT_ERROR_CODES.has(error?.code);
}

export class LocalCodexThreadRpcLifecycle {
  constructor({ launchTransport } = {}) {
    if (typeof launchTransport !== "function") {
      throw new TypeError("Local Codex thread RPC lifecycle requires a launch function");
    }
    this.launchTransport = launchTransport;
    this.transport = null;
    this.retirementError = null;
    this.closed = false;
    this.closePromise = null;
    this.tail = Promise.resolve();
  }

  get currentTransport() {
    return this.transport;
  }

  #enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  #closedError() {
    return rpcError(
      "Local Codex thread RPC lifecycle is closed",
      "CODEX_THREAD_RPC_LIFECYCLE_CLOSED",
    );
  }

  ensure() {
    return this.#enqueue(async () => {
      if (this.closed) throw this.#closedError();
      if (this.transport && !this.transport.closed) return this.transport;
      if (this.transport) {
        throw rpcError(
          "Previous local Codex thread RPC transport did not retire cleanly",
          "CODEX_THREAD_RPC_RETIRE_FAILED",
          this.retirementError,
        );
      }

      const transport = await this.launchTransport();
      if (typeof transport?.request !== "function" || typeof transport?.close !== "function") {
        throw new TypeError("Local Codex thread RPC launch returned an invalid transport");
      }
      if (this.closed) {
        await transport.close();
        throw this.#closedError();
      }
      this.transport = transport;
      this.retirementError = null;
      return transport;
    });
  }

  retire(expectedTransport) {
    return this.#enqueue(async () => {
      if (!expectedTransport || this.transport !== expectedTransport) return false;
      try {
        await expectedTransport.close();
      } catch (error) {
        this.retirementError = error;
        throw error;
      }
      if (this.transport === expectedTransport) {
        this.transport = null;
        this.retirementError = null;
      }
      return true;
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.#enqueue(async () => {
      const transport = this.transport;
      if (!transport) return;
      try {
        await transport.close();
      } catch (error) {
        this.retirementError = error;
        throw error;
      }
      if (this.transport === transport) {
        this.transport = null;
        this.retirementError = null;
      }
    });
    return this.closePromise;
  }
}

export function shouldUseLocalCodexThreadRpc({
  platform = process.platform,
  watch = false,
  launch = false,
  cdpPipe = false,
} = {}) {
  return platform === "darwin" && watch === true && launch === true && cdpPipe !== true;
}

export function selectCodexThreadRpcRoute({
  localEnabled = false,
  codexHostId,
} = {}) {
  return localEnabled === true && codexHostId === LOCAL_CODEX_HOST_ID
    ? "local"
    : "renderer";
}

export class CodexAppServerJsonLineClient {
  constructor({ child, onServerRequest } = {}) {
    if (
      !child?.stdin || typeof child.stdin.write !== "function"
      || !child?.stdout || typeof child.stdout.on !== "function"
      || typeof child.once !== "function" || typeof child.kill !== "function"
    ) {
      throw new TypeError("Codex app-server client requires one spawned process");
    }
    if (onServerRequest !== undefined && typeof onServerRequest !== "function") {
      throw new TypeError("Codex app-server server-request observer must be a function");
    }
    this.child = child;
    this.onServerRequest = onServerRequest ?? (() => {});
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.closePromise = null;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.#handleLine(line));
    child.stdin.on("error", (error) => this.#fail(rpcError(
      "Codex app-server input failed",
      "CODEX_APP_SERVER_PROCESS_ERROR",
      error,
    )));
    child.once("error", (error) => this.#fail(rpcError(
      "Codex app-server process failed",
      "CODEX_APP_SERVER_PROCESS_ERROR",
      error,
    )));
    child.once("exit", (code, signal) => {
      this.resolveExit({ code, signal });
      if (!this.closed) {
        this.#fail(rpcError(
          `Codex app-server exited (${signal || code || 0})`,
          "CODEX_APP_SERVER_EXITED",
        ));
      }
    });
  }

  get pendingRequestCount() {
    return this.pending.size;
  }

  #write(message) {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw rpcError("Codex app-server is closed", "CODEX_APP_SERVER_CLOSED");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#fail(rpcError(
        "Codex app-server returned invalid JSON",
        "CODEX_APP_SERVER_INVALID_JSON",
        error,
      ));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;

    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      try {
        this.onServerRequest(message.method);
      } catch (_) {}
      try {
        this.#write({
          id: message.id,
          error: {
            code: SERVER_REQUEST_NOT_SUPPORTED,
            message: "Taskboard headless transport does not handle Codex server requests",
          },
        });
      } catch (_) {}
      return;
    }

    if (!Object.hasOwn(message, "id")) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = rpcError(
        message.error.message || "Codex app-server request failed",
        message.error.code ?? "CODEX_APP_SERVER_REQUEST_FAILED",
      );
      error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  request(method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(rpcError(
        "Codex app-server is closed",
        "CODEX_APP_SERVER_CLOSED",
      ));
    }
    if (typeof method !== "string" || !method) {
      return Promise.reject(new TypeError("Codex app-server method is required"));
    }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new TypeError("Codex app-server request timeout must be positive"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(rpcError(
          `Codex app-server request '${method}' timed out`,
          "CODEX_APP_SERVER_REQUEST_TIMEOUT",
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (typeof method !== "string" || !method) {
      throw new TypeError("Codex app-server notification method is required");
    }
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    const error = rpcError("Codex app-server is closed", "CODEX_APP_SERVER_CLOSED");
    this.#fail(error);
    this.closePromise = (async () => {
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.kill("SIGTERM");
      const exited = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        const killed = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]);
        if (!killed && this.child.exitCode === null && this.child.signalCode === null) {
          throw rpcError(
            "Codex app-server did not exit after SIGKILL",
            "CODEX_APP_SERVER_TERMINATION_TIMEOUT",
          );
        }
      }
    })();
    return this.closePromise;
  }
}

export async function launchLocalCodexAppServer({
  executable,
  cwd,
  env = process.env,
  spawnProcess = spawn,
  onServerRequest,
  initializeTimeoutMs = 10_000,
} = {}) {
  if (typeof executable !== "string" || !executable) {
    throw new TypeError("Codex app-server executable is required");
  }
  if (!Number.isFinite(initializeTimeoutMs) || initializeTimeoutMs <= 0) {
    throw new TypeError("Codex app-server initialize timeout must be positive");
  }
  const child = spawnProcess(
    executable,
    ["app-server", "--listen", "stdio://"],
    {
      cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const client = new CodexAppServerJsonLineClient({ child, onServerRequest });
  let initializeTimer;
  try {
    await Promise.race([
      client.request("initialize", {
        clientInfo: {
          name: "codex-taskboard-headless",
          title: "Codex Taskboard",
          version: "1",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      new Promise((_, reject) => {
        initializeTimer = setTimeout(() => reject(rpcError(
          "Codex app-server initialize timed out",
          "CODEX_APP_SERVER_INITIALIZE_TIMEOUT",
        )), initializeTimeoutMs);
      }),
    ]);
    client.notify("initialized");
    return client;
  } catch (error) {
    await client.close();
    throw error;
  } finally {
    clearTimeout(initializeTimer);
  }
}
