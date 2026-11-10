// Launch adapters for harnesses that accept an effort setting only when the
// process starts: Claude Code (`--effort`) and Codex
// (`-c model_reasoning_effort=`). The decision is made from the prompt, then
// the real harness runs with the level already in its argument list.

import { spawn as nodeSpawn } from "node:child_process";
import { resolveVariant, type EffortLevel } from "../core/index.ts";
import { createRuntime, type RuntimeOptions } from "../core/index.ts";

/** One harness that takes its level at launch. */
export interface LaunchAdapter {
  readonly name: string;
  /** Levels the harness accepts, weakest first. */
  readonly levels: readonly string[];
  /** Arguments that select a level. */
  effortArgs(level: string): string[];
  /** Flags whose next token is a value, not the prompt. */
  readonly valueFlags: readonly string[];
  /** Subcommands that can precede the prompt. */
  readonly subcommands?: readonly string[];
}

export const CODEX_ADAPTER: LaunchAdapter = {
  name: "codex",
  levels: ["minimal", "low", "medium", "high", "xhigh"],
  effortArgs: (level) => ["-c", `model_reasoning_effort=${level}`],
  valueFlags: [
    "-c",
    "--config",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "-i",
    "--image",
    "--add-dir",
    "--output-schema",
    "--thread-source",
    "--local-provider",
    "--cyber-access-program",
  ],
  subcommands: ["exec", "e", "review", "resume", "fork", "sandbox", "queue"],
};

export const CLAUDE_ADAPTER: LaunchAdapter = {
  name: "claude",
  levels: ["low", "medium", "high", "xhigh", "max"],
  effortArgs: (level) => ["--effort", level],
  valueFlags: [
    "--effort",
    "--model",
    "--settings",
    "--output-format",
    "--input-format",
    "--permission-mode",
    "--allowed-tools",
    "--disallowed-tools",
    "--append-system-prompt",
    "--add-dir",
    "--resume",
    "--fallback-model",
    "--agents",
    "--mcp-config",
    "--plugin-dir",
  ],
};

export const ADAPTERS: Record<string, LaunchAdapter> = {
  codex: CODEX_ADAPTER,
  claude: CLAUDE_ADAPTER,
};

/**
 * The first positional argument, skipping flags, the values they consume, and
 * one leading subcommand. A `--` separator ends flag parsing.
 */
export function findPrompt(
  args: readonly string[],
  valueFlags: readonly string[],
  subcommands: readonly string[] = [],
): string | null {
  let flagsDone = false;
  let subcommandDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && arg.startsWith("-")) {
      const takesValue = !arg.includes("=") && valueFlags.includes(arg);
      if (takesValue) index += 1;
      continue;
    }
    if (!subcommandDone && subcommands.includes(arg)) {
      subcommandDone = true;
      continue;
    }
    return arg;
  }
  return null;
}

/** Maps a decided effort onto the levels this harness accepts. */
export function launchLevel(
  adapter: LaunchAdapter,
  effort: EffortLevel,
): string {
  const levels = adapter.levels.map((id) => ({ id }));
  return resolveVariant(effort, levels) ?? adapter.levels[0]!;
}

type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit"; env?: NodeJS.ProcessEnv },
) => {
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
};

export interface LaunchOptions {
  adapter: LaunchAdapter;
  args: readonly string[];
  command?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeOptions;
  spawn?: SpawnFunction;
  /** Reads the prompt from stdin when the argument list has none. */
  readStdin?: () => Promise<string | null>;
}

/** How long to wait for a piped prompt before running unchanged. */
const STDIN_WAIT_MS = 250;

/**
 * Reads a piped prompt, giving up quickly. A harness launched from a script
 * often inherits a pipe that never closes, so waiting for EOF would hang.
 */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  const collect = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return true;
  })();
  await Promise.race([
    collect,
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), STDIN_WAIT_MS),
    ),
  ]);
  process.stdin.pause();
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

/**
 * Decides from the prompt, then runs the harness with the level in its
 * arguments. A failed decision runs the harness unchanged.
 */
export async function runLaunch(options: LaunchOptions): Promise<number> {
  const { adapter, args } = options;
  const runtime = createRuntime(options.runtime ?? {});
  const { config, logger, router, telemetry } = runtime;
  const command = options.command ?? adapter.name;
  const spawn = (options.spawn ?? nodeSpawn) as unknown as SpawnFunction;
  const readStdin = options.readStdin ?? readPipedStdin;

  let extra: string[] = [];
  try {
    const prompt =
      findPrompt(args, adapter.valueFlags, adapter.subcommands) ??
      (await readStdin());
    if (prompt) {
      const decision = await router.onPrompt({
        sessionID: `launch:${adapter.name}`,
        text: prompt,
      });
      if (decision) {
        const level = launchLevel(adapter, decision.effort);
        extra = adapter.effortArgs(level);
        logger.debug("decided", {
          harness: adapter.name,
          effort: decision.effort,
          applied: level,
          source: "prompt",
        });
        if (config.telemetry) {
          telemetry.append({
            session: `launch:${adapter.name}`,
            effort: decision.effort,
            variant: level,
            applied: true,
            choice: decision.choice,
            confidence: decision.confidence,
            highStakes: decision.highStakes,
            keyword: decision.keyword,
            source: "prompt",
            promptHash: decision.promptHash,
            prompt,
          });
        }
      }
    }
  } catch (error) {
    logger.warn("launch decision failed; running unchanged", error);
  }

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...extra, ...args], {
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    child.on("exit", (status) => resolve(status ?? 0));
    child.on("error", reject);
  });
  await runtime.stop();
  return code;
}
