// One resident jevos server per installation.
//
// The model load costs a second or two and about 1 GB of memory, so the
// server starts on the first decision and stops after `idleMs` without one.
// A second process that finds a healthy server on the port attaches to it
// instead of spawning another.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import { NULL_LOGGER } from "../log.ts";
import { cacheRoot, jevLogPath } from "../paths.ts";
import type { JevInstall } from "./manager.ts";

export const FIRST_PORT = 8017;
export const LAST_PORT = 8099;

const FAILURE_COOLDOWN_MS = 60_000;
const IDLE_CHECK_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_STOP_GRACE_MS = 5_000;

export interface SupervisorOptions {
  /** Resolves the install, downloading on first use. */
  readonly install: () => Promise<JevInstall>;
  /** 0 asks for the first free port from 8017. */
  readonly port: number;
  readonly threads: number | null;
  readonly logger?: Logger;
  readonly logPath?: string;
  readonly root?: string;
  readonly idleMs: number;
  readonly startupTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

/** What `GET /health` reports for a ready server. */
export interface HealthReport {
  readonly status: string;
  readonly model?: string;
  readonly model_files?: Record<string, string>;
  readonly engine?: { readonly device?: string };
}

/** Probes a port for a ready jevos server. */
export async function probeHealth(
  port: number,
  timeoutMs: number,
): Promise<HealthReport | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthReport;
    if (body.status !== "ready") return null;
    if (!body.model_files || typeof body.model_files !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

/** True when the loopback port can be bound. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function freePort(taken: number | null): Promise<number | null> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
    if (port === taken) continue;
    if (await portFree(port)) return port;
  }
  return null;
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
  probeTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeHealth(port, probeTimeoutMs)) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export class JevServer {
  private base: string | null = null;
  private child: ChildProcess | null = null;
  private pending: Promise<string | null> | null = null;
  private failedAt = 0;
  private lastUse = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;
  private readonly logPath: string;
  private readonly root: string;

  constructor(private readonly options: SupervisorOptions) {
    this.logger = options.logger ?? NULL_LOGGER;
    this.root = options.root ?? cacheRoot();
    this.logPath = options.logPath ?? jevLogPath(this.root);
  }

  /** The base URL of a running server, or null. Never starts one. */
  get url(): string | null {
    return this.base;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The base URL, starting the server when needed; null when unavailable. */
  async ensure(): Promise<string | null> {
    if (this.base !== null) {
      this.lastUse = Date.now();
      return this.base;
    }
    if (this.pending !== null) return this.pending;
    if (Date.now() - this.failedAt < FAILURE_COOLDOWN_MS) return null;

    this.pending = this.start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Records use so the idle timer does not stop a server mid-session. */
  touch(): void {
    this.lastUse = Date.now();
  }

  /** Forgets a server that stopped answering; the cooldown prevents loops. */
  async invalidate(): Promise<void> {
    this.failedAt = Date.now();
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.base = null;
    if (child === null) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, this.options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async start(): Promise<string | null> {
    const requested = this.options.port > 0 ? this.options.port : null;

    // Another instance may already serve the port; attach rather than spawn.
    if (
      requested !== null &&
      (await probeHealth(requested, this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS))
    ) {
      this.logger.debug("attaching to a running jevos server", { port: requested });
      return this.attach(requested);
    }

    let install: JevInstall;
    try {
      install = await this.options.install();
    } catch (error) {
      this.failedAt = Date.now();
      this.logger.warn("jevos is not installed; leaving model defaults", error);
      return null;
    }

    // A configured port may belong to another program; scan for a free one.
    const port =
      requested !== null && (await portFree(requested))
        ? requested
        : await freePort(requested);
    if (port === null) {
      this.failedAt = Date.now();
      this.logger.warn("no free port for the jevos server");
      return null;
    }

    mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 });
    const log = openSync(this.logPath, "a", 0o600);
    // One prompt is the whole state, so the default 8192-token context and
    // the state cache only cost memory here.
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--model-dir",
      install.modelDir,
      "--ctx",
      "1024",
      "--state-cache",
      "0",
    ];
    const threads = this.options.threads;
    if (threads !== null && threads > 0) args.push("--threads", String(threads));

    let child: ChildProcess;
    try {
      child = spawn(install.binary, args, {
        cwd: install.root,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(log);
      this.failedAt = Date.now();
      this.logger.warn("could not start the jevos server", error);
      return null;
    } finally {
      closeSync(log);
    }
    this.child = child;

    const ready = await waitForHealth(
      port,
      this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );
    if (!ready) {
      this.failedAt = Date.now();
      this.logger.warn("the jevos server did not answer", `see ${this.logPath}`);
      await this.stop();
      return null;
    }

    this.logger.info("the jevos server is ready", { port });
    return this.attach(port);
  }

  private attach(port: number): string {
    this.base = `http://127.0.0.1:${port}`;
    this.lastUse = Date.now();
    if (this.timer === null) {
      this.timer = setInterval(() => this.expire(), IDLE_CHECK_MS);
      this.timer.unref?.();
    }
    return this.base;
  }

  private expire(): void {
    if (this.base === null) return;
    if (Date.now() - this.lastUse < this.options.idleMs) return;
    this.logger.info("stopping the idle jevos server");
    void this.stop();
  }
}
