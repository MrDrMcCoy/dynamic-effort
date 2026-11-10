// Newline-delimited JSON transports. ACP reserves stdout for protocol
// traffic, so every diagnostic goes to stderr or the log file.

import { spawn, type ChildProcess } from "node:child_process";
import { encodeMessage, parseLine, type RpcMessage } from "./jsonrpc.ts";

export interface Transport {
  write(message: RpcMessage): void;
  onMessage(handler: (message: RpcMessage) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

/** Feeds complete lines from a byte stream into a line handler. */
class LineReader {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }
}

/**
 * A transport over one readable and one writable stream. The writer is a
 * callback so tests can capture messages without a real pipe.
 */
export class StreamTransport implements Transport {
  private readonly reader: LineReader;
  private handler: ((message: RpcMessage) => void) | null = null;
  private closed = false;
  private writeClosed = false;
  private closeHandler: ((error?: Error) => void) | null = null;

  constructor(
    private readonly writeLine: (line: string) => void,
    readable: AsyncIterable<Uint8Array | string>,
    private readonly closeStream: () => void = () => {},
  ) {
    this.reader = new LineReader((line) => {
      const message = parseLine(line);
      if (message) this.handler?.(message);
    });
    void this.pump(readable);
  }

  private async pump(readable: AsyncIterable<Uint8Array | string>) {
    try {
      for await (const chunk of readable) this.reader.push(chunk);
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.finish();
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(error);
  }

  write(message: RpcMessage): void {
    // Input can end before a reply is ready; keep writing until close().
    if (this.writeClosed) return;
    this.writeLine(encodeMessage(message));
  }

  /** Closes the transport from the outside, for a pipe that failed. */
  fail(error?: Error): void {
    if (this.closed) return;
    this.writeClosed = true;
    this.finish(error);
  }

  onMessage(handler: (message: RpcMessage) => void): void {
    this.handler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.writeClosed) return;
    this.writeClosed = true;
    this.closed = true;
    this.closeStream();
  }
}

/** The process's own stdin and stdout. */
export function stdioTransport(): Transport {
  const stdin = process.stdin as unknown as AsyncIterable<Uint8Array>;
  return new StreamTransport(
    (line) => {
      process.stdout.write(line);
    },
    stdin,
    () => {
      process.stdin.pause();
    },
  );
}

export interface SpawnOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A child process that speaks ACP on its stdin and stdout. */
export function spawnTransport(options: SpawnOptions): Transport {
  const child: ChildProcess = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    throw new Error(`could not start ${options.command}`);
  }
  const transport = new StreamTransport(
    (line) => {
      stdin.write(line);
    },
    stdout as unknown as AsyncIterable<Uint8Array>,
    () => {
      stdin.end();
      child.kill("SIGTERM");
    },
  );
  // A command that is missing or not executable emits "error" and never
  // writes anything, so without this the proxy would wait forever.
  child.on("error", (error) => transport.fail(error));
  return transport;
}
