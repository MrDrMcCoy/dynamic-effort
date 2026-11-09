// Filesystem locations for the plugin's own state. Everything lives under
// one cache root so uninstalling is a single directory removal.

import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR = "dynamic-effort";

/** Root for downloads, logs, and manifests. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CACHE_HOME"]?.trim();
  if (xdg) return join(xdg, APP_DIR);
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"]?.trim();
    if (local) return join(local, APP_DIR);
  }
  return join(homedir(), ".cache", APP_DIR);
}

/** Where one jevos version and target is installed. */
export function jevInstallDir(
  version: string,
  target: string,
  root: string = cacheRoot(),
): string {
  return join(root, "jev", `${version}-${target}`);
}

export function jevLogPath(root: string = cacheRoot()): string {
  return join(root, "jev.log");
}

/**
 * Directories where another tool may already have installed jevos, so a
 * download is not repeated. Checked after our own cache directory.
 */
export function defaultReuseDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
  if (!home) return [];
  return [
    join(home, ".cache", "opencode", "xerj", "jev"),
    join(home, ".cache", "xerj", "jev"),
  ];
}
