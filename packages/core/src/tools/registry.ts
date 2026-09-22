/**
 * The catalogue: which tools exist, resolved once at load.
 *
 * **Resolution happens at load, never per turn, and never by search.** A provider like Composio
 * exposes on the order of twenty thousand tools; letting the model search and then execute is
 * two-hop reasoning, which is precisely where small models fail. So the manifest names what it
 * wants, this resolves it once, and the catalogue is fixed for the process.
 *
 * **An unknown slug fails the load.** The observed failure it replaces: a shared cap across
 * toolkits, a silent auto-cap near twenty "important" tools that starved every write tool, and dead
 * slugs dropped without a word — an agent that boots healthy and cannot act. Here the slug and the
 * provider are named, and nothing is dropped quietly: what the budget trims is reported as a
 * warning the caller emits.
 *
 * The two budget rules read as one but are different in kind:
 *
 * - Pinning **more slugs than the cap** is a configuration error. The manifest asked for something
 *   arithmetically impossible, and only its author can decide what to give up.
 * - Resolution **expanding past the cap** — one toolkit slug yielding thirty tools — is a runtime
 *   fact. That trims, holding `reserveWrite` slots for mutating tools so a large read surface
 *   cannot starve the writes, and says what it dropped.
 */

import {
    type ErrorDetail,
    toolBudgetExceeded,
    toolSlugCollision,
    unknownTool,
    unknownToolAtRuntime,
} from "../errors.ts"
import { visibleIn } from "../loop/phases.ts"
import { localProvider } from "./local.ts"
import type { Tool, ToolAvailability, ToolProvider, ToolSpec } from "./types.ts"

export interface ToolBudget {
    readonly max: number
    readonly reserveWrite: number
}

export const DEFAULT_TOOL_BUDGET: ToolBudget = { max: 24, reserveWrite: 6 }

export interface DroppedTool {
    readonly slug: string
    readonly reason: string
}

export interface RegistryOptions {
    /** Provider slugs, in priority order. Resolved against `providers`, then the local set. */
    readonly pinned?: readonly string[]
    /** Built-in slugs, resolved against the local provider only. */
    readonly local?: readonly string[]
    readonly budget?: ToolBudget
    /** Consulted in order. The local provider is always consulted first. */
    readonly providers?: readonly ToolProvider[]
}

/** `Send_Email`, `send email` and `send-email` name the same tool. Nothing looser than that. */
function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

export class ToolRegistry {
    readonly #bySlug: ReadonlyMap<string, Tool>
    readonly #byNormalised: ReadonlyMap<string, Tool>
    readonly #order: readonly ToolSpec[]
    readonly dropped: readonly DroppedTool[]
    readonly warnings: readonly ErrorDetail[]
    /**
     * Tools a provider offers that this manifest did not pin.
     *
     * Rendered into the catalogue so the model can answer "I can't do that yet, and here is what would
     * let me" instead of "I can't do that". Without it a pinned-down agent is silently less capable
     * than its own runtime and only the person reading the manifest can work out why — which is a
     * question they asked the agent precisely because they did not want to read the manifest.
     */
    readonly notEnabled: readonly ToolAvailability[]

    private constructor(init: {
        tools: readonly Tool[]
        dropped: readonly DroppedTool[]
        warnings: readonly ErrorDetail[]
        notEnabled?: readonly ToolAvailability[]
    }) {
        const bySlug = new Map<string, Tool>()
        const byNormalised = new Map<string, Tool>()
        for (const tool of init.tools) {
            bySlug.set(tool.spec.slug, tool)
            byNormalised.set(normalise(tool.spec.slug), tool)
        }
        this.#bySlug = bySlug
        this.#byNormalised = byNormalised
        this.#order = init.tools.map((tool) => tool.spec)
        this.dropped = init.dropped
        this.warnings = init.warnings
        this.notEnabled = init.notEnabled ?? []
    }

    /** An agent with no tools configured. Distinct from one whose resolution produced nothing. */
    static empty(): ToolRegistry {
        return new ToolRegistry({ tools: [], dropped: [], warnings: [] })
    }

