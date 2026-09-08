const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requiredString(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`Host executor lifecycle requires ${field}`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== "function") {
    throw new Error(`Host executor lifecycle requires ${field}`);
  }
  return value;
}

function validateRegistration(value, expected) {
  const registration = value?.registration;
  if (!registration
    || registration.codexHostId !== expected.codexHostId
    || registration.executorInstanceId !== expected.executorInstanceId
    || registration.adapterId !== expected.adapterId
    || !SHA256_PATTERN.test(registration.fingerprint ?? "")
    || !Array.isArray(registration.capabilities)
    || registration.capabilities.length < 1) {
    throw new Error("Taskboard returned an invalid host executor registration");
  }
  return registration;
}

function registrationMatches(candidate, expected) {
  return candidate?.codexHostId === expected.codexHostId
    && candidate?.executorInstanceId === expected.executorInstanceId
    && candidate?.adapterId === expected.adapterId
    && candidate?.fingerprint === expected.fingerprint;
}

function validateInspection(value, expectedRegistration) {
  if (!value
    || value.codexHostId !== expectedRegistration.codexHostId
    || !Array.isArray(value.registrations)
    || !value.registrations.some((candidate) => (
      registrationMatches(candidate, expectedRegistration)
    ))) {
    throw new Error("Taskboard did not confirm the exact host executor registration");
  }
  if (value.lease !== null && (typeof value.lease !== "object" || Array.isArray(value.lease))) {
    throw new Error("Taskboard returned an invalid host executor lease state");
  }
  return value;
}

function leaseOwnedBy(lease, registration) {
  return lease?.codexHostId === registration.codexHostId
    && lease?.executorInstanceId === registration.executorInstanceId
    && lease?.registrationFingerprint === registration.fingerprint;
}

function receiptMatches(receipt, lease, registration, action) {
  return receipt?.action === action
    && receipt?.codexHostId === registration.codexHostId
    && receipt?.executorInstanceId === registration.executorInstanceId
    && receipt?.leaseId === lease?.id;
}

function validateActiveLease(value, registration, action) {
  const lease = value?.lease;
  if (!lease
    || typeof lease.id !== "string"
    || !lease.id
    || lease.status !== "active"
    || !leaseOwnedBy(lease, registration)
    || !receiptMatches(value?.receipt, lease, registration, action)) {
    throw new Error(`Taskboard returned an invalid host executor ${action} receipt`);
  }
  return lease;
}

function stateCopy({ active, reason, registration, lease, error }) {
  return {
    active,
    reason,
    registration: registration ? { ...registration } : null,
    lease: lease ? { ...lease } : null,
    error,
  };
}

