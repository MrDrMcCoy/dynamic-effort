import { describe, expect, test } from "bun:test";
import { DecisionRouter, type StashedDecision } from "../../src/core/router.ts";
import type { FetchLike } from "../../src/core/decision.ts";

function stubDecision(effort: "minimal" | "low" | "medium" | "high" | "xhigh") {
  return async () =>
    new Response(
      JSON.stringify({
        model: "jevos-v5",
        answers: {
          reasoning_effort: { type: "choice", choice: effort, confidence: 0.9 },
          high_stakes: { type: "noul", noul: 0.1 },
        },
      }),
    );
}

const context = {
  sessionID: "ses_1",
  agent: "build",
  model: { providerID: "openrouter", modelID: "glm-5" },
};

describe("DecisionRouter", () => {
  test("decides once per prompt and reuses the stash", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return stubDecision("high")();
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });

    const first = await router.onPrompt({ sessionID: "ses_1", text: "fix the bug" });
    const second = await router.onPrompt({ sessionID: "ses_1", text: "fix the bug" });
    const applied = await router.onContext(context);

    expect(calls).toBe(1);
    expect(first?.effort).toBe("high");
    expect(second).toBe(first);
    expect(applied).toBe(first);
  });

  test("decides again for a new prompt in the same session", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return stubDecision("low")();
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });

    await router.onPrompt({ sessionID: "ses_1", text: "one" });
    await router.onPrompt({ sessionID: "ses_1", text: "two" });
    expect(calls).toBe(2);
  });

  test("skips the decision for a pinned prompt", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return stubDecision("high")();
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });

    await router.onPrompt({ sessionID: "ses_1", text: "x" });
    expect(router.get("ses_1")).toBeDefined();

    const pinned = await router.onPrompt({
      sessionID: "ses_1",
      text: "y",
      pinned: true,
    });
    expect(pinned).toBeUndefined();
    expect(router.get("ses_1")).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("ignores a pinned context request", async () => {
    const router = new DecisionRouter({ request: { fetch: stubDecision("high") } });
    await router.onPrompt({ sessionID: "ses_1", text: "x" });
    expect(await router.onContext({ ...context, pinned: true })).toBeUndefined();
  });

  test("a max keyword wins without asking the model", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return stubDecision("low")();
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });

    const decision = await router.onPrompt({
      sessionID: "ses_1",
      text: "ultrathink about this",
    });
    expect(decision?.effort).toBe("xhigh");
    expect(decision?.keyword).toBe("ultrathink");
    expect(calls).toBe(0);
  });

  test("falls back to a decision from the messages on context", async () => {
    const router = new DecisionRouter({ request: { fetch: stubDecision("medium") } });
    const decision = await router.onContext({
      ...context,
      messages: [{ role: "user", content: "explain this function" }],
    });
    expect(decision?.effort).toBe("medium");
    expect(router.get("ses_1")).toBe(decision);
  });

  test("applies the fallback keyword on context", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return stubDecision("low")();
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });
    const decision = await router.onContext({
      ...context,
      messages: [{ role: "user", content: "please ultrathink" }],
    });
    expect(decision?.effort).toBe("xhigh");
    expect(calls).toBe(0);
  });

  test("returns undefined when there is nothing to decide from", async () => {
    const router = new DecisionRouter();
    expect(await router.onContext({ ...context, messages: [] })).toBeUndefined();
    expect(await router.onPrompt({ sessionID: "ses_1", text: "   " })).toBeUndefined();
  });

  test("fails open when the decision call throws", async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("connection refused");
    }) as FetchLike;
    const router = new DecisionRouter({ request: { fetch: fetchImpl } });
    expect(await router.onPrompt({ sessionID: "ses_1", text: "x" })).toBeUndefined();
    expect(await router.onContext({ ...context, messages: [{ role: "user", content: "y" }] }))
      .toBeUndefined();
  });

  test("reports each decision to the callback", async () => {
    const seen: StashedDecision[] = [];
    const router = new DecisionRouter({
      request: { fetch: stubDecision("low") },
      onDecision: (_sessionID, decision) => seen.push(decision),
    });
    await router.onPrompt({ sessionID: "ses_1", text: "x" });
    await router.onPrompt({ sessionID: "ses_1", text: "x" });
    expect(seen).toHaveLength(1);
  });

  test("evicts the oldest session beyond the cap", async () => {
    const router = new DecisionRouter({
      request: { fetch: stubDecision("low") },
      maxSessions: 2,
    });
    for (const id of ["a", "b", "c"]) {
      await router.onPrompt({ sessionID: id, text: "x" });
    }
    expect(router.get("a")).toBeUndefined();
    expect(router.get("b")).toBeDefined();
    expect(router.get("c")).toBeDefined();
  });

  test("re-deciding an existing session does not evict another", async () => {
    const router = new DecisionRouter({
      request: { fetch: stubDecision("low") },
      maxSessions: 2,
    });
    await router.onPrompt({ sessionID: "a", text: "x" });
    await router.onPrompt({ sessionID: "b", text: "x" });
    await router.onPrompt({ sessionID: "b", text: "y" });
    expect(router.get("a")).toBeDefined();
  });

  test("clear forgets one session", async () => {
    const router = new DecisionRouter({ request: { fetch: stubDecision("low") } });
    await router.onPrompt({ sessionID: "ses_1", text: "x" });
    router.clear("ses_1");
    expect(router.get("ses_1")).toBeUndefined();
  });

  test("accepts a request provider called per decision", async () => {
    const endpoints: (string | undefined)[] = [];
    const fetchImpl = (async (url: string) => {
      endpoints.push(url);
      return stubDecision("high")();
    }) as FetchLike;
    let url = "http://127.0.0.1:1/v1/systemone";
    const router = new DecisionRouter({
      request: async () => ({ endpoint: url, fetch: fetchImpl }),
    });

    await router.onPrompt({ sessionID: "ses_1", text: "one" });
    url = "http://127.0.0.1:2/v1/systemone";
    await router.onPrompt({ sessionID: "ses_1", text: "two" });

    expect(endpoints).toEqual([
      "http://127.0.0.1:1/v1/systemone",
      "http://127.0.0.1:2/v1/systemone",
    ]);
  });
});
