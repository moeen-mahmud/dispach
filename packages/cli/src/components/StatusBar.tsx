/**
 * One line saying what the runtime is doing.
 *
 * It exists to answer a question the old REPL could not: is this slow or is it hung? A model that
 * takes twelve seconds before its first token and a model that will never answer look identical
 * without an elapsed counter, and "nothing is happening" is the least debuggable state a tool can
 * present.
 */

import { Text } from "ink"
import type { StatusBarProps } from "#lib/schema"
import { GLYPH, STATUS_COLOR, THEME } from "#lib/theme"
import type { TurnStatus } from "#lib/types"
import { formatStats } from "#transcript"

const LABEL: Record<TurnStatus, string> = {
    idle: "ready",
    thinking: "thinking",
    streaming: "replying",
    working: "running a tool",
    cancelling: "cancelling",
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`
}

/**
 * What ^C will do, said in the place a reader is already looking.
 *
 * Three states rather than two, because the chord now has three meanings and the wrong hint is worse
 * than none: mid-turn it cancels, at an idle prompt it arms, and once armed it leaves. The armed line is
 * the one that has to be loud — it is the only moment when the next keystroke discards the screen.
 */
function exitHint(status: TurnStatus, armed: boolean): string {
    if (status !== "idle") return " · ^C cancels"
    return armed ? " · ^C again to leave" : " · ^C twice to leave · /exit"
}

function reasoningHint(status: TurnStatus): string {
    if (status !== "idle") return ""
    return " · ^O show reasoning"
}

/**
 * Below this the gauge is hidden: the lowest shipped threshold is `trim` at 0.60, so anything under
 * half is a prompt with nothing to say about itself.
 */
const PRESSURE_VISIBLE_AT = 0.5

/** Coloured from here — past the shipped `micro` threshold, where the stages start costing fidelity. */
const PRESSURE_WARN_AT = 0.8

export function StatusBar({
    status,
    model,
    sessionKey,
    elapsedMs,
    last,
    quiet,
    armed,
    pressure,
    phase,
}: StatusBarProps) {
    return (
        // Truncated, never wrapped. Found live at 80 columns: `ready · deepseek-v4-pro · live:two · last
        // 2330 prompt · 80 output · 2681 ms · ^C twice to leave · /exit` is longer than the terminal, so Ink
        // wrapped it onto a second row — which made the frame one row taller than `chatFrame` had counted
        // and pushed the top of the display off the alternate buffer. A status line is the one thing that
        // must never change height: everything else is laid out against it.
        <Text dimColor wrap="truncate">
            <Text color={STATUS_COLOR[status]}>
                {GLYPH.dot}
                {LABEL[status]}
            </Text>
            {status === "idle" ? "" : ` ${seconds(elapsedMs)}`}
            {` · ${model} · ${sessionKey}`}
            {/* Straight after the session key, because a phase is a property of the conversation. */}
            {phase === undefined || quiet ? "" : ` · ${phase}`}
            {/*
             * Ahead of the turn stats, and that is not cosmetic. This line is truncated rather than
             * wrapped, and a real 100-column capture cut it mid-figure at `2564…` — so anything
             * appended after the stats vanishes exactly when the session is busiest, which is when the
             * gauge is the one thing worth reading. What a person can act on comes first.
             *
             * Shown only once it is worth knowing: below the lowest shipped threshold the number is
             * noise, and a gauge that is always visible is a gauge nobody reads.
             */}
            {pressure === undefined || pressure < PRESSURE_VISIBLE_AT || quiet ? (
                ""
            ) : (
                // Spread, not `color={cond ? x : undefined}`: Ink declares `color?: string`, so under
                // `exactOptionalPropertyTypes` an explicit undefined is a type error — and omitting it
                // is what we want anyway, so the figure inherits the dim style of the line.
                <Text {...(pressure >= PRESSURE_WARN_AT ? { color: THEME.warning } : {})}>
                    {` · ctx ${Math.round(pressure * 100)}%`}
                </Text>
            )}
            {last === undefined || quiet ? "" : ` · last ${formatStats(last)}`}
            {reasoningHint(status)}
            {armed === true ? (
                <Text color={THEME.warning}>{exitHint(status, true)}</Text>
            ) : (
                exitHint(status, false)
            )}
        </Text>
    )
}
