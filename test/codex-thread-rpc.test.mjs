import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  CodexAppServerJsonLineClient,
  CodexThreadRpcTransportError,
  LocalCodexThreadRpcLifecycle,
  createLocalCodexThreadRpcTransport,
  launchLocalCodexAppServer,
  shouldRetireLocalCodexThreadRpcTransport,
  shouldUseLocalCodexThreadRpc,
} from "../server/codex-thread-rpc.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

class NeverExitChild extends FakeChild {
  constructor() {
    super();
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }
}

function readJsonLines(stream, onMessage) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
}

test("local Codex thread RPC forwards the exact request", async () => {
  const calls = [];
  const appServer = {
    async request(method, params) {
      calls.push({ method, params });
      return { thread: { id: "thread-local" } };
    },
    async close() {},
  };
  const transport = createLocalCodexThreadRpcTransport({ appServer });

  assert.deepEqual(
    await transport.request("local", "thread/read", {
      threadId: "thread-local",
      includeTurns: true,
    }, 100),
    { thread: { id: "thread-local" } },
  );
  assert.deepEqual(calls, [{
    method: "thread/read",
    params: { threadId: "thread-local", includeTurns: true },
  }]);
  assert.equal(transport.pendingRequestCount, 0);
  await transport.close();
});

test("local Codex thread RPC rejects empty and remote hosts without forwarding", async () => {
  let calls = 0;
  const transport = createLocalCodexThreadRpcTransport({
    appServer: {
      async request() { calls += 1; },
      async close() {},
    },
  });

  for (const hostId of ["", "remote-host", null]) {
    await assert.rejects(
      transport.request(hostId, "thread/read", { threadId: "thread-local" }, 100),
      (error) => error instanceof CodexThreadRpcTransportError
        && error.code === "UNSUPPORTED_CODEX_HOST",
    );
  }
  assert.equal(calls, 0);
  assert.equal(transport.pendingRequestCount, 0);
  await transport.close();
});

test("local Codex thread RPC times out and releases its pending request", async () => {
  const request = deferred();
  const transport = createLocalCodexThreadRpcTransport({
    appServer: {
      request() { return request.promise; },
      async close() {},
    },
  });

  await assert.rejects(
    transport.request("local", "turn/start", { threadId: "thread-local" }, 10),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_THREAD_RPC_TIMEOUT",
  );
  assert.equal(transport.pendingRequestCount, 0);

  request.resolve({ turn: { id: "late-turn" } });
  await transport.close();
});

test("local Codex thread RPC retires either timeout source without blind retry", () => {
  for (const code of [
    "CODEX_THREAD_RPC_TIMEOUT",
    "CODEX_APP_SERVER_REQUEST_TIMEOUT",
    "CODEX_APP_SERVER_CLOSED",
    "CODEX_APP_SERVER_EXITED",
    "CODEX_APP_SERVER_PROCESS_ERROR",
    "CODEX_APP_SERVER_INVALID_JSON",
  ]) {
    assert.equal(shouldRetireLocalCodexThreadRpcTransport({ code }), true, code);
  }
  for (const code of [
    "CODEX_APP_SERVER_REQUEST_FAILED",
    "UNSUPPORTED_CODEX_HOST",
    undefined,
  ]) {
    assert.equal(shouldRetireLocalCodexThreadRpcTransport({ code }), false, code);
  }
});

test("local Codex thread RPC serializes concurrent retirement before replacement", async () => {
  const firstClose = deferred();
  const events = [];
  let launches = 0;
  let activeServers = 0;
  let maximumActiveServers = 0;
  const lifecycle = new LocalCodexThreadRpcLifecycle({
    async launchTransport() {
      launches += 1;
      activeServers += 1;
      maximumActiveServers = Math.max(maximumActiveServers, activeServers);
      const generation = launches;
      return createLocalCodexThreadRpcTransport({
        appServer: {
          async request() {},
          async close() {
            events.push(`close-start:${generation}`);
            if (generation === 1) await firstClose.promise;
            activeServers -= 1;
            events.push(`close-finish:${generation}`);
          },
        },
      });
    },
  });

  const first = await lifecycle.ensure();
  const retirement = Promise.all([
    lifecycle.retire(first),
    lifecycle.retire(first),
    lifecycle.retire(first),
  ]);
  const replacementPromises = [lifecycle.ensure(), lifecycle.ensure()];
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(launches, 1);
  assert.equal(activeServers, 1);
  assert.equal(lifecycle.currentTransport, first);
  assert.deepEqual(events, ["close-start:1"]);

  firstClose.resolve();
  await retirement;
  const [replacement, concurrentReplacement] = await Promise.all(replacementPromises);
  assert.notEqual(replacement, first);
  assert.equal(concurrentReplacement, replacement);
  assert.equal(launches, 2);
  assert.equal(maximumActiveServers, 1);
  assert.deepEqual(events.slice(0, 2), ["close-start:1", "close-finish:1"]);

  await lifecycle.close();
  assert.equal(activeServers, 0);
});

