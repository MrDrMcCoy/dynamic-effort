// The session-level decision flow shared by every harness adapter.
//
// A decision is made once per user prompt and reused for the tool loop that
// follows. Adapters translate their events into these calls and apply the
// result to their own request options.

import {
  buildState,
  findMaxKeyword,
  hashPrompt,
  lastUserText,
  type EffortLevel,
} from "./effort.ts";
import {
  decide,
  type Decision,
  type DecisionPolicy,
  type DecisionRequestOptions,
  type QuestionSpec,
} from "./decision.ts";
import type { Logger } from "./log.ts";
import { NULL_LOGGER } from "./log.ts";

/** What the harness sends when a user prompt is admitted. */
export interface PromptEvent {
  readonly sessionID: string;
  readonly text: string;
  /** A user-pinned effort or variant; the decision is skipped. */
  readonly pinned?: boolean;
}

/** What the harness sends when a model request is about to be made. */
export interface ContextEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  /** Messages for a fallback decision when no prompt was seen. */
  readonly messages?: unknown;
  /** True when the request already carries a user-pinned variant. */
  readonly pinned?: boolean;
}

export interface StashedDecision {
  readonly promptHash: string;
  readonly effort: EffortLevel;
  readonly choice?: string;
  readonly confidence?: number;
  readonly highStakes?: number;
  readonly bumpedForStakes?: boolean;
  readonly lowConfidence?: boolean;
  readonly keyword?: string;
}

export interface RouterOptions {
  readonly policy?: DecisionPolicy;
  /**
   * Request settings, or a provider called per decision so a lazily started
   * endpoint is picked up after it becomes available.
   */
  readonly request?:
    | DecisionRequestOptions
    | (() => DecisionRequestOptions | Promise<DecisionRequestOptions>);
  readonly maxStateChars?: number;
  readonly keywords?: readonly string[];
  /** Replaces the built-in question wording and criteria. */
  readonly questions?: QuestionSpec;
  /** Sessions kept before the oldest is evicted. */
  readonly maxSessions?: number;
  readonly logger?: Logger;
  /** Called after each prompt decision, for telemetry and the TUI. */
  readonly onDecision?: (sessionID: string, decision: StashedDecision) => void;
}

const DEFAULT_MAX_SESSIONS = 500;

/**
 * Holds per-session decisions between the prompt hook and the model calls
 * that follow it. Pure state plus the decision call; no harness types.
 */
export class DecisionRouter {
  private readonly stashed = new Map<string, StashedDecision>();
  private readonly logger: Logger;
  private readonly maxStateChars: number;
  private readonly keywords: readonly string[];
  private readonly maxSessions: number;

  constructor(private readonly options: RouterOptions = {}) {
    this.logger = options.logger ?? NULL_LOGGER;
    this.maxStateChars = options.maxStateChars ?? 4000;
    this.keywords = options.keywords ?? ["ultrathink"];
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** The decision stashed for a session, if any. */
  get(sessionID: string): StashedDecision | undefined {
    return this.stashed.get(sessionID);
  }

  clear(sessionID: string): void {
    this.stashed.delete(sessionID);
  }

  /**
   * Decides once per new prompt. A replayed admission of the same prompt
   * reuses the stash instead of paying for a second decision.
   */
  async onPrompt(event: PromptEvent): Promise<StashedDecision | undefined> {
    try {
      const text = event.text.trim();
      if (!text) return undefined;

      if (event.pinned) {
        this.clear(event.sessionID);
        return undefined;
      }

      const promptHash = hashPrompt(
        `${event.sessionID}:${text.slice(-this.maxStateChars)}`,
      );
      const previous = this.stashed.get(event.sessionID);
      if (previous?.promptHash === promptHash) return previous;

      const keyword = findMaxKeyword(text, this.keywords);
      if (keyword) {
        return this.remember(event.sessionID, {
          promptHash,
          effort: "xhigh",
          keyword,
        });
      }

      const decision = await decide(
        buildState(text, {}, this.maxStateChars),
        this.options.policy,
        await this.requestOptions(),
        this.options.questions,
      );
      return this.remember(event.sessionID, {
        promptHash,
        effort: decision.effort,
        choice: decision.rawChoice,
        confidence: decision.confidence,
        highStakes: decision.highStakes,
        bumpedForStakes: decision.bumpedForStakes,
        lowConfidence: decision.lowConfidence,
      });
    } catch (error) {
      this.logger.debug("prompt decision skipped", error);
      return undefined;
    }
  }

  /**
   * The effort to apply to a model request. Uses the stashed prompt decision
   * and only decides on the spot when the session has none (synthetic
   * messages, sessions that started before the plugin loaded).
   */
  async onContext(event: ContextEvent): Promise<StashedDecision | undefined> {
    try {
      if (event.pinned) return undefined;

      const hit = this.stashed.get(event.sessionID);
      if (hit) return hit;

      const text = lastUserText(event.messages);
      if (!text) return undefined;

      const keyword = findMaxKeyword(text, this.keywords);
      if (keyword) {
        return this.remember(event.sessionID, {
          promptHash: hashPrompt(`${event.sessionID}:${text}`),
          effort: "xhigh",
          keyword,
        });
      }

      const model = `${event.model.providerID}/${event.model.modelID}`;
      const state = buildState(
        text,
        { agent: event.agent, model },
        this.maxStateChars,
      );
      const decision: Decision = await decide(
        state,
        this.options.policy,
        await this.requestOptions(),
        this.options.questions,
      );
      return this.remember(event.sessionID, {
        promptHash: hashPrompt(`${event.sessionID}:${state}`),
        effort: decision.effort,
        choice: decision.rawChoice,
        confidence: decision.confidence,
        highStakes: decision.highStakes,
        bumpedForStakes: decision.bumpedForStakes,
        lowConfidence: decision.lowConfidence,
      });
    } catch (error) {
      this.logger.debug("context decision skipped", error);
      return undefined;
    }
  }

  private async requestOptions(): Promise<DecisionRequestOptions> {
    const request = this.options.request;
    if (typeof request === "function") return request();
    return request ?? {};
  }

  private remember(
    sessionID: string,
    decision: StashedDecision,
  ): StashedDecision {
    if (this.stashed.size >= this.maxSessions && !this.stashed.has(sessionID)) {
      const oldest = this.stashed.keys().next();
      if (!oldest.done) this.stashed.delete(oldest.value);
    }
    this.stashed.set(sessionID, decision);
    this.options.onDecision?.(sessionID, decision);
    return decision;
  }
}
