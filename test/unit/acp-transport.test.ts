import { describe, expect, test } from "bun:test";
import {
  StreamTransport,
  spawnTransport,
} from "../../src/acp/transport.ts";
import type { RpcMessage } from "../../src/acp/jsonrpc.ts";

/** A readable that yields the given chunks, then ends. */
async function* chunks(...parts: string[]) {
  for (const part of parts) yield part;
}

/** A readable that never ends until released. */
function held() {
  let release: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = (async function* () {
    await done;
  })();
  return { stream: source, release: () => release?.() };
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("StreamTransport", () => {
  test("delivers whole messages split across chunks", async () => {
    const received: RpcMessage[] = [];
    const transport = new StreamTransport(
      () => {},
      chunks(
        '{"jsonrpc":"2.0","id":1,"meth',
        'od":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n',
      ),
    );
    transport.onMessage((message) => received.push(message));
    await settle();

    expect(received.map((message) => (message as { id: number }).id)).toEqual([
      1, 2,
    ]);
  });

  test("ignores blank and malformed lines", async () => {
    const received: RpcMessage[] = [];
    const transport = new StreamTransport(
      () => {},
      chunks('\n  \nnot json\n{"jsonrpc":"2.0","id":1,"method":"a"}\n'),
    );
    transport.onMessage((message) => received.push(message));
    await settle();

    expect(received.length).toBe(1);
  });

  test("writes encoded messages", () => {
    let written = "";
    const transport = new StreamTransport(
      (line) => {
        written += line;
      },
      held().stream,
    );
    transport.write({ jsonrpc: "2.0", id: 1, method: "a" });

    expect(written).toBe('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
  });

  test("reports a close when the stream ends", async () => {
    let closed = false;
    const transport = new StreamTransport(() => {}, chunks());
    transport.onClose(() => {
      closed = true;
    });
    await settle();

    expect(closed).toBe(true);
  });

  test("stops writing after close", () => {
    let written = "";
    const transport = new StreamTransport(
      (line) => {
        written += line;
      },
      held().stream,
    );
    transport.close();
    transport.write({ jsonrpc: "2.0", id: 1, method: "a" });

    expect(written).toBe("");
  });

  test("reports a read error as a close", async () => {
    const failure = (async function* () {
      yield '{"jsonrpc":"2.0","id":1,"method":"a"}\n';
      throw new Error("broken pipe");
    })();
    const seen: RpcMessage[] = [];
    let error: Error | undefined;
    const transport = new StreamTransport(() => {}, failure);
    transport.onMessage((message) => seen.push(message));
    transport.onClose((cause) => {
      error = cause;
    });
    await settle();

    expect(seen.length).toBe(1);
    expect(error?.message).toBe("broken pipe");
  });
});

// Answers every request on stdin with one reply on stdout, so the pipes are
// exercised for real on each platform rather than simulated.
const ECHO_SCRIPT = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    const reply = { jsonrpc: "2.0", id: request.id, result: { method: request.method } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
    index = buffer.indexOf("\\n");
  }
});
`;

async function until(check: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the child did not answer in time");
}

describe("spawnTransport", () => {
  test("carries messages through a real child process", async () => {
    const transport = spawnTransport({
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
    });
    const received: RpcMessage[] = [];
    transport.onMessage((message) => received.push(message));

    transport.write({ jsonrpc: "2.0", id: 7, method: "ping" });
    await until(() => received.length === 1);

    expect(received[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { method: "ping" },
    });
    transport.close();
  });

  test("reports a close when the child exits", async () => {
    const transport = spawnTransport({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    await until(() => closed);
  });

  test("closes instead of crashing when the command does not exist", async () => {
    const transport = spawnTransport({
      command: "dynamic-effort-no-such-command",
    });
    let error: Error | undefined;
    transport.onClose((cause) => {
      error = cause;
    });
    await until(() => error !== undefined);

    expect(error?.message).toContain("dynamic-effort-no-such-command");
  });
});
