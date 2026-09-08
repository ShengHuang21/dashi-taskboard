import { isCanonicalCodexHostId } from "../shared/domain.mjs";

const REMOTE_MUTATING_METHODS = new Set([
  "thread/archive",
  "thread/name/set",
  "thread/resume",
  "thread/start",
  "turn/start",
  "turn/steer",
]);

function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Remote host executor runtime requires ${name}`);
  }
  return value;
}

function validExecution(execution) {
  return execution
    && isCanonicalCodexHostId(execution.codexHostId)
    && execution.codexHostId !== "local"
    && typeof execution.executorInstanceId === "string"
    && execution.executorInstanceId.length > 0
    && /^[a-f0-9]{64}$/.test(execution.registrationFingerprint ?? "")
    && typeof execution.leaseId === "string"
    && execution.leaseId.length > 0;
}

function validatedDelivery(delivery) {
  const request = delivery?.request;
  if (request === null) return null;
  if (!request
    || typeof request.id !== "string"
    || !request.id
    || !Array.isArray(request.operations)
    || request.operations.length < 1
    || request.operations.length > 4
    || request.operations.some((operation) => (
      !operation
      || typeof operation !== "object"
      || Array.isArray(operation)
      || !REMOTE_MUTATING_METHODS.has(operation.method)
      || !operation.params
      || typeof operation.params !== "object"
      || Array.isArray(operation.params)
    ))) {
    throw new Error("Taskboard returned an invalid remote host executor request");
  }
  return request;
}

function rendererRpcError(message, definitiveRejection = false) {
  const error = new Error(message);
  error.definitiveRejection = definitiveRejection;
  return error;
}

function abortError() {
  const error = new Error("Remote host executor operation was aborted");
  error.name = "AbortError";
  return error;
}

function abortableCall(action, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  const pending = Promise.resolve().then(action);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    signal.addEventListener("abort", handleAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function failureClass(error) {
  if (typeof error?.code === "string" && error.code) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return `${error?.name ?? typeof error}:${message}`;
}

export function decodeCodexRendererRpcOutcome(response) {
  if (response?.kind === "transport-error") {
    throw rendererRpcError(
      typeof response.error === "string" && response.error.trim()
        ? response.error.trim()
        : "Codex renderer RPC transport failed",
    );
  }
  if (response?.kind !== "response"
    || !response.message
    || typeof response.message !== "object"
    || Array.isArray(response.message)) {
    throw rendererRpcError("Codex App Server returned a malformed response");
  }
  const hasError = Object.hasOwn(response.message, "error");
  const hasResult = Object.hasOwn(response.message, "result");
  if (hasError === hasResult || (hasResult && response.message.result === undefined)) {
    throw rendererRpcError("Codex App Server returned a malformed response");
  }
  if (hasResult) return response.message.result;
  const rejection = response.message.error;
  const message = rejection
    && typeof rejection === "object"
    && !Array.isArray(rejection)
    && typeof rejection.message === "string"
    ? rejection.message.trim()
    : "";
  if (!message) throw rendererRpcError("Codex App Server returned a malformed error");
  throw rendererRpcError(message, true);
}

export async function runRemoteHostExecutorChannelOnce({
  execution,
  signal,
  pollRequest,
  executeRpc,
  completeRequest,
  isCurrent,
} = {}) {
  if (!validExecution(execution)) {
    throw new Error("Remote host executor runtime requires an active exact execution envelope");
  }
  requiredFunction(pollRequest, "pollRequest");
  requiredFunction(executeRpc, "executeRpc");
  requiredFunction(completeRequest, "completeRequest");
  requiredFunction(isCurrent, "isCurrent");
  const request = validatedDelivery(await abortableCall(
    () => pollRequest({ execution, signal }),
    signal,
  ));
  if (!request) return { delivered: false, reason: "idle" };

  let outcome;
  try {
    const results = [];
    for (const operation of request.operations) {
      if (!isCurrent(execution)) {
        return { delivered: false, reason: "execution-stale" };
      }
      const result = await abortableCall(
        () => executeRpc(
          execution.codexHostId,
          operation.method,
          operation.params,
          signal,
        ),
        signal,
      );
      if (result === undefined) {
        throw new Error("Codex renderer RPC returned an undefined result");
      }
      results.push(result);
    }
    outcome = { result: results };
  } catch (error) {
    outcome = {
      error: {
        message: (
          error instanceof Error && error.message
            ? error.message
            : String(error) || "Remote Codex renderer RPC failed"
        ).slice(0, 4_000),
        definitiveRejection: error?.definitiveRejection === true,
      },
    };
  }
  if (!isCurrent(execution)) {
    return { delivered: false, reason: "execution-stale" };
  }
  const completion = await abortableCall(
    () => completeRequest({
      execution,
      requestId: request.id,
      outcome,
      ...(signal ? { signal } : {}),
    }),
    signal,
  );
  return {
    delivered: true,
    rejected: Object.hasOwn(outcome, "error"),
    completion,
  };
}

function defaultWait(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export function createRemoteHostExecutorWorker({
  codexHostId,
  lifecycle,
  pollRequest,
  completeRequest,
  disconnectRequest,
  executeRpc,
  retryDelayMs = 500,
  maxRetryDelayMs = 30_000,
  wait = defaultWait,
  onError = () => {},
} = {}) {
  if (!isCanonicalCodexHostId(codexHostId) || codexHostId === "local") {
    throw new TypeError("Remote host executor worker requires a canonical remote host id");
  }
  if (typeof lifecycle?.start !== "function"
    || typeof lifecycle?.reconcile !== "function"
    || typeof lifecycle?.stop !== "function"
    || typeof lifecycle?.isActive !== "function"
    || typeof lifecycle?.executionEnvelope !== "function") {
    throw new TypeError("Remote host executor worker requires a lease lifecycle");
  }
  requiredFunction(pollRequest, "pollRequest");
  requiredFunction(completeRequest, "completeRequest");
  requiredFunction(disconnectRequest, "disconnectRequest");
  requiredFunction(executeRpc, "executeRpc");
  requiredFunction(wait, "wait");
  requiredFunction(onError, "onError");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1
    || !Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs) {
    throw new TypeError("Remote host executor worker requires valid retry delays");
  }

  let stopped = true;
  let started = false;
  let loopPromise = null;
  let activityController = null;
  let consecutiveFailures = 0;
  let lastReportedFailureClass = null;

  const isCurrent = (candidate) => {
    const current = lifecycle.executionEnvelope();
    return !stopped
      && current?.codexHostId === candidate.codexHostId
      && current?.executorInstanceId === candidate.executorInstanceId
      && current?.registrationFingerprint === candidate.registrationFingerprint
      && current?.leaseId === candidate.leaseId;
  };

  const report = (error) => {
    const currentFailureClass = failureClass(error);
    if (currentFailureClass === lastReportedFailureClass) return;
    lastReportedFailureClass = currentFailureClass;
    try {
      onError(error);
    } catch (_) {}
  };

  const resetFailures = () => {
    consecutiveFailures = 0;
    lastReportedFailureClass = null;
  };

  const nextRetryDelay = () => {
    const multiplier = 2 ** Math.min(consecutiveFailures, 20);
    consecutiveFailures += 1;
    return Math.min(maxRetryDelayMs, retryDelayMs * multiplier);
  };

  const waitForRetry = async () => {
    try {
      await abortableCall(
        () => wait(nextRetryDelay()),
        activityController?.signal,
      );
      return true;
    } catch (error) {
      if (stopped && error?.name === "AbortError") return false;
      throw error;
    }
  };

  const loop = async () => {
    while (!stopped) {
      if (!lifecycle.isActive()) {
        try {
          await lifecycle.reconcile();
        } catch (error) {
          report(error);
        }
        if (lifecycle.isActive()) {
          resetFailures();
        } else if (!stopped) {
          if (!(await waitForRetry())) break;
        }
        continue;
      }
      const execution = lifecycle.executionEnvelope();
      if (!execution) continue;
      try {
        await runRemoteHostExecutorChannelOnce({
          execution,
          signal: activityController?.signal,
          pollRequest,
          executeRpc,
          completeRequest,
          isCurrent,
        });
        resetFailures();
      } catch (error) {
        if (!stopped && error?.name !== "AbortError") report(error);
        if (!stopped) {
          try {
            await lifecycle.reconcile();
          } catch (reconcileError) {
            report(reconcileError);
          }
          if (!(await waitForRetry())) break;
        }
      }
    }
  };

  async function start() {
    if (started && !stopped) return lifecycle.snapshot?.() ?? null;
    started = true;
    stopped = false;
    activityController = new AbortController();
    const state = await lifecycle.start();
    loopPromise = loop();
    return state;
  }

  async function stop() {
    if (stopped) return lifecycle.snapshot?.() ?? null;
    stopped = true;
    const execution = lifecycle.executionEnvelope();
    activityController?.abort();
    if (execution) {
      try {
        await disconnectRequest({ execution });
      } catch (error) {
        report(error);
      }
    }
    const state = await lifecycle.stop();
    if (loopPromise) await loopPromise;
    loopPromise = null;
    activityController = null;
    return state;
  }

  return { codexHostId, start, stop, isCurrent };
}

function normalizeHostIds(hostIds) {
  if (!Array.isArray(hostIds)) {
    throw new TypeError("Remote host executor inventory must be an array");
  }
  const result = new Set();
  for (const codexHostId of hostIds) {
    if (!isCanonicalCodexHostId(codexHostId) || codexHostId === "local") {
      throw new TypeError("Remote host executor inventory contains an invalid host id");
    }
    result.add(codexHostId);
  }
  return [...result].sort();
}

export function createRemoteHostExecutorManager({ createWorker } = {}) {
  requiredFunction(createWorker, "createWorker");
  const workers = new Map();
  let queue = Promise.resolve();
  let stopped = false;
  let stopPromise = null;

  const serialize = (operation) => {
    const pending = queue.catch(() => {}).then(operation);
    queue = pending;
    return pending;
  };

  const readyHosts = () => [...workers]
    .filter(([, record]) => record.ready)
    .map(([codexHostId]) => codexHostId)
    .sort();

  const beginStop = (codexHostId, record) => {
    record.ready = false;
    if (!record.stopPromise) {
      let pending;
      try {
        pending = Promise.resolve(record.worker.stop());
      } catch (error) {
        pending = Promise.reject(error);
      }
      const tracked = pending.finally(() => {
        if (record.stopPromise === tracked) record.stopPromise = null;
      });
      record.stopPromise = tracked;
    }
    return record.stopPromise.then(() => {
      if (workers.get(codexHostId) === record) workers.delete(codexHostId);
    });
  };

  const stopEntries = async (entries) => {
    const results = await Promise.allSettled(
      entries.map(([codexHostId, record]) => beginStop(codexHostId, record)),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more remote host executors could not stop");
    }
  };

  function reconcile(hostIds, {
    startMissing = true,
    isCurrent = () => true,
  } = {}) {
    const desired = normalizeHostIds(hostIds);
    if (typeof startMissing !== "boolean" || typeof isCurrent !== "function") {
      throw new TypeError("Remote host executor reconciliation requires valid options");
    }
    return serialize(async () => {
      if (stopped || !isCurrent()) return { hosts: readyHosts() };
      const desiredSet = new Set(desired);
      const removals = [...workers]
        .filter(([codexHostId]) => !desiredSet.has(codexHostId))
        .sort(([left], [right]) => left.localeCompare(right));
      if (removals.length > 0) {
        await stopEntries(removals);
      }
      if (stopped || !isCurrent() || !startMissing) return { hosts: readyHosts() };
      for (const codexHostId of desired) {
        if (stopped || !isCurrent()) break;
        const existing = workers.get(codexHostId);
        if (existing?.ready) continue;
        if (existing) await stopEntries([[codexHostId, existing]]);
        if (stopped || !isCurrent()) break;
        const worker = createWorker(codexHostId);
        if (!worker || typeof worker.start !== "function" || typeof worker.stop !== "function") {
          throw new TypeError("Remote host executor manager received an invalid worker");
        }
        const record = { worker, ready: false, stopPromise: null };
        workers.set(codexHostId, record);
        try {
          await worker.start();
          if (stopped || !isCurrent()) {
            if (workers.get(codexHostId) === record) {
              await stopEntries([[codexHostId, record]]);
            }
            break;
          }
          record.ready = true;
        } catch (startError) {
          if (workers.get(codexHostId) !== record) throw startError;
          try {
            await stopEntries([[codexHostId, record]]);
          } catch (cleanupError) {
            throw new AggregateError(
              [startError, cleanupError],
              "Remote host executor start and cleanup both failed",
            );
          }
          throw startError;
        }
      }
      return { hosts: readyHosts() };
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    const immediateStop = stopEntries([...workers]);
    immediateStop.catch(() => {});
    stopPromise = serialize(async () => {
      try {
        await immediateStop;
      } catch (_) {
        if (workers.size > 0) await stopEntries([...workers]);
      }
      return { hosts: [] };
    });
    return stopPromise;
  }

  return { reconcile, stop };
}

export function createRemoteHostInventoryController({
  listRenderers,
  readHostIds,
  manager,
  readTimeoutMs = 5_000,
  closeRenderer = (renderer) => renderer.close?.(),
} = {}) {
  requiredFunction(listRenderers, "listRenderers");
  requiredFunction(readHostIds, "readHostIds");
  requiredFunction(closeRenderer, "closeRenderer");
  if (typeof manager?.reconcile !== "function" || typeof manager?.stop !== "function") {
    throw new TypeError("Remote host inventory requires an executor manager");
  }
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) {
    throw new TypeError("Remote host inventory requires a positive read timeout");
  }

  let renderersByHost = new Map();
  let queue = Promise.resolve();
  let requestedGeneration = 0;
  let stopped = false;
  let stopPromise = null;

  const isCurrent = (generation) => !stopped && generation === requestedGeneration;
  const snapshot = () => ({ hosts: [...renderersByHost.keys()].sort() });

  const readRenderer = async (renderer) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Remote Codex host inventory read timed out");
        error.code = "REMOTE_HOST_INVENTORY_TIMEOUT";
        reject(error);
      }, readTimeoutMs);
    });
    try {
      return normalizeHostIds(await Promise.race([
        Promise.resolve().then(() => readHostIds(renderer)),
        timeout,
      ]));
    } catch (error) {
      if (error?.code === "REMOTE_HOST_INVENTORY_TIMEOUT") {
        try {
          closeRenderer(renderer);
        } catch (_) {}
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const transition = async (generation, nextRenderers) => {
    const stableHosts = [...nextRenderers]
      .filter(([codexHostId, renderer]) => renderersByHost.get(codexHostId) === renderer)
      .map(([codexHostId]) => codexHostId)
      .sort();
    await manager.reconcile(stableHosts, {
      startMissing: false,
      isCurrent: () => isCurrent(generation),
    });
    if (!isCurrent(generation)) return snapshot();
    renderersByHost = nextRenderers;
    return manager.reconcile([...nextRenderers.keys()].sort(), {
      isCurrent: () => isCurrent(generation),
    });
  };

  const failClosed = async (generation, error) => {
    try {
      await manager.reconcile([], {
        startMissing: false,
        isCurrent: () => isCurrent(generation),
      });
    } finally {
      renderersByHost = new Map();
    }
    throw error;
  };

  const performReconcile = async (generation) => {
    if (!isCurrent(generation)) return snapshot();
    const renderers = listRenderers();
    if (!Array.isArray(renderers)) {
      return failClosed(generation, new TypeError("Remote host renderer inventory must be an array"));
    }
    if (renderers.length === 0) return transition(generation, new Map());
    const results = await Promise.allSettled(renderers.map(readRenderer));
    if (!isCurrent(generation)) return snapshot();
    const nextRenderers = new Map();
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled") continue;
      for (const codexHostId of result.value) {
        if (!nextRenderers.has(codexHostId)) nextRenderers.set(codexHostId, renderers[index]);
      }
    }
    if (results.every((result) => result.status === "rejected")) {
      const timedOut = results.some((result) => (
        result.status === "rejected" && result.reason?.code === "REMOTE_HOST_INVENTORY_TIMEOUT"
      ));
      return failClosed(
        generation,
        new Error(timedOut
          ? "Remote Codex host inventory read timed out"
          : "No Codex renderer published authoritative remote host inventory"),
      );
    }
    return transition(generation, nextRenderers);
  };

  const reconcile = () => {
    const generation = ++requestedGeneration;
    const pending = queue.catch(() => {}).then(() => performReconcile(generation));
    queue = pending;
    return pending;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    requestedGeneration += 1;
    stopPromise = manager.stop();
    renderersByHost = new Map();
    return stopPromise;
  };

  return {
    reconcile,
    stop,
    rendererFor: (codexHostId) => renderersByHost.get(codexHostId) ?? null,
  };
}
