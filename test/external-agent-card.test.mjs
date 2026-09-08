import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer, resolveServerOptions } from "../server/index.mjs";
import { inspectExternalAgentCard } from "../server/external-agent-card.mjs";

const runningApps = [];
const temporaryDirectories = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function fixtureCard(overrides = {}) {
  return {
    protocolVersion: "0.3.0",
    name: "Fixture Research Agent",
    description: "Local test fixture only",
    url: "https://example.invalid/a2a",
    preferredTransport: "HTTP+JSON",
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    security: [{ bearerAuth: [] }],
    skills: [
      {
        id: "taskboard.task-capsule.read",
        name: "Read task context",
        description: "Read a bounded task context",
        tags: ["taskboard"],
      },
      {
        id: "external.agent-card.inspect",
        name: "Inspect Agent Card",
        description: "Compare another card",
        tags: ["discovery"],
      },
      {
        id: "provider.private-research",
        name: "Private research",
        description: "Provider-specific research",
        tags: ["research"],
      },
    ],
    ...overrides,
  };
}

async function startServer({
  card,
  configured = card !== undefined,
  missing = false,
  maxAgeMs = 60_000,
  modifiedAt,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-agent-card-test-"));
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory, { recursive: true });
  const sourcePath = configured ? path.join(directory, "configured-agent-card.json") : null;
  if (sourcePath && !missing) {
    await writeFile(
      sourcePath,
      typeof card === "string" ? card : `${JSON.stringify(card, null, 2)}\n`,
    );
    if (modifiedAt) await utimes(sourcePath, modifiedAt, modifiedAt);
  }
  const app = createTaskboardServer({
    dataDirectory,
    externalAgentCardPath: sourcePath,
    externalAgentCardMaxAgeMs: maxAgeMs,
  });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("external Agent Card reports an explicit not-configured source", async () => {
  const baseUrl = await startServer();
  const result = await request(baseUrl, "/api/agent-capabilities/external");

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    source: {
      kind: "local_file",
      configured: false,
      state: "not_configured",
      reasonCode: "SOURCE_NOT_CONFIGURED",
      observedAt: null,
    },
    card: null,
    comparison: null,
    selectable: false,
    selectionBlockers: ["SOURCE_NOT_CONFIGURED", "EXTERNAL_DISPATCH_NOT_IMPLEMENTED"],
    safety: {
      discoveryOnly: true,
      providerClaimsVerified: false,
      dispatch: false,
    },
  });
});

test("external Agent Card normalizes a current local fixture against stable Taskboard IDs", async () => {
  const baseUrl = await startServer({ card: fixtureCard() });
  const result = await request(baseUrl, "/api/agent-capabilities/external");

  assert.equal(result.response.status, 200);
  assert.equal(result.body.source.configured, true);
  assert.equal(result.body.source.state, "valid");
  assert.equal(result.body.source.reasonCode, null);
  assert.match(result.body.source.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.body.card, {
    protocolVersion: "0.3.0",
    name: "Fixture Research Agent",
    description: "Local test fixture only",
    transport: "http-json",
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
    authentication: [
      { id: "bearerAuth", type: "http", scheme: "bearer" },
    ],
    skills: [
      { id: "taskboard.task-capsule.read", name: "Read task context" },
      { id: "external.agent-card.inspect", name: "Inspect Agent Card" },
      { id: "provider.private-research", name: "Private research" },
    ],
  });
  assert.deepEqual(result.body.comparison.capabilityIds, {
    supported: ["taskboard.task-capsule.read"],
    planned: ["external.agent-card.inspect"],
    unknown: ["provider.private-research"],
  });
  assert.deepEqual(result.body.comparison.transport, {
    declared: "http-json",
    taskboard: "http-json",
    compatible: true,
  });
  assert.deepEqual(result.body.comparison.media, {
    input: {
      declared: ["application/json", "text/plain"],
      compatible: ["application/json"],
    },
    output: {
      declared: ["application/json"],
      compatible: ["application/json"],
    },
  });
  assert.deepEqual(result.body.comparison.authentication, {
    requirements: [["bearerAuth"]],
    configured: false,
    satisfied: false,
  });
  assert.equal(result.body.selectable, false);
  assert.deepEqual(result.body.selectionBlockers, [
    "AUTHENTICATION_NOT_CONFIGURED",
    "UNKNOWN_CAPABILITY_IDS",
    "EXTERNAL_DISPATCH_NOT_IMPLEMENTED",
  ]);
  assert.deepEqual(result.body.safety, {
    discoveryOnly: true,
    providerClaimsVerified: false,
    dispatch: false,
  });
  assert.doesNotMatch(JSON.stringify(result.body), /configured-agent-card\.json/);
  assert.doesNotMatch(JSON.stringify(result.body), /example\.invalid/);
});

