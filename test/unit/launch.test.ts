// Unit tests for the launch adapters: argument scanning, level mapping, and
// the full run with a stub decision endpoint and a stub spawn.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTERS,
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  HERMES_ADAPTER,
  findPrompt,
  launchLevel,
  runLaunch,
} from "../../src/launch/index.ts";
import { readTelemetry } from "../../src/core/index.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Serves one fixed decision and records the request bodies. */
function decisionServer(choice = "high", stakes = 0.1) {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json({
        model: "jevos-v5",
        answers: {
          reasoning_effort: {
            type: "choice",
            choice,
            probabilities: { [choice]: 0.9 },
            confidence: 0.9,
          },
          high_stakes: { type: "noul", noul: stakes },
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1/systemone`, bodies };
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-effort-launch-"));
  directories.push(directory);
  return directory;
}

describe("findPrompt", () => {
  test("takes the prompt after a subcommand", () => {
    expect(findPrompt(["exec", "fix the build"], CODEX_ADAPTER))
      .toBe("fix the build");
  });

  test("takes the value of a prompt flag", () => {
    const args = ["-m", "gpt-6.1", "-z", "say hi"];
    expect(findPrompt(args, HERMES_ADAPTER)).toBe("say hi");
  });

  test("skips flags and their values", () => {
    const args = ["-m", "gpt-6.1-sol", "--sandbox", "read-only", "do it"];
    expect(findPrompt(args, CODEX_ADAPTER)).toBe("do it");
  });

  test("does not consume a value after an equals form", () => {
    const args = ["--model=gpt-6.1", "do it"];
    expect(findPrompt(args, CLAUDE_ADAPTER)).toBe("do it");
  });

  test("skips a subcommand before the prompt", () => {
    const args = ["exec", "--sandbox", "read-only", "do it"];
    expect(findPrompt(args, CODEX_ADAPTER)).toBe("do it");
  });

  test("treats everything after a separator as positional", () => {
    const args = ["--", "-m", "a value"];
    expect(findPrompt(args, CODEX_ADAPTER)).toBe("-m");
  });

  test("returns null when there is no positional argument", () => {
    expect(findPrompt(["-m", "x"], CODEX_ADAPTER)).toBeNull();
  });
});

describe("launchLevel", () => {
  test("maps xhigh onto the strongest codex level", () => {
    expect(launchLevel(CODEX_ADAPTER, "xhigh")).toBe("xhigh");
  });

  test("keeps xhigh on claude, which accepts it", () => {
    expect(launchLevel(CLAUDE_ADAPTER, "xhigh")).toBe("xhigh");
  });

  test("maps minimal down to claude's lowest level", () => {
    expect(launchLevel(CLAUDE_ADAPTER, "minimal")).toBe("low");
  });

  test("keeps a level both harnesses accept", () => {
    expect(launchLevel(CODEX_ADAPTER, "medium")).toBe("medium");
    expect(launchLevel(CLAUDE_ADAPTER, "medium")).toBe("medium");
  });
});

describe("runLaunch", () => {
  test("adds the decided level to the harness arguments", async () => {
    const { url, bodies } = decisionServer("xhigh");
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const code = await runLaunch({
      adapter: CLAUDE_ADAPTER,
      args: ["-p", "prove this sort is stable"],
      runtime: { config: { endpoint: url } },
      spawn: (command, args) => {
        spawned.push({ command, args });
        return {
          on(event: string, callback: (value: never) => void) {
            if (event === "exit") setTimeout(() => callback(0 as never), 0);
            return {};
          },
        };
      },
      readStdin: async () => null,
    });

    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toBe("claude");
    expect(spawned[0]!.args).toEqual([
      "--effort",
      "xhigh",
      "-p",
      "prove this sort is stable",
    ]);
    expect(bodies).toHaveLength(1);
  });

  test("reads the prompt from stdin when the arguments have none", async () => {
    const { url } = decisionServer("minimal");
    const spawned: Array<readonly string[]> = [];
    await runLaunch({
      adapter: CODEX_ADAPTER,
      args: ["exec"],
      runtime: { config: { endpoint: url } },
      spawn: (_command, args) => {
        spawned.push(args);
        return {
          on(event: string, callback: (value: never) => void) {
            if (event === "exit") setTimeout(() => callback(0 as never), 0);
            return {};
          },
        };
      },
      readStdin: async () => "say hi in one word",
    });

    expect(spawned[0]).toEqual([
      "-c",
      "model_reasoning_effort=minimal",
      "exec",
    ]);
  });

  test("runs unchanged when the decision server fails", async () => {
    const directory = await scratch();
    const spawned: Array<readonly string[]> = [];
    const code = await runLaunch({
      adapter: CLAUDE_ADAPTER,
      args: ["-p", "hello"],
      runtime: {
        env: { XDG_CACHE_HOME: directory },
        config: { endpoint: "http://127.0.0.1:1/v1/systemone", timeoutMs: 500 },
      },
      spawn: (_command, args) => {
        spawned.push(args);
        return {
          on(event: string, callback: (value: never) => void) {
            if (event === "exit") setTimeout(() => callback(3 as never), 0);
            return {};
          },
        };
      },
      readStdin: async () => null,
    });

    expect(code).toBe(3);
    expect(spawned[0]).toEqual(["-p", "hello"]);
  });

  test("records the decision when persistence is on", async () => {
    const { url } = decisionServer("high");
    const directory = await scratch();
    await runLaunch({
      adapter: CODEX_ADAPTER,
      args: ["exec", "refactor the parser"],
      runtime: {
        env: { XDG_CACHE_HOME: directory },
        config: { endpoint: url, telemetryPersist: true },
      },
      spawn: () => ({
        on(event: string, callback: (value: never) => void) {
          if (event === "exit") setTimeout(() => callback(0 as never), 0);
          return {};
        },
      }),
      readStdin: async () => null,
    });

    const entries = readTelemetry(
      join(directory, "dynamic-effort", "telemetry.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.session).toBe("launch:codex");
    expect(entries[0]!.effort).toBe("high");
    expect(entries[0]!.variant).toBe("high");
    expect(entries[0]!.source).toBe("prompt");
  });

  test("exposes both adapters by name", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([
      "claude",
      "codex",
      "hermes",
    ]);
  });
});
