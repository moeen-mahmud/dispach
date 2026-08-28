/**
 * What `config` prints, and what a person has to confirm. Pure, so both are asserted as strings.
 *
 * The policy lives here rather than in the command for the same reason `remove-plan.ts` does: this
 * surface can disable the write gate and open a bind address to the network, and "which edits need a
 * confirmation" is exactly the thing that must be checkable without performing one.
 *
 * ## Why the person's policy is not the agent's
 *
 * Decision 11.29: *enabling a capability answers "what may I do"; a write root, an allowlist and a
 * bind address answer "who and where", and those are the person's by definition.* The agent's floor
 * exists because an agent that could widen its own inbound gate could be **talked into** widening it
 * by the very message it is reading — `config_set` sits in `policy.allow` on a real manifest, so the
 * write gate would not stop that. A person typing at a terminal is not that threat, and refusing them
 * is what left the fields reserved for them with the worst ergonomics in the system.
 *
 * So nothing here is floored. Two edits are confirmed, both from decision 4.50, and only those two:
 * a confirmation that fires on `limits.maxSteps` is one nobody reads by the time it fires on the
 * write gate.
 */

import { SETTINGS, type Setting } from "@dispach/core"
import type { EditorRow } from "#lib/config-editor"
import { bullet, indent, keyValue, section } from "#lib/render"

/** A setting with whatever the manifest currently has in it. */
export interface SettingValue {
    readonly setting: Setting
    /** Plain JS, or `undefined` when the field is absent from the file. */
    readonly value: unknown
}

/**
 * How a value appears in a listing.
 *
 * Lists and maps as JSON rather than flattened YAML, which is the lesson from `config_read`: collapsing
 * a block's newlines rendered `[type: telegram id: tg tokenEnv: …]`, one run-on string where the reader
 * needed fields. A sequence of maps went through `String(entry)` and wrote `[object Object]` — the same
 * defect, three times, in three renderers.
 */
export function showValue(value: unknown): string {
    if (value === undefined || value === null) return "(not set)"
    if (typeof value === "string") return value === "" ? '""' : value
    if (typeof value === "boolean" || typeof value === "number") return String(value)
    return JSON.stringify(value)
}