test("local Codex thread RPC refuses replacement when the old child never exits", {
  timeout: 7_000,
}, async () => {
  const child = new NeverExitChild();
  let launches = 0;
  const lifecycle = new LocalCodexThreadRpcLifecycle({
    async launchTransport() {
      launches += 1;
      return createLocalCodexThreadRpcTransport({
        appServer: launches === 1
          ? new CodexAppServerJsonLineClient({ child })
          : { async request() {}, async close() {} },
      });
    },
  });

  const first = await lifecycle.ensure();
  await assert.rejects(
    lifecycle.retire(first),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_APP_SERVER_TERMINATION_TIMEOUT",
  );
  await assert.rejects(
    lifecycle.ensure(),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_THREAD_RPC_RETIRE_FAILED",
  );
  assert.equal(lifecycle.currentTransport, first);
  assert.equal(launches, 1);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("local Codex thread RPC preserves app-server request rejection", async () => {
  const rejection = new Error("app-server rejected turn/start");
  const transport = createLocalCodexThreadRpcTransport({
    appServer: {
      async request() { throw rejection; },
      async close() {},
    },
  });

  await assert.rejects(
    transport.request("local", "turn/start", { threadId: "thread-local" }, 100),
    (error) => error === rejection,
  );
  assert.equal(transport.pendingRequestCount, 0);
  await transport.close();
});

test("local Codex thread RPC close is idempotent and rejects pending work", async () => {
  const request = deferred();
  let closeCalls = 0;
  let requestCalls = 0;
  const transport = createLocalCodexThreadRpcTransport({
    appServer: {
      request() {
        requestCalls += 1;
        return request.promise;
      },
      async close() { closeCalls += 1; },
    },
  });
  const pending = transport.request(
    "local",
    "thread/read",
    { threadId: "thread-local" },
    1_000,
  );

  await Promise.all([transport.close(), transport.close()]);
  await assert.rejects(
    pending,
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_THREAD_RPC_CLOSED",
  );
  assert.equal(requestCalls, 0);
  assert.equal(closeCalls, 1);
  assert.equal(transport.pendingRequestCount, 0);
  await assert.rejects(
    transport.request("local", "thread/read", { threadId: "thread-local" }, 100),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_THREAD_RPC_CLOSED",
  );

  request.resolve({ thread: { id: "thread-local" } });
});

test("single-visible-app mode uses headless RPC only for the resident macOS launcher", () => {
  assert.equal(shouldUseLocalCodexThreadRpc({
    platform: "darwin", watch: true, launch: true, cdpPipe: false,
  }), true);
  assert.equal(shouldUseLocalCodexThreadRpc({
    platform: "darwin", watch: false, launch: true, cdpPipe: false,
  }), false);
  assert.equal(shouldUseLocalCodexThreadRpc({
    platform: "linux", watch: true, launch: true, cdpPipe: true,
  }), false);
});

test("headless app-server initializes once and rejects server requests without approval", async () => {
  const child = new FakeChild();
  const clientMessages = [];
  const serverRequests = [];
  readJsonLines(child.stdin, (message) => {
    clientMessages.push(message);
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        result: {
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
          userAgent: "test",
        },
      })}\n`);
    }
  });

  const client = await launchLocalCodexAppServer({
    executable: "/test/codex",
    cwd: "/test/taskboard",
    spawnProcess(executable, args, options) {
      assert.equal(executable, "/test/codex");
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      assert.equal(options.cwd, "/test/taskboard");
      return child;
    },
    onServerRequest: (method) => serverRequests.push(method),
  });
  assert.equal(clientMessages[0].method, "initialize");
  assert.deepEqual(clientMessages[0].params.clientInfo, {
    name: "codex-taskboard-headless",
    title: "Codex Taskboard",
    version: "1",
  });
  assert.equal(clientMessages[1].method, "initialized");

  child.stdout.write(`${JSON.stringify({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "unsafe" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(serverRequests, ["item/commandExecution/requestApproval"]);
  assert.deepEqual(clientMessages[2], {
    id: "approval-1",
    error: {
      code: -32601,
      message: "Taskboard headless transport does not handle Codex server requests",
    },
  });
  await client.close();
});

test("headless app-server client forwards thread RPC and rejects malformed protocol", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerJsonLineClient({ child });
  const messages = [];
  readJsonLines(child.stdin, (message) => messages.push(message));

  const read = client.request("thread/read", {
    threadId: "thread-local",
    includeTurns: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    id: messages[0].id,
    result: { thread: { id: "thread-local" } },
  })}\n`);
  assert.deepEqual(await read, { thread: { id: "thread-local" } });

  const pending = client.request("model/list", { limit: 100 });
  child.stdout.write("not-json\n");
  await assert.rejects(
    pending,
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_APP_SERVER_INVALID_JSON",
  );
  assert.equal(client.pendingRequestCount, 0);
  await client.close();
});

test("headless app-server request timeout releases its protocol request", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerJsonLineClient({ child });
  await assert.rejects(
    client.request("thread/read", { threadId: "thread-local" }, 10),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT",
  );
  assert.equal(client.pendingRequestCount, 0);
  await client.close();
});

test("headless app-server terminates a child that never completes initialization", async () => {
  const child = new FakeChild();
  await assert.rejects(
    launchLocalCodexAppServer({
      executable: "/test/codex",
      cwd: "/test/taskboard",
      spawnProcess: () => child,
      initializeTimeoutMs: 10,
    }),
    (error) => error instanceof CodexThreadRpcTransportError
      && error.code === "CODEX_APP_SERVER_INITIALIZE_TIMEOUT",
  );
  assert.equal(child.signalCode, "SIGTERM");
});
