// A minimal ACP agent for integration tests: it advertises a thought-level
// selector, records every config change, and answers prompts with an echo.

let buffer = "";
const state = { effort: "default", changes: [] as string[], prompts: 0 };

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message: {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}) {
  if (message.id === undefined) return;
  const reply = (result: unknown) =>
    send({ jsonrpc: "2.0", id: message.id, result });

  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: 1,
        agentInfo: { name: "fake", version: "0.0.0" },
        agentCapabilities: { loadSession: false },
      });
    case "session/new": {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_fake",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
        },
      });
      return reply({
        sessionId: "ses_fake",
        configOptions: [
          {
            id: "effort",
            name: "Effort",
            type: "select",
            category: "thought_level",
            currentValue: state.effort,
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
              { value: "max", name: "Max" },
              { value: "default", name: "Default" },
            ],
          },
        ],
      });
    }
    case "session/set_config_option": {
      state.effort = String(message.params?.["value"]);
      state.changes.push(state.effort);
      return reply({ configOptions: [] });
    }
    case "session/prompt": {
      state.prompts += 1;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_fake",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `effort=${state.effort}` },
          },
        },
      });
      return reply({
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }
    case "session/report":
      return reply({
        effort: state.effort,
        changes: state.changes,
        prompts: state.prompts,
      });
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim()) handle(JSON.parse(line));
  }
});
