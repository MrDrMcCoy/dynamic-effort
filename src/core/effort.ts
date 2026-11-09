// Effort levels and their mapping onto a harness's model vocabulary.
//
// The decision model answers in abstract levels; every harness exposes its
// own scale (variant ids, reasoning options). Mapping lives here so adapters
// only carry their catalog in and their request options out.

/** Abstract reasoning effort, weakest to strongest. */
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export const EFFORT_ORDER: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Levels a harness may expose that are outside the abstract scale. */
const HARNESS_SCALE = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type HarnessLevel = (typeof HARNESS_SCALE)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_ORDER as readonly string[]).includes(value)
  );
}

/** Clamps `effort` to `max`, never raising it. */
export function clampEffort(
  effort: EffortLevel,
  max: EffortLevel,
): EffortLevel {
  return EFFORT_ORDER.indexOf(effort) <= EFFORT_ORDER.indexOf(max)
    ? effort
    : max;
}

/** The next stronger level, saturating at `xhigh`. */
export function bumpEffort(effort: EffortLevel): EffortLevel {
  const index = EFFORT_ORDER.indexOf(effort);
  return EFFORT_ORDER[Math.min(index + 1, EFFORT_ORDER.length - 1)]!;
}

export interface CatalogVariant {
  readonly id: string;
  readonly settings?: Record<string, unknown>;
}

export interface CatalogEntry {
  readonly providerID: string;
  readonly modelID: string;
  readonly variants: readonly CatalogVariant[];
}

/** The subset of a harness model record the catalog needs. */
export interface CatalogModel {
  readonly providerID: string;
  readonly modelID?: string;
  readonly id?: string;
  readonly variants?: readonly CatalogVariant[];
}

export function catalogKey(providerID: string, modelID: string): string {
  return `${providerID.toLowerCase()}/${modelID.toLowerCase()}`;
}

export function buildCatalog(
  models: readonly CatalogModel[],
): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const model of models) {
    const modelID = (model.modelID ?? model.id ?? "").trim();
    if (!model.providerID || !modelID) continue;
    catalog.set(catalogKey(model.providerID, modelID), {
      providerID: model.providerID,
      modelID,
      variants: (model.variants ?? []).filter((variant) => variant?.id),
    });
  }
  return catalog;
}

function scaleIndex(value: string): number {
  return HARNESS_SCALE.indexOf(value.toLowerCase() as HarnessLevel);
}

/** Position of a variant on the harness scale; -1 when unplaceable. */
function variantPosition(variant: CatalogVariant): number {
  const byId = scaleIndex(variant.id);
  if (byId >= 0) return byId;
  const settings = variant.settings ?? {};
  for (const key of ["reasoningEffort", "thinkingLevel"]) {
    const value = settings[key];
    if (typeof value === "string" && scaleIndex(value) >= 0) {
      return scaleIndex(value);
    }
  }
  return -1;
}

/**
 * Picks the variant closest to `desired` on the harness scale. Ties go to the
 * stronger variant so an ambiguous catalog never under-provisions.
 */
export function resolveVariant(
  desired: EffortLevel,
  variants: readonly CatalogVariant[],
): string | undefined {
  const known = variants
    .map((variant) => ({ id: variant.id, at: variantPosition(variant) }))
    .filter((variant) => variant.at >= 0);
  if (known.length === 0) return undefined;

  const want = scaleIndex(desired);
  let best = known[0]!;
  let bestDistance = Math.abs(best.at - want);
  for (const variant of known.slice(1)) {
    const distance = Math.abs(variant.at - want);
    const strongerTie = distance === bestDistance && variant.at > best.at;
    if (distance < bestDistance || strongerTie) {
      best = variant;
      bestDistance = distance;
    }
  }
  return best.id;
}

export type OptionTemplates = Record<string, Record<string, unknown>>;

// Most specific template wins: provider/model, provider/wildcard,
// wildcard/model, then the catch-all.
export function matchTemplate(
  templates: OptionTemplates | undefined,
  providerID: string,
  modelID: string,
): Record<string, unknown> | undefined {
  if (!templates) return undefined;
  const provider = providerID.toLowerCase();
  const model = modelID.toLowerCase();
  const keys = [`${provider}/${model}`, `${provider}/*`, `*/${model}`, `*`];
  for (const key of keys) {
    const found = Object.entries(templates).find(
      ([candidate]) => candidate.toLowerCase() === key,
    );
    if (found) return found[1];
  }
  return undefined;
}

/** Replaces every `{effort}` placeholder in a template value. */
export function substituteEffort(value: unknown, effort: string): unknown {
  if (typeof value === "string") return value.split("{effort}").join(effort);
  if (Array.isArray(value)) {
    return value.map((entry) => substituteEffort(entry, effort));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        substituteEffort(entry, effort),
      ]),
    );
  }
  return value;
}

export interface AppliedEffort {
  /** The variant id chosen from the catalog, when one was found. */
  readonly variantId?: string;
  /** Whether anything was written into the request options. */
  readonly applied: boolean;
}

/**
 * Writes the resolved effort into `options`. Templates win over catalog
 * settings because they are the user's explicit escape hatch.
 */
export function applyEffort(
  options: Record<string, unknown>,
  providerID: string,
  modelID: string,
  effort: EffortLevel,
  entry?: CatalogEntry,
  templates?: OptionTemplates,
): AppliedEffort {
  const resolved = entry ? resolveVariant(effort, entry.variants) : undefined;

  const template = matchTemplate(templates, providerID, modelID);
  if (template) {
    Object.assign(
      options,
      substituteEffort(template, resolved ?? effort) as Record<string, unknown>,
    );
    return { variantId: resolved, applied: true };
  }

  const variant = resolved
    ? entry?.variants.find(
        (candidate) =>
          candidate.id.toLowerCase() === resolved.toLowerCase(),
      )
    : undefined;
  if (variant?.settings && typeof variant.settings === "object") {
    Object.assign(options, variant.settings);
    return { variantId: resolved, applied: true };
  }
  return { variantId: resolved, applied: false };
}

/** Prefix the decision model sees before the task text. */
export function buildState(
  task: string,
  context: { agent?: string; model?: string } = {},
  maxChars = 4000,
): string {
  const body = task.length > maxChars ? task.slice(-maxChars) : task;
  const scope = [
    context.agent ? `agent=${context.agent}` : "",
    context.model ? `model=${context.model}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return scope ? `${scope}\ntask: ${body}` : `task: ${body}`;
}

/** Flattens message content parts into plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("\n");
}

/** The last user message's text, or an empty string. */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
      text?: unknown;
    } | null;
    const role = String(message?.role ?? "").toLowerCase();
    if (role !== "user" && role !== "human") continue;
    const text = contentToText(message?.content ?? message?.text ?? "");
    if (text.trim()) return text.trim();
  }
  return "";
}

/** FNV-1a, used to recognise a replayed prompt without storing its text. */
export function hashPrompt(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export const DEFAULT_MAX_KEYWORDS: readonly string[] = ["ultrathink"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the first whole-word keyword found in `text`, if any. */
export function findMaxKeyword(
  text: string,
  keywords: readonly string[] = DEFAULT_MAX_KEYWORDS,
): string | undefined {
  for (const keyword of keywords) {
    const word = keyword.trim();
    if (!word) continue;
    const pattern = new RegExp(`(?<!\\w)${escapeRegExp(word)}(?!\\w)`, "i");
    if (pattern.test(text)) return word;
  }
  return undefined;
}
