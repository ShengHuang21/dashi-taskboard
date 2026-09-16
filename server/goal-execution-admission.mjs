import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHostResourceObserver } from "../scripts/host-resource-observer.mjs";
import { normalizeRepository } from "./standing-authority.mjs";

const GIB = 1024 ** 3;
const MAX_AGE_MS = 30_000;
const BUDGET = Object.freeze({
  roles: 2, topology: "coordinator-plus-one-serial-child", cpuPerRole: 1,
  memoryPerRoleBytes: GIB, memoryWarningBytes: 768 * 1024 ** 2,
  commandThreadsPerRole: 1, storageGrowthBytes: 2 * GIB,
  cpuTargetRatio: 0.8, cpuCriticalRatio: 0.95, memoryReserveRatio: 0.2,
  minimumMemoryReserveBytes: 2 * GIB, memoryCriticalRatio: 0.1,
});
const unavailable = (state, code, message, extra = {}) => ({ available: false, state, code, message, ...extra });

// Only the mapped local repository plus an active recorded project policy can admit work.
// A remote URL, workflow profile, prompt, or client flag alone is not authority.
export function createGoalExecutionAdmissionResolver({
  database, resolveContext, processEnv,
  runGit = promisify(execFile),
  observe = createHostResourceObserver({ reporter: "taskboard-api", minimumSampleIntervalMs: 250 }),
  now = Date.now,
}) {
  async function git(workspacePath, args) {
    return (await runGit("git", ["-C", workspacePath, ...args], {
      env: processEnv, timeout: 5_000, windowsHide: true,
    })).stdout.trim();
  }

  async function repositoryAt(workspacePath) {
    const root = await realpath(workspacePath);
    const topLevel = await realpath(await git(root, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== root) throw new Error("Workspace is not the repository root");
    const repository = normalizeRepository(await git(root, ["remote", "get-url", "origin"]));
    if (!repository) throw new Error("A supported canonical repository is required");
    const commonDirectory = await realpath(path.resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
    return { repository, workspacePath: root, commonDirectory,
      branch: await git(root, ["branch", "--show-current"]),
      head: await git(root, ["rev-parse", "HEAD"]), verifiedAt: new Date(now()).toISOString() };
  }

  function policiesFor(projectId, repository) {
    const timestamp = now();
    return database.listProjectStandingAuthorities(projectId).filter((policy) => (
      policy.projectId === projectId && policy.repository === repository && policy.revokedAt === null
      && Date.parse(policy.grantedAt) <= timestamp
      && (policy.expiresAt === null || Date.parse(policy.expiresAt) > timestamp)
    ));
  }

  function ownership(goal, thread) {
    const task = database.getTask(goal.id);
    const binding = task?.threadBinding;
    if (!task || task.archivedAt || task.projectId !== goal.projectId
      || binding?.codexProjectKind === "remote" || (binding?.codexHostId && binding.codexHostId !== "local")) {
      return unavailable("ownership_unavailable", "GOAL_ROUTE_UNAVAILABLE", "目标当前不属于此本机执行路径。");
    }
    const claim = database.getAgentTaskClaim(goal.id);
    const owner = database.getOpenTaskAgentRun(goal.id) ?? (claim?.status === "active" ? claim : null);
    if (owner && owner.agentThreadId !== thread?.codexThreadId) {
      return unavailable("owner_busy", "GOAL_OWNED", "目标已有其他执行者，请先在原任务中协调。");
    }
    const domain = database.getAgentTaskDomainRoute(goal.id);
    const config = database.getAgentLaneProject(goal.projectId);
    const lease = config?.coordinatorLease;
    const holder = lease ? config?.tasks?.find((item) => item.id === lease.holderTaskId) : null;
    const global = lease ? {
      leaseId: lease.id, holderThreadId: holder?.threadId ?? null,
      expiresAt: lease.expiresAt, releasedAt: lease.releasedAt ?? null,
    } : null;
    if ((domain && (domain.status !== "active" || domain.holderThreadId !== thread?.codexThreadId))
      || (!domain && config && !lease && config.rootTaskId == null)
      || (!domain && global && (global.releasedAt || !(Date.parse(global.expiresAt) > now())
        || global.holderThreadId !== thread?.codexThreadId))) {
      return unavailable("owner_busy", "GOAL_COORDINATOR_ROUTE_REQUIRED", "项目已有协调归属，需要沿原协调路径执行。", { route: { domain, global } });
    }
    return { route: { domain, global }, ownerThreadId: owner?.agentThreadId ?? null };
  }

  function resources() {
    const observation = observe();
    const knownRunningHosted = database.listAiChatThreads().filter((item) => item.currentRun)
      .map((item) => ({ threadId: item.id, runId: item.currentRun.id }));
    const evidence = { observation, budget: BUDGET, knownRunningHosted,
      coverage: "this-api-hosted-runs-only; other local activity is reflected in host pressure but not enumerated",
      storage: "unknown", io: "unknown", enforcement: "best-effort-admission-not-os-reservation" };
    const { cpu, memory } = observation ?? {};
    if (observation?.source !== "taskboard-api" || observation.hostId !== "local"
      || !memory || !Number.isFinite(memory.availableBytes) || !Number.isFinite(memory.totalBytes)
      || !Number.isFinite(cpu?.capacity) || now() - Date.parse(observation.observedAt) > MAX_AGE_MS) {
      return unavailable("resources_waiting", "GOAL_RESOURCES_UNKNOWN", "暂时无法核实本机资源，稍后可重新检查。", { resources: evidence });
    }
    if (!Number.isFinite(cpu.busyRatio) || !(cpu.sampleWindowMs > 0) || cpu.sampleWindowMs > MAX_AGE_MS) {
      return unavailable("resources_checking", "GOAL_RESOURCES_CHECKING", "正在检查本机资源。", { resources: evidence });
    }
    const reserve = Math.max(BUDGET.minimumMemoryReserveBytes, Math.ceil(memory.totalBytes * BUDGET.memoryReserveRatio));
    const cpuSlots = Math.floor(Math.max(0, cpu.capacity * (BUDGET.cpuTargetRatio - cpu.busyRatio)) / BUDGET.cpuPerRole);
    const memorySlots = Math.floor(Math.max(0, memory.availableBytes - reserve) / BUDGET.memoryPerRoleBytes);
    // Known hosted work is conservatively retained in addition to measured host pressure.
    const requiredSlots = BUDGET.roles + knownRunningHosted.length;
    const critical = cpu.busyRatio >= BUDGET.cpuCriticalRatio || memory.availableRatio <= BUDGET.memoryCriticalRatio;
    Object.assign(evidence, { cpuSlots, memorySlots, requiredSlots, pressure: critical ? "critical" : "measured" });
    if (critical || Math.min(cpuSlots, memorySlots) < requiredSlots) {
      return unavailable("resources_waiting", "GOAL_RESOURCES_WAITING", "等待本机资源，可稍后重新检查；尚未启动执行。", { resources: evidence });
    }
    return { available: true, resources: evidence };
  }

  function revalidate(goal, thread, admission) {
    const owner = ownership(goal, thread);
    if (owner.state) return owner;
    const policies = policiesFor(goal.projectId, admission.authority.repository.repository);
    const prior = admission.authority.policies;
    if (JSON.stringify(policies.map(({ id, version }) => ({ id, version }))) !== JSON.stringify(prior.map(({ id, version }) => ({ id, version })))
      || now() - Date.parse(admission.authority.repository.verifiedAt) > MAX_AGE_MS
      || JSON.stringify(owner.route) !== JSON.stringify(admission.ownership.route)) {
      return unavailable("permission_unavailable", "GOAL_AUTHORITY_CHANGED", "项目授权或协调归属已变化，请重新核对。");
    }
    const current = resources();
    if (!current.available) return current;
    if (JSON.stringify(current.resources.knownRunningHosted) !== JSON.stringify(admission.resources.knownRunningHosted)) {
      return unavailable("resources_waiting", "GOAL_RESOURCES_CHANGED", "本机执行活动已变化，请重新检查资源。");
    }
    return { available: true };
  }

  async function resolveGoalExecutionAdmission(goal, thread, { warm = false } = {}) {
    const owner = ownership(goal, thread);
    if (owner.state) return owner;
    let repository;
    try {
      const project = await resolveContext(goal.projectId);
      repository = await repositoryAt(project.workspacePath);
      if (thread && thread.origin.workspacePath !== repository.workspacePath) {
        const coordinator = await repositoryAt(thread.origin.workspacePath);
        if (coordinator.commonDirectory !== repository.commonDirectory || coordinator.repository !== repository.repository) {
          return unavailable("permission_unavailable", "GOAL_REPOSITORY_MISMATCH", "协调任务与已映射项目不属于同一个已核实仓库。");
        }
      }
    } catch {
      return unavailable("permission_unavailable", "GOAL_REPOSITORY_UNVERIFIED", "此项目尚无可核实的本地仓库，规划仍可使用。");
    }
    const policies = policiesFor(goal.projectId, repository.repository);
    const actions = new Set(policies.flatMap((policy) => policy.actions));
    if (!actions.has("edit") || !actions.has("test")) {
      return unavailable("permission_unavailable", "GOAL_PROJECT_PERMISSION_REQUIRED", "此项目尚未记录覆盖开发与验证的有效授权，规划仍可使用。");
    }
    let capacity = resources();
    if (warm && capacity.state === "resources_checking") {
      await new Promise((resolve) => setTimeout(resolve, 275));
      capacity = resources();
    }
    if (!capacity.available) return capacity;
    return {
      available: true, state: "ready", message: "项目授权与本机资源已核实，可执行一个就绪子项。",
      schema: "taskboard-goal-admission.v1", source: "taskboard-api", observedAt: new Date(now()).toISOString(),
      authority: { projectId: goal.projectId, repository, actions: ["edit", "test"],
        exactLeafScope: "coordinator-prepares-standing-envelope-before-claim", policies },
      ownership: owner, resources: capacity.resources,
    };
  }
  return { resolve: resolveGoalExecutionAdmission, revalidate };
}
