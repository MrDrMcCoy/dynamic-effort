import { describe, expect, test } from "bun:test";
import { DecisionRouter } from "../../src/core/router.ts";
import type { FetchLike } from "../../src/core/decision.ts";
import { AcpProxy } from "../../src/acp/proxy.ts";
import { FakeTransport, settle } from "../helpers/acp.ts";

const effortOptions = [
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
];

const noEffortOptions = [{ id: "model", type: "select", options: [] }];

function router(decide = "high", calls: string[] = []) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(
      JSON.stringify({
        answers: {
          reasoning_effort: { type: "choice", choice: decide, confidence: 0.9 },
          high_stakes: { type: "noul", noul: 0.1 },
        },
      }),
    );
  }) as FetchLike;
  return new DecisionRouter({ request: { fetch: fetchImpl } });
}

function build(options: {
  decide?: string;
  configOptions?: unknown;
  applyEffort?: boolean;
  calls?: string[];
  onApplied?: (
    sessionId: string,
    decision: unknown,
    value: string | null,
    prompt: string,
  ) => void;
  onUsage?: (
    sessionId: string,
    usage: { input: number; output: number; reasoning: number },
  ) => void;
}) {
  const client = new FakeTransport();
  const agent = new FakeTransport();
  const proxy = new AcpProxy({
    client,
    agent,
    router: router(options.decide ?? "high", options.calls ?? []),
    applyEffort: options.applyEffort,
    applyTimeoutMs: 50,
    onApplied: options.onApplied as never,
    onUsage: options.onUsage,
  });
  proxy.start();
  return { client, agent, proxy };
}

/** Answers a forwarded session/new and returns the agent's request id. */
async function openSession(
  agent: FakeTransport,
  configOptions: unknown,
  sessionId = "ses_1",
) {
  await settle();
  const request = agent.requests("session/new").at(-1);
  if (!request) throw new Error("session/new was not forwarded");
  agent.push({
    jsonrpc: "2.0",
    id: request.id,
    result: { sessionId, configOptions },
  });
  await settle();
  return request;
}

/** Answers the agent-side config change so the prompt can proceed. */
async function answerConfig(agent: FakeTransport) {
  await settle();
  const request = agent.requests("session/set_config_option").at(-1);
  if (!request) throw new Error("the proxy did not set an effort");
  agent.push({ jsonrpc: "2.0", id: request.id, result: { configOptions: [] } });
  await settle();
}

