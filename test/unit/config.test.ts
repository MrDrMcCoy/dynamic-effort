import { describe, expect, test } from "bun:test";
import {
  agentIncluded,
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDE_AGENTS,
  readConfig,
} from "../../src/core/config.ts";

describe("readConfig", () => {
  test("returns defaults for empty options", () => {
    expect(readConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(readConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("keeps valid values", () => {
    const config = readConfig({
      endpoint: " http://127.0.0.1:9930/v1/systemone ",
      apiKey: "local",
      model: "jev-1.13-free",
      defaultEffort: "low",
      maxEffort: "high",
      minConfidence: 0.5,
      stakesThreshold: 0.8,
      timeoutMs: 3000,
      maxStateChars: 2000,
      respectExplicitVariant: false,
      debug: true,
      jevPort: 0,
      jevThreads: 4,
      jevIdleMs: 1000,
      jevPath: "/opt/jev",
      jevReuseDirs: ["/other/jev"],
      keywords: ["think"],
    });

    expect(config.endpoint).toBe("http://127.0.0.1:9930/v1/systemone");
    expect(config.apiKey).toBe("local");
    expect(config.model).toBe("jev-1.13-free");
    expect(config.defaultEffort).toBe("low");
    expect(config.maxEffort).toBe("high");
    expect(config.minConfidence).toBe(0.5);
    expect(config.stakesThreshold).toBe(0.8);
    expect(config.timeoutMs).toBe(3000);
    expect(config.maxStateChars).toBe(2000);
    expect(config.respectExplicitVariant).toBe(false);
    expect(config.debug).toBe(true);
    expect(config.jevPort).toBe(0);
    expect(config.jevThreads).toBe(4);
    expect(config.jevIdleMs).toBe(1000);
    expect(config.jevPath).toBe("/opt/jev");
    expect(config.jevReuseDirs).toEqual(["/other/jev"]);
    expect(config.keywords).toEqual(["think"]);
  });

  test("ignores invalid values", () => {
    const config = readConfig({
      defaultEffort: "maximum",
      maxEffort: 3,
      minConfidence: -1,
      timeoutMs: 0,
      jevPort: -5,
      jevThreads: 2.7,
      keywords: "not-a-list",
      includeAgents: [1, "build"],
    });
    expect(config.defaultEffort).toBe("medium");
    expect(config.maxEffort).toBe("xhigh");
    expect(config.minConfidence).toBe(0.35);
    expect(config.timeoutMs).toBe(8000);
    expect(config.jevPort).toBe(8017);
    expect(config.jevThreads).toBe(2);
    expect(config.keywords).toEqual(["ultrathink"]);
    expect(config.includeAgents).toEqual(["build"]);
  });

  test("treats blank strings as absent", () => {
    const config = readConfig({ endpoint: "  ", apiKey: "", model: " " });
    expect(config.endpoint).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  test("floors thread counts", () => {
    expect(readConfig({ jevThreads: 3.9 }).jevThreads).toBe(3);
    expect(readConfig({ jevThreads: 0 }).jevThreads).toBeNull();
  });

  test("reads option templates with object entries only", () => {
    const config = readConfig({
      optionTemplates: {
        "openrouter/glm-5": { reasoningEffort: "{effort}" },
        bad: "nope",
        worse: [1, 2],
      },
    });
    expect(config.optionTemplates).toEqual({
      "openrouter/glm-5": { reasoningEffort: "{effort}" },
    });
  });

  test("drops option templates that are not an object", () => {
    expect(readConfig({ optionTemplates: [] }).optionTemplates).toBeUndefined();
    expect(readConfig({ optionTemplates: "x" }).optionTemplates).toBeUndefined();
  });

  test("reads a complete question set", () => {
    const config = readConfig({
      questions: {
        reasoningEffort: "how hard?",
        highStakes: "risky?",
        effortCriteria: {
          minimal: "a",
          low: "b",
          medium: "c",
          high: "d",
          xhigh: "e",
        },
      },
    });
    expect(config.questions?.reasoningEffort).toBe("how hard?");
    expect(config.questions?.effortCriteria.xhigh).toBe("e");
  });

  test("rejects an incomplete question set", () => {
    const config = readConfig({
      questions: {
        reasoningEffort: "how hard?",
        highStakes: "risky?",
        effortCriteria: { minimal: "a" },
      },
    });
    expect(config.questions).toBeUndefined();
  });

  test("rejects non-object questions", () => {
    expect(readConfig({ questions: [] }).questions).toBeUndefined();
    expect(readConfig({ questions: 4 }).questions).toBeUndefined();
  });
});

describe("agentIncluded", () => {
  test("excludes the aux agents by default", () => {
    for (const agent of DEFAULT_EXCLUDE_AGENTS) {
      expect(agentIncluded(DEFAULT_CONFIG, agent)).toBe(false);
    }
  });

  test("includes other agents by default", () => {
    expect(agentIncluded(DEFAULT_CONFIG, "build")).toBe(true);
  });

  test("matches names case-insensitively", () => {
    expect(agentIncluded(DEFAULT_CONFIG, "TITLE")).toBe(false);
  });

  test("an include list limits the agents", () => {
    const config = { ...DEFAULT_CONFIG, includeAgents: ["build"] };
    expect(agentIncluded(config, "build")).toBe(true);
    expect(agentIncluded(config, "plan")).toBe(false);
  });

  test("exclusion wins over inclusion", () => {
    const config = {
      ...DEFAULT_CONFIG,
      includeAgents: ["build"],
      excludeAgents: ["build"],
    };
    expect(agentIncluded(config, "build")).toBe(false);
  });
});
