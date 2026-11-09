// Entry point for the ACP proxy mode: read ACP from stdin, drive a real agent
// over its own stdio, apply the decided effort to each prompt.

import { createRuntime, type EffortConfig } from "../core/index.ts";
import { AcpProxy } from "./proxy.ts";
import { spawnTransport, stdioTransport } from "./transport.ts";

export const DEFAULT_AGENT_COMMAND = "opencode";
export const DEFAULT_AGENT_ARGS: readonly string[] = ["acp"];

export interface RunOptions {
  /** The agent to drive; defaults to `opencode acp`. */
  readonly agent: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  };
  readonly config?: Partial<EffortConfig>;
  /** Keep the agent's effort untouched; useful to test the pass-through. */
  readonly applyEffort?: boolean;
}

/**
 * Starts the proxy and resolves when either side closes. Diagnostics go to
 * stderr, so stdout stays clean for ACP.
 */
export async function runAcpProxy(options: RunOptions): Promise<void> {
  const runtime = createRuntime({ config: options.config });
  const { logger } = runtime;
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const proxy = new AcpProxy({
    client: stdioTransport(),
    agent: spawnTransport(options.agent),
    router: runtime.router,
    logger,
    applyEffort: options.applyEffort,
    onClose: () => finish(),
    onDecision: (sessionId, decision) => {
      logger.debug("decided", {
        session: sessionId,
        effort: decision.effort,
        keyword: decision.keyword,
        confidence: decision.confidence,
      });
    },
  });
  logger.debug("proxy started", {
    command: options.agent.command,
    args: options.agent.args ?? [],
  });
  proxy.start();

  const stop = () => {
    proxy.close();
    finish();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  proxy.close();
  await runtime.stop();
}

export { AcpProxy, type ProxyOptions } from "./proxy.ts";
export {
  findThoughtLevel,
  isCurrent,
  mapEffort,
  type SelectOption,
  type ThoughtLevelOption,
} from "./options.ts";
export {
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  parseLine,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./jsonrpc.ts";
export {
  spawnTransport,
  stdioTransport,
  StreamTransport,
  type SpawnOptions,
  type Transport,
} from "./transport.ts";
