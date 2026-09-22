/**
 * Connect, disconnect, re-credential and unpair a channel — the four things a person does to one.
 *
 * ## Why this is a module rather than four call sites
 *
 * Every one of these was *possible* already and reachable from nowhere obvious. Disabling a channel
 * meant `config set <agent> channels '[{...the whole list again...}]'`; changing a token meant
 * knowing that `tokenEnv` names a variable and that `config env` writes it; relinking WhatsApp meant
 * finding a directory and deleting it. A capability reachable only by somebody who already knows the
 * field names is a capability the surface is hiding — the standing rule that put every provider in
 * `init`, and the same one applies to the thing a person touches most after creating an agent.
 *
 * So: one module, read by the `channels` command and by the HTTP routes the browser calls. Two
 * surfaces over one implementation, which is the only way they cannot disagree — and the lesson this
 * project has paid for repeatedly, most recently where `validate` and `run` disagreed about a cold
 * Composio cache.
 *
 * ## What "connect" means, and what it cannot mean
 *
 * `enabled: true` in the manifest, and nothing more. A channel is constructed at boot and
 * `Runtime.create` is what starts it, so flipping the flag on a running agent takes effect at its
 * next start — `manifest_changed` already says so for every other setting and this is no different.
 * Pretending otherwise by hot-starting a transport here would make "connected" mean two different
 * things depending on which surface you asked.
 */

import { existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import {
    type AgentManifest,
    editManifest,
    HarnessError,
    parseDotEnv,
    readManifestHeader,
} from "@dispach/core"
import { applySecret, envPathOf } from "#lib/config-apply"

/** One channel as every surface reports it, before any runtime state is layered on. */
export interface ChannelEntry {
    readonly id: string
    readonly type: string
    readonly enabled: boolean
    /** The env var this channel's credential lives in, when it has one. */
    readonly credentialEnv?: string
    /**
     * Whether that variable currently has a value.
     *
     * The **name and whether it is set**, never the value. A surface that could read a credential
     * back is one a leaked operator key turns into a credential dump, and nothing needs it: the only
     * question anybody asks is "is this filled in".
     */
    readonly credentialSet?: boolean
    /** Senders this channel accepts. Inbound only. */
    readonly allowFrom: readonly string[]
}

/**
 * Which manifest field holds a channel's credential variable, by channel type.
 *
 * A small table rather than a convention, because it *is* small and a convention would be a guess:
 * `tokenEnv` is Telegram's word and a plugin picks its own. A type that is not here has no
 * credential in the `.env` — WhatsApp is the case, and its pairing is `reset` rather than a value.
 */
const CREDENTIAL_FIELD: ReadonlyMap<string, string> = new Map([["telegram", "tokenEnv"]])

export function channelsOf(manifestPath: string): readonly ChannelEntry[] {
    const header = readManifestHeader(manifestPath)
    const declared = header.channels ?? []
    const envPath = envPathOf(manifestPath)
    const env = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {}

    return declared.map((channel) => {
        const field = CREDENTIAL_FIELD.get(channel.type)
        const variable =
            field === undefined
                ? undefined
                : typeof (channel as Record<string, unknown>)[field] === "string"
                  ? ((channel as Record<string, unknown>)[field] as string)
                  : undefined
        return {
            id: channel.id,
            type: channel.type,
            // Absent means enabled, which is the schema's default and what a reader expects.
            enabled: channel.enabled !== false,
            ...(variable === undefined ? {} : { credentialEnv: variable }),
            ...(variable === undefined ? {} : { credentialSet: (env[variable] ?? "") !== "" }),
            allowFrom: channel.allowFrom ?? [],
        }
    })
}

/**
 * Flip one channel's `enabled`, leaving every other entry byte-identical.
 *
 * Read-modify-write through `editManifest`, the one manifest writer, rather than asking a caller to
 * send the whole `channels` list back. Sending the list is what `config set` does and it is right
 * for a person editing YAML; for a button it would mean the browser reconstructing an array it did
 * not author, and two clients racing on that lose an entry rather than a flag.
 */
export async function setChannelEnabled(
    manifestPath: string,
    channelId: string,
    enabled: boolean,
): Promise<{ readonly note: string; readonly changed: boolean }> {
    const entries = readManifestHeader(manifestPath).channels ?? []
    const existing = entries.find((entry) => entry.id === channelId)
    if (existing === undefined)
        throw unknownChannel(
            channelId,
            entries.map((e) => e.id),
        )
    if ((existing.enabled !== false) === enabled) {
        return {
            note: `Channel "${channelId}" is already ${enabled ? "connected" : "disconnected"}.`,
            changed: false,
        }
    }

    await editManifest({
        file: manifestPath,
        path: ["channels"],
        value: entries.map((entry) =>
            entry.id === channelId ? { ...entry, enabled } : { ...entry },
        ),
    })
    return {
        note: enabled
            ? `Channel "${channelId}" is connected — it starts at the agent's next start.`
            : `Channel "${channelId}" is disconnected. A disabled channel is never constructed, so it reads no credential and opens no socket.`,
        changed: true,
    }
}

/**
 * Write a channel's credential into the `.env` beside the manifest.
 *
 * The variable is the one the *manifest* names, resolved here rather than taken from the caller: a
 * surface that let a client name the variable would let it write any variable at all, including the
 * API token this server authenticates with.
 */
export function setChannelCredential(
    manifestPath: string,
    channelId: string,
    value: string,
): { readonly note: string; readonly variable: string } {
    const entries = readManifestHeader(manifestPath).channels ?? []
    const existing = entries.find((entry) => entry.id === channelId)
    if (existing === undefined)
        throw unknownChannel(
            channelId,
            entries.map((e) => e.id),
        )

    const field = CREDENTIAL_FIELD.get(existing.type)
    const variable =
        field === undefined
            ? undefined
            : typeof (existing as Record<string, unknown>)[field] === "string"
              ? ((existing as Record<string, unknown>)[field] as string)
              : undefined
    if (variable === undefined) {
        throw new HarnessError({
            code: "channel_has_no_credential",
            message: `Channel "${channelId}" (type ${existing.type}) keeps no credential in the .env.`,
            hint:
                existing.type === "whatsapp"
                    ? "WhatsApp is paired by scanning a QR, not by a value anybody types. Use `channels unpair` to forget the current pairing and scan a new code."
                    : "Only a channel whose manifest entry names an environment variable has one to set. Check the entry's own fields.",
            field: `channels[${channelId}]`,
        })
    }

    const applied = applySecret(manifestPath, variable, value)
    return {
        note: `${applied.note}. It is read at the agent's next start.`,
        variable,
    }
}

function unknownChannel(channelId: string, known: readonly string[]): HarnessError {
    return new HarnessError({
        code: "channel_unknown",
        message: `This agent declares no channel with id "${channelId}".`,
        hint:
            known.length === 0
                ? "It declares no channels at all. Add one with `config set <agent> channels`, or answer the channel questions in `init`."
                : `Declared: ${known.join(", ")}. The id is the channel's own, not its type.`,
        field: "channelId",
    })
}

/**
 * Delete a stored pairing on disk.
 *
 * The on-disk path, used when no live transport can be asked — a stopped agent, or one whose
 * channels a `run`-mode host never started. Both routes end in the same state, which is the state a
 * first start produces.
 */
export function unpairChannel(manifestPath: string, channelId: string): { readonly note: string } {
    const entries = readManifestHeader(manifestPath).channels ?? []
    const existing = entries.find((entry) => entry.id === channelId)
    if (existing === undefined)
        throw unknownChannel(
            channelId,
            entries.map((e) => e.id),
        )
    const dir = pairingDirOf(manifestPath, existing)
    if (dir === undefined) {
        throw new HarnessError({
            code: "channel_has_no_pairing",
            message: `Channel "${channelId}" (type ${existing.type}) stores no pairing.`,
            hint: "Only a channel linked by scanning a code has one to forget. A credential somebody typed is changed with `channels credential`, and a channel is switched off with `channels disconnect`.",
            field: `channels[${channelId}]`,
        })
    }
    rmSync(dir, { recursive: true, force: true })
    return {
        note: `Forgot the pairing — deleted ${dir}. The next start offers a new code to scan; the old device may still be listed on the phone, which is the only place it can be removed.`,
    }
}

/** Where a channel that stores a pairing keeps it, so a stopped agent can be unpaired too. */
export function pairingDirOf(
    manifestPath: string,
    channel: { readonly type: string; readonly authDir?: unknown },
): string | undefined {
    if (channel.type !== "whatsapp") return undefined
    const configured = typeof channel.authDir === "string" ? channel.authDir : "./.whatsapp"
    return join(dirname(manifestPath), configured)
}

export type { AgentManifest }
