#!/usr/bin/env bun
// CLI for work a plugin cannot do before it loads: install the model, check
// the install, and run the server in the foreground.
//
//   bun run src/cli.ts setup     install jevos if it is missing
//   bun run src/cli.ts status    report the install and any running server
//   bun run src/cli.ts serve     run the server until interrupted

import { join } from "node:path";
import {
  cacheRoot,
  createLogger,
  defaultReuseDirs,
  jevLogPath,
  JevInstaller,
  JevServer,
  probeHealth,
  releaseTarget,
} from "./core/index.ts";

const FIRST_PORT = 8017;

function usage(): never {
  console.error(
    "usage: dynamic-effort <setup|status|serve>\n" +
      "  setup   download and verify jevos if it is missing\n" +
      "  status  report the install and any running server\n" +
      "  serve   run the server until interrupted",
  );
  process.exit(2);
}

function makeInstaller(): JevInstaller {
  return new JevInstaller({
    root,
    target: targetOrExit(),
    logger,
    reuseDirs: defaultReuseDirs(),
  });
}

function targetOrExit() {
  const target = releaseTarget(process.platform, process.arch);
  if (target === null) {
    console.error(
      `no jevos release for ${process.platform}-${process.arch}; ` +
        "set the endpoint option to use a decision server you run yourself",
    );
    process.exit(1);
  }
  return target;
}

const command = process.argv[2];
const root = cacheRoot();
const logger = createLogger({
  debug: true,
  file: join(root, "dynamic-effort.log"),
});

switch (command) {
  case "setup": {
    const installer = makeInstaller();
    const install = await installer.ensure();
    console.log(`jevos is ready at ${install.root}`);
    break;
  }

  case "status": {
    const installer = makeInstaller();
    const install = await installer.find();
    console.log(install ? `install: ${install.root}` : "install: none");
    const health = await probeHealth(FIRST_PORT, 500);
    console.log(
      health ? `server: ready on port ${FIRST_PORT}` : "server: not listening",
    );
    console.log(`log: ${jevLogPath(root)}`);
    break;
  }

  case "serve": {
    const installer = makeInstaller();
    const server = new JevServer({
      install: () => installer.ensure(),
      port: FIRST_PORT,
      threads: null,
      logger,
      logPath: jevLogPath(root),
      root,
      // A foreground server is meant to stay up; stop it with Ctrl-C.
      idleMs: Number.MAX_SAFE_INTEGER,
    });
    const url = await server.ensure();
    if (url === null) {
      console.error(`the server did not start; see ${jevLogPath(root)}`);
      process.exit(1);
    }
    console.log(`listening on ${url}; press Ctrl-C to stop`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await server.stop();
    break;
  }

  default:
    usage();
}
