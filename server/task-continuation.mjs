// Continuation records describe an agreement. They never grant or dispatch work.
export function normalizeContinuationRecord(input) {
  const invalid = (field) => { throw new TypeError(`Invalid continuation field '${field}'`); };
  const object = (value, keys, field) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(value, key))) invalid(field);
  };
  const text = (value, field, limit = 256) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit) invalid(field);
    return value;
  };
  const nullableText = (value, field, limit) => value === null ? null : text(value, field, limit);
  const list = (value, field, count, limit) => {
    if (!Array.isArray(value) || value.length > count) invalid(field);
    return value.map((item) => text(item, field, limit));
  };
  object(input, [
    "eventId", "idempotencyKey", "senderThreadId", "expectedRecordId", "expectedResumeToken",
    "goal", "sourceRefs", "authorizationSource", "actionIds", "stopBoundary", "status", "checkpoint",
  ], "record");
  const checkpoint = input.checkpoint;
  object(checkpoint, ["summary", "nextActionId", "waitingKind", "waitingDetail", "retryAt"], "checkpoint");
  if (!["active", "paused", "canceled", "endpoint_reached"].includes(input.status)) invalid("status");
  if (!["none", "resource", "dependency", "decision", "authorization"].includes(checkpoint.waitingKind)) {
    invalid("checkpoint.waitingKind");
  }
  const retryAt = nullableText(checkpoint.retryAt, "checkpoint.retryAt", 64);
  if (retryAt !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(retryAt)
    || !Number.isFinite(Date.parse(retryAt)))) invalid("checkpoint.retryAt");
  let authorizationSource = null;
  if (input.authorizationSource !== null) {
    object(input.authorizationSource, ["commentId", "commentVersion"], "authorizationSource");
    if (!Number.isSafeInteger(input.authorizationSource.commentVersion)
      || input.authorizationSource.commentVersion < 1) invalid("authorizationSource.commentVersion");
    authorizationSource = {
      commentId: text(input.authorizationSource.commentId, "authorizationSource.commentId"),
      commentVersion: input.authorizationSource.commentVersion,
    };
  }
  return {
    eventId: text(input.eventId, "eventId"),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
    senderThreadId: text(input.senderThreadId, "senderThreadId"),
    expectedRecordId: nullableText(input.expectedRecordId, "expectedRecordId"),
    expectedResumeToken: text(input.expectedResumeToken, "expectedResumeToken"),
    goal: text(input.goal, "goal", 16_384),
    sourceRefs: list(input.sourceRefs, "sourceRefs", 32, 2_048),
    authorizationSource,
    actionIds: list(input.actionIds, "actionIds", 64, 256),
    stopBoundary: text(input.stopBoundary, "stopBoundary", 8_192),
    status: input.status,
    checkpoint: {
      summary: text(checkpoint.summary, "checkpoint.summary", 8_192),
      nextActionId: nullableText(checkpoint.nextActionId, "checkpoint.nextActionId"),
      waitingKind: checkpoint.waitingKind,
      waitingDetail: nullableText(checkpoint.waitingDetail, "checkpoint.waitingDetail", 8_192),
      retryAt,
    },
  };
}

export function continuationBasis(capsule, evaluation) {
  return {
    taskId: capsule.task.id,
    projectId: capsule.task.projectId,
    taskVersion: capsule.task.version,
    binding: capsule.execution.threadBinding,
    requirementsRevision: capsule.requirementsRevision,
    authorization: {
      source: evaluation.effectiveAuthorization.source,
      state: evaluation.effectiveAuthorization.state,
      appliedOwnerDecisionReceiptIds: evaluation.appliedOwnerDecisionReceipts.map((receipt) => receipt.id),
      pendingActions: evaluation.pendingActions,
      gates: [...evaluation.gatesById.values()],
      standingAuthority: evaluation.standingAuthority,
      evaluatedAt: evaluation.evaluatedAt,
    },
  };
}

export function normalizeOwnedTerminalNotification(notification) {
  if (notification?.method !== "turn/completed" || Object.hasOwn(notification, "id")) return null;
  const { threadId, turn } = notification.params ?? {};
  const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  if (!identifier(threadId) || !identifier(turn?.id)
    || !["completed", "interrupted", "failed"].includes(turn?.status)) return null;
  return { threadId, turnId: turn.id, turnStatus: turn.status };
}

