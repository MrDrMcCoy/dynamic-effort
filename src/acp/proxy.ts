// The ACP proxy: it sits between an ACP client (the editor) and a real ACP
// agent, decides an effort level per prompt, and sets it through the agent's
// own thought-level selector before the prompt reaches the agent.
//
// Everything the proxy does not need to understand is forwarded untouched.

import { contentToText } from "../core/effort.ts";
import type { DecisionRouter, StashedDecision } from "../core/router.ts";
import type { Logger } from "../core/log.ts";
import { NULL_LOGGER } from "../core/log.ts";
import {
  isNotification,
  isRequest,
  isResponse,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./jsonrpc.ts";
import {
  findThoughtLevel,
  isCurrent,
  mapEffort,
  type ThoughtLevelOption,
} from "./options.ts";
import type { Transport } from "./transport.ts";

/** What the proxy remembers about one session. */
interface SessionState {
  option: ThoughtLevelOption | null;
  /** The user picked an effort themselves; leave the session alone. */
  pinned: boolean;
}

interface Forwarded {
  readonly clientId: RpcId;
  readonly onResponse?: (response: RpcResponse) => void;
}

export interface ProxyOptions {
  readonly client: Transport;
  readonly agent: Transport;
  readonly router: DecisionRouter;
  readonly logger?: Logger;
  /** Set an effort on every prompt; false makes the proxy a pass-through. */
  readonly applyEffort?: boolean;
  /** How long to wait for the agent to accept a config change. */
  readonly applyTimeoutMs?: number;
  /** Called after a decision, for logging and telemetry. */
  readonly onDecision?: (sessionId: string, decision: StashedDecision) => void;
  /** Called once when either side closes. */
  readonly onClose?: () => void;
}

const DEFAULT_APPLY_TIMEOUT_MS = 5000;
const SESSION_NEW_METHODS = new Set([
  "session/new",
  "session/load",
  "session/resume",
]);
const SESSION_END_METHODS = new Set(["session/close", "session/delete"]);

/**
 * Routes ACP traffic in both directions. Requests from the client are
 * renumbered so the proxy can tell its own agent calls apart; responses are
 * mapped back before they reach the client.
 */
export class AcpProxy {
  private readonly logger: Logger;
  private readonly applyEffort: boolean;
  private readonly applyTimeoutMs: number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly forwarded = new Map<RpcId, Forwarded>();
  private readonly own = new Map<
    RpcId,
    { resolve: (response: RpcResponse) => void }
  >();
  private counter = 0;
  private closed = false;
  private reportedNoOption = false;

  constructor(private readonly options: ProxyOptions) {
    this.logger = options.logger ?? NULL_LOGGER;
    this.applyEffort = options.applyEffort ?? true;
    this.applyTimeoutMs = options.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  }

  start(): void {
    this.options.client.onMessage((message) => {
      void this.fromClient(message);
    });
    this.options.agent.onMessage((message) => {
      void this.fromAgent(message);
    });
    this.options.client.onClose(() => this.shutdown());
    this.options.agent.onClose(() => this.shutdown());
  }

  private async fromClient(message: RpcMessage): Promise<void> {
    // Responses and notifications carry no method to intercept.
    if (!isRequest(message)) {
      this.options.agent.write(message);
      return;
    }

    if (message.method === "session/prompt") {
      await this.handlePrompt(message);
      return;
    }
    if (message.method === "session/set_config_option") {
      this.markPinned(message.params);
    }
    if (SESSION_NEW_METHODS.has(message.method)) {
      this.forward(message, (response) => this.learnSession(response));
      return;
    }
    if (SESSION_END_METHODS.has(message.method)) {
      this.forgetSession(message.params);
    }
    this.forward(message);
  }

  private async fromAgent(message: RpcMessage): Promise<void> {
    if (isResponse(message)) {
      const forwarded = this.forwarded.get(message.id as RpcId);
      if (forwarded) {
        this.forwarded.delete(message.id as RpcId);
        this.options.client.write({
          ...message,
          id: forwarded.clientId,
        } as RpcResponse);
        forwarded.onResponse?.(message);
        return;
      }
      const own = this.own.get(message.id as RpcId);
      if (own) {
        this.own.delete(message.id as RpcId);
        own.resolve(message);
        return;
      }
      this.options.client.write(message);
      return;
    }
    if (isNotification(message)) {
      if (message.method === "session/update") this.trackUpdate(message.params);
      this.options.client.write(message);
      return;
    }
    this.options.client.write(message);
  }

  private forward(
    message: RpcRequest,
    onResponse?: (response: RpcResponse) => void,
  ): void {
    const id: RpcId = `c${++this.counter}`;
    this.forwarded.set(id, { clientId: message.id, onResponse });
    this.options.agent.write({ ...message, id });
  }

  /** Calls the agent and waits a bounded time for the answer. */
  private call(method: string, params: unknown): Promise<RpcResponse> {
    const id: RpcId = `p${++this.counter}`;
    return new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        resolve({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "the agent did not answer in time" },
        });
      }, this.applyTimeoutMs);
      timer.unref?.();
      this.own.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      });
      this.options.agent.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async handlePrompt(message: RpcRequest): Promise<void> {
    const params = message.params as
      | { sessionId?: unknown; prompt?: unknown }
      | undefined;
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : "";
    const text = contentToText(params?.prompt);

    if (sessionId && text && this.applyEffort) {
      const state = this.session(sessionId);
      const decision = await this.options.router.onPrompt({
        sessionID: sessionId,
        text,
        pinned: state.pinned,
      });
      if (decision) {
        this.options.onDecision?.(sessionId, decision);
        await this.applyDecision(sessionId, decision);
      }
    }
    this.forward(message);
  }

  /** Sets the decided level through the agent's thought-level selector. */
  private async applyDecision(
    sessionId: string,
    decision: StashedDecision,
  ): Promise<void> {
    const state = this.session(sessionId);
    if (!state.option) {
      if (!this.reportedNoOption) {
        this.reportedNoOption = true;
        this.logger.debug("the agent offers no thought-level option");
      }
      return;
    }
    const value = mapEffort(state.option, decision.effort);
    if (value === null) {
      this.logger.debug("no agent value matches the decided level", {
        session: sessionId,
        effort: decision.effort,
        values: state.option.values.map((entry) => entry.value),
      });
      return;
    }
    if (isCurrent(state.option, value)) return;

    const response = await this.call("session/set_config_option", {
      sessionId,
      configId: state.option.id,
      value,
    });
    if (response.error) {
      this.logger.warn("the agent rejected the effort", {
        session: sessionId,
        value,
        error: response.error.message,
      });
      return;
    }
    state.option = { ...state.option, current: value };
    this.logger.info("applied", {
      session: sessionId,
      effort: decision.effort,
      value,
    });
  }

  private learnSession(response: RpcResponse): void {
    const result = response.result as
      | { sessionId?: unknown; configOptions?: unknown }
      | undefined;
    if (typeof result?.sessionId !== "string") return;
    const option = findThoughtLevel(result.configOptions);
    this.sessions.set(result.sessionId, { option, pinned: false });
    this.logger.debug("session started", {
      session: result.sessionId,
      configId: option?.id ?? null,
      values: option?.values.map((entry) => entry.value) ?? [],
    });
  }

  /** Keeps the cached selector current when the agent reports a change. */
  private trackUpdate(params: unknown): void {
    const update = params as
      | { sessionId?: unknown; update?: { configOptions?: unknown } }
      | undefined;
    const sessionId = update?.sessionId;
    if (typeof sessionId !== "string") return;
    const options = update?.update?.configOptions;
    if (!options) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.option = findThoughtLevel(options);
  }

  private markPinned(params: unknown): void {
    const request = params as
      | { sessionId?: unknown; configId?: unknown }
      | undefined;
    if (typeof request?.sessionId !== "string") return;
    const state = this.sessions.get(request.sessionId);
    if (!state) return;
    if (state.option && request.configId === state.option.id) {
      state.pinned = true;
      this.logger.debug("session pinned by the user", {
        session: request.sessionId,
      });
    }
  }

  private forgetSession(params: unknown): void {
    const request = params as { sessionId?: unknown } | undefined;
    if (typeof request?.sessionId !== "string") return;
    this.sessions.delete(request.sessionId);
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { option: null, pinned: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Closes both sides; safe to call more than once. */
  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const error: RpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "the connection closed" },
    };
    for (const pending of this.own.values()) pending.resolve(error);
    this.own.clear();
    this.options.client.close();
    this.options.agent.close();
    this.options.onClose?.();
  }
}

