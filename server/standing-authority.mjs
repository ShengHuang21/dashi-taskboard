export const STANDING_AUTHORITY_ACTIONS = Object.freeze([
  "edit",
  "test",
  "scoped_delete",
  "commit",
  "ordinary_push",
  "draft_pr",
]);

const ACTION_SET = new Set(STANDING_AUTHORITY_ACTIONS);
const STANDING_TEST_SUITES = new Set([
  "focused",
  "node",
  "browser",
  "components",
  "typecheck",
  "build",
  "diff_check",
]);

export function normalizeRepository(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
  return /^(?:github\.com|gitlab\.com)\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)
    ? normalized
    : null;
}

export function normalizeStandingActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  if (actions.some((action) => !ACTION_SET.has(action))) return null;
  const unique = [...new Set(actions)].sort();
  return unique.length === actions.length ? unique : null;
}

export function isSafeScopedDeleteTarget(target) {
  if (typeof target !== "string" || !target.trim()) return false;
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return false;
  const segments = normalized.split("/");
  return normalized !== "."
    && !normalized.startsWith("-")
    && !segments.includes("")
    && !segments.includes(".")
    && !segments.includes("..")
    && !segments.includes(".git")
    && segments.every((segment) => !segment.startsWith("-"))
    && !/[\u0000-\u0020\u007f~*?$`()\[\]{};|&<>!'"\\]/.test(normalized);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.slice().sort().every((key, index) => key === actual[index]);
}

function safePathList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 128
    && new Set(value).size === value.length
    && value.every(isSafeScopedDeleteTarget);
}

function safeRef(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && value.split("/").every((segment) => segment && !segment.endsWith(".lock"))
    && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value);
}

export function validateStandingActionScope(kind, scope, { branch } = {}) {
  if (!scope || scope.kind !== kind) return false;
  if (kind === "edit" || kind === "commit") {
    return exactKeys(scope, ["kind", "paths"]) && safePathList(scope.paths);
  }
  if (kind === "test") {
    return exactKeys(scope, ["kind", "suites"])
      && Array.isArray(scope.suites)
      && scope.suites.length > 0
      && scope.suites.length <= 32
      && new Set(scope.suites).size === scope.suites.length
      && scope.suites.every((suite) => STANDING_TEST_SUITES.has(suite));
  }
  if (kind === "scoped_delete") {
    return exactKeys(scope, ["kind", "paths", "recursive"])
      && scope.recursive === false
      && safePathList(scope.paths);
  }
  if (kind === "ordinary_push") {
    return exactKeys(scope, ["kind", "remote", "branch", "force"])
      && scope.remote === "origin"
      && scope.force === false
      && safeRef(scope.branch)
      && scope.branch === branch;
  }
  if (kind === "draft_pr") {
    return exactKeys(scope, ["kind", "base", "head", "draft"])
      && scope.draft === true
      && safeRef(scope.base)
      && safeRef(scope.head)
      && scope.head === branch
      && scope.base !== scope.head;
  }
  return false;
}

export function validateStandingAction(action, kind, context) {
  return exactKeys(action, ["id", "order", "text", "gate", "target", "status", "standingScope"])
    && validateStandingActionScope(kind, action.standingScope, context);
}

function canonicalScope(scope) {
  if (scope.kind === "ordinary_push") {
    return { kind: scope.kind, remote: scope.remote, branch: scope.branch, force: false };
  }
  if (scope.kind === "draft_pr") {
    return { kind: scope.kind, base: scope.base, head: scope.head, draft: true };
  }
  if (scope.kind === "test") return { kind: scope.kind, suites: [...scope.suites] };
  if (scope.kind === "scoped_delete") {
    return { kind: scope.kind, paths: [...scope.paths], recursive: false };
  }
  return { kind: scope.kind, paths: [...scope.paths] };
}

export function canonicalStandingAction(action, kind) {
  const scope = canonicalScope(action.standingScope);
  const description = kind === "ordinary_push"
    ? `Ordinary push ${scope.branch} to origin without force`
    : kind === "draft_pr"
      ? `Create Draft PR from ${scope.head} to ${scope.base}`
      : kind === "test"
        ? `Run declared test suites: ${scope.suites.join(", ")}`
        : kind === "scoped_delete"
          ? `Delete declared files without recursion: ${scope.paths.join(", ")}`
          : `${kind === "edit" ? "Edit" : "Commit"} declared paths: ${scope.paths.join(", ")}`;
  return {
    id: action.id,
    order: action.order,
    text: description,
    gate: action.gate,
    target: JSON.stringify(scope),
    status: action.status,
    standingScope: scope,
    standingAuthority: true,
  };
}
