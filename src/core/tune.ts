// Tuning support: turn recorded decisions into a prompt, and turn the
// model's answer back into a validated, diffable proposal.
//
// Nothing here calls a model or writes config on its own. The adapter
// supplies the text, and applying a proposal stays an explicit step.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readQuestionSpec, type EffortConfig } from "./config.ts";
import { isEffortLevel, type EffortLevel } from "./effort.ts";
import type { QuestionSpec } from "./decision.ts";
import type { TelemetryEntry } from "./telemetry.ts";

/** How many entries the prompt shows; the rest are summarised only. */
export const MAX_TUNE_ENTRIES = 200;
/** Proposal files kept on disk; the oldest are removed past this. */
export const MAX_TUNE_PROPOSALS = 20;

export interface TuningStats {
  readonly entries: number;
  readonly sessions: number;
  readonly applied: number;
  /** Entries whose answer fell below the confidence threshold. */
  readonly lowConfidence: number;
  /** Entries where the stakes score reached the bump threshold. */
  readonly bumped: number;
  readonly byEffort: Readonly<Record<string, number>>;
  readonly bySource: Readonly<Record<string, number>>;
  readonly reasoningTokens: number;
  readonly outputTokens: number;
  readonly averageConfidence: number;
  readonly averageStakes: number;
}

/** A candidate change; every field except `summary` is optional. */
export interface TuningProposal {
  readonly summary: string;
  readonly questions?: QuestionSpec;
  readonly minConfidence?: number;
  readonly stakesThreshold?: number;
  readonly defaultEffort?: EffortLevel;
  readonly maxEffort?: EffortLevel;
  readonly notes?: readonly string[];
}

export interface TuningRecord {
  readonly at: string;
  readonly entries: number;
  readonly proposal: TuningProposal;
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Counts what the tuner should look at, using the current thresholds. */
export function summarizeTelemetry(
  entries: readonly TelemetryEntry[],
  config: Pick<EffortConfig, "minConfidence" | "stakesThreshold">,
): TuningStats {
  const confidences = entries
    .map((entry) => entry.confidence)
    .filter((value): value is number => typeof value === "number");
  const stakes = entries
    .map((entry) => entry.highStakes)
    .filter((value): value is number => typeof value === "number");

  return {
    entries: entries.length,
    sessions: new Set(entries.map((entry) => entry.session)).size,
    applied: entries.filter((entry) => entry.applied).length,
    lowConfidence: confidences.filter(
      (value) => value < config.minConfidence,
    ).length,
    bumped: stakes.filter((value) => value >= config.stakesThreshold).length,
    byEffort: tally(entries.map((entry) => entry.effort)),
    bySource: tally(entries.map((entry) => entry.source)),
    reasoningTokens: entries.reduce(
      (total, entry) => total + (entry.usage?.reasoning ?? 0),
      0,
    ),
    outputTokens: entries.reduce(
      (total, entry) => total + (entry.usage?.output ?? 0),
      0,
    ),
    averageConfidence: average(confidences),
    averageStakes: average(stakes),
  };
}

/** One line per decision, newest last, with the prompt quoted. */
function renderEntry(entry: TelemetryEntry): string {
  const parts = [
    `effort=${entry.effort}`,
    entry.variant ? `variant=${entry.variant}` : "",
    entry.choice ? `choice=${entry.choice}` : "",
    typeof entry.confidence === "number"
      ? `confidence=${entry.confidence.toFixed(3)}`
      : "",
    typeof entry.highStakes === "number"
      ? `stakes=${entry.highStakes.toFixed(3)}`
      : "",
    `applied=${entry.applied}`,
    entry.usage ? `reasoning_tokens=${entry.usage.reasoning}` : "",
    entry.keyword ? `keyword=${entry.keyword}` : "",
  ].filter(Boolean);
  const prompt = entry.prompt ? ` prompt=${JSON.stringify(entry.prompt)}` : "";
  return `- ${parts.join(" ")}${prompt}`;
}

/** Builds the review prompt: current settings, statistics, then evidence. */
export function buildTuningPrompt(
  entries: readonly TelemetryEntry[],
  config: EffortConfig,
): string {
  const stats = summarizeTelemetry(entries, config);
  const recent = entries.slice(-MAX_TUNE_ENTRIES).map(renderEntry);
  const questions = config.questions ?? null;

  return [
    "You are reviewing how a small local model routes coding tasks to",
    "reasoning effort. Each recorded decision shows the effort it chose,",
    "its confidence, a stakes score, whether the harness accepted the",
    "value, and how many reasoning tokens the turn then used.",
    "",
    "Judge the routing, not the code. Propose changes only where the",
    "record supports them: question wording that misreads a task type,",
    "criteria that do not separate levels, or thresholds that send too",
    "many turns to the wrong effort.",
    "",
    "Answer with one JSON object and nothing else:",
    '{"summary": "one paragraph",',
    ' "questions": {"reasoningEffort": "...", "highStakes": "...",',
    '   "effortCriteria": {"minimal": "...", "low": "...",',
    '     "medium": "...", "high": "...", "xhigh": "..."}},',
    ' "minConfidence": 0.5, "stakesThreshold": 0.4,',
    ' "defaultEffort": "medium", "maxEffort": "xhigh",',
    ' "notes": ["short observation"]}',
    "",
    "Include only the fields you want to change, but when you include",
    '"questions" give every field. Thresholds are between 0 and 1.',
    "",
    "Current settings:",
    `- defaultEffort=${config.defaultEffort} maxEffort=${config.maxEffort}`,
    `- minConfidence=${config.minConfidence}`,
    `- stakesThreshold=${config.stakesThreshold}`,
    `- reasoningEffort question=${JSON.stringify(
      questions?.reasoningEffort ?? "(built in)",
    )}`,
    `- highStakes question=${JSON.stringify(
      questions?.highStakes ?? "(built in)",
    )}`,
    "",
    "Observed:",
    `- decisions=${stats.entries} sessions=${stats.sessions}`,
    `- applied=${stats.applied} low_confidence=${stats.lowConfidence}`,
    `- stakes_bumped=${stats.bumped}`,
    `- mean_confidence=${stats.averageConfidence.toFixed(3)}`,
    `- mean_stakes=${stats.averageStakes.toFixed(3)}`,
    `- reasoning_tokens=${stats.reasoningTokens}`,
    `- output_tokens=${stats.outputTokens}`,
    `- by_effort=${JSON.stringify(stats.byEffort)}`,
    `- by_source=${JSON.stringify(stats.bySource)}`,
    "",
    `Decisions (${recent.length} of ${stats.entries}, oldest first):`,
    ...recent,
  ].join("\n");
}

/** Pulls the first JSON object out of a fenced or bare answer. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("the answer contains no JSON object");
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the answer is not valid JSON: ${String(error)}`);
  }
}

function unitInterval(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  if (value <= 0 || value > 1) {
    throw new Error(`${field} must be greater than 0 and at most 1`);
  }
  return value;
}

function effortField(value: unknown, field: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!isEffortLevel(value)) throw new Error(`${field} is not an effort level`);
  return value;
}

/**
 * Validates the model's answer. A malformed proposal is an error, not a
 * silent fallback: the point is to review the change before applying it.
 */
export function parseTuningProposal(text: string): TuningProposal {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the answer is not a JSON object");
  }
  const fields = raw as Record<string, unknown>;
  const summary = fields["summary"];
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("the proposal needs a summary");
  }

  const questions = readQuestionSpec(fields["questions"]);
  if (fields["questions"] !== undefined && !questions) {
    throw new Error("the questions field is incomplete");
  }

  const notes = fields["notes"];
  if (notes !== undefined && !Array.isArray(notes)) {
    throw new Error("notes must be a list");
  }

  return {
    summary: summary.trim(),
    questions,
    minConfidence: unitInterval(fields["minConfidence"], "minConfidence"),
    stakesThreshold: unitInterval(
      fields["stakesThreshold"],
      "stakesThreshold",
    ),
    defaultEffort: effortField(fields["defaultEffort"], "defaultEffort"),
    maxEffort: effortField(fields["maxEffort"], "maxEffort"),
    notes: notes === undefined
      ? undefined
      : notes.filter((note): note is string => typeof note === "string"),
  };
}

