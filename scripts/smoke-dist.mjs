// Checks the built dist/ the way a Node consumer uses it: entry points import,
// the CLI is executable by node, and no bun-only shebang survives the build.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join("dist", "cli.js");
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok ${name}`);
    return;
  }
  failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`not ok ${name}${detail ? `: ${detail}` : ""}`);
}

const shebang = (await readFile(CLI, "utf8")).split("\n", 1)[0];
check("cli shebang names node", shebang === "#!/usr/bin/env node", shebang);

const core = await import(
  pathToFileURL(join("dist", "core", "index.js")).href
);
check(
  "core exports createRuntime",
  typeof core.createRuntime === "function",
);
check("core exports readConfig", typeof core.readConfig === "function");

const plugin = await import(
  pathToFileURL(join("dist", "opencode", "index.js")).href
);
check("plugin id", plugin.default?.id === "dynamic-effort", plugin.default?.id);

const usage = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
check("cli exits 2 without a command", usage.status === 2, String(usage.status));
check(
  "cli prints usage",
  (usage.stderr ?? "").includes("usage: dynamic-effort"),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\ndist smoke passed");