test("external Agent Card preserves alternative authentication requirements", async () => {
  const baseUrl = await startServer({
    card: fixtureCard({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        oauth: { type: "oauth2", authorizationUrl: "https://secret.invalid/oauth" },
      },
      security: [{ bearerAuth: [] }, { oauth: ["task.read"] }],
    }),
  });
  const result = await request(baseUrl, "/api/agent-capabilities/external");

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.comparison.authentication, {
    requirements: [["bearerAuth"], ["oauth"]],
    configured: false,
    satisfied: false,
  });
  assert.doesNotMatch(JSON.stringify(result.body), /secret\.invalid/);

  const malformedBaseUrl = await startServer({
    card: fixtureCard({ security: [{ bearerAuth: "task.read" }] }),
  });
  const malformed = await request(malformedBaseUrl, "/api/agent-capabilities/external");
  assert.equal(malformed.response.status, 200);
  assert.equal(malformed.body.source.state, "unsupported");
  assert.equal(malformed.body.source.reasonCode, "INVALID_AGENT_CARD");

  const duplicateSchemeBaseUrl = await startServer({
    card: fixtureCard({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        " bearerAuth ": { type: "oauth2" },
      },
    }),
  });
  const duplicateScheme = await request(
    duplicateSchemeBaseUrl,
    "/api/agent-capabilities/external",
  );
  assert.equal(duplicateScheme.response.status, 200);
  assert.equal(duplicateScheme.body.source.state, "unsupported");
  assert.equal(duplicateScheme.body.source.reasonCode, "INVALID_AGENT_CARD");
});

