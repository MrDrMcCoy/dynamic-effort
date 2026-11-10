// One resident jevos server per installation.
//
// The model load costs a second or two and about 1 GB of memory, so the
// server starts on the first decision and stops after `idleMs` without one.
// A second process that finds a healthy server on the port attaches to it
// instead of spawning another.

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
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
/** A claim older than this belongs to a process that died while loading. */
const CLAIM_STALE_MS = 300_000;

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
  /** How often the idle timer checks; 30 s unless a test says otherwise. */
  readonly idleCheckMs?: number;
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

/** Why a startup wait ended. */
type StartupResult = "ready" | "exited" | "timeout";

/** A held claim on a port; releasing it lets another process try. */
interface PortClaim {
  release(): void;
}

// Two processes that both see a free port would both spawn a server, and the
// loser only finds out after loading the model. A claim file makes the second
// process wait for the first one's server instead of racing it.
//
// Returns null only when another live process holds the claim. Any other
// failure (a missing root, a read-only cache) starts the server unserialised
// rather than waiting for a rival that will never appear.
function claimPort(
  root: string,
  port: number,
  logger: Logger,
): PortClaim | null {
  const path = join(root, `jev-${port}.claim`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      logger.debug("could not claim the jevos port", error);
      return { release: () => {} };
    }
    // A claim left by a process that died while loading must not block.
    if (!claimIsStale(path)) return null;
    try {
      unlinkSync(path);
    } catch {
      return { release: () => {} };
    }
    return claimPort(root, port, logger);
  }
  return {
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // Already gone; nothing to release.
      }
    },
  };
}

/** True when the claim names a dead process or outlives the model load. */
function claimIsStale(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > CLAIM_STALE_MS) return true;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      // Signal 0 checks for the process without touching it.
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
  probeTimeoutMs: number,
  child: ChildProcess | null = null,
): Promise<StartupResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check the child before the port: once it has exited it will never bind,
    // and a healthy port then belongs to somebody else.
    if (child !== null && child.exitCode !== null) return "exited";
    if ((await probeHealth(port, probeTimeoutMs)) !== null) return "ready";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "timeout";
}

export class JevServer {
  private base: string | null = null;
  private child: ChildProcess | null = null;
  private attached = false;
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

  /** True when the server is one this process started. */
  get owns(): boolean {
    return this.child !== null && !this.attached;
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
    this.attached = false;
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
      (await probeHealth(
        requested,
        this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ))
    ) {
      this.logger.debug("attaching to a running jevos server", {
        port: requested,
      });
      return this.attach(requested);
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

    // Another process may be loading a server for this port right now. Wait
    // for it rather than spawn a second model into memory.
    const claim = claimPort(this.root, port, this.logger);
    if (claim === null) {
      this.logger.debug("another process holds the port claim", { port });
      const url = await this.waitForRival(port);
      if (url !== null) return url;
      this.failedAt = Date.now();
      this.logger.warn("another process holds the jevos port", { port });
      return null;
    }

    let install: JevInstall;
    try {
      install = await this.options.install();
    } catch (error) {
      claim.release();
      this.failedAt = Date.now();
      this.logger.warn("jevos is not installed; leaving model defaults", error);
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
    if (threads !== null && threads > 0) {
      args.push("--threads", String(threads));
    }

    let child: ChildProcess;
    try {
      child = spawn(install.binary, args, {
        cwd: install.root,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(log);
      claim.release();
      this.failedAt = Date.now();
      this.logger.warn("could not start the jevos server", error);
      return null;
    } finally {
      closeSync(log);
    }
    this.child = child;

    const outcome = await waitForHealth(
      port,
      this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      child,
    );
    claim.release();
    if (outcome !== "ready") {
      // A concurrent start can win the port after our free-port check. The
      // loser exits at once, so a healthy server here is somebody else's.
      const probeTimeout =
        this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      if ((await probeHealth(port, probeTimeout)) !== null) {
        this.child = null;
        this.logger.debug("attaching to the server that won the port", {
          port,
        });
        return this.attach(port);
      }
      this.failedAt = Date.now();
      this.logger.warn(
        "the jevos server did not answer",
        `see ${this.logPath}`,
      );
      await this.stop();
      return null;
    }

    // Health can turn ready because a rival start won the port, not because
    // our child is serving. attach() settles ownership, so log from that.
    const url = this.attach(port);
    if (this.attached) {
      this.logger.debug("attaching to the server that won the port", { port });
    } else {
      this.logger.info("the jevos server is ready", { port });
    }
    return url;
  }

  /** Waits for a server another process is starting on `port`. */
  private async waitForRival(port: number): Promise<string | null> {
    const deadline =
      Date.now() +
      (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const probeTimeout =
      this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await probeHealth(port, probeTimeout)) !== null) {
        this.logger.debug("attaching to the server another process started", {
          port,
        });
        return this.attach(port);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  private attach(port: number): string {
    this.base = `http://127.0.0.1:${port}`;
    // A child that already exited cannot be serving: whatever answers on the
    // port belongs to another process, and only a server this process started
    // stops with it.
    if (
      this.child !== null &&
      (this.child.exitCode !== null || this.child.signalCode !== null)
    ) {
      this.child = null;
    }
    this.attached = this.child === null;
    this.lastUse = Date.now();
    if (this.timer === null) {
      this.timer = setInterval(
        () => this.expire(),
        this.options.idleCheckMs ?? IDLE_CHECK_MS,
      );
      this.timer.unref?.();
    }
    return this.base;
  }

  private expire(): void {
    if (this.base === null) return;
    if (Date.now() - this.lastUse < this.options.idleMs) return;
    if (this.attached) {
      // Someone else's server: drop the reference, leave the process alone.
      this.logger.debug("forgetting the idle jevos server");
      this.base = null;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.logger.info("stopping the idle jevos server");
    void this.stop();
  }
}
