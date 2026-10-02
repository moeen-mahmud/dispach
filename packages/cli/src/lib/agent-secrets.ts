/**
 * An agent's credentials, set over the API: which ones it reads, and writing them.
 *
 * **The variable is resolved from the manifest, never taken on trust from the caller.** A route that
 * wrote whatever name it was sent would write any variable at all, the one this host authenticates
 * with included. The set a caller may write is exactly the set the agent's own manifest reads, as
 * `${VAR}` or through an `*Env` field. That rule is `ChannelAdmin.setCredential`'s, generalised
 * from one channel to the whole manifest.
 *
 * **Minus the server's own token.** `server.tokenEnv` authenticates callers of the agent's API, and a
 * caller able to set it could replace the credential it is checked against.
 *
 * Values are write-only. `secretStatus` says whether each is set, never what it is.
 */

import { readFileSync } from "node:fs"
import { HarnessError, manifestEnvReferences } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { applySecret } from "#lib/config-apply"
import { agentEnv, isSet } from "#lib/config-env"

/** The dotted path excluded by meaning rather than by name. See the module comment. */
const SERVER_TOKEN_PATH = "server.tokenEnv"

export interface SecretStatus {
    readonly name: string
    /** Whether the agent will see a non-empty value: its `.env` layered under the real environment. */
    readonly set: boolean
    /** The fields that read it, so a caller can tell `MODEL_API_KEY` for the model from one for a tool. */
    readonly usedBy: readonly string[]
}

/** Every variable this agent's manifest reads that a caller may set, in first-use order. */
export function secretStatus(manifestPath: string): readonly SecretStatus[] {
    const text = readFileSync(manifestPath, "utf8")
    const env = agentEnv(manifestPath)
    const byName = new Map<string, string[]>()
    const serverToken = new Set(
        manifestEnvReferences(text)
            .filter((ref) => ref.path === SERVER_TOKEN_PATH)
            .map((ref) => ref.name),
    )
    for (const ref of manifestEnvReferences(text)) {
        if (serverToken.has(ref.name)) continue
        const uses = byName.get(ref.name) ?? []
        uses.push(ref.path)
        byName.set(ref.name, uses)
    }
    return [...byName].map(([name, usedBy]) => ({ name, set: isSet(env, name), usedBy }))
}

export interface SecretsWritten {
    readonly written: readonly string[]
    /**
     * Written, and not what the agent will see, because the real environment sets the same variable
     * and wins. Precedence is core's and deliberate (an operator's export must beat a file for a
     * container to configure its own agents), so the route reports it rather than overriding it.
     */
    readonly shadowed: readonly string[]
}

/**
 * Write values into the `.env` beside the manifest, at 0600. All or nothing: every name is checked
 * before anything is written, so a request naming one wrong variable changes no file.
 */
export function writeSecrets(
    manifestPath: string,
    values: Readonly<Record<string, string>>,
): SecretsWritten {
    const allowed = secretStatus(manifestPath).map((entry) => entry.name)
    for (const [name, value] of Object.entries(values)) {
        if (!allowed.includes(name)) {
            throw new HarnessError({
                code: "secret_not_referenced",
                message: `"${name}" is not a variable this agent's manifest reads.`,
                hint:
                    allowed.length === 0
                        ? "This agent's manifest reads no variables a caller may set."
                        : `It reads ${allowed.join(", ")}. A variable is settable when the manifest names it, as \${NAME} or through an *Env field; the server's own token never is. GET /v1/agents/:id/secrets lists them.`,
                field: `values.${name}`,
            })
        }
        if (value === "") {
            throw new HarnessError({
                code: "secret_value_empty",
                message: `An empty value for ${name} would not start the agent.`,
                hint: "A variable set to nothing fails the load exactly as a missing one does. Nothing was written.",
                field: `values.${name}`,
            })
        }
    }
    const ambient = ambientEnv([manifestPath])
    const written: string[] = []
    const shadowed: string[] = []
    for (const [name, value] of Object.entries(values)) {
        applySecret(manifestPath, name, value)
        written.push(name)
        if (isSet(ambient, name)) shadowed.push(name)
    }
    return { written, shadowed }
}
