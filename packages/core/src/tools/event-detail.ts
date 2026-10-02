/**
 * What a tool event carries under `tools.eventDetail: redacted` (pilot.5, VelaCrew #16).
 *
 * `tool.call` has carried `argsHash` rather than the arguments since Phase 3, because arguments hold
 * what a person typed and sometimes what a tool needs to authenticate. An embedder showing a chat
 * wants to expand a call into what it did and what came back, so this adds both, opt-in, after two
 * kinds of redaction:
 *
 * - **by key**: a value under a key that names a credential (`token`, `password`, `apiKey`, …) is
 *   replaced whatever it holds;
 * - **by value**: anywhere in the arguments or the output, the value of an environment variable whose
 *   name says it is a secret (`*_KEY`, `*_TOKEN`, …) is replaced. That is what catches a key the model
 *   pasted into a `curl` command, which no key name would.
 *
 * Neither is a guarantee, and this says so: a secret the agent was told in conversation is in neither
 * list. It is a display feature with a floor under it, which is why it is off by default.
 */

import type { EnvSource } from "../manifest/env.ts"
import { stripControl } from "./sanitise.ts"

/** How much of a tool's output an event carries. */
export const EVENT_OUTPUT_CHARS = 2048
/** How much of any one string argument. A `file_write` body is not a thing to put on every event. */
const EVENT_ARG_CHARS = 1024
const REDACTED = "[redacted]"

const SECRET_KEY =
    /pass(word|wd|phrase)?$|secret|token|api[-_]?key|private[-_]?key|authorization|cookie|credential|^auth$/i
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i
/** Shorter than this, a value is too likely to occur by accident to be worth replacing. */
const MIN_SECRET_CHARS = 8

export interface EventDetail {
    args(args: Readonly<Record<string, unknown>>): Record<string, unknown>
    output(output: string): { readonly output: string; readonly outputTruncated: boolean }
}

export function eventDetail(env: EnvSource): EventDetail {
    const secrets = Object.entries(env)
        .filter(
            ([name, value]) =>
                SECRET_ENV_NAME.test(name) && (value?.length ?? 0) >= MIN_SECRET_CHARS,
        )
        .map(([, value]) => value as string)
        // Longest first, so a secret that contains another is replaced whole.
        .sort((a, b) => b.length - a.length)
    const scrub = (text: string): string => {
        let out = text
        for (const secret of secrets) out = out.replaceAll(secret, REDACTED)
        return out
    }
    const clip = (text: string, max: number) =>
        text.length > max ? `${text.slice(0, max)}…` : text

    const walk = (value: unknown, key: string | undefined): unknown => {
        if (key !== undefined && SECRET_KEY.test(key)) return REDACTED
        if (typeof value === "string") return clip(scrub(stripControl(value)), EVENT_ARG_CHARS)
        if (Array.isArray(value)) return value.map((item) => walk(item, undefined))
        if (value !== null && typeof value === "object") {
            return Object.fromEntries(
                Object.entries(value).map(([inner, item]) => [inner, walk(item, inner)]),
            )
        }
        return value
    }

    return {
        args: (args) => walk(args, undefined) as Record<string, unknown>,
        output: (output) => {
            const clean = scrub(stripControl(output))
            return {
                output: clean.slice(0, EVENT_OUTPUT_CHARS),
                outputTruncated: clean.length > EVENT_OUTPUT_CHARS,
            }
        },
    }
}
