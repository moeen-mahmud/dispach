/**
 * Which tools a phase exposes, and which phase a session is in.
 *
 * Decision 4.8: phase-scoped tool visibility is in **core**, not a plugin. Constraining the tool space
 * per phase took local models from 2/10 to 10/10 on a benchmark subset with no model change, which
 * makes it too central to be optional — and it is the same reasoning as 4.7, which keeps tool *search*
 * off: every extra tool in front of a small model is another branch it can take wrongly, and the fix is
 * to remove branches rather than to explain them.
 *
 * `phases` has been in `02-SPEC-MANIFEST.md` and in `PhaseSchema` since Phase 1, refused at load as
 * `not_implemented_yet`. This is what implements it. `ToolSpec.tags` was already carried for exactly
 * this, with a comment saying so.
 *
 * ## What a phase change costs, and why it is paid
 *
 * The catalogue is slot 1, inside the cache-stable prefix. Changing the visible tool set mid-turn
 * therefore invalidates the cached prefix from slot 1 onward for that request. That is accepted
 * deliberately: `triage` → `phase_set("act")` → write, inside one turn, is the whole feature, and
 * deferring the effect to the next turn recreates precisely the two-hop shape decision 4.7 refuses —
 * in the feature that exists for the models which fail it. The third option, rendering every tool and
 * marking the out-of-phase ones unavailable, loses for a worse reason: it puts the write tools back in
 * front of the model during triage, which is the constraint the phase exists to impose.
 *
 * A phase change is rare by construction — a session moves forward through phases, not back and forth —
 * so the cost is one uncached prefix on the turns where the agent changed what it was doing.
 */

import type { ToolSpec } from "../tools/types.ts"

/**
 * As declared in the manifest. Mirrors `PhaseSchema`.
 *
 * `entry?: boolean | undefined` rather than `entry?: boolean`, because under
 * `exactOptionalPropertyTypes` those are different types and Zod infers the first — a mirror written the
 * tidier way does not accept the value it exists to describe.
 */
export interface PhaseConfig {
    readonly allow: readonly string[]
    readonly entry?: boolean | undefined
}

export type PhaseMap = Readonly<Record<string, PhaseConfig>>

/** The slug the runtime registers when more than one phase is declared. */
export const PHASE_SET = "phase_set"

/** Matches every tool. The single-phase default, and the escape for a phase that constrains nothing. */
export const ALLOW_ALL = "*"

const TAG_PREFIX = "tag:"

/**
 * Where a session starts.
 *
 * `entry: true` wins; otherwise the first *declared* phase, which is why the manifest loader must
 * preserve key order — an object whose iteration order changed would silently move the starting phase,
 * and the symptom would be an agent that begins with the wrong tools rather than an error.
 */
export function entryPhase(phases: PhaseMap): string | undefined {
    const names = Object.keys(phases)
    const declared = names.find((name) => phases[name]?.entry === true)
    return declared ?? names[0]
}

/** Slug comparison, matching the registry's own normalisation so `memory-write` finds `memory_write`. */
function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

/**
 * Does one `allow` entry name this tool?
 *
 * Three forms, per the spec: `*`, a `tag:<name>`, or a slug. Nothing else — a pattern language here
 * would be a second matcher beside `tools.policy`'s, and the two disagreeing about what `exec*` means
 * is a worse failure than not supporting it.
 */
export function allowMatches(entry: string, spec: ToolSpec): boolean {
    if (entry === ALLOW_ALL) return true
    if (entry.startsWith(TAG_PREFIX)) {
        const tag = entry.slice(TAG_PREFIX.length).toLowerCase()
        return spec.tags.some((own) => own.toLowerCase() === tag)
    }
    return normalise(entry) === normalise(spec.slug)
}

export function visibleIn(
    specs: readonly ToolSpec[],
    allow: readonly string[],
): readonly ToolSpec[] {
    // Catalogue order preserved, because slot 1 must be byte-stable for a given phase. Filtering keeps
    // the original order for free; re-sorting by anything would not.
    return specs.filter((spec) => allow.some((entry) => allowMatches(entry, spec)))
}

