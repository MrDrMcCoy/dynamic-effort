// Runs the whole proxy in a real process against a fake ACP agent, reading
// and writing NDJSON on stdio the way an editor would.
//
// The decision server is a local stub, so the test does not need jevos.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const AGENT = join(ROOT, "test", "fixtures", "fake-acp-agent.ts");

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class Peer {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: Message) => void>();
  readonly updates: Record<string, unknown>[] = [];

  constructor(
    private readonly child: Bun.Subprocess<"pipe", "pipe", "inherit">,
  ) {
    void this.read();
  }

  private async read() {
    const stdout = this.child.stdout as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    for await (const chunk of stdout) {
      this.buffer += decoder.decode(chunk);
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Message;
        if (message.method === "session/update") {
          this.updates.push(message.params ?? {});
          continue;
        }
        if (message.id !== undefined && message.method === undefined) {
          const resolve = this.pending.get(message.id as number);
          this.pending.delete(message.id as number);
          resolve?.(message);
        }
      }
    }
  }

  async request(method: string, params: unknown): Promise<Message> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.child.stdin.write(`${body}\n`);
    await this.child.stdin.flush();
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  write(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/** A decision stub that always answers `effort`. */
function startStub(effort: string) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        questions: Record<string, unknown>;
      };
      expect(body.questions["reasoning_effort"]).toBeDefined();
      return Response.json({
        answers: {
          reasoning_effort: { type: "choice", choice: effort, confidence: 0.9 },
          high_stakes: { type: "noul", noul: 0.05 },
        },
      });
    },
  });
}

let stub: ReturnType<typeof Bun.serve>;
let proxy: Bun.Subprocess<"pipe", "pipe", "inherit">;
let peer: Peer;

beforeAll(() => {
  stub = startStub("xhigh");
  proxy = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), "acp", "--",
    "bun", "run", AGENT], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      DYNAMIC_EFFORT_ENDPOINT: `http://127.0.0.1:${stub.port}/v1/systemone`,
    },
  });
  peer = new Peer(proxy);
});

afterAll(() => {
  proxy?.kill();
  stub?.stop(true);
});

describe("acp proxy", () => {
  test("forwards initialize", async () => {
    const response = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect((response.result?.["agentInfo"] as { name: string }).name).toBe(
      "fake",
    );
  });

  test("sets the decided effort before the prompt", async () => {
    const created = await peer.request("session/new", {
      cwd: ROOT,
      mcpServers: [],
    });
    const sessionId = created.result?.["sessionId"] as string;
    expect(sessionId).toBe("ses_fake");

    const response = await peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "refactor the parser" }],
    });
    expect(response.result?.["stopReason"]).toBe("end_turn");

    const report = await peer.request("session/report", {});
    expect(report.result?.["effort"]).toBe("max");
    expect(report.result?.["changes"]).toEqual(["max"]);
  });

  test("reuses the effort when nothing changed", async () => {
    const response = await peer.request("session/prompt", {
      sessionId: "ses_fake",
      prompt: [{ type: "text", text: "refactor the parser" }],
    });
    expect(response.result?.["stopReason"]).toBe("end_turn");

    const report = await peer.request("session/report", {});
    // The prompt hash matches, so no second config change is sent.
    expect(report.result?.["changes"]).toEqual(["max"]);
  });

  test("forces the maximum on a keyword", async () => {
    await peer.request("session/prompt", {
      sessionId: "ses_fake",
      prompt: [{ type: "text", text: "ultrathink about this diff" }],
    });
    const report = await peer.request("session/report", {});
    expect(report.result?.["effort"]).toBe("max");
  });
});
