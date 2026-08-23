/**
 * Binding channels to agents: inbound becomes a turn, a turn becomes a delivery.
 *
 * Core owns this rather than each channel package, for the same reason it owns `allowFrom` and
 * chunking: a policy implemented once per transport is a policy two transports can disagree about.
 * A channel package supplies bytes in and bytes out. Everything between is here.
 *
 * **Channels start after `runtime.ready` and never block it.** A bad bot token must not make a
 * runtime unbootable — an orchestrator watching `/v1/ready` would see a Telegram outage as a dead
 * process and restart it into the same outage. So `start()` returns once transports are *running*,
 * not once they are connected, and a connection failure arrives as `agent.channel.error` while the
 * HTTP surface keeps serving.
 *
 * Turns are **serialised per session**. Two messages arriving while a turn is in flight would
 * otherwise run concurrently against one history, and both would read the same prior state and
 * append over each other. The queue is per session key rather than global so one slow conversation
 * cannot stall another.
 */

import type {
    ChannelBinding,
    ChannelHost,
    ChannelStatus,
    ChannelTransport,
    RawInbound,
    WebhookDelivery,
    WebhookOutcome,
} from "../channels/channel.ts"
import { Inbox } from "../channels/inbox.ts"
import { Outbox } from "../channels/outbox.ts"
import type { ErrorDetail } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import { endNote } from "../loop/turn-end.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { OutboxStore } from "../store/store.ts"
import type { Agent } from "./agent.ts"

/**
 * How a channel package is registered, mirroring `ToolProviderFactory`.
 *
 * A factory rather than an instance because `packages/core` may not import a sibling package, and a
 * transport needs the agent's own directory and resolved environment — which exist only once its
 * manifest is loaded.
 */
export type ChannelFactory = (context: ChannelFactoryContext) => ChannelTransport

export interface ChannelFactoryContext {
    readonly agentId: string
    /** The manifest's directory, never `process.cwd()`. Same reasoning as `ToolContext.dir`. */
    readonly dir: string
    readonly env: EnvSource
    /** The channel's manifest entry, minus the fields core validated. */
    readonly config: Readonly<Record<string, unknown>>
    readonly id: string
}

/** Telegram's indicator lapses after ~5 s, so it is refreshed while a turn runs. */
const TYPING_INTERVAL_MS = 4_000

export interface ChannelHubOptions {
    readonly bus: EventBus
    readonly outboxStore: OutboxStore
    /** How long a delivery may sit unsent before the poll loop notices. */
    readonly pollIntervalMs?: number
}

interface Bound {
    readonly agent: Agent
    readonly bindings: readonly ChannelBinding[]
    readonly inboxes: ReadonlyMap<string, Inbox>
    readonly outbox: Outbox
    readonly status: Map<string, ChannelStatus>
}

export class ChannelHub {
    readonly #bus: EventBus
    readonly #outboxStore: OutboxStore
    readonly #pollIntervalMs: number | undefined
    readonly #agents = new Map<string, Bound>()
    /** One promise chain per session key. See the file comment. */
    readonly #queues = new Map<string, Promise<void>>()
    #started = false
    #stopped = false

    constructor(options: ChannelHubOptions) {
        this.#bus = options.bus
        this.#outboxStore = options.outboxStore
        this.#pollIntervalMs = options.pollIntervalMs
    }

    /**
     * Register an agent's channels. Constructs transports; connects nothing.
     *
     * Called during boot, which is why it must stay free of I/O — a factory allocates an object and
     * reads its config, and the first packet leaves in `start()`.
     */
    register(agent: Agent, bindings: readonly ChannelBinding[]): void {
        const enabled = bindings.filter((binding) => binding.enabled)
        if (enabled.length === 0) return

        const inboxes = new Map<string, Inbox>()
        const transports = new Map<string, ChannelTransport>()
        for (const binding of enabled) {
            transports.set(binding.transport.id, binding.transport)
            inboxes.set(
                binding.transport.id,
                new Inbox({
                    channelId: binding.transport.id,
                    channelType: binding.transport.type,
                    ...(binding.allowFrom === undefined ? {} : { allowFrom: binding.allowFrom }),
                }),
            )
        }

        this.#agents.set(agent.id, {
            agent,
            bindings: enabled,
            inboxes,
            outbox: new Outbox({
                store: this.#outboxStore,
                bus: this.#bus,
                channels: transports,
                ...(this.#pollIntervalMs === undefined
                    ? {}
                    : { pollIntervalMs: this.#pollIntervalMs }),
            }),
            status: new Map(),
        })
    }

    get size(): number {
        return this.#agents.size
    }

