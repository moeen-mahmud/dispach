/**
 * Whether a variable an agent depends on is actually set, from that agent's point of view.
 *
 * `ambientEnv` is **not** this. It layers the *cwd*'s `.env` against an agent's — demoting a colliding
 * variable so a project checkout cannot silently change which model a sandbox agent runs on — and it
 * returns `process.env` unchanged whenever nothing is in tension. It never *adds* the agent's own file.
 *
 * The agent's `.env` is merged by `loadManifest`, through core's `layeredEnv`, and that is the answer a
 * question about this agent needs. Reading `process.env` alone reported a variable as unset while the
 * file beside the manifest plainly had it — the same class of mistake `serve` made once, reporting
 * "unauthenticated" for a token sitting next to the manifest. It showed up here as an editor row that
 * still read `(not set)` immediately after somebody set it, which is the "did that work?" failure this
 * whole surface exists to remove.
 *
 * Precedence is core's, unchanged: the real environment wins, because an operator's export has to beat
 * a file for a container to be able to configure the agent it runs.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { type EnvSource, layeredEnv, parseDotEnv } from "@dispach/core"
import { type AmbientOptions, ambientEnv, readDotEnv } from "#lib/ambient"

/** The environment this agent will actually see: its own `.env` under the ambient one. */
export function agentEnv(manifestPath: string): EnvSource {
    const path = join(dirname(manifestPath), ".env")
    let beside: Record<string, string> = {}
    if (existsSync(path)) {
        try {
            beside = parseDotEnv(readFileSync(path, "utf8"))
        } catch {
            // An unreadable `.env` is reported by the loader, in the words the loader uses. Here it
            // simply means nothing is known to be set, which is the safe reading for a "is it set?"
            // question — claiming a variable is present when the file cannot be read would be worse.
        }
    }
    return layeredEnv(beside, ambientEnv([manifestPath]))
}

/** Whether `name` has a non-empty value. Empty counts as unset: it fails a load exactly as absent does. */
export function isSet(env: EnvSource, name: string): boolean {
    const value = env[name]
    return value !== undefined && value !== ""
}

/**
 * Where a value came from, which is a different question from whether it is set.
 *
 * Three layers can supply one variable and the winner is not obvious from any of them:
 *
 * 1. the real environment — an operator's export, or a container's `environment:` block
 * 2. the `.env` beside the agent's manifest
 * 3. a `.env` in the directory the command was run from, demoted beneath (2) by `ambientEnv`
 *
 * Every one of those is correct on its own, and the composition is unreadable. It produced a real
 * confusion in a container: `docker compose` passes `MODEL_ID` and friends as process environment,
 * so an agent scaffolded inside that container silently ran on the *mounted*
 * agent's model, and the `0600` `.env` that `init` had just written was ignored for exactly those
 * keys — with nothing anywhere saying so.
 *
 * The precedence is not the bug and is not changed here. What was missing is a sentence, and the
 * recorded lesson from the last time this surfaced is that *a warning explained the surprise and
 * did not remove it* — so this reports rather than intervenes.
 */
export type EnvOrigin =
    /** The real environment won: an export, or a container's own configuration. */
    | { readonly kind: "export" }
    /** The `.env` beside the manifest won. */
    | { readonly kind: "agent"; readonly path: string }
    /**
     * Either an export or the cwd's `.env`, and **they cannot be told apart**.
     *
     * Bun auto-loads a `.env` from the current directory into `process.env` before any of this code
     * runs, so once the two agree on a string there is no evidence left distinguishing them. Said
     * rather than guessed: naming one would be a coin toss printed as a fact.
     */
    | { readonly kind: "ambiguous"; readonly path: string }
    | { readonly kind: "unset" }

/**
 * Which layer supplies `name` for this agent.
 *
 * Mirrors `ambientEnv`'s precedence by *calling* it rather than by restating it — the demotion rule
 * is subtle (a cwd variable is demoted only when the agent's own file also sets it *and* the values
 * match), and a second implementation of that would drift on the first edit.
 */
