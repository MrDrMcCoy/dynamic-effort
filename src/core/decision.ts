// The SystemOne decision client: one HTTP request, two atomic questions,
// composed in code. Failures are the caller's business; this module only
// reports them.

import type { EffortLevel } from "./effort.ts";
import { bumpEffort, clampEffort, isEffortLevel } from "./effort.ts";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:8017/v1/systemone";
/** Appended to a base URL that carries no path. */
export const SYSTEMONE_PATH = "/v1/systemone";
export const DEFAULT_MODEL = "jevos-v5";
export const DEFAULT_TIMEOUT_MS = 8000;
// Calibrated on calibration/corpus.jsonl. The gate sits at the bottom of the
// best plateau: raising it past 0.10 only discards answers that were right,
// because confidence when right (0.46) is barely above confidence when wrong
// (0.33).
export const DEFAULT_MIN_CONFIDENCE = 0.1;
export const DEFAULT_STAKES_THRESHOLD = 0.2;

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities?: Record<string, number>;
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface SystemOneResponse {
  readonly model: string;
  readonly answers: {
    readonly reasoning_effort?: ChoiceAnswer;
    readonly high_stakes?: NoulAnswer;
  };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

/** The part of `fetch` the client needs; tests pass plain functions. */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface DecisionRequestOptions {
  readonly endpoint?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Injected for tests; anything fetch-shaped works. */
  readonly fetch?: FetchLike;
}

/** Question wording is data so the auto-tuner can rewrite it later. */
export interface QuestionSpec {
  readonly reasoningEffort: string;
  readonly effortCriteria: Readonly<Record<EffortLevel, string>>;
  readonly highStakes: string;
}

// Calibrated against calibration/corpus.jsonl: the sharper criteria move the
// model's mean answer from 0.40 levels below the human label to 0.08 below,
// and a 0.15 confidence gate stops discarding answers that are right.
export const DEFAULT_QUESTIONS: QuestionSpec = {
  reasoningEffort:
    "How much reasoning does this coding task need? " +
    "Judge only the task described in the state.",
  effortCriteria: {
    minimal:
      "Trivial lookup, greeting, formatting, or a single obvious answer " +
      "with no tradeoffs. Not for anything that requires reading code.",
    low:
      "Simple well-defined task: single-file edit, explain code, or a " +
      "small fix with a clear path.",
    medium:
      "Moderate task: multi-file change, debugging with some unknowns, " +
      "or choosing between a few approaches.",
    high:
      "Complex task: ambiguous requirements, system-wide refactor, hard " +
      "bug, security or performance critical work, novel design, or a " +
      "change that touches concurrency, serialization, or platform " +
      "differences.",
    xhigh:
      "Exceptional: mission-critical architecture, distributed consistency, " +
      "adversarial security, payments or billing correctness, irreversible " +
      "data operations, or high-uncertainty research where a wrong answer " +
      "is costly.",
  },
  highStakes:
    "Does this task involve irreversible, production, security, auth, " +
    "payments, data-loss, migration, or deployment actions where a " +
    "mistake is costly?",
};

export function buildQuestions(
  spec: QuestionSpec = DEFAULT_QUESTIONS,
): Record<string, unknown> {
  return {
    reasoning_effort: {
      type: "choice",
      instructions: spec.reasoningEffort,
      criteria: spec.effortCriteria,
    },
    high_stakes: {
      type: "noul",
      instructions: spec.highStakes,
    },
  };
}

function resolveApiKey(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env["JEV_API_KEY"]?.trim() ||
    process.env["DYNAMIC_EFFORT_API_KEY"]?.trim() ||
    ""
  );
}

// Accepts a base URL or a full endpoint; adds the decision path when
// absent.
export function resolveEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_ENDPOINT;
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") {
      return `${trimmed}${SYSTEMONE_PATH}`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** Posts one SystemOne request. Throws on transport or protocol failure. */
export async function askSystemOne(
  state: string,
  options: DecisionRequestOptions = {},
  spec: QuestionSpec = DEFAULT_QUESTIONS,
): Promise<SystemOneResponse> {
  const endpoint = resolveEndpoint(
    options.endpoint?.trim() ||
      process.env["DYNAMIC_EFFORT_ENDPOINT"]?.trim() ||
      process.env["JEV_ENDPOINT"]?.trim() ||
      DEFAULT_ENDPOINT,
  );
  const model =
    options.model?.trim() ||
    process.env["DYNAMIC_EFFORT_MODEL"]?.trim() ||
    DEFAULT_MODEL;
  const apiKey = resolveApiKey(options.apiKey);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, state, questions: buildQuestions(spec) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `decision request failed (${response.status}): ${body.slice(0, 300)}`,
      );
    }
    return (await response.json()) as SystemOneResponse;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export interface Decision {
  readonly effort: EffortLevel;
  /** The model's raw choice, before confidence and stakes handling. */
  readonly rawChoice: string;
  readonly confidence: number;
  readonly highStakes: number;
  readonly bumpedForStakes: boolean;
  /** True when confidence fell below the threshold. */
  readonly lowConfidence: boolean;
}

export interface DecisionPolicy {
  readonly defaultEffort?: EffortLevel;
  readonly maxEffort?: EffortLevel;
  readonly minConfidence?: number;
  readonly stakesThreshold?: number;
}

/**
 * Composes the answers: low confidence falls back to the default, high
 * stakes bumps one level, and the result never exceeds `maxEffort`.
 */
export function composeDecision(
  response: SystemOneResponse,
  policy: DecisionPolicy = {},
): Decision {
  const defaultEffort = policy.defaultEffort ?? "medium";
  const maxEffort = policy.maxEffort ?? "xhigh";
  const minConfidence = policy.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const stakesThreshold = policy.stakesThreshold ?? DEFAULT_STAKES_THRESHOLD;

  const choice = response.answers?.reasoning_effort;
  const highStakes = response.answers?.high_stakes?.noul ?? 0;

  if (!choice || !isEffortLevel(choice.choice)) {
    return {
      effort: clampEffort(defaultEffort, maxEffort),
      rawChoice: choice?.choice ?? "unknown",
      confidence: choice?.confidence ?? 0,
      highStakes,
      bumpedForStakes: false,
      lowConfidence: true,
    };
  }

  const lowConfidence = choice.confidence < minConfidence;
  let effort = lowConfidence ? defaultEffort : choice.choice;
  let bumped = false;
  if (highStakes >= stakesThreshold) {
    effort = bumpEffort(effort);
    bumped = effort !== (lowConfidence ? defaultEffort : choice.choice);
  }

  return {
    effort: clampEffort(effort, maxEffort),
    rawChoice: choice.choice,
    confidence: choice.confidence,
    highStakes,
    bumpedForStakes: bumped,
    lowConfidence,
  };
}

/** Asks once and composes the answers. Throws like `askSystemOne`. */
export async function decide(
  state: string,
  policy: DecisionPolicy = {},
  request: DecisionRequestOptions = {},
  spec: QuestionSpec = DEFAULT_QUESTIONS,
): Promise<Decision> {
  return composeDecision(await askSystemOne(state, request, spec), policy);
}
