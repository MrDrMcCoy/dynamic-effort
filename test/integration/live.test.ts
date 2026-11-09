// Live checks against a real jevos server. Skipped when none answers, so
// `bun test` stays green on a machine without the model.
//
// Start one with:
//   jev serve --host 127.0.0.1 --port 8017 --model-dir <dir> --ctx 1024

import { describe, expect, test } from "bun:test";
import {
  askSystemOne,
  composeDecision,
  decide,
  probeHealth,
} from "../../src/core/index.ts";

const PORT = Number(process.env["DYNAMIC_EFFORT_TEST_PORT"] ?? 8017);
const endpoint = `http://127.0.0.1:${PORT}/v1/systemone`;
const health = await probeHealth(PORT, 500);
const live = health !== null ? describe : describe.skip;

live("live jevos", () => {
  test("reports readiness", () => {
    expect(health?.status).toBe("ready");
    expect(health?.model_files).toBeDefined();
  });

  test("answers both questions for a trivial task", async () => {
    const response = await askSystemOne("task: say hi in one word", { endpoint });
    expect(response.model).toBe("jevos-v5");
    expect(response.answers.reasoning_effort?.type).toBe("choice");
    expect(typeof response.answers.reasoning_effort?.confidence).toBe("number");
    expect(response.answers.high_stakes?.type).toBe("noul");
    expect(response.answers.high_stakes?.noul).toBeGreaterThanOrEqual(0);
    expect(response.answers.high_stakes?.noul).toBeLessThanOrEqual(1);
  });

  test("composes a usable decision", async () => {
    const decision = await decide("task: fix a typo in the README", {}, { endpoint });
    expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(
      decision.effort,
    );
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
  });

  test("rates a hard task no lower than a trivial one", async () => {
    const trivial = composeDecision(
      await askSystemOne("task: print hello world", { endpoint }),
    );
    const hard = composeDecision(
      await askSystemOne(
        "task: design a lock-free distributed queue with exactly-once " +
          "semantics and prove the invariants under partition",
        { endpoint },
      ),
    );
    const order = ["minimal", "low", "medium", "high", "xhigh"];
    expect(order.indexOf(hard.effort)).toBeGreaterThanOrEqual(
      order.indexOf(trivial.effort),
    );
  });

  test("rejects an unknown model", async () => {
    await expect(
      askSystemOne("task: hi", { endpoint, model: "nope" }),
    ).rejects.toThrow(/422/);
  });
});
