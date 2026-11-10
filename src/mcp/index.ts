// A minimal MCP server over stdio. The harness asks for an effort level and
// applies it itself, so this is the weakest integration: advisory only. It
// exists because any MCP-capable client can use it with no plugin support.
//
//   dynamic-effort mcp
//
// Tools:
//   decide_effort  { prompt, agent?, model? } -> { effort, confidence, ... }

import { createRuntime, type RuntimeOptions } from "../core/index.ts";
import {
  isNotification,
  isRequest,
  type RpcMessage,
} from "../acp/jsonrpc.ts";
import { stdioTransport, type Transport } from "../acp/transport.ts";

export const SERVER_NAME = "dynamic-effort";
export const SERVER_VERSION = "0.1.0";
export const TOOL_NAME = "decide_effort";
export const PROTOCOL_VERSION = "2025-06-18";

export const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    "Choose a reasoning effort for one prompt. Returns the level to use " +
    "for the whole turn, with the confidence behind it.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user prompt to judge.",
      },
      agent: {
        type: "string",
        description: "The agent that will run the prompt.",
      },
      model: {
        type: "string",
        description: "The model that will run the prompt, as provider/id.",
      },
    },
    required: ["prompt"],
  },
} as const;

export interface McpOptions {
  runtime?: RuntimeOptions;
  transport?: Transport;
}

/** The JSON-RPC result for one request, or null to send nothing. */
type Handler = (params: unknown) => Promise<unknown>;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Serves MCP on a transport until it closes. Returns when the peer
 * disconnects.
 */
export async function serveMcp(
  options: RuntimeOptions,
  transport: Transport = stdioTransport(),
): Promise<void> {
  const runtime = createRuntime(options);
  const { config, logger, router, telemetry } = runtime;

  const handlers: Record<string, Handler> = {
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }),
    "tools/list": async () => ({ tools: [TOOL_SCHEMA] }),
    "tools/call": async (params) => {
      const call = asObject(params);
      if (call["name"] !== TOOL_NAME) {
        throw new Error(`unknown tool: ${String(call["name"])}`);
      }
      const args = asObject(call["arguments"]);
      const prompt = asString(args["prompt"]);
      if (!prompt) throw new Error("prompt is required");

      const model = asString(args["model"]);
      const decision = await router.onPrompt({
        sessionID: "mcp",
        text: prompt,
      });
      if (!decision) throw new Error("no decision was made");

      const payload = {
        effort: decision.effort,
        confidence: decision.confidence,
        highStakes: decision.highStakes,
        bumpedForStakes: decision.bumpedForStakes,
        lowConfidence: decision.lowConfidence,
        choice: decision.choice,
        keyword: decision.keyword,
        model: model ?? null,
      };
      logger.debug("decided", { source: "mcp", ...payload });
      if (config.telemetry) {
        telemetry.append({
          session: "mcp",
          agent: asString(args["agent"]),
          model,
          effort: decision.effort,
          applied: true,
          choice: decision.choice,
          confidence: decision.confidence,
          highStakes: decision.highStakes,
          keyword: decision.keyword,
          source: "mcp",
          promptHash: decision.promptHash,
          prompt,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    },
  };

  let closed = false;
  const pending = new Set<Promise<void>>();
  const finish = new Promise<void>((resolve) => {
    transport.onClose(() => {
      if (!closed) {
        closed = true;
        resolve();
      }
    });
  });

  transport.onMessage((message: RpcMessage) => {
    const work = respond(message, handlers, transport, logger);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });

  // The peer can close stdin while a decision is still running, so let the
  // in-flight replies finish before the process exits.
  await finish;
  await Promise.allSettled([...pending]);
  await runtime.stop();
}

async function respond(
  message: RpcMessage,
  handlers: Record<string, Handler>,
  transport: { write(message: RpcMessage): void },
  logger: { debug(message: string, detail?: unknown): void },
): Promise<void> {
  if (!isRequest(message)) {
    // Notifications, including notifications/initialized, need no reply.
    if (isNotification(message)) {
      logger.debug("ignored notification", { method: message.method });
    }
    return;
  }

  const handler = handlers[message.method];
  if (!handler) {
    transport.write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
    return;
  }

  try {
    const result = await handler(message.params);
    transport.write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    transport.write({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/** Convenience wrapper used by the CLI. */
export async function runMcpServer(
  options: RuntimeOptions = {},
): Promise<void> {
  await serveMcp(options);
}
