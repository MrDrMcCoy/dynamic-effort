// Adapter options, read once at startup. The same shape serves every harness;
// an adapter ignores the fields it cannot honour.

import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_STAKES_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  type QuestionSpec,
} from "./decision.ts";
import {
  isEffortLevel,
  type EffortLevel,
  type OptionTemplates,
} from "./effort.ts";

export const DEFAULT_EXCLUDE_AGENTS: readonly string[] = [
  "title",
  "summary",
  "compaction",
];

/** Default jevos port; 0 asks the supervisor to scan for a free one. */
export const DEFAULT_JEV_PORT = 8017;

export interface EffortConfig {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly defaultEffort: EffortLevel;
  readonly maxEffort: EffortLevel;
  readonly minConfidence: number;
  readonly stakesThreshold: number;
  readonly timeoutMs: number;
  readonly maxStateChars: number;
  readonly includeAgents: readonly string[] | null;
  readonly excludeAgents: readonly string[];
  readonly keywords: readonly string[];
  readonly optionTemplates?: OptionTemplates;
  readonly respectExplicitVariant: boolean;
  readonly debug: boolean;
  /** Local server settings; ignored when `endpoint` is set. */
  readonly jevPort: number;
  readonly jevThreads: number | null;
  readonly jevIdleMs: number;
  /** A pre-installed jevos directory. */
  readonly jevPath?: string;
  /** Extra directories to reuse before downloading. */
  readonly jevReuseDirs: readonly string[];
  /** A tuned question set; absent means the built-in wording. */
  readonly questions?: QuestionSpec;
  /** Keep a local ring buffer of decisions; in memory only by default. */
  readonly telemetry: boolean;
  /** Write the buffer to disk when the adapter shuts down. */
  readonly telemetryPersist: boolean;
  readonly telemetryCapacity: number;
  /** Prompt characters kept per entry; 0 drops the prompt text. */
  readonly telemetryPromptChars: number;
}

export const DEFAULT_CONFIG: EffortConfig = {
  defaultEffort: "medium",
  maxEffort: "xhigh",
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  stakesThreshold: DEFAULT_STAKES_THRESHOLD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxStateChars: 4000,
  includeAgents: null,
  excludeAgents: DEFAULT_EXCLUDE_AGENTS,
  keywords: ["ultrathink"],
  respectExplicitVariant: true,
  debug: false,
  jevPort: DEFAULT_JEV_PORT,
  jevThreads: null,
  jevIdleMs: 10 * 60_000,
  jevReuseDirs: [],
  telemetry: true,
  telemetryPersist: false,
  telemetryCapacity: 500,
  telemetryPromptChars: 500,
};

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 0 ? value : undefined;
}

/** Accepts zero, which means "keep nothing" for the prompt text. */
function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

function effort(value: unknown): EffortLevel | undefined {
  return isEffortLevel(value) ? value : undefined;
}

function templates(value: unknown): OptionTemplates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: OptionTemplates = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      result[key] = entry as Record<string, unknown>;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Reads the plugin options, falling back to defaults for anything invalid. */
export function readConfig(options: unknown): EffortConfig {
  const raw = (options ?? {}) as Record<string, unknown>;
  const endpoint = typeof raw["endpoint"] === "string" && raw["endpoint"].trim()
    ? raw["endpoint"].trim()
    : undefined;
  const apiKey = typeof raw["apiKey"] === "string" && raw["apiKey"].trim()
    ? raw["apiKey"].trim()
    : undefined;
  const model = typeof raw["model"] === "string" && raw["model"].trim()
    ? raw["model"].trim()
    : undefined;
  const jevPath = typeof raw["jevPath"] === "string" && raw["jevPath"].trim()
    ? raw["jevPath"].trim()
    : undefined;
  const threads = positiveNumber(raw["jevThreads"]);

  return {
    endpoint,
    apiKey,
    model,
    defaultEffort: effort(raw["defaultEffort"]) ?? DEFAULT_CONFIG.defaultEffort,
    maxEffort: effort(raw["maxEffort"]) ?? DEFAULT_CONFIG.maxEffort,
    minConfidence:
      positiveNumber(raw["minConfidence"]) ?? DEFAULT_CONFIG.minConfidence,
    stakesThreshold:
      positiveNumber(raw["stakesThreshold"]) ?? DEFAULT_CONFIG.stakesThreshold,
    timeoutMs: positiveNumber(raw["timeoutMs"]) ?? DEFAULT_CONFIG.timeoutMs,
    maxStateChars:
      positiveNumber(raw["maxStateChars"]) ?? DEFAULT_CONFIG.maxStateChars,
    includeAgents: stringList(raw["includeAgents"]) ?? null,
    excludeAgents:
      stringList(raw["excludeAgents"]) ?? DEFAULT_CONFIG.excludeAgents,
    keywords: stringList(raw["keywords"]) ?? DEFAULT_CONFIG.keywords,
    optionTemplates: templates(raw["optionTemplates"]),
    respectExplicitVariant: raw["respectExplicitVariant"] !== false,
    debug: raw["debug"] === true,
    jevPort:
      typeof raw["jevPort"] === "number" && raw["jevPort"] >= 0
        ? raw["jevPort"]
        : DEFAULT_CONFIG.jevPort,
    jevThreads: threads === undefined ? null : Math.floor(threads),
    jevIdleMs: positiveNumber(raw["jevIdleMs"]) ?? DEFAULT_CONFIG.jevIdleMs,
    jevPath,
    jevReuseDirs:
      stringList(raw["jevReuseDirs"]) ?? DEFAULT_CONFIG.jevReuseDirs,
    questions: readQuestions(raw["questions"]),
    telemetry: raw["telemetry"] !== false,
    telemetryPersist: raw["telemetryPersist"] === true,
    telemetryCapacity:
      positiveNumber(raw["telemetryCapacity"]) ??
      DEFAULT_CONFIG.telemetryCapacity,
    telemetryPromptChars:
      nonNegativeNumber(raw["telemetryPromptChars"]) ??
      DEFAULT_CONFIG.telemetryPromptChars,
  };
}

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Accepts a full replacement question set only when every field is present. */
function readQuestions(value: unknown): QuestionSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const reasoningEffort = raw["reasoningEffort"];
  const highStakes = raw["highStakes"];
  const criteria = raw["effortCriteria"];
  if (typeof reasoningEffort !== "string" || typeof highStakes !== "string") {
    return undefined;
  }
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    return undefined;
  }
  const entries = criteria as Record<string, unknown>;
  const complete = EFFORT_LEVELS.every(
    (level) => typeof entries[level] === "string",
  );
  if (!complete) return undefined;
  return {
    reasoningEffort,
    highStakes,
    effortCriteria: Object.fromEntries(
      EFFORT_LEVELS.map((level) => [level, entries[level] as string]),
    ) as Record<EffortLevel, string>,
  };
}

/** True when the agent should not get a decision at all. */
export function agentIncluded(
  config: EffortConfig,
  agent: string,
): boolean {
  const name = agent.toLowerCase();
  if (config.excludeAgents.some((entry) => entry.toLowerCase() === name)) {
    return false;
  }
  if (config.includeAgents === null) return true;
  return config.includeAgents.some((entry) => entry.toLowerCase() === name);
}
