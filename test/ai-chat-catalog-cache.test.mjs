import assert from "node:assert/strict";
import test from "node:test";

import { AiChatService } from "../server/ai-chat.mjs";

function createService(discoverCatalog, options = {}) {
  let notify = () => {};
  const appServer = {
    subscribe: (listener) => {
      notify = listener;
      return () => { notify = () => {}; };
    },
    close: async () => {},
  };
  const service = new AiChatService({
    database: {},
    codexExecutable: "codex",
    codexStatePath: "/tmp/codex-state.json",
    manageTaskboardSkillPath: "/tmp/manage-taskboard/SKILL.md",
    appServer,
    composerCatalog: { close() {} },
    resolveContext: options.resolveContext ?? (async () => ({ workspacePath: "/tmp/workspace" })),
    discoverCatalog,
    catalogTtlMs: options.catalogTtlMs ?? 30_000,
  });
  return { service, notify: (notification) => notify(notification) };
}

test("concurrent and repeated catalog reads share one bounded discovery", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const expected = { models: [], skills: [], commands: [], sandboxes: [] };
  const { service } = createService(async () => {
    calls += 1;
    await blocked;
    return expected;
  });

  try {
    const first = service.getCatalog("local");
    const second = service.getCatalog("local");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.equal(await first, expected);
    assert.equal(await second, expected);
    assert.equal(await service.getCatalog("local"), expected);
    assert.equal(calls, 1);
  } finally {
    release();
    await service.close();
  }
});

test("a failed discovery is not cached", async () => {
  let calls = 0;
  const expected = { models: [], skills: [], commands: [], sandboxes: [] };
  const { service } = createService(async () => {
    calls += 1;
    if (calls === 1) throw new Error("catalog unavailable");
    return expected;
  });

  try {
    await assert.rejects(service.getCatalog("local"), /catalog unavailable/);
    assert.equal(await service.getCatalog("local"), expected);
    assert.equal(calls, 2);
  } finally {
    await service.close();
  }
});

test("an expired catalog refresh still coalesces concurrent readers", async () => {
  let calls = 0;
  const serviceResult = createService(async () => {
    calls += 1;
    return { models: [{ slug: `catalog-${calls}` }], skills: [], commands: [], sandboxes: [] };
  }, { catalogTtlMs: -1 });
  const { service } = serviceResult;

  try {
    assert.equal((await service.getCatalog("local")).models[0].slug, "catalog-1");
    const second = service.getCatalog("local");
    const sharedSecond = service.getCatalog("local");
    assert.equal((await second).models[0].slug, "catalog-2");
    assert.equal((await sharedSecond).models[0].slug, "catalog-2");
    assert.equal(calls, 2);
  } finally {
    await service.close();
  }
});

test("catalog caches stay isolated by resolved workspace", async () => {
  const calls = new Map();
  const { service } = createService(async ({ workspacePath }) => {
    calls.set(workspacePath, (calls.get(workspacePath) ?? 0) + 1);
    return { models: [{ slug: workspacePath }], skills: [], commands: [], sandboxes: [] };
  }, {
    resolveContext: async (projectId) => ({ workspacePath: `/tmp/${projectId}` }),
  });

  try {
    const [firstA, secondA, firstB, secondB] = await Promise.all([
      service.getCatalog("project-a"),
      service.getCatalog("project-a"),
      service.getCatalog("project-b"),
      service.getCatalog("project-b"),
    ]);
    assert.equal(firstA.models[0].slug, "/tmp/project-a");
    assert.equal(secondA, firstA);
    assert.equal(firstB.models[0].slug, "/tmp/project-b");
    assert.equal(secondB, firstB);
    assert.deepEqual([...calls], [["/tmp/project-a", 1], ["/tmp/project-b", 1]]);
  } finally {
    await service.close();
  }
});

test("skill invalidation cannot let an older pending discovery replace fresh catalog data", async () => {
  let calls = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const stale = { models: [{ slug: "stale" }], skills: [], commands: [], sandboxes: [] };
  const fresh = { models: [{ slug: "fresh" }], skills: [], commands: [], sandboxes: [] };
  const { service, notify } = createService(async () => {
    calls += 1;
    if (calls === 1) {
      await firstBlocked;
      return stale;
    }
    return fresh;
  });

  try {
    const first = service.getCatalog("local");
    await new Promise((resolve) => setImmediate(resolve));
    notify({ method: "skills/changed" });
    assert.equal(await service.getCatalog("local"), fresh);
    releaseFirst();
    assert.equal(await first, stale);
    assert.equal(await service.getCatalog("local"), fresh);
    assert.equal(calls, 2);
  } finally {
    releaseFirst();
    await service.close();
  }
});