    /**
     * Whether `start()` has been called — that is, whether anything is actually listening.
     *
     * Not derivable from `statusOf`, and assuming it was is how decision 5.17's bug survived its
     * own fix. `statusOf` reports every *registered* binding, which `run` has just as much as
     * `serve` does, so `statusOf(id).length > 0` answers "is a channel configured" and was being
     * read as "is a channel running". Slot 2 then told an agent under `run` that its Telegram
     * channel was connected in this session, which is the precise sentence 5.17 exists to prevent.
     */
    get started(): boolean {
        return this.#started
    }

    /** Channel ids and their last reported state, for `GET /v1/agents/:id`. */
    statusOf(agentId: string): readonly { id: string; type: string; status: ChannelStatus }[] {
        const bound = this.#agents.get(agentId)
        if (bound === undefined) return []
        return bound.bindings.map((binding) => ({
            id: binding.transport.id,
            type: binding.transport.type,
            status: bound.status.get(binding.transport.id) ?? "starting",
        }))
    }

    /**
     * Recover in-flight deliveries, then start every transport. Call **after** `runtime.ready`.
     *
     * Recovery runs before any transport, so a reply the previous process may not have delivered
     * goes out before new work arrives — a person who asked a question and saw nothing gets the
     * answer, rather than the answer arriving after their follow-up.
     */
    async start(): Promise<void> {
        if (this.#started || this.#stopped) return
        this.#started = true

        for (const [agentId, bound] of this.#agents) {
            // Scoped to this agent, not to every row in the file. Two runtimes can share a store,
            // and recovering the other one's in-flight chunk makes it re-send a message it has
            // already delivered.
            await bound.outbox.recover([agentId])
            bound.outbox.start(agentId)

            for (const binding of bound.bindings) {
                const transport = binding.transport
                const host = this.#hostFor(agentId, transport)
                host.status("starting")
                // Not awaited as a group: one transport failing to start must not prevent the
                // others, and `start` is specified to return once running rather than connected.
                try {
                    await transport.start(host)
                } catch (cause) {
                    host.status("error", cause instanceof Error ? cause.message : String(cause))
                    host.error({
                        code: "channel_start_failed",
                        message: `Channel "${transport.id}" (${transport.type}) failed to start: ${
                            cause instanceof Error ? cause.message : String(cause)
                        }`,
                        hint: "The runtime is still serving — a channel that cannot start never blocks readiness. Check the channel's credentials and network access, then reload the agent.",
                        field: `channels[${transport.id}]`,
                    })
                }
            }
        }
    }

    async stop(): Promise<void> {
        if (this.#stopped) return
        this.#stopped = true
        for (const bound of this.#agents.values()) {
            bound.outbox.stop()
            for (const binding of bound.bindings) {
                try {
                    await binding.transport.stop()
                } catch {
                    // Shutdown is best-effort. A transport that throws on stop has already been
                    // told to stop, and reporting it would be the last event before exit anyway.
                }
            }
        }
    }

    /**
     * Queue a reply for delivery and drain immediately.
     *
     * Public because the API surface needs it: `POST /v1/agents/:id/messages` with a `deliver`
     * target goes out the same queue as a channel reply, and a second path would be a second set
     * of idempotency semantics.
     */
    async deliver(input: {
        readonly agentId: string
        readonly sessionKey: string
        readonly channelId: string
        readonly recipient: string
        readonly text: string
        readonly turnId?: string
        readonly key?: string
        readonly thread?: string
    }): Promise<void> {
        const bound = this.#agents.get(input.agentId)
        if (bound === undefined) {
            throw new Error(
                `Agent "${input.agentId}" has no channels configured, so there is nowhere to deliver to. ` +
                    'hint: add a channels entry to its manifest, or use deliver: "none" and read the reply from the API response.',
            )
        }
        await bound.outbox.enqueue({
            agentId: input.agentId,
            sessionKey: input.sessionKey,
            channelId: input.channelId,
            recipient: input.recipient,
            text: input.text,
            ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
            ...(input.key === undefined ? {} : { key: input.key }),
            ...(input.thread === undefined ? {} : { thread: input.thread }),
        })
        await bound.outbox.drain(input.agentId)
    }

    /**
     * Route a webhook delivery to the transport that owns the channel id.
     *
     * Returns 404 for an unknown agent or channel rather than describing which of the two was
     * wrong: this endpoint is reachable by anyone who can guess a URL, and a probe that
     * distinguishes "no such agent" from "no such channel" enumerates the runtime for free.
     */
    async handleWebhook(
        agentId: string,
        channelId: string,
        delivery: WebhookDelivery,
    ): Promise<WebhookOutcome> {
        const transport = this.#agents
            .get(agentId)
            ?.bindings.find((binding) => binding.transport.id === channelId)?.transport

        if (transport?.webhook === undefined) {
            return { status: 404, detail: "no such webhook" }
        }
        return transport.webhook(delivery)
    }

    #hostFor(agentId: string, transport: ChannelTransport): ChannelHost {
        const bound = this.#agents.get(agentId)
        return {
            receive: (raw) => {
                // Deliberately not awaited. A long-poll's read loop must not stall behind turn
                // execution, or one slow turn stops the runtime from seeing any further updates.
                void this.#onInbound(agentId, transport, raw)
            },
            status: (status, detail) => {
                bound?.status.set(transport.id, status)
                this.#bus.emit(
                    "agent.channel.status",
                    {
                        channelId: transport.id,
                        channelType: transport.type,
                        status,
                        ...(detail === undefined ? {} : { detail }),
                    },
                    { agentId },
                )
            },
            error: (detail: ErrorDetail) => {
                this.#bus.emit(
                    "agent.channel.error",
                    { ...detail, channelId: transport.id },
                    { agentId },
                )
            },
        }
    }

    async #onInbound(agentId: string, transport: ChannelTransport, raw: RawInbound): Promise<void> {
        const bound = this.#agents.get(agentId)
        if (bound === undefined) return

        const inbox = bound.inboxes.get(transport.id)
        if (inbox === undefined) return

        const decision = inbox.accept(raw)
        if (decision.kind !== "accept") {
            this.#bus.emit(
                "agent.channel.rejected",
                {
                    channelId: transport.id,
                    reason: decision.kind === "duplicate" ? "duplicate" : "denied",
                    sender:
                        decision.kind === "duplicate"
                            ? (raw.senderHandle ?? raw.peerId)
                            : decision.sender,
                    detail:
                        decision.kind === "duplicate"
                            ? `Provider message ${decision.providerMessageId} was already handled.`
                            : decision.reason,
                },
                { agentId },
            )
            return
        }

        const message = decision.message
        // One chain per session: a second message waits for the first turn rather than racing it
        // through the same history.
        const key = `${agentId}␟${message.sessionKey}`
        const previous = this.#queues.get(key) ?? Promise.resolve()
        const next = previous.catch(() => {}).then(() => this.#runTurn(bound, transport, message))
        this.#queues.set(key, next)
        // Cleared only if nothing else has queued behind it, so the map does not grow per session.
        void next.finally(() => {
            if (this.#queues.get(key) === next) this.#queues.delete(key)
        })
        await next
    }

    async #runTurn(
        bound: Bound,
        transport: ChannelTransport,
        message: { sessionKey: string; peerId: string; text: string; thread?: string },
    ): Promise<void> {
        const agentId = bound.agent.id
        const stopTyping = this.#startTyping(transport, message.peerId, message.thread)

        try {
            const result = await bound.agent.send(message.text, {
                sessionKey: message.sessionKey,
                source: transport.id,
            })
            stopTyping()

            // An empty reply is still a turn that happened; it is just not something to send. A
            // zero-length message is an error at every provider, and delivering one would turn a
            // quiet turn into a channel error.
            //
            // Unless the turn was cut short, in which case there is something to say and silence is
            // the worst available answer: on a channel nobody can see an exit code, a status line or
            // a log file, so a turn stopped by its step budget with no prose to show delivered
            // *nothing at all* — indistinguishable from a bot that is down.
            const note = endNote(result.reason, {
                steps: result.steps,
                durationMs: result.durationMs,
            })
            const text = result.text.trim() === "" ? (note ?? "") : result.text
            if (text === "") return

            await bound.outbox.enqueue({
                agentId,
                sessionKey: message.sessionKey,
                channelId: transport.id,
                recipient: message.peerId,
                turnId: result.turnId,
                ...(message.thread === undefined ? {} : { thread: message.thread }),
                text,
            })
            await bound.outbox.drain(agentId)
        } catch (cause) {
            stopTyping()
            // The turn failing is already reported by the loop; what is added here is that it
            // failed *on a channel*, where a person is waiting and will otherwise see silence.
            this.#bus.emit(
                "agent.channel.error",
                {
                    channelId: transport.id,
                    code: "channel_turn_failed",
                    message: `A turn from ${transport.id} failed: ${
                        cause instanceof Error ? cause.message : String(cause)
                    }`,
                    hint: "The sender received no reply. The turn's own error event carries the cause; this one records that a waiting person was affected.",
                },
                { agentId, sessionKey: message.sessionKey },
            )
        }
    }

    /** Returns a stop function. Never throws, never awaited by the turn. */
    #startTyping(transport: ChannelTransport, recipient: string, thread?: string): () => void {
        if (transport.typing === undefined) return () => {}

        const tick = () => {
            void transport.typing?.(recipient, thread).catch(() => {
                // Cosmetic. A failed indicator must not surface as a channel error, or a provider
                // that rate-limits the indicator would fill the event stream during normal use.
            })
        }
        tick()
        const timer = setInterval(tick, TYPING_INTERVAL_MS)
        timer.unref?.()
        return () => {
            clearInterval(timer)
        }
    }
}
