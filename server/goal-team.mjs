import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const RESULT_FENCE = "taskboard-goal-team-result";
const REPORT_FENCE = "taskboard-goal-validation";
const CONTEXT_FENCE = "taskboard-goal-team-context";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fencedJson(text, fence) {
  const matches = [...String(text).matchAll(new RegExp("```" + fence + "\\s*\\n([\\s\\S]*?)```", "g"))];
  if (matches.length !== 1) return null;
  try { return JSON.parse(matches[0][1]); } catch { return null; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

async function worktreeIdentity(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    const resolved = await realpath(value);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function goalTeamContext(events, runId) {
  const event = events.find((item) => item.runId === runId && item.type === "user_message");
  return event ? fencedJson(event.content, CONTEXT_FENCE) : null;
}

export function buildGoalTeamPrompt({ goal, thread, input, taskctlPath, runtimeFile }) {
  const context = {
    schema: "taskboard-goal-team-context.v1", roundId: input.requestId,
    goalId: goal.id, projectId: goal.projectId, version: input.version, resumeToken: input.resumeToken,
    coordinatorThreadId: thread.id, coordinatorCodexThreadId: thread.codexThreadId,
    model: thread.model, reasoningEffort: thread.reasoningEffort, workflowProfile: goal.workflowProfile,
    admission: input.admission,
  };
  return [
    "Execute one dependency-ready deliverable of this goal, then obtain independent validation and publish the actual artifact/result. This is one bounded team round, not the planning-only action.",
    "```" + CONTEXT_FENCE + "\n" + JSON.stringify(context) + "\n```",
    `Use only the protected CLI ${JSON.stringify(taskctlPath)} with --runtime-file ${JSON.stringify(runtimeFile)}. Never print its tokenized descriptor.`,
    "TASKBOARD ACCESS — include this paragraph unchanged in BOTH developer and validator prompts: Already-authorized Taskboard access still obeys host sandbox permissions; read-only product scope does not itself grant loopback access. A generic SERVICE_UNAVAILABLE or fetch failed is not proof of sandbox/network denial. If actual host/tool permission evidence confirms the sandbox blocks the required loopback access, use only the currently available host-controlled on-request approval path for that exact protected CLI command, runtime, target and authorized operation; let the existing reviewer decide and proceed only if granted. Do not request escalation by default, assume an unavailable tool option, bypass approval, change the endpoint, read tokens, enable network globally, weaken sandbox settings or expand writable authority. Explicit host denial, unavailable approval, stale admission or an ownership conflict remains blocked. If the approved exact command still fails, record that actual failure and stop; do not probe other endpoints or blindly retry.",
    "AUTHORITY: context.admission is the service's recorded project-policy/repository/ownership and API-only resource observation for this explicit start, not an injector permit or blanket future-command grant. Read the recorded policy IDs/versions and actual source evidence through protected authority list, current goal/child Capsules and project instructions. The service checked the mapped repository and coordinator Git identity; preserve that exact repository/common Git directory and original goal binding. Do not infer authority from vibe, AGENTS prose, a remote URL or this prompt. A revoked/stale/mismatched policy, foreign claim or domain/global route remains blocked; do not grant yourself policy or change routing. Peak topology is this coordinator plus ONE child; developer and validator are serial.",
    "Before child dispatch, prepare the selected leaf's exact Task Authorization Envelope V1 in a protected comment: useStandingAuthority true, repository exactly context.admission.authority.repository.repository; declared edit paths and focused test suites only. Keep gates approval_required with approver and approvalRequest describing the recorded standing policy, never set them authorized by fiat. Each pending action needs id/order/text/gate/target/status and standingScope ({kind:'edit',paths:[actual worktree-relative files]} or {kind:'test',suites:['focused']}). Include all prior envelope comment IDs in supersedesCommentIds when replacing an envelope. YOU derive actual paths/actions from the goal and project, not the Owner. After real worktree binding, bootstrap the leaf and require standingAuthority.state matched and every proposed action ID in authorizedActionIds before any claim/edit/test. A listed Safe Action is evidence of matching scope, not proof that it executed. No commit/push/PR/delete/merge/deployment is admitted by this round.",
    "RESOURCE BOUNDARY: preserve context.admission.resources raw taskboard-api observation, measured time, known hosted activity and budget in both role prompts. This is best-effort admission, not CPU reservation or complete knowledge of external tasks; storage and I/O are unknown unless freshly measured. Recheck actual resources using the available project/role Skills before each serial child and substantive direct command; stay within the recorded per-role CPU/RAM/thread/storage envelope, do not invent resident-injector observations, admission IDs or permits. Tight/unknown headroom means checkpoint/wait visibly, not new Owner permission or automatic heavy work. No permanent sampler, nested team or process termination.",
    "1. Read issue bootstrap for this exact goal, all goal/child comments and existing descendants, and relevant project AGENTS/Skills. Check the reviewed version/resume token before writes. Choose ONE unarchived todo leaf with actually satisfied dependencies and no foreign claim/open run. Do not change statuses/dependencies to manufacture readiness. Preserve existing deliverables and exact workflowProfile; any genuinely needed new child must explicitly use --workflow-profile " + goal.workflowProfile + ".",
    "2. Verify the authorized repository/base and prepare a real feature Git worktree before creating the developer thread. Reuse only a correctly owned existing worktree; preserve dirty work and foreign bindings. Update ONLY the selected leaf with its real absolute worktree path/branch and full local Root binding to this coordinator's actual Codex identity. Use issue update --worktree-path ABSOLUTE_WORKTREE_PATH --worktree-branch BRANCH --binding-thread-id COORDINATOR_CODEX_ID --binding-codex-project-id ACTUAL_PROJECT_ID --binding-codex-project-kind local --binding-codex-host-id local --binding-workspace-path ABSOLUTE_COORDINATOR_WORKSPACE, with current version. Do not alter the goal's original window association. Stop if actual domain/global lease routing rejects this route; do not weaken it.",
    `3. Read background get ${thread.id} to record THIS coordinator hosted run ID. Prepare the developer prompt in an owned evidence directory outside product files. Use background create --project ${goal.projectId} --issue SELECTED_CHILD --title 'CHILD_TITLE · 开发' --model ${thread.model} --reasoning-effort ${thread.reasoningEffort} --sandbox workspace-write, then background start HOSTED_UUID --request-id ROUND-developer --message-file PROMPT. The hosted UUID is not a Codex identity. Record each actual returned ID before the next operation.`,
    `The developer must first bootstrap, verify the exact standing-authority action match, then successfully issue claim CHILD --agent-path /root/goal-team/ROUND/developer --root-thread-id ${thread.codexThreadId} --lease-minutes WITHIN_CURRENT_RESOURCE_BOUND --write-scope 'RELATIVE_PATH,RELATIVE_PATH' --if-version CURRENT. Unlike --worktree-path, each --write-scope entry must be relative to that task worktree, never an absolute path, '.' or a path containing '..'. Syntax-only example: --write-scope 'src/main.mjs,README.md'; replace these examples with the exact admitted product paths, without prepending the absolute worktree directory. Its own real CODEX_THREAD_ID supplies Agent identity; never substitute a hosted UUID. No product edit before claim succeeds. Include the exact goal/leaf acceptance, actual base/worktree/write scope, CLI/runtime, models, project Skills, recorded policy/action/resource evidence and admitted limits. Apply only the already-selected role-bounded workflow, no nested team or extra reviewer.`,
    "4. Developer implements this leaf's main path only, runs the real artifact/direct check, and freezes a complete candidate (Git base/head plus sorted full changed/untracked product-file manifest, including modes and deleted files). Candidate digest is SHA256 of UTF-8 JSON.stringify(files), where each sorted entry has keys path,mode,sha256 in that order; deleted files use mode 'deleted', sha256 null. Exclude only owned evidence reports outside product scope, not untracked product files. Produce an actual usable artifact file or source archive; upload it with attachment upload --task CHILD --file ARTIFACT. Record the returned attachment ID and SHA256 of the exact uploaded bytes. Record command/exit/output evidence and a task-run checkpoint, then run finish TASK_RUN --status completed --if-version CURRENT --summary ... --next-action 'Independent validation and Owner acceptance pending'. This means implementation complete/in_review, not independently approved or done.",
    "5. Wait for BOTH developer hosted run completed/exit0 and its durable task-agent run completed; confirm the actual writer is finished before inspecting/freezing candidate. A failed/interrupted run, active lease, timeout or unavailable provider is a recorded blocked round, not permission to duplicate it. Keep exact IDs in a goal progress comment before waiting. Use only bounded waits/checkpoints on these known IDs; no resident scheduler or automatic repair loop.",
    `6. After the writer is finished, create a DISTINCT validator hosted thread on that same child/worktree with title 'CHILD_TITLE · 独立验证', model ${thread.model}, reasoning effort ${thread.reasoningEffort}, sandbox workspace-write. Give complete raw requirements, exact base/head/manifest/digest, actual artifact attachment/hash and developer direct evidence. Validator product scope is READ-ONLY (role restriction, not a claim of kernel isolation); it may write only its separate report/evidence directory and upload its report. It does not claim, edit product, finish a task run, spawn helpers, merge or mark done. It must remeasure/check admitted resources before any direct commands.`,
    "7. Validator independently reads the exact candidate and runs the actual artifact. It must author one JSON report with the schema below, save/upload those JSON bytes as a CHILD attachment, and include that exact complete JSON in its final assistant message inside a ```taskboard-goal-validation fence. Report checks need real command, exitCode and observed output; PASS requires no remaining findings. Use needs_fix plus concrete findings otherwise. Empty PASS prose or exit0 alone is not a report. Report identities must be read from its own CODEX_THREAD_ID and background get, not copied from the developer.",
    JSON.stringify({
      schema: "taskboard-goal-validation.v1", roundId: "EXACT_ROUND", goalId: "EXACT_GOAL", childId: "EXACT_CHILD",
      developer: { threadId: "HOSTED_UUID", codexThreadId: "ACTUAL_CODEX_ID", runId: "HOSTED_RUN", taskRunId: "DURABLE_TASK_RUN" },
      validator: { threadId: "DISTINCT_HOSTED_UUID", codexThreadId: "DISTINCT_ACTUAL_CODEX_ID", runId: "VALIDATOR_HOSTED_RUN" },
      candidate: { base: "GIT_BASE", head: "GIT_HEAD", digest: "MANIFEST_SHA256", files: [{ path: "product-file", mode: "644", sha256: "FILE_SHA256" }], artifactAttachmentId: "CHILD_ATTACHMENT", artifactSha256: "ARTIFACT_SHA256" },
      verdict: "PASS or needs_fix", summary: "Concrete outcome", checks: [{ command: "Exact command", exitCode: 0, output: "Observed output" }], findings: [],
    }),
    "8. Wait for the separate validator hosted run to finish. Read the complete report and actual candidate; verify report/manifest/artifact hashes, all real identities, developer-before-validator ordering and child in_review. On PASS publish review_pass, on findings needs_fix, on missing evidence blocked. Upload/report through protected taskctl only. Append the same final receipt to BOTH exact child and goal, in one ```taskboard-goal-team-result fence, using schema below. The report attachment is the validator's uploaded JSON bytes, not a coordinator rewrite. Provide a short user-facing summary and the existing attachment download link. End this round; child stays in_review and ownerAcceptance pending. No goal done/100%, other-leaf work, company tasks, original-window rebinding, deployment, commit/push/merge/release or unbounded automatic fixes.",
    JSON.stringify({
      schema: "taskboard-goal-team-result.v1", roundId: "EXACT_ROUND", goalId: "EXACT_GOAL", childId: "EXACT_CHILD",
      status: "review_pass or needs_fix or blocked", summary: "Readable result", ownerAcceptance: "pending",
      coordinator: { threadId: thread.id, codexThreadId: thread.codexThreadId, runId: "THIS_HOSTED_RUN" },
      developer: "EXACT developer object from report", validator: "EXACT validator object from report",
      candidate: "EXACT candidate object from report", reportAttachmentId: "VALIDATOR_REPORT_ATTACHMENT", reportSha256: "REPORT_BYTES_SHA256",
    }),
    "For a blocked round, include the known goal/round/coordinator IDs and concrete blocker summary; unknown child/developer/validator/candidate/report fields may be null. Never manufacture missing receipts. Preserve any already launched child identity for recovery.",
  ].join("\n\n");
}

export async function readGoalTeamResult({ database, goal, thread, attachmentsDirectory }) {
  if (!thread) return null;
  const comments = database.listComments(goal.id);
  const source = comments.filter((comment) => comment.body.includes("```" + RESULT_FENCE)).at(-1);
  if (!source) return null;
  const receipt = fencedJson(source.body, RESULT_FENCE);
  const unverified = (reason) => ({ verification: "unverified", status: "blocked", summary: reason, commentId: source.id });
  if (receipt?.schema !== "taskboard-goal-team-result.v1" || receipt.goalId !== goal.id
    || receipt.ownerAcceptance !== "pending" || typeof receipt.summary !== "string"
    || receipt.coordinator?.threadId !== thread.id || receipt.coordinator.codexThreadId !== thread.codexThreadId
    || source.threadId !== thread.codexThreadId) return unverified("本轮结果记录尚未绑定到当前协调 Agent。");
  if (typeof receipt.coordinator.runId !== "string" || typeof receipt.roundId !== "string") {
    return unverified("本轮结果缺少实际执行标识。");
  }
  const coordinatorRun = database.getAiChatRun(receipt.coordinator.runId);
  const coordinatorEvents = database.listAiChatEvents(thread.id);
  const latestTeamEvent = coordinatorEvents.filter((event) => event.type === "user_message"
    && fencedJson(event.content, CONTEXT_FENCE)).at(-1);
  if (latestTeamEvent?.runId !== coordinatorRun?.id) return null;
  const context = goalTeamContext(coordinatorEvents, coordinatorRun?.id);
  if (coordinatorRun?.threadId !== thread.id || context?.roundId !== receipt.roundId
    || context.goalId !== goal.id) return unverified("本轮结果缺少对应的真实协调执行。");
  if (receipt.status === "blocked") return {
    verification: "recorded", status: "blocked", summary: receipt.summary,
    roundId: receipt.roundId, childId: receipt.childId ?? null, commentId: source.id,
  };
  if (!['review_pass', 'needs_fix'].includes(receipt.status)) return unverified("本轮结果状态无法确认。");
  if (coordinatorRun.status !== "completed" || coordinatorRun.exitCode !== 0) return unverified("协调执行尚未完成，最终结果待核对。");
  if (![receipt.childId, receipt.developer?.threadId, receipt.developer?.codexThreadId,
    receipt.developer?.runId, receipt.developer?.taskRunId, receipt.validator?.threadId,
    receipt.validator?.codexThreadId, receipt.validator?.runId, receipt.reportAttachmentId,
    receipt.candidate?.artifactAttachmentId].every((value) => typeof value === "string" && value)) {
    return unverified("本轮结果缺少开发、验证或产物的实际标识。");
  }
  const child = database.getTask(receipt.childId);
  let ancestor = child;
  const visited = new Set();
  while (ancestor && ancestor.id !== goal.id && !visited.has(ancestor.id)) {
    visited.add(ancestor.id);
    ancestor = ancestor.relations.parent ? database.getTask(ancestor.relations.parent.id) : null;
  }
  if (!child || ancestor?.id !== goal.id || child.projectId !== goal.projectId
    || child.status !== "in_review" || child.archivedAt) return unverified("交付子项或待验收状态与目标不一致。");
  const developer = database.getAiChatThread(receipt.developer?.threadId);
  const validator = database.getAiChatThread(receipt.validator?.threadId);
  const developerRun = database.getAiChatRun(receipt.developer?.runId);
  const validatorRun = database.getAiChatRun(receipt.validator?.runId);
  const taskRun = database.getTaskAgentRun(receipt.developer?.taskRunId);
  const members = [developer, validator];
  const [childWorktree, developerWorktree, validatorWorktree, taskRunWorktree] = await Promise.all([
    child.developmentContext?.path, developer?.origin.workspacePath,
    validator?.origin.workspacePath, taskRun?.worktree?.path,
  ].map(worktreeIdentity));
  if (members.some((member, index) => !member || member.origin.issueId !== child.id
    || member.origin.projectId !== goal.projectId || !childWorktree
    || [developerWorktree, validatorWorktree][index] !== childWorktree
    || member.codexThreadId !== [receipt.developer, receipt.validator][index]?.codexThreadId)
    || new Set([thread.id, developer?.id, validator?.id]).size !== 3
    || new Set([thread.codexThreadId, developer?.codexThreadId, validator?.codexThreadId]).size !== 3
    || !developer?.codexThreadId || !validator?.codexThreadId) return unverified("开发与独立验证的真实身份或工作区尚未核对通过。");
  if ([developerRun, validatorRun].some((run, index) => !run || run.threadId !== members[index].id
    || run.status !== "completed" || run.exitCode !== 0)
    || !(Date.parse(developerRun.finishedAt) <= Date.parse(validatorRun.startedAt))
    || taskRun?.taskId !== child.id || taskRun.agentThreadId !== developer.codexThreadId
    || taskRun.rootThreadId !== thread.codexThreadId || taskRun.status !== "completed"
    || taskRunWorktree !== childWorktree
    || !(Date.parse(taskRun.finishedAt) <= Date.parse(validatorRun.startedAt))) return unverified("尚未核实开发终态、认领记录及随后独立验证的完整顺序。");
  const artifact = database.getAttachment(receipt.candidate?.artifactAttachmentId);
  const reportAttachment = database.getAttachment(receipt.reportAttachmentId);
  if (artifact?.taskId !== child.id || reportAttachment?.taskId !== child.id
    || artifact.size <= 0 || reportAttachment.size <= 0 || reportAttachment.size > 1_048_576) return unverified("缺少此子项的实际产物或独立报告附件。");
  try {
    const [artifactBytes, reportBytes] = await Promise.all([
      readFile(path.join(attachmentsDirectory, artifact.id)), readFile(path.join(attachmentsDirectory, reportAttachment.id)),
    ]);
    if (sha256(artifactBytes) !== receipt.candidate.artifactSha256 || sha256(reportBytes) !== receipt.reportSha256) {
      return unverified("实际产物或报告内容与记录的摘要不符。");
    }
    const report = JSON.parse(reportBytes.toString("utf8"));
    const actualReport = database.listAiChatEvents(validator.id).some((event) => event.runId === validatorRun.id
      && event.type === "agent_message" && event.role === "assistant" && same(fencedJson(event.content, REPORT_FENCE), report));
    const files = receipt.candidate.files;
    const manifestValid = Array.isArray(files) && files.length > 0 && files.length <= 1000
      && files.every((file) => typeof file.path === "string" && file.path.length > 0
        && typeof file.mode === "string" && (file.sha256 === null || /^[a-f0-9]{64}$/.test(file.sha256)))
      && sha256(JSON.stringify(files)) === receipt.candidate.digest;
    if (!actualReport || report.schema !== "taskboard-goal-validation.v1" || report.roundId !== receipt.roundId
      || report.goalId !== goal.id || report.childId !== child.id || !same(report.developer, receipt.developer)
      || !same(report.validator, receipt.validator) || !same(report.candidate, receipt.candidate)
      || !manifestValid || !/^[a-f0-9]{40,64}$/.test(receipt.candidate.base)
      || !/^[a-f0-9]{40,64}$/.test(receipt.candidate.head)
      || !Array.isArray(report.checks) || report.checks.length === 0
      || !report.checks.every((check) => typeof check.command === "string" && check.command.trim()
        && Number.isInteger(check.exitCode) && typeof check.output === "string")
      || !Array.isArray(report.findings)
      || (receipt.status === "review_pass" && (report.verdict !== "PASS" || report.findings.length !== 0
        || report.checks.some((check) => check.exitCode !== 0)))
      || (receipt.status === "needs_fix" && (report.verdict !== "needs_fix" || report.findings.length === 0))) {
      return unverified("独立验证报告尚未与真实验证输出、完整候选及直接检查绑定。");
    }
    return {
      verification: "verified", status: receipt.status, summary: receipt.summary,
      roundId: receipt.roundId, childId: child.id, childIdentifier: child.identifier,
      commentId: source.id, ownerAcceptance: "pending",
      developerStatus: developerRun.status, validatorStatus: validatorRun.status,
      artifact: { id: artifact.id, filename: artifact.filename },
      report: { id: reportAttachment.id, filename: reportAttachment.filename },
    };
  } catch {
    return unverified("产物或报告暂时不可读取；未将本轮认定为已验证完成。");
  }
}
