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
```

The integration suite skips itself when no server answers.

## License

MIT