export function assessTaskContinuation({ record, capsule, evaluation, currentClaim, terminalCheckpoint = null }) {
  const current = continuationBasis(capsule, evaluation);
  const recordedTerminalCheckpoint = record && terminalCheckpoint
    && terminalCheckpoint.continuationRecordId === record.eventId
    && terminalCheckpoint.projectId === current.projectId
    && JSON.stringify(terminalCheckpoint.bindingAtObservation) === JSON.stringify(current.binding)
    ? terminalCheckpoint : null;
  const result = (assessment, reason, nextCoordinationAction) => ({
    record, assessment, reasonCodes: [reason], agreementEventId: record?.eventId ?? null,
    basis: { current, recorded: record?.basis ?? null },
    recordedWait: record ? {
      kind: record.checkpoint.waitingKind, detail: record.checkpoint.waitingDetail,
      retryAt: record.checkpoint.retryAt, source: "recorded",
    } : null,
    stopBoundary: record?.stopBoundary ?? null,
    nextCoordinationAction, queriedAt: evaluation.evaluatedAt,
    liveExecution: "unknown", eligibleForDispatch: false,
    recordedTerminalCheckpoint,
  });
  if (!record) return result("not_enrolled", "continuation_not_recorded", "record_existing_agreement");
  if (capsule.task.archivedAt !== null || ["canceled", "done"].includes(capsule.task.status)) {
    return result("stopped", capsule.task.archivedAt !== null ? "task_archived" : `task_${capsule.task.status}`, "none");
  }
  if (record.status !== "active") {
    return result(record.status === "endpoint_reached" ? "recorded_endpoint_reached" : "stopped",
      `agreement_${record.status}`, "none");
  }
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(record.basis.binding, current.binding) || record.basis.projectId !== current.projectId) {
    return result("needs_reconciliation", "task_binding_changed", "reconcile_current_binding");
  }
  if (record.basis.requirementsRevision !== current.requirementsRevision) {
    return result("needs_reconciliation", "task_requirements_changed", "reconcile_current_requirements");
  }
  if (record.authorizationSource !== null && !same(record.authorizationSource, current.authorization.source)) {
    return result("needs_reconciliation", "authorization_source_changed", "reconcile_authorization_evidence");
  }
  if (currentClaim?.status === "active" || [capsule.activeRun, capsule.latestRun].some((run) => (
    run && ["active", "blocked", "claimed", "running", "admission_uncertain", "expired_unresolved", "interrupted"].includes(run.state)
  ))) {
    return result("execution_observation_required", "unresolved_execution_evidence", "observe_current_execution");
  }
  if (capsule.relations.blockedBy.some((dependency) => dependency.status !== "done")) {
    return result("waiting_dependency", "current_dependency_unresolved", "observe_dependency_completion");
  }
  const { waitingKind, retryAt, nextActionId } = record.checkpoint;
  if (["dependency", "decision"].includes(waitingKind)) {
    return result(`waiting_${waitingKind}`, `recorded_${waitingKind}_wait`, `reconcile_recorded_${waitingKind}`);
  }
  if (waitingKind === "resource") {
    const due = retryAt !== null && Date.parse(retryAt) <= Date.parse(evaluation.evaluatedAt);
    return result(due ? "resource_observation_due" : "waiting_resource",
      due ? "recorded_retry_time_reached" : retryAt === null ? "resource_retry_time_not_recorded" : "recorded_resource_wait",
      due ? "observe_resource_capacity" : "retain_resource_queue");
  }
  if (nextActionId === null) return result("next_step_not_recorded", "next_action_not_recorded", "record_next_step");
  if (record.authorizationSource === null || evaluation.effectiveAuthorization.state !== "valid") {
    return result("authorization_evidence_required", "authorization_evidence_missing_or_invalid", "reconcile_authorization_evidence");
  }
  const action = evaluation.pendingActions.find((candidate) => candidate.id === nextActionId);
  const gate = action ? evaluation.gatesById.get(action.gate) : null;
  if (!record.actionIds.includes(nextActionId) || !action || gate?.state !== "authorized") {
    return result("authorization_not_effective", gate?.expired ? "authorization_expired"
      : gate?.state === "denied" ? "authorization_denied" : "next_action_not_authorized", "reconcile_authorization_evidence");
  }
  return result("runtime_observation_required", "action_authorized_runtime_unknown", "observe_runtime_before_continuation");
}
