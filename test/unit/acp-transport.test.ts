import { describe, expect, test } from "bun:test";
import { StreamTransport } from "../../src/acp/transport.ts";
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
