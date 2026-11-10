import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_ORDER, isEffortLevel } from "../../src/core/index.ts";

const CORPUS = join(import.meta.dir, "..", "..", "calibration", "corpus.jsonl");

interface Row {
  text: string;
  expected: string;
  stakes: boolean;
}

function rows(): Row[] {
  return readFileSync(CORPUS, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);
}

describe("calibration corpus", () => {
  test("every row parses and carries a known effort level", () => {
    const all = rows();
    expect(all.length).toBeGreaterThan(40);
    for (const row of all) {
      expect(row.text.trim().length).toBeGreaterThan(0);
      expect(isEffortLevel(row.expected)).toBe(true);
      expect(typeof row.stakes).toBe("boolean");
    }
  });

  test("covers every effort level with several examples", () => {
    const all = rows();
    for (const level of EFFORT_ORDER) {
      const count = all.filter((row) => row.expected === level).length;
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  test("includes both dangerous and ordinary prompts", () => {
    const all = rows();
    expect(all.filter((row) => row.stakes).length).toBeGreaterThanOrEqual(10);
    expect(all.filter((row) => !row.stakes).length).toBeGreaterThanOrEqual(10);
  });

  test("has no duplicate prompts", () => {
    const all = rows();
    expect(new Set(all.map((row) => row.text)).size).toBe(all.length);
  });
});
