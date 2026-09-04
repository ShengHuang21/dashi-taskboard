import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import vm from "node:vm";

import { coordinatorThreadSelectionConfirmed } from "../scripts/codex-injector-runtime.mjs";

const source = (await readFile(
  new URL("../scripts/codex-injector.mjs", import.meta.url),
  "utf8",
)).replace(/\r\n/g, "\n");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../scripts/taskboard-supervisor.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector authenticates its launcher-managed Taskboard service", () => {
  assert.match(supervisorSource, /function createTaskboardSupervisor/);
  assert.match(source, /CODEX_TASKBOARD_INSTANCE_TOKEN/);
  assert.match(source, /createHmac\("sha256"/);
  assert.match(source, /x-codex-taskboard-challenge/);
  assert.match(source, /proof/);
  assert.match(source, /taskboardInstanceSecret/);
  assert.match(source, /Page\.setDocumentContent/);
  assert.match(source, /<base href=/);
  assert.match(source, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.action === "load-frame"/);
  assert.match(supervisorSource, /ensureInFlight/);
  assert.match(supervisorSource, /await terminateManagedChild\(managedChild\)/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
  assert.match(source, /__CODEX_TASKBOARD_FRAME_CAPABILITY__/);
  assert.match(runtimeSource, /request\.frameCapability/);
});

