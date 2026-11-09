import { describe, expect, test } from "bun:test";
import {
  applyEffort,
  buildCatalog,
  buildState,
  bumpEffort,
  catalogKey,
  clampEffort,
  contentToText,
  DEFAULT_MAX_KEYWORDS,
  findMaxKeyword,
  hashPrompt,
  isEffortLevel,
  lastUserText,
  matchTemplate,
  resolveVariant,
  substituteEffort,
} from "../../src/core/effort.ts";

describe("clampEffort", () => {
  test("keeps effort at or below the maximum", () => {
    expect(clampEffort("low", "high")).toBe("low");
    expect(clampEffort("high", "high")).toBe("high");
  });

  test("lowers effort above the maximum", () => {
    expect(clampEffort("xhigh", "medium")).toBe("medium");
  });
});

describe("bumpEffort", () => {
  test("raises one level", () => {
    expect(bumpEffort("minimal")).toBe("low");
    expect(bumpEffort("medium")).toBe("high");
  });

  test("saturates at xhigh", () => {
    expect(bumpEffort("xhigh")).toBe("xhigh");
  });
});

describe("isEffortLevel", () => {
  test("accepts known levels only", () => {
    expect(isEffortLevel("medium")).toBe(true);
    expect(isEffortLevel("max")).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
  });
});

describe("buildCatalog", () => {
  test("keys models by provider and model id", () => {
    const catalog = buildCatalog([
      { providerID: "openrouter", modelID: "glm-5", variants: [{ id: "high" }] },
      { providerID: "local", id: "qwen", variants: [] },
    ]);
    expect([...catalog.keys()]).toEqual([
      catalogKey("openrouter", "glm-5"),
      catalogKey("local", "qwen"),
    ]);
    expect(catalog.get("openrouter/glm-5")?.variants).toHaveLength(1);
  });

  test("skips records without a provider or model id", () => {
    const catalog = buildCatalog([
      { providerID: "", modelID: "x" },
      { providerID: "p" },
      { providerID: "p", modelID: "  " },
    ]);
    expect(catalog.size).toBe(0);
  });

  test("lowercases keys for case-insensitive lookup", () => {
    const catalog = buildCatalog([
      { providerID: "OpenRouter", modelID: "GLM-5" },
    ]);
    expect(catalog.get(catalogKey("openrouter", "glm-5"))).toBeDefined();
  });
});

describe("resolveVariant", () => {
  const variants = [
    { id: "none" },
    { id: "low" },
    { id: "high" },
    { id: "max" },
  ];

  test("picks the nearest variant on the scale", () => {
    expect(resolveVariant("medium", variants)).toBe("high");
    expect(resolveVariant("minimal", variants)).toBe("low");
  });

  test("ties go to the stronger variant", () => {
    // "low" is distance 1 from "minimal"; "none" is also distance 1 but
    // weaker. The tie must resolve upward.
    expect(resolveVariant("minimal", [{ id: "none" }, { id: "low" }])).toBe(
      "low",
    );
  });

  test("reads the level from settings when the id is opaque", () => {
    const opaque = [{ id: "fast", settings: { reasoningEffort: "low" } }];
    expect(resolveVariant("medium", opaque)).toBe("fast");
  });

  test("reads thinkingLevel settings", () => {
    const opaque = [{ id: "deep", settings: { thinkingLevel: "xhigh" } }];
    expect(resolveVariant("xhigh", opaque)).toBe("deep");
  });

  test("returns undefined when no variant is placeable", () => {
    expect(resolveVariant("medium", [{ id: "turbo" }])).toBeUndefined();
    expect(resolveVariant("medium", [])).toBeUndefined();
  });
});

describe("matchTemplate", () => {
  const templates = {
    "openrouter/glm-5": { a: 1 },
    "openrouter/*": { b: 2 },
    "*/qwen": { c: 3 },
    "*": { d: 4 },
  };

  test("prefers the exact provider and model", () => {
    expect(matchTemplate(templates, "openrouter", "glm-5")).toEqual({ a: 1 });
  });

  test("falls back through provider, model, then wildcard", () => {
    expect(matchTemplate(templates, "openrouter", "other")).toEqual({ b: 2 });
    expect(matchTemplate(templates, "other", "qwen")).toEqual({ c: 3 });
    expect(matchTemplate(templates, "other", "other")).toEqual({ d: 4 });
  });

  test("is case-insensitive", () => {
    expect(matchTemplate(templates, "OpenRouter", "GLM-5")).toEqual({ a: 1 });
  });

  test("returns undefined without templates", () => {
    expect(matchTemplate(undefined, "p", "m")).toBeUndefined();
  });
});

