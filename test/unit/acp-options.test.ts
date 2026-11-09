import { describe, expect, test } from "bun:test";
import {
  findThoughtLevel,
  isCurrent,
  mapEffort,
} from "../../src/acp/options.ts";

const agentOptions = [
  {
    id: "model",
    type: "select",
    currentValue: "a/b",
    options: [{ value: "a/b", name: "A/B" }],
  },
  {
    id: "effort",
    type: "select",
    category: "thought_level",
    currentValue: "default",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
      { value: "default", name: "Default" },
    ],
  },
  {
    id: "mode",
    type: "select",
    category: "mode",
    currentValue: "restricted",
    options: [{ value: "restricted", name: "Restricted" }],
  },
];

describe("findThoughtLevel", () => {
  test("finds the selector by its category", () => {
    const option = findThoughtLevel(agentOptions);
    expect(option?.id).toBe("effort");
    expect(option?.current).toBe("default");
    expect(option?.values.map((entry) => entry.value)).toEqual([
      "low",
      "high",
      "max",
      "default",
    ]);
  });

  test("falls back to known ids without a category", () => {
    const option = findThoughtLevel([
      {
        id: "reasoning_effort",
        type: "select",
        options: [{ value: "medium", name: "Medium" }],
      },
    ]);
    expect(option?.id).toBe("reasoning_effort");
  });

  test("ignores boolean, empty, and malformed selectors", () => {
    expect(
      findThoughtLevel([
        { id: "effort", type: "boolean", currentValue: true },
        { id: "thinking", type: "select", options: [] },
        { id: "mode", type: "select", options: [{ value: 1 }] },
        null,
        "effort",
      ]),
    ).toBeNull();
  });

  test("returns null when there is nothing to drive", () => {
    expect(findThoughtLevel(undefined)).toBeNull();
    expect(findThoughtLevel([])).toBeNull();
  });
});

describe("mapEffort", () => {
  const option = findThoughtLevel(agentOptions);

  test("maps abstract levels onto the agent's own vocabulary", () => {
    if (!option) throw new Error("expected a selector");
    // Ties go to the stronger value, matching resolveVariant.
    expect(mapEffort(option, "minimal")).toBe("low");
    expect(mapEffort(option, "low")).toBe("low");
    expect(mapEffort(option, "medium")).toBe("high");
    expect(mapEffort(option, "high")).toBe("high");
    expect(mapEffort(option, "xhigh")).toBe("max");
  });

  test("returns null when no value sits on the scale", () => {
    const odd = findThoughtLevel([
      {
        id: "effort",
        type: "select",
        options: [{ value: "turbo", name: "Turbo" }],
      },
    ]);
    if (!odd) throw new Error("expected a selector");
    expect(mapEffort(odd, "medium")).toBeNull();
  });

  test("reports the current value", () => {
    if (!option) throw new Error("expected a selector");
    expect(isCurrent(option, "default")).toBe(true);
    expect(isCurrent(option, "max")).toBe(false);
  });
});
