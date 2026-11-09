// Downloads and installs the jevos decision model and binary.
//
// The model is ~630 MB, so install is a deliberate one-time cost: first use
// or an explicit `setup`. Both assets are checked against the release
// SHA256SUMS.txt before anything executes; a missing list fails closed.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import type { Logger } from "../log.ts";
import { NULL_LOGGER } from "../log.ts";
import { cacheRoot, jevInstallDir } from "../paths.ts";
import {
  assetUrl,
  binaryAsset,
  DEFAULT_VERSION,
  MODEL_FILES,
  modelAsset,
  parseSums,
  RELEASE_BASE,
  SUMS_ASSET,
  type ReleaseTarget,
} from "./release.ts";

export interface JevInstall {
  /** Directory holding `bin/` and `model/`. */
  readonly root: string;
  readonly binary: string;
  readonly modelDir: string;
  readonly version: string;
  readonly target: string;
}

export interface InstallOptions {
  readonly root?: string;
  readonly version?: string;
  readonly target: ReleaseTarget;
  readonly logger?: Logger;
  /** A pre-installed directory: skip download and detection entirely. */
  readonly path?: string | null;
  /** Extra directories to reuse when they already hold an install. */
  readonly reuseDirs?: readonly string[];
  readonly downloadTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Overrides the release base URL; tests serve fixtures on loopback. */
  readonly releaseBase?: string;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const INSTALLED = "installed.json";
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
const BINARY_NAME = "jev";

export class JevInstaller {
  private readonly root: string;
  private readonly version: string;
  private readonly target: ReleaseTarget;
  private readonly logger: Logger;
  private readonly pathOverride: string | null;
  private readonly reuseDirs: readonly string[];
  private readonly downloadTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly releaseBase: string;

  constructor(options: InstallOptions) {
    this.root = options.root ?? cacheRoot();
    this.version = options.version ?? DEFAULT_VERSION;
    this.target = options.target;
    this.logger = options.logger ?? NULL_LOGGER;
    this.pathOverride = options.path ?? null;
    this.reuseDirs = options.reuseDirs ?? [];
    this.downloadTimeoutMs =
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.releaseBase = options.releaseBase ?? RELEASE_BASE;
  }

  get directory(): string {
    if (this.pathOverride !== null) return this.pathOverride;
    return jevInstallDir(this.version, this.target.name, this.root);
  }

  /** An installed copy, or null when anything is missing. */
  async inspect(dir: string = this.directory): Promise<JevInstall | null> {
    const binary = join(
      dir,
      "bin",
      process.platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME,
    );
    const modelDir = join(dir, "model");
    if (!(await isFile(binary))) return null;
    for (const name of MODEL_FILES) {
      if (!(await isFile(join(modelDir, name)))) return null;
    }
    return {
      root: dir,
      binary,
      modelDir,
      version: this.version,
      target: this.target.name,
    };
  }

  /**
   * An existing install: the configured path, our own directory, or one of
   * the reuse directories (another plugin's cache). Never downloads.
   */
  async find(): Promise<JevInstall | null> {
    const candidates = [
      ...(this.pathOverride !== null ? [this.pathOverride] : []),
      this.directory,
      // A shared cache holds one directory per version and target.
      ...this.reuseDirs.map((dir) =>
        join(dir, `${this.version}-${this.target.name}`),
      ),
      ...this.reuseDirs,
    ];
    for (const candidate of candidates) {
      const install = await this.inspect(candidate);
      if (install !== null) return install;
    }
    return null;
  }

  /** Installs when needed. Safe to call concurrently in one process tree. */
  async ensure(): Promise<JevInstall> {
    const existing = await this.find();
    if (existing !== null) return existing;

    if (this.pathOverride !== null) {
      throw new Error(
        `${this.pathOverride} does not hold a jevos install ` +
          `(want bin/${BINARY_NAME} and model/)`,
      );
    }

    await this.withLock(async () => {
      if ((await this.inspect()) !== null) return;
      await this.install();
    });

    const installed = await this.inspect();
    if (installed === null) {
      throw new Error("the jevos install is incomplete after extraction");
    }
    return installed;
  }

