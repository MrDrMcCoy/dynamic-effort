import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/core/runtime.ts";

describe("createRuntime", () => {
  test("layers options over the environment over the defaults", async () => {
    const runtime = createRuntime({
      env: {
        DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9999/v1/systemone",
        DYNAMIC_EFFORT_DEFAULT_EFFORT: "low",
      },
      config: { defaultEffort: "high" },
      warm: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    expect(runtime.config.defaultEffort).toBe("high");
    expect(runtime.config.maxEffort).toBe("xhigh");
    expect(runtime.config.endpoint).toBe("http://127.0.0.1:9999/v1/systemone");
    expect(runtime.available).toBe(true);
    await runtime.stop();
  });

  test("passes the configured endpoint to each decision", async () => {
    const runtime = createRuntime({
      env: { DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9999/" },
      config: { timeoutMs: 1500 },
      warm: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const options = await runtime.requestOptions();
    // The decision client normalises a bare base URL; the runtime only
    // forwards what it was given.
    expect(options.endpoint).toBe("http://127.0.0.1:9999/");
    expect(options.timeoutMs).toBe(1500);
    await runtime.stop();
  });

  test("keeps a telemetry buffer sized from the config", () => {
    const runtime = createRuntime({
      env: { DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9999/" },
      config: { telemetryCapacity: 3 },
      warm: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    for (let index = 0; index < 5; index += 1) {
      runtime.telemetry.append({
        session: `ses_${index}`,
        effort: "low",
        applied: true,
        source: "prompt",
      });
    }

    expect(runtime.telemetry.size).toBe(3);
    expect(runtime.telemetryPath.endsWith("telemetry.jsonl")).toBe(true);
  });

  test("writes telemetry on stop only when persistence is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "dynamic-effort-runtime-"));
    const runtime = createRuntime({
      env: {
        DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9999/",
        XDG_CACHE_HOME: root,
      },
      config: { telemetryPersist: true },
      warm: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    runtime.telemetry.append({
      session: "ses_1",
      effort: "low",
      applied: true,
      source: "prompt",
    });

    await runtime.stop();

    expect(runtime.telemetryPath.startsWith(root)).toBe(true);
    expect(readFileSync(runtime.telemetryPath, "utf8")).toContain('"ses_1"');
  });

  test("leaves the disk alone when persistence is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "dynamic-effort-runtime-"));
    const runtime = createRuntime({
      env: {
        DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9999/",
        XDG_CACHE_HOME: root,
      },
      warm: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    runtime.telemetry.append({
      session: "ses_1",
      effort: "low",
      applied: true,
      source: "prompt",
    });

    await runtime.stop();

    expect(existsSync(runtime.telemetryPath)).toBe(false);
  });
});
