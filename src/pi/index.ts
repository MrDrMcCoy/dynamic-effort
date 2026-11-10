// Native extension for pi and oh-my-pi, which share the extension surface
// this adapter needs: an `input` event before the first model call and a
// session-scoped `setThinkingLevel`.
//
// The file declares the host API structurally, so it loads in either host
// without importing their packages and stays off their module graph.

import {
  createRuntime,
  resolveVariant,
  type EffortLevel,
  type RuntimeOptions,
} from "../core/index.ts";

export const EXTENSION_ID = "dynamic-effort";
const STATUS_KEY = "dynamic-effort";

/** Levels both hosts accept; used when the model reports no vocabulary. */
const LEVELS: Record<EffortLevel, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * The levels this model accepts, as the host names them. omp publishes
 * `thinking.efforts`; pi publishes a `thinkingLevelMap` whose null entries are
 * unsupported. Both hosts clamp inside the setter, and clamping down loses the
 * decision (xhigh on a high/max model must become max, not high), so the
 * adapter picks from the model's own vocabulary first.
 */
function supportedLevels(ctx: HostContext): string[] | null {
  const model = ctx.model;
  if (!model) return null;
  const efforts = model.thinking?.efforts;
  if (efforts && efforts.length > 0) return [...efforts];
  const map = model.thinkingLevelMap;
  if (map) {
    const usable = Object.entries(map)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([level]) => level);
    if (usable.length > 0) return usable;
  }
  return null;
}

/** A user choice wins until the session ends. */
const SELECTION_GRACE_MS = 2000;

interface HostUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface HostMessage {
  role?: string;
  usage?: HostUsage;
}

interface HostSessionManager {
  getSessionId?(): string;
}

interface HostUi {
  setStatus?(key: string, text: string): void;
}

interface HostModel {
  provider?: string;
  id?: string;
  /** omp: canonical per-model effort support. */
  thinking?: { efforts?: readonly string[]; mode?: string };
  /** pi: pi level → provider value, with null marking an unsupported level. */
  thinkingLevelMap?: Record<string, string | null>;
}

interface HostContext {
  sessionManager?: HostSessionManager;
  ui?: HostUi;
  model?: HostModel;
}

interface HostInputEvent {
  type: "input";
  text: string;
  source?: "interactive" | "rpc" | "extension";
}

interface HostMessageEndEvent {
  type: "message_end";
  message?: HostMessage;
}

interface HostSelectEvent {
  type: "thinking_level_select";
  level: string;
  previousLevel: string;
}

type Handler<Event> = (event: Event, ctx: HostContext) => unknown;

/** The part of `ExtensionAPI` the adapter uses. */
export interface HostApi {
  on(event: "input", handler: Handler<HostInputEvent>): unknown;
  on(event: "message_end", handler: Handler<HostMessageEndEvent>): unknown;
  on(
    event: "thinking_level_select",
    handler: Handler<HostSelectEvent>,
  ): unknown;
  on(event: "session_shutdown", handler: () => unknown): unknown;
  setThinkingLevel(level: string): void;
  getThinkingLevel?(): string;
}

export type PiExtensionOptions = RuntimeOptions;

function sessionID(ctx: HostContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "session";
  } catch {
    return "session";
  }
}

/**
 * Builds the extension factory. The default export wires the defaults, so a
 * `settings.json` entry or `-e <file>` loads it with environment settings.
 */
export function createDynamicEffortExtension(
  options: PiExtensionOptions = {},
): (host: HostApi) => void {
  return function dynamicEffort(host: HostApi): void {
    const runtime = createRuntime(options);
    const { config, logger, router, telemetry } = runtime;
    const pinned = new Set<string>();
    /** The level this adapter just wrote, to ignore its own event. */
    let applied: { level: string; at: number } | null = null;
    /** Set while `setThinkingLevel` runs: some hosts emit the select event
     * synchronously from inside that call, before `applied` is recorded. */
    let writing = false;

    const status = (ctx: HostContext, text: string) => {
      try {
        ctx.ui?.setStatus?.(STATUS_KEY, text);
      } catch {
        // A host without a footer is not a failure.
      }
    };

    const applyLevel = (ctx: HostContext, effort: EffortLevel): string => {
      const levels = supportedLevels(ctx);
      const wanted =
        (levels
          ? resolveVariant(
              effort,
              levels.map((level) => ({ id: level })),
            )
          : undefined) ?? LEVELS[effort];
      // Some hosts emit `thinking_level_select` from inside the setter, so
      // flag the write before calling it and treat that echo as our own.
      writing = true;
      try {
        host.setThinkingLevel(wanted);
      } catch (error) {
        writing = false;
        logger.debug("thinking level rejected", error);
        return wanted;
      }
      writing = false;
      const actual = host.getThinkingLevel?.() ?? wanted;
      applied = { level: actual, at: Date.now() };
      return actual;
    };

    host.on("input", async (event, ctx) => {
      if (event.source === "extension") return;
      const text = event.text ?? "";
      if (!text.trim()) return;

      const id = sessionID(ctx);
      if (pinned.has(id)) return;

      const decision = await router.onPrompt({ sessionID: id, text });
      if (!decision) return;

      const actual = applyLevel(ctx, decision.effort);
      status(
        ctx,
        actual === decision.effort
          ? `effort ${decision.effort}`
          : `effort ${decision.effort} (${actual})`,
      );
      logger.debug("decided", {
        session: id,
        effort: decision.effort,
        applied: actual,
        source: "input",
      });

      if (config.telemetry) {
        telemetry.append({
          session: id,
          model: ctxModel(ctx),
          effort: decision.effort,
          variant: actual,
          applied: true,
          choice: decision.choice,
          confidence: decision.confidence,
          highStakes: decision.highStakes,
          keyword: decision.keyword,
          source: "prompt",
          promptHash: decision.promptHash,
          prompt: text,
        });
      }
    });

    // A level the user picks by hand wins for the rest of the session. The
    // host echoes our own write, which is not a user choice.
    host.on("thinking_level_select", (event, ctx) => {
      if (writing) return;
      const recent =
        applied !== null &&
        event.level === applied.level &&
        Date.now() - applied.at < SELECTION_GRACE_MS;
      applied = null;
      if (recent) return;

      const id = sessionID(ctx);
      pinned.add(id);
      router.clear(id);
      status(ctx, `effort ${event.level} (pinned)`);
      logger.debug("thinking level pinned by the user", {
        session: id,
        level: event.level,
      });
    });

    // Usage arrives on the finalized assistant message.
    host.on("message_end", (event, ctx) => {
      const usage = event.message?.usage;
      if (!config.telemetry || !usage) return;
      telemetry.stampUsage(sessionID(ctx), {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        reasoning: usage.reasoning ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
      });
    });

    // Persist telemetry and stop a server this adapter started.
    host.on("session_shutdown", async () => {
      await runtime.stop();
    });
  };
}

/** The model label recorded with a decision; the host names it in `model`. */
function ctxModel(ctx: HostContext): string | undefined {
  if (!ctx.model) return undefined;
  return `${ctx.model.provider ?? "unknown"}/${ctx.model.id ?? "unknown"}`;
}

export default createDynamicEffortExtension();