describe("AcpProxy", () => {
  test("restores the client's request id on the response", async () => {
    const { client, agent } = build({ configOptions: effortOptions });
    client.push({ jsonrpc: "2.0", id: 7, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    const response = client.last() as { id: unknown; result: unknown };
    expect(response.id).toBe(7);
    expect((response.result as { sessionId: string }).sessionId).toBe("ses_1");
  });

  test("sets the effort before the prompt reaches the agent", async () => {
    const calls: string[] = [];
    const { client, agent } = build({ configOptions: effortOptions, calls });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "ses_1",
        prompt: [{ type: "text", text: "refactor the parser" }],
      },
    });
    await answerConfig(agent);

    const config = agent.requests("session/set_config_option").at(-1);
    expect(config?.params).toEqual({
      sessionId: "ses_1",
      configId: "effort",
      value: "high",
    });
    expect(calls.length).toBe(1);
    const prompt = agent.requests("session/prompt").at(-1);
    expect((prompt?.params as { sessionId: string }).sessionId).toBe("ses_1");
  });

  test("keeps the prompt when the agent offers no thought level", async () => {
    const { client, agent } = build({ configOptions: noEffortOptions });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, noEffortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hello" }] },
    });
    await settle();

    expect(agent.requests("session/set_config_option").length).toBe(0);
    expect(agent.requests("session/prompt").length).toBe(1);
  });

  test("leaves a session alone once the user picks an effort", async () => {
    const { client, agent } = build({ configOptions: effortOptions });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/set_config_option",
      params: { sessionId: "ses_1", configId: "effort", value: "max" },
    });
    await settle();

    client.push({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await settle();

    // Only the user's own change went through.
    expect(agent.requests("session/set_config_option").length).toBe(1);
    expect(agent.requests("session/prompt").length).toBe(1);
  });

  test("forwards the prompt when the agent rejects the effort", async () => {
    const { client, agent } = build({ configOptions: effortOptions });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await settle();
    const config = agent.requests("session/set_config_option").at(-1);
    agent.push({
      jsonrpc: "2.0",
      id: config?.id as string,
      error: { code: -32602, message: "Invalid params: effort not found" },
    });
    await settle();

    expect(agent.requests("session/prompt").length).toBe(1);
  });

  test("forwards the prompt after the agent stops answering", async () => {
    const { client, agent } = build({ configOptions: effortOptions });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    // The proxy gives up after applyTimeoutMs and sends the prompt anyway.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    expect(agent.requests("session/prompt").length).toBe(1);
  });

  test("passes notifications through and refreshes the selector", async () => {
    const { client, agent } = build({
      configOptions: effortOptions,
      decide: "xhigh",
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    agent.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "thinking",
              type: "select",
              category: "thought_level",
              currentValue: "low",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
                { value: "max", name: "Max" },
              ],
            },
          ],
        },
      },
    });
    await settle();

    const last = client.last() as { method?: string };
    expect(last.method).toBe("session/update");

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await answerConfig(agent);

    const config = agent.requests("session/set_config_option").at(-1);
    // The refreshed selector reuses the same id with a new vocabulary.
    expect(config?.params).toEqual({
      sessionId: "ses_1",
      configId: "thinking",
      value: "max",
    });
  });

  test("does nothing when applying effort is turned off", async () => {
    const calls: string[] = [];
    const { client, agent } = build({
      configOptions: effortOptions,
      applyEffort: false,
      calls,
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await settle();

    expect(agent.requests("session/set_config_option").length).toBe(0);
    expect(calls.length).toBe(0);
    expect(agent.requests("session/prompt").length).toBe(1);
  });

  test("forgets a session when the client closes it", async () => {
    const { client, agent } = build({ configOptions: effortOptions });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/close",
      params: { sessionId: "ses_1" },
    });
    await settle();
    const request = agent.last() as { id?: string | number } | undefined;
    agent.push({ jsonrpc: "2.0", id: request?.id ?? "", result: {} });
    await settle();

    client.push({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await settle();

    // The selector is gone, so the prompt goes through unmodified.
    expect(agent.requests("session/set_config_option").length).toBe(0);
  });

  test("reports the applied value and the prompt for telemetry", async () => {
    const applied: Array<[string, string | null, string]> = [];
    const { client, agent } = build({
      configOptions: effortOptions,
      onApplied: (sessionId, _decision, value, prompt) => {
        applied.push([sessionId, value, prompt]);
      },
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "ses_1",
        prompt: [{ type: "text", text: "refactor the parser" }],
      },
    });
    await answerConfig(agent);

    expect(applied).toEqual([["ses_1", "high", "refactor the parser"]]);
  });

  test("reports a null value when nothing could be applied", async () => {
    const applied: Array<string | null> = [];
    const { client, agent } = build({
      configOptions: noEffortOptions,
      onApplied: (_sessionId, _decision, value) => {
        applied.push(value);
      },
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, noEffortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await settle();

    expect(applied).toEqual([null]);
  });

  test("reads the token counts from the prompt response", async () => {
    const usage: Array<{ input: number; output: number; reasoning: number }> =
      [];
    const { client, agent } = build({
      configOptions: effortOptions,
      onUsage: (_sessionId, snapshot) => usage.push(snapshot),
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await answerConfig(agent);
    const prompt = agent.requests("session/prompt").at(-1);
    agent.push({
      jsonrpc: "2.0",
      id: prompt?.id as string,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 34, thoughtTokens: 56 },
      },
    });
    await settle();

    expect(usage).toEqual([{ input: 12, output: 34, reasoning: 56 }]);
  });

  test("ignores a prompt response without usage", async () => {
    const usage: unknown[] = [];
    const { client, agent } = build({
      configOptions: effortOptions,
      onUsage: (_sessionId, snapshot) => usage.push(snapshot),
    });
    client.push({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await openSession(agent, effortOptions);

    client.push({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses_1", prompt: [{ type: "text", text: "hi" }] },
    });
    await answerConfig(agent);
    const prompt = agent.requests("session/prompt").at(-1);
    agent.push({
      jsonrpc: "2.0",
      id: prompt?.id as string,
      result: { stopReason: "end_turn" },
    });
    await settle();

    expect(usage).toEqual([]);
  });
});
