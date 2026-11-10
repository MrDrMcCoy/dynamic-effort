#!/usr/bin/env bun
// CLI for work a plugin cannot do before it loads: install the model, check
// the install, run the server in the foreground, and proxy an ACP agent.
//
//   dynamic-effort setup            install jevos if it is missing
//   dynamic-effort status           report the install and any running server
//   dynamic-effort serve            run the server until interrupted
//   dynamic-effort acp [cmd ...]    proxy an ACP agent on stdin and stdout
//   dynamic-effort telemetry        summarise the recorded decisions

import { join } from "node:path";
import {
  cacheRoot,
  createLogger,
  defaultReuseDirs,
  jevLogPath,
  JevInstaller,
  JevServer,
  probeHealth,
  readTelemetry,
  releaseTarget,
  type TelemetryEntry,
} from "./core/index.ts";
import {
  DEFAULT_AGENT_ARGS,
  DEFAULT_AGENT_COMMAND,
  runAcpProxy,
} from "./acp/index.ts";

const FIRST_PORT = 8017;

const USAGE =
  "usage: dynamic-effort <setup|status|serve|acp|telemetry>\n" +
  "       [-- command ...]\n" +
  "  setup      download and verify jevos if it is missing\n" +
  "  status     report the install and any running server\n" +
  "  serve      run the server until interrupted\n" +
  "  acp        proxy an ACP agent (default: opencode acp)\n" +
  "  telemetry  summarise the decisions recorded on disk";

function usage(): never {
  console.error(USAGE);
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

/** The agent to drive: `-- command args...`, or `opencode acp`. */
function agentFromArgs(rest: readonly string[]) {
  const split = rest.indexOf("--");
  const [command, ...args] = split >= 0 ? rest.slice(split + 1) : [];
  if (!command) {
    return { command: DEFAULT_AGENT_COMMAND, args: DEFAULT_AGENT_ARGS };
  }
  return { command, args };
}

/** Counts entries per key, largest first. */
function tally(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/** Prints a short report over the persisted ring buffer. */
function printTelemetry(entries: readonly TelemetryEntry[]): void {
  if (entries.length === 0) {
    console.log("no telemetry recorded; enable telemetryPersist to keep it");
    return;
  }

  const sessions = new Set(entries.map((entry) => entry.session));
  const applied = entries.filter((entry) => entry.applied).length;
  const withUsage = entries.filter((entry) => entry.usage);
  const reasoning = withUsage.reduce(
    (total, entry) => total + (entry.usage?.reasoning ?? 0),
    0,
  );
  const output = withUsage.reduce(
    (total, entry) => total + (entry.usage?.output ?? 0),
    0,
  );

  console.log(`entries: ${entries.length} across ${sessions.size} sessions`);
  console.log(`applied: ${applied} of ${entries.length}`);
  console.log(`reasoning tokens: ${reasoning}`);
  console.log(`output tokens: ${output}`);
  console.log(
    `efforts: ${tally(entries.map((entry) => entry.effort))
      .map(([effort, count]) => `${effort}=${count}`)
      .join(" ")}`,
  );
  console.log(
    `sources: ${tally(entries.map((entry) => entry.source))
      .map(([source, count]) => `${source}=${count}`)
      .join(" ")}`,
  );
  const last = entries[entries.length - 1];
  if (last) console.log(`last: ${last.at} ${last.effort} (${last.session})`);
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

  case "acp": {
    await runAcpProxy({
      agent: agentFromArgs(process.argv.slice(3)),
      config: { debug: true },
    });
    break;
  }

  case "telemetry": {
    printTelemetry(readTelemetry(join(root, "telemetry.jsonl")));
    break;
  }

  default:
    usage();
}
