// OpenCode adapter: two session hooks plus the jevos server lifecycle.
//
// The prompt hook decides once per user prompt and stashes the result; the
// context hook applies it to every model call that follows, so the tool loop
// does not pay for a second decision.

import { Plugin } from "@opencode/plugin";
import { join } from "node:path";
import {
  applyEffort,
  buildCatalog,
  catalogKey,
  cacheRoot,
  createLogger,
  defaultReuseDirs,
  DecisionRouter,
  jevLogPath,
  JevInstaller,
  JevServer,
  releaseTarget,
  type CatalogEntry,
  type CatalogModel,
  type EffortLevel,
  type StashedDecision,
} from "../core/index.ts";
import { agentIncluded, readConfig, type PluginConfig } from "./config.ts";
import { DynamicEffort } from "./rpc.ts";

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
      const config = readConfig(ctx.options);
      const root = cacheRoot();
      const logger = createLogger({
        debug: config.debug,
        file: join(root, "dynamic-effort.log"),
      });
      logger.debug("setup", {
        endpoint: config.endpoint ?? "local",
        defaultEffort: config.defaultEffort,
        maxEffort: config.maxEffort,
      });

      // A configured endpoint means someone else runs the model: no server.
      const usesLocalServer = !config.endpoint;
      const target = releaseTarget(process.platform, process.arch);
      const installer = target
        ? new JevInstaller({
            root,
            logger,
            target,
            path: config.jevPath ?? null,
            reuseDirs: [...config.jevReuseDirs, ...defaultReuseDirs()],
          })
        : null;
      const server =
        usesLocalServer && installer
          ? new JevServer({
              install: () => installer.ensure(),
              port: config.jevPort,
              threads: config.jevThreads,
              logger,
              logPath: jevLogPath(root),
              root,
              idleMs: config.jevIdleMs,
            })
          : null;

      if (!target) {
        logger.warn(
          "no jevos release for this platform; leaving model defaults",
          { platform: process.platform, arch: process.arch },
        );
      }

      // Resolved per decision: a lazily started server has no URL until it
      // answers, and a failed start must fall back to model defaults.
      const requestOptions = async () => ({
        endpoint: config.endpoint ?? (await server?.ensure()) ?? undefined,
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });

      // Warm the server so the first prompt does not pay the model load.
      if (server) void server.ensure().catch(() => {});

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
      const registration = await ctx.rpc.register(DynamicEffort, {
        getDecision: async (input) => {
          const sessionID = (input as { sessionID?: unknown }).sessionID;
          if (typeof sessionID !== "string") return {};
          const record = records.get(sessionID);
          return record ? defined(record) : {};
        },
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

      const router = new DecisionRouter({
        policy: {
          defaultEffort: config.defaultEffort,
          maxEffort: config.maxEffort,
          minConfidence: config.minConfidence,
          stakesThreshold: config.stakesThreshold,
        },
        request: requestOptions,
        maxStateChars: config.maxStateChars,
        keywords: config.keywords,
        questions: config.questions,
        logger,
      });

      await ctx.session.hook("prompt", async (event) => {
        const text = event.prompt?.text ?? "";
        if (!text.trim()) return;

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

      return () => {
        void registration.dispose();
        void server?.stop();
      };
    },
  }),

  async server() {
    return {};
  },
};
