import { ApiError } from "./database.mjs";

const SELECTED_MODEL_CAPACITY_ERROR = /selected model is at capacity\.\s*please try a different model\.?/i;
const MUTATING_METHODS = new Set([
  "thread/archive",
  "thread/name/set",
  "thread/resume",
  "thread/start",
  "turn/start",
  "turn/steer",
]);

export class HostExecutorDispatcher {
  constructor({ database, adapter, hooks = {} } = {}) {
    if (!database
      || typeof database.reserveHostExecutorEffect !== "function"
      || typeof database.beginHostExecutorEffectDispatch !== "function") {
      throw new TypeError("Host executor dispatcher requires the Taskboard database");
    }
    if (typeof adapter?.ensureReady !== "function"
      || typeof adapter?.dispatchReady !== "function") {
      throw new TypeError("Host executor dispatcher requires a ready Codex RPC adapter router");
    }
    this.database = database;
    this.adapter = adapter;
    this.afterReserve = typeof hooks.afterReserve === "function"
      ? hooks.afterReserve
      : async () => {};
  }

  async execute(input) {
    if (!Array.isArray(input?.operations)
      || input.operations.some((operation) => !MUTATING_METHODS.has(operation?.method))) {
      throw new ApiError(
        400,
        "HOST_EXECUTOR_RPC_METHOD_NOT_ALLOWED",
        "The fenced dispatcher accepts only mutating Codex RPC methods",
      );
    }

    const reservation = this.database.reserveHostExecutorEffect(input);
    if (reservation.replayed) {
      return { replayed: true, effect: reservation.effect, results: reservation.effect.result };
    }

    await this.afterReserve({ input, reservation });
    await this.adapter.ensureReady(input.execution);

    // No await may be introduced between this final server-clock fence and the
    // ready adapter call. dispatchReady must enqueue the whole effect synchronously.
    const dispatch = this.database.beginHostExecutorEffectDispatch(input);
    if (!dispatch.dispatch) {
      return { replayed: true, effect: dispatch.effect, results: dispatch.effect.result };
    }
    let pending;
    try {
      pending = this.adapter.dispatchReady(
        input.execution,
        input.operations,
      );
    } catch (error) {
      this.database.markHostExecutorEffectUncertain(input.effectKey, dispatch.dispatchToken);
      throw error;
    }

    try {
      const results = await pending;
      const effect = this.database.completeHostExecutorEffect(
        input.effectKey,
        dispatch.dispatchToken,
        results,
      );
      return { replayed: false, effect, results };
    } catch (error) {
      const singleDefinitiveRejection = input.operations.length === 1
        && error?.definitiveRejection === true;
      const modelCapacity = singleDefinitiveRejection
        && SELECTED_MODEL_CAPACITY_ERROR.test(
          typeof error?.message === "string" ? error.message : "",
        );
      if (modelCapacity) {
        this.database.releaseHostExecutorEffectAfterRejection(
          input.effectKey,
          dispatch.dispatchToken,
        );
        throw new ApiError(
          503,
          "HOST_EXECUTOR_MODEL_CAPACITY",
          "Selected model is at capacity. Please try a different model.",
        );
      }
      this.database.markHostExecutorEffectUncertain(input.effectKey, dispatch.dispatchToken);
      if (singleDefinitiveRejection) {
        throw new ApiError(
          502,
          "HOST_EXECUTOR_RPC_REJECTED",
          "Codex app-server rejected the host executor RPC; delivery is uncertain",
        );
      }
      throw error;
    }
  }
}

export function createHostExecutorDispatcher(options) {
  return new HostExecutorDispatcher(options);
}
