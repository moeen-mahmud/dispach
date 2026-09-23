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

import { dirname } from "node:path"
import { BRAND, HarnessError } from "@dispach/core"
import {
    type ChannelEntry,
    channelsOf,
    setChannelCredential,
    setChannelEnabled,
    unpairChannel,
} from "#lib/channel-actions"
import { askSecret } from "#lib/confirm"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { pairWhatsApp } from "#lib/init-whatsapp"
import { agentIdFor, callHost, liveHosts } from "#lib/lifecycle"
import { keyValue, type Row } from "#lib/render"
import type { ChannelsOptions } from "#lib/schema"

export async function channelsCommand(options: ChannelsOptions): Promise<number> {
    switch (options.action) {
        case "list":
        case undefined:
            return await list(options)
        case "connect":
            return await flip(options, true)
        case "disconnect":
            return await flip(options, false)
        case "credential":
            return await credential(options)
        case "pair":
            return await pair(options)
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

async function list(options: ChannelsOptions): Promise<number> {
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

    /**
     * **This column never says "connected", and that is a correction rather than a wording tweak.**
     *
     * It used to read `channel.enabled ? "connected" : "disconnected"` — so a WhatsApp channel that
     * had never been paired in its life printed `wa whatsapp connected`, and the footer explaining
     * that this is only the manifest did not undo the word in the table. Reported exactly that way:
     * a number was added, the listing said connected, and nothing anywhere offered a code. A
     * disclaimer under a claim does not cancel the claim.
     *
     * `enabled` and `disabled` are what the file actually says, and the live half now comes from
     * the host below instead of being disclaimed away.
     */
    const live = await liveStatus(options)
    const rows: Row[] = channels.map((channel) => {
        const now = live?.get(channel.id)
        return {
            label: channel.id,
            value: channel.type,
            note: [
                channel.enabled ? "enabled" : "disabled",
                ...(now === undefined ? [] : [`now ${now.status}`]),
                channel.credentialEnv === undefined
                    ? // Said rather than omitted: an absent credential row reads as "this one needs
                      // no setting up", which for WhatsApp is the opposite of the truth.
                      channel.type === "whatsapp"
                        ? pairingNote(channel)
                        : "no credential in the .env"
                    : `${channel.credentialEnv} ${channel.credentialSet ? "set" : "NOT SET"}`,
                // The paired account is always admitted, so an empty list no longer means nobody
                // for a channel with a `pairWith` — saying so is what stops the owner editing a
                // field they do not need to.
                channel.allowFrom.length === 0
                    ? channel.pairWith === undefined
                        ? "allowFrom empty — permits nobody"
                        : `allows you (${channel.pairWith}) — allowFrom names anyone else`
                    : `allows ${channel.allowFrom.join(", ")}${channel.pairWith === undefined ? "" : " and you"}`,
            ].join(" · "),
        }
    })
    process.stdout.write(`${keyValue(rows)}\n`)

    /**
     * The pending code or QR, from the host that is holding it.
     *
     * This is the half that was missing entirely: `needs_input` reached the `serve` banner and the
     * agent resource and **no command**, so the only way to pair was to watch a log at the moment
     * it scrolled past. A person who ran `channels list` — the command named after the question
     * they had — was told the channel was connected and given nothing to act on.
     */
    for (const [id, state] of live ?? []) {
        if (state.input === undefined) continue
        process.stdout.write(
            `\n${id} is waiting to be paired — ${state.detail ?? "enter this"}:\n\n    ${state.input.payload}\n`,
        )
        if (state.input.expiresAt !== undefined)
            process.stdout.write(`\n  expires ${state.input.expiresAt}\n`)
    }

    if (live === undefined)
        // The distinction 5.17 exists for. With no host there is genuinely nothing live to report,
        // and saying so beats printing a status column that is really a config flag.
        process.stdout.write(
            `\nNothing is hosting this agent, so nothing above is a live status — it is what the\nmanifest says. Start it with \`${BRAND.slug} serve\` to see what each channel is doing.\n`,
        )
    return EXIT_OK
}

/** How this WhatsApp entry pairs, and whether it already has. */
function pairingNote(channel: ChannelEntry): string {
    // `pairWith` turns pairing into a code typed into the phone; without it, a QR. The old string
    // said "paired by QR" unconditionally — wrong about the method once `pairWith` existed, and
    // wrong about the tense always, since it printed for a channel that had never been paired.
    const how =
        channel.pairWith === undefined ? "pairs by QR" : `pairs by code to ${channel.pairWith}`
    return channel.paired === true
        ? `${how}; linked — \`channels unpair\` forgets it`
        : `${how}; not linked yet`
}

/**
 * What the running host says about this agent's channels, or `undefined` when nothing holds it.
 *
 * Best effort throughout: a host that refuses, has no HTTP, or answers something unexpected leaves
 * the manifest view intact rather than failing the command. Reading a file must not start depending
 * on a socket.
 */
async function liveStatus(options: ChannelsOptions): Promise<Map<string, LiveChannel> | undefined> {
    const agentId = agentIdFor(options.manifestPath)
    if (agentId === "") return undefined
    const hosts = await liveHosts()
    const holder = hosts.find((lease) => lease.agentId === agentId && lease.baseUrl !== undefined)
    if (holder === undefined) return undefined
    const reply = await callHost(
        holder,
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}`,
        options.manifestPath,
    )
    if (!reply.ok) return undefined
    const body = reply.body as { channels?: readonly LiveChannel[] } | undefined
    if (body?.channels === undefined) return undefined
    return new Map(body.channels.map((channel) => [channel.id, channel]))
}

interface LiveChannel {
    readonly id: string
    readonly status: string
    readonly detail?: string
    readonly input?: {
        readonly kind: string
        readonly payload: string
        readonly expiresAt?: string
    }
}

/**
 * Connect a channel the way that channel needs.
 *
 * One verb for two mechanisms, because from the person's seat it is one action: "make this
 * channel work". WhatsApp pairs by a code typed into the phone; Telegram wants a bot token in the
 * `.env`. Making somebody know which of `credential` and `unpair`-then-`serve` applies is
 * remembering the implementation, and `channels pair <agent> wa` was the first thing typed when
 * the code did not appear — it answered *"No agent named \"pair\""*, because `pair` was not an
 * action and so was read as the agent.
 *
 * WhatsApp has two cases. If a host is already serving this agent, the code it is offering is
 * shown and the command waits for the phone. If nothing is running, this pairs on its own — the
 * same interlude `init` uses — and the result is on disk for the next `serve`.
 */
async function pair(options: ChannelsOptions): Promise<number> {
    const channelId = channelIdOf(options)
    const channel = channelsOf(options.manifestPath).find((entry) => entry.id === channelId)
    if (channel === undefined)
        throw new HarnessError({
            code: "cli_channel_unknown",
            message: `No channel "${channelId}" in ${options.manifestPath}.`,
            hint: `\`${BRAND.slug} channels list <agent>\` names them.`,
        })

    if (channel.type === "telegram") {
        // A token is the pairing. Prompted and not echoed, then switched on.
        const code = await credential(options)
        if (code !== EXIT_OK) return code
        return await flip(options, true)
    }

    if (channel.type !== "whatsapp")
        throw new HarnessError({
            code: "cli_channel_no_pairing",
            message: `Channel "${channelId}" is a ${channel.type}, which has no pairing step.`,
            hint: `Use \`${BRAND.slug} channels connect\` to switch it on, or \`credential\` if it takes a token.`,
        })

    if (channel.pairWith === undefined)
        throw new HarnessError({
            code: "cli_channel_no_number",
            message: `Channel "${channelId}" has no pairWith, so there is no number to pair to.`,
            hint: "Set pairWith on the channel to the account's own number, digits with the country code. Without it pairing is a QR, which `serve` offers.",
        })

    if (channel.paired === true) {
        process.stdout.write(
            `${channelId} is already paired to ${channel.pairWith}. \`${BRAND.slug} channels unpair\` forgets it first.\n`,
        )
        return EXIT_OK
    }

    // A running host is already offering a code — show that one and wait, rather than opening a
    // second socket to WhatsApp beside it.
    const live = await liveStatus(options)
    const now = live?.get(channelId)
    if (now?.input !== undefined) {
        process.stdout.write(
            `${now.detail ?? "enter this code"}:\n\n    ${now.input.payload}\n\nWaiting for the phone…\n`,
        )
        const end = Date.now() + 120_000
        while (Date.now() < end) {
            await new Promise((resolve) => setTimeout(resolve, 2_000))
            const again = (await liveStatus(options))?.get(channelId)
            if (again?.status === "connected") {
                process.stdout.write(`Paired. ${channelId} is linked to ${channel.pairWith}.\n`)
                return EXIT_OK
            }
        }
        process.stdout.write(`Not paired yet — the host keeps offering codes; run this again.\n`)
        return EXIT_FAILURE
    }

    const outcome = await pairWhatsApp({
        manifestPath: options.manifestPath,
        dir: dirname(options.manifestPath),
        number: channel.pairWith,
        channelId,
        ...(channel.authDir === undefined ? {} : { authDir: channel.authDir }),
    })
    return outcome === "paired" ? EXIT_OK : EXIT_FAILURE
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
