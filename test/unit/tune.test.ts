import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { NULL_LOGGER } from "../../src/core/log.ts";
import {
  TelemetryBuffer,
  type TelemetryInput,
} from "../../src/core/telemetry.ts";
import {
  buildTuningPrompt,
  describeProposal,
  MAX_TUNE_PROPOSALS,
  parseTuningProposal,
  readLatestProposal,
  summarizeTelemetry,
  writeTuningProposal,
  type TuningProposal,
} from "../../src/core/tune.ts";
import {
  collectEntries,
  executeTune,
  runTune,
  tuneDirectory,
  type TuneHarness,
} from "../../src/opencode/tune.ts";

function decision(overrides: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    session: "ses_1",
    model: "openrouter/test",
    effort: "medium",
    applied: true,
    source: "prompt",
    ...overrides,
  };
}

function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), "dynamic-effort-tune-"));
}

function proposalText(proposal: Record<string, unknown>): string {
  return `Here is the review.\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``;
}

describe("summarizeTelemetry", () => {
  test("counts confidence and stakes against the current thresholds", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ confidence: 0.2, highStakes: 0.9 }));
    buffer.append(decision({ confidence: 0.8, highStakes: 0.1 }));
    buffer.append(decision({ applied: false, effort: "low" }));

    const stats = summarizeTelemetry(buffer.snapshot(), DEFAULT_CONFIG);

    expect(stats.entries).toBe(3);
    expect(stats.sessions).toBe(1);
    expect(stats.applied).toBe(2);
    expect(stats.lowConfidence).toBe(1);
    expect(stats.bumped).toBe(1);
    expect(stats.byEffort).toEqual({ medium: 2, low: 1 });
    expect(stats.bySource).toEqual({ prompt: 3 });
  });

  test("sums token usage and averages the scores it has", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ confidence: 0.4, highStakes: 0.2 }));
    buffer.append(decision({ confidence: 0.6, highStakes: 0.4 }));
    buffer.stampUsage("ses_1", {
      input: 10,
      output: 20,
      reasoning: 30,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const stats = summarizeTelemetry(buffer.snapshot(), DEFAULT_CONFIG);

    expect(stats.reasoningTokens).toBe(30);
    expect(stats.outputTokens).toBe(20);
    expect(stats.averageConfidence).toBeCloseTo(0.5, 6);
    expect(stats.averageStakes).toBeCloseTo(0.3, 6);
  });

  test("reports zeros for an empty record", () => {
    const stats = summarizeTelemetry([], DEFAULT_CONFIG);
    expect(stats.entries).toBe(0);
    expect(stats.averageConfidence).toBe(0);
    expect(stats.byEffort).toEqual({});
  });
});

describe("buildTuningPrompt", () => {
  test("carries the settings, the statistics, and the decisions", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(
      decision({
        confidence: 0.91,
        highStakes: 0.05,
        prompt: "add a test",
        promptHash: "abc123",
      }),
    );

    const prompt = buildTuningPrompt(buffer.snapshot(), DEFAULT_CONFIG);

    expect(prompt).toContain("defaultEffort=medium");
    expect(prompt).toContain("minConfidence=0.35");
    expect(prompt).toContain("decisions=1 sessions=1");
    expect(prompt).toContain("effort=medium");
    expect(prompt).toContain("confidence=0.910");
    expect(prompt).toContain('prompt="add a test"');
    expect(prompt).toContain('"summary": "one paragraph"');
  });

  test("shows the current question wording when it is tuned", () => {
    const questions = {
      reasoningEffort: "custom wording",
      highStakes: "custom stakes",
      effortCriteria: {
        minimal: "a",
        low: "b",
        medium: "c",
        high: "d",
        xhigh: "e",
      },
    };
    const prompt = buildTuningPrompt([], { ...DEFAULT_CONFIG, questions });
    expect(prompt).toContain('"custom wording"');
  });
});

describe("parseTuningProposal", () => {
  test("reads a full proposal from a fenced answer", () => {
    const proposal = parseTuningProposal(
      proposalText({
        summary: "Raise the stakes threshold.",
        minConfidence: 0.4,
        stakesThreshold: 0.8,
        defaultEffort: "low",
        notes: ["two notes", 3],
      }),
    );

    expect(proposal.summary).toBe("Raise the stakes threshold.");
    expect(proposal.minConfidence).toBe(0.4);
    expect(proposal.stakesThreshold).toBe(0.8);
    expect(proposal.defaultEffort).toBe("low");
    expect(proposal.notes).toEqual(["two notes"]);
  });

  test("reads a bare JSON object", () => {
    const proposal = parseTuningProposal('{"summary":"ok"}');
    expect(proposal.summary).toBe("ok");
    expect(proposal.questions).toBeUndefined();
  });

  test("accepts a complete question set", () => {
    const questions = {
      reasoningEffort: "reworded",
      highStakes: "reworded stakes",
      effortCriteria: {
        minimal: "a",
        low: "b",
        medium: "c",
        high: "d",
        xhigh: "e",
      },
    };
    const proposal = parseTuningProposal(
      proposalText({ summary: "ok", questions }),
    );
    expect(proposal.questions?.reasoningEffort).toBe("reworded");
  });

  test("rejects an incomplete question set", () => {
    expect(() =>
      parseTuningProposal(
        proposalText({ summary: "ok", questions: { reasoningEffort: "x" } }),
      ),
    ).toThrow("the questions field is incomplete");
  });

  test("rejects an answer with no JSON", () => {
    expect(() => parseTuningProposal("nothing useful")).toThrow(
      "no JSON object",
    );
  });

  test("rejects invalid JSON", () => {
    expect(() => parseTuningProposal("{oops}")).toThrow("not valid JSON");
  });

  test("rejects a missing summary", () => {
    expect(() => parseTuningProposal('{"minConfidence":0.5}')).toThrow(
      "needs a summary",
    );
  });

  test("rejects a threshold outside the unit interval", () => {
    expect(() =>
      parseTuningProposal('{"summary":"ok","minConfidence":1.5}'),
    ).toThrow("at most 1");
    expect(() =>
      parseTuningProposal('{"summary":"ok","stakesThreshold":0}'),
    ).toThrow("greater than 0");
  });

  test("rejects an unknown effort level", () => {
    expect(() =>
      parseTuningProposal('{"summary":"ok","defaultEffort":"maximum"}'),
    ).toThrow("not an effort level");
  });

  test("rejects notes that are not a list", () => {
    expect(() =>
      parseTuningProposal('{"summary":"ok","notes":"one"}'),
    ).toThrow("notes must be a list");
  });
});

describe("proposal files", () => {
  test("writes, reads back, and prunes to the limit", () => {
    const directory = temporaryDir();
    const proposal: TuningProposal = { summary: "keep going" };
    const file = writeTuningProposal(directory, proposal, 7);

    expect(file.endsWith(".json")).toBe(true);
    const latest = readLatestProposal(directory);
    expect(latest?.proposal.summary).toBe("keep going");
    expect(latest?.entries).toBe(7);

    for (let index = 0; index < MAX_TUNE_PROPOSALS + 3; index += 1) {
      writeTuningProposal(directory, { summary: `proposal ${index}` });
    }
    expect(readdirSync(directory).length).toBe(MAX_TUNE_PROPOSALS);
  });

  test("returns null when there is no proposal", () => {
    expect(readLatestProposal(temporaryDir())).toBeNull();
    expect(readLatestProposal(join(temporaryDir(), "missing"))).toBeNull();
  });
});

describe("describeProposal", () => {
  test("lists only the values that change", () => {
    const lines = describeProposal(
      {
        summary: "Tighter thresholds.",
        minConfidence: 0.5,
        stakesThreshold: DEFAULT_CONFIG.stakesThreshold,
        defaultEffort: "low",
        questions: {
          reasoningEffort: "a",
          highStakes: "b",
          effortCriteria: {
            minimal: "a",
            low: "b",
            medium: "c",
            high: "d",
            xhigh: "e",
          },
        },
        notes: ["watch the low tail"],
      },
      DEFAULT_CONFIG,
    );

    expect(lines[0]).toBe("Tighter thresholds.");
    expect(lines).toContain("minConfidence: 0.35 -> 0.5");
    expect(lines).toContain("defaultEffort: medium -> low");
    expect(lines).toContain("questions: rewritten");
    expect(lines).toContain("note: watch the low tail");
    const stakes = lines.some((line) => line.startsWith("stakesThreshold"));
    expect(stakes).toBe(false);
  });
});

describe("the tuning command", () => {
  function harness(
    overrides: Partial<TuneHarness> = {},
  ): TuneHarness & { reported: string[]; prompts: string[] } {
    const reported: string[] = [];
    const prompts: string[] = [];
    const root = temporaryDir();
    return {
      config: DEFAULT_CONFIG,
      logger: NULL_LOGGER,
      telemetry: new TelemetryBuffer(),
      telemetryPath: join(root, "telemetry.jsonl"),
      directory: tuneDirectory(root),
      async generate(prompt) {
        prompts.push(prompt);
        return proposalText({ summary: "ok" });
      },
      async report(_sessionID, text) {
        reported.push(text);
      },
      reported,
      prompts,
      ...overrides,
    };
  }

  test("collects the file and the live buffer without duplicates", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ session: "live", at: "2026-01-01" } as never));
    const entries = collectEntries(buffer, "/nonexistent/telemetry.jsonl");
    expect(entries.length).toBe(1);
    expect(entries[0]?.session).toBe("live");
  });

  test("writes a proposal and reports the changes", async () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ confidence: 0.9 }));
    const fake = harness({ telemetry: buffer });

    const outcome = await runTune(fake, "ses_1");

    expect(outcome.entries).toBe(1);
    expect(outcome.file).not.toBeNull();
    expect(outcome.lines[0]).toBe("Reviewed 1 decisions.");
    expect(fake.prompts.length).toBe(1);
    expect(fake.prompts[0]).toContain("effort=medium");
  });

  test("explains an empty record instead of calling the model", async () => {
    const fake = harness();
    const outcome = await runTune(fake, "ses_1");
    expect(outcome.entries).toBe(0);
    expect(outcome.file).toBeNull();
    expect(fake.prompts.length).toBe(0);
  });

  test("reports a malformed answer without throwing", async () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision());
    const fake = harness({
      telemetry: buffer,
      async generate() {
        return "no json here";
      },
    });

    await executeTune(fake, "ses_1");

    expect(fake.reported[0]).toContain("Effort tuning failed");
  });

  test("reports the outcome in the session", async () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision());
    const fake = harness({ telemetry: buffer });

    await executeTune(fake, "ses_1");

    expect(fake.reported[0]).toContain("Reviewed 1 decisions.");
    expect(fake.reported[0]).toContain("Proposal:");
  });
});
