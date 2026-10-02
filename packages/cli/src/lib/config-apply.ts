/**
 * The three writes `config` performs, separated from how any surface prints them.
 *
 * The plain actions and the editor both go through here, which is the same argument the phase made one
 * level down: `editManifest` is the only thing that writes `agent.yaml` because three writers meant the
 * guarantee depended on which caller you were. Two *callers* of that writer would have the same problem
 * one step up — the editor validating a handle differently from `config allow`, or writing a secret
 * without tightening the file's mode.
 *
 * Each function does the effect and returns a sentence. Refusals throw `HarnessError`, so a caller that
 * prints to a terminal and a caller that shows a line in a frame both get the same words.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { editManifest, HarnessError, manifestValueAt, parseSettingValue } from "@dispach/core"
import { upsertEnv } from "#lib/dotenv-edit"
import { telegramHandle } from "#lib/init-flow"
import { MEDIA_PROVIDERS, TOOL_PROVIDERS } from "#lib/providers"

export interface Applied {
    /** One line saying what happened, for whichever surface asked. */
    readonly note: string
    /** The source editor could not place the path, so the document was re-serialised. */
    readonly reflowed: boolean
    /** What was there before, so a caller can offer the undo. */
    readonly before: unknown
}

/** The `.env` beside a manifest. */
export function envPathOf(manifestPath: string): string {
    return join(dirname(manifestPath), ".env")
}

export async function applySet(manifestPath: string, path: string, raw: string): Promise<Applied> {
    const value = parseSettingValue(raw)
    // The binary's providers, so a `tools.providers` edit the provider itself would refuse is refused
    // here — the TUI editor and `config set` both land on this line.
    const result = await editManifest({
        file: manifestPath,
        path: path.split("."),
        value,
        providers: TOOL_PROVIDERS,
        mediaProviders: MEDIA_PROVIDERS,
    })
    return {
        note: `${path} is now ${describe(value)}`,
        reflowed: result.reflowed,
        before: result.before,
    }
}

/**
 * Add, remove or replace a channel's inbound allowlist.
 *
 * `handles` is the whole list, because the whole list is what gets written: the field lives inside a
 * sequence entry and the source editor matches `key:` at an indent, so one entry's key is not
 * addressable. Every handle is checked against the service that issues it first — an impossible one
 * matches nobody, and the only symptom is a bot that is connected, healthy and silently refusing the
 * person it was set up for.
 */
export async function applyAllow(
    manifestPath: string,
    channelId: string,
    handles: readonly string[],
): Promise<Applied> {
    const source = readFileSync(manifestPath, "utf8")
    const channels = manifestValueAt(source, ["channels"])
    if (!Array.isArray(channels)) {
        throw new HarnessError({
            code: "cli_config_no_channels",
            message: "This agent has no channels, so there is nobody to allow.",
            hint: "`config set <agent> channels '[{type: telegram, id: tg, tokenEnv: TELEGRAM_BOT_TOKEN, mode: longpoll}]'` declares one first.",
        })
    }

    const entries = channels.filter(
        (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    const at = entries.findIndex((entry) => String(entry.id ?? "") === channelId)
    if (at === -1) {
        throw new HarnessError({
            code: "cli_config_channel_unknown",
            message: `No channel with id "${channelId}".`,
            hint: `Declared: ${entries.map((entry) => String(entry.id ?? "")).join(", ")}.`,
            field: "channel",
        })
    }

    const target = entries[at] as Record<string, unknown>
    const checked = handles.map((handle) => checkedHandle(handle, String(target.type ?? "")))
    const unique = [...new Set(checked)]
    const before = Array.isArray(target.allowFrom) ? target.allowFrom.map(String) : []

    const result = await editManifest({
        file: manifestPath,
        path: ["channels"],
        value: entries.map((entry, index) =>
            index === at ? { ...entry, allowFrom: unique } : entry,
        ),
    })
    return {
        note:
            unique.length === 0
                ? `${channelId} now allows nobody, which refuses every message`
                : `${channelId} now allows ${unique.join(", ")}`,
        reflowed: result.reflowed,
        before,
    }
}

/**
 * Put a value in the `.env` beside the manifest, at 0600.
 *
 * Written 0600 whichever way the file arrived: under a service manager this is the *only* path
 * credentials take — launchd hands a job almost no environment and a plist carries none on purpose — so
 * tightening it is right even when this command did not create it. `writeFileSync`'s mode applies only
 * when it creates the file, which is why the check afterwards is not redundant.
 */
export function applySecret(manifestPath: string, name: string, value: string): Applied {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new HarnessError({
            code: "cli_config_env_name_invalid",
            message: `"${name}" is not an environment variable name.`,
            hint: "Letters, digits and underscores, not starting with a digit — MODEL_API_KEY, TELEGRAM_BOT_TOKEN.",
            field: "name",
        })
    }
    if (value === "") {
        throw new HarnessError({
            code: "cli_config_env_empty",
            message: `An empty value for ${name} would not start the agent.`,
            hint: "A variable set to nothing fails the load exactly as a missing one does. Nothing was written.",
        })
    }

    const path = envPathOf(manifestPath)
    const before = existsSync(path) ? readFileSync(path, "utf8") : ""
    const upsert = upsertEnv(before, name, value)
    writeFileSync(path, upsert.text, { encoding: "utf8", mode: 0o600 })
    const loose = (statSync(path).mode & 0o077) !== 0
    if (loose) chmodSync(path, 0o600)

    return {
        note: `${name} ${upsert.replaced ? "replaced" : "written"} in ${path}${loose ? " (tightened to 0600)" : ""}`,
        reflowed: false,
        before: undefined,
    }
}

/**
 * A handle, validated against the service that issues it.
 *
 * Telegram's rule is shared with `init` rather than restated, because a check only one surface performs
 * is a check the two disagree about. An unknown channel type passes through: guessing at another
 * service's identifier format would refuse handles that are perfectly valid.
 */
export function checkedHandle(raw: string, type: string): string {
    const given = raw.trim()
    if (given === "") {
        throw new HarnessError({
            code: "cli_config_handle_missing",
            message: "No handle given.",
            hint: "On Telegram that is the username, not the display name.",
            field: "handle",
        })
    }
    if (type !== "telegram") return given
    const checked = telegramHandle(given)
    if (!checked.ok) {
        throw new HarnessError({
            code: "cli_config_handle_invalid",
            message: `"${given}" ${checked.reason}`,
            hint: "A handle that cannot exist matches nobody, and the only symptom is the bot silently refusing every message from the person it was set up for.",
            field: "handle",
        })
    }
    return checked.value
}

/** A value as a short phrase, for a one-line note. */
function describe(value: unknown): string {
    if (value === "") return "empty"
    if (typeof value === "string") return value
    return JSON.stringify(value)
}
