import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
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
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve(port);
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

  const posixOnly = process.platform === "win32" ? test.skip : test;
  posixOnly("keeps one server when a claim is held", async () => {
    // A rival process holds the claim and is still loading its model. The
    // second process must wait for that server, not start another.
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await writeFile(join(root, `jev-${port}.claim`), "1");

    let spawned = false;
    const winner = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(READY_BODY));
    });
    setTimeout(() => {
      winner.listen(port, "127.0.0.1");
    }, 300);

    const instance = server({
      port,
      startupTimeoutMs: 5_000,
      probeTimeoutMs: 100,
      install: async () => {
        spawned = true;
        throw new Error("must not install while another process claims");
      },
    });

    expect(await instance.ensure()).toBe(`http://127.0.0.1:${port}`);
    expect(spawned).toBe(false);
    expect(instance.owns).toBe(false);
    await instance.stop();
    await new Promise<void>((resolve) => winner.close(() => resolve()));
  });

  posixOnly("takes over a stale claim", async () => {
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const claimPath = join(root, `jev-${port}.claim`);
    await writeFile(claimPath, "1");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(claimPath, old, old);

    // The stale claim must not block a fresh start; the install failure
    // proves the code got past the claim.
    const instance = server({
      port,
      startupTimeoutMs: 1_000,
      install: async () => {
        throw new Error("no install");
      },
    });
    expect(await instance.ensure()).toBeNull();
  });

  posixOnly("attaches when another process wins the port", async () => {
    // Reserve a port and release it, so the port is free when we check it and
    // another process can take it while our own child is starting.
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const binary = join(root, "losing-jev");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const winner = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(READY_BODY));
    });
    setTimeout(() => {
      winner.listen(port, "127.0.0.1");
    }, 200);

    const instance = server({
      port,
      startupTimeoutMs: 3_000,
      probeTimeoutMs: 100,
      install: async () => ({
        root,
        binary,
        modelDir: join(root, "model"),
        version: "jevos-v5",
        target: "linux-x64",
      }),
    });

    expect(await instance.ensure()).toBe(`http://127.0.0.1:${port}`);
    expect(instance.owns).toBe(false);
    expect(instance.pid).toBeNull();
    await instance.stop();
    // The winner still serves: attaching must not kill another process.
    expect(await probeHealth(port, 500)).not.toBeNull();
    await new Promise<void>((resolve) => winner.close(() => resolve()));
  });

  const posix = process.platform === "win32" ? test.skip : test;
  posix("returns null when the child never becomes ready", async () => {
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
