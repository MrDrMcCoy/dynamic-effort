import { describe, expect, test } from "bun:test";
import {
  askSystemOne,
  buildQuestions,
  composeDecision,
  decide,
  DEFAULT_QUESTIONS,
  DEFAULT_ENDPOINT,
  resolveEndpoint,
  type FetchLike,
  type SystemOneResponse,
} from "../../src/core/decision.ts";

function response(partial: Partial<SystemOneResponse["answers"]>): SystemOneResponse {
  return { model: "jevos-v5", answers: partial };
}

const confident = (choice: string, confidence = 0.9) => ({
  type: "choice" as const,
  choice,
  confidence,
});

describe("buildQuestions", () => {
  test("asks one choice and one noul question", () => {
    const questions = buildQuestions() as Record<string, { type: string }>;
    expect(questions["reasoning_effort"]?.type).toBe("choice");
    expect(questions["high_stakes"]?.type).toBe("noul");
  });

  test("uses the supplied wording", () => {
    const questions = buildQuestions({
      ...DEFAULT_QUESTIONS,
      reasoningEffort: "custom",
    }) as Record<string, { instructions: string }>;
    expect(questions["reasoning_effort"]?.instructions).toBe("custom");
  });
});

describe("composeDecision", () => {
  test("uses a confident choice as-is", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("low"), high_stakes: { type: "noul", noul: 0.1 } }),
    );
    expect(decision.effort).toBe("low");
    expect(decision.lowConfidence).toBe(false);
    expect(decision.bumpedForStakes).toBe(false);
  });

  test("falls back to the default when confidence is low", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("minimal", 0.1) }),
    );
    expect(decision.effort).toBe("medium");
    expect(decision.lowConfidence).toBe(true);
    expect(decision.rawChoice).toBe("minimal");
  });

  test("bumps one level for high-stakes work", () => {
    const decision = composeDecision(
      response({
        reasoning_effort: confident("low"),
        high_stakes: { type: "noul", noul: 0.95 },
      }),
    );
    expect(decision.effort).toBe("medium");
    expect(decision.bumpedForStakes).toBe(true);
  });

  test("does not bump at or above xhigh", () => {
    const decision = composeDecision(
      response({
        reasoning_effort: confident("xhigh"),
        high_stakes: { type: "noul", noul: 0.99 },
      }),
    );
    expect(decision.effort).toBe("xhigh");
    expect(decision.bumpedForStakes).toBe(false);
  });

  test("respects the stakes threshold", () => {
    const decision = composeDecision(
      response({
        reasoning_effort: confident("low"),
        high_stakes: { type: "noul", noul: 0.69 },
      }),
    );
    expect(decision.effort).toBe("low");
  });

  test("clamps to maxEffort", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("xhigh") }),
      { maxEffort: "medium" },
    );
    expect(decision.effort).toBe("medium");
  });

  test("honours a custom confidence threshold", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("low", 0.5) }),
      { minConfidence: 0.4 },
    );
    expect(decision.effort).toBe("low");
  });

  test("falls back when the choice is unknown", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("extreme") }),
      { defaultEffort: "high" },
    );
    expect(decision.effort).toBe("high");
    expect(decision.rawChoice).toBe("extreme");
    expect(decision.lowConfidence).toBe(true);
  });

  test("falls back when the choice is missing", () => {
    const decision = composeDecision(response({}));
    expect(decision.effort).toBe("medium");
    expect(decision.rawChoice).toBe("unknown");
    expect(decision.confidence).toBe(0);
    expect(decision.highStakes).toBe(0);
  });

  test("treats a missing stakes answer as zero", () => {
    const decision = composeDecision(
      response({ reasoning_effort: confident("medium") }),
    );
    expect(decision.highStakes).toBe(0);
  });
});

describe("resolveEndpoint", () => {
  test("adds the decision path to a bare base URL", () => {
    expect(resolveEndpoint("http://127.0.0.1:8017")).toBe(
      "http://127.0.0.1:8017/v1/systemone",
    );
    expect(resolveEndpoint("http://127.0.0.1:8017/")).toBe(
      "http://127.0.0.1:8017/v1/systemone",
    );
    expect(resolveEndpoint("  http://localhost:9930  ")).toBe(
      "http://localhost:9930/v1/systemone",
    );
  });

  test("keeps a full endpoint as given", () => {
    expect(resolveEndpoint("http://localhost:9930/v1/systemone")).toBe(
      "http://localhost:9930/v1/systemone",
    );
    expect(resolveEndpoint("https://example.test/zen/v1/systemone/")).toBe(
      "https://example.test/zen/v1/systemone",
    );
  });

  test("falls back to the default for a blank value", () => {
    expect(resolveEndpoint("   ")).toBe(DEFAULT_ENDPOINT);
  });
});

describe("askSystemOne", () => {
  test("posts the state and questions to the endpoint", async () => {
    let seen: { url: string; body: unknown; headers: Record<string, string> } | null =
      null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      };
      return new Response(
        JSON.stringify({ model: "jevos-v5", answers: {} }),
        { status: 200 },
      );
    }) as FetchLike;

    await askSystemOne("task: hi", {
      endpoint: "http://127.0.0.1:9999/v1/systemone",
      model: "jevos-v5",
      fetch: fetchImpl,
    });

    expect(seen!.url).toBe("http://127.0.0.1:9999/v1/systemone");
    const body = seen!.body as {
      model: string;
      state: string;
      questions: Record<string, unknown>;
    };
    expect(body.model).toBe("jevos-v5");
    expect(body.state).toBe("task: hi");
    expect(Object.keys(body.questions)).toEqual([
      "reasoning_effort",
      "high_stakes",
    ]);
  });

  test("sends an authorization header only when a key exists", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ model: "m", answers: {} }));
    }) as FetchLike;

    const previous = process.env["JEV_API_KEY"];
    delete process.env["JEV_API_KEY"];
    try {
      await askSystemOne("task: hi", { fetch: fetchImpl });
      await askSystemOne("task: hi", { fetch: fetchImpl, apiKey: "secret" });
    } finally {
      if (previous !== undefined) process.env["JEV_API_KEY"] = previous;
    }

    expect(seen[0]?.["Authorization"]).toBeUndefined();
    expect(seen[1]?.["Authorization"]).toBe("Bearer secret");
  });

  test("throws on a non-OK response with a truncated body", async () => {
    const fetchImpl = (async () =>
      new Response("bad model", { status: 422 })) as unknown as typeof fetch;
    await expect(askSystemOne("task: hi", { fetch: fetchImpl })).rejects.toThrow(
      /decision request failed \(422\): bad model/,
    );
  });

  test("aborts after the timeout", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    await expect(
      askSystemOne("task: hi", { fetch: fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("decide", () => {
  test("asks and composes in one call", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "jevos-v5",
          answers: {
            reasoning_effort: confident("high"),
            high_stakes: { type: "noul", noul: 0.05 },
          },
        }),
      )) as unknown as typeof fetch;
    const decision = await decide("task: hi", {}, { fetch: fetchImpl });
    expect(decision.effort).toBe("high");
  });
});
