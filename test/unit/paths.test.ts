import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  APP_DIR,
  cacheRoot,
  jevInstallDir,
  jevLogPath,
} from "../../src/core/paths.ts";
import { createLogger, NULL_LOGGER } from "../../src/core/log.ts";

describe("cacheRoot", () => {
  test("uses XDG_CACHE_HOME when set", () => {
    const xdg = join(tmpdir(), "xdg");
    expect(cacheRoot({ XDG_CACHE_HOME: xdg })).toBe(join(xdg, APP_DIR));
  });

  test("ignores a blank XDG_CACHE_HOME", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "  " })).toContain(APP_DIR);
  });

  test("falls back to the home cache directory", () => {
    expect(cacheRoot({})).toBe(join(homedir(), ".cache", APP_DIR));
  });

  test("uses LOCALAPPDATA on Windows", () => {
    const local = join(tmpdir(), "local");
    expect(cacheRoot({ LOCALAPPDATA: local }, "win32")).toBe(
      join(local, APP_DIR),
    );
  });

  test("ignores LOCALAPPDATA elsewhere", () => {
    const local = join(tmpdir(), "local");
    expect(cacheRoot({ LOCALAPPDATA: local }, "linux")).toBe(
      join(homedir(), ".cache", APP_DIR),
    );
  });
});

describe("install paths", () => {
  test("names the install after version and target", () => {
    const root = join(tmpdir(), "root");
    expect(jevInstallDir("jevos-v5", "linux-x64", root)).toBe(
      join(root, "jev", "jevos-v5-linux-x64"),
    );
  });

  test("puts the server log in the cache root", () => {
    const root = join(tmpdir(), "root");
    expect(jevLogPath(root)).toBe(join(root, "jev.log"));
  });
});

describe("createLogger", () => {
  test("sends every level to an explicit sink", () => {
    const lines: string[] = [];
    const logger = createLogger({ debug: false, sink: (line) => lines.push(line) });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("debug [dynamic-effort] d");
  });

  test("renders details", () => {
    const lines: string[] = [];
    const logger = createLogger({ debug: true, sink: (line) => lines.push(line) });
    logger.info("with error", new Error("boom"));
    logger.info("with string", "text");
    logger.info("with object", { a: 1 });
    expect(lines[0]).toContain("boom");
    expect(lines[1]).toContain("text");
    expect(lines[2]).toContain('{"a":1}');
  });

  test("renders a circular detail without throwing", () => {
    const lines: string[] = [];
    const logger = createLogger({ debug: true, sink: (line) => lines.push(line) });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    logger.info("circular", circular);
    expect(lines[0]).toContain("[object Object]");
  });

  test("drops debug output when debug is off", () => {
    const written: string[] = [];
    const original = console.error;
    console.error = (line: string) => written.push(line);
    try {
      const logger = createLogger({ debug: false });
      logger.debug("hidden");
      logger.info("shown");
    } finally {
      console.error = original;
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("shown");
  });

  test("appends to a file and survives an unwritable path", () => {
    const path = join(tmpdir(), `dynamic-effort-log-${process.pid}.log`);
    const logger = createLogger({ debug: true, file: path });
    logger.debug("to file");
    const text = require("node:fs").readFileSync(path, "utf8");
    expect(text).toContain("to file");

    const broken = createLogger({
      debug: true,
      file: join(path, "nested", "x.log"),
    });
    expect(() => broken.info("no crash")).not.toThrow();
  });
});

describe("NULL_LOGGER", () => {
  test("accepts every call", () => {
    expect(() => {
      NULL_LOGGER.debug("d");
      NULL_LOGGER.info("i");
      NULL_LOGGER.warn("w");
      NULL_LOGGER.error("e");
    }).not.toThrow();
  });
});
