// OpenCode adapter: two session hooks plus the jevos server lifecycle.
//
// The prompt hook decides once per user prompt and stashes the result; the
// context hook applies it to every model call that follows, so the tool loop
// does not pay for a second decision.

import { Plugin } from "@opencode/plugin";
import {
  agentIncluded,
  applyEffort,
  buildCatalog,
  catalogKey,
  createRuntime,
  type CatalogEntry,
  type CatalogModel,
  type EffortConfig,
  type EffortLevel,
  type StashedDecision,
} from "../core/index.ts";
import { DynamicEffort } from "./rpc.ts";
import { executeTune, tuneDirectory, TUNE_COMMAND } from "./tune.ts";

export const PLUGIN_ID = "dynamic-effort";

const CATALOG_REFRESH_MS = 5 * 60_000;

interface DecisionRecord {
  session: string;
  agent: string;
  model: string;
  effort: EffortLevel;
  variant?: string;
  applied: boolean;
  choice?: string;
  confidence?: number;
  highStakes?: number;
  keyword?: string;
  source: string;
}

/** Drops undefined fields so the RPC schema stays satisfied. */
function defined(record: DecisionRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

export default {
  ...Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      // Pass the raw options, not readConfig() output: a full config object
      // would shadow every DYNAMIC_EFFORT_* variable. createRuntime merges
      // and validates the layers itself.
      const runtime = createRuntime({
        config: (ctx.options ?? {}) as Partial<EffortConfig>,
      });
      const { config, logger, router, requestOptions, telemetry } = runtime;
      logger.debug("setup", {
        endpoint: config.endpoint ?? "local",
        defaultEffort: config.defaultEffort,
        maxEffort: config.maxEffort,
      });

      let catalog = new Map<string, CatalogEntry>();
      const refreshCatalog = async () => {
        try {
          const out = (await ctx.model.list()) as unknown;
          const models = (
            Array.isArray(out) ? out : ((out as { data?: unknown }).data ?? [])
          ) as CatalogModel[];
          catalog = buildCatalog(models);
        } catch (error) {
          logger.debug("catalog refresh failed", error);
        }
      };
      await refreshCatalog();
      let refreshedAt = Date.now();
      const records = new Map<string, DecisionRecord>();
      /** The text of the newest prompt per session, for telemetry only. */
      const prompts = new Map<string, string>();
      const usageAbort = new AbortController();
      const registration = await ctx.rpc.register(DynamicEffort, {
        getDecision: async (input) => {
          const sessionID = (input as { sessionID?: unknown }).sessionID;
          if (typeof sessionID !== "string") return {};
          const record = records.get(sessionID);
          return record ? defined(record) : {};
        },
      });

      // `/effort-tune` reviews the recorded decisions with the main model.
      // The proposal lands on disk; applying it stays manual.
      await ctx.command.transform((editor) => {
        editor.add({
          name: TUNE_COMMAND,
          description: "Review recorded decisions and propose tuning",
          async execute({ sessionID }) {
            await executeTune(
              {
                config,
                logger,
                telemetry,
                telemetryPath: runtime.telemetryPath,
                directory: tuneDirectory(runtime.root),
                async generate(prompt) {
                  const session = (await ctx.session.get({ sessionID })) as {
                    model?: {
                      id: string;
                      providerID: string;
                      variant?: string;
                    } | null;
                  };
                  const model = session?.model ?? null;
                  const out = await ctx.experimental.generate.text({
                    prompt,
                    ...(model ? { model } : {}),
                  });
                  return out.text;
                },
                async report(target, text) {
                  await ctx.session.synthetic({
                    sessionID: target,
                    text,
                    description: "effort tuning",
                  });
                },
              },
              sessionID,
            );
          },
        });
      });

      const publish = async (record: DecisionRecord) => {
        records.set(record.session, record);
        if (records.size > 500) {
          const oldest = records.keys().next();
          if (!oldest.done) records.delete(oldest.value);
        }
        try {
          await registration.events.emit("decided", defined(record) as never);
        } catch {
          // The TUI may not be listening; that is not a failure.
        }
      };

      /** A user-pinned variant on the session model wins over the decision. */
      const sessionPinned = async (sessionID: string): Promise<boolean> => {
        if (!config.respectExplicitVariant) return false;
        try {
          const session = (await ctx.session.get({ sessionID })) as {
            model?: { variant?: string | null } | null;
          };
          return Boolean(session?.model?.variant);
        } catch {
          return false;
        }
      };

      await ctx.session.hook("prompt", async (event) => {
        const text = event.prompt?.text ?? "";
        if (!text.trim()) return;
        prompts.set(event.sessionID, text);
        if (prompts.size > 500) {
          const oldest = prompts.keys().next();
          if (!oldest.done) prompts.delete(oldest.value);
        }

        const decision = await router.onPrompt({
          sessionID: event.sessionID,
          text,
          pinned: await sessionPinned(event.sessionID),
        });
        if (!decision) return;
        logger.debug("decided", {
          session: event.sessionID,
          effort: decision.effort,
          source: "prompt",
        });
      });

      const applyTo = async (
        event: {
          sessionID: string;
          agent: string;
          model: { providerID: string; id: string; variant?: string };
          options: Record<string, unknown>;
        },
        decision: StashedDecision,
        source: string,
      ) => {
        const display = `${event.model.providerID}/${event.model.id}`;
        const entry = catalog.get(
          catalogKey(event.model.providerID, event.model.id),
        );
        if (!entry && Date.now() - refreshedAt > CATALOG_REFRESH_MS) {
          refreshedAt = Date.now();
          void refreshCatalog();
        }

        const applied = applyEffort(
          event.options,
          event.model.providerID,
          event.model.id,
          decision.effort,
          entry,
          config.optionTemplates,
        );
        await publish({
          session: event.sessionID,
          agent: event.agent,
          model: display,
          effort: decision.effort,
          variant: applied.variantId,
          applied: applied.applied,
          choice: decision.choice,
          confidence: decision.confidence,
          highStakes: decision.highStakes,
          keyword: decision.keyword,
          source,
        });
        if (config.telemetry) {
          telemetry.append({
            session: event.sessionID,
            agent: event.agent,
            model: display,
            effort: decision.effort,
            variant: applied.variantId,
            applied: applied.applied,
            choice: decision.choice,
            confidence: decision.confidence,
            highStakes: decision.highStakes,
            keyword: decision.keyword,
            source,
            promptHash: decision.promptHash,
            prompt: prompts.get(event.sessionID),
          });
        }
        logger.debug("applied", {
          session: event.sessionID,
          model: display,
          effort: decision.effort,
          variant: applied.variantId,
          applied: applied.applied,
        });
      };

      await ctx.session.hook("context", async (event) => {
        if (!agentIncluded(config, event.agent)) return;
        if (config.respectExplicitVariant && event.model.variant) return;

        const stashed = router.get(event.sessionID);
        if (stashed) {
          await applyTo(event, stashed, "prompt");
          return;
        }

        const decision = await router.onContext({
          sessionID: event.sessionID,
          agent: event.agent,
          model: {
            providerID: event.model.providerID,
            modelID: event.model.id,
          },
          messages: event.messages,
        });
        if (!decision) return;
        await applyTo(event, decision, "context");
      });

      // Token counts arrive on their own event, after the request finishes.
      if (config.telemetry) {
        void (async () => {
          try {
            const events = ctx.event.subscribe({
              types: ["session.usage.updated"],
              signal: usageAbort.signal,
            });
            for await (const event of events) {
              const data = (event as { data?: unknown }).data as
                | {
                    sessionID?: unknown;
                    tokens?: {
                      input?: number;
                      output?: number;
                      reasoning?: number;
                      cache?: { read?: number; write?: number };
                    };
                  }
                | undefined;
              if (typeof data?.sessionID !== "string" || !data.tokens) continue;
              telemetry.stampUsage(data.sessionID, {
                input: data.tokens.input ?? 0,
                output: data.tokens.output ?? 0,
                reasoning: data.tokens.reasoning ?? 0,
                cacheRead: data.tokens.cache?.read ?? 0,
                cacheWrite: data.tokens.cache?.write ?? 0,
              });
            }
          } catch (error) {
            logger.debug("usage subscription ended", error);
          }
        })();
      }

      return () => {
        usageAbort.abort();
        void registration.dispose();
        void runtime.stop();
      };
    },
  }),

  async server() {
    return {};
  },
};
