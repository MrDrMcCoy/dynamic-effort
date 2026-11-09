// The slice of JSON-RPC that ACP uses on the wire, plus the helpers the proxy
// needs to tell requests, notifications, and responses apart.

export type RpcId = string | number;

export interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: RpcId | null;
  readonly result?: unknown;
  readonly error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export function isRequest(message: RpcMessage): message is RpcRequest {
  return typeof (message as RpcRequest).method === "string" &&
    (message as RpcRequest).id !== undefined;
}

export function isNotification(
  message: RpcMessage,
): message is RpcNotification {
  return typeof (message as RpcRequest).method === "string" &&
    (message as RpcRequest).id === undefined;
}

export function isResponse(message: RpcMessage): message is RpcResponse {
  return typeof (message as RpcRequest).method !== "string";
}

/** Parses one line, returning null for blank or malformed input. */
export function parseLine(line: string): RpcMessage | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as RpcMessage;
  } catch {
    return null;
  }
}

/** Serialises one message as a single line, newline included. */
export function encodeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
