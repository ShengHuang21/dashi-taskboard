import { createHash, randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";

const REMOTE_ADAPTER_ID = "codex-renderer-rpc-v1";

function executionKey(execution) {
  return [
    execution?.codexHostId,
    execution?.executorInstanceId,
    execution?.registrationFingerprint,
    execution?.leaseId,
  ].join("\u0000");
}

function outcomeFingerprint(outcome) {
  return createHash("sha256").update(JSON.stringify(outcome)).digest("hex");
}

function channelError(code, message, status = 503) {
  return new ApiError(status, code, message);
}

function rejectedOutcomeError(outcome) {
  const error = new Error(outcome.error.message);
  error.definitiveRejection = outcome.error.definitiveRejection === true;
  return error;
}

export class RemoteHostExecutorChannelRegistry {
  constructor({
    database,
    pollTimeoutMs = 4_000,
    requestTimeoutMs = 35_000,
    acknowledgementTtlMs = 60_000,
    createRequestId = randomUUID,
  } = {}) {
    if (!database || typeof database.assertHostExecutorChannelExecution !== "function") {
      throw new TypeError("Remote host executor channels require the Taskboard database");
    }
    if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 1
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
      || !Number.isSafeInteger(acknowledgementTtlMs) || acknowledgementTtlMs < 1
      || typeof createRequestId !== "function") {
      throw new TypeError("Remote host executor channels require valid timing dependencies");
    }
    this.database = database;
    this.pollTimeoutMs = pollTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.acknowledgementTtlMs = acknowledgementTtlMs;
    this.createRequestId = createRequestId;
    this.hosts = new Map();
    this.acknowledgements = new Map();
    this.closed = false;
  }

  #assertRemoteExecution(execution) {
    return this.database.assertHostExecutorChannelExecution(execution, REMOTE_ADAPTER_ID);
  }

  #retire(state, error) {
    if (state.waiter) {
      clearTimeout(state.waiter.timer);
      state.waiter.resolve({ request: null });
      state.waiter = null;
    }
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
    if (this.hosts.get(state.codexHostId) === state) {
      this.hosts.delete(state.codexHostId);
    }
  }

  #stateFor(execution, { create = false } = {}) {
    const key = executionKey(execution);
    let state = this.hosts.get(execution.codexHostId) ?? null;
    if (state && state.executionKey !== key) {
      this.#retire(state, channelError(
        "HOST_EXECUTOR_CHANNEL_REPLACED",
        "The remote host executor channel was replaced by another lease epoch",
        409,
      ));
      state = null;
    }
    if (!state && create) {
      state = {
        codexHostId: execution.codexHostId,
        executionKey: key,
        execution: { ...execution },
        waiter: null,
        pending: new Map(),
      };
      this.hosts.set(execution.codexHostId, state);
    }
    return state;
  }

  #exactState(execution) {
    const state = this.hosts.get(execution.codexHostId) ?? null;
    return state?.executionKey === executionKey(execution) ? state : null;
  }

  #purgeAcknowledgements() {
    const currentTime = Date.now();
    for (const [key, value] of this.acknowledgements) {
      if (value.expiresAt <= currentTime) this.acknowledgements.delete(key);
    }
  }

  poll(execution, pollId) {
    if (this.closed) {
      throw channelError("HOST_EXECUTOR_CHANNEL_CLOSED", "Remote host executor channels are closed");
    }
    this.#assertRemoteExecution(execution);
    const state = this.#stateFor(execution, { create: true });
    if (state.waiter) {
      throw channelError(
        "HOST_EXECUTOR_CHANNEL_POLL_ACTIVE",
        "The exact remote host executor already has an active request poll",
        409,
      );
    }
    return new Promise((resolve) => {
      const waiter = { pollId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        if (state.waiter !== waiter) return;
        state.waiter = null;
        resolve({ request: null });
      }, this.pollTimeoutMs);
      waiter.timer.unref?.();
      state.waiter = waiter;
    });
  }

  cancelPoll(execution, pollId) {
    const state = this.#exactState(execution);
    if (!state?.waiter || state.waiter.pollId !== pollId) return false;
    const waiter = state.waiter;
    state.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve({ request: null });
    return true;
  }

  ensureReady(execution) {
    const state = this.#exactState(execution);
    if (!state?.waiter) {
      throw channelError(
        "HOST_EXECUTOR_CHANNEL_UNAVAILABLE",
        "The exact remote host executor does not have a live request channel",
      );
    }
  }

  dispatchReady(execution, operations) {
    const state = this.#exactState(execution);
    const waiter = state?.waiter;
    if (!state || !waiter) {
      throw channelError(
        "HOST_EXECUTOR_CHANNEL_UNAVAILABLE",
        "The exact remote host executor request channel disconnected before dispatch",
      );
    }
    state.waiter = null;
    clearTimeout(waiter.timer);
    const requestId = this.createRequestId();
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const pending = {
      executionKey: state.executionKey,
      expectedResultCount: operations.length,
      resolve: resolveResult,
      reject: rejectResult,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (state.pending.get(requestId) !== pending) return;
      state.pending.delete(requestId);
      rejectResult(channelError(
        "HOST_EXECUTOR_CHANNEL_TIMEOUT",
        "The remote host executor result is uncertain after the channel timeout",
      ));
    }, this.requestTimeoutMs);
    pending.timer.unref?.();
    state.pending.set(requestId, pending);
    waiter.resolve({ request: { id: requestId, operations } });
    return result;
  }

  complete(execution, requestId, outcome) {
    this.#assertRemoteExecution(execution);
    this.#purgeAcknowledgements();
    const state = this.#exactState(execution);
    const acknowledgementKey = `${executionKey(execution)}\u0000${requestId}`;
    const fingerprint = outcomeFingerprint(outcome);
    const previous = this.acknowledgements.get(acknowledgementKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw channelError(
          "HOST_EXECUTOR_CHANNEL_RESULT_CONFLICT",
          "The remote host executor request already has another outcome",
          409,
        );
      }
      return { applied: false, replayed: true, accepted: previous.accepted };
    }
    const pending = state?.pending.get(requestId);
    if (!pending || pending.executionKey !== executionKey(execution)) {
      throw channelError(
        "HOST_EXECUTOR_CHANNEL_REQUEST_STALE",
        "The remote host executor request is no longer pending",
        409,
      );
    }
    state.pending.delete(requestId);
    clearTimeout(pending.timer);
    const accepted = !Object.hasOwn(outcome, "result")
      || (Array.isArray(outcome.result)
        && outcome.result.length === pending.expectedResultCount);
    this.acknowledgements.set(acknowledgementKey, {
      fingerprint,
      accepted,
      expiresAt: Date.now() + this.acknowledgementTtlMs,
    });
    if (Object.hasOwn(outcome, "result") && accepted) pending.resolve(outcome.result);
    else if (Object.hasOwn(outcome, "result")) pending.reject(channelError(
      "HOST_EXECUTOR_CHANNEL_RESULT_INVALID",
      "The remote host executor returned a malformed operation result envelope",
      502,
    ));
    else pending.reject(rejectedOutcomeError(outcome));
    return { applied: true, replayed: false, accepted };
  }

  disconnect(execution) {
    this.#assertRemoteExecution(execution);
    const state = this.#exactState(execution);
    if (!state) return { applied: false };
    this.#retire(state, channelError(
      "HOST_EXECUTOR_CHANNEL_DISCONNECTED",
      "The remote host executor disconnected before its result was confirmed",
    ));
    return { applied: true };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const state of [...this.hosts.values()]) {
      this.#retire(state, channelError(
        "HOST_EXECUTOR_CHANNEL_CLOSED",
        "Remote host executor channels closed before the result was confirmed",
      ));
    }
    this.acknowledgements.clear();
  }
}

export function createHostExecutorAdapterRouter({ localAdapter, remoteChannels } = {}) {
  if (typeof localAdapter?.ensureReady !== "function"
    || typeof localAdapter?.requestReady !== "function"
    || typeof remoteChannels?.ensureReady !== "function"
    || typeof remoteChannels?.dispatchReady !== "function") {
    throw new TypeError("Host executor adapter routing requires local and remote adapters");
  }
  return {
    ensureReady(execution) {
      return execution?.codexHostId === "local"
        ? localAdapter.ensureReady()
        : remoteChannels.ensureReady(execution);
    },
    dispatchReady(execution, operations) {
      if (execution.codexHostId !== "local") {
        return remoteChannels.dispatchReady(execution, operations);
      }
      let pending;
      try {
        pending = operations.map(({ method, params }) => (
          localAdapter.requestReady(execution.codexHostId, method, params)
        ));
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.all(pending);
    },
  };
}

export function createRemoteHostExecutorChannelRegistry(options) {
  return new RemoteHostExecutorChannelRegistry(options);
}
