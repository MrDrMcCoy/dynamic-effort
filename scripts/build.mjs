// Builds the Node-compatible dist/: compiles src/ with tsc, then rewrites the
// CLI shebang. tsc copies the shebang verbatim, and the source one names bun.
//
// This also runs as `prepare`, so a fresh checkout gets a dist after install.
// Consumers who install the published tarball already have dist and no tsc,
// so a missing compiler with a usable dist is not an error.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUN_SHEBANG = "#!/usr/bin/env bun";
const NODE_SHEBANG = "#!/usr/bin/env node";
const CLI = join("dist", "cli.js");
const LOCAL_TSC = join(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

// npm puts node_modules/.bin on PATH, a bare `node scripts/build.mjs` does not.
const compiler = existsSync(LOCAL_TSC) ? LOCAL_TSC : "tsc";
const tsc = spawnSync(compiler, ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (tsc.error || tsc.status === null) {
  if (existsSync(CLI)) {
    console.log("tsc is not available; keeping the existing dist/");
    process.exit(0);
  }
  console.error("tsc is not available and dist/ is missing");
  process.exit(1);
}
if (tsc.status !== 0) {
  process.exit(tsc.status);
}

const source = await readFile(CLI, "utf8");
if (!source.startsWith(BUN_SHEBANG)) {
  console.error(`${CLI} does not start with ${BUN_SHEBANG}`);
  process.exit(1);
}
await writeFile(CLI, NODE_SHEBANG + source.slice(BUN_SHEBANG.length));
