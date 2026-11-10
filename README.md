# dynamic-effort

Adjust a coding agent's reasoning effort to the difficulty of the task. A
small local decision model reads the prompt and answers two questions: how
much reasoning the task needs, and whether a mistake would be costly. The
plugin maps that answer onto the model variant the harness supports.

No prompt leaves the machine. The decision model is
[jev](https://github.com/feder-cr/jev), a CPU-only binary with an
OpenVINO-quantized model.

## How it decides

One decision per user prompt, reused for the tool calls that follow:

1. The prompt hook sends the prompt text to jev and stashes the answer.
2. The context hook applies the stashed effort to every model request in
   that turn, so the tool loop does not pay for more decisions.
3. A low-confidence answer falls back to `defaultEffort`. High stakes bumps
   one level. The result never exceeds `maxEffort`.
4. A prompt containing a max keyword (`ultrathink`) skips the model and
   requests the maximum.

Every failure is fail-open: a missing server, a timeout, or a malformed
answer leaves the harness's own defaults untouched.

## Install

The plugin is not published yet. Use it from a checkout:

```jsonc
// opencode.jsonc
{
  "plugins": [
    { "package": "/path/to/dynamic-effort", "options": {} }
  ]
}
```

The first decision downloads jevos (about 630 MB of model plus a 27 MB
binary) into `~/.cache/dynamic-effort/jev/`. Later starts reuse it. If
another copy of jevos already exists, set `jevPath` or `jevReuseDirs` and
nothing is downloaded.

To install ahead of time:

```sh
bun run src/cli.ts setup
```

From a build, the same command is `node dist/cli.js setup` or, once the
package is published, `npx @mrdrmccoy/dynamic-effort setup`.

## ACP agents

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
gets the same treatment through a proxy. Your editor starts the proxy instead
of the agent, and the proxy starts the agent itself:

```jsonc
// Zed, or any ACP client, as the agent command
"command": "bun",
"args": ["run", "/path/to/dynamic-effort/src/cli.ts", "acp", "--", "opencode", "acp"]
```

Everything after `--` is the agent command; it defaults to `opencode acp`.
A published install uses the built entry instead:
`npx @mrdrmccoy/dynamic-effort acp -- opencode acp`.
The proxy is a pass-through except for one thing: before each prompt it sets
the session's `thought_level` config option, using the value the decision
maps onto. Agents advertise their own vocabulary (opencode offers `low`,
`high`, and `max`), so the abstract level is mapped and never sent raw.

The proxy stays out of the way in these cases:

- The agent offers no `thought_level` option: prompts pass through unchanged.
- You set the effort yourself in the editor: that session is left alone.
- The agent rejects the value or does not answer in time: the prompt is
  forwarded with the session's current effort.
- The decision fails for any reason: nothing is changed.

Coverage depends on the agent. The proxy speaks ACP version 1 and forwards
anything it does not understand, so features such as session loading, modes,
and MCP servers work as if the proxy were not there.

## Environment variables

The ACP proxy has no config file, so it reads `DYNAMIC_EFFORT_` variables.
They sit below explicit options and above the defaults.

| Variable | Meaning |
| --- | --- |
| `DYNAMIC_EFFORT_ENDPOINT` | Full SystemOne URL; skips the local server. |
| `DYNAMIC_EFFORT_API_KEY` | Bearer token for that endpoint. |
| `DYNAMIC_EFFORT_MODEL` | Model name sent to the endpoint. |
| `DYNAMIC_EFFORT_DEFAULT_EFFORT` | Effort used when the answer is unsure. |
| `DYNAMIC_EFFORT_MAX_EFFORT` | Upper bound for every decision. |
| `DYNAMIC_EFFORT_MIN_CONFIDENCE` | Below this the answer is ignored. |
| `DYNAMIC_EFFORT_STAKES_THRESHOLD` | At or above this the effort bumps. |
| `DYNAMIC_EFFORT_TIMEOUT_MS` | Decision deadline. |
| `DYNAMIC_EFFORT_MAX_STATE_CHARS` | Prompt tail sent to the model. |
| `DYNAMIC_EFFORT_PORT` | Local server port. |
| `DYNAMIC_EFFORT_THREADS` | Worker threads for the model. |
| `DYNAMIC_EFFORT_JEV_PATH` | A jevos install to use as-is. |
| `DYNAMIC_EFFORT_DEBUG` | `1` writes decision details to the log. |

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | local server | Full SystemOne URL. Set it to use a server you run yourself. |
| `apiKey` | `JEV_API_KEY` | Bearer token for that endpoint. |
| `model` | `jevos-v5` | Model name sent to the endpoint. |
| `defaultEffort` | `medium` | Effort used when the answer is not confident. |
| `maxEffort` | `xhigh` | Upper bound for every decision. |
| `minConfidence` | `0.35` | Below this the answer is ignored. |
| `stakesThreshold` | `0.7` | At or above this the effort bumps one level. |
| `timeoutMs` | `8000` | Decision deadline. |
| `maxStateChars` | `4000` | Prompt tail sent to the model. |
| `keywords` | `["ultrathink"]` | Whole words that force the maximum. |
| `includeAgents` | all | Only these agents get a decision. |
| `excludeAgents` | `title`, `summary`, `compaction` | These agents never do. |
| `optionTemplates` | none | Per-model request options, `{effort}` substituted. |
| `respectExplicitVariant` | `true` | Skip sessions where you pinned a variant. |
| `jevPort` | `8017` | Local server port; `0` scans for a free one. |
| `jevThreads` | auto | Worker threads for the model. |
| `jevIdleMs` | `600000` | Stop the server after this long unused. |
| `jevPath` | none | A jevos install to use as-is. |
| `jevReuseDirs` | none | Directories to search for an existing install. |
| `questions` | built in | Replace the question wording and criteria. |
| `debug` | `false` | Write decision details to the log. |

## Effort mapping

Abstract levels are `minimal`, `low`, `medium`, `high`, and `xhigh`. A
harness may expose a different scale (`none` through `max`, or settings
such as `reasoningEffort`). The plugin picks the nearest variant on that
scale and, on a tie, the stronger one. If nothing matches, it leaves the
request alone.

## Development

```sh
bun install
bun run typecheck
bun test test/unit
bun test test/integration   # needs a jevos server on port 8017
bun run build               # writes the Node-compatible dist/
node dist/cli.js status
```

The integration suite skips itself when no server answers. `dist/` is
compiled by `tsc` and is not committed; `npm pack` builds it first.

## License

MIT
