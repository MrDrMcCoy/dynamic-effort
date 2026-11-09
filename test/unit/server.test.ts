import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JevServer, portFree, probeHealth } from "../../src/core/jev/server.ts";
import type { JevInstall } from "../../src/core/jev/manager.ts";

const root = join(tmpdir(), `dynamic-effort-server-${process.pid}`);

const READY_BODY = {
  status: "ready",
  model: "jevos-v5",
  model_files: { "model.json": "abc" },
  engine: { device: "cpu" },
};

let ready: Server;
let readyPort = 0;
let warming: Server;
let warmingPort = 0;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  ready = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(READY_BODY));
  });
  readyPort = await listen(ready);

  warming = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "loading" }));
  });
  warmingPort = await listen(warming);
});

afterAll(async () => {
  await new Promise<void>((resolve) => ready.close(() => resolve()));
  await new Promise<void>((resolve) => warming.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function server(overrides: Record<string, unknown> = {}) {
  return new JevServer({
    install: async () => {
      throw new Error("install must not run in this test");
    },
    port: readyPort,
    threads: null,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    logPath: join(root, "jev.log"),
    root,
    idleMs: 60_000,
    startupTimeoutMs: 2_000,
    probeTimeoutMs: 300,
    stopGraceMs: 200,
    ...overrides,
  });
}

describe("probeHealth", () => {
  test("reports a ready server", async () => {
    const health = await probeHealth(readyPort, 500);
    expect(health?.status).toBe("ready");
    expect(health?.model).toBe("jevos-v5");
    expect(health?.engine?.device).toBe("cpu");
  });

  test("ignores a server that is still loading", async () => {
    expect(await probeHealth(warmingPort, 500)).toBeNull();
  });

  test("returns null when nothing listens", async () => {
    expect(await probeHealth(1, 200)).toBeNull();
  });
});

describe("portFree", () => {
  test("is false for a bound port", async () => {
    expect(await portFree(readyPort)).toBe(false);
  });

  test("is true for a free port", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await portFree(port)).toBe(true);
  });
});

describe("JevServer", () => {
  test("attaches to a healthy server instead of spawning", async () => {
    const instance = server();
    const url = await instance.ensure();
    expect(url).toBe(`http://127.0.0.1:${readyPort}`);
    expect(instance.pid).toBeNull();
    expect(instance.owns).toBe(false);
    await instance.stop();
    expect(instance.url).toBeNull();
  });

  test("forgets an attached server after the idle timeout", async () => {
    const instance = server({ idleMs: 0, idleCheckMs: 10 });
    await instance.ensure();
    expect(instance.owns).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // The reference is dropped, but the process we attached to keeps running.
    expect(instance.url).toBeNull();
    expect(instance.pid).toBeNull();
    expect(await probeHealth(readyPort, 500)).not.toBeNull();
  });

  test("returns null when the install fails", async () => {
    const instance = server({ port: 0 });
    expect(await instance.ensure()).toBeNull();
  });

  const posix = process.platform === "win32" ? test.skip : test;
  posix("returns null when the spawned server never becomes ready", async () => {
    const binary = join(root, "fake-jev");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const install: JevInstall = {
      root,
      binary,
      modelDir: join(root, "model"),
      version: "jevos-v5",
      target: "linux-x64",
    };
    const instance = server({
      port: 0,
      startupTimeoutMs: 700,
      probeTimeoutMs: 100,
      install: async () => install,
    });
    expect(await instance.ensure()).toBeNull();
    expect(instance.pid).toBeNull();
  });

  test("invalidate puts the server into a cooldown", async () => {
    let installs = 0;
    const instance = server({
      port: 0,
      install: async () => {
        installs += 1;
        throw new Error("no install");
      },
    });
    expect(await instance.ensure()).toBeNull();
    expect(installs).toBe(1);

    await instance.invalidate();
    expect(await instance.ensure()).toBeNull();
    expect(installs).toBe(1);
  });

  test("concurrent ensure calls share one start", async () => {
    let installs = 0;
    const instance = server({
      port: 0,
      install: async () => {
        installs += 1;
        throw new Error("no install");
      },
    });
    const results = await Promise.all([
      instance.ensure(),
      instance.ensure(),
      instance.ensure(),
    ]);
    expect(results).toEqual([null, null, null]);
    expect(installs).toBe(1);
  });

  test("touch keeps the server alive and stop is idempotent", async () => {
    const instance = server();
    await instance.ensure();
    instance.touch();
    await instance.stop();
    await instance.stop();
    expect(instance.url).toBeNull();
  });
});