    static async create(options: RegistryOptions): Promise<ToolRegistry> {
        const pinned = options.pinned ?? []
        const local = options.local ?? []
        const budget = options.budget ?? DEFAULT_TOOL_BUDGET
        const providers = options.providers ?? []

        const requested = [...local, ...pinned]
        if (requested.length === 0) return ToolRegistry.empty()

        // Arithmetically impossible before anything is resolved, so it fails before any provider is
        // asked — the answer cannot change with what comes back.
        if (requested.length > budget.max) {
            throw toolBudgetExceeded(requested.length, budget.max)
        }

        const warnings: ErrorDetail[] = []
        const found = new Map<string, Tool>()
        const consulted: string[] = []

        // The local provider is consulted first and for both lists, so a remote provider cannot
        // shadow a built-in — and a genuine clash throws below rather than being resolved silently
        // in someone's favour. `local` is never sent to a remote provider: it names built-ins, and
        // asking Composio to resolve `now` invites it to answer with something else entirely.
        //
        // The third element is the trust default, and it is carried here rather than derived later
        // because **this loop is the only place that knows which provider is the built-in one**.
        // `spec.provider` is a self-report a resolved tool could set to "local", and `provider.id`
        // is chosen by whoever registered the factory — nothing stops an embedder registering one
        // under the id "local". Position is the fact; the strings are claims.
        const trustOverrides: string[] = []
        for (const [provider, slugs, fallback] of [
            [localProvider(), requested, "trusted"] as const,
            ...providers.map((provider) => [provider, pinned, "untrusted"] as const),
        ]) {
            if (slugs.length === 0) continue
            consulted.push(provider.id)
            for (const resolved of await provider.resolve(slugs)) {
                const key = normalise(resolved.spec.slug)
                const existing = found.get(key)
                if (existing !== undefined && existing.spec.provider !== resolved.spec.provider) {
                    throw toolSlugCollision(resolved.spec.slug, [
                        existing.spec.provider,
                        resolved.spec.provider,
                    ])
                }
                if (existing !== undefined) continue

                // Only an *unexplained* override warns. A provider that declares trusted and says why
                // has thought about it, and the reason belongs in `tools` output rather than in a
                // banner that fires on every boot of a correct configuration.
                if (
                    fallback === "untrusted" &&
                    resolved.spec.trust === "trusted" &&
                    (resolved.spec.trustReason ?? "") === ""
                ) {
                    trustOverrides.push(resolved.spec.slug)
                }
                // Normalised once, here, so every consumer downstream reads a settled value and no
                // provider package can ship a trusted email body by forgetting a field.
                found.set(
                    key,
                    resolved.spec.trust === undefined
                        ? { ...resolved, spec: { ...resolved.spec, trust: fallback } }
                        : resolved,
                )
            }
        }

        const missing = requested.filter((slug) => !found.has(normalise(slug)))
        if (missing.length > 0) {
            /**
             * **Warned and omitted, never fatal.** A pinned slug nothing can resolve is almost
             * always a *credential* rather than a typo: a Composio account with no key resolves
             * nothing, and refusing to boot meant `init --composio connected` produced an agent that
             * could not start — while `validate` said `ok`, because it does not build a registry.
             * That is the recorded asymmetry in its worst direction, and the same complaint as a
             * channel with no token: an optional capability made the whole agent unstartable.
             *
             * It is not silent, which is the whole reason this is defensible. The finding lands on
             * `agent.tools.warnings`, which `Runtime` emits and the banner prints; the tool is absent
             * from the catalogue; and `available()` is what tells the *model* it was not given
             * something its manifest asks for — the seam that already exists for exactly this.
             *
             * A provider that knows *why* it came up empty still gets to say so first. Asked here
             * rather than thrown from `resolve` because the question only makes sense once every
             * provider has answered: each is handed the whole pinned list, so a cold Composio is
             * asked about `config_read` and cannot know the system provider is about to resolve it.
             */
            const explained = providers
                .map((provider) => provider.explainUnresolved?.(missing))
                .find((detail) => detail !== undefined)
            if (explained !== undefined) {
                warnings.push(explained.toDetail())
            } else {
                const first = missing[0] ?? ""
                const pinnedIndex = pinned.indexOf(first)
                warnings.push(
                    unknownTool({
                        slug: first,
                        providers: consulted,
                        available: await listAll(providers),
                        field:
                            pinnedIndex >= 0
                                ? `tools.pinned[${pinnedIndex}]`
                                : `tools.local[${local.indexOf(first)}]`,
                        alsoMissing: missing.slice(1),
                    }).toDetail(),
                )
            }
        }

        // Manifest order is priority order: what the author listed first is what survives a trim.
        // A slug that expanded into several tools contributes the rest afterwards, in provider order.
        const claimed = new Set<Tool>()
        const ordered: Tool[] = []
        for (const slug of requested) {
            const tool = found.get(normalise(slug))
            if (tool === undefined || claimed.has(tool)) continue
            claimed.add(tool)
            ordered.push(tool)
        }
        const all = [...ordered, ...[...found.values()].filter((tool) => !claimed.has(tool))]

        // Honoured — the embedder chose to run that provider's code — but never silent. Declaring a
        // provider tool trusted opts it out of the delimiter *and* out of the write gate, which is
        // the kind of thing someone should learn at load rather than during an incident.
        if (trustOverrides.length > 0) {
            warnings.push({
                code: "tool_trust_overridden",
                message: `Declared trusted by their provider, with no reason given: ${trustOverrides.join(", ")}.`,
                // The hint used to assert *why* — "a provider cannot know what its upstream API
                // returns" — which is true of a remote catalogue and plainly false of a local
                // package whose write tools return a sentence the runtime composed. A warning that
                // states a wrong reason at every boot is how a correct warning gets ignored, so this
                // one states the consequence, which holds either way, and leaves the judgement to
                // whoever knows what the tool actually returns.
                hint: "Trusted output skips the data delimiter and does not gate a later mutating call. That is right for a tool whose output the runtime composed itself and wrong for one returning anything an upstream API or a file supplied — so a provider that opts out is asked to say why, in ToolSpec.trustReason. With a reason this is silent and the reason is shown by the tools command instead.",
            })
        }

        // Asked after resolution, so the answer is "not pinned" rather than "not resolved" — and only
        // of providers that volunteer it. A catalogue of twenty-five thousand omits `available`
        // entirely, which is what keeps this a handful of tokens instead of a second catalogue.
        const offered: ToolAvailability[] = []
        for (const provider of providers) {
            if (provider.available === undefined) continue
            offered.push(...(await provider.available()))
        }
        const notEnabled = offered.filter((entry) => !found.has(normalise(entry.slug)))

        const { kept, dropped } = applyBudget(all, budget)
        if (dropped.length > 0) {
            warnings.push({
                code: "tool_budget_trimmed",
                message: `Resolution produced ${all.length} tools for a cap of ${budget.max}; ${dropped.length} were dropped: ${dropped.map((entry) => entry.slug).join(", ")}.`,
                hint: `Raise tools.budget.max, or pin individual slugs instead of a whole toolkit. ${budget.reserveWrite} slots are held for mutating tools so a large read surface cannot starve them.`,
                field: "tools.budget.max",
            })
        }

        const undocumented = kept
            .filter(
                (tool) =>
                    tool.spec.whenNotToUse === undefined || tool.spec.whenNotToUse.trim() === "",
            )
            .map((tool) => tool.spec.slug)
        if (undocumented.length > 0) {
            warnings.push({
                code: "tool_missing_negative_guidance",
                message: `No "do not use when" guidance for: ${undocumented.join(", ")}.`,
                hint: "The catalogue renders a placeholder rather than inventing one. Negative examples are the cheapest routing-accuracy improvement available, so it is worth writing them by hand for the tools an agent gets wrong.",
            })
        }

        return new ToolRegistry({ tools: kept, dropped, warnings, notEnabled })
    }

