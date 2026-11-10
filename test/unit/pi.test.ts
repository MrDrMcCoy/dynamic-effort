// The pi/oh-my-pi adapter against a stand-in host: the same events and
// methods the real extension API exposes, with a stub decision server.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDynamicEffortExtension,
  type HostApi,
} from "../../src/pi/index.ts";

interface Answer {
  effort: "minimal" | "low" | "medium" | "high" | "xhigh";
  stakes?: number;
}

let answer: Answer = { effort: "high" };
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    await request.json();
    return Response.json({
      model: "jevos-v5",
      answers: {
        reasoning_effort: {
          type: "choice",
          choice: answer.effort,
          confidence: 0.9,
        },
        high_stakes: { type: "noul", noul: answer.stakes ?? 0.1 },
      },
    });
  },
});
const endpoint = `http://127.0.0.1:${server.port}/v1/systemone`;

afterAll(() => {
  server.stop(true);
});

interface Recorded {
  input?: (event: { text: string; source?: string }, ctx: unknown) => unknown;
  select?: (event: { level: string }, ctx: unknown) => unknown;
  messageEnd?: (event: unknown, ctx: unknown) => unknown;
  shutdown?: () => unknown;
}

function fakeHost(records: Recorded, levels: string[] = []): HostApi {
  let level = "medium";
  // Emulates pi and omp emitting the select event from inside the setter.
  let echo: ((event: { level: string }) => void) | null = null;
  const host: HostApi = {
    on(event: string, handler: unknown) {
      if (event === "input") records.input = handler as Recorded["input"];
      if (event === "thinking_level_select") {
        const select = handler as Recorded["select"];
        records.select = select;
        echo = (payload) => void select?.(payload, context());
      }
      if (event === "message_end") {
        records.messageEnd = handler as Recorded["messageEnd"];
      }
      if (event === "session_shutdown") {
        records.shutdown = handler as Recorded["shutdown"];
      }
      return () => {};
    },
    setThinkingLevel(next: string) {
      // The real hosts clamp to the model's capabilities.
      if (levels.length > 0 && !levels.includes(next)) {
        level = levels[levels.length - 1]!;
      } else {
        level = next;
      }
      // pi emits the select event from inside the setter.
      if (echo) echo({ level });
    },
    getThinkingLevel() {
      return level;
    },
  };
  return host;
}

function context(
  sessionID = "ses_1",
  model: {
    provider?: string;
    id?: string;
    thinking?: { efforts?: readonly string[]; mode?: string };
    thinkingLevelMap?: Record<string, string | null>;
  } = { provider: "openrouter", id: "glm-5" },
) {
  return {
    sessionManager: { getSessionId: () => sessionID },
    model,
    ui: { setStatus() {} },
  };
}

function extension() {
  return createDynamicEffortExtension({
    env: {
      DYNAMIC_EFFORT_ENDPOINT: endpoint,
      XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "dynamic-effort-pi-")),
    },
    warm: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

describe("pi extension", () => {
  test("sets the thinking level from the decision", async () => {
    answer = { effort: "xhigh" };
    const records: Recorded = {};
    const levels: string[] = [];
    const host = fakeHost(records, levels);
    levels.push("xhigh");
    extension()(host);

    await records.input?.({ text: "prove this sort is stable" }, context());

    expect(host.getThinkingLevel?.()).toBe("xhigh");
  });

  test("reads the level back after the host clamps it", async () => {
    answer = { effort: "xhigh" };
    const records: Recorded = {};
    // The model supports nothing above high.
    const host = fakeHost(records, ["low", "high"]);
    extension()(host);

    await records.input?.({ text: "prove this sort is stable" }, context());

    expect(host.getThinkingLevel?.()).toBe("high");
  });

  test("maps up to the model's strongest level", async () => {
    answer = { effort: "xhigh" };
    const records: Recorded = {};
    // omp publishes the model's vocabulary; this model has no xhigh.
    const host = fakeHost(records, ["high", "max"]);
    extension()(host);

    await records.input?.(
      { text: "prove this sort is stable" },
      context("ses_1", {
        provider: "huggingface",
        id: "deepseek-ai/DeepSeek-R1",
        thinking: { efforts: ["high", "max"], mode: "effort" },
      }),
    );

    expect(host.getThinkingLevel?.()).toBe("max");
  });

  test("skips the levels a pi model marks unsupported", async () => {
    answer = { effort: "xhigh" };
    const records: Recorded = {};
    const host = fakeHost(records, ["low", "medium", "high"]);
    extension()(host);

    await records.input?.(
      { text: "prove this sort is stable" },
      context("ses_1", {
        provider: "anthropic",
        id: "claude-sonnet-4",
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
        },
      }),
    );

    expect(host.getThinkingLevel?.()).toBe("high");
  });

  test("applies the stakes bump for irreversible work", async () => {
    answer = { effort: "low", stakes: 0.95 };
    const records: Recorded = {};
    const host = fakeHost(records);
    extension()(host);

    await records.input?.({ text: "drop the users table" }, context());

    // low bumped once for stakes is medium.
    expect(host.getThinkingLevel?.()).toBe("medium");
  });

  test("leaves extension-sourced input alone", async () => {
    answer = { effort: "xhigh" };
    const records: Recorded = {};
    const host = fakeHost(records);
    extension()(host);

    await records.input?.(
      { text: "injected", source: "extension" },
      context(),
    );

    expect(host.getThinkingLevel?.()).toBe("medium");
  });

  test("ignores its own level change and honours a user's pick", async () => {
    answer = { effort: "high" };
    const records: Recorded = {};
    const host = fakeHost(records);
    extension()(host);

    await records.input?.({ text: "refactor the parser" }, context());
    expect(host.getThinkingLevel?.()).toBe("high");

    // The host echoed our own write; the next prompt still gets a decision.
    answer = { effort: "low" };
    await records.input?.({ text: "say hi" }, context());
    expect(host.getThinkingLevel?.()).toBe("low");

    // A user pick pins the session: later prompts leave it alone.
    host.setThinkingLevel("minimal");
    answer = { effort: "xhigh" };
    await records.input?.({ text: "say hi" }, context());
    expect(host.getThinkingLevel?.()).toBe("minimal");
  });

  test("stops the runtime on session shutdown", async () => {
    const records: Recorded = {};
    extension()(fakeHost(records));

    expect(typeof records.shutdown).toBe("function");
    await records.shutdown?.();
  });
});
