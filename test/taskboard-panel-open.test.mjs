import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskboardPanelPresence } from "../server/taskboard-panel-presence.mjs";
import { createNativeTaskboardPanelOpener } from "../scripts/taskboard-panel-open.mjs";

test("panel presence expires closed or stale Taskboard pages", () => {
  let now = 1_000;
  const presence = createTaskboardPanelPresence({ now: () => now, ttlMs: 5_000 });

  presence.touch("panel-aaaa");
  assert.equal(presence.hasLivePanel(), true);

  presence.remove("panel-aaaa");
  assert.equal(presence.hasLivePanel(), false);

  presence.touch("panel-bbbb");
  now += 5_001;
  assert.equal(presence.hasLivePanel(), false);
});

test("repeated native open requests reuse one live protected panel", async () => {
  let live = false;
  let opens = 0;
  let focuses = 0;
  const opener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => live,
    openPanel: async () => { opens += 1; live = true; },
    focusApp: () => { focuses += 1; },
  });

  const [first, duplicate] = await Promise.all([
    opener.openOrFocus(),
    opener.openOrFocus(),
  ]);
  assert.deepEqual([first.action, duplicate.action].sort(), ["opened", "reused"]);
  assert.equal(opens, 1);
  assert.equal(focuses, 1);
});

test("a genuinely closed native panel opens exactly one replacement", async () => {
  let live = true;
  let opens = 0;
  const opener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => live,
    openPanel: async () => { opens += 1; live = true; },
    focusApp: () => {},
  });

  assert.equal((await opener.openOrFocus()).action, "reused");
  live = false;
  const replacements = await Promise.all([
    opener.openOrFocus(),
    opener.openOrFocus(),
  ]);
  assert.deepEqual(replacements.map(({ action }) => action).sort(), ["opened", "reused"]);
  assert.equal(opens, 1);
});

test("native opening lease suppresses a duplicate before delayed presence arrives", async () => {
  let live = false;
  let now = 1_000;
  let opens = 0;
  const opener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => live,
    openPanel: async () => { opens += 1; },
    focusApp: () => {},
    now: () => now,
    openingLeaseMs: 5_000,
  });

  assert.equal((await opener.openOrFocus()).action, "opened");
  assert.equal((await opener.openOrFocus()).action, "opening");
  assert.equal(opens, 1);

  live = true;
  now += 1;
  assert.equal((await opener.openOrFocus()).action, "reused");
  assert.equal(opens, 1);
});

test("native opening lease expires when presence never arrives", async () => {
  let now = 1_000;
  let opens = 0;
  const opener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => false,
    openPanel: async () => { opens += 1; },
    focusApp: () => {},
    now: () => now,
    openingLeaseMs: 5_000,
  });

  assert.equal((await opener.openOrFocus()).action, "opened");
  now += 5_001;
  assert.equal((await opener.openOrFocus()).action, "opened");
  assert.equal(opens, 2);
});

test("a live native panel remains reusable when app activation is unavailable", async () => {
  const opener = createNativeTaskboardPanelOpener({
    hasLivePanel: async () => true,
    openPanel: async () => { throw new Error("must not open a duplicate"); },
    focusApp: () => { throw new Error("activation unavailable"); },
  });

  assert.equal((await opener.openOrFocus()).action, "reused");
});
