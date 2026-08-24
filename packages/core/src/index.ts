/**
 * Public export surface.
 *
 * The library is the contract: `import { Runtime }` is as first-class as the CLI, and every
 * surface — CLI, server, Docker image — is a consumer of what is exported here.
 */

export type { Brand } from "./brand.ts"
export {
    BRAND,
    BRAND_OVERRIDE_ENV,
    brandFromSlug,
    DEFAULT_BRAND,
    deriveBrand,
    SLUG_PATTERN,
    titleCaseSlug,
} from "./brand.ts"
export type {
    ChannelBinding,
    ChannelHost,
    ChannelLimits,
    ChannelStatus,
    ChannelTransport,
    InboundMessage,
    OutboundMessage,
    RawInbound,
    SendResult,
    WebhookDelivery,
    WebhookOutcome,
} from "./channels/channel.ts"
export { type InboundDecision, Inbox, type InboxOptions, isAllowed } from "./channels/inbox.ts"
export {
    type DeliveryGroupParts,
    type DrainReport,
    deliveryGroup,
    deliveryKey,
    type EnqueueReply,
    Outbox,
    type OutboxOptions,
} from "./channels/outbox.ts"
export { type SplitOptions, splitMessage } from "./channels/split.ts"
export { type Activatable, type ActivationLimits, activate } from "./context/activate.ts"
export {
    type AssembledContext,
    type AssembleInput,
    assembleContext,
    slotReport,
} from "./context/assemble.ts"
export {
    type ContextBlock,
    SLOT,
    type SlotName,
    type SlotNumber,
    skillHeader,
    VOLATILE_HEADER,
} from "./context/blocks.ts"
export {
    type ConfigSummaryInput,
    renderConfigSummary,
} from "./context/config-summary.ts"
export { estimateMessageTokens, estimateTokens } from "./context/tokens.ts"
export {
    AbortedError,
    ConfigError,
    type ErrorDetail,
    HarnessError,
    ModelError,
    ToolError,
} from "./errors.ts"
export { EventBus, type EventBusOptions, type EventHandler } from "./events/bus.ts"
export type {
    AnyEvent,
    ContextSlotReport,
    EventContext,
    EventDataMap,
    EventEnvelope,
    EventType,
    TurnEndReason,
} from "./events/types.ts"
export { newStepId, newTurnId } from "./loop/ids.ts"
export { runStep, type StepInput, type StepResult } from "./loop/step.ts"
export {
    runTurn,
    type ToolRuntime,
    type TurnInput,
    type TurnLimits,
    type TurnResult,
} from "./loop/turn.ts"
export { type EndContext, endedBadly, endNote } from "./loop/turn-end.ts"
export {
    editManifest,
    editManifestSync,
    type ManifestEdit,
    type ManifestEditResult,
    manifestDocument,
    manifestValueAt,
    type PreparedEdit,
    parseSettingValue,
    plain,
    prepareManifestEdit,
} from "./manifest/edit.ts"
export {
    type EnvOverride,
    type EnvSource,
    envOverrides,
    envReferencesIn,
    expandEnvDeep,
    layeredEnv,
    mergeEnv,
    parseDotEnv,
} from "./manifest/env.ts"
export { type ManifestHeader, readManifestHeader } from "./manifest/header.ts"
export {
    defineAgent,
    type LoadedManifest,
    type LoadOptions,
    loadManifest,
    loadManifestFromObject,
} from "./manifest/load.ts"
export {
    type ProviderFields,
    type ProviderPlan,
    type ProviderSelection,
    providerIds,
    resolveProviders,
} from "./manifest/providers.ts"
export { resolveRefs, shallowMerge } from "./manifest/refs.ts"
export type {
    AgentManifest,
    ChannelConfig,
    ContextConfig,
    DeliveryConfig,
    LimitsConfig,
    MemoryConfig,
    ModelCapabilitiesOverride,
    ModelConfig,
    ModelRole,
    ModelRoleConfig,
    PhaseConfig,
    ScheduleConfig,
    ServerConfig,
    SkillsConfig,
    ThresholdsConfig,
    ToolsConfig,
} from "./manifest/schema.ts"
export { AgentManifestSchema, MODEL_ROLES } from "./manifest/schema.ts"
export {
    AGENT_SETTABLE_PATHS,
    PERSON_SETTABLE_PATHS,
    SETTINGS,
    type Setting,
    settingByPath,
} from "./manifest/settings.ts"
export {
    assertApiVersion,
    scanForLiteralSecrets,
    type ValidateOptions,
    validateManifest,
} from "./manifest/validate.ts"
export { setInSource, uncommentInSource } from "./manifest/yaml-edit.ts"
export {
    CAPABILITY_REGISTRY,
    type CapabilityEntry,
    describeWindowSource,
    globToRegExp,
    type ModelCapabilities,
    matchCapabilities,
    patternSpecificity,
    resolveCapabilities,
    type WindowProvenance,
    type WindowSource,
    windowProvenance,
} from "./model/capabilities.ts"
export {
    type ChatCompletionsConfig,
    createChatCompletionsProvider,
    DEFAULT_RETRY,
    type RetryPolicy,
} from "./model/chat-completions.ts"
export {
    DEFAULT_PROMPT_STYLE,
    defaultPromptStyle,
    type ExtractedExamples,
    extractExamples,
    type PromptStyle,
    type PromptStyleClass,
    parameterBillions,
    promptStyleClass,
    renderPromptStyle,
    SMALL_MODEL_BILLIONS,
} from "./model/prompt-style.ts"
export type {
    ChatChunk,
    ChatMessage,
    ChatRequest,
    FetchLike,
    ModelProvider,
    ToolCallRequest,
    ToolDefinition,
} from "./model/provider.ts"
export {
    type ResolvedRole,
    type ResolvedRoles,
    type ResolveRolesOptions,
    type RoleWindow,
    requestParamsFor,
    resolveRoles,
    windowReport,
} from "./model/roles.ts"
export { parseSSE, type SSEEvent } from "./model/sse.ts"
export { nearest } from "./nearest.ts"
export {
    Agent,
    type AgentCreateOptions,
    type AgentDescription,
    type AgentSendOptions,
    resolveWorkspace,
} from "./runtime/agent.ts"
export {
    type ChannelFactory,
    type ChannelFactoryContext,
    ChannelHub,
    type ChannelHubOptions,
} from "./runtime/channels.ts"
export {
    claimLeases,
    LEASE_BEAT_MS,
    LEASE_STALE_MS,
    type LeaseOutcome,
    // Exported so a front end asking "is this lease real?" uses the same witness the runtime does.
    // Two definitions of alive is how a status command comes to disagree with the thing it reports.
    processAlive,
} from "./runtime/lease.ts"
export {
    type AgentSource,
    type BootReport,
    buildChannels,
    defaultStorePath,
    Runtime,
    type RuntimeOptions,
    type StoreSource,
} from "./runtime/runtime.ts"
export { checkSkillAuthoring } from "./skills/authoring.ts"
export {
    isSkillName,
    type ParsedSkillFile,
    parseSkillFile,
    type SkillFrontmatter,
    whenNotToUseKey,
} from "./skills/frontmatter.ts"
export {
    cachePath as skillsCachePath,
    type LoadSkillsOptions,
    loadSkills,
    type Skill,
    type SkillCatalogue,
} from "./skills/index.ts"
export {
    type ActivateSkillsOptions,
    type Activation,
    type ActiveSkill,
    activateSkills,
} from "./skills/load.ts"
export {
    type InterpreterInput,
    interpreterFor,
    type ScriptPlan,
    type ScriptResolution,
    scriptSlug,
} from "./skills/scripts.ts"
export {
    bm25Selector,
    type ScoredSkill,
    type SkillSelector,
    terms as skillTerms,
} from "./skills/select.ts"
export {
    renderScripts,
    type SkillToolOptions,
    scriptSpec,
    skillScriptTools,
} from "./skills/tools.ts"
export {
    type TurnAttachment,
    type TurnBufferState,
    TurnStreams,
    type TurnStreamsOptions,
} from "./store/buffer.ts"
export {
    formatSessionKey,
    isSessionKey,
    parseSessionKey,
    type SessionParts,
} from "./store/session-key.ts"
export {
    type OpenOptions,
    openDatabase,
    type SqlDatabase,
    type SqlParam,
    type SqlRunResult,
    type SqlStatement,
    type SqlValue,
    setUserVersion,
    userVersion,
} from "./store/sqlite/driver.ts"
export {
    MIGRATIONS,
    type Migration,
    type MigrationReport,
    migrate,
} from "./store/sqlite/migrations.ts"
export { openMemoryStore, SqliteStore, type SqliteStoreOptions } from "./store/sqlite/store.ts"
export type {
    AgentFootprint,
    DeliveryRecord,
    DeliveryStatus,
    EnqueueDelivery,
    EnqueueResult,
    KVStore,
    MessagePage,
    MessageStore,
    OutboxStore,
    SessionRecord,
    SessionStore,
    SessionSummary,
    Store,
    StoredMessage,
    TurnRecord,
    TurnStatus,
    TurnStore,
} from "./store/store.ts"
export {
    type Coercion,
    type CoercionFailure,
    type CoercionSuccess,
    coerceArgs,
} from "./tools/coerce.ts"
export {
    type DialectId,
    type ParsedOutput,
    passThroughFilter,
    type StepOutput,
    type StreamFilter,
    type ToolDialect,
} from "./tools/dialect/dialect.ts"
export {
    nativeDialect,
    nativeWireTokens,
    parseNative,
    renderNativeDescription,
} from "./tools/dialect/native.ts"
export {
    createNltStreamFilter,
    nltDialect,
    parseNlt,
    renderNltEntry,
} from "./tools/dialect/nlt.ts"
export { renderNotEnabledBlock, renderNotEnabledText } from "./tools/dialect/not-enabled.ts"
export { proseOf } from "./tools/dialect/prose.ts"
export {
    type ApprovalRequest,
    batch,
    type ExecuteInput,
    type ExecuteOutcome,
    executeIntents,
    hashArgs,
    planIntents,
} from "./tools/execute.ts"
export {
    LOCAL_PROVIDER_ID,
    LOCAL_TOOL_SLUGS,
    localProvider,
    MEMORY_DIR,
    MEMORY_FILE,
    toolContext,
} from "./tools/local.ts"
export {
    type Authorization,
    type AuthorizeInput,
    authorize,
    DEFAULT_POLICY,
    decidePolicy,
    NEVER_STRIPPED,
    onceOnlyTools,
    type ParsedPolicy,
    type PolicyConfig,
    type PolicyDecision,
    type PolicyEffect,
    type PolicyMode,
    type PolicyQuery,
    parsePolicy,
    resolveWithoutApprover,
    subcommands,
} from "./tools/policy.ts"
export {
    applyBudget,
    DEFAULT_TOOL_BUDGET,
    type DroppedTool,
    type RegistryOptions,
    type ToolBudget,
    ToolRegistry,
} from "./tools/registry.ts"
export { hasControl, stripControl } from "./tools/sanitise.ts"
export {
    GATE_CODE,
    gatedResult,
    gateRefusalText,
    neutraliseMarkers,
    type OnMutate,
    refusedResult,
    renderTrusted,
    type Trust,
    untrustedFence,
    wrapUntrusted,
} from "./tools/trust.ts"
export type {
    FieldError,
    JsonSchemaNode,
    JsonType,
    ScriptRunner,
    ScriptRunRequest,
    ScriptRunResult,
    Tool,
    ToolAvailability,
    ToolContext,
    ToolHandler,
    ToolIntent,
    ToolParameters,
    ToolProvider,
    ToolProviderContext,
    ToolProviderFactory,
    ToolProviderRefresh,
    ToolResult,
    ToolSpec,
    WorkspaceWriteTarget,
} from "./tools/types.ts"
export { VERSION } from "./version.ts"
export {
    type AuthoringInput,
    BULLET_DENSITY_LIMIT,
    checkAuthoring,
    EXAMPLE_OVERLAP_LIMIT,
    EXAMPLES_MAX,
    EXAMPLES_MIN,
    PROHIBITION_LIMIT,
} from "./workspace/authoring.ts"
export type {
    Editable,
    Frontmatter,
    ParsedFile,
    ParsedKnowledgeFile,
    Tier,
} from "./workspace/frontmatter.ts"
export {
    parseKnowledgeFile,
    parseWorkspaceFile,
    strip as stripWorkspaceText,
} from "./workspace/frontmatter.ts"
export {
    activateKnowledge,
    type KnowledgeBase,
    type KnowledgeEntry,
    type KnowledgeSelector,
    keywordSelector,
    type LoadKnowledgeOptions,
    loadKnowledge,
} from "./workspace/knowledge.ts"
export {
    DEFAULT_WORKSPACE_BUDGETS,
    emptyWorkspace,
    loadWorkspace,
    planWorkspace,
    type RulesConfig,
    ruleBudgetFailure,
    type Workspace,
    type WorkspaceBudgets,
    type WorkspaceFile,
    type WorkspaceFileRef,
    type WorkspacePlan,
    workspaceRefs,
    writeTarget,
} from "./workspace/load.ts"
export {
    allowedRules,
    type CountedRule,
    checkRules,
    countRules,
    type RuleCheck,
    rulesBlocksOnly,
} from "./workspace/rules.ts"
export {
    planSoul,
    type SoulClass,
    type SoulGateConfig,
    type SoulPlan,
    soulClass,
    windowRequirementMet,
} from "./workspace/soul.ts"