export function sourceOf(
    manifestPath: string,
    name: string,
    options: AmbientOptions = {},
): EnvOrigin {
    const agentDir = dirname(manifestPath)
    const cwd = resolve(options.cwd ?? process.cwd())
    const read = options.readDir ?? readDotEnv
    const raw = options.env ?? process.env

    const ambient = ambientEnv([manifestPath], options)
    const beside = read(agentDir)
    const inCwd = read(cwd)

    const fromAmbient = ambient[name]
    if (fromAmbient !== undefined && fromAmbient !== "") {
        // The cwd file is only a candidate when it is a *different* directory from the agent's: when
        // they are the same directory, that file **is** the agent's own and `ambientEnv` says so.
        const sameDir = resolve(agentDir) === cwd
        const cwdValue = inCwd[name]
        if (!sameDir && cwdValue !== undefined && raw[name] === cwdValue) {
            return { kind: "ambiguous", path: join(cwd, ".env") }
        }
        return { kind: "export" }
    }

    const fromFile = beside[name]
    if (fromFile !== undefined && fromFile !== "") {
        return { kind: "agent", path: join(agentDir, ".env") }
    }

    return { kind: "unset" }
}

/**
 * The phrase for a status line — short, because it rides after a value somebody is already reading.
 *
 * Returns `undefined` for the ordinary case, which is the whole point: a line that always carries a
 * provenance note is a line nobody reads it on. The agent's own `.env` winning is what an author
 * expects, so only the surprising sources say anything.
 */
export function describeOrigin(origin: EnvOrigin): string | undefined {
    switch (origin.kind) {
        case "export":
            return "from the environment, not a .env file"
        case "ambiguous":
            return "from the environment or ./.env — indistinguishable"
        case "agent":
            return undefined
        case "unset":
            return "not set"
    }
}

/** One env-backed field, the variable behind it, and where the value came from. */
export interface Provenance {
    readonly field: string
    readonly variable: string
    readonly origin: EnvOrigin
}

/**
 * The env-backed fields worth saying something about, and only when there is something to say.
 *
 * Two fields, chosen because they are the two that produced a real confusion in a container:
 * `docker compose` passes `MODEL_ID` and `MODEL_API_KEY` as process environment, and the ambient
 * environment deliberately beats the agent's own file so an operator can configure the agent their
 * container runs. So an agent scaffolded in that container ran on the *mounted*
 * agent's model and ignored the `0600` `.env` init had just written.
 *
 * The model id is included **only when the manifest writes it as a variable**. A generated manifest
 * carries it literally (which is why `readManifestHeader` can list agents without credentials), and
 * a literal has no provenance to report — printing "from the environment" about a value nothing read
 * from the environment would be worse than silence. `apiKeyEnv` is always a variable name by hard
 * rule 10, so it is always askable.
 */
export function envProvenance(input: {
    readonly manifestPath: string
    /** The raw, unexpanded `model.main.id` — `readManifestHeader().modelId`. */
    readonly rawModelId: string | undefined
    readonly apiKeyEnv: string | undefined
    readonly options?: AmbientOptions
}): readonly Provenance[] {
    const rows: Provenance[] = []
    const variable = soleVariable(input.rawModelId)
    if (variable !== undefined) {
        rows.push({
            field: "model.main.id",
            variable,
            origin: sourceOf(input.manifestPath, variable, input.options ?? {}),
        })
    }
    if (input.apiKeyEnv !== undefined) {
        rows.push({
            field: "model.main.apiKeyEnv",
            variable: input.apiKeyEnv,
            origin: sourceOf(input.manifestPath, input.apiKeyEnv, input.options ?? {}),
        })
    }
    return rows
}

/**
 * The variable name when a value is exactly one `${VAR}` reference, and nothing otherwise.
 *
 * Deliberately narrow. `prefix-${VAR}` expands from the environment too, but its provenance is a
 * sentence about part of a string, and a half-true note on a compound value is the kind of detail
 * that gets believed whole.
 */
function soleVariable(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.trim())
    return match?.[1]
}
