// Drives the proxy with the official ACP client, the way an editor does:
// the SDK validates every message shape, so this catches protocol drift that
// a hand-rolled peer would accept.
//
// The agent is the fake fixture and the decision server is a local stub, so
// the test needs neither jevos nor a real editor.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  client as createClient,
  ndJsonStream,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

const ROOT = join(import.meta.dir, "..", "..");
const AGENT = join(ROOT, "test", "fixtures", "fake-acp-agent.ts");

/** Wraps a child's stdio as the ACP stream pair. */
function streamOf(
  child: Bun.Subprocess<"pipe", "pipe", "inherit">,
): ReturnType<typeof ndJsonStream> {
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      child.stdin.write(chunk);
    },
    close() {
      void child.stdin.end();
    },
  });
  return ndJsonStream(
    input,
    child.stdout as unknown as ReadableStream<Uint8Array>,
  );
}

/** A decision stub that always answers `xhigh`. */
function startStub() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        questions: Record<string, unknown>;
      };
      expect(body.questions["reasoning_effort"]).toBeDefined();
      return Response.json({
        answers: {
          reasoning_effort: {
            type: "choice",
            choice: "xhigh",
            confidence: 0.9,
          },
          high_stakes: { type: "noul", noul: 0.05 },
        },
      });
    },
  });
}

let stub: ReturnType<typeof Bun.serve>;
let proxy: Bun.Subprocess<"pipe", "pipe", "inherit">;
let connection: ClientConnection;
let sessionId: string;

beforeAll(async () => {
  stub = startStub();
  proxy = Bun.spawn(
    [
      "bun",
      "run",
      join(ROOT, "src", "cli.ts"),
      "acp",
      "--",
      "bun",
      "run",
      AGENT,
    ],
    {
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: {
        ...process.env,
        DYNAMIC_EFFORT_ENDPOINT:
          `http://127.0.0.1:${stub.port}/v1/systemone`,
      },
    },
  );
  connection = createClient({ name: "test-editor" }).connect(streamOf(proxy));
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const created = await connection.agent.request("session/new", {
    cwd: ROOT,
    mcpServers: [],
  });
  sessionId = created.sessionId;
});

afterAll(() => {
  connection?.close();
  proxy?.kill();
  stub?.stop(true);
});

describe("acp client", () => {
  test("creates a session through the proxy", () => {
    expect(sessionId).toBe("ses_fake");
  });

  test("applies the decided effort before the prompt", async () => {
    const response = await connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "refactor the parser" }],
    });
    expect(response.stopReason).toBe("end_turn");

    const report = await connection.agent.request<{
      effort: string;
      changes: string[];
    }>("session/report", {});
    expect(report.effort).toBe("max");
    expect(report.changes).toEqual(["max"]);
  });

  test("does not resend the same effort for an identical prompt", async () => {
    await connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "refactor the parser" }],
    });

    const report = await connection.agent.request<{
      changes: string[];
    }>("session/report", {});
    expect(report.changes).toEqual(["max"]);
  });

  test("routes updates to an active session", async () => {
    // The SDK queues session/update notifications on an ActiveSession, which
    // is how an editor collects thought chunks and message chunks.
    const active = await connection.agent
      .buildSession({ cwd: ROOT, mcpServers: [] })
      .start();
    try {
      const kinds: string[] = [];
      const done = active.prompt("ultrathink about this diff");
      for (;;) {
        const message = await active.nextUpdate();
        if (message.kind === "stop") break;
        kinds.push(message.update.sessionUpdate);
      }
      await done;
      expect(kinds).toContain("agent_message_chunk");
    } finally {
      active.dispose();
    }
  });
});