/** Writes a proposal as JSON, creating the directory if needed. */
export function writeTuningProposal(
  directory: string,
  proposal: TuningProposal,
  entries = 0,
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = uniquePath(directory, stamp);
  const record: TuningRecord = {
    at: new Date().toISOString(),
    entries,
    proposal,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  pruneProposals(directory);
  return file;
}

/** Several proposals can land in the same millisecond; number the extras. */
function uniquePath(directory: string, stamp: string): string {
  let candidate = join(directory, `${stamp}.json`);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stamp}-${counter}.json`);
    counter += 1;
  }
  return candidate;
}

/** Proposal files, oldest first; same-millisecond names sort by suffix. */
function proposalFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

/** Keeps the newest proposal files and removes the rest. */
function pruneProposals(directory: string): void {
  try {
    const files = proposalFiles(directory);
    for (const name of files.slice(0, -MAX_TUNE_PROPOSALS)) {
      try {
        unlinkSync(join(directory, name));
      } catch {
        // A file that cannot be removed is left for the next run.
      }
    }
  } catch {
    // Pruning is housekeeping; a failure must not lose the proposal.
  }
}

/** Reads the newest proposal, or null when there is none. */
export function readLatestProposal(directory: string): TuningRecord | null {
  let names: string[];
  try {
    names = proposalFiles(directory);
  } catch {
    return null;
  }
  const newest = names[names.length - 1];
  if (!newest) return null;
  try {
    const text = readFileSync(join(directory, newest), "utf8");
    const record = JSON.parse(text) as TuningRecord;
    if (!record?.proposal?.summary) return null;
    return record;
  } catch {
    return null;
  }
}

/** A human-readable list of what a proposal changes. */
export function describeProposal(
  proposal: TuningProposal,
  config: EffortConfig,
): string[] {
  const lines: string[] = [proposal.summary];
  const next = proposal.defaultEffort;
  if (next && next !== config.defaultEffort) {
    lines.push(`defaultEffort: ${config.defaultEffort} -> ${next}`);
  }
  if (proposal.maxEffort && proposal.maxEffort !== config.maxEffort) {
    lines.push(`maxEffort: ${config.maxEffort} -> ${proposal.maxEffort}`);
  }
  if (
    proposal.minConfidence !== undefined &&
    proposal.minConfidence !== config.minConfidence
  ) {
    lines.push(
      `minConfidence: ${config.minConfidence} -> ${proposal.minConfidence}`,
    );
  }
  if (
    proposal.stakesThreshold !== undefined &&
    proposal.stakesThreshold !== config.stakesThreshold
  ) {
    lines.push(
      "stakesThreshold: " +
        `${config.stakesThreshold} -> ${proposal.stakesThreshold}`,
    );
  }
  if (proposal.questions) lines.push("questions: rewritten");
  for (const note of proposal.notes ?? []) lines.push(`note: ${note}`);
  return lines;
}
