// Release metadata for the jevos decision model, kept pure: asset naming,
// platform mapping, and checksum parsing. Verified against jevos-v5:
//   jev-linux-x64.tar.gz, jev-macos-arm64.tar.gz, jev-windows-x64.zip
//   jevos-v5-openvino-int8.zip (the model)
//   SHA256SUMS.txt ("<hex> *<name>")

export const RELEASE_BASE = "https://github.com/feder-cr/jev/releases/download";
export const DEFAULT_VERSION = "jevos-v5";
export const SUMS_ASSET = "SHA256SUMS.txt";

/** Model files that must exist for an install to count as complete. */
export const MODEL_FILES: readonly string[] = [
  "model.json",
  "openvino_model.xml",
  "openvino_model.bin",
  "tokenizer.gguf",
];

export type ArchiveKind = "tar.gz" | "zip";

export interface ReleaseTarget {
  /** `<os>-<arch>` as the release names it. */
  readonly name: string;
  readonly archive: ArchiveKind;
  /** Whether the model archive is a zip. It is a zip on every platform. */
  readonly modelArchive: ArchiveKind;
}

/**
 * The platforms jevos publishes for. Anything else gets no binary, and the
 * caller falls back to leaving model defaults untouched.
 */
export function releaseTarget(
  platform: NodeJS.Platform,
  arch: string,
): ReleaseTarget | null {
  if (platform === "linux" && arch === "x64") {
    return { name: "linux-x64", archive: "tar.gz", modelArchive: "zip" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { name: "macos-arm64", archive: "tar.gz", modelArchive: "zip" };
  }
  if (platform === "win32" && arch === "x64") {
    return { name: "windows-x64", archive: "zip", modelArchive: "zip" };
  }
  return null;
}

export function binaryAsset(target: ReleaseTarget): string {
  return `jev-${target.name}.${target.archive}`;
}

/** The tag name is part of the model asset name. */
export function modelAsset(version: string): string {
  return `${version}-openvino-int8.zip`;
}

export function assetUrl(
  version: string,
  asset: string,
  base: string = RELEASE_BASE,
): string {
  return `${base}/${version}/${asset}`;
}

/**
 * Parses `SHA256SUMS.txt` into asset name -> digest. Lines are
 * `<hex> *<name>` or `<hex>  <name>`; malformed lines are ignored.
 */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    const digest = match?.[1];
    const name = match?.[2];
    if (digest && name) sums.set(name, digest.toLowerCase());
  }
  return sums;
}

/** Accepts `jevos-v5`, `v5`, or anything else (which pins the default). */
export function normaliseVersion(value: string): string {
  const trimmed = value.trim();
  if (/^jevos-v\d+(?:\.\d+)*$/.test(trimmed)) return trimmed;
  if (/^v\d+(?:\.\d+)*$/.test(trimmed)) return `jevos-${trimmed}`;
  return DEFAULT_VERSION;
}
