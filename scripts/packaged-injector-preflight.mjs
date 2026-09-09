import { spawnSync } from "node:child_process";
import path from "node:path";

const PACKAGED_INJECTOR_PREFLIGHT = "--packaged-injector-import-preflight";

export function verifyPackagedInjectorModuleGraph({
  nodePath = process.execPath,
  appRoot,
  label = "Packaged Taskboard",
  env = process.env,
}) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) {
    throw new Error(`${label} injector preflight requires an absolute app root`);
  }
  const result = spawnSync(
    nodePath,
    [path.join(appRoot, "scripts", "codex-injector.mjs"), PACKAGED_INJECTOR_PREFLIGHT],
    {
      cwd: appRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
    },
  );
  const expected = `Unknown option: ${PACKAGED_INJECTOR_PREFLIGHT}`;
  if (result.error || result.status !== 1 || !result.stderr?.includes(expected)) {
    const diagnostic = result.error?.message
      || result.stderr?.trim()
      || result.stdout?.trim()
      || `exit ${result.status}`;
    throw new Error(`${label} injector module preflight failed: ${diagnostic}`);
  }
}
