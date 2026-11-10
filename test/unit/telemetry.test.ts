import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTelemetry,
  TelemetryBuffer,
  type TelemetryInput,
} from "../../src/core/telemetry.ts";

function decision(overrides: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    session: "ses_1",
    agent: "build",
    model: "openrouter/test",
    effort: "medium",
    applied: true,
    source: "prompt",
    ...overrides,
  };
}

function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), "dynamic-effort-telemetry-"));
}

describe("TelemetryBuffer", () => {
  test("keeps entries in order and stamps a timestamp", () => {
    const buffer = new TelemetryBuffer();
    const entry = buffer.append(decision({ prompt: "hi" }));

    expect(buffer.size).toBe(1);
    expect(entry.session).toBe("ses_1");
    expect(entry.prompt).toBe("hi");
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  test("drops the oldest entry once the capacity is reached", () => {
    const buffer = new TelemetryBuffer({ capacity: 2 });
    buffer.append(decision({ session: "a" }));
    buffer.append(decision({ session: "b" }));
    buffer.append(decision({ session: "c" }));

    expect(buffer.size).toBe(2);
    expect(buffer.snapshot().map((entry) => entry.session)).toEqual([
      "b",
      "c",
    ]);
  });

  test("keeps the tail of a long prompt", () => {
    const buffer = new TelemetryBuffer({ promptChars: 5 });
    const entry = buffer.append(decision({ prompt: "abcdefghij" }));

    expect(entry.prompt).toBe("fghij");
  });

  test("drops the prompt text when the limit is zero", () => {
    const buffer = new TelemetryBuffer({ promptChars: 0 });
    const entry = buffer.append(decision({ prompt: "secret" }));

    expect(entry.prompt).toBeUndefined();
  });

  test("stamps usage on the newest entry for the session", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ session: "a" }));
    buffer.append(decision({ session: "b" }));

    const stamped = buffer.stampUsage("a", {
      input: 10,
      output: 20,
      reasoning: 30,
      cacheRead: 0,
      cacheWrite: 0,
    });

    expect(stamped).toBe(true);
    const [first] = buffer.snapshot();
    expect(first?.usage).toEqual({
      input: 10,
      output: 20,
      reasoning: 30,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("reports a miss when the session has no entry", () => {
    const buffer = new TelemetryBuffer();

    expect(
      buffer.stampUsage("missing", {
        input: 1,
        output: 1,
        reasoning: 1,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(false);
  });

  test("snapshot returns copies the caller cannot mutate", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision());
    const [entry] = buffer.snapshot();
    if (entry) (entry as { effort: string }).effort = "xhigh";

    expect(buffer.snapshot()[0]?.effort).toBe("medium");
  });

  test("clear empties the buffer", () => {
    const buffer = new TelemetryBuffer();
    buffer.append(decision());
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });
});

describe("TelemetryBuffer.persist", () => {
  test("appends one JSON line per entry", () => {
    const file = join(temporaryDir(), "telemetry.jsonl");
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ session: "a" }));
    buffer.append(decision({ session: "b" }));

    expect(buffer.persist(file)).toBe(2);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("appends to an existing file instead of replacing it", () => {
    const file = join(temporaryDir(), "telemetry.jsonl");
    writeFileSync(file, '{"at":"x","session":"old","effort":"low"}\n');
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ session: "new" }));

    buffer.persist(file);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"new"');
  });

  test("rotates once past the size limit", () => {
    const file = join(temporaryDir(), "telemetry.jsonl");
    writeFileSync(file, "x".repeat(64));
    const buffer = new TelemetryBuffer();
    buffer.append(decision({ session: "new" }));

    buffer.persist(file, 32);

    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(64);
    expect(readFileSync(file, "utf8")).toContain('"new"');
  });

  test("writes nothing for an empty buffer", () => {
    const file = join(temporaryDir(), "telemetry.jsonl");
    const buffer = new TelemetryBuffer();

    expect(buffer.persist(file)).toBe(0);
  });
});

describe("readTelemetry", () => {
  test("returns an empty list for a missing file", () => {
    expect(readTelemetry(join(temporaryDir(), "absent.jsonl"))).toEqual([]);
  });

  test("skips lines that do not parse or lack the required fields", () => {
    const file = join(temporaryDir(), "telemetry.jsonl");
    writeFileSync(
      file,
      [
        '{"at":"2026-01-01T00:00:00.000Z","session":"a","effort":"low"}',
        "{not json",
        '{"effort":"low"}',
        "",
        '{"at":"2026-01-01T00:00:01.000Z","session":"b","effort":"high"}',
      ].join("\n"),
    );

    const entries = readTelemetry(file);

    expect(entries.map((entry) => entry.session)).toEqual(["a", "b"]);
  });
});
