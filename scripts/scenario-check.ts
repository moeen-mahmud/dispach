/**
 * The deterministic half of a scenario step: did the agent call what it should have?
 *
 * Kept apart from `eval-scenarios.ts` so it can be tested — that script runs on import. This is the
 * part the judge is never asked about: which tools were called with which arguments is a fact about
 * the call log.
 */

export interface Call {
    readonly slug: string
    readonly args: Readonly<Record<string, unknown>>
}

export interface ExpectedCall {
    readonly slug: string
    /** Every key given must equal the call's value for it; keys not given are not checked. */
    readonly args?: Readonly<Record<string, unknown>> | undefined
}

export type CallOrder = "exact" | "in_order" | "any_order"

function argsMatch(
    expected: Readonly<Record<string, unknown>> | undefined,
    actual: Readonly<Record<string, unknown>>,
): boolean {
    if (expected === undefined) return true
    return Object.entries(expected).every(
        ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
    )
}

/**
 * `undefined` when the call log satisfies the expectation, otherwise what is wrong with it.
 *
 * - `exact`: these calls and no others, in this order.
 * - `in_order` (the default): these calls appear in this order; others may come between them.
 * - `any_order`: each of these calls appears somewhere.
 *
 * An empty expectation under `exact` means "no tool at all" — the restraint case, where the right
 * answer is to call nothing. Under the other two it checks nothing.
 */
export function checkCalls(
    expected: readonly ExpectedCall[],
    calls: readonly Call[],
    order: CallOrder,
): string | undefined {
    // Arguments are shown whenever the expectation has any, or "expected [send], got [send]" reads as
    // a pass when it is the recipient that differs.
    const withArgs = expected.some((e) => e.args !== undefined)
    const show = (slug: string, args: unknown) =>
        withArgs && args !== undefined ? `${slug} ${JSON.stringify(args).slice(0, 120)}` : slug
    const seen = calls.map((c) => show(c.slug, c.args)).join(", ") || "(none)"
    const names = expected.map((e) => show(e.slug, e.args)).join(", ")
    if (order === "exact") {
        const same =
            expected.length === calls.length &&
            expected.every(
                (e, i) => e.slug === calls[i]?.slug && argsMatch(e.args, calls[i]?.args ?? {}),
            )
        return same ? undefined : `expected exactly [${names}], got [${seen}]`
    }
    if (order === "any_order") {
        const missing = expected.filter(
            (e) => !calls.some((c) => c.slug === e.slug && argsMatch(e.args, c.args)),
        )
        return missing.length === 0
            ? undefined
            : `missing ${missing.map((m) => m.slug).join(", ")}; got [${seen}]`
    }
    let at = 0
    for (const call of calls) {
        const want = expected[at]
        if (want !== undefined && want.slug === call.slug && argsMatch(want.args, call.args))
            at += 1
    }
    return at === expected.length ? undefined : `expected in order [${names}], got [${seen}]`
}
