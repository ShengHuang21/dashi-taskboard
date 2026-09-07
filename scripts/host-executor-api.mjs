import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

function requiredString(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`Host executor API requires ${field}`);
  }
  return value;
}

export function createHostExecutorEffectKey({
  codexHostId,
  method,
  params,
  occurrenceId = randomUUID(),
}) {
  const host = requiredString(codexHostId, "codexHostId");
  const rpcMethod = requiredString(method, "method");
  const occurrence = requiredString(occurrenceId, "occurrenceId");
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Host executor effect key requires params");
  }
  const semanticDigest = createHash("sha256").update(JSON.stringify({
    codexHostId: host,
    method: rpcMethod,
    params,
  })).digest("hex");
  return `resident:${occurrence}:${semanticDigest}`;
}

export function createHostExecutorApi({
  baseUrl,
  instanceSecret,
  fetchImpl = fetch,
  now = Date.now,
  createNonce = () => randomBytes(32).toString("hex"),
  timeoutSignal = () => AbortSignal.timeout(5_000),
}) {
  const origin = requiredString(baseUrl, "baseUrl").replace(/\/$/, "");
  const secret = requiredString(instanceSecret, "instanceSecret");
  if (typeof fetchImpl !== "function"
    || typeof now !== "function"
    || typeof createNonce !== "function"
    || typeof timeoutSignal !== "function") {
    throw new Error("Host executor API requires exact request dependencies");
  }

  function proofHeaders(pathname, body, method) {
    const nonce = requiredString(createNonce(), "nonce");
    const issuedAt = String(now());
    return {
      "content-type": "application/json",
      "x-codex-taskboard-injector-nonce": nonce,
      "x-codex-taskboard-injector-issued-at": issuedAt,
      "x-codex-taskboard-injector-proof": createHmac("sha256", secret)
        .update(JSON.stringify({ nonce, issuedAt, method, pathname, body }))
        .digest("hex"),
    };
  }

  async function request(pathname, { method = "GET", body = null, action }) {
    const response = await fetchImpl(`${origin}${pathname}`, {
      method,
      headers: proofHeaders(pathname, body, method),
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: timeoutSignal(),
    });
    let result;
    try {
      result = await response.json();
    } catch (_) {
      throw new Error(`Taskboard host executor ${action} returned invalid JSON`);
    }
    if (!response.ok) {
      const code = typeof result?.error?.code === "string" ? result.error.code : null;
      const serverMessage = typeof result?.error?.message === "string"
        ? result.error.message
        : null;
      const error = new Error(serverMessage
        || `Taskboard host executor ${action} returned HTTP ${response.status}`);
      error.status = response.status;
      if (code) error.code = code;
      throw error;
    }
    return result;
  }

  const registration = (input) => {
    const codexHostId = requiredString(input?.codexHostId, "codexHostId");
    const executorInstanceId = requiredString(
      input?.executorInstanceId,
      "executorInstanceId",
    );
    const pathname = `/api/local/host-executors/${encodeURIComponent(codexHostId)}`
      + `/registrations/${encodeURIComponent(executorInstanceId)}`;
    return request(pathname, {
      method: "PUT",
      action: "registration",
      body: {
        adapterId: input.adapterId,
        idempotencyKey: input.idempotencyKey,
      },
    });
  };

  const inspection = (input) => {
    const codexHostId = requiredString(input?.codexHostId, "codexHostId");
    const pathname = `/api/local/host-executors/${encodeURIComponent(codexHostId)}`;
    return request(pathname, { method: "GET", action: "inspection" });
  };

  const leaseMutation = (action, input) => {
    if (!["acquire", "renew", "release"].includes(action)) {
      throw new Error("Host executor API requires an allowlisted lease action");
    }
    const codexHostId = requiredString(input?.codexHostId, "codexHostId");
    const suffix = action === "acquire" ? "" : `/${action}`;
    const pathname = `/api/local/host-executors/${encodeURIComponent(codexHostId)}`
      + `/lease${suffix}`;
    const { codexHostId: _codexHostId, ...body } = input;
    return request(pathname, {
      method: "POST",
      action: `lease ${action}`,
      body,
    });
  };

  const executeEffect = (input) => {
    const codexHostId = requiredString(input?.execution?.codexHostId, "codexHostId");
    const effectKey = requiredString(input?.effectKey, "effectKey");
    const pathname = `/api/local/host-executors/${encodeURIComponent(codexHostId)}`
      + `/effects/${encodeURIComponent(effectKey)}/execute`;
    return request(pathname, {
      method: "POST",
      action: "effect execution",
      body: {
        execution: input.execution,
        operations: input.operations,
      },
    });
  };

  return {
    register: registration,
    inspect: inspection,
    acquire: (input) => leaseMutation("acquire", input),
    renew: (input) => leaseMutation("renew", input),
    release: (input) => leaseMutation("release", input),
    executeEffect,
  };
}