    get size(): number {
        return this.#order.length
    }

    /**
     * A new registry with per-turn tools layered on top. Never mutates, and never re-runs the budget.
     *
     * For an active skill's scripts, which exist for one turn and must not reach the slot-1 catalogue.
     * Immutability is what makes that safe: the base registry is the one slot 1 was rendered from at
     * load, it keeps existing untouched, and a turn's overlay cannot leak into the cached prefix even by
     * accident.
     *
     * The budget is deliberately not reapplied. `applyBudget` exists to stop a large provider catalogue
     * from crowding out write tools in a prompt paid for on every turn; these entries are described in
     * the skill's own block, are bounded by `skills.maxActive`, and dropping one silently would leave the
     * model reading an instruction naming a tool the executor would then refuse.
     */
    /**
     * The same registry with extra tools appended.
     *
     * Named `withTools` rather than `withTurnTools`, which is what it was called while every caller
     * was per-turn. A **load-time** caller arrived with Phase 10B — `handoff` is registered because
     * the manifest declared a team, so it belongs in the catalogue slot 1 renders from, exactly like
     * a pinned tool — and a method whose name says "turn" being correct at load is the kind of thing
     * somebody later reads as a bug and "fixes".
     *
     * The distinction that *is* real lives at the call site: a registry built at load is rendered
     * into slot 1 and must stay byte-identical for the prompt cache, while one built per turn must
     * never reach it. This method does not know which it is doing, and should not.
     */
    withTools(extra: readonly Tool[]): ToolRegistry {
        if (extra.length === 0) return this
        const base = this.#order
            .map((spec) => this.#bySlug.get(spec.slug))
            .filter((tool): tool is Tool => tool !== undefined)
        return new ToolRegistry({
            tools: [...base, ...extra],
            dropped: this.dropped,
            warnings: this.warnings,
            notEnabled: this.notEnabled,
        })
    }

    /**
     * The same registry with only the tools a phase allows.
     *
     * `dropped`, `warnings` and `notEnabled` are carried unchanged, and that is deliberate: they describe
     * what happened at *load*, which no phase changes. A phase-filtered `notEnabled` would also read as
     * "these could be enabled", when the truth is that they are enabled and not in this phase — a
     * different sentence, and `phase_set`'s own description is where it belongs.
     */
    inPhase(allow: readonly string[]): ToolRegistry {
        const kept = visibleIn(this.#order, allow)
        if (kept.length === this.#order.length) return this
        const tools = kept
            .map((spec) => this.#bySlug.get(spec.slug))
            .filter((tool): tool is Tool => tool !== undefined)
        return new ToolRegistry({
            tools,
            dropped: this.dropped,
            warnings: this.warnings,
            notEnabled: this.notEnabled,
        })
    }

    /** In catalogue order, which is manifest order. Feeds slot 1 and must stay stable. */
    specs(): readonly ToolSpec[] {
        return this.#order
    }

    has(slug: string): boolean {
        return this.#bySlug.has(slug) || this.#byNormalised.has(normalise(slug))
    }

    /**
     * Throws on an unknown slug rather than returning undefined.
     *
     * Silently dropping an unrecognised call is how a config error becomes a runtime mystery: the
     * model calls a tool, nothing happens, no observation comes back, and it tries again forever.
     */
    resolve(slug: string): Tool {
        const exact = this.#bySlug.get(slug)
        if (exact !== undefined) return exact
        const loose = this.#byNormalised.get(normalise(slug))
        if (loose !== undefined) return loose
        throw unknownToolAtRuntime(
            slug,
            this.#order.map((spec) => spec.slug),
        )
    }
}

/**
 * Trim to the cap, holding slots for mutating tools.
 *
 * The reservation is a floor, not a ceiling: with nothing but write tools resolved, they take the
 * whole budget. Its only job is to stop a read surface from crowding them out.
 */
export function applyBudget(
    tools: readonly Tool[],
    budget: ToolBudget,
): { kept: readonly Tool[]; dropped: readonly DroppedTool[] } {
    if (tools.length <= budget.max) return { kept: tools, dropped: [] }

    const reads = tools.filter((tool) => !tool.spec.mutating)
    const writes = tools.filter((tool) => tool.spec.mutating)

    const held = Math.min(writes.length, budget.reserveWrite)
    const keptReads = reads.slice(0, Math.max(0, budget.max - held))
    const keptWrites = writes.slice(0, Math.max(0, budget.max - keptReads.length))

    const keptSet = new Set([...keptReads, ...keptWrites])
    return {
        // Original order, so the catalogue does not reshuffle when one tool falls off the end.
        kept: tools.filter((tool) => keptSet.has(tool)),
        dropped: tools
            .filter((tool) => !keptSet.has(tool))
            .map((tool) => ({
                slug: tool.spec.slug,
                reason: tool.spec.mutating
                    ? `over tools.budget.max (${budget.max}) after the write reservation was filled`
                    : `over tools.budget.max (${budget.max}), with ${held} slots held for mutating tools`,
            })),
    }
}

/** Everything resolvable, for the "did you mean" line. Best-effort: `list` is optional. */
async function listAll(providers: readonly ToolProvider[]): Promise<readonly string[]> {
    const out: string[] = []
    for (const provider of [localProvider(), ...providers]) {
        if (provider.list === undefined) continue
        out.push(...(await provider.list()))
    }
    return out
}
