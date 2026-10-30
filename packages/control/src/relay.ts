/**
 * The peer-ask relay (decision 15.10, `docs/24-SPEC-PEER-ASK.md`): one person's agent in one silo
 * asks one of their agents in another.
 *
 * Who is the same person is the embedder's record (`person_links`), never the caller's claim. The
 * calling silo is identified by its relay token. And the target silo still decides everything: the
 * question is sent with a 60-second key **minted in the target**, bound to the person there, so its
 * own scope rules — not this process — say what the turn may reach (rule 2, decision 14.6). The
 * silo token lists the target's agents, mints that key and revokes it; it never sends a message.
 */

import { BRAND } from "./brand.ts"
import { type ControlPlane, relayDigest } from "./control.ts"
import { ControlError } from "./placer.ts"
import type { Silo } from "./store.ts"

/** Asks per minute per person until an operator sets a default (`PUT /v1/relay/config`). */
export const DEFAULT_ASK_RATE = 30

/** How long the key minted for one ask lives. The turn is authenticated once, at its start. */
const ASK_KEY_SECONDS = 60

export interface RemotePeer {
    readonly silo: string
    readonly agent: string
    readonly name?: string
    readonly description?: string
    readonly shared: boolean
}

export interface AskReply {
    readonly text: string
    readonly reason: string
    readonly steps: number
    readonly tokens: { readonly prompt: number; readonly output: number }
    readonly sessionKey: string
    readonly error?: { readonly code: string; readonly message: string; readonly hint: string }
}

/** One answer for "not linked" and "no such silo", so a silo cannot probe who is linked where. */
const unknownPeer = () =>
    new ControlError({
        code: "relay_peer_unknown",
        message: "No such peer for this person.",
        hint: "The person has to be linked in both silos (PUT /v1/people/<principal>/silos/<subject>), and the agent has to exist there. GET /v1/relay/peers lists what this person can ask.",
        status: 404,
    })

export class Relay {
    readonly #control: ControlPlane
    readonly #now: () => number

    constructor(control: ControlPlane, now: () => number = Date.now) {
        this.#control = control
        this.#now = now
    }

    /** The silo presenting this relay token. Every relay route starts here, never from the body. */
    caller(authorization: string | undefined): Silo {
        const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
        const silo =
            presented === ""
                ? undefined
                : this.#control.store.siloByRelayHash(relayDigest(presented))
        if (silo === undefined) {
            throw new ControlError({
                code: "relay_token_invalid",
                message: "Relay routes need the silo's relay token.",
                hint: `A silo reads it from ${BRAND.runtime.relayTokenEnv}, set when the control plane created or last recreated it. A silo created before the relay existed gets one from POST /v1/silos/<subject>/recreate.`,
                status: 401,
            })
        }
        return silo
    }

    /** The asks-per-minute limit for one person, and whether it is their own. */
    rate(principal: string): { readonly askRatePerMinute: number; readonly override: boolean } {
        const own = this.#control.store.personRate(principal)
        return own === undefined
            ? {
                  askRatePerMinute: this.#control.store.defaultRate() ?? DEFAULT_ASK_RATE,
                  override: false,
              }
            : { askRatePerMinute: own, override: true }
    }

    /**
     * The agents a person can ask from `caller`: in each of their other linked silos, those that
     * declare `delegation.ask` and are assigned to them there or to nobody. An unlinked participant
     * gets an empty list, never an error.
     */
    async peers(caller: Silo, participantId: string): Promise<readonly RemotePeer[]> {
        const principal = this.#control.store.principalOf(caller.subject, participantId)
        if (principal === undefined) return []
        const found: RemotePeer[] = []
        for (const link of this.#control.store.links(principal)) {
            if (link.subject === caller.subject) continue
            const silo = this.#control.store.get(link.subject)
            if (silo === undefined) continue
            const release = this.#control.hold(silo.subject)
            try {
                const awake = await this.#control.ensureAwake(silo)
                const response = await this.#control.siloFetch(awake, "/v1/agents")
                if (!response.ok) continue
                const agents = (await response.json()) as readonly {
                    id: string
                    name?: string
                    description?: string
                    ask?: boolean
                    assignee?: string | null
                    status?: string
                }[]
                for (const agent of Array.isArray(agents) ? agents : []) {
                    if (agent.status === "disabled") continue
                    if (agent.ask !== true) continue
                    const shared = agent.assignee === null || agent.assignee === undefined
                    if (!shared && agent.assignee !== link.participantId) continue
                    found.push({
                        silo: silo.subject,
                        agent: agent.id,
                        ...(agent.name === undefined || agent.name === agent.id
                            ? {}
                            : { name: agent.name }),
                        ...(agent.description === undefined
                            ? {}
                            : { description: agent.description }),
                        shared,
                    })
                }
            } finally {
                release()
            }
        }
        return found
    }

