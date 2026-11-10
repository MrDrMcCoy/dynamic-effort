// Options from the environment, for adapters that have no config file of
// their own (the ACP proxy, a one-off CLI run).
//
// These sit below explicit options and above the defaults.

import type { EffortConfig } from "./config.ts";

const PREFIX = "DYNAMIC_EFFORT_";

/** Reads `DYNAMIC_EFFORT_<NAME>` for each option that has a variable. */
export function envConfig(
  env: NodeJS.ProcessEnv = process.env,
): Partial<EffortConfig> {
  const read = (name: string): string | undefined => {
    const value = env[`${PREFIX}${name}`];
    return value && value.trim() ? value.trim() : undefined;
  };
  const readNumber = (name: string): number | undefined => {
    const value = read(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const port = readNumber("PORT");
  const maxStateChars = readNumber("MAX_STATE_CHARS");
  const timeoutMs = readNumber("TIMEOUT_MS");
  const threads = readNumber("THREADS");
  const telemetryCapacity = readNumber("TELEMETRY_CAPACITY");
  const telemetryPromptChars = readNumber("TELEMETRY_PROMPT_CHARS");
  const telemetry = read("TELEMETRY");
  const telemetryPersist = read("TELEMETRY_PERSIST");

  return {
    endpoint: read("ENDPOINT"),
    apiKey: read("API_KEY"),
    model: read("MODEL"),
    jevPath: read("JEV_PATH"),
    defaultEffort: read("DEFAULT_EFFORT") as EffortConfig["defaultEffort"],
    maxEffort: read("MAX_EFFORT") as EffortConfig["maxEffort"],
    minConfidence: readNumber("MIN_CONFIDENCE"),
    stakesThreshold: readNumber("STAKES_THRESHOLD"),
    timeoutMs,
    maxStateChars,
    jevPort: port,
    jevThreads: threads === undefined ? undefined : Math.floor(threads),
    debug: read("DEBUG") === "1" || read("DEBUG") === "true" ? true : undefined,
    telemetry: telemetry === undefined ? undefined : telemetry !== "0" &&
      telemetry !== "false",
    telemetryPersist:
      telemetryPersist === undefined
        ? undefined
        : telemetryPersist === "1" || telemetryPersist === "true",
    telemetryCapacity:
      telemetryCapacity === undefined
        ? undefined
        : Math.floor(telemetryCapacity),
    telemetryPromptChars:
      telemetryPromptChars === undefined
        ? undefined
        : Math.floor(telemetryPromptChars),
  };
}
