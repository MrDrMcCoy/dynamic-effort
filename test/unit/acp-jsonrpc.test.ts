import { describe, expect, test } from "bun:test";
import {
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  parseLine,
} from "../../src/acp/jsonrpc.ts";

describe("parseLine", () => {
  test("reads a request, a notification, and a response", () => {
    expect(
      parseLine('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}'),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {},
    });
    expect(parseLine('{"jsonrpc":"2.0","method":"session/cancel"}')).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
    });
    expect(
      parseLine('{"jsonrpc":"2.0","id":"a","result":{"sessionId":"s"}}'),
    ).toEqual({ jsonrpc: "2.0", id: "a", result: { sessionId: "s" } });
  });

  test("returns null for blank, malformed, and non-object lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("{")).toBeNull();
    expect(parseLine("null")).toBeNull();
    expect(parseLine('"text"')).toBeNull();
  });
});

describe("message kinds", () => {
  test("requests have a method and an id", () => {
    const message = { jsonrpc: "2.0" as const, id: 3, method: "x" };
    expect(isRequest(message)).toBe(true);
    expect(isNotification(message)).toBe(false);
    expect(isResponse(message)).toBe(false);
  });

  test("notifications have a method and no id", () => {
    const message = { jsonrpc: "2.0" as const, method: "x" };
    expect(isNotification(message)).toBe(true);
    expect(isRequest(message)).toBe(false);
    expect(isResponse(message)).toBe(false);
  });

  test("responses have no method", () => {
    const message = {
      jsonrpc: "2.0" as const,
      id: null,
      error: { code: 1, message: "x" },
    };
    expect(isResponse(message)).toBe(true);
    expect(isRequest(message)).toBe(false);
    expect(isNotification(message)).toBe(false);
  });
});

describe("encodeMessage", () => {
  test("writes one line", () => {
    expect(encodeMessage({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"x"}\n',
    );
  });
});
