/**
 * Operator credentials from a terminal: mint one, list them, revoke one.
 *
 * ## Why this is not called `keys`
 *
 * The `keys` command already exists and prints the bytes a terminal sends for a chord — a keyboard
 * diagnostic, nothing to do with credentials. Two unrelated meanings under one verb is the kind of
 * collision that costs somebody a confused minute every time they reach for either, so the new
 * surface takes the word the code and the spec already use for the thing: a **credential**.
 * `token` was the other candidate and loses to `server.tokenEnv`, which is a different credential
 * this command cannot mint or revoke.
 *
 * ## Why it talks to a running server rather than the store
 *
 * A key is a fingerprint in the shared store, so writing one directly would work — and would
 * bypass every check `POST /v1/keys` performs: the label rule, the scope validation, and the
 * refusal of a scope naming an agent that does not exist. That is the *"a check only one surface
 * performs is a check the two disagree about"* shape, on the surface where disagreeing means a
 * credential that the API would never have issued. So this is an HTTP client, and it says so when
 * there is no server to talk to.
 */

import { BRAND, CAPABILITIES, type Capability } from "@dispach/core"
import { UsageError } from "#lib/args"
import { anyLiveHost, callHost, manifestForId, postToHost } from "#lib/lifecycle"

export interface CredentialOptions {
    readonly action: string
    readonly keyId?: string
    readonly label?: string
    readonly agents?: string
    readonly sessions?: string
    readonly can?: string
    readonly expires?: string
    readonly json?: boolean
    readonly store?: string
}

/**
 * `1h`, `30m`, `7d`, `90s`, or plain seconds — into whole seconds.
 *
 * A suffix because "how long should this credential live" is a question people answer in hours and
 * days, and `3600` is a number somebody has to compute and can get wrong by a factor of sixty. Bare
 * digits stay accepted, since that is what the wire takes and a script already has the number.
 */
export function parseDuration(raw: string): number {
    const match = /^(\d+)\s*(s|m|h|d)?$/.exec(raw.trim())
    if (match === null) {
        throw new UsageError({
            code: "credential_usage",
            message: `--expires ${JSON.stringify(raw)} is not a duration.`,
            hint: "Write it as 30s, 15m, 2h or 7d — or as a plain number of seconds.",
        })
    }
    const value = Number(match[1])
    if (value === 0) {
        throw new UsageError({
            code: "credential_usage",
            message: "--expires 0 would mint a credential that has already expired.",
            hint: "Leave the flag off for a key that never expires, or give it a real duration like 1h.",
        })
    }
    const unit = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] ?? "s"] ?? 1
    return value * unit
}

/** `chat,read` → the capabilities, refusing anything that is not one rather than dropping it. */
export function parseCapabilities(raw: string): readonly Capability[] {
    const names = raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== "")
    const unknown = names.filter((name) => !(CAPABILITIES as readonly string[]).includes(name))
    if (unknown.length > 0) {
        throw new UsageError({
            code: "credential_usage",
            message: `--can names ${unknown.map((name) => JSON.stringify(name)).join(", ")}, which is not a capability.`,
            hint: `The four are: ${CAPABILITIES.join(", ")}. read is every GET; chat sends a message, answers an approval and stops a turn; write covers schedules, phase and clearing a session; admin covers credentials, provisioning and start/stop.`,
        })
    }
    // An empty list is *not* silently promoted to "everything": `--can ""` is a key that may do
    // nothing, which is a coherent thing to ask for and a confusing thing to be given instead.
    return names as readonly Capability[]
}

/** A comma list into ids, with the empty entries dropped rather than sent as `""`. */
function parseList(raw: string): readonly string[] {
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
}

interface KeyLike {
    readonly keyId: string
    readonly label: string
    readonly createdAt: string
    readonly lastUsedAt?: string
    readonly revokedAt?: string
    readonly expiresAt?: string
    readonly scope?: {
        readonly agents?: readonly string[]
        readonly sessions?: string
        readonly can?: readonly string[]
    }
}

/**
 * One line describing what a key reaches, for a listing.
 *
 * **Printed back after minting too**, which is the half that matters: a prefix is not a namespace —
 * `team_4` also matches `team_42:x` — so showing what the scope *says* at the moment it is created
 * is the only cheap place to notice that it says something other than what was meant. The same
 * argument `telegramHandle` makes about a username that cannot exist.
 */
export function describeScope(key: KeyLike): string {
    const parts: string[] = []
    parts.push(key.scope?.agents === undefined ? "every agent" : key.scope.agents.join(", "))
    if (key.scope?.sessions !== undefined) parts.push(`sessions ${key.scope.sessions}`)
    parts.push(key.scope?.can === undefined ? "all capabilities" : key.scope.can.join("+"))
    if (key.expiresAt !== undefined) parts.push(`until ${key.expiresAt}`)
    return parts.join(" · ")
}