/** The top-level key a path belongs under, for grouping. */
function group(path: string): string {
    return path.split(/[.[]/)[0] ?? path
}

/**
 * The whole catalogue, grouped by the block it lives in, each row carrying who owns it.
 *
 * Grouped by manifest block rather than by owner, because the question a reader arrives with is "what
 * can I change about tools" far more often than "what is mine versus the agent's" — and the ownership
 * still shows on every row that is not the default.
 */
export function renderSettings(rows: readonly SettingValue[], file: string): string {
    const out: string[] = [`${file}`, ""]

    // Collected by block rather than emitted in catalogue order. Printing a heading whenever the block
    // *changes* looks equivalent and is not: the person-only rows sit at the end of the catalogue, so a
    // real listing came out with `server` and `tools` as two sections each, reading as though there
    // were two of them. Grouping here rather than reordering the catalogue keeps the render correct
    // whatever order the rows arrive in, which is the property worth having.
    const blocks = new Map<string, SettingValue[]>()
    for (const row of rows) {
        const block = group(row.setting.path)
        blocks.set(block, [...(blocks.get(block) ?? []), row])
    }

    let first = true
    for (const [block, members] of blocks) {
        out.push(section(block, first))
        first = false
        for (const row of members) {
            const owner = row.setting.agentListed ? "" : "  · yours only"
            const via = row.setting.via === undefined ? "" : `  · set with \`${row.setting.via}\``
            const guard = row.setting.confirm === undefined ? "" : "  · asks first"
            out.push(
                keyValue([{ label: row.setting.path, value: showValue(row.value) }]),
                indent(`${row.setting.means}${owner}${via}${guard}`, 4),
            )
        }
    }
    out.push(
        "",
        "A change takes effect the next time the agent starts. `yours only` marks a field the agent is",
        "refused: what it may do is its to ask for, where it writes and who may reach it are yours.",
    )
    return out.join("\n")
}

/** One field, for `config get`. */
export function renderOne(setting: Setting, value: unknown): string {
    return [
        keyValue([{ label: setting.path, value: showValue(value) }]),
        indent(setting.means, 4),
        ...(setting.toAgent === undefined ? [] : [indent(`to the agent: ${setting.toAgent}`, 4)]),
    ].join("\n")
}

/**
 * What a confirmation says before a guard-weakening edit, or `undefined` when none is needed.
 *
 * The value matters, not only the path: `onMutate: confirm` tightens the gate and `allow` removes it,
 * and asking about both would teach people to agree to the one that matters. Same asymmetry the agent's
 * floor has, where `confirm` is settable and `allow` is refused.
 */
export function confirmationFor(setting: Setting, value: unknown): string | undefined {
    if (setting.confirm === undefined) return undefined
    if (setting.path === "tools.untrusted.onMutate" && String(value).toLowerCase() !== "allow") {
        return undefined
    }
    return setting.confirm
}

/**
 * The report after a successful set.
 *
 * `reflowed` is surfaced rather than swallowed: the file is correct and its comments have moved, which
 * is a surprise better heard from the command than found later in a diff.
 */
export function renderChange(input: {
    readonly path: string
    readonly before: unknown
    readonly after: unknown
    readonly file: string
    readonly reflowed: boolean
    /** A live process holding this agent, if there is one. */
    readonly running?: { readonly pid: number; readonly mode: string }
    /**
     * Env variables this edit has *newly* made load-bearing and that are not set.
     *
     * Newly, not "all of them": a note about tokens printed on every `limits.maxSteps` change is a note
     * nobody reads by the time it matters — the same reasoning that makes `config_set` report a pending
     * secret only for a write that could have introduced one. What is already missing is `config list`'s
     * to report, because that is the command whose job is the overview.
     */
    readonly pending: readonly EnvNeed[]
    readonly restartHint: string
}): string {
    const out: string[] = [
        keyValue([
            { label: "set", value: `${input.path} = ${showValue(input.after)}` },
            {
                label: "was",
                value: input.before === undefined ? "(not set)" : showValue(input.before),
            },
            { label: "file", value: input.file },
        ]),
    ]
    if (input.reflowed) {
        out.push(
            "",
            bullet(
                "the block could not be edited in place, so the file was re-serialised — it is valid, and comments may have moved",
            ),
        )
    }
    if (input.running !== undefined) {
        // Never a refusal. Fixing a misconfiguration while it is running and broken is the main use of
        // this command, so the state it would refuse in is the state somebody is trying to get out of.
        out.push(
            "",
            bullet(
                `this agent is running (pid ${input.running.pid}, ${input.running.mode}) and holds its settings for its lifetime — the change applies after ${input.restartHint}`,
            ),
        )
    }
    for (const need of input.pending) {
        out.push(bullet(`${need.name} is not set — ${need.why}`))
        out.push(bullet(`fill it in with \`config env <agent> ${need.name}\``))
    }
    return out.join("\n")
}

/** Every setting with a real dotted path, in catalogue order. `config set`'s accepted list. */
export function settablePaths(): readonly string[] {
    return SETTINGS.filter((entry) => entry.via === undefined && !/[[<]/.test(entry.path)).map(
        (entry) => entry.path,
    )
}

/** An env variable this manifest depends on, and what actually happens without it. */
export interface EnvNeed {
    readonly name: string
    /** The real consequence, which differs per source and is not interchangeable. */
    readonly why: string
}

/**
 * The env variables a manifest depends on, each with the consequence of it being unset.
 *
 * One message for all of them was wrong, and a live run showed it: the API token variable reported as
 * "read at boot — the agent will refuse to start until it is filled in", printed for an agent with
 * `server.enabled: false` that starts perfectly well. Three sources, three different outcomes:
 *
 * - `model.<role>.apiKeyEnv` — a **load failure**. `validateApiKeyEnv` refuses the manifest outright.
 * - an enabled channel's `tokenEnv` — a **boot failure**, because the factory reads it inside
 *   `Runtime.create`. A channel with `enabled: false` is never constructed, so it needs nothing.
 * - `server.tokenEnv` — **no failure at all**. The API serves unauthenticated and the banner says so,
 *   which is worth telling somebody and is not the same sentence as "will not start".
 * - a provider's `apiKeyEnv` — that provider's tools do not work; the agent runs.
 *
 * A disabled block contributes nothing. Claiming a dependency that does not exist is worse than
 * claiming none, because it is the kind of warning that teaches people to ignore this line.
 */
export function envNeeds(document: unknown): readonly EnvNeed[] {
    if (typeof document !== "object" || document === null) return []
    const doc = document as Record<string, unknown>
    const needs: EnvNeed[] = []
    const add = (name: unknown, why: string) => {
        if (typeof name === "string" && name !== "") needs.push({ name, why })
    }

    const model = asRecord(doc.model)
    for (const role of ["main", "selector", "compactor"]) {
        const config = asRecord(model?.[role])
        add(config?.apiKeyEnv, "the manifest will not load until it is set")
    }

    if (Array.isArray(doc.channels)) {
        for (const entry of doc.channels) {
            const channel = asRecord(entry)
            if (channel === undefined || channel.enabled === false) continue
            add(
                channel.tokenEnv,
                `the ${String(channel.id ?? channel.type ?? "channel")} channel is read at boot, so the agent will not start until it is set`,
            )
        }
    }

    const server = asRecord(doc.server)
    if (server?.enabled === true) {
        add(
            server.tokenEnv,
            "the HTTP API would accept unauthenticated requests. This does not stop the agent starting",
        )
    }

    const providers = asRecord(asRecord(doc.tools)?.providers)
    for (const [id, config] of Object.entries(providers ?? {})) {
        add(asRecord(config)?.apiKeyEnv, `the ${id} provider's tools will not work until it is set`)
    }

    return needs
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
}

/** Those of `needs` the environment does not supply. */
export function unmet(
    needs: readonly EnvNeed[],
    env: Readonly<Record<string, string | undefined>>,
): readonly EnvNeed[] {
    return needs.filter((need) => env[need.name] === undefined || env[need.name] === "")
}

/**
 * The editor's rows for a manifest: every setting, one `allowFrom` per channel, and every secret.
 *
 * Here rather than in the component because it is the whole shape of the surface and it is pure — what
 * appears, in what order, under which heading — and because both hosts build it the same way.
 *
 * The two catalogue rows that are not dotted paths are *replaced* by their expansions rather than shown
 * beside them: `channels[].allowFrom` becomes one row per declared channel, and
 * `tools.providers.<id>.writeRoots` is left as a listing-only row, because writing it means naming a
 * provider and the editor has no way to ask which. A row nobody can act on would be the dead end this
 * surface exists to remove, so it is not offered at all — `config list` still shows it.
 */
export function editorRows(
    settings: readonly SettingValue[],
    input: {
        readonly channels: readonly {
            readonly id: string
            readonly type: string
            readonly allowFrom: readonly string[]
        }[]
        readonly secrets: readonly EnvNeed[]
        readonly present: (name: string) => boolean
    },
): readonly EditorRow[] {
    const out: EditorRow[] = []

    // Collected by block, not emitted when the block *changes* — the same distinction `renderSettings`
    // records above, which this renderer had never been given. The two are not equivalent: the
    // person-only rows sit at the end of the catalogue, so `server.host` and `server.tokenEnv` were
    // already a second `server` section here, and inserting any row between `server.port` and them
    // made it visible. `schedules` was that row. Grouping keeps the render correct whatever order the
    // catalogue arrives in, which is the property worth having and the reason not to fix it by
    // reordering the table.
    const blocks = new Map<string, SettingValue[]>()
    for (const row of settings) {
        if (row.setting.via !== undefined || /[[<]/.test(row.setting.path)) continue
        const key = row.setting.path.split(".")[0] ?? row.setting.path
        blocks.set(key, [...(blocks.get(key) ?? []), row])
    }
    for (const [label, members] of blocks) {
        out.push({ kind: "heading", label })
        for (const row of members) {
            out.push({ kind: "setting", setting: row.setting, value: row.value })
        }
    }

    if (input.channels.length > 0) {
        out.push({ kind: "heading", label: "who may reach it" })
        for (const channel of input.channels) {
            out.push({
                kind: "allow",
                channelId: channel.id,
                channelType: channel.type,
                handles: channel.allowFrom,
            })
        }
    }

    if (input.secrets.length > 0) {
        out.push({ kind: "heading", label: "secrets — written to the .env, never shown" })
        for (const need of input.secrets) {
            out.push({
                kind: "secret",
                name: need.name,
                why: need.why,
                present: input.present(need.name),
            })
        }
    }

    return out
}
