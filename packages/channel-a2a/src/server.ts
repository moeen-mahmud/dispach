/**
 * The inbound half: an agent answering A2A peers, as a channel.
 *
 * A peer's `SendMessage` becomes an ordinary channel message — `ChannelHost.receive`, peer id
 * `<peer>:<contextId>` and so the session `a2a:<peer>:<contextId>` — marked `senderKind: "agent"`, which
 * is what makes its text untrusted and its turn act for nobody. The reply comes back the way every
 * channel's does, through the outbox into `send()`, and that call is what completes the task. So
 * `allowFrom`, the outbox and per-conversation sessions are the ones every channel has; the only thing
 * this module owns is the task table a peer polls.
 *
 * **An approval keeps the task `working`, never `input-required`.** `input-required` hands the turn
 * back to the peer, and an owner's approval is not the peer's to answer.
 *
 * Tasks live in memory for an hour after they end (decision 14.47): after a restart `GetTask` answers
 * `TaskNotFound`, which the protocol allows, while the conversation itself is in the session as usual.
 */

import { randomUUID } from "node:crypto"
import type {
    AnyEvent,
    ChannelHost,
    ChannelLimits,
    ChannelTransport,
    OutboundMessage,
    PluginCaller,
    PluginRouteRequest,
    SendResult,
} from "@dispach/core"
import type { A2AConfig, PeerConfig } from "./config.ts"

export const PROTOCOL_VERSION = "1.0"

/**
 * JSON-RPC error codes. A2A's own: the numbering the protocol has used since 0.3 (-32001 onward) — the
 * v1.0 text names the errors without restating the numbers, so these are the established ones.
 */
export const RPC = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    unsupportedOperation: -32004,
    contentTypeNotSupported: -32005,
    versionNotSupported: -32009,
} as const

export type TaskState =
    | "TASK_STATE_SUBMITTED"
    | "TASK_STATE_WORKING"
    | "TASK_STATE_COMPLETED"
    | "TASK_STATE_FAILED"
    | "TASK_STATE_CANCELED"

export interface A2AMessage {
    readonly messageId: string
    readonly role: "ROLE_USER" | "ROLE_AGENT"
    readonly parts: readonly { readonly text: string }[]
    readonly contextId?: string
    readonly taskId?: string
}

export interface A2ATask {
    readonly id: string
    readonly contextId: string
    readonly status: {
        readonly state: TaskState
        readonly message?: A2AMessage
        readonly timestamp: string
    }
    readonly artifacts: readonly {
        readonly artifactId: string
        readonly parts: readonly { readonly text: string }[]
    }[]
}

interface TaskRecord {
    task: A2ATask
    readonly peer: string
    readonly recipient: string
    readonly messageId: string
    text: string
    endedAt?: number
    readonly waiters: ((task: A2ATask) => void)[]
}

const TERMINAL: readonly TaskState[] = [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
]
const RETAIN_MS = 60 * 60 * 1000
/** A turn that ended without a reply: how long to wait for an outbox delivery that is not coming. */
const QUIET_MS = 3_000

class RpcError extends Error {
    readonly code: number
    readonly status: number

    constructor(code: number, message: string, status = 200) {
        super(message)
        this.code = code
        this.status = status
    }
}

export class A2AServer {
    readonly #config: A2AConfig
    readonly #agentId: string
    readonly #tasks = new Map<string, TaskRecord>()
    /** Per recipient, the tasks waiting for a reply in order: a session's turns run one at a time. */
    readonly #queues = new Map<string, string[]>()
    readonly #bySource = new Map<string, string>()
    readonly #calls = new Map<string, number[]>()
    #host: ChannelHost | undefined

    constructor(config: A2AConfig, agentId: string) {
        this.#config = config
        this.#agentId = agentId
    }

