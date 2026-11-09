// The pieces every adapter needs at startup: a logger, the decision router,
// and the jevos install and server when no external endpoint is configured.
//
// Keeping this in core means an adapter only translates its own events and
// never repeats the setup.

import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  readConfig,
  type EffortConfig,
} from "./config.ts";
import { envConfig } from "./env.ts";
import {
  cacheRoot,
  defaultReuseDirs,
  jevLogPath,
} from "./paths.ts";
import { createLogger, type Logger } from "./log.ts";
import { JevInstaller } from "./jev/manager.ts";
import { JevServer } from "./jev/server.ts";
import { releaseTarget } from "./jev/release.ts";
import { DecisionRouter } from "./router.ts";
import type { DecisionRequestOptions } from "./decision.ts";

export interface RuntimeOptions {
  /** Adapter options; the defaults are used for anything omitted. */
  readonly config?: Partial<EffortConfig>;
  /** Variables to read; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** Start the server now instead of at the first decision. */
  readonly warm?: boolean;
}

export interface Runtime {
  readonly config: EffortConfig;
  readonly logger: Logger;
  readonly root: string;
  readonly router: DecisionRouter;
  /** Settings for one decision; safe to call before the server is ready. */
  requestOptions(): Promise<DecisionRequestOptions>;
  /** True when the proxy could not prepare a decision path at all. */
  readonly available: boolean;
  stop(): Promise<void>;
}

/**
 * Builds the shared runtime. Nothing here throws: a platform without a jevos
 * release or an install failure leaves `available` false so the adapter can
 * fall back to the model's own defaults.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  // Explicit options win over the environment, which wins over defaults.
  // readConfig validates every field, so an unset or malformed value falls
  // back instead of reaching the decision call.
  const config = readConfig({
    ...DEFAULT_CONFIG,
    ...envConfig(options.env),
    ...options.config,
  });
  const root = cacheRoot();
  const logger =
    options.logger ??
    createLogger({
      debug: config.debug,
      file: join(root, "dynamic-effort.log"),
    });

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
    !config.endpoint && installer
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
    logger.warn("no jevos release for this platform; leaving model defaults", {
      platform: process.platform,
      arch: process.arch,
    });
  }

  const requestOptions = async (): Promise<DecisionRequestOptions> => ({
    endpoint: config.endpoint ?? (await server?.ensure()) ?? undefined,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });

  if (server && options.warm !== false) {
    void server.ensure().catch(() => {
      // The first decision retries; a warm-up failure is not fatal.
    });
  }

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

  return {
    config,
    logger,
    root,
    router,
    requestOptions,
    available: Boolean(config.endpoint) || server !== null,
    async stop() {
      await server?.stop();
    },
  };
}