test("the CDP bridge accepts service ensure and native task conversation start actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV1"/);
  assert.match(source, /hostRequestQueueName/);
  assert.match(source, /async \(\) => \{[\s\S]*?queue\.splice\(0, queue\.length\)/);
  assert.match(source, /setInterval\(\(\) => void pollHostRequestQueue\(\), 50\)/);
  assert.match(source, /Fetch\.enable/);
  assert.match(source, /requestUrl\.startsWith\(`\$\{taskboardBaseUrl\}\//);
  assert.match(source, /Fetch\.fulfillRequest/);
  assert.match(source, /access-control-allow-private-network/);
  assert.match(source, /contextId: activeMainContextId/);
  assert.match(source, /corsOrigin = browserOrigin === "app:\/\/-" \? "app:\/\/-" : "null"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "start-task-conversation"/);
  assert.match(runtimeSource, /request\.action === "open-external"/);
  assert.match(runtimeSource, /request\.taskId/);
  assert.match(runtimeSource, /request\.previousThreadId\.length <= 240/);
  assert.match(runtimeSource, /request\.codexHostId\.length <= 240/);
  assert.match(runtimeSource, /request\.targetRoot\.length <= 4_096/);
  assert.match(runtimeSource, /payload\.length > 4_194_304/);
  assert.match(runtimeSource, /request\.instruction\.length <= 4_000_000/);
  assert.match(runtimeSource, /request\.title\.length <= 240/);
  assert.match(source, /async function startTaskConversationViaCdp/);
  assert.match(source, /data-composer-placement="home"/);
  assert.match(source, /\(editor\.innerText \|\| ""\) !== \$\{JSON\.stringify\(instruction\)\}/);
  assert.doesNotMatch(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyDown",\s*key: "Enter"/,
  );
  assert.match(
    source,
    /cdp\.send\("Input\.dispatchKeyEvent", \{\s*type: "keyUp",\s*key: "Enter"/,
  );
  assert.match(source, /submitted = true/);
  assert.match(source, /if \(!submitted\) throw new Error/);
  assert.match(source, /const threadId = typeof started\.result\.value === "string"/);
  assert.match(source, /threadId && threadId !== previousThreadId/);
  assert.match(source, /discoveredThreadId = threadId/);
  assert.match(source, /error\.threadId = discoveredThreadId/);
  assert.match(source, /function requestCodexAppServerViaCdp/);
  assert.match(source, /type: "mcp-request"/);
  assert.match(source, /hostId: \$\{JSON\.stringify\(hostId\)\}/);
  assert.match(source, /"thread\/read"/);
  assert.match(source, /normalizeWorkspaceRoot\(result\.thread\.cwd\) === normalizedTargetRoot/);
  assert.match(source, /"thread\/name\/set"/);
  assert.match(source, /result\.thread\.name === title/);
  assert.match(source, /const taskConversationOperations = new Map\(\)/);
  assert.match(source, /taskConversationOperations\.get\(request\.taskId\)/);
  assert.match(source, /const taskConversationAppServerTimeoutMs = 30_000/);
  assert.doesNotMatch(source, /window\.postMessage\(\{ type: "rename-thread" \}/);
  assert.match(source, /return \{ threadId, title \}/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(source, /Page\.createIsolatedWorld/);
  assert.match(source, /Runtime\.addBinding", \{\s*name: hostBindingName,\s*executionContextId:/);
  assert.match(source, /params\.executionContextId !== activeContextId/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(runtimeSource, /threadId: error\.threadId/);
  assert.match(source, /hostResponseMessage/);
  assert.match(source, /if \(keepAlive\) await hostBridge\.install\(\)/);
  assert.match(source, /hostBridge\.publishHeartbeat/);
  assert.match(source, /withoutTaskboardLauncherEnvironment\(process\.env\)/);
});

test("reinstalling the CDP host bridge preserves queued requests", () => {
  const start = source.indexOf("function initializeHostRequestQueueExpression");
  const end = source.indexOf("async function applyTaskboardAutomationPolicy", start);
  assert.notEqual(start, -1, "host queue initializer must exist");
  assert.notEqual(end, -1, "host queue initializer source boundary must exist");
  const initializerSource = source.slice(start, end);
  const initializeHostRequestQueueExpression = vm.runInNewContext(
    `(() => { ${initializerSource}; return initializeHostRequestQueueExpression; })()`,
  );
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(initializeHostRequestQueueExpression("__queue"), context);
  window.__queue.push({ id: "queued-before-reinstall" });
  vm.runInContext(initializeHostRequestQueueExpression("__queue"), context);
  assert.equal(window.__queue.length, 1);
  assert.equal(window.__queue[0].id, "queued-before-reinstall");
});

test("the CDP network proxy preserves arbitrary binary attachment bytes", async (t) => {
  const start = source.indexOf("function taskboardRequestBody");
  const end = source.indexOf("async function injectTarget", start);
  assert.notEqual(start, -1, "binary-safe request body helper must exist");
  assert.notEqual(end, -1, "proxy helper source boundary must exist");
  const proxySource = source.slice(start, end);
  const { proxyTaskboardRequest } = vm.runInNewContext(
    `(() => { ${proxySource}; return { proxyTaskboardRequest }; })()`,
    { Buffer, fetch },
  );
  const expected = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x0d, 0x0a, 0x41]);
  let stored = Buffer.alloc(0);
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stored = Buffer.concat(chunks);
      response.writeHead(201, { "content-type": "application/octet-stream" });
      response.end(stored);
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(stored);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/attachment`;
  const upload = await proxyTaskboardRequest(url, {
    method: "POST",
    postData: expected.toString("utf8"),
    postDataEntries: [{ bytes: expected.toString("base64") }],
  }, [["content-type", "application/octet-stream"]]);
  assert.equal(upload.status, 201);
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), expected);
  const download = await proxyTaskboardRequest(url, { method: "GET" }, []);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), expected);
});

