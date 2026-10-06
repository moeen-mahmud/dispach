/**
 * What a child process sees of the runtime's environment: `exec` and a skill's scripts.
 *
 * `inherit` (the default, and every agent before pilot.9) hands a child the whole resolved
 * environment, which on a hosted silo includes the API token, the AWS container token and whatever
 * relay credentials the embedder set — so `env` or `cat /proc/self/environ` in one command prints
 * them all. The read guard in `protect.ts` never bound `exec`, by its own comment.
 *
 * `scrub` hands a child only what a shell needs to behave (`BASE`), plus any names the manifest lists.
 * It is opt-in because an agent whose commands rely on, say, `GITHUB_TOKEN` for `gh` would otherwise
 * stop working on upgrade; such an agent lists the name instead.
 *
 * The other half is not this package's to close: a child runs as the runtime's own user, so it can
 * read `/proc/<runtime pid>/environ` directly. That is a deployment step — `/proc` mounted with
 * `hidepid=2`, or secrets passed as files (`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`) — and saying
 * so beats a setting that reads as a boundary and is not one.
 */

import { ConfigError } from "@dispach/core"

export type EnvPolicy = "inherit" | { readonly scrub: true; readonly pass: readonly string[] }

/** Enough for a shell, a locale and a temp directory. No credential ever has one of these names. */
const BASE = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "TMPDIR",
]

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `env:` from the provider's config: absent or `inherit`, `scrub`, or a list of names to pass. */
export function envPolicy(value: unknown): EnvPolicy {
    if (value === undefined || value === "inherit") return "inherit"
    if (value === "scrub") return { scrub: true, pass: [] }
    if (
        Array.isArray(value) &&
        value.every((name) => typeof name === "string" && NAME.test(name))
    ) {
        return { scrub: true, pass: value as string[] }
    }
    throw new ConfigError({
        code: "system_env_invalid",
        message: `tools.providers.system.env is ${JSON.stringify(value)}, which is none of inherit, scrub or a list of variable names.`,
        hint: "Write `env: scrub` to give commands only PATH, HOME, the locale and the like, or `env: [GITHUB_TOKEN]` to scrub and pass those names too. Omit it (or `inherit`) to keep handing commands the whole environment.",
        field: "tools.providers.system.env",
    })
}

export function childEnv(
    env: Readonly<Record<string, string | undefined>>,
    policy: EnvPolicy,
): Readonly<Record<string, string | undefined>> {
    if (policy === "inherit") return env
    const keep = new Set([...BASE, ...policy.pass])
    return Object.fromEntries(
        Object.entries(env).filter(([name]) => keep.has(name) || name.startsWith("LC_")),
    )
}