/** The host to ask, or a refusal naming why there is none. */
async function host(store?: string) {
    const lease = await anyLiveHost(store)
    if (lease === undefined) {
        throw new UsageError({
            code: "credential_usage",
            message: "No server is running, so there is nothing to mint a credential on.",
            hint: `A credential belongs to a server rather than to a file, so this command is an API client. Start one with \`${BRAND.slug} serve\`, or use POST /v1/keys directly against a server you can already reach.`,
        })
    }
    return { lease, manifest: manifestForId(lease.agentId) }
}

export async function credentialCommand(options: CredentialOptions): Promise<number> {
    if (options.action === "create") return await create(options)
    if (options.action === "list") return await list(options)
    if (options.action === "revoke") return await revoke(options)
    throw new UsageError({
        code: "credential_usage",
        message: `Unknown action ${JSON.stringify(options.action)}.`,
        hint: "The actions are create, list and revoke.",
    })
}

async function create(options: CredentialOptions): Promise<number> {
    const label = options.label?.trim()
    if (label === undefined || label === "") {
        throw new UsageError({
            code: "credential_usage",
            message: "--label is required.",
            hint: 'A label is the only thing distinguishing two credentials in a listing, and "key 2" is a name nobody can act on when deciding which to revoke.',
        })
    }
    const scope = {
        ...(options.agents === undefined ? {} : { agents: parseList(options.agents) }),
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
        ...(options.can === undefined ? {} : { can: parseCapabilities(options.can) }),
        ...(options.expires === undefined ? {} : { expiresIn: parseDuration(options.expires) }),
    }

    const { lease, manifest } = await host(options.store)
    const reply = await postToHost(
        lease,
        "/v1/keys",
        { label, ...(Object.keys(scope).length === 0 ? {} : { scope }) },
        manifest,
    )
    if (!reply.ok) return refused(reply, "mint a credential")

    const key = reply.body as KeyLike & { readonly secret: string }
    if (options.json === true) {
        process.stdout.write(`${JSON.stringify(key, null, 2)}\n`)
        return 0
    }
    /**
     * The secret, on its own line, **once**.
     *
     * It is not stored anywhere in a readable form and no route returns it again, so this is the
     * only moment it exists outside the caller's memory. Printed bare rather than inside a sentence
     * so that copying the line copies the credential and nothing else.
     */
    process.stdout.write(`${key.secret}\n`)
    process.stderr.write(`  ${key.label} · ${key.keyId}\n`)
    process.stderr.write(`  reaches ${describeScope(key)}\n`)
    process.stderr.write(
        "  This is the only time the secret is shown. It is stored as a fingerprint and no route returns it.\n",
    )
    return 0
}

async function list(options: CredentialOptions): Promise<number> {
    const { lease, manifest } = await host(options.store)
    const reply = await callHost(lease, "GET", "/v1/keys", manifest)
    if (!reply.ok) return refused(reply, "list credentials")

    const body = reply.body as { readonly keys?: readonly KeyLike[]; readonly scope?: string }
    const keys = body.keys ?? []
    if (options.json === true) {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
        return 0
    }
    if (keys.length === 0) {
        process.stdout.write("No credentials. The server token is the only way in.\n")
        return 0
    }
    for (const key of keys) {
        // Revoked ones are shown rather than hidden, the same as the API's listing: the row is the
        // only record a credential ever existed, and hiding it makes a revocation unverifiable.
        const state = key.revokedAt === undefined ? "live" : "revoked"
        process.stdout.write(`${key.keyId}  ${state.padEnd(7)}  ${key.label}\n`)
        process.stdout.write(`  reaches ${describeScope(key)}\n`)
        process.stdout.write(
            `  created ${key.createdAt}${key.lastUsedAt === undefined ? " · never used" : ` · last used ${key.lastUsedAt}`}\n`,
        )
    }
    return 0
}

async function revoke(options: CredentialOptions): Promise<number> {
    const keyId = options.keyId?.trim()
    if (keyId === undefined || keyId === "") {
        throw new UsageError({
            code: "credential_usage",
            message: "Which credential?",
            hint: `\`${BRAND.slug} credential list\` prints the ids. Revoking is permanent — a revoked secret can never be re-presented.`,
        })
    }
    const { lease, manifest } = await host(options.store)
    const reply = await callHost(lease, "DELETE", `/v1/keys/${encodeURIComponent(keyId)}`, manifest)
    if (!reply.ok) return refused(reply, "revoke that credential")
    const key = reply.body as KeyLike
    if (options.json === true) {
        process.stdout.write(`${JSON.stringify(key, null, 2)}\n`)
        return 0
    }
    process.stdout.write(`revoked ${key.keyId} · ${key.label}\n`)
    return 0
}

/** The server's own words, not a paraphrase — it knows why far better than this command does. */
function refused(reply: { status: number; detail?: string; hint?: string }, what: string): number {
    process.stderr.write(
        `Could not ${what}${reply.status === 0 ? "" : ` (${reply.status})`}: ${reply.detail ?? "the host did not answer"}\n`,
    )
    if (reply.hint !== undefined) process.stderr.write(`  hint: ${reply.hint}\n`)
    return 1
}