test("a ready injected connection can consume open work before a later renderer finishes", async () => {
  const start = source.indexOf("async function injectAll");
  const end = source.indexOf("async function currentInjectionSource", start);
  assert.notEqual(start, -1, "injectAll must exist");
  assert.notEqual(end, -1, "injectAll source boundary must exist");

  let releaseLaterRenderer;
  let laterRendererReleased = false;
  const injectTarget = async (_runtime, target) => {
    if (target.id === "later") {
      await new Promise((resolve) => { releaseLaterRenderer = resolve; });
    }
    return {
      result: { frameReady: true },
      connection: { id: target.id, closed: false, close() {} },
    };
  };
  const injectAll = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return injectAll; })()`,
    { injectTarget, Set },
  );
  const injectedTargets = new Map();
  const readyBeforeLaterRenderer = [];
  const batch = injectAll(
    { targets: async () => [{ id: "ready" }, { id: "later" }] },
    "source",
    "hash",
    true,
    null,
    injectedTargets,
    true,
    {},
    false,
    "startup-token",
    async (connection, target, { opened }) => {
      readyBeforeLaterRenderer.push({
        id: target.id,
        laterRendererReleased,
        retained: injectedTargets.get(target.id) === connection,
        opened,
      });
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  laterRendererReleased = true;
  releaseLaterRenderer();
  await batch;

  assert.deepEqual(readyBeforeLaterRenderer[0], {
    id: "ready",
    laterRendererReleased: false,
    retained: true,
    opened: true,
  });
});

test("Coordinator selection delegates to the injected identity-aware API and fails closed", async () => {
  const start = source.indexOf("async function requestCoordinatorThreadSelection");
  const end = source.indexOf("\n\nasync function waitForCoordinatorThreadSelection", start);
  assert.notEqual(start, -1, "Coordinator selection request helper must exist");
  const requestCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return requestCoordinatorThreadSelection; })()`,
  );
  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";

  for (const taskboard of [undefined, {}, { selectNativeThread: () => false }]) {
    const cdp = {
      send: async (_method, request) => ({
        result: {
          value: await vm.runInNewContext(request.expression, {
            window: { __codexTaskboardInjection__: taskboard },
            document: { documentElement: { hasAttribute: () => false } },
          }),
        },
      }),
    };
    assert.equal(await requestCoordinatorThreadSelection(cdp, coordinator), false);
  }

  let selectedThreadId = null;
  let closeRestoreFocus = null;
  const cdp = {
    send: async (_method, request) => ({
      result: {
        value: await vm.runInNewContext(request.expression, {
          window: {
            __codexTaskboardInjection__: {
              close(restoreFocus) {
                closeRestoreFocus = restoreFocus;
              },
              selectNativeThread(threadId) {
                selectedThreadId = threadId;
                return true;
              },
            },
          },
          document: { documentElement: { hasAttribute: () => true } },
        }),
      },
    }),
  };
  assert.equal(await requestCoordinatorThreadSelection(cdp, coordinator), true);
  assert.equal(closeRestoreFocus, false);
  assert.equal(selectedThreadId, coordinator);
});

