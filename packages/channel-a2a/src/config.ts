/**
 * The plugin's config, as a manifest writes it:
 *
 * ```yaml
 * plugins:
 *   - spec: "@dispach/channel-a2a"
 *     config:
 *       card:
 *         name: Crew
 *         description: Triage for the platform team.
 *         skills: [{ id: triage, name: Triage, description: Sorts incoming issues. }]
 *       peers:
 *         acme:                      # inbound: the operator key labelled "a2a-acme" is acme
 *           key: a2a-acme
 *           ratePerMinute: 30
 *         partner:                   # outbound: a2a_send may call it
 *           url: https://partner.example/a2a
 *           tokenEnv: PARTNER_A2A_TOKEN
 * channels:
 *   - { type: a2a, id: a2a }
 * ```
 *
 * A peer is inbound when it names a `key`, outbound when it names a `url`, and may be both. Nothing a
 * model writes ever chooses a URL: `a2a_send`'s `peer` is an enum of the names here.
 */

import { ConfigError } from "@dispach/core"

export interface PeerConfig {
    readonly name: string
    /** The label of the operator key this peer calls with. Minted with `can: ["peer"]`. */
    readonly key?: string
    readonly url?: string
    readonly tokenEnv?: string
    readonly ratePerMinute: number
    /** The longest message this peer may send, in characters. */
    readonly maxChars: number
}

export interface CardConfig {
    readonly name: string
    readonly description: string
    readonly skills: readonly {
        readonly id: string
        readonly name: string
        readonly description: string
        readonly tags: readonly string[]
    }[]
}

export interface A2AConfig {
    readonly card: CardConfig
    readonly peers: readonly PeerConfig[]
    /** Where peers reach this agent, when the request's own origin is not it (a proxy in front). */
    readonly publicUrl?: string
    /** How long a blocking `SendMessage` waits before answering with a working task. */
    readonly waitMs: number
}

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

const count = (value: unknown, fallback: number, field: string): number => {
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
    throw invalid(`${field} must be a positive whole number.`, field)
}

function invalid(message: string, field: string): ConfigError {
    return new ConfigError({
        code: "a2a_config_invalid",
        message,
        hint: "See @dispach/channel-a2a's config: `card` describes this agent, and `peers` maps each name to the key it calls with (`key`), the URL it is called at (`url` and `tokenEnv`), or both.",
        field: `plugins[channel-a2a].${field}`,
    })
}

export function readConfig(raw: unknown): A2AConfig {
    const config = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
    const card = (
        typeof config.card === "object" && config.card !== null ? config.card : {}
    ) as Record<string, unknown>
    const peersRaw = (
        typeof config.peers === "object" && config.peers !== null ? config.peers : {}
    ) as Record<string, unknown>

    const peers = Object.entries(peersRaw).map(([name, value]): PeerConfig => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
            throw invalid(
                `Peer "${name}" needs a lowercase slug name; it becomes part of a session key.`,
                `peers.${name}`,
            )
        }
        const peer = (typeof value === "object" && value !== null ? value : {}) as Record<
            string,
            unknown
        >
        const key = text(peer.key)
        const url = text(peer.url)
        const tokenEnv = text(peer.tokenEnv)
        if (key === undefined && url === undefined) {
            throw invalid(
                `Peer "${name}" names neither a key (inbound) nor a url (outbound).`,
                `peers.${name}`,
            )
        }
        if (url !== undefined && !/^https?:\/\//.test(url)) {
            throw invalid(`Peer "${name}"'s url must be absolute http(s).`, `peers.${name}.url`)
        }
        return {
            name,
            ...(key === undefined ? {} : { key }),
            ...(url === undefined ? {} : { url }),
            ...(tokenEnv === undefined ? {} : { tokenEnv }),
            ratePerMinute: count(peer.ratePerMinute, 30, `peers.${name}.ratePerMinute`),
            maxChars: count(peer.maxChars, 20_000, `peers.${name}.maxChars`),
        }
    })
    const labels = peers.flatMap((peer) => (peer.key === undefined ? [] : [peer.key]))
    if (new Set(labels).size !== labels.length) {
        throw invalid("Two peers name the same key; a key identifies exactly one peer.", "peers")
    }

    const skills = Array.isArray(card.skills) ? card.skills : []
    const publicUrl = text(config.publicUrl)
    return {
        card: {
            name: text(card.name) ?? "Agent",
            description: text(card.description) ?? "",
            skills: skills.map((entry, index) => {
                const skill = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
                    string,
                    unknown
                >
                const id = text(skill.id)
                if (id === undefined)
                    throw invalid("A card skill needs an id.", `card.skills.${index}`)
                return {
                    id,
                    name: text(skill.name) ?? id,
                    description: text(skill.description) ?? "",
                    tags: Array.isArray(skill.tags) ? skill.tags.map(String) : [],
                }
            }),
        },
        peers,
        ...(publicUrl === undefined ? {} : { publicUrl }),
        waitMs: count(config.waitMs, 60_000, "waitMs"),
    }
}
