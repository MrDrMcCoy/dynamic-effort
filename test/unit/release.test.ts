import { describe, expect, test } from "bun:test";
import {
  assetUrl,
  binaryAsset,
  DEFAULT_VERSION,
  MODEL_FILES,
  modelAsset,
  normaliseVersion,
  parseSums,
  RELEASE_BASE,
  releaseTarget,
  SUMS_ASSET,
} from "../../src/core/jev/release.ts";

describe("releaseTarget", () => {
  test("maps the three published platforms", () => {
    expect(releaseTarget("linux", "x64")?.name).toBe("linux-x64");
    expect(releaseTarget("darwin", "arm64")?.name).toBe("macos-arm64");
    expect(releaseTarget("win32", "x64")?.name).toBe("windows-x64");
  });

  test("uses tar.gz for unix binaries and zip for windows", () => {
    expect(releaseTarget("linux", "x64")?.archive).toBe("tar.gz");
    expect(releaseTarget("darwin", "arm64")?.archive).toBe("tar.gz");
    expect(releaseTarget("win32", "x64")?.archive).toBe("zip");
  });

  test("the model is always a zip", () => {
    const targets = [
      releaseTarget("linux", "x64"),
      releaseTarget("darwin", "arm64"),
      releaseTarget("win32", "x64"),
    ];
    for (const target of targets) {
      expect(target?.modelArchive).toBe("zip");
    }
  });

  test("returns null for unsupported targets", () => {
    expect(releaseTarget("linux", "arm64")).toBeNull();
    expect(releaseTarget("darwin", "x64")).toBeNull();
    expect(releaseTarget("win32", "arm64")).toBeNull();
    expect(releaseTarget("freebsd", "x64")).toBeNull();
  });
});

describe("asset names", () => {
  test("builds the binary asset from the target", () => {
    const target = releaseTarget("linux", "x64")!;
    expect(binaryAsset(target)).toBe("jev-linux-x64.tar.gz");
  });

  test("builds the model asset from the tag", () => {
    expect(modelAsset("jevos-v5")).toBe("jevos-v5-openvino-int8.zip");
  });

  test("builds release URLs", () => {
    expect(assetUrl("jevos-v5", "SHA256SUMS.txt")).toBe(
      `${RELEASE_BASE}/jevos-v5/SHA256SUMS.txt`,
    );
  });

  test("accepts a fixture base URL", () => {
    expect(assetUrl("jevos-v5", "x", "http://127.0.0.1:1")).toBe(
      "http://127.0.0.1:1/jevos-v5/x",
    );
  });

  test("names the checksum list", () => {
    expect(SUMS_ASSET).toBe("SHA256SUMS.txt");
  });

  test("pins the current version", () => {
    expect(DEFAULT_VERSION).toBe("jevos-v5");
  });
});

describe("parseSums", () => {
  const digest = "1ce77566405514ed2f20d64f8222cf9eba9b714d332f05f6296e0cad84dd7b04";

  test("parses both separator styles", () => {
    const sums = parseSums(
      `${digest} *jev-linux-x64.tar.gz\n${digest}  jevos-v5-openvino-int8.zip\n`,
    );
    expect(sums.get("jev-linux-x64.tar.gz")).toBe(digest);
    expect(sums.get("jevos-v5-openvino-int8.zip")).toBe(digest);
  });

  test("lowercases digests", () => {
    expect(parseSums(`${digest.toUpperCase()} *a`).get("a")).toBe(digest);
  });

  test("ignores malformed lines", () => {
    const sums = parseSums("garbage\n\nabc *short\n");
    expect(sums.size).toBe(0);
  });

  test("keeps the last entry for a duplicate name", () => {
    const sums = parseSums(`${digest} *a\n${"0".repeat(64)} *a\n`);
    expect(sums.get("a")).toBe("0".repeat(64));
  });
});

describe("normaliseVersion", () => {
  test("keeps a full tag", () => {
    expect(normaliseVersion("jevos-v5")).toBe("jevos-v5");
  });

  test("expands a bare version", () => {
    expect(normaliseVersion("v6")).toBe("jevos-v6");
    expect(normaliseVersion("v5.1")).toBe("jevos-v5.1");
  });

  test("trims whitespace", () => {
    expect(normaliseVersion("  v5  ")).toBe("jevos-v5");
  });

  test("falls back to the default for anything else", () => {
    expect(normaliseVersion("latest")).toBe(DEFAULT_VERSION);
    expect(normaliseVersion("")).toBe(DEFAULT_VERSION);
  });
});

describe("MODEL_FILES", () => {
  test("lists the four required model artifacts", () => {
    expect([...MODEL_FILES]).toEqual([
      "model.json",
      "openvino_model.xml",
      "openvino_model.bin",
      "tokenizer.gguf",
    ]);
  });
});