test("Coordinator panel preparation rejects stale generations before commit", async () => {
  const start = source.indexOf("async function prepareInjectedNativeOpen");
  const end = source.indexOf("\n\nasync function completeSuccessfulTaskboardOpen", start);
  assert.notEqual(start, -1, "injected panel preparation helper must exist");
  const requestPreparedTaskboardOpen = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return requestPreparedTaskboardOpen; })()`,
  );
  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  let generation = 1;
  let releaseA;
  const commits = [];
  const taskboard = {
    prepareNativeThreadOpen: (threadId) => threadId === coordinator
      ? new Promise((resolve) => { releaseA = () => resolve("token-a"); })
      : "token-b",
    commitPreparedNativeOpen: (token) => {
      commits.push(token);
      return true;
    },
  };
  const cdp = {
    send: async (_method, request) => ({
      result: {
        value: await vm.runInNewContext(request.expression, {
          window: { __codexTaskboardInjection__: taskboard },
        }),
      },
    }),
  };
  const staleA = requestPreparedTaskboardOpen(cdp, coordinator, 1, () => generation);
  await new Promise((resolve) => setImmediate(resolve));
  generation = 2;
  releaseA();
  assert.equal(await staleA, false);
  assert.deepEqual(commits, []);

  const coordinatorB = "01a004bd-a749-7b53-81e2-af2d477f93af";
  assert.equal(await requestPreparedTaskboardOpen(cdp, coordinatorB, 2, () => generation), true);
  assert.deepEqual(commits, ["token-b"]);

  for (const missing of [undefined, {}, { prepareNativeThreadOpen: () => null }]) {
    const missingCdp = {
      send: async (_method, request) => ({
        result: { value: await vm.runInNewContext(request.expression, {
          window: { __codexTaskboardInjection__: missing },
        }) },
      }),
    };
    assert.equal(
      await requestPreparedTaskboardOpen(missingCdp, coordinatorB, 2, () => generation),
      false,
    );
  }
});

test("a delayed Coordinator active row keeps the launch panel gate closed", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function renewCoordinatorLease", start);
  assert.notEqual(start, -1, "Coordinator selection helper must exist");
  assert.notEqual(end, -1, "Coordinator selection helper boundary must exist");
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date,
      JSON,
      setTimeout: (resolve) => setImmediate(resolve),
      codexThreadIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    },
  );

  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const owner = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  let releaseActiveRow;
  let selectionChecks = 0;
  let navigationRequests = 0;
  let coordinatorRowClicks = 0;
  let routeFallbacks = 0;
  let panelOpens = 0;
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("native-sidebar-selection-readiness")) {
        return { result: { value: owner } };
      }
      if (request.expression.includes("selectNativeThread")) {
        assert.match(request.expression, new RegExp(coordinator));
        navigationRequests += 1;
        coordinatorRowClicks += 1;
        return { result: { value: true } };
      }
      selectionChecks += 1;
      if (selectionChecks === 1) {
        return { result: { value: { activeThreadId: owner, routeThreadId: coordinator } } };
      }
      await new Promise((resolve) => { releaseActiveRow = resolve; });
      return { result: { value: {
        activeThreadId: coordinator,
        routeThreadId: coordinator,
      } } };
    },
  };

  const gatedOpen = (async () => {
    if (await waitForCoordinatorThreadSelection(cdp, coordinator, 1_000, 0, 0)) panelOpens += 1;
  })();
  while (!releaseActiveRow) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panelOpens, 0);
  assert.equal(navigationRequests, 1);
  assert.equal(coordinatorRowClicks, 1);
  assert.equal(routeFallbacks, 0);
  releaseActiveRow();
  await gatedOpen;
  assert.equal(panelOpens, 1);
  assert.equal(selectionChecks, 2);
});

test("Coordinator launch falls back to the supported route message when its row is absent", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date,
      JSON,
      setTimeout: (resolve) => setImmediate(resolve),
      codexThreadIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    },
  );
  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const owner = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  let selectionChecks = 0;
  let routeFallbacks = 0;
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("native-sidebar-selection-readiness")) {
        return { result: { value: owner } };
      }
      if (request.expression.includes("selectNativeThread")) {
        routeFallbacks += 1;
        return { result: { value: true } };
      }
      selectionChecks += 1;
      return { result: { value: selectionChecks === 1
        ? { activeThreadId: null, routeThreadId: null }
        : { activeThreadId: coordinator, routeThreadId: coordinator } } };
    },
  };

  assert.equal(await waitForCoordinatorThreadSelection(cdp, coordinator, 1_000, 0, 0), true);
  assert.equal(routeFallbacks, 1);
  assert.equal(selectionChecks, 2);
});

test("a newer open generation cancels an older Coordinator selection wait", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date,
      JSON,
      setTimeout: (resolve) => setImmediate(resolve),
      codexThreadIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    },
  );
  const coordinatorA = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const coordinatorB = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  let generation = 1;
  let releaseAObservation;
  const selections = [];
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("selectNativeThread")) {
        const target = request.expression.includes(coordinatorA) ? coordinatorA : coordinatorB;
        selections.push(target);
        return { result: { value: true } };
      }
      if (selections.at(-1) === coordinatorA) {
        await new Promise((resolve) => { releaseAObservation = resolve; });
        return { result: { value: { activeThreadId: coordinatorA, routeThreadId: coordinatorA } } };
      }
      return { result: { value: { activeThreadId: coordinatorB, routeThreadId: coordinatorB } } };
    },
  };
  const waitA = waitForCoordinatorThreadSelection(
    cdp, coordinatorA, 1_000, 0, 0, 0, () => generation === 1,
  );
  while (!releaseAObservation) await new Promise((resolve) => setImmediate(resolve));
  generation = 2;
  const waitB = waitForCoordinatorThreadSelection(
    cdp, coordinatorB, 1_000, 0, 0, 0, () => generation === 2,
  );
  assert.equal(await waitB, true);
  releaseAObservation();
  assert.equal(await waitA, false);
  assert.deepEqual(selections, [coordinatorA, coordinatorB]);
});

test("Coordinator launch reselects after hydration override and waits for stable active state", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  assert.doesNotMatch(source.slice(start, end), /waitForNativeSidebarSelectionReady/);
  let now = 0;
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date: { now: () => now },
      JSON,
      setTimeout: (resolve, delay) => {
        now += delay;
        setImmediate(resolve);
      },
    },
  );
  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  const owner = "01a050de-03c2-7f32-ba9c-4342b40ac18a";
  let selectionChecks = 0;
  let coordinatorRowClicks = 0;
  let panelOpens = 0;
  const activeSequence = [null, coordinator, owner, coordinator, coordinator, coordinator, coordinator];
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("selectNativeThread")) {
        assert.equal(panelOpens, 0);
        coordinatorRowClicks += 1;
        return { result: { value: true } };
      }
      assert.equal(panelOpens, 0);
      const activeThreadId = activeSequence[selectionChecks] ?? coordinator;
      selectionChecks += 1;
      return { result: { value: {
        activeThreadId,
        routeThreadId: activeThreadId,
      } } };
    },
  };

  if (await waitForCoordinatorThreadSelection(cdp, coordinator, 200, 30, 10, 10)) {
    panelOpens += 1;
  }
  assert.equal(coordinatorRowClicks, 2);
  assert.equal(selectionChecks, 7);
  assert.equal(panelOpens, 1);
});

test("Coordinator stability resets across an unknown selection read interval", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  let now = 0;
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date: { now: () => now },
      JSON,
      setTimeout: (resolve, delay) => {
        now += delay;
        setImmediate(resolve);
      },
    },
  );
  const coordinator = "01a004bd-a749-7b53-81e2-af2d477f93ae";
  let navigationRequests = 0;
  let selectionChecks = 0;
  let panelOpens = 0;
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("selectNativeThread")) {
        navigationRequests += 1;
        return { result: { value: true } };
      }
      selectionChecks += 1;
      if (selectionChecks === 2) {
        now += 40;
        throw new Error("selection state unavailable");
      }
      return { result: { value: {
        activeThreadId: coordinator,
        routeThreadId: coordinator,
      } } };
    },
  };

  if (await waitForCoordinatorThreadSelection(cdp, coordinator, 200, 30, 10, 10)) {
    panelOpens += 1;
  }
  assert.equal(navigationRequests, 2);
  assert.equal(selectionChecks, 6);
  assert.equal(panelOpens, 1);
});

test("continuous selection errors bound re-navigation and leave panel open pending", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  let now = 0;
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date: { now: () => now },
      JSON,
      setTimeout: (resolve, delay) => {
        now += delay;
        setImmediate(resolve);
      },
    },
  );
  let navigationRequests = 0;
  let panelOpens = 0;
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("selectNativeThread")) {
        navigationRequests += 1;
        return { result: { value: true } };
      }
      throw new Error("selection state unavailable");
    },
  };

  if (await waitForCoordinatorThreadSelection(
    cdp,
    "01a004bd-a749-7b53-81e2-af2d477f93ae",
    90_000,
    35_000,
    100,
    5_000,
  )) panelOpens += 1;
  assert.equal(navigationRequests, 18);
  assert.equal(panelOpens, 0);
});

test("Coordinator launch times out after proactively navigating from null Home", async () => {
  const start = source.indexOf("async function coordinatorThreadIsSelected");
  const end = source.indexOf("async function completeSuccessfulTaskboardOpen", start);
  const waitForCoordinatorThreadSelection = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return waitForCoordinatorThreadSelection; })()`,
    {
      coordinatorThreadSelectionConfirmed,
      Date,
      JSON,
      setTimeout: (resolve) => setImmediate(resolve),
    },
  );
  let navigationRequests = 0;
  const cdp = {
    closed: false,
    async send(_method, request) {
      if (request.expression.includes("selectNativeThread")) navigationRequests += 1;
      return { result: { value: null } };
    },
  };

  assert.equal(await waitForCoordinatorThreadSelection(
    cdp,
    "01a004bd-a749-7b53-81e2-af2d477f93ae",
    5,
    2,
    1,
  ), false);
  assert.equal(navigationRequests, 1);
});

