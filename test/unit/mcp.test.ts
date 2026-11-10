// Unit tests for the MCP server: handshake, tool listing, and one decision.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_NAME,
  serveMcp,
} from "../../src/mcp/index.ts";
import { readTelemetry } from "../../src/core/index.ts";
import { FakeTransport, settle } from "../helpers/acp.ts";
import type { RpcResponse } from "../../src/acp/jsonrpc.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function decisionServer(choice = "high", stakes = 0.1) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      return Response.json({
        model: "jevos-v5",
        answers: {
          reasoning_effort: {
            type: "choice",
            choice,
            probabilities: { [choice]: 0.9 },
            confidence: 0.9,
          },
          high_stakes: { type: "noul", noul: stakes },
        },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1/systemone`;
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-effort-mcp-"));
  directories.push(directory);
  return directory;
}

/** The response the server wrote for one request id. */
function reply(
  transport: FakeTransport,
  id: number,
): RpcResponse | undefined {
  return transport.written.find(
    (message) => (message as RpcResponse).id === id,
  ) as RpcResponse | undefined;
}

/** Starts the server on a fake transport and returns when it exits. */
function start(endpoint: string, directory?: string) {
  const transport = new FakeTransport();
  const done = serveMcp(
    {
      env: directory ? { XDG_CACHE_HOME: directory } : {},
      config: { endpoint, telemetryPersist: directory !== undefined },
    },
    transport,
  );
  return { transport, done };
}

describe("serveMcp", () => {
  test("answers initialize with the protocol version", async () => {
    const { transport, done } = start(decisionServer());
    transport.push({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    await settle();

    const initialized = reply(transport, 1);
    expect(initialized?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME },
    });
    transport.countdown();
    await done;
  });

  test("lists the decide_effort tool", async () => {
    const { transport, done } = start(decisionServer());
    transport.push({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await settle();

    const tools = (reply(transport, 2)?.result as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe(TOOL_NAME);
    transport.countdown();
    await done;
  });

  test("returns a decision as JSON text content", async () => {
    const { transport, done } = start(decisionServer("xhigh"));
    transport.push({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: TOOL_NAME,
        arguments: { prompt: "prove this sort is stable", model: "a/b" },
      },
    });
    await settle();

    const result = reply(transport, 3)?.result as {
      content: Array<{ type: string; text: string }>;
    };
    const payload = JSON.parse(result.content[0]!.text) as Record<
      string,
      unknown
    >;
    expect(payload["effort"]).toBe("xhigh");
    expect(payload["model"]).toBe("a/b");
    expect(payload["confidence"]).toBeGreaterThan(0);
    transport.countdown();
    await done;
  });

  test("rejects a call without a prompt", async () => {
    const { transport, done } = start(decisionServer());
    transport.push({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: {} },
    });
    await settle();

    expect(reply(transport, 4)?.error?.message).toBe("prompt is required");
    transport.countdown();
    await done;
  });

  test("reports an unknown method", async () => {
    const { transport, done } = start(decisionServer());
    transport.push({ jsonrpc: "2.0", id: 5, method: "prompts/list" });
    await settle();

    expect(reply(transport, 5)?.error?.code).toBe(-32601);
    transport.countdown();
    await done;
  });

  test("ignores notifications", async () => {
    const { transport, done } = start(decisionServer());
    transport.push({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();

    expect(transport.written).toHaveLength(0);
    transport.countdown();
    await done;
  });

  test("records the decision when persistence is on", async () => {
    const directory = await scratch();
    const { transport, done } = start(decisionServer("high"), directory);
    transport.push({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: TOOL_NAME,
        arguments: { prompt: "refactor the parser", agent: "build" },
      },
    });
    await settle();
    transport.countdown();
    await done;

    const entries = readTelemetry(
      join(directory, "dynamic-effort", "telemetry.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.session).toBe("mcp");
    expect(entries[0]!.agent).toBe("build");
    expect(entries[0]!.source).toBe("mcp");
  });
});
