/**
 * A single agent: a manifest plus its resolved model roles, identity, and persisted sessions.
 *
 * The workspace is read **once, at load**, and its `static` tier held as one string. That is not
 * an optimization. Slot 0 is half of the cache-stable prefix, and re-reading the files per turn
 * would let an editor save change the prefix mid-session, quietly destroying prompt caching
 * with no error and no symptom other than the bill.
 *
 * Session history lives in the store, and there is no in-memory fallback. A second code path
 * for "no store configured" would be the one exercised by every test and none of production —
 * so the store is a required constructor argument and `Runtime` always supplies one, defaulting
 * to an in-memory SQLite database rather than to a different implementation.
 */

import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { assembleContext, historyReport, slotReport } from "../context/assemble.ts"
import { type Calibration, UNCALIBRATED } from "../context/budget.ts"
import { renderCompactionNotice } from "../context/compaction-notice.ts"
import { renderConfigSummary } from "../context/config-summary.ts"
import { estimateMessageTokens } from "../context/tokens.ts"
import {
    type ErrorDetail,
    envOverridden,
    memoryNotConfigured,
    modelWindowUnknown,
    phaseAllowUnmatched,
    toolGatedAfterFirstUse,
    unknownRetriever,
} from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import { newTurnId } from "../loop/ids.ts"
import { entryPhase, isPhased, unmatchedAllows } from "../loop/phases.ts"
import { runStep } from "../loop/step.ts"
import { runTurn, type ToolRuntime, type TurnCompaction, type TurnResult } from "../loop/turn.ts"
import type { LoadedManifest } from "../manifest/load.ts"
import { resolveProviders } from "../manifest/providers.ts"
import type { AgentManifest } from "../manifest/schema.ts"
import { scheduleDeliveryWarnings } from "../manifest/validate.ts"
import {
    enumerateFiles,
    enumerateSessions,
    fts5Retriever,
    type IndexReport,
    type MemoryRetriever,
    type RetrievedPassage,
    retrieveWithContext,
    selectPassages,
    sessionSource,
    syncFiles,
    syncSessions,
} from "../memory/index.ts"
import type { PromptStyle } from "../model/prompt-style.ts"
import type { ChatMessage } from "../model/provider.ts"
import {
    type ResolvedRoles,
    type ResolveRolesOptions,
    requestParamsFor,
    resolveRoles,
    windowReport,
} from "../model/roles.ts"
import { loadSkills, type SkillCatalogue } from "../skills/index.ts"
import { activateSkills } from "../skills/load.ts"
import { renderScripts, skillScriptTools } from "../skills/tools.ts"
import type { SessionSummary, Store, TurnRecord } from "../store/store.ts"
import { type DialectId, passThroughFilter, type StreamFilter } from "../tools/dialect/dialect.ts"
import { nativeDialect, nativeWireTokens } from "../tools/dialect/native.ts"
import { nltDialect } from "../tools/dialect/nlt.ts"
import { onceOnlyTools } from "../tools/policy.ts"
import { ToolRegistry } from "../tools/registry.ts"
import type { ScriptRunner, Tool } from "../tools/types.ts"
import { activateKnowledge, type KnowledgeBase, loadKnowledge } from "../workspace/knowledge.ts"
import {
    loadWorkspace,
    planWorkspace,
    ruleBudgetFailure,
    type Workspace,
    type WorkspaceFileRef,
    writeTarget,
} from "../workspace/load.ts"
import { planSoul } from "../workspace/soul.ts"

/** Boot-time mtime, or `undefined` for a manifest that never came from a file. */
function mtimeOf(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs
    } catch {
        return undefined
    }
}

/**
 * What the compactor is told. One block, generated, never authored by a manifest.
 *
 * Written as a brief for notes rather than a style instruction, because the *reader* is the same model
 * on its next step and what it needs is facts it can act on: what was asked, what was decided, what a
 * tool established. The last line is the one that matters — a digest that reads as a complete account
 * invites the model to answer from it, and a digest is lossy by construction.
 */
/** The slug whose presence decides whether the notice mentions following a pointer. */
const ARTIFACT_READ = "artifact_read"

/**
 * How much of the compactor's window the digest span may occupy.
 *
 * The rest covers the instruction and the reply. Deliberately a share rather than a subtraction: the
 * compactor may be a 32k model or a 1M one, and a fixed reserve that suits one starves the other.
 */
const DIGEST_SPAN_SHARE = 0.6

/**
 * The newest messages of a span that fit the compactor's window, oldest dropped first.
 *
 * Newest-first because a digest of the recent part is worth more than no digest at all, and because
 * the older part is what earlier compactions have already been over. The caller says so in the
 * instruction when anything was dropped — a digest that silently covers less than it was asked to is
 * the failure this whole path exists to avoid.
 */
function withinWindow(messages: readonly ChatMessage[], window: number): readonly ChatMessage[] {
    const budget = Math.max(1, Math.floor(window * DIGEST_SPAN_SHARE))
    const kept: ChatMessage[] = []
    let spent = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message === undefined) continue
        const cost = estimateMessageTokens(message.content)
        if (spent + cost > budget) break
        spent += cost
        kept.unshift(message)
    }
    return kept
}

const DIGEST_INSTRUCTION = [
    "Summarise the conversation above for your own future reference. You are writing notes to yourself, not a report for a person.",
    "",
    // The requests themselves are kept verbatim beside this digest, so restating them spends the word
    // budget on the one thing that did not need summarising.
    "The person's own requests are preserved verbatim below your summary, so do not restate them.",
    "Keep: decisions taken and why, facts established by tool results, and anything still outstanding.",
    "Drop: pleasantries, your own reasoning, and anything already superseded.",
    "Write plain prose under 300 words. No headings, no preamble, no closing summary.",
    "End with one line naming what this summary does not cover, so a later step knows to ask rather than assume.",
].join("\n")

export interface AgentCreateOptions extends ResolveRolesOptions {
    /**
     * The resolved catalogue. Built by `Runtime` rather than here because resolution is
     * asynchronous — a provider is consulted, and `Agent.create` is not the place to await one.
     */
    readonly tools?: ToolRegistry
    /**
     * How a skill's script runs, supplied from outside because core starts no processes.
     *
     * Omitted means skills are read for their prose and their `scripts/` is not discovered at all —
     * coherent, and what an embedder with no shell wants. Discovered-but-unrunnable would be worse: the
     * model would be told about a tool that refuses.
     */
    readonly scriptRunner?: ScriptRunner
}

export interface AgentSendOptions {
    readonly sessionKey?: string
    readonly signal?: AbortSignal
    readonly source?: string
    /** Supply a turn id to hand a client its handle before the turn starts. */
    readonly turnId?: string
    /**
     * A model role to run this turn on instead of `main`.
     *
     * Exists for schedules: a heartbeat every fifteen minutes and a weekly report have very
     * different worth-paying-for, and expressing that by duplicating an endpoint per schedule is
     * how a base URL comes to be wrong in one place. Resolved through `roles.byName`, which throws
     * on a name the manifest never declared rather than falling back — a silent fallback here means
     * a schedule quietly running on the expensive model forever.
     */
    readonly role?: string
}

