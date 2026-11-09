// Finding and driving the agent's thought-level option.
//
// ACP agents advertise session configuration selectors. The one with the
// `thought_level` category is the reasoning effort; its values are the
// agent's own vocabulary, so the abstract level has to be mapped onto them.

import { resolveVariant, type EffortLevel } from "../core/index.ts";

export interface SelectOption {
  readonly value: string;
  readonly name: string;
}

export interface ThoughtLevelOption {
  readonly id: string;
  readonly values: readonly SelectOption[];
  current?: string;
}

/** The ids agents use when they omit the `thought_level` category. */
const FALLBACK_IDS: readonly string[] = [
  "effort",
  "reasoning_effort",
  "reasoningEffort",
  "thinking",
  "thought_level",
];

interface RawOption {
  id?: unknown;
  type?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

function readSelect(raw: unknown): ThoughtLevelOption | null {
  if (!raw || typeof raw !== "object") return null;
  const option = raw as RawOption;
  if (typeof option.id !== "string" || option.type !== "select") return null;
  const values: SelectOption[] = [];
  if (Array.isArray(option.options)) {
    for (const entry of option.options) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as { value?: unknown; name?: unknown };
      if (typeof candidate.value !== "string") continue;
      values.push({
        value: candidate.value,
        name:
          typeof candidate.name === "string" ? candidate.name : candidate.value,
      });
    }
  }
  if (values.length === 0) return null;
  return {
    id: option.id,
    values,
    current:
      typeof option.currentValue === "string" ? option.currentValue : undefined,
  };
}

/** Picks the thought-level selector out of a session's config options. */
export function findThoughtLevel(
  configOptions: unknown,
): ThoughtLevelOption | null {
  if (!Array.isArray(configOptions)) return null;
  const selects = configOptions
    .map(readSelect)
    .filter((entry): entry is ThoughtLevelOption => entry !== null);

  const categorised = configOptions.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as RawOption).category === "thought_level";
  });
  if (categorised) {
    const select = readSelect(categorised);
    if (select) return select;
  }

  for (const id of FALLBACK_IDS) {
    const match = selects.find((entry) => entry.id === id);
    if (match) return match;
  }
  return null;
}

/**
 * Maps an abstract level onto one of the agent's values, or null when no
 * value sits on the recognised scale.
 */
export function mapEffort(
  option: ThoughtLevelOption,
  effort: EffortLevel,
): string | null {
  const variants = option.values.map((entry) => ({ id: entry.value }));
  return resolveVariant(effort, variants) ?? null;
}

/** True when the option already shows `value`. */
export function isCurrent(
  option: ThoughtLevelOption,
  value: string,
): boolean {
  return option.current === value;
}