  private async install(): Promise<void> {
    const final = this.directory;
    const staging = `${final}.partial-${process.pid}`;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      const sums = await this.fetchSums();
      const binaryName = binaryAsset(this.target);
      const modelName = modelAsset(this.version);

      this.logger.info("downloading the jevos binary", { asset: binaryName });
      const binaryPath = join(staging, binaryName);
      await this.download(binaryName, binaryPath, sums);

      this.logger.info("downloading the jevos model", {
        asset: modelName,
        note: "about 630 MB, one time",
      });
      const modelPath = join(staging, modelName);
      await this.download(modelName, modelPath, sums);

      const binDir = join(staging, "bin");
      await mkdir(binDir, { recursive: true, mode: 0o700 });
      await extract(
        binaryPath,
        binDir,
        this.target.archive,
        this.logger,
        this.commandTimeoutMs,
      );
      await flatten(binDir, BINARY_NAME, this.logger);
      const binary = join(
        binDir,
        process.platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME,
      );
      await chmod(binary, 0o755).catch(() => {});

      await extract(
        modelPath,
        staging,
        this.target.modelArchive,
        this.logger,
        this.commandTimeoutMs,
      );
      await this.probe(binary);

      await writeFile(
        join(staging, INSTALLED),
        `${JSON.stringify(
          {
            version: this.version,
            target: this.target.name,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ).catch(() => {});

      await rm(final, { recursive: true, force: true }).catch(() => {});
      await mkdir(join(final, ".."), { recursive: true, mode: 0o700 });
      await rename(staging, final);
      this.logger.info("jevos is installed", { directory: final });
    } catch (error) {
      // A partial tree must never look like an install later.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private url(asset: string): string {
    return assetUrl(this.version, asset, this.releaseBase);
  }

  private async fetchSums(): Promise<Map<string, string>> {
    const response = await fetch(this.url(SUMS_ASSET), {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`checksum list download failed: HTTP ${response.status}`);
    }
    const sums = parseSums(await response.text());
    if (sums.size === 0) throw new Error("the jevos checksum list is empty");
    return sums;
  }

  private async download(
    asset: string,
    destination: string,
    sums: Map<string, string>,
  ): Promise<void> {
    const expected = sums.get(asset);
    if (expected === undefined) {
      throw new Error(`no checksum for ${asset}; refusing to install`);
    }

    const response = await fetch(this.url(asset), {
      redirect: "follow",
      signal: AbortSignal.timeout(this.downloadTimeoutMs),
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed for ${asset}: HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { mode: 0o600 }),
    );

    const actual = await hashFile(destination);
    if (actual !== expected) {
      await rm(destination, { force: true }).catch(() => {});
      throw new Error(`checksum mismatch for ${asset} (want ${expected})`);
    }
  }

  /** The binary without arguments prints usage and exits 2. */
  private async probe(binary: string): Promise<void> {
    const result = await run(binary, [], this.commandTimeoutMs).catch(
      (error: unknown) => {
        throw new Error(`the jevos binary did not run: ${String(error)}`);
      },
    );
    if (result.code !== 2 || !result.stderr.includes("usage: jev")) {
      throw new Error(
        `the jevos binary did not report its usage ` +
          `(exit ${result.code}): ${result.stderr.slice(0, 200)}`,
      );
    }
  }

  private async withLock(body: () => Promise<void>): Promise<void> {
    const lock = join(this.root, ".install.lock");
    await mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => {});
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lock, { recursive: false, mode: 0o700 });
        break;
      } catch {
        const info = await stat(lock).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error("another jevos install is still running");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    try {
      await body();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Archives root the binary under a folder with the same name. */
export async function flatten(
  directory: string,
  name: string,
  logger: Logger,
): Promise<void> {
  const nested = join(directory, name);
  const isDir = await stat(nested).then((info) => info.isDirectory(), () => false);
  if (!isDir) return;

  // Move the folder aside first: its contents can collide with its name.
  const stash = `${nested}.extract`;
  await rename(nested, stash);
  for (const entry of await readdir(stash)) {
    await rename(join(stash, entry), join(directory, entry)).catch(
      (error: unknown) => logger.debug("could not move an extracted file", error),
    );
  }
  await rm(stash, { recursive: true, force: true }).catch(() => {});
}

async function extract(
  archive: string,
  destination: string,
  kind: string,
  logger: Logger,
  timeoutMs: number,
): Promise<void> {
  if (kind === "zip") {
    try {
      const result = await run("unzip", ["-q", "-o", archive, "-d", destination], timeoutMs);
      if (result.code === 0) return;
    } catch {
      // Fall through to tar, which handles zip as bsdtar on macOS and Windows.
    }
  }
  const result = await run("tar", ["-xf", archive, "-C", destination], timeoutMs).catch(
    (error: unknown) => {
      throw new Error(`could not extract ${archive}: ${String(error)}`);
    },
  );
  if (result.code !== 0) {
    logger.warn("archive extraction failed", result.stderr.slice(0, 200));
    throw new Error(`could not extract ${archive}`);
  }
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

/** Streams the file so a 630 MB model is never held in memory. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
