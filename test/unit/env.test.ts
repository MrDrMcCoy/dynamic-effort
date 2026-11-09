import { describe, expect, test } from "bun:test";
import { envConfig } from "../../src/core/env.ts";

describe("envConfig", () => {
  test("reads the documented variables", () => {
    const config = envConfig({
      DYNAMIC_EFFORT_ENDPOINT: "http://127.0.0.1:9000/v1/systemone",
      DYNAMIC_EFFORT_API_KEY: "secret",
      DYNAMIC_EFFORT_MODEL: "jev-1.13-free",
      DYNAMIC_EFFORT_DEFAULT_EFFORT: "low",
      DYNAMIC_EFFORT_MAX_EFFORT: "high",
      DYNAMIC_EFFORT_MIN_CONFIDENCE: "0.5",
      DYNAMIC_EFFORT_STAKES_THRESHOLD: "0.8",
      DYNAMIC_EFFORT_TIMEOUT_MS: "2500",
      DYNAMIC_EFFORT_MAX_STATE_CHARS: "1200",
      DYNAMIC_EFFORT_PORT: "8100",
      DYNAMIC_EFFORT_THREADS: "4",
      DYNAMIC_EFFORT_JEV_PATH: "/opt/jev",
      DYNAMIC_EFFORT_DEBUG: "1",
    });

    expect(config.endpoint).toBe("http://127.0.0.1:9000/v1/systemone");
    expect(config.apiKey).toBe("secret");
    expect(config.model).toBe("jev-1.13-free");
    expect(config.defaultEffort).toBe("low");
    expect(config.maxEffort).toBe("high");
    expect(config.minConfidence).toBe(0.5);
    expect(config.stakesThreshold).toBe(0.8);
    expect(config.timeoutMs).toBe(2500);
    expect(config.maxStateChars).toBe(1200);
    expect(config.jevPort).toBe(8100);
    expect(config.jevThreads).toBe(4);
    expect(config.jevPath).toBe("/opt/jev");
    expect(config.debug).toBe(true);
  });

  test("ignores blank and malformed values", () => {
    const config = envConfig({
      DYNAMIC_EFFORT_ENDPOINT: "   ",
      DYNAMIC_EFFORT_TIMEOUT_MS: "soon",
      DYNAMIC_EFFORT_DEBUG: "yes",
    });

    expect(config.endpoint).toBeUndefined();
    expect(config.timeoutMs).toBeUndefined();
    expect(config.debug).toBeUndefined();
  });

  test("returns no keys for an empty environment", () => {
    const config = envConfig({});
    for (const value of Object.values(config)) {
      expect(value).toBeUndefined();
    }
  });
});