describe("substituteEffort", () => {
  test("replaces placeholders in nested values", () => {
    expect(
      substituteEffort(
        { reasoning: { effort: "{effort}", list: ["x-{effort}"] }, keep: 3 },
        "high",
      ),
    ).toEqual({ reasoning: { effort: "high", list: ["x-high"] }, keep: 3 });
  });

  test("leaves non-string scalars alone", () => {
    expect(substituteEffort(7, "high")).toBe(7);
    expect(substituteEffort(null, "high")).toBeNull();
  });
});

describe("applyEffort", () => {
  const entry = {
    providerID: "p",
    modelID: "m",
    variants: [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ],
  };

  test("copies the resolved variant's settings", () => {
    const options: Record<string, unknown> = {};
    const applied = applyEffort(options, "p", "m", "high", entry);
    expect(applied).toEqual({ variantId: "high", applied: true });
    expect(options).toEqual({ reasoningEffort: "high" });
  });

  test("templates win over catalog settings", () => {
    const options: Record<string, unknown> = {};
    const applied = applyEffort(options, "p", "m", "high", entry, {
      "p/m": { custom: "{effort}" },
    });
    expect(applied).toEqual({ variantId: "high", applied: true });
    expect(options).toEqual({ custom: "high" });
  });

  test("reports applied false when nothing could be written", () => {
    const options: Record<string, unknown> = {};
    const applied = applyEffort(options, "p", "m", "high");
    expect(applied).toEqual({ variantId: undefined, applied: false });
    expect(options).toEqual({});
  });

  test("still writes a template when the catalog has no match", () => {
    const options: Record<string, unknown> = {};
    const applied = applyEffort(options, "p", "m", "low", undefined, {
      "*": { effort: "{effort}" },
    });
    expect(applied).toEqual({ variantId: undefined, applied: true });
    expect(options).toEqual({ effort: "low" });
  });
});

describe("buildState", () => {
  test("prefixes the task with the scope", () => {
    expect(buildState("fix it", { agent: "build", model: "p/m" })).toBe(
      "agent=build model=p/m\ntask: fix it",
    );
  });

  test("omits an empty scope", () => {
    expect(buildState("fix it")).toBe("task: fix it");
  });

  test("keeps the tail of a long task", () => {
    const state = buildState("a".repeat(100), {}, 10);
    expect(state).toBe(`task: ${"a".repeat(10)}`);
  });
});

describe("contentToText", () => {
  test("joins text parts", () => {
    expect(
      contentToText([
        { type: "text", text: "one" },
        "two",
        { type: "image" },
      ]),
    ).toBe("one\ntwo\n");
  });

  test("returns strings unchanged", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  test("returns empty for other shapes", () => {
    expect(contentToText(undefined)).toBe("");
    expect(contentToText({ text: "x" })).toBe("");
  });
});

describe("lastUserText", () => {
  test("returns the last user message", () => {
    expect(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("second");
  });

  test("accepts the human role", () => {
    expect(lastUserText([{ role: "human", content: "hi" }])).toBe("hi");
  });

  test("skips empty user messages", () => {
    expect(
      lastUserText([
        { role: "user", content: "real" },
        { role: "user", content: "   " },
      ]),
    ).toBe("real");
  });

  test("returns empty for non-arrays", () => {
    expect(lastUserText(null)).toBe("");
    expect(lastUserText({ role: "user" })).toBe("");
  });
});

describe("hashPrompt", () => {
  test("is stable and differs between prompts", () => {
    expect(hashPrompt("abc")).toBe(hashPrompt("abc"));
    expect(hashPrompt("abc")).not.toBe(hashPrompt("abd"));
  });
});

describe("findMaxKeyword", () => {
  test("finds whole-word keywords only", () => {
    expect(findMaxKeyword("please ultrathink this")).toBe("ultrathink");
    expect(findMaxKeyword("ultrathinking is not a keyword")).toBeUndefined();
  });

  test("is case-insensitive", () => {
    expect(findMaxKeyword("ULTRAthink")).toBe("ultrathink");
  });

  test("uses the default keyword list", () => {
    expect(DEFAULT_MAX_KEYWORDS).toContain("ultrathink");
  });

  test("ignores blank keyword entries", () => {
    expect(findMaxKeyword("text", ["", "  "])).toBeUndefined();
  });

  test("escapes regex metacharacters in keywords", () => {
    expect(findMaxKeyword("use c++ here", ["c++"])).toBe("c++");
  });
});
