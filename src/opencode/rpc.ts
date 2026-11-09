// RPC surface: one query for the current decision and one event per change,
// so the TUI footer can show what the plugin chose.

import { Rpc } from "@opencode/plugin/rpc";

const decisionProperties = {
  session: { type: "string" },
  agent: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  variant: { type: "string" },
  applied: { type: "boolean" },
  choice: { type: "string" },
  confidence: { type: "number" },
  highStakes: { type: "number" },
  keyword: { type: "string" },
  source: { type: "string" },
} as const;

export const DynamicEffort = Rpc.define({
  id: "dynamic-effort",
  methods: {
    getDecision: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: decisionProperties,
        additionalProperties: false,
      },
    },
  },
  events: {
    decided: {
      schema: {
        type: "object",
        properties: decisionProperties,
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
});