export function createHostExecutorLeaseLifecycle({
  codexHostId,
  executorInstanceId,
  adapterId,
  leaseDurationSeconds = 120,
  renewIntervalMs = 30_000,
  register,
  inspect,
  acquire,
  renew,
  release,
  schedule = (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  cancel = clearInterval,
  now = Date.now,
  createOperationId,
  onStateChange = () => {},
  onError = () => {},
}) {
  const identity = {
    codexHostId: requiredString(codexHostId, "codexHostId"),
    executorInstanceId: requiredString(executorInstanceId, "executorInstanceId"),
    adapterId: requiredString(adapterId, "adapterId"),
  };
  if (!Number.isSafeInteger(leaseDurationSeconds)
    || leaseDurationSeconds < 30
    || leaseDurationSeconds > 3600) {
    throw new Error("Host executor lifecycle requires a valid lease duration");
  }
  if (!Number.isSafeInteger(renewIntervalMs)
    || renewIntervalMs < 1
    || renewIntervalMs >= leaseDurationSeconds * 1_000) {
    throw new Error("Host executor lifecycle requires a renewal interval inside the lease duration");
  }
  const transport = {
    register: requireFunction(register, "register"),
    inspect: requireFunction(inspect, "inspect"),
    acquire: requireFunction(acquire, "acquire"),
    renew: requireFunction(renew, "renew"),
    release: requireFunction(release, "release"),
  };
  requireFunction(schedule, "schedule");
  requireFunction(cancel, "cancel");
  requireFunction(now, "now");
  requireFunction(createOperationId, "createOperationId");
  requireFunction(onStateChange, "onStateChange");
  requireFunction(onError, "onError");

  let registration = null;
  let lease = null;
  let active = false;
  let reason = "not-started";
  let error = null;
  let started = false;
  let stopped = false;
  let timer = null;
  let reconcileInFlight = null;
  let startInFlight = null;
  let stopInFlight = null;
  let stopCompleted = false;

  function hasFreshActiveLease() {
    if (!active || stopped || lease?.status !== "active") return false;
    const observedAtMs = Number(now());
    const acquiredAtMs = Date.parse(lease.acquiredAt);
    const expiresAtMs = Date.parse(lease.expiresAt);
    return Number.isFinite(observedAtMs)
      && Number.isFinite(acquiredAtMs)
      && Number.isFinite(expiresAtMs)
      && acquiredAtMs < expiresAtMs
      && acquiredAtMs <= observedAtMs
      && observedAtMs < expiresAtMs;
  }

  const snapshot = () => stateCopy({
    active: hasFreshActiveLease(), reason, registration, lease, error,
  });

  const executionEnvelope = () => {
    if (!hasFreshActiveLease() || !registration || !lease) return null;
    return Object.freeze({
      codexHostId: registration.codexHostId,
      executorInstanceId: registration.executorInstanceId,
      registrationFingerprint: registration.fingerprint,
      leaseId: lease.id,
    });
  };

  function reportError(caught) {
    try {
      onError(caught);
    } catch (_) {}
  }

  function updateState(next) {
    const previous = snapshot();
    const previousKey = JSON.stringify([
      previous.active, previous.reason, previous.lease?.id ?? null,
      previous.lease?.status ?? null, previous.error,
    ]);
    if (Object.hasOwn(next, "active")) active = next.active;
    if (Object.hasOwn(next, "reason")) reason = next.reason;
    if (Object.hasOwn(next, "registration")) registration = next.registration;
    if (Object.hasOwn(next, "lease")) lease = next.lease;
    if (Object.hasOwn(next, "error")) error = next.error;
    const current = snapshot();
    const currentKey = JSON.stringify([
      current.active, current.reason, current.lease?.id ?? null,
      current.lease?.status ?? null, current.error,
    ]);
    if (currentKey !== previousKey) {
      try {
        onStateChange(current);
      } catch (stateError) {
        reportError(stateError);
      }
    }
    return current;
  }

  function operationKey(action) {
    const operationId = requiredString(createOperationId(), "operation id");
    return `host-executor-${action}:${identity.executorInstanceId}:${operationId}`;
  }

  async function performReconcile() {
    if (stopped) return updateState({ active: false, reason: "stopped", error: null });
    try {
      const registered = validateRegistration(await transport.register({
        ...identity,
        idempotencyKey: `host-executor-register:${identity.executorInstanceId}`,
      }), identity);
      registration = registered;
      if (stopped) return updateState({ active: false, reason: "stopped", error: null });

      const current = validateInspection(
        await transport.inspect({ codexHostId: identity.codexHostId }),
        registered,
      ).lease;
      lease = current;
      if (stopped) return updateState({ active: false, reason: "stopped", error: null });

      if (current?.status === "active") {
        if (!leaseOwnedBy(current, registered)) {
          return updateState({
            active: false,
            reason: "lease-held-by-another",
            lease: current,
            error: null,
          });
        }
        const renewed = validateActiveLease(await transport.renew({
          codexHostId: identity.codexHostId,
          executorInstanceId: identity.executorInstanceId,
          registrationFingerprint: registered.fingerprint,
          expectedLeaseId: current.id,
          leaseDurationSeconds,
          idempotencyKey: operationKey("renew"),
        }), registered, "renewed");
        lease = renewed;
        if (stopped) return updateState({ active: false, reason: "stopped", error: null });
        return updateState({
          active: true,
          reason: "lease-renewed",
          registration: registered,
          lease: renewed,
          error: null,
        });
      }

      if (current !== null && !["expired", "released"].includes(current.status)) {
        throw new Error("Taskboard returned an invalid host executor lease status");
      }
      const acquired = validateActiveLease(await transport.acquire({
        codexHostId: identity.codexHostId,
        executorInstanceId: identity.executorInstanceId,
        registrationFingerprint: registered.fingerprint,
        expectedLeaseId: current?.id ?? null,
        leaseDurationSeconds,
        idempotencyKey: operationKey("acquire"),
      }), registered, "acquired");
      lease = acquired;
      if (stopped) return updateState({ active: false, reason: "stopped", error: null });
      return updateState({
        active: true,
        reason: "lease-acquired",
        registration: registered,
        lease: acquired,
        error: null,
      });
    } catch (reconcileError) {
      const uncertain = updateState({
        active: false,
        reason: stopped ? "stopped" : "reconcile-uncertain",
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
      reportError(reconcileError);
      return uncertain;
    }
  }

  function reconcile() {
    if (stopped) return Promise.resolve(snapshot());
    if (reconcileInFlight) return reconcileInFlight;
    const pending = performReconcile().finally(() => {
      if (reconcileInFlight === pending) reconcileInFlight = null;
    });
    reconcileInFlight = pending;
    return pending;
  }

  function start() {
    if (startInFlight) return startInFlight;
    if (started) return reconcile();
    started = true;
    const pending = (async () => {
      const state = await reconcile();
      if (!stopped && timer === null) {
        timer = schedule(() => void reconcile(), renewIntervalMs);
      }
      return state;
    })().finally(() => {
      if (startInFlight === pending) startInFlight = null;
    });
    startInFlight = pending;
    return pending;
  }

  function stop() {
    if (stopInFlight) return stopInFlight;
    if (stopCompleted) return Promise.resolve(snapshot());
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    const pending = (async () => {
      if (reconcileInFlight) await reconcileInFlight;
      try {
        if (registration) {
          const current = validateInspection(
            await transport.inspect({ codexHostId: identity.codexHostId }),
            registration,
          ).lease;
          lease = current;
          if (current?.status === "active" && leaseOwnedBy(current, registration)) {
            const released = await transport.release({
              codexHostId: identity.codexHostId,
              executorInstanceId: identity.executorInstanceId,
              registrationFingerprint: registration.fingerprint,
              expectedLeaseId: current.id,
              idempotencyKey: operationKey("release"),
            });
            if (released?.lease?.id !== current.id
              || released?.lease?.status !== "released"
              || !receiptMatches(released?.receipt, released.lease, registration, "released")) {
              throw new Error("Taskboard returned an invalid host executor release receipt");
            }
            lease = released.lease;
          }
        }
      } catch (stopError) {
        error = stopError instanceof Error ? stopError.message : String(stopError);
        reportError(stopError);
      }
      stopCompleted = true;
      return updateState({ active: false, reason: "stopped" });
    })().finally(() => {
      if (stopInFlight === pending) stopInFlight = null;
    });
    stopInFlight = pending;
    return pending;
  }

  return {
    start,
    reconcile,
    stop,
    isActive: hasFreshActiveLease,
    executionEnvelope,
    snapshot,
  };
}
