import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JevInstaller, flatten, hashFile } from "../../src/core/jev/manager.ts";
import { releaseTarget } from "../../src/core/jev/release.ts";
import { createStoredZip } from "../helpers/zip.ts";

const VERSION = "jevos-v5";
const BINARY_ASSET = "jev-linux-x64.tar.gz";
const MODEL_ASSET = `${VERSION}-openvino-int8.zip`;
const MODEL_FILES = [
  "model.json",
  "openvino_model.xml",
  "openvino_model.bin",
  "tokenizer.gguf",
];

/** A stand-in binary: prints the usage line and exits 2, like jev does. */
const BINARY_SCRIPT = "#!/bin/sh\necho 'usage: jev serve [options]' >&2\nexit 2\n";

const root = join(tmpdir(), `dynamic-effort-install-${process.pid}`);
const fixtures = join(root, "fixtures");
let server: Server;
let base = "";

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sh(command: string, cwd: string): Promise<void> {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${command}: ${result.stderr.toString()}`);
  }
}

beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(fixtures, { recursive: true });

  // Binary archive: jev/jev at the root, as the real release ships it.
  const binaryStage = join(fixtures, "binary-stage");
  await mkdir(join(binaryStage, "jev"), { recursive: true });
  await writeFile(join(binaryStage, "jev", "jev"), BINARY_SCRIPT, { mode: 0o755 });
  await sh(`tar -czf ${join(fixtures, BINARY_ASSET)} -C ${binaryStage} jev`, fixtures);

  // Model archive: model/ at the root, stored (not deflated) by design.
  await writeFile(
    join(fixtures, MODEL_ASSET),
    createStoredZip(
      MODEL_FILES.map((name) => ({
        name: `model/${name}`,
        data: Buffer.from(`fixture ${name}`),
      })),
    ),
  );

  const sums = [
    `${await sha256(join(fixtures, BINARY_ASSET))} *${BINARY_ASSET}`,
    `${await sha256(join(fixtures, MODEL_ASSET))} *${MODEL_ASSET}`,
  ].join("\n");
  await writeFile(join(fixtures, "SHA256SUMS.txt"), `${sums}\n`);

  server = createServer(async (request, response) => {
    const name = (request.url ?? "").split("/").pop() ?? "";
    const path = join(fixtures, name);
    try {
      const body = await readFile(path);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function installer(overrides: Record<string, unknown> = {}) {
  return new JevInstaller({
    root: join(root, "cache"),
    target: releaseTarget("linux", "x64")!,
    releaseBase: base,
    downloadTimeoutMs: 10_000,
    commandTimeoutMs: 20_000,
    ...overrides,
  });
}

describe("JevInstaller", () => {
  test("inspect reports null for a missing install", async () => {
    expect(await installer().inspect()).toBeNull();
  });

  test("find reports null when nothing is installed", async () => {
    expect(await installer().find()).toBeNull();
  });

  test("ensure downloads, verifies, and extracts", async () => {
    const install = await installer().ensure();

    expect(install.root).toBe(join(root, "cache", "jev", `${VERSION}-linux-x64`));
    expect(install.target).toBe("linux-x64");
    expect(await hashFile(install.binary)).toBe(
      createHash("sha256").update(BINARY_SCRIPT).digest("hex"),
    );
    for (const name of MODEL_FILES) {
      expect(await readFile(join(install.modelDir, name), "utf8")).toBe(
        `fixture ${name}`,
      );
    }
    const manifest = JSON.parse(
      await readFile(join(install.root, "installed.json"), "utf8"),
    );
    expect(manifest.version).toBe(VERSION);
    expect(manifest.target).toBe("linux-x64");
  });

  test("ensure is idempotent and leaves the lock released", async () => {
    const first = await installer().ensure();
    const second = await installer().ensure();
    expect(second.root).toBe(first.root);
    expect(await installer().inspect(join(root, "cache", ".install.lock"))).toBeNull();
  });

  test("find reuses an install without touching the network", async () => {
    const broken = installer({ releaseBase: "http://127.0.0.1:1" });
    const install = await broken.find();
    expect(install).not.toBeNull();
  });

  test("find reuses a configured path", async () => {
    const existing = await installer().find();
    const reused = await installer({ path: existing!.root }).find();
    expect(reused?.root).toBe(existing!.root);
  });

  test("find reuses a directory from another install", async () => {
    const existing = await installer().find();
    const other = installer({ reuseDirs: [existing!.root] });
    const found = await other.find();
    expect(found?.root).toBe(existing!.root);
  });

  test("find looks inside a shared cache by version and target", async () => {
    const existing = await installer().find();
    const shared = join(root, "shared-cache");
    await mkdir(join(shared, `${VERSION}-linux-x64`), { recursive: true });
    await sh(
      `cp -r ${existing!.root}/. ${join(shared, `${VERSION}-linux-x64`)}`,
      root,
    );
    const found = await installer({
      root: join(root, "cache-shared"),
      reuseDirs: [shared],
    }).find();
    expect(found?.root).toBe(join(shared, `${VERSION}-linux-x64`));
  });

  test("a configured path without an install fails instead of downloading", async () => {
    const missing = join(root, "empty");
    await mkdir(missing, { recursive: true });
    await expect(installer({ path: missing }).ensure()).rejects.toThrow(
      /does not hold a jevos install/,
    );
  });

  test("a checksum mismatch is rejected and leaves no install", async () => {
    const tampered = join(root, "tampered");
    await mkdir(tampered, { recursive: true });
    await writeFile(
      join(tampered, "SHA256SUMS.txt"),
      `${"0".repeat(64)} *${BINARY_ASSET}\n${"0".repeat(64)} *${MODEL_ASSET}\n`,
    );
    const broken = new JevInstaller({
      root: join(root, "cache-tampered"),
      target: releaseTarget("linux", "x64")!,
      releaseBase: base,
      commandTimeoutMs: 20_000,
    });
    // Point the checksum fetch at the tampered list by swapping the base.
    const tamperedServer = createServer(async (request, response) => {
      const name = (request.url ?? "").split("/").pop() ?? "";
      const path = name === "SHA256SUMS.txt" ? join(tampered, name) : join(fixtures, name);
      response.end(await readFile(path));
    });
    await new Promise<void>((resolve) =>
      tamperedServer.listen(0, "127.0.0.1", resolve),
    );
    const address = tamperedServer.address() as { port: number };
    try {
      const evil = new JevInstaller({
        root: join(root, "cache-tampered"),
        target: releaseTarget("linux", "x64")!,
        releaseBase: `http://127.0.0.1:${address.port}`,
        commandTimeoutMs: 20_000,
      });
      await expect(evil.ensure()).rejects.toThrow(/checksum mismatch/);
      expect(await evil.inspect()).toBeNull();
      void broken;
    } finally {
      await new Promise<void>((resolve) => tamperedServer.close(() => resolve()));
    }
  });

  test("an empty checksum list fails closed", async () => {
    const emptyServer = createServer((_request, response) => response.end(""));
    await new Promise<void>((resolve) =>
      emptyServer.listen(0, "127.0.0.1", resolve),
    );
    const address = emptyServer.address() as { port: number };
    try {
      const evil = new JevInstaller({
        root: join(root, "cache-empty"),
        target: releaseTarget("linux", "x64")!,
        releaseBase: `http://127.0.0.1:${address.port}`,
      });
      await expect(evil.ensure()).rejects.toThrow(/checksum list is empty/);
    } finally {
      await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
    }
  });

  test("a missing asset in the checksum list fails closed", async () => {
    const partialServer = createServer(async (request, response) => {
      const name = (request.url ?? "").split("/").pop() ?? "";
      if (name === "SHA256SUMS.txt") {
        response.end(`${"0".repeat(64)} *something-else.tar.gz\n`);
        return;
      }
      response.end(await readFile(join(fixtures, name)));
    });
    await new Promise<void>((resolve) =>
      partialServer.listen(0, "127.0.0.1", resolve),
    );
    const address = partialServer.address() as { port: number };
    try {
      const evil = new JevInstaller({
        root: join(root, "cache-partial"),
        target: releaseTarget("linux", "x64")!,
        releaseBase: `http://127.0.0.1:${address.port}`,
      });
      await expect(evil.ensure()).rejects.toThrow(/no checksum for/);
    } finally {
      await new Promise<void>((resolve) => partialServer.close(() => resolve()));
    }
  });
});

describe("flatten", () => {
  test("moves a nested folder's contents up one level", async () => {
    const directory = join(root, "flatten");
    await mkdir(join(directory, "jev"), { recursive: true });
    await writeFile(join(directory, "jev", "jev"), "binary");
    await flatten(directory, "jev", {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    expect(await readFile(join(directory, "jev"), "utf8")).toBe("binary");
  });

  test("does nothing when the entry is not a directory", async () => {
    const directory = join(root, "flatten-file");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "jev"), "already flat");
    await flatten(directory, "jev", {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    expect(await readFile(join(directory, "jev"), "utf8")).toBe("already flat");
  });
});