    async ask(
        caller: Silo,
        request: {
            readonly participantId: string
            readonly toSilo: string
            readonly toAgent: string
            readonly question: string
            readonly askedBy: string
            readonly sessionKey: string
        },
    ): Promise<AskReply> {
        const store = this.#control.store
        const principal = store.principalOf(caller.subject, request.participantId)
        const target =
            principal === undefined
                ? undefined
                : store.links(principal).find((link) => link.subject === request.toSilo)
        const silo = target === undefined ? undefined : store.get(request.toSilo)
        if (principal === undefined || target === undefined || silo === undefined) {
            throw unknownPeer()
        }

        const { askRatePerMinute } = this.rate(principal)
        const windowStart = this.#now() - 60_000
        const recent = store.asksSince(principal, new Date(windowStart).toISOString())
        if (recent.length >= askRatePerMinute) {
            const oldest = Date.parse(recent[0] ?? new Date(this.#now()).toISOString())
            const retryAfter = Math.max(1, Math.ceil((oldest + 60_000 - this.#now()) / 1000))
            throw new ControlError({
                code: "relay_rate_limited",
                message: `This person has made ${recent.length} asks in the last minute; the limit is ${askRatePerMinute}.`,
                hint: `Try again in ${retryAfter} s. An operator changes the limit with PUT /v1/relay/config, or for one person with PUT /v1/people/<principal>.`,
                status: 429,
                retryAfter,
            })
        }

        const started = this.#now()
        const auditId = store.recordAsk({
            at: new Date(started).toISOString(),
            principal,
            fromSubject: caller.subject,
            fromAgent: request.askedBy,
            toSubject: silo.subject,
            toAgent: request.toAgent,
            outcome: "running",
            durationMs: 0,
        })
        let outcome = "error"
        const release = this.#control.hold(silo.subject)
        try {
            const awake = await this.#control.ensureAwake(silo)
            const reply = await this.#run(awake, target.participantId, caller, request)
            outcome = reply.error === undefined ? reply.reason : "error"
            return reply
        } finally {
            release()
            store.finishAsk(auditId, outcome, this.#now() - started)
        }
    }

    async #run(
        silo: Silo,
        participantId: string,
        caller: Silo,
        request: Parameters<Relay["ask"]>[1],
    ): Promise<AskReply> {
        const minted = await this.#control.siloFetch(silo, "/v1/keys", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                label: `relay ask from ${caller.subject}/${request.askedBy}`,
                scope: {
                    participant: participantId,
                    agents: [request.toAgent],
                    can: ["chat"],
                    sessions: "ask:",
                    expiresIn: ASK_KEY_SECONDS,
                },
            }),
        })
        if (!minted.ok) {
            // The agent named does not exist there, most often: the silo refuses the scope.
            if (minted.status === 400 || minted.status === 404) throw unknownPeer()
            throw new ControlError({
                code: "relay_unavailable",
                message: `Silo "${silo.subject}" answered ${minted.status} when asked for a key.`,
                hint: "The silo is up but refused the control plane's own token; check it was not changed by hand.",
                status: 502,
            })
        }
        const key = (await minted.json()) as { keyId: string; secret: string }
        try {
            const response = await this.#control.fetchAs(
                silo,
                `/v1/agents/${encodeURIComponent(request.toAgent)}/messages`,
                key.secret,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        text: request.question,
                        sessionKey: request.sessionKey,
                        from: { id: participantId, kind: "user" },
                        peerAsk: { askedBy: `${caller.subject}/${request.askedBy}` },
                        stream: true,
                    }),
                },
            )
            if (response.status === 404) throw unknownPeer()
            if (!response.ok || response.body === null) {
                const body = (await response.json().catch(() => ({}))) as {
                    error?: { code: string; message: string; hint: string }
                }
                throw new ControlError({
                    code: body.error?.code ?? "relay_unavailable",
                    message: body.error?.message ?? `The target silo answered ${response.status}.`,
                    hint: body.error?.hint ?? "See the target silo's log.",
                    status: response.status >= 500 ? 502 : response.status,
                })
            }
            return await readTurn(response.body, request.sessionKey)
        } finally {
            // The key would expire in a minute anyway; revoked now, so it does not outlive the ask.
            await this.#control
                .siloFetch(silo, `/v1/keys/${encodeURIComponent(key.keyId)}`, { method: "DELETE" })
                .catch(() => {})
        }
    }
}

/** Read a turn's SSE stream to its end: the final prose, the counts, or the turn's own error. */
async function readTurn(body: ReadableStream<Uint8Array>, sessionKey: string): Promise<AskReply> {
    const decoder = new TextDecoder()
    let buffer = ""
    let error: AskReply["error"]
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true })
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
            const type = /^event: (.*)$/m.exec(block)?.[1]
            const data = block
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n")
            if (data === "") continue
            const frame = JSON.parse(data) as {
                type?: string
                data?: Record<string, unknown>
            } & Record<string, unknown>
            const kind = type ?? frame.type
            const payload = (frame.data ?? frame) as Record<string, unknown>
            if (kind === "error") {
                error = {
                    code: String(payload.code ?? "turn_failed"),
                    message: String(payload.message ?? "The asked turn failed."),
                    hint: String(payload.hint ?? "See the target silo's log."),
                }
            }
            if (kind === "turn.end") {
                const tokens = (payload.tokens ?? {}) as { prompt?: number; output?: number }
                return {
                    text: typeof payload.finalText === "string" ? payload.finalText : "",
                    reason: String(payload.reason ?? "final"),
                    steps: Number(payload.steps ?? 0),
                    tokens: { prompt: tokens.prompt ?? 0, output: tokens.output ?? 0 },
                    sessionKey,
                    ...(error === undefined ? {} : { error }),
                }
            }
        }
    }
    return {
        text: "",
        reason: "error",
        steps: 0,
        tokens: { prompt: 0, output: 0 },
        sessionKey,
        error: error ?? {
            code: "relay_stream_ended",
            message: "The asked turn's stream ended before the turn did.",
            hint: "The target silo may have restarted mid-turn; its transcript is in the session named here.",
        },
    }
}