export interface AgentDescription {
    readonly id: string
    readonly name: string
    readonly model: string
    readonly window: number
    readonly identityTokensApprox: number
    /** Every workspace file, in load order, whichever tier listed it. */
    readonly contextFiles: readonly string[]
    readonly workspace: readonly {
        readonly name: string
        readonly tier: string
        readonly editable: string
        readonly tokens: number
        readonly budget: number
    }[]
    /** Narrower than it was: it can only ever be one of two, and a reader deciding how to strip an
     * embedded invocation needs that to be a fact rather than a string it has to re-check. */
    readonly dialect: DialectId
    readonly tools: readonly string[]
    /** Tier 3 entries and their gates. Empty when the manifest configures none. */
    readonly knowledge: readonly {
        readonly name: string
        readonly keywords: readonly string[]
        readonly tokens: number
    }[]
    /**
     * What the catalogue costs per turn, whichever channel carries it.
     *
     * Slot 1's blocks under NLT, plus the request's `tools` parameter under native. Summing only the
     * blocks would report a native catalogue as free, which is the reverse of the truth — it is the
     * same schemas, in a place the context budget cannot see.
     */
    readonly catalogueTokens: number
}

/**
 * How many recent turns the cache report reads.
 *
 * Bounded because this runs on every `/context` and a long session's turn list is unbounded, and 50 is
 * enough for a ratio to be stable while staying one indexed read. A session's *whole* history is a
 * question for an eval with a query, not for a status command.
 */
const CACHE_REPORT_TURNS = 50

export class Agent {
    readonly id: string
    readonly manifest: AgentManifest
    readonly dir: string
    readonly window: number
    readonly roles: ResolvedRoles
    /** The workspace's `static` tier. Byte-stable for the lifetime of the agent. */
    readonly identity: string
    /** Tiers, budgets, and per-file editability. Slot 0's text is `workspace.static`. */
    readonly workspace: Workspace
    /** Non-fatal load findings, emitted as `agent.warning` by `Runtime`. */
    readonly warnings: readonly ErrorDetail[]
    readonly store: Store
    /**
     * Resolved memory wiring, or `undefined` when the manifest configures none.
     *
     * `carried` is the source name of the workspace file that is *already in the prompt* — slot 4 — and
     * it is excluded from slot 7 rather than from the index, so `memory search` can still find a note
     * saved a minute ago while the model is never told the same thing twice.
     */
    readonly #memory:
        | {
              readonly retrieve: MemoryRetriever
              readonly dir: string
              readonly carried: string | undefined
              readonly maxActive: number
              readonly threshold: number
              readonly budget: number
              /** Index past conversations as well as the notes. See `memory/conversation.ts`. */
              readonly includeHistory: boolean
          }
        | undefined
    /** Resolved once, at load. Never searched, never extended at runtime. */
    readonly tools: ToolRegistry
    /** Tier 3, read once at load. `undefined` when the manifest configures none. */
    readonly knowledge: KnowledgeBase | undefined
    /**
     * Frontmatter and token counts, scanned once at load. `undefined` when none is configured.
     *
     * Bodies are not here on purpose — they are read on activation, at most `maxActive` per turn. See
     * `skills/index.ts` for what that buys and what it costs.
     */
    readonly skills: SkillCatalogue | undefined

    #bus: EventBus
    #toolRuntime: ToolRuntime | undefined
    /**
     * Per-session compaction state, in memory for the process's lifetime.
     *
     * Deliberately not persisted. The calibration is a fact about *this* endpoint's tokeniser as this
     * process saw it, and it is re-learned within a couple of turns — storing it would add a migration
     * and a staleness question (a manifest that changed `model.main` would resume with the previous
     * model's bias) to save two turns of a correction that starts at 1.0 and is never *wrong*, only
     * uncorrected. The reset count is the same: it exists to catch a window that is too small for the
     * configuration, and a fresh process re-earns that within an hour if it is true.
     */
    #calibrations = new Map<string, Calibration>()
    #resets = new Map<string, number>()
    /**
     * Compaction stages run in this session, accumulated the same way `#resets` is.
     *
     * Not persisted, for the same reason the calibration is not: compaction rewrites the prompt and
     * never the store, so a resumed session re-reads the whole conversation and re-compacts it. A
     * count carried across a restart would describe work that is about to be redone.
     */
    #compactions = new Map<string, number>()
    /**
     * Phase per session, cached in front of the store.
     *
     * Unlike the calibration this *is* persisted — in `sessions.phase`, a column that has existed since
     * Phase 2 with `setPhase` beside it, so no migration was needed. It has to survive a restart because
     * it is a statement about where a conversation got to: resuming a triage-then-act session in `triage`
     * would silently take away tools the agent had already earned, and the model's own history would
     * show it using them.
     */
    #phases = new Map<string, string>()
    /** Absent when the embedder supplied none; then a skill's scripts are never discovered. */
    readonly #scriptRunner: ScriptRunner | undefined
    /**
     * Slot 2, rendered **lazily and once**.
     *
     * Lazy because the block reports runtime *state* — whether channels are actually connected and
     * the HTTP surface actually bound — and neither is known when the agent is constructed: channels
     * start later in `Runtime.create`, and the server binds after it returns. Describing the manifest
     * instead is what made an agent under `run` announce that the Telegram runtime had died, from
     * inside the running process.
     *
     * Once because slot 2 is in the cache-stable prefix. Both setters run during startup, before any
     * turn, and `reportRuntimeState` throws if that stops being true — a silently changed prefix has
     * no symptom except the bill.
     */
    #configSummary: string | undefined
    #channelsStarted = false
    #schedulerStarted = false
    #servedElsewhere = false
    #serverListening = false
    /** Absolute path, or `(object)` for the programmatic path — which has no file to watch. */
    readonly #manifestPath: string
    /** `undefined` when there is no file. Compared after each turn, never polled. */
    #manifestMtime: number | undefined
    #manifestChangeReported = false

    private constructor(init: {
        loaded: LoadedManifest
        roles: ResolvedRoles
        workspace: Workspace
        warnings: readonly ErrorDetail[]
        bus: EventBus
        store: Store
        tools: ToolRegistry
        knowledge: KnowledgeBase | undefined
        skills: SkillCatalogue | undefined
        scriptRunner: ScriptRunner | undefined
    }) {
        this.id = init.loaded.manifest.id
        this.manifest = init.loaded.manifest
        this.dir = init.loaded.dir
        this.window = init.loaded.window
        this.roles = init.roles
        this.workspace = init.workspace
        this.identity = init.workspace.static
        this.warnings = init.warnings
        this.#bus = init.bus
        this.store = init.store
        this.tools = init.tools
        this.knowledge = init.knowledge
        this.skills = init.skills
        this.#scriptRunner = init.scriptRunner

        const memory = init.loaded.manifest.memory
        if (memory === undefined) {
            this.#memory = undefined
        } else {
            if (memory.retriever !== "fts5") {
                throw unknownRetriever(memory.retriever)
            }
            const target = writeTarget(init.workspace)
            this.#memory = {
                retrieve: fts5Retriever({ store: init.store.memory, agentId: this.id }),
                dir: isAbsolute(memory.dir) ? memory.dir : resolve(init.loaded.dir, memory.dir),
                // Only a *writable* target is carried-and-excluded. A refused one is not being written
                // to, so nothing accumulates there and nothing needs excluding.
                carried: target?.mode === "refused" ? undefined : target?.name,
                maxActive: memory.maxActive,
                threshold: memory.threshold,
                budget: memory.budget,
                includeHistory: memory.includeHistory,
            }
        }

