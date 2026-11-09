// A transport that records what the proxy writes and lets a test inject
// messages in either direction.

import type { Transport } from "../../src/acp/transport.ts";
import type { RpcMessage } from "../../src/acp/jsonrpc.ts";

export class FakeTransport implements Transport {
  readonly written: RpcMessage[] = [];
  private handler: ((message: RpcMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  closed = false;

  write(message: RpcMessage): void {
    this.written.push(message);
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.handler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers a message as if it came from the other side. */
  push(message: RpcMessage): void {
    this.handler?.(message);
  }

  countdown(): void {
    this.closeHandler?.();
  }

  /** The last message written, or undefined. */
  last(): RpcMessage | undefined {
    return this.written[this.written.length - 1];
  }

  /** Every written message with the given method. */
  requests(method: string) {
    return this.written.filter(
      (message) =>
        (message as { method?: string }).method === method,
    ) as { id: string | number; method: string; params: unknown }[];
  }
}

/** Yields to the event loop so queued async work can finish. */
export async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
