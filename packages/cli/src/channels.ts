/**
 * `channels` — what an agent is reachable on, and the four things a person does to one.
 *
 * ## Why a command rather than more `config`
 *
 * Every one of these was possible already and reachable from nowhere obvious. Disconnecting meant
 * `config set <agent> channels '[{…the whole list again…}]'`; changing a token meant knowing that
 * `tokenEnv` names a variable and that `config env` writes it; relinking WhatsApp meant finding a
 * directory and deleting it. That is the standing rule about `init` — a capability reachable only by
 * somebody who already knows the field names is one the surface is hiding — applied to the thing a
 * person touches most after creating an agent.
 *
 * `lib/channel-actions.ts` holds the implementation, because the browser does the same four things
 * through HTTP and two implementations of "disconnect a channel" is how two surfaces come to
 * disagree about what it means.
 *
 * ## `status` is a different question from `list`
 *
 * This reads the **manifest**: what is configured, and whether its credential is filled in. Whether
 * a channel is *connected right now* is a fact about a running process, which only a host can
 * answer — `GET /v1/agents/:id` carries it and the `serve` banner prints it. Reporting a manifest
 * flag as a connection is decision 5.17's failure, so the output says which it is showing.
 */

import { BRAND, HarnessError } from "@dispach/core"
import {
    channelsOf,
    setChannelCredential,
    setChannelEnabled,
    unpairChannel,
} from "#lib/channel-actions"
import { askSecret } from "#lib/confirm"
import { EXIT_OK } from "#lib/const"
import { keyValue, type Row } from "#lib/render"
import type { ChannelsOptions } from "#lib/schema"

export async function channelsCommand(options: ChannelsOptions): Promise<number> {
    switch (options.action) {
        case "list":
        case undefined:
            return list(options)
        case "connect":
            return await flip(options, true)
        case "disconnect":
            return await flip(options, false)
        case "credential":
            return await credential(options)
        case "unpair":
            return unpair(options)
        default:
            throw new HarnessError({
                code: "cli_channels_action_unknown",
                message: `channels: ${JSON.stringify(options.action)} is not an action`,
                hint: `Actions are list, connect, disconnect, credential and unpair — \`${BRAND.slug} channels list <agent>\`.`,
            })
    }
}

function list(options: ChannelsOptions): number {
    const channels = channelsOf(options.manifestPath)
    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ channels }, null, 2)}\n`)
        return EXIT_OK
    }
    if (channels.length === 0) {
        process.stdout.write(
            `No channels. This agent is reached through the CLI and the HTTP API only.\nAdd one with \`${BRAND.slug} config set <agent> channels\`, or answer the channel questions in \`${BRAND.slug} init\`.\n`,
        )
        return EXIT_OK
    }

    const rows: Row[] = channels.map((channel) => ({
        label: channel.id,
        value: channel.type,
        note: [
            channel.enabled ? "connected" : "disconnected",
            channel.credentialEnv === undefined
                ? // Said rather than omitted: an absent credential row reads as "this one needs no
                  // setting up", which for WhatsApp is the opposite of the truth.
                  channel.type === "whatsapp"
                    ? "paired by QR — `channels unpair` forgets it"
                    : "no credential in the .env"
                : `${channel.credentialEnv} ${channel.credentialSet ? "set" : "NOT SET"}`,
            channel.allowFrom.length === 0
                ? "allowFrom empty — permits nobody"
                : `allows ${channel.allowFrom.join(", ")}`,
        ].join(" · "),
    }))
    process.stdout.write(`${keyValue(rows)}\n`)
    // The distinction 5.17 exists for. This command reads a file; whether anything is listening is
    // a fact about a process, and only a host knows it.
    process.stdout.write(
        `\nThis is what the manifest says. Whether a channel is connected *right now* is\n\`${BRAND.slug} serve\`'s banner or GET /v1/agents/<id> — only a running host knows.\n`,
    )
    return EXIT_OK
}

async function flip(options: ChannelsOptions, enabled: boolean): Promise<number> {
    const result = await setChannelEnabled(options.manifestPath, channelIdOf(options), enabled)
    process.stdout.write(`${result.note}\n`)
    return EXIT_OK
}

async function credential(options: ChannelsOptions): Promise<number> {
    const channelId = channelIdOf(options)
    // **Prompted, never taken from an argument.** An argument lands in shell history *and* in `ps`,
    // readable by every local process for the call's lifetime — the same rule `config env` follows
    // and the reason `renderPlist` throws rather than writing one into a service definition.
    const value = await askSecret(`Credential for channel "${channelId}"`)
    // `undefined` covers both "not a terminal" and "cancelled", and both mean the same thing here:
    // nothing was read, so nothing is written. CI is told rather than having a secret arrive
    // unaudited from a pipe.
    if (value === undefined || value === "") {
        process.stdout.write(
            "Nothing was read, so nothing was written. A secret is never taken from an argument or a pipe —\nrun this at a terminal, or put the variable in the .env beside the manifest yourself.\n",
        )
        return EXIT_OK
    }
    const result = setChannelCredential(options.manifestPath, channelId, value)
    process.stdout.write(`${result.note}\n`)
    return EXIT_OK
}

/**
 * Forget a stored pairing.
 *
 * Done on disk rather than through the transport, because the useful moment is usually with the
 * agent **not** running — `ChannelHub.reset` is the live path and the HTTP route uses it. Both end
 * in the same state, which is the state a first start produces.
 */
function unpair(options: ChannelsOptions): number {
    const result = unpairChannel(options.manifestPath, channelIdOf(options))
    process.stdout.write(`${result.note}\n`)
    return EXIT_OK
}

function channelIdOf(options: ChannelsOptions): string {
    const given = options.channelId
    if (given !== undefined && given !== "") return given
    const declared = channelsOf(options.manifestPath)
    // One channel is unambiguous, and making somebody name it would be ceremony. Two is a choice
    // nothing here can make for them.
    const only = declared[0]
    if (declared.length === 1 && only !== undefined) return only.id
    throw new HarnessError({
        code: "cli_channels_needs_id",
        message: "Which channel?",
        hint:
            declared.length === 0
                ? "This agent declares none. `channels list <agent>` says so too."
                : `Name one: ${declared.map((channel) => channel.id).join(", ")}.`,
        field: "channelId",
    })
}
