/**
 * Turning `GET /v1/provision` into a form, and a form back into an answer set.
 *
 * Pure and separate from the component for the reason every reducer in `packages/cli` is: the
 * interesting cases are a step that is only asked because of an earlier answer, a required field
 * left empty, and a secret the operator skipped — and none of them is worth mounting a page to
 * check.
 *
 * ## Why the page does not know the questions
 *
 * Every step, prompt, default and choice list comes off the wire, generated from the *same walk*
 * the terminal wizard follows. A question list written down here would be the two-hand-kept-lists
 * shape `GET /v1/provision` exists to prevent — right when written, wrong at the next capability,
 * with nothing reporting the gap. So this module knows the *rules* of a form and none of its
 * content.
 *
 * ## Secrets
 *
 * A secret answer lives in React state and nowhere else: not in the URL, not in `localStorage`, not
 * in `sessionStorage`. It is sent once, written into the agent's `.env` at `0600`, and no route
 * reads it back — so a page that stashed one would be the only copy anywhere a refresh could leak.
 */

import type { ProvisionStepLike } from "@dispach/client"

export type Answers = Readonly<Record<string, string>>

/**
 * The default for every step, as the server resolved it.
 *
 * Includes steps that are not currently askable, deliberately: an operator who picks
 * `telegram: connected`, types a token, changes their mind and picks it again should find the token
 * still there. `payloadFor` is what decides whether an answer is *sent*, and it asks about
 * visibility — so holding an answer for a hidden step costs nothing and losing it is annoying.
 */
export function initialAnswers(steps: readonly ProvisionStepLike[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const step of steps) out[step.step] = step.fallback
    return out
}

/** How deep a `requires` chain may go before something is wrong. `web → webBackend` is 2. */
const CHAIN_GUARD = 8

/**
 * Is this step asked, given the answers so far?
 *
 * **Transitive**, because the wire records only the *nearest* opening choice: `webKey` requires
 * `web: search` and `webBackend` requires the same, so a chain that stopped at the first link would
 * be right today and wrong the moment a third level lands. A step whose requirement names a step
 * that is not itself in the list is treated as **not** askable — a requirement nothing can satisfy
 * is a form bug, and rendering the field anyway would put a value in front of somebody that the
 * route then refuses as unknown.
 */
export function askable(
    steps: readonly ProvisionStepLike[],
    step: ProvisionStepLike,
    answers: Answers,
): boolean {
    let current: ProvisionStepLike | undefined = step
    for (let depth = 0; depth < CHAIN_GUARD; depth += 1) {
        if (current === undefined) return false
        // Annotated, not inferred: `requires` is read off `current` and `current` is reassigned
        // from a lookup keyed on `requires`, which TypeScript reads as a cycle (TS7022).
        const requires: ProvisionStepLike["requires"] = current.requires
        if (requires === undefined) return true
        if (answers[requires.step] !== requires.value) return false
        current = steps.find((candidate) => candidate.step === requires.step)
    }
    return false
}

/** The fields to draw, in the order the wire sent them — which is the terminal's asking order. */
export function visibleSteps(
    steps: readonly ProvisionStepLike[],
    answers: Answers,
): readonly ProvisionStepLike[] {
    return steps.filter((step) => askable(steps, step, answers))
}

/**
 * Required fields with no answer — the submit gate.
 *
 * Checked here rather than left to the route because the route answers one field at a time, and a
 * form that submits three times to learn about three empty fields is a form that feels broken.
 * Only *visible* steps count: a required question nobody was asked has its default filled server
 * side, exactly as `init --yes` does.
 */
export function missingAnswers(
    steps: readonly ProvisionStepLike[],
    answers: Answers,
): readonly ProvisionStepLike[] {
    return visibleSteps(steps, answers).filter(
        (step) => step.optional !== true && (answers[step.step] ?? "").trim() === "",
    )
}

/**
 * What to send.
 *
 * Two omissions, and each is a decision. A **hidden** step is not sent, because an answer to a
 * question that was not asked is exactly the "accepted and acted on by nobody" shape this route was
 * just corrected for. An **empty** answer is not sent, because absence means "take the default" on
 * this route and an empty string means "the variable is supplied another way" — sending `""` for a
 * required step would turn a field the operator never touched into a refusal.
 */
export function payloadFor(
    steps: readonly ProvisionStepLike[],
    answers: Answers,
): Record<string, string> {
    const out: Record<string, string> = {}
    for (const step of visibleSteps(steps, answers)) {
        const value = (answers[step.step] ?? "").trim()
        if (value !== "") out[step.step] = value
    }
    return out
}

/**
 * Secrets the operator was asked for and left empty.
 *
 * Reported after a create, because this is the one thing that stops a provisioned agent working and
 * the one thing no route can fix: `.env` is a **protected path**, so neither the agent nor the API
 * can fill it in afterwards. Named by the step's own `prompt` rather than by an environment
 * variable, because a step-to-variable map here would be a second copy of the one the generated
 * `.env` already writes as comments.
 */
export function blankSecrets(
    steps: readonly ProvisionStepLike[],
    answers: Answers,
): readonly ProvisionStepLike[] {
    return visibleSteps(steps, answers).filter(
        (step) => step.secret && (answers[step.step] ?? "").trim() === "",
    )
}