test("a successful panel open consumes its generation despite foreground activation failure", async () => {
  const start = source.indexOf("async function completeSuccessfulTaskboardOpen");
  const end = source.indexOf("async function renewCoordinatorLease", start);
  assert.notEqual(start, -1, "successful open completion helper must exist");
  assert.notEqual(end, -1, "successful open completion helper boundary must exist");
  const completeSuccessfulTaskboardOpen = vm.runInNewContext(
    `(() => { ${source.slice(start, end)}; return completeSuccessfulTaskboardOpen; })()`,
  );

  const requestedGeneration = 4;
  let openedGeneration = 3;
  let panelOpenCalls = 1;
  const diagnostics = [];
  assert.equal(await completeSuccessfulTaskboardOpen({
    markOpened: () => { openedGeneration = requestedGeneration; },
    bringToFront: async () => { throw new Error("background bring-to-front denied"); },
    activate: () => { throw new Error("background activation denied"); },
    report: (message) => diagnostics.push(message),
  }), true);
  if (openedGeneration < requestedGeneration) panelOpenCalls += 1;

  assert.equal(openedGeneration, requestedGeneration);
  assert.equal(panelOpenCalls, 1);
  assert.equal(diagnostics.length, 2);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("passive automation policy keeps idle pauses and only resumes quota pauses", () => {
  assert.match(source, /taskboardAutomationPolicyOperation/);
  assert.match(source, /previousQuotaState: current\.quota\?\.state/);
  assert.match(source, /enqueueQuotaPolicyMutation\(record, rpc, \{ explicit: true \}\)/);
  assert.match(
    source,
    /!explicit && result\.operation === "list" && result\.item\?\.status === "PAUSED"/,
  );
  assert.match(source, /enabledByUser: false/);
  assert.match(source, /record\.quota \? \{ quota: record\.quota \} : \{\}/);
});

test("persisted automation policies retain remote project identity", () => {
  const storedPolicySource = source.slice(
    source.indexOf("function storedAutomationPolicy"),
    source.indexOf("function restoredAutomationPolicy"),
  );
  assert.match(storedPolicySource, /codexProjectKind: request\.codexProjectKind/);
  assert.match(storedPolicySource, /codexHostId: request\.codexHostId/);
  assert.match(storedPolicySource, /remoteProjects: request\.remoteProjects/);
});

test("automation list rebuilds a stored policy on the incoming project identity", async () => {
  const reconcileSource = source.slice(
    source.indexOf("async function reconcileStoredAutomationPolicy"),
    source.indexOf("async function enqueueCurrentQuotaPolicy"),
  );
  const storedRequest = {
    taskboardProjectId: "taskboard-project",
    codexProjectId: "old-project",
    codexProjectKind: "local",
    codexHostId: "local",
    projectName: "Old project",
    workspacePath: "/old/project",
    skillPath: "/old/skill/SKILL.md",
    automationId: "automation-1",
    enabledByUser: true,
    quotaAware: true,
    intervalMinutes: 15,
    model: "gpt-5.5",
    reasoningEffort: "high",
  };
  const incomingRequest = {
    ...storedRequest,
    codexProjectId: "remote-project",
    codexProjectKind: "remote",
    codexHostId: "remote-host",
    projectName: "Remote project",
    workspacePath: "/remote/project",
    remoteProjects: [{
      codexProjectId: "remote-worktree",
      codexProjectKind: "remote",
      codexHostId: "remote-host",
      workspacePath: "/remote/project-worktree",
    }],
    skillPath: "/new/skill/SKILL.md",
    enabledByUser: false,
    quotaAware: false,
    intervalMinutes: 5,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };
  let appliedRequest;
  const reconcileStoredAutomationPolicy = vm.runInNewContext(`(${reconcileSource})`, {
    ensureQuotaPoliciesLoaded: async () => {},
    quotaPolicyRecords: new Map([[
      storedRequest.taskboardProjectId,
      { request: storedRequest },
    ]]),
    updateAndApplyQuotaPolicy: async (request) => {
      appliedRequest = request;
      return { policy: request };
    },
    enqueueQuotaPolicyMutation: () => {
      throw new Error("stored target must not continue");
    },
    storedAutomationPolicy: (request) => request,
  });

  const result = await reconcileStoredAutomationPolicy(incomingRequest, () => {});
  assert.deepEqual(
    JSON.parse(JSON.stringify(appliedRequest)),
    {
      ...incomingRequest,
      automationId: "automation-1",
      enabledByUser: true,
      quotaAware: true,
      intervalMinutes: 15,
      model: "gpt-5.5",
      reasoningEffort: "high",
    },
  );
  assert.equal(result.policy, appliedRequest);
  assert.match(source, /reconcileStoredAutomationPolicy\(\s*request,\s*rpc/);
  assert.match(source, /policy: storedAutomationPolicy\(current\.request\)/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV1/);
});

test("launch mode opens a dedicated debuggable Codex instance beside the native app", () => {
  assert.match(
    source,
    /spawn\(\s*"\/usr\/bin\/open",\s*\[\s*"-n",\s*"-a",\s*appPath/,
  );
  assert.match(
    source,
    /if \(runningCodex\.length > 0\) \{[\s\S]*?if \(debuggingCodexFound\) return false;[\s\S]*?if \(!options\.launch\) \{[\s\S]*?nativeCodexBrowser = true;/,
  );
  assert.match(source, /startupTimeoutMs: 120_000,[\s\S]*?unhealthyChildGraceMs: 120_000,/);
  assert.match(source, /Timed out publishing the Taskboard host heartbeat[\s\S]*?30_000/);
  assert.match(source, /waitForHostHeartbeat\(cdp, startupToken, timeoutMs = 30_000\)/);
  assert.match(
    source,
    /const queueTaskboardOpen = \(\) => \{[\s\S]*?openRequestGeneration \+= 1;[\s\S]*?void requestTaskboardOpen\(\);/,
  );
  assert.match(source, /selectLaunchCoordinatorRoute/);
  assert.match(
    source,
    /requestCoordinatorThreadSelection[\s\S]*?selectNativeThread[\s\S]*?waitForCoordinatorThreadSelection[\s\S]*?prepareInjectedNativeOpen[\s\S]*?commitPreparedNativeOpen/,
  );
  assert.match(
    source,
    /const opened = launchCoordinatorRoute[\s\S]*?requestPreparedTaskboardOpen[\s\S]*?requestInjectedTaskboardOpen[\s\S]*?if \(!opened\)[\s\S]*?completeSuccessfulTaskboardOpen/,
  );
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
  assert.match(source, /async function waitForHostHeartbeat/);
  assert.match(source, /await waitForHostHeartbeat\(cdp, startupToken\)/);
  assert.match(source, /if \(shouldRemainOpen && \(!status\.frameReady \|\| !frameLoaded\)\)[\s\S]*?hostBridge\.publishHeartbeat\(\)[\s\S]*?__codexTaskboardInjection__\?\.open\(\)/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardBaseUrl = `\$\{taskboardOrigin\}\/\$\{encodeURIComponent\(taskboardInstanceToken\)\}`/);
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardBaseUrl\}\/\?host=codex`/);
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});

test("native Taskboard opening reuses protected live panel presence", () => {
  assert.match(source, /createNativeTaskboardPanelOpener/);
  assert.match(source, /`\$\{taskboardBaseUrl\}\/api\/local\/taskboard-panel-presence`/);
  assert.match(source, /reusedTaskboardInExistingCodex/);
  assert.doesNotMatch(source, /`\$\{taskboardOrigin\}\/api\/local\/taskboard-panel-presence`/);
});
