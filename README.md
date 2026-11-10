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

## pi and oh-my-pi

Both hosts load a TypeScript extension with no build step and expose a
thinking level per prompt, which makes them the best native targets. Load the
extension with `-e`:

```sh
pi -e /path/to/dynamic-effort/src/pi/index.ts
omp -e /path/to/dynamic-effort/src/pi/index.ts
```

A published install uses the built entry:
`pi -e node_modules/@mrdrmccoy/dynamic-effort/dist/pi/index.js`.

To load it in every session, add the path to `settings.json`:

```json
{
  "extensions": ["/path/to/dynamic-effort/src/pi/index.ts"]
}
```

The extension decides on the first prompt of each turn, calls
`setThinkingLevel`, then reads the level back. Before it sets a level it reads
the model's own vocabulary — `thinking.efforts` in omp, `thinkingLevelMap` in
pi — and picks the nearest supported level, with ties going to the stronger
one. A model that offers only `high` and `max` therefore gets `max` for an
`xhigh` decision instead of being clamped down to `high`. The footer shows
`effort xhigh (max)` when the level differs from the decision. A level you
pick yourself pins the session and later prompts leave it alone; the host
echoes the extension's own write, which is not treated as a choice.
`session_shutdown` persists telemetry and stops a server this extension
started.

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
| `DYNAMIC_EFFORT_TELEMETRY` | `0` turns the local ring buffer off. |
| `DYNAMIC_EFFORT_TELEMETRY_PERSIST` | `1` writes the buffer on shutdown. |
| `DYNAMIC_EFFORT_TELEMETRY_CAPACITY` | Entries kept in memory. |
| `DYNAMIC_EFFORT_TELEMETRY_PROMPT_CHARS` | Prompt characters kept per entry. |

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
| `telemetry` | `true` | Keep a local ring buffer of decisions. |
| `telemetryPersist` | `false` | Write the buffer on shutdown. |
| `telemetryCapacity` | `500` | Entries kept in memory. |
| `telemetryPromptChars` | `500` | Prompt characters kept per entry; `0` keeps none. |
| `debug` | `false` | Write decision details to the log. |

## Telemetry

The plugin records each decision locally: the effort, the variant applied,
the model, the confidence and stakes scores, and the token counts when the
harness reports them. The buffer is a fixed-size ring in memory, so a long
session does not grow without limit.

Nothing is written to disk unless `telemetryPersist` is on. Then the buffer
is appended to `telemetry.jsonl` under the cache root on shutdown, one JSON
object per line, rotated once past 5 MB. The data never leaves the machine
and no request sends it anywhere.

`dynamic-effort telemetry` prints a summary over that file:

```
entries: 42 across 7 sessions
applied: 41 of 42
reasoning tokens: 12043
output tokens: 3021
efforts: low=20 minimal=12 high=6 xhigh=4
sources: prompt=40 context=2
```

## Effort tuning

Run `/effort-tune` in a session to review the recorded decisions with the
main model. The tuner sends the current settings, a summary, and up to 200
decision lines, and asks for changes to the question wording, the level
criteria, or the thresholds where the record supports them.

The command runs from the prompt itself, so it works in the TUI and in
`opencode run`. The plugin also registers it for the command palette. After
the review, the prompt is replaced with a short note so the model does not
repeat the work.

The answer comes back as one validated JSON proposal, stored under the
cache root in the `tune` folder. Nothing in your configuration changes by
itself: applying a proposal stays an explicit, diffable step. The newest
20 proposals are kept.

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