/**
 * `allow` entries that name nothing in this catalogue.
 *
 * Spec rule 6 makes these a load failure, and the reason is the same one that makes `resolve()` throw
 * on an unknown slug: a phase whose `allow` names a tool that is not there is a phase that silently
 * exposes less than its author wrote, and the symptom appears turns later as a model declining work it
 * was supposed to be able to do. Reported as data rather than thrown, so the caller decides — the same
 * shape as `ruleBudgetFailure`, for the same reason.
 */
export function unmatchedAllows(
    phases: PhaseMap,
    specs: readonly ToolSpec[],
): readonly { readonly phase: string; readonly entry: string }[] {
    const found: { phase: string; entry: string }[] = []
    for (const [phase, config] of Object.entries(phases)) {
        for (const entry of config.allow) {
            // `phase_set` is registered by the runtime rather than pinned, so an author who lists it
            // explicitly is not making a mistake — and it is always visible anyway, see `allowFor`.
            if (entry === PHASE_SET) continue
            if (!specs.some((spec) => allowMatches(entry, spec))) found.push({ phase, entry })
        }
    }
    return found
}

/**
 * The effective allow list for a phase: what it declares, plus `phase_set`.
 *
 * `phase_set` is added unconditionally, and that is not a convenience. A phase that omitted it would be
 * a phase with no way out — the agent would be stuck in `triage` for the rest of the session with no
 * error anywhere, which is the shape of failure this project cares most about. Leaving it to authors to
 * remember in every phase is leaving a trap in the manifest format.
 */
export function allowFor(phases: PhaseMap, phase: string): readonly string[] {
    const config = phases[phase]
    if (config === undefined) return [ALLOW_ALL]
    return config.allow.includes(PHASE_SET) ? config.allow : [...config.allow, PHASE_SET]
}

/** Whether `phases` describes more than one phase, which is what makes `phase_set` worth registering. */
export function isPhased(phases: PhaseMap | undefined): phases is PhaseMap {
    return phases !== undefined && Object.keys(phases).length > 1
}

/**
 * Which declared phases make this tool visible — the inverse of `visibleIn`, per tool.
 *
 * In core rather than in the HTTP layer, because it is a statement about phase semantics: `allow`
 * takes `*`, `tag:<name>` and slugs, with the registry's own slug normalisation, and a second
 * implementation of that in a route handler is a second answer to "is this tool in that phase".
 * The introspection surface and the runtime have to agree, for the same reason `validate` and
 * `run` call one `ruleBudgetFailure`.
 *
 * Declared order, and `phase_set` is included in every phase's effective allow list by `allowFor`
 * — so `phase_set` correctly reports every phase rather than only the ones that name it.
 */
export function phasesFor(phases: PhaseMap, spec: ToolSpec): readonly string[] {
    return Object.keys(phases).filter((name) =>
        allowFor(phases, name).some((entry) => allowMatches(entry, spec)),
    )
}

/**
 * What each other phase would add, as counts rather than slugs.
 *
 * This is what `phase_set` tells the model, and the form is the point. A model in `triage` that is told
 * nothing about `act` reports that it cannot write — decision 4.53's failure, where an agent said its
 * only route to the web was `curl` because the provider was switched off. Listing the hidden slugs
 * instead would put the write tools back in front of it and undo the constraint. A count plus a name
 * gives it a reason to switch and nothing to route over.
 */
export function otherPhases(
    phases: PhaseMap,
    current: string,
    specs: readonly ToolSpec[],
): readonly { readonly name: string; readonly adds: number }[] {
    const here = new Set(visibleIn(specs, allowFor(phases, current)).map((spec) => spec.slug))
    return Object.keys(phases)
        .filter((name) => name !== current)
        .map((name) => ({
            name,
            adds: visibleIn(specs, allowFor(phases, name)).filter((spec) => !here.has(spec.slug))
                .length,
        }))
}