test("external Agent Card distinguishes stale and unreachable configured sources", async () => {
  const staleBaseUrl = await startServer({
    card: fixtureCard({ securitySchemes: {}, security: [] }),
    maxAgeMs: 1_000,
    modifiedAt: new Date("2000-01-01T00:00:00.000Z"),
  });
  const stale = await request(staleBaseUrl, "/api/agent-capabilities/external");
  assert.equal(stale.response.status, 200);
  assert.equal(stale.body.source.state, "stale");
  assert.equal(stale.body.source.reasonCode, "SOURCE_STALE");
  assert.equal(stale.body.card.name, "Fixture Research Agent");
  assert.ok(stale.body.selectionBlockers.includes("SOURCE_STALE"));

  const unreachableBaseUrl = await startServer({ card: fixtureCard(), missing: true });
  const unreachable = await request(unreachableBaseUrl, "/api/agent-capabilities/external");
  assert.equal(unreachable.response.status, 200);
  assert.deepEqual(unreachable.body.source, {
    kind: "local_file",
    configured: true,
    state: "unreachable",
    reasonCode: "SOURCE_UNREACHABLE",
    observedAt: null,
  });
  assert.equal(unreachable.body.card, null);
  assert.equal(unreachable.body.comparison, null);
  assert.doesNotMatch(JSON.stringify(unreachable.body), /configured-agent-card\.json/);

  const futureBaseUrl = await startServer({
    card: fixtureCard(),
    modifiedAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const future = await request(futureBaseUrl, "/api/agent-capabilities/external");
  assert.equal(future.response.status, 200);
  assert.equal(future.body.source.state, "unsupported");
  assert.equal(future.body.source.reasonCode, "SOURCE_TIME_INVALID");
  assert.equal(future.body.card, null);

  const toleratedSkewBaseUrl = await startServer({
    card: fixtureCard({ securitySchemes: {}, security: [] }),
    modifiedAt: new Date(Date.now() + 30_000),
  });
  const toleratedSkew = await request(
    toleratedSkewBaseUrl,
    "/api/agent-capabilities/external",
  );
  assert.equal(toleratedSkew.response.status, 200);
  assert.equal(toleratedSkew.body.source.state, "valid");
  assert.equal(toleratedSkew.body.source.reasonCode, null);
});

test("external Agent Card retries when content changes during its bounded read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-agent-card-rewrite-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "agent-card.json");
  const oldTime = new Date("2000-01-01T00:00:00.000Z");
  const rewrittenTime = new Date("2026-09-01T00:00:05.000Z");
  await writeFile(sourcePath, `${JSON.stringify(fixtureCard({ name: "Old revision" }))}\n`);
  await utimes(sourcePath, oldTime, oldTime);

  let rewrites = 0;
  const openWithOneRewrite = async (...args) => {
    const handle = await open(...args);
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: async (...readArgs) => {
        if (rewrites === 0) {
          rewrites += 1;
          await writeFile(
            sourcePath,
            `${JSON.stringify(fixtureCard({ name: "Current revision after rewrite" }))}\n`,
          );
          await utimes(sourcePath, rewrittenTime, rewrittenTime);
        }
        return handle.read(...readArgs);
      },
      close: () => handle.close(),
    };
  };

  const result = await inspectExternalAgentCard({
    sourcePath,
    maxAgeMs: 60_000,
    now: new Date("2026-09-01T00:00:10.000Z").getTime(),
    openFile: openWithOneRewrite,
  });

  assert.equal(rewrites, 1);
  assert.equal(result.source.state, "valid");
  assert.equal(result.source.observedAt, rewrittenTime.toISOString());
  assert.equal(result.card.name, "Current revision after rewrite");

  let changingRevision = 0;
  const openWithPersistentRewrite = async (...args) => {
    const handle = await open(...args);
    let changedThisAttempt = false;
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: async (...readArgs) => {
        if (!changedThisAttempt) {
          changedThisAttempt = true;
          changingRevision += 1;
          await writeFile(
            sourcePath,
            `${JSON.stringify(fixtureCard({ name: `Changing revision ${changingRevision}` }))}\n`,
          );
          const changedAt = new Date(rewrittenTime.getTime() + changingRevision * 1_000);
          await utimes(sourcePath, changedAt, changedAt);
        }
        return handle.read(...readArgs);
      },
      close: () => handle.close(),
    };
  };
  const unstable = await inspectExternalAgentCard({
    sourcePath,
    maxAgeMs: 60_000,
    now: new Date("2026-09-01T00:00:10.000Z").getTime(),
    openFile: openWithPersistentRewrite,
  });
  assert.equal(changingRevision, 2);
  assert.equal(unstable.source.state, "unreachable");
  assert.equal(unstable.source.reasonCode, "SOURCE_CHANGED_DURING_READ");
  assert.equal(unstable.card, null);
});

test("external Agent Card reports unsupported input without exposing or dispatching it", async () => {
  const baseUrl = await startServer({
    card: fixtureCard({ preferredTransport: "websocket" }),
  });
  const result = await request(baseUrl, "/api/agent-capabilities/external");

  assert.equal(result.response.status, 200);
  assert.equal(result.body.source.state, "unsupported");
  assert.equal(result.body.source.reasonCode, "UNSUPPORTED_TRANSPORT");
  assert.equal(result.body.card, null);
  assert.equal(result.body.comparison, null);
  assert.equal(result.body.selectable, false);
  assert.equal(result.body.safety.dispatch, false);

  const oversizedBaseUrl = await startServer({ card: "x".repeat(257 * 1_024) });
  const oversized = await request(oversizedBaseUrl, "/api/agent-capabilities/external");
  assert.equal(oversized.response.status, 200);
  assert.equal(oversized.body.source.state, "unsupported");
  assert.equal(oversized.body.source.reasonCode, "INVALID_AGENT_CARD");
});

test("external Agent Card route stays GET-only and query-free", async () => {
  const baseUrl = await startServer();
  const mutation = await request(baseUrl, "/api/agent-capabilities/external", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(mutation.response.status, 405);
  assert.equal(mutation.response.headers.get("allow"), "GET");

  const query = await request(baseUrl, "/api/agent-capabilities/external?url=https://example.invalid");
  assert.equal(query.response.status, 400);
  assert.equal(query.body.error.code, "UNKNOWN_QUERY_PARAMETER");
});

test("external Agent Card configuration requires an absolute path and bounded freshness", () => {
  assert.throws(
    () => resolveServerOptions({ externalAgentCardPath: "relative-agent-card.json" }),
    /must be absolute/,
  );
  assert.throws(
    () => resolveServerOptions({ externalAgentCardMaxAgeMs: 999 }),
    /must be an integer from 1000 through 604800000/,
  );
});
