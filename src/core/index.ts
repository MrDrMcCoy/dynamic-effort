// The core's public surface. Harness adapters import from here only.

export {
  applyEffort,
  buildCatalog,
  buildState,
  bumpEffort,
  catalogKey,
  clampEffort,
  contentToText,
  DEFAULT_MAX_KEYWORDS,
  EFFORT_ORDER,
  findMaxKeyword,
  hashPrompt,
  isEffortLevel,
  lastUserText,
  matchTemplate,
  resolveVariant,
  substituteEffort,
  type AppliedEffort,
  type CatalogEntry,
  type CatalogModel,
  type CatalogVariant,
  type EffortLevel,
  type OptionTemplates,
} from "./effort.ts";

export {
  askSystemOne,
  buildQuestions,
  composeDecision,
  decide,
  DEFAULT_ENDPOINT,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MODEL,
  DEFAULT_QUESTIONS,
  DEFAULT_STAKES_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  resolveEndpoint,
  SYSTEMONE_PATH,
  type ChoiceAnswer,
  type Decision,
  type DecisionPolicy,
  type DecisionRequestOptions,
  type FetchLike,
  type NoulAnswer,
  type QuestionSpec,
  type SystemOneResponse,
} from "./decision.ts";

export {
  DecisionRouter,
  type ContextEvent,
  type PromptEvent,
  type RouterOptions,
  type StashedDecision,
} from "./router.ts";

export { JevInstaller, hashFile, type InstallOptions, type JevInstall } from "./jev/manager.ts";
export {
  JevServer,
  FIRST_PORT,
  LAST_PORT,
  portFree,
  probeHealth,
  type HealthReport,
  type SupervisorOptions,
} from "./jev/server.ts";
export {
  assetUrl,
  binaryAsset,
  DEFAULT_VERSION,
  MODEL_FILES,
  modelAsset,
  normaliseVersion,
  parseSums,
  RELEASE_BASE,
  releaseTarget,
  SUMS_ASSET,
  type ArchiveKind,
  type ReleaseTarget,
} from "./jev/release.ts";

export {
  APP_DIR,
  cacheRoot,
  defaultReuseDirs,
  jevInstallDir,
  jevLogPath,
} from "./paths.ts";
export { createLogger, NULL_LOGGER, type Logger, type LogLevel } from "./log.ts";
