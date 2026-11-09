import { describe, expect, test } from "bun:test";
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
});