        this.#manifestPath = init.loaded.path
        this.#manifestMtime = mtimeOf(init.loaded.path)

        // Configuration, never inference. Reading the model id to pick a dialect would mean behaviour
        // changing silently when someone edits `model.main.id`, and a per-model difference nobody can
        // reproduce is exactly the bug class decision 4.1's opt-in avoids.
        const dialect = this.manifest.tools.dialect === "native" ? nativeDialect : nltDialect

        // Resolved once, here, rather than per call: which file a note goes to is a property of the
        // manifest, and re-deriving it inside a handler would let it disagree with the tier the
        // model is actually shown in slot 3.
        const target = writeTarget(init.workspace)

        // The catalogue is rendered here, once, for the same reason the identity files are read
        // here: slot 1 is half of the cache-stable prefix. Rendering it per turn — or letting its
        // order depend on anything that varies — silently stops prompt caching working, and the only
        // symptom is the bill.
        //
        // `requestTools` is built here too, and not only for symmetry: under native it is where a slug
        // the wire format cannot carry is refused, and "at load" is the only useful place to refuse it.
        if (init.tools.size === 0) {
            this.#toolRuntime = undefined
        } else {
            const specs = init.tools.specs()
            const requestTools = dialect.requestTools(specs)
            this.#toolRuntime = {
                registry: init.tools,
                dialect,
                dir: init.loaded.dir,
                // The catalogue *and* what was left out of it. Both are settled at load, so both
                // belong to the cache-stable prefix; passing `notEnabled` per turn would be the one
                // way to make slot 1 vary and quietly stop prompt caching.
                blocks: dialect.renderCatalogue(specs, init.tools.notEnabled),
                ...(target === undefined ? {} : { writeTarget: target }),
                ...(this.#memory === undefined ? {} : { memoryDir: this.#memory.dir }),
                ...(requestTools === undefined ? {} : { requestTools }),
                wireTokens: requestTools === undefined ? 0 : nativeWireTokens(requestTools),
                observationMaxTokens: this.manifest.context.observationMaxTokens,
                untrustedOnMutate: this.manifest.tools.untrusted.onMutate,
                // Resolved once, here, so every turn of this agent is decided by the same rules.
                // The approver itself is supplied per run by whichever front end has a person
                // attached — absent for a schedule or a pipe, which is exactly when
                // `onNoApprover` matters.
                policy: this.manifest.tools.policy,
            }

            // Said at load, where it can be fixed. Without it, an agent pinning `exec` runs one
            // command per turn and has the second refused — correct behaviour under A5, and
            // indistinguishable from a broken runtime at the moment it happens.
            const onceOnly = onceOnlyTools({
                tools: specs,
                policy: this.manifest.tools.policy,
                onMutate: this.manifest.tools.untrusted.onMutate,
            })
            if (onceOnly.length > 0) {
                this.warnings = [...this.warnings, toolGatedAfterFirstUse(onceOnly)]
            }

            // Spec rule 6, and it throws rather than warns for the same reason `resolve()` throws on an
            // unknown slug: a phase whose `allow` names a tool that is not in the catalogue exposes less
            // than its author wrote, and the symptom arrives turns later as a model declining work it
            // was supposed to be able to do. Checked here because "resolved" is only knowable once the
            // providers have answered — `validate` cannot reach this without resolving tools itself.
            const unmatched = unmatchedAllows(this.manifest.phases ?? {}, specs)
            if (unmatched.length > 0) {
                throw phaseAllowUnmatched(
                    unmatched,
                    specs.map((spec) => spec.slug),
                )
            }
        }
    }

    static create(
        loaded: LoadedManifest,
        bus: EventBus,
        store: Store,
        options: AgentCreateOptions = {},
    ): Agent {
        // Roles first: the workspace is rendered for the model in front of it, so the resolved
        // `promptStyle` has to exist before the files are read.
        const roles = resolveRoles(loaded.manifest, options)
        const style = roles.main.capabilities.promptStyle
        const { workspace, warnings } = readWorkspace(loaded, style)

        // Tier 3, read here for the same reason the workspace is: disk at boot, never per turn.
        // Rendered with the same style so the two cannot drift.
        const knowledgeConfig = loaded.manifest.knowledge
        const knowledge =
            knowledgeConfig === undefined
                ? undefined
                : loadKnowledge({
                      dir: isAbsolute(knowledgeConfig.dir)
                          ? knowledgeConfig.dir
                          : resolve(loaded.dir, knowledgeConfig.dir),
                      maxActive: knowledgeConfig.maxActive,
                      budget: knowledgeConfig.budget,
                      style,
                  })

        // Frontmatter only, and the token counts the budget check needs. `agentDir` is what enables the
        // scan cache; it is the agent's own directory rather than the skills directory, so a workspace
        // shared between agents does not have one agent's cache overwritten by another's rendering.
        const skillsConfig = loaded.manifest.skills
        const skills =
            skillsConfig === undefined
                ? undefined
                : loadSkills({
                      dir: isAbsolute(skillsConfig.dir)
                          ? skillsConfig.dir
                          : resolve(loaded.dir, skillsConfig.dir),
                      maxActive: skillsConfig.maxActive,
                      threshold: skillsConfig.threshold,
                      style,
                      agentDir: loaded.dir,
                      ...(options.scriptRunner === undefined
                          ? {}
                          : { runner: options.scriptRunner }),
                  })

        // Read here rather than threaded in from `Runtime.create`, which calls the same function for
        // the selections it builds. A warning emitted during boot lands in an empty room — nothing has
        // subscribed yet — so anything true for the whole session belongs on the agent, where a front
        // end still finds it after the banner has scrolled away.
        const providerWarnings = resolveProviders(loaded.manifest.tools).warnings

        // The layering is right and it must not be silent. An agent whose own `.env` names one model
        // ran on another for a whole session because a `.env` in the directory the binary was
        // launched from said so — and the banner reported the model actually in use, correctly and
        // uselessly, since the person had just written the other one.
        const overrides =
            loaded.envOverrides.length === 0 ? [] : [envOverridden(loaded.envOverrides)]

        // A role whose model matched nothing in the registry is budgeting against a floor. Through
        // `windowReport` rather than off `roles`, so the thing that warns and the thing `validate`
        // prints are one derivation. Roles that fall back to main are dropped by the `configuredAs`
        // test: they share main's instance, so an unconfigured pair would report one mistake three
        // times, and three lines about one mistake is how a banner teaches people to skip it.
        const unknownWindows = windowReport(loaded.manifest)
            .filter((entry) => entry.role === entry.configuredAs)
            .filter((entry) => entry.window.source === "fallback")
            .map((entry) => ({
                role: entry.role,
                modelId: entry.modelId,
                window: entry.window.contextWindow,
            }))

        return new Agent({
            loaded,
            roles,
            workspace,
            warnings: [
                ...warnings,
                ...providerWarnings,
                ...overrides,
                // Same function `validate` calls. A deliverability check only one of them performs
                // is a check the two disagree about, and this one is about a schedule that fires
                // perfectly and reaches nobody — the surface where nothing else would say so.
                ...scheduleDeliveryWarnings(loaded.manifest),
                // Same function `validate` calls. A deliverability check only one of them performs
                // is a check the two disagree about, and this one is about a schedule that fires
                // perfectly and reaches nobody — the surface where nothing else would say so.
                ...(unknownWindows.length === 0 ? [] : [modelWindowUnknown(unknownWindows)]),
            ],
            bus,
            store,
            tools: options.tools ?? ToolRegistry.empty(),
            knowledge,
            skills,
            scriptRunner: options.scriptRunner,
        })
    }

    /** Default session key for a surface with no natural one, such as the REPL. */
    static readonly DEFAULT_SESSION = "local:default"

    history(sessionKey = Agent.DEFAULT_SESSION): Promise<readonly ChatMessage[]> {
        return this.store.messages.history(this.id, sessionKey)
    }

    sessions(): Promise<readonly SessionSummary[]> {
        return this.store.sessions.list(this.id)
    }

    turns(sessionKey = Agent.DEFAULT_SESSION, limit?: number): Promise<readonly TurnRecord[]> {
        return this.store.turns.list(this.id, sessionKey, limit === undefined ? {} : { limit })
    }

    /** Drops history, turns, and their derived index source. Memory files on disk are untouched. */
    clearSession(sessionKey = Agent.DEFAULT_SESSION): Promise<void> {
        return this.store.sessions.clear(this.id, sessionKey)
    }

    /**
     * Run a turn to completion. Detached by design: the returned promise resolves when the turn
     * is done, and abandoning it does not stop the work.
     *
     * The turn row is written `running` *before* the model is called, so a turn is durable from
     * the moment it starts rather than from the moment it finishes. That ordering is what lets a
     * crash be told apart from a turn that never began.
     */
    async send(input: string, options: AgentSendOptions = {}): Promise<TurnResult> {
        const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
        const turnId = options.turnId ?? newTurnId()
        const source = options.source ?? "library"

        await this.store.sessions.ensure(this.id, sessionKey)
        const history = await this.store.messages.history(this.id, sessionKey)

        await this.store.turns.start({
            turnId,
            agentId: this.id,
            sessionKey,
            source,
            input,
        })

        const active = this.knowledge === undefined ? [] : activateKnowledge(input, this.knowledge)
        const skills = this.#activateSkills(input, history)
        const remembered = await this.#recall(input, sessionKey, history)

        const result = await runTurn({
            agentId: this.id,
            sessionKey,
            turnId,
            input,
            history,
            identity: this.identity,
            configSummary: this.#configBlock(),
            // Read at load, like `static`. The tier's *position* is what Phase 3.5's first half
            // delivers — after the cache breakpoint, so that a write leaves slots 0 and 1
            // byte-identical. Re-reading it mid-session lands with the write path that changes it,
            // since a re-read with nothing writing is a filesystem call per turn for no observable
            // difference.
            ...(this.workspace.examples === "" ? {} : { examples: this.workspace.examples }),
            ...(this.workspace.volatile === "" ? {} : { volatile: this.workspace.volatile }),
            ...(this.workspace.reminder === "" ? {} : { reminder: this.workspace.reminder }),
            // Activated once per turn against the input — the selection is a function of the turn,
            // so it is stable across the steps within one and re-selecting per step would let two
            // steps of the same turn argue from different reference material.
            ...(active.length === 0
                ? {}
                : {
                      knowledge: active.map((entry) => ({
                          name: entry.name,
                          content: entry.content,
                      })),
                  }),
            ...(remembered.length === 0 ? {} : { memory: remembered }),
            ...(skills.length === 0 ? {} : { skills }),
            role: options.role === undefined ? this.roles.main : this.roles.byName(options.role),
            window: this.window,
            reserveOutput: this.manifest.context.reserveOutput,
            // Named field by field rather than spread, so the compiler names anything the manifest
            // grows and this forgets — which is what it did for `noProgress`.
            limits: {
                maxSteps: this.manifest.limits.maxSteps,
                noProgress: this.manifest.limits.noProgress,
                turnTimeoutMs: this.manifest.limits.turnTimeoutMs,
                toolTimeoutMs: this.manifest.limits.toolTimeoutMs,
                maxParallelTools: this.manifest.limits.maxParallelTools,
            },
            ...(this.#toolRuntime === undefined ? {} : { tools: this.#toolRuntime }),
            compaction: this.#compaction(sessionKey),
            ...(isPhased(this.manifest.phases)
                ? {
                      phases: {
                          config: this.manifest.phases,
                          current: await this.#phaseOf(sessionKey),
                          // Persisted inside the turn as well as after it: a crash between the model
                          // being told its tools changed and the turn finishing would otherwise resume
                          // in the phase it had already left, with a catalogue it has stopped expecting.
                          persist: async (to) => {
                              await this.store.sessions.setPhase(this.id, sessionKey, to)
                              this.#phases.set(sessionKey, to)
                          },
                      },
                  }
                : {}),
            bus: this.#bus,
            source,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        })

        // Carried per session, not per turn. One turn's observations are a sample of the estimator's
        // bias; the bias itself belongs to the conversation, and a fresh calibration every turn would
        // spend the first call of each turn running on the raw estimate — which is measured at 16-20%
        // low on exactly the observation-heavy prompts that need compacting.
        if (result.calibration !== undefined) {
            this.#calibrations.set(sessionKey, result.calibration)
        }
        if (result.phase !== undefined && result.phase !== "") {
            this.#phases.set(sessionKey, result.phase)
            await this.store.sessions.setPhase(this.id, sessionKey, result.phase)
        }
        if (result.compactions !== undefined && result.compactions > 0) {
            this.#compactions.set(
                sessionKey,
                (this.#compactions.get(sessionKey) ?? 0) + result.compactions,
            )
        }
        if (result.resets !== undefined && result.resets > 0) {
            this.#resets.set(sessionKey, (this.#resets.get(sessionKey) ?? 0) + result.resets)
        }

        // The turn row is the audit trail and records every outcome, including a failure and its
        // hint. `appended` is the conversation, and is empty on failure — a turn that errored
        // must not leave a half-answer in the history the next turn will be conditioned on.
        await this.store.turns.finish(turnId, {
            status: result.reason,
            text: result.text,
            reasoning: result.reasoning,
            steps: result.steps,
            promptTokens: result.tokens.prompt,
            outputTokens: result.tokens.output,
            ...(result.tokens.cachedPrompt === undefined
                ? {}
                : { cachedPromptTokens: result.tokens.cachedPrompt }),
            ...(result.tokens.cacheSource === undefined
                ? {}
                : { cacheSource: result.tokens.cacheSource }),
            durationMs: result.durationMs,
            ...(result.error === undefined
                ? {}
                : {
                      errorCode: result.error.code,
                      errorMessage: result.error.message,
                      errorHint: result.error.hint,
                  }),
        })

        if (result.appended.length > 0) {
            await this.store.messages.append(this.id, sessionKey, result.appended, turnId)
        }
        // After the append, so this turn is in the corpus before the next one asks about it — and after
        // `turns.finish`, so a failure to index cannot lose the audit record.
        await this.#indexHistory()

        this.#reportManifestChange()
        return result
    }

    /**
     * Index the conversations, so the next session can be asked what this one was about.
     *
     * At turn end rather than during recall, and that is the whole of `includeHistory`. Recall runs
     * before the model is called, when this turn's exchange does not exist yet; indexing there would
     * make every conversation exactly one turn stale, which is the turn somebody is most likely to ask
     * about.
     *
     * **Every** session is passed, not just this one. `reconcile` drops any source in its namespace that
     * it was not handed, so a single-session call would delete every other conversation from the index —
     * and it is cheap to be correct here, because `enumerateSessions` reads staleness out of a summary
     * it already has and only re-reads the session that moved.
     *
     * Failure is reported and swallowed, like recall's. The reply has been produced and persisted; a
     * broken index must not turn a delivered answer into an error, and the next turn will try again.
     */
    async #indexHistory(): Promise<void> {
        const memory = this.#memory
        if (memory === undefined || !memory.includeHistory) return
        try {
            await syncSessions({
                store: this.store.memory,
                agentId: this.id,
                sessions: await enumerateSessions({
                    sessions: this.store.sessions,
                    messages: this.store.messages,
                    agentId: this.id,
                }),
                now: new Date(),
            })
        } catch (error) {
            this.#bus.emit("agent.warning", {
                code: "memory_history_index_failed",
                message: `Indexing the conversation for memory failed: ${error instanceof Error ? error.message : String(error)}`,
                hint: "The reply was delivered and is in the store; only its retrievability is affected. `memory rebuild --history` re-indexes every conversation.",
            })
        }
    }

    /**
     * Say so, once, when the manifest on disk stops matching the one this process is running.
     *
     * `config_set` writes `agent.yaml` and the change takes effect at the next start. The tool says so
     * in its observation, and relying on that means relying on the model to relay it — which it did in
     * testing and will not always. A configuration change that silently does not apply is precisely
     * the shape rule 8 exists to prevent, so the runtime states it rather than delegating it.
     *
     * Here rather than in a front end because it is a fact about the agent, not about a terminal: a
     * server or a scheduled run needs it just as much. Latched, because it is one piece of news and
     * repeating it every turn is how a person learns to skim past it.
     */
    #reportManifestChange(): void {
        if (this.#manifestMtime === undefined || this.#manifestChangeReported) return
        let now: number
        try {
            now = statSync(this.#manifestPath).mtimeMs
        } catch {
            // Moved or deleted mid-session. Not this method's business to report — the next boot will
            // fail loudly and name the path, which is the right place for it.
            return
        }
        if (now === this.#manifestMtime) return
        this.#manifestChangeReported = true
        this.#bus.emit(
            "agent.warning",
            {
                code: "manifest_changed",
                message: `This agent's configuration has been edited since it started: ${this.#manifestPath}`,
                hint: "The running agent still has the settings it booted with — a tool it was just given is not available in this conversation. Restart it to pick the change up.",
                field: "agent.yaml",
            },
            { agentId: this.id },
        )
    }

    /**
     * A filter for one turn's worth of streamed deltas.
     *
     * Every surface that shows tokens as they arrive needs this, because with a line-oriented dialect
     * the invocation *is* text: printing deltas straight through puts `ACTION:` and `END` in front of
     * the person and runs them into the answer. Dialect selection stays here — config, never
     * inference — so a caller asks for a filter rather than choosing one.
     */
    streamFilter(): StreamFilter {
        return this.#toolRuntime?.dialect.createStreamFilter() ?? passThroughFilter()
    }

    /**
     * The context the next turn on this session would be given, without running one.
     *
     * Exists for `GET /v1/agents/:id/context`, whose whole justification is that "why did it do
     * that?" is almost always a context question. **It calls `assembleContext` with the same
     * arguments `send` does**, and that is the entire point: a server that rebuilt the argument list
     * itself would answer a question about a prompt the agent does not actually use, and would drift
     * silently the first time a slot moved. `examplesIn` placement, the volatile tier's position
     * behind the cache breakpoint, and the window reduction for native's wire tokens are all
     * properties of that one call, and none of them are re-derived here.
     *
     * `input` defaults to empty, which activates no knowledge and no skill — both are selected from
     * the turn's input, so a preview with no input honestly shows a turn with no input.
     */
    async previewContext(
        options: { readonly sessionKey?: string; readonly input?: string } = {},
    ): Promise<{
        readonly slots: readonly { slot: number; label: string; tokens: number; pinned: boolean }[]
        /**
         * What the history slot is made of, largest first.
         *
         * The slot total is the number that hides the answer — on a real agent it was 85% of the turn
         * with nothing able to say what was in it, and the owner's own agent, asked directly, blamed
         * its instruction files instead. Composition is the difference between a runtime that can be
         * diagnosed and one that has to be measured by hand.
         */
        readonly history: readonly { label: string; tokens: number; messages: number }[]
        readonly total: number
        readonly window: number
        /**
         * Tool schemas that ride in the request body rather than in a block.
         *
         * Reported because it is the term that makes the budget arithmetic add up and is invisible
         * everywhere else: `assembleContext` is handed `window − wireTokens`, so `Pressure.budget`'s
         * docstring saying `window − reserveOutput` is true of the number it received and not of the
         * window a person configured. Zero under `nlt`, where the catalogue is a block like any other.
         */
        readonly wireTokens: number
        readonly reserveOutput: number
        /**
         * How far this session's estimator has been corrected by what the endpoint actually charged.
         *
         * `samples: 0` means nothing has come back yet and the total is a raw estimate — which runs
         * 16–20% *low* on the prompts that matter, in the overflow direction, exactly when the window
         * is tight. A reader deciding whether to trust the percentage needs this, not just the number.
         */
        readonly calibration: Calibration
        /** Compaction stages run in this session so far. Zero on a conversation under no pressure. */
        readonly compactions: number
        /**
         * What this session's endpoints actually served from cache, across the turns that said so.
         *
         * `undefined` when no turn reported a figure — most endpoints do not, and that is a different
         * statement from "nothing was cached". Read from the stored turns rather than kept in memory,
         * so a resumed session reports the conversation's history and not this process's slice of it.
         */
        readonly cache:
            | {
                  readonly cached: number
                  readonly prompt: number
                  readonly turns: number
                  readonly source: string
              }
            | undefined
    }> {
        const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
        const input = options.input ?? ""
        const history = await this.store.messages.history(this.id, sessionKey)
        const active =
            this.knowledge === undefined || input === ""
                ? []
                : activateKnowledge(input, this.knowledge)
        const skills = input === "" ? [] : this.#activateSkills(input, history)
        const remembered = await this.#recall(input, sessionKey, history)
        const tools = this.#toolRuntime

        const assembled = assembleContext({
            identity: this.identity,
            ...(tools === undefined ? {} : { toolBlocks: tools.blocks }),
            configSummary: this.#configBlock(),
            ...(this.workspace.examples === "" ? {} : { examples: this.workspace.examples }),
            ...(this.workspace.volatile === "" ? {} : { volatile: this.workspace.volatile }),
            ...(active.length === 0
                ? {}
                : {
                      knowledge: active.map((entry) => ({
                          name: entry.name,
                          content: entry.content,
                      })),
                  }),
            ...(remembered.length === 0 ? {} : { memory: remembered }),
            ...(skills.length === 0 ? {} : { skills }),
            ...(this.workspace.reminder === "" ? {} : { reminder: this.workspace.reminder }),
            history,
            input,
            window: Math.max(1, this.window - (tools?.wireTokens ?? 0)),
            reserveOutput: this.manifest.context.reserveOutput,
        })

        return {
            slots: slotReport(assembled.blocks),
            history: historyReport(assembled.blocks),
            total: assembled.totalTokens,
            window: this.window,
            wireTokens: tools?.wireTokens ?? 0,
            reserveOutput: this.manifest.context.reserveOutput,
            calibration: this.#calibrations.get(sessionKey) ?? UNCALIBRATED,
            compactions: this.#compactions.get(sessionKey) ?? 0,
            cache: await this.#cacheReport(sessionKey),
        }
    }

    /**
     * The session's cache ratio, summed over the turns whose endpoint reported one.
     *
     * Only reporting turns are counted, in both numerator and denominator. Including a silent turn's
     * prompt in the denominator would quietly dilute the ratio toward zero and read as a cache that
     * is failing, which is the opposite of the truth: it is a cache nobody asked about.
     */
    async #cacheReport(sessionKey: string): Promise<
        | {
              readonly cached: number
              readonly prompt: number
              readonly turns: number
              readonly source: string
          }
        | undefined
    > {
        const turns = await this.store.turns.list(this.id, sessionKey, {
            limit: CACHE_REPORT_TURNS,
        })
        let cached = 0
        let prompt = 0
        let counted = 0
        let source: string | undefined
        for (const turn of turns) {
            if (turn.cachedPromptTokens === undefined) continue
            cached += turn.cachedPromptTokens
            prompt += turn.promptTokens
            counted += 1
            source ??= turn.cacheSource
        }
        if (counted === 0 || source === undefined) return undefined
        return { cached, prompt, turns: counted, source }
    }

    /**
     * Tell the agent what is actually running, before its first turn.
     *
     * Called by `Runtime.create` once channels have started, and by whatever binds the HTTP surface.
     * Throws if slot 2 has already been rendered: after that point a change would alter the
     * cache-stable prefix mid-session, which costs prompt caching and reports nothing.
     */
    reportRuntimeState(state: {
        readonly channelsStarted?: boolean
        readonly schedulerStarted?: boolean
        readonly serverListening?: boolean
        /**
         * Another live process holds this agent's serving lease.
         *
         * Separate from the three above because it is not about *this* process at all, and without
         * it the other three are true and misleading together: "not running in this session" is what
         * a REPL says while a `serve` in the next terminal is running the lot.
         */
        readonly servedElsewhere?: boolean
    }): void {
        if (this.#configSummary !== undefined) {
            throw new Error(
                `Runtime state for agent "${this.id}" was reported after its configuration block had already been rendered. ` +
                    "hint: slot 2 is part of the cache-stable prefix, so it is frozen at first use. Report state during startup, before the first turn.",
            )
        }
        if (state.channelsStarted !== undefined) this.#channelsStarted = state.channelsStarted
        if (state.schedulerStarted !== undefined) this.#schedulerStarted = state.schedulerStarted
        if (state.serverListening !== undefined) this.#serverListening = state.serverListening
        if (state.servedElsewhere !== undefined) this.#servedElsewhere = state.servedElsewhere
    }

    /** Slot 2's text. Rendered on first use, then frozen — see `#configSummary`. */
    /**
     * Select and load the skills that apply to this turn, and put anything worth saying on the bus.
     *
     * Called by `send` and by `previewContext`, which is the same discipline that keeps the preview
     * honest about the tool catalogue: a second implementation here would answer a question about a
     * prompt nothing uses.
     *
     * The selection text is the input *plus the previous assistant turn*. A follow-up rarely repeats
     * its subject — "now do the other one" contains no term any description holds — and the assistant's
     * last message is where the subject still is.
     *
     * `notes` are emitted rather than returned because they describe a skill that was expected to apply
     * and did not, which is precisely the class of thing that must never be silent. They are per-turn,
     * so they go on the bus rather than onto `agent.warnings`, which is for the whole session.
     */

    /**
     * Reconcile the index with the files, then rank against this turn's input.
     *
     * Sync runs **per turn**, not only at boot, and it is cheap on purpose: `enumerateFiles` stats and
     * does not read, and `syncFiles` skips a source whose mtime, size and tokeniser version all match, so
     * the steady-state cost is a dozen `stat` calls. That is what makes two acceptance criteria hold at
     * once — an externally edited memory file is picked up without a restart, and `memory_write`'s own
     * eviction is indexed before the next turn can ask about it.
     *
     * Retrieval failure is **not** a turn failure. A corrupt index or a store from a newer build should
     * cost the agent its memory for that turn, not the reply: the person asked a question, and answering
     * without slot 7 is strictly better than an error. Reported on the bus rather than swallowed.
     */
    async #recall(
        input: string,
        sessionKey: string,
        history: readonly ChatMessage[],
    ): Promise<readonly { source: string; at: string; text: string; because?: string }[]> {
        const memory = this.#memory
        if (memory === undefined || memory.maxActive === 0 || input === "") return []

        try {
            await this.#syncMemory(memory.dir)

            const previousAssistant = [...history]
                .reverse()
                .find((message) => message.role === "assistant")
            const cleanPreviousAssistant =
                previousAssistant?.origin === undefined && previousAssistant?.tainted !== true
                    ? previousAssistant
                    : undefined
            const ranked = await retrieveWithContext(memory.retrieve, {
                input,
                now: new Date(),
                minimumScore: memory.threshold,
                ...(cleanPreviousAssistant === undefined
                    ? {}
                    : { previousAssistant: cleanPreviousAssistant.content }),
                // Over-fetch relative to `maxActive`: the retriever re-ranks by recency and drops
                // excluded sources, so asking for exactly the cap would lose both effects.
                limit: Math.max(memory.maxActive * 4, 12),
                // The conversation being had is excluded for exactly the reason the carried file is:
                // it is already in the prompt, as history. Retrieving it would spend slot 7 telling
                // the model something it can read two slots down — and would do it worst on a long
                // session, where the budget matters most. Excluded at retrieval, not in the index, so
                // `memory search` can still find what was said a minute ago.
                exclude: [
                    sessionSource(sessionKey),
                    ...(memory.carried === undefined ? [] : [memory.carried]),
                ],
            })

            return selectPassages(ranked, {
                threshold: memory.threshold,
                maxActive: memory.maxActive,
                budget: memory.budget,
            }).map((hit) => ({
                source: hit.passage.source,
                at: hit.passage.at,
                text: hit.passage.text,
                ...(hit.because === undefined ? {} : { because: hit.because }),
            }))
        } catch (error) {
            this.#bus.emit("agent.warning", {
                code: "memory_recall_failed",
                message: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
                hint: "The turn continues without slot 7. Run `memory rebuild` to re-read the files; if it keeps failing, the store may be from a newer build.",
            })
            return []
        }
    }

    /**
     * Reconcile the index with the files on disk. Shared by recall, `memory search` and `memory rebuild`.
     *
     * The carried workspace file is indexed *alongside* the archive, which looks redundant and is not:
     * `memory search` has to be able to find a note saved a minute ago, and that note is still in the
     * carried file. Slot 7 excludes it at **retrieval** instead, which is the only arrangement under
     * which the model is never told the same thing twice and the person can still search everything.
     */
    async #syncMemory(dir: string): Promise<IndexReport> {
        const target = writeTarget(this.workspace)
        return await syncFiles({
            store: this.store.memory,
            agentId: this.id,
            files: enumerateFiles({
                dir,
                ...(target?.path === undefined || target.mode === "refused"
                    ? {}
                    : { extra: [{ source: target.name, path: target.path }] }),
            }),
            now: new Date(),
        })
    }

    /**
     * Rank the whole corpus against a query, the way a turn would — but **without** the threshold and
     * without excluding the carried file.
     *
     * Both omissions are the point. A person running this is asking "what is in there, and why did it
     * not recall X", and a floor that hid the near-misses would make the command useless for exactly
     * that question; the caller marks what falls below `threshold` rather than dropping it. And the
     * carried file is included because "where is that note" has a legitimate answer of "still in
     * MEMORY.md, which is why you did not see it under Remembered".
     */
    async searchMemory(options: { readonly query: string; readonly limit?: number }): Promise<{
        readonly corpus: number
        readonly threshold: number
        readonly carried: string | undefined
        readonly hits: readonly RetrievedPassage[]
    }> {
        const memory = this.#memory
        if (memory === undefined) throw memoryNotConfigured()

        await this.#syncMemory(memory.dir)
        const hits = await memory.retrieve({
            input: options.query,
            now: new Date(),
            limit: options.limit ?? 10,
        })
        const stats = await this.store.memory.stats(this.id)
        return {
            corpus: stats.passages,
            threshold: memory.threshold,
            carried: memory.carried,
            hits,
        }
    }

    /**
     * Forget the index and re-read every file — and every conversation, when `includeHistory` is on.
     *
     * Exists because staleness is detected from mtime **and** size, and an edit that preserves both is a
     * real blind spot rather than a hypothetical one — a one-character correction, or a restore from a
     * copy that kept timestamps. The files are canonical, so this is always safe: nothing is lost by
     * discarding an index that can be rebuilt from them.
     *
     * **Conversations are re-indexed unconditionally, not behind a flag, because `clear` wipes both
     * namespaces.** A `--history` opt-in was the plan and it was a foot-gun: a plain rebuild would have
     * deleted every indexed conversation and reported success, and the person most likely to run one is
     * the person whose retrieval has just stopped working. Restoring exactly what was discarded is the
     * only shape with no silent loss in it — and it makes a rebuild the backfill for an agent whose
     * sessions predate this being wired up at all.
     */
    async rebuildMemory(): Promise<IndexReport & { readonly sessions: readonly string[] }> {
        const memory = this.#memory
        if (memory === undefined) throw memoryNotConfigured()
        await this.store.memory.clear(this.id)
        const files = await this.#syncMemory(memory.dir)
        if (!memory.includeHistory) return { ...files, sessions: [] }
        const sessions = await syncSessions({
            store: this.store.memory,
            agentId: this.id,
            sessions: await enumerateSessions({
                sessions: this.store.sessions,
                messages: this.store.messages,
                agentId: this.id,
            }),
            now: new Date(),
        })
        // The session pass ran second, so its count is the corpus total rather than the files' subtotal.
        return { ...files, passages: sessions.passages, sessions: sessions.indexed }
    }

    #activateSkills(
        input: string,
        history: readonly ChatMessage[],
    ): readonly {
        name: string
        content: string
        role: "system" | "user"
        tools: readonly Tool[]
    }[] {
        const catalogue = this.skills
        if (catalogue === undefined) return []

        const previous = [...history].reverse().find((message) => message.role === "assistant")
        const { active, notes } = activateSkills({
            input: previous === undefined ? input : `${input}\n${previous.content}`,
            catalogue,
            style: this.roles.main.capabilities.promptStyle,
        })

        for (const note of notes) {
            this.#bus.emit("agent.warning", note, { agentId: this.id })
        }

        const role = this.roles.main.capabilities.promptStyle.skillsIn
        const runner = this.#scriptRunner
        return active.map((entry) => {
            // The catalogue record, for the scripts. `ActiveSkill` deliberately carries only what the
            // block needs; looking the record up here keeps the activation result from growing a second
            // copy of it that could drift.
            const record = catalogue.skills.find((skill) => skill.name === entry.name)
            const scripts = record === undefined ? "" : renderScripts(record, runner !== undefined)
            return {
                name: entry.name,
                // The scripts section is appended, never interleaved — the authored body stays
                // byte-identical, which is the line decision 4.19 draws.
                content: scripts === "" ? entry.content : `${entry.content}\n\n${scripts}`,
                role,
                tools:
                    record === undefined || runner === undefined
                        ? []
                        : skillScriptTools({ skill: record, runner }),
            }
        })
    }

    /**
     * The compaction seam for one session, or nothing.
     *
     * Absent when `compactionNotice` is off *and* nothing else needs it? No — absent never, because the
     * thresholds are always present in the manifest. The seam is what turns them from a validated,
     * inert block into behaviour, so it is always supplied; the ladder itself does nothing until a
     * threshold is crossed.
     *
     * `summarise` is present only when the manifest declares a `compactor` role. There is deliberately
     * no fallback to `main`: a digest written by the model that is mid-task, inside the same turn, on a
     * prompt that is already too big, is how a compaction becomes the thing that overflows the window.
     * The mechanical digest is the fallback, and it never fails.
     */
    /**
     * Where this session is, falling back to the entry phase.
     *
     * The store is consulted once per process per session and then cached, because a phase changes only
     * through `setPhase`, which writes both. A stored phase the manifest no longer declares falls back
     * to the entry phase rather than failing: someone renamed a phase between runs, and refusing to
     * resume the conversation is a worse answer than starting it at the beginning of the ladder.
     */
    async #phaseOf(sessionKey: string): Promise<string> {
        const declared = this.manifest.phases ?? {}
        const entry = entryPhase(declared) ?? ""
        const cached = this.#phases.get(sessionKey)
        if (cached !== undefined) return declared[cached] === undefined ? entry : cached
        const stored = (await this.store.sessions.get(this.id, sessionKey))?.phase
        const resolved = stored !== undefined && declared[stored] !== undefined ? stored : entry
        this.#phases.set(sessionKey, resolved)
        return resolved
    }

    #compaction(sessionKey: string): TurnCompaction {
        // `resolveRoles` always returns a compactor — it falls back to `main`, deliberately, so an
        // unconfigured role costs nothing. `configuredAs` is what distinguishes "configured" from
        // "inherited", and only a configured one gets to write digests: asking the model that is
        // mid-task, inside the same turn, on a prompt already too large, is how a compaction becomes
        // the thing that overflows the window.
        const compactor =
            this.roles.compactor.configuredAs === "compactor" ? this.roles.compactor : undefined
        return {
            thresholds: this.manifest.context.thresholds,
            calibration: this.#calibrations.get(sessionKey) ?? UNCALIBRATED,
            resets: this.#resets.get(sessionKey) ?? 0,
            persist: async (artifacts) => {
                await this.store.artifacts.put(
                    this.id,
                    sessionKey,
                    artifacts.map((artifact) => ({
                        id: artifact.id,
                        ...(artifact.slug === undefined ? {} : { slug: artifact.slug }),
                        content: artifact.content,
                        tokens: artifact.tokens,
                    })),
                    new Date().toISOString(),
                )
            },
            read: async (id) => {
                const found = await this.store.artifacts.get(this.id, sessionKey, id)
                if (found === undefined) return undefined
                return {
                    content: found.content,
                    tokens: found.tokens,
                    ...(found.slug === undefined ? {} : { slug: found.slug }),
                }
            },
            ...(compactor === undefined
                ? {}
                : {
                      summarise: async (messages, signal) => {
                          // The compactor's own window, not `this.window`. `this.window` is main's,
                          // and `roles.ts` calls a cheap compactor beside a large main "the intended
                          // production shape and usually the biggest available cost win" — which is
                          // exactly the configuration where a span sized for main overflows the
                          // compactor. It threw, `digestFor` caught it, and the ladder fell back to a
                          // mechanical digest reporting `digestSource: "mechanical"` to nobody. So the
                          // recommended optimisation was configuration with no effect.
                          const window = compactor.capabilities.contextWindow
                          const fitted = withinWindow(messages, window)
                          const instruction =
                              fitted.length === messages.length
                                  ? DIGEST_INSTRUCTION
                                  : `${DIGEST_INSTRUCTION}\n\nThe oldest ${messages.length - fitted.length} message(s) of this span did not fit and are not shown. Say so in your closing line.`
                          const result = await runStep({
                              role: compactor,
                              provider: compactor.provider,
                              messages: [{ role: "system", content: instruction }, ...fitted],
                              params: requestParamsFor(compactor, window),
                              promptTokens: 0,
                              bus: this.#bus,
                              context: { agentId: this.id, sessionKey },
                              signal,
                          })
                          return result.text
                      },
                  }),
        }
    }

    #configBlock(): string {
        if (this.#configSummary === undefined) {
            this.#configSummary = renderConfigSummary({
                manifest: this.manifest,
                path: this.#manifestPath,
                window: this.window,
                tools: this.tools.specs().map((spec) => spec.slug),
                providers: resolveProviders(this.manifest.tools).selections.map((s) => s.id),
                channelsStarted: this.#channelsStarted,
                schedulerStarted: this.#schedulerStarted,
                serverListening: this.#serverListening,
                servedElsewhere: this.#servedElsewhere,
                // Absent, not zero, when no block is configured — the row distinguishes "off" from
                // "no such concept", and only this side knows which it is.
                ...(this.skills === undefined
                    ? {}
                    : { skillNames: this.skills.skills.map((skill) => skill.name) }),
                // Default on: the behaviour it removes — a model quietly wrapping up because it senses
                // the window filling — is invisible and costs a whole turn's usefulness, while the
                // notice costs about sixty tokens once in a cached prefix.
                ...(this.manifest.context.compactionNotice === false
                    ? {}
                    : {
                          compactionNotice: renderCompactionNotice({
                              canReadArtifacts: this.tools
                                  .specs()
                                  .some((spec) => spec.slug === ARTIFACT_READ),
                          }),
                      }),
            })
        }
        return this.#configSummary
    }

    describe(): AgentDescription {
        return {
            id: this.id,
            name: this.manifest.name ?? this.id,
            model: this.manifest.model.main.id,
            window: this.window,
            identityTokensApprox: Math.ceil(this.identity.length / 3.8),
            contextFiles: this.workspace.files.map((file) => file.name),
            workspace: this.workspace.files.map((file) => ({
                name: file.name,
                tier: file.tier,
                editable: file.editable,
                tokens: file.tokens,
                budget: file.budget,
            })),
            dialect: this.#toolRuntime?.dialect.id ?? this.manifest.tools.dialect,
            tools: this.tools.specs().map((spec) => spec.slug),
            knowledge: (this.knowledge?.entries ?? []).map((entry) => ({
                name: entry.name,
                keywords: entry.keywords,
                tokens: entry.tokens,
            })),
            catalogueTokens:
                (this.#toolRuntime?.blocks ?? []).reduce((sum, block) => sum + block.tokens, 0) +
                (this.#toolRuntime?.wireTokens ?? 0),
        }
    }
}

/**
 * Plan, gate, and load the workspace: the deprecated-alias resolution, the soul gate, and the
 * tiered load, in that order.
 *
 * Exported because `validate` calls it too. The soul gate and the alias conflict first lived only
 * on this path, which is the asymmetry the rule guard already taught: a check only `run` performs
 * is a check `validate` disagrees with. The rule budget is deliberately *not* applied here — each
 * caller applies `ruleBudgetFailure` under its own `onExceed`.
 */
export function resolveWorkspace(
    loaded: LoadedManifest,
    style: PromptStyle,
): { workspace: Workspace; warnings: ErrorDetail[] } {
    const { context } = loaded.manifest
    const plan = planWorkspace(context, loaded.dir)
    const warnings = [...plan.warnings]

    // The soul gate runs against the model actually configured, and whichever file wins — the full
    // document, the hand-edited compact one, or nothing — loads as an ordinary static ref, ahead of
    // the declared list: identity leads. A second loading path for souls would be the one nobody
    // tests.
    let refs: readonly WorkspaceFileRef[] = plan.refs
    if (context.soul !== undefined) {
        const workspaceDir = isAbsolute(context.workspace)
            ? context.workspace
            : resolve(loaded.dir, context.workspace)
        const soul = planSoul(
            context.soul,
            { id: loaded.manifest.model.main.id, window: loaded.window },
            workspaceDir,
        )
        warnings.push(...soul.warnings)
        if (soul.ref !== undefined) refs = [soul.ref, ...refs]
    }

    const workspace = loadWorkspace({ refs, budgets: context.budgets, style })
    return { workspace, warnings }
}

/**
 * `resolveWorkspace` plus this agent's `onExceed` applied to the rule budget.
 *
 * Counted across static and reminder together, because the model does not know they came from
 * different files. `volatile` is excluded: it holds facts about the person, not obligations.
 */
function readWorkspace(
    loaded: LoadedManifest,
    style: PromptStyle,
): { workspace: Workspace; warnings: ErrorDetail[] } {
    const { workspace, warnings } = resolveWorkspace(loaded, style)

    const failure = ruleBudgetFailure(workspace, loaded.manifest.context.rules)
    if (failure !== undefined) {
        // `warn` is the escape for a miscounted line, and it still says so. Silence is not an
        // option here: an author over budget and unaware of it is the case the guard exists for.
        if (loaded.manifest.context.rules.onExceed === "fail") throw failure
        return { workspace, warnings: [...warnings, failure.toDetail()] }
    }

    return { workspace, warnings }
}
