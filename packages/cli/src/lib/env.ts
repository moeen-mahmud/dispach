/**
 * Every environment read the CLI makes.
 *
 * Centralised for the same reason termheat centralises it: an environment variable consulted deep
 * inside a component is untestable and invisible. Everything downstream takes an `EnvFacts` value,
 * so the interesting logic — `resolveMode` especially — is a pure function of its inputs.
 */

import { BRAND } from "@dispach/core"
import type { EnvFacts } from "#lib/types"

/**
 * `NO_COLOR` is honoured when present and non-empty, per no-color.org. An exported-but-empty
 * variable is a container passing through something unset, not a stated preference.
 */
function isSet(value: string | undefined): boolean {
    return value !== undefined && value !== ""
}

export function readEnv(env: Readonly<Record<string, string | undefined>> = process.env): EnvFacts {
    return {
        noColor: isSet(env.NO_COLOR),
        dumbTerminal: env.TERM === "dumb",
        // `CI=false` is set by tooling that wants to say "not CI", and taking it literally would
        // strip interactivity from a terminal that has it.
        ci: isSet(env.CI) && env.CI !== "false",
        debug: isSet(env.DEBUG),
        // The sandbox root override, `<ENVPREFIX>HOME`. Brand-derived so a rename moves it.
        sandboxHome: isSet(env[`${BRAND.envPrefix}HOME`])
            ? env[`${BRAND.envPrefix}HOME`]
            : undefined,
        // Brand-derived like the sandbox root above, so a rename moves it.
        noEnhancedKeys: isSet(env[`${BRAND.envPrefix}NO_CSI_U`]),
    }
}