    /** The channel a manifest's `channels: [{type: a2a}]` builds. One per agent is enough. */
    transport(id: string): ChannelTransport {
        const limits: ChannelLimits = { maxMessageChars: 1_000_000, idempotentSend: true }
        return {
            id,
            type: "a2a",
            limits,
            // The peer is authenticated by its key before any message exists, so `allowFrom` keeps
            // meaning "who else" — and there is nobody else.
            alwaysAllow: this.#config.peers.flatMap((peer) =>
                peer.key === undefined ? [] : [peer.name],
            ),
            start: async (host) => {
                this.#host = host
                host.status("connected")
            },
            stop: async () => {
                this.#host = undefined
            },
            send: async (message) => this.#delivered(message),
        }
    }

    /** `turn.end` for an a2a session: a turn that failed, or ended with nothing to say, ends its task. */
    observe(event: AnyEvent): void {
        if (event.type !== "turn.end" || event.agentId !== this.#agentId) return
        const recipient =
            event.sessionKey?.startsWith("a2a:") === true ? event.sessionKey.slice(4) : undefined
        if (recipient === undefined) return
        const reason = (event.data as { reason?: string }).reason
        if (reason !== "final" && reason !== "stopped") {
            const record = this.#head(recipient)
            if (record !== undefined)
                this.#finish(record, "TASK_STATE_FAILED", `The turn ended: ${reason ?? "unknown"}.`)
            return
        }
        // A delivery is enqueued after the turn and sent on a later outbox tick, so a reply may still
        // be on its way. Only if none arrives is the task a quiet completion.
        const pending = this.#head(recipient)
        if (pending === undefined) return
        const timer = setTimeout(() => {
            if (pending.endedAt === undefined && this.#head(recipient) === pending) {
                this.#finish(pending, "TASK_STATE_COMPLETED", undefined)
            }
        }, QUIET_MS)
        timer.unref?.()
    }

    card(request: PluginRouteRequest): Response {
        const url =
            this.#config.publicUrl ??
            `${request.url.origin}/v1/agents/${encodeURIComponent(this.#agentId)}/plugins/a2a/`
        return Response.json({
            name: this.#config.card.name,
            description: this.#config.card.description,
            version: PROTOCOL_VERSION,
            supportedInterfaces: [
                { url, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION },
            ],
            capabilities: { streaming: true, pushNotifications: false },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: this.#config.card.skills,
            securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
            securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        })
    }

    async rpc(request: PluginRouteRequest): Promise<Response> {
        let id: unknown = null
        try {
            const version = request.request.headers.get("a2a-version")
            // Absent is accepted: a client that omits the header is most likely a v1 client that
            // forgot it, and refusing it would be a stricter reading than the peer can act on.
            if (version !== null && version !== "" && !version.startsWith("1.")) {
                throw new RpcError(
                    RPC.versionNotSupported,
                    `A2A-Version ${version} is not supported; this agent speaks ${PROTOCOL_VERSION}.`,
                )
            }
            const peer = this.#peerOf(request.caller)
            let body: unknown
            try {
                body = await request.request.json()
            } catch {
                throw new RpcError(RPC.parse, "The body is not JSON.")
            }
            const call = (typeof body === "object" && body !== null ? body : {}) as Record<
                string,
                unknown
            >
            id = call.id ?? null
            if (call.jsonrpc !== "2.0" || typeof call.method !== "string") {
                throw new RpcError(RPC.invalidRequest, "Not a JSON-RPC 2.0 request.")
            }
            this.#limit(peer)
            const params = (
                typeof call.params === "object" && call.params !== null ? call.params : {}
            ) as Record<string, unknown>
            switch (call.method) {
                case "SendMessage":
                    return reply(id, await this.#send(peer, params))
                case "SendStreamingMessage":
                    return this.#stream(id, await this.#start(peer, params))
                // A Task itself, unlike SendMessage's `{task}` union — the official SDK client reads it so.
                case "GetTask":
                    return reply(id, this.#owned(peer, params.id).task)
                case "CancelTask": {
                    const record = this.#owned(peer, params.id)
                    throw new RpcError(
                        RPC.taskNotCancelable,
                        record.endedAt === undefined
                            ? "A running turn is finished, not cancelled: this agent's turns do not stop when a caller leaves."
                            : "The task has already ended.",
                    )
                }
                default:
                    throw new RpcError(
                        call.method.startsWith("SendMessage") ||
                            call.method.includes("PushNotification")
                            ? RPC.unsupportedOperation
                            : RPC.methodNotFound,
                        `${call.method} is not supported here.`,
                    )
            }
        } catch (error) {
            if (error instanceof RpcError)
                return rpcError(id, error.code, error.message, error.status)
            throw error
        }
    }

    #peerOf(caller: PluginCaller): PeerConfig {
        const peer =
            caller.kind === "key"
                ? this.#config.peers.find((candidate) => candidate.key === caller.label)
                : undefined
        if (peer === undefined) {
            throw new RpcError(
                RPC.invalidRequest,
                "This credential is not a peer of this agent. Each peer calls with the operator key its `key` names.",
                403,
            )
        }
        return peer
    }

    #limit(peer: PeerConfig): void {
        const now = Date.now()
        const recent = (this.#calls.get(peer.name) ?? []).filter((at) => now - at < 60_000)
        if (recent.length >= peer.ratePerMinute) {
            this.#calls.set(peer.name, recent)
            throw new RpcError(
                RPC.invalidRequest,
                `Peer ${peer.name} is over ${peer.ratePerMinute} requests a minute.`,
                429,
            )
        }
        this.#calls.set(peer.name, [...recent, now])
    }

    async #send(peer: PeerConfig, params: Record<string, unknown>): Promise<{ task: A2ATask }> {
        const record = await this.#start(peer, params)
        const returnImmediately =
            (params.configuration as { returnImmediately?: unknown } | undefined)
                ?.returnImmediately === true
        if (returnImmediately || record.endedAt !== undefined) return this.#view(record)
        return { task: await this.#settled(record, this.#config.waitMs) }
    }

    async #start(peer: PeerConfig, params: Record<string, unknown>): Promise<TaskRecord> {
        this.#evict()
        const message = (
            typeof params.message === "object" && params.message !== null ? params.message : {}
        ) as Record<string, unknown>
        const parts = Array.isArray(message.parts)
            ? (message.parts as Record<string, unknown>[])
            : []
        if (parts.length === 0) throw new RpcError(RPC.invalidParams, "The message has no parts.")
        if (parts.some((part) => typeof part.text !== "string")) {
            throw new RpcError(RPC.contentTypeNotSupported, "Only text parts are accepted.")
        }
        const text = parts.map((part) => String(part.text)).join("\n")
        if (text.length > peer.maxChars) {
            throw new RpcError(
                RPC.invalidParams,
                `The message is ${text.length} characters; ${peer.name} may send ${peer.maxChars}.`,
            )
        }
        const messageId =
            typeof message.messageId === "string" && message.messageId !== ""
                ? message.messageId
                : randomUUID()
        // A resend of one message is the same task, not a second turn.
        const known = this.#bySource.get(`${peer.name}\u001f${messageId}`)
        const existing = known === undefined ? undefined : this.#tasks.get(known)
        if (existing !== undefined) return existing

        const host = this.#host
        if (host === undefined) {
            throw new RpcError(
                RPC.unsupportedOperation,
                "This agent has no running a2a channel. Add `channels: [{type: a2a, id: a2a}]`.",
                503,
            )
        }
        const contextId =
            typeof message.contextId === "string" &&
            /^[A-Za-z0-9._-]{1,128}$/.test(message.contextId)
                ? message.contextId
                : randomUUID()
        const recipient = `${peer.name}:${contextId}`
        const record: TaskRecord = {
            task: {
                id: randomUUID(),
                contextId,
                status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
                artifacts: [],
            },
            peer: peer.name,
            recipient,
            messageId,
            text: "",
            waiters: [],
        }
        this.#tasks.set(record.task.id, record)
        this.#bySource.set(`${peer.name}\u001f${messageId}`, record.task.id)
        this.#queues.set(recipient, [...(this.#queues.get(recipient) ?? []), record.task.id])
        host.receive({
            peerId: recipient,
            senderHandle: peer.name,
            senderName: peer.name,
            senderKind: "agent",
            providerMessageId: messageId,
            receivedAt: new Date().toISOString(),
            text,
        })
        return record
    }

    #stream(id: unknown, record: TaskRecord): Response {
        const encoder = new TextEncoder()
        const frame = (result: unknown) =>
            encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`)
        const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                controller.enqueue(frame(this.#view(record)))
                const task = await this.#settled(record, this.#config.waitMs)
                controller.enqueue(
                    frame({
                        statusUpdate: {
                            taskId: task.id,
                            contextId: task.contextId,
                            status: task.status,
                        },
                    }),
                )
                controller.close()
            },
        })
        return new Response(body, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
    }

    #settled(record: TaskRecord, waitMs: number): Promise<A2ATask> {
        if (record.endedAt !== undefined) return Promise.resolve(record.task)
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(record.task), waitMs)
            timer.unref?.()
            record.waiters.push((task) => {
                clearTimeout(timer)
                resolve(task)
            })
        })
    }

    #owned(peer: PeerConfig, id: unknown): TaskRecord {
        this.#evict()
        const record = typeof id === "string" ? this.#tasks.get(id) : undefined
        // Another peer's task answers exactly like a missing one.
        if (record === undefined || record.peer !== peer.name)
            throw new RpcError(RPC.taskNotFound, "No such task.")
        return record
    }

    #view(record: TaskRecord): { task: A2ATask } {
        return { task: record.task }
    }

    #head(recipient: string): TaskRecord | undefined {
        const id = this.#queues.get(recipient)?.[0]
        return id === undefined ? undefined : this.#tasks.get(id)
    }

    /** The outbox delivering a reply: the chunks of one message complete the task at the front. */
    #delivered(message: OutboundMessage): SendResult {
        const record = this.#head(message.recipient)
        if (record === undefined) {
            // Nothing waiting: a schedule or a reply to a task that already timed out of memory. The
            // peer cannot be reached from here — A2A has no push without push notifications.
            return { ok: true }
        }
        record.text += message.text
        if (message.chunkIndex + 1 >= message.chunkTotal)
            this.#finish(record, "TASK_STATE_COMPLETED", record.text)
        return { ok: true, providerMessageId: record.task.id }
    }

    #finish(record: TaskRecord, state: TaskState, text: string | undefined): void {
        if (record.endedAt !== undefined) return
        const reply: A2AMessage | undefined =
            text === undefined || text === ""
                ? undefined
                : {
                      messageId: randomUUID(),
                      role: "ROLE_AGENT",
                      parts: [{ text }],
                      contextId: record.task.contextId,
                      taskId: record.task.id,
                  }
        record.task = {
            ...record.task,
            status: {
                state,
                ...(reply === undefined ? {} : { message: reply }),
                timestamp: new Date().toISOString(),
            },
            artifacts:
                reply === undefined || state !== "TASK_STATE_COMPLETED"
                    ? []
                    : [{ artifactId: randomUUID(), parts: reply.parts }],
        }
        record.endedAt = Date.now()
        this.#queues.set(
            record.recipient,
            (this.#queues.get(record.recipient) ?? []).filter((id) => id !== record.task.id),
        )
        for (const wake of record.waiters.splice(0)) wake(record.task)
    }

    #evict(): void {
        const cutoff = Date.now() - RETAIN_MS
        for (const [id, record] of this.#tasks) {
            if (record.endedAt !== undefined && record.endedAt < cutoff) {
                this.#tasks.delete(id)
                this.#bySource.delete(`${record.peer}\u001f${record.messageId}`)
            }
        }
    }
}

export function isTerminal(state: TaskState): boolean {
    return TERMINAL.includes(state)
}

function reply(id: unknown, result: unknown): Response {
    return Response.json({ jsonrpc: "2.0", id, result })
}

function rpcError(id: unknown, code: number, message: string, status: number): Response {
    return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status })
}
