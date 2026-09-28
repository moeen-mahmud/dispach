/**
 * Slack is faked at the wire: a real WebSocket server speaking Socket Mode's envelopes, and a fetch
 * standing in for the Web API. The platform `WebSocket` client is the real one.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChannelHost,
    type ChatChunk,
    type ErrorDetail,
    type ModelTransport,
    type RawInbound,
    Runtime,
} from "@dispach/core"
import type { ServerWebSocket } from "bun"
import {
    type FetchLike,
    type SlackEvent,
    SlackTransport,
    slackChannel,
    toInbound,
} from "../src/index.ts"

const BOT = "UBOT"

interface Sent {
    readonly url: string
    readonly authorization: string
    readonly body: Record<string, unknown>
}

const servers: { stop(force: boolean): void }[] = []
afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true)
})

function slack() {
    const sockets: ServerWebSocket<unknown>[] = []
    const acks: string[] = []
    const sent: Sent[] = []
    let opens = 0
    const server = Bun.serve({
        port: 0,
        fetch(request, srv) {
            return srv.upgrade(request) ? undefined : new Response("upgrade", { status: 400 })
        },
        websocket: {
            open(socket) {
                sockets.push(socket)
                socket.send(JSON.stringify({ type: "hello", num_connections: 1 }))
            },
            message(_socket, data) {
                acks.push((JSON.parse(String(data)) as { envelope_id: string }).envelope_id)
            },
        },
    })
    servers.push(server)
    const state = {
        open: (): Response => Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/` }),
        post: (): Response => Response.json({ ok: true, ts: "1700.0009" }),
    }
    const fetch: FetchLike = async (url, init) => {
        const authorization = new Headers(init.headers).get("authorization") ?? ""
        if (url.endsWith("apps.connections.open")) {
            opens += 1
            expect(authorization).toBe("Bearer xapp-1")
            return state.open()
        }
        sent.push({ url, authorization, body: JSON.parse(String(init.body)) })
        return state.post()
    }
    let envelopes = 0
    const push = (event: SlackEvent) => {
        envelopes += 1
        const id = `env-${envelopes}`
        sockets.at(-1)?.send(
            JSON.stringify({
                type: "events_api",
                envelope_id: id,
                payload: { event, authorizations: [{ user_id: BOT }] },
            }),
        )
        return id
    }
    return { sockets, acks, sent, fetch, push, state, opens: () => opens }
}

function fakeHost() {
    const received: RawInbound[] = []
    const statuses: string[] = []
    const errors: ErrorDetail[] = []
    const host = {
        receive: (message: RawInbound) => received.push(message),
        status: (status: string, detail?: string) =>
            statuses.push(detail === undefined ? status : `${status}: ${detail}`),
        error: (detail: ErrorDetail) => errors.push(detail),
    } as unknown as ChannelHost
    return { host, received, statuses, errors }
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
        if (check()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${what}`)
}

const transportFor = (fake: ReturnType<typeof slack>) =>
    new SlackTransport({
        id: "slack",
        appToken: "xapp-1",
        botToken: "xoxb-1",
        fetch: fake.fetch,
        backoffMs: [5, 5],
    })

describe("which events are answered", () => {
    const dm: SlackEvent = {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "on &amp; when &lt;soon&gt;?",
        ts: "1700000000.000100",
    }
    const mention: SlackEvent = {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: `<@${BOT}> summarise <@U2>'s thread`,
        ts: "1700000000.000200",
    }

    test("a DM always, as the conversation; a mention in a channel, in its thread", () => {
        expect(toInbound(dm, BOT)).toEqual({
            providerMessageId: "D1:1700000000.000100",
            peerId: "D1",
            senderId: "U1",
            senderHandle: "U1",
            text: "on & when <soon>?",
            receivedAt: "2023-11-14T22:13:20.000Z",
        })
        const inbound = toInbound(mention, BOT)
        expect(inbound?.text).toBe("summarise <@U2>'s thread")
        // The mention started the thread, so its own ts is the thread; a reply inside one keeps it.
        expect(inbound?.thread).toBe("1700000000.000200")
        expect(toInbound({ ...mention, thread_ts: "1699.1" }, BOT)?.thread).toBe("1699.1")
    })

    test("not a channel message without a mention, nor a bot, an edit, or the bot itself", () => {
        expect(toInbound({ ...dm, channel_type: "channel" }, BOT)).toBeUndefined()
        expect(toInbound({ ...dm, bot_id: "B1" }, BOT)).toBeUndefined()
        expect(toInbound({ ...dm, subtype: "message_changed" }, BOT)).toBeUndefined()
        expect(toInbound({ ...dm, user: BOT }, BOT)).toBeUndefined()
        expect(toInbound({ ...mention, text: `<@${BOT}>` }, BOT)).toBeUndefined()
    })
})

describe("Socket Mode", () => {
    test("connects, acknowledges every envelope, and hands the agent what it should answer", async () => {
        const fake = slack()
        const { host, received, statuses } = fakeHost()
        const transport = transportFor(fake)
        await transport.start(host)
        await until(() => statuses.includes("connected: Socket Mode"), "hello")

        const answered = fake.push({
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: `<@${BOT}> hi`,
            ts: "1.1",
        })
        const ignored = fake.push({
            type: "message",
            channel_type: "channel",
            channel: "C1",
            user: "U1",
            text: "chatter",
            ts: "1.2",
        })
        await until(() => fake.acks.length === 2, "acks")
        expect(fake.acks).toEqual([answered, ignored])
        expect(received.map((message) => message.text)).toEqual(["hi"])
        await transport.stop()
        expect(statuses.at(-1)).toBe("disconnected")
    })

    test("a disconnect from Slack opens a new socket, and the loop keeps going", async () => {
        const fake = slack()
        const { host, received, statuses } = fakeHost()
        const transport = transportFor(fake)
        await transport.start(host)
        await until(() => fake.sockets.length === 1, "first socket")
        fake.sockets[0]?.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }))
        await until(() => fake.sockets.length === 2, "second socket")
        await until(() => fake.opens() === 2, "second open")
        fake.push({
            type: "message",
            channel_type: "im",
            channel: "D1",
            user: "U1",
            text: "still there?",
            ts: "2.1",
        })
        await until(() => received.length === 1, "delivery on the new socket")
        // The refresh is routine: announced connected once, never an error.
        expect(statuses.filter((status) => status.startsWith("connected"))).toHaveLength(1)
        await transport.stop()
    })

    test("a refused token is reported and retried, not the end of the loop", async () => {
        const fake = slack()
        let refusals = 2
        const open = fake.state.open
        fake.state.open = () =>
            refusals-- > 0 ? Response.json({ ok: false, error: "not_allowed_token_type" }) : open()
        const { host, statuses, errors } = fakeHost()
        const transport = transportFor(fake)
        await transport.start(host)
        await until(() => statuses.includes("connected: Socket Mode"), "recovery")
        expect(fake.opens()).toBe(3)
        // Reported on the first failure, not on every one.
        expect(errors.map((error) => error.code)).toEqual(["slack_app_token_refused"])
        expect(errors[0]?.hint).toContain("xapp-")
        await transport.stop()
    })
})

describe("replies", () => {
    const message = {
        channelId: "slack",
        recipient: "C1",
        text: "**done** — see [the PR](https://x.test/1)",
        thread: "1.1",
        idempotencyKey: "k",
        chunkIndex: 0,
        chunkTotal: 1,
    }

    test("posted into the thread with the bot token, as a markdown block", async () => {
        const fake = slack()
        expect(await transportFor(fake).send(message)).toEqual({
            ok: true,
            providerMessageId: "1700.0009",
        })
        expect(fake.sent[0]).toEqual({
            url: "https://slack.com/api/chat.postMessage",
            authorization: "Bearer xoxb-1",
            body: {
                channel: "C1",
                text: message.text,
                blocks: [{ type: "markdown", text: message.text }],
                thread_ts: "1.1",
            },
        })
    })

    test("rate limits are retried after Slack's delay; a missing membership is not retried, and says why", async () => {
        const fake = slack()
        const transport = transportFor(fake)
        fake.state.post = () =>
            Response.json(
                { ok: false, error: "ratelimited" },
                { status: 429, headers: { "retry-after": "3" } },
            )
        expect(await transport.send(message)).toMatchObject({
            ok: false,
            retryable: true,
            retryAfterMs: 3000,
        })
        fake.state.post = () => Response.json({ ok: false, error: "not_in_channel" })
        const refused = await transport.send(message)
        expect(refused).toMatchObject({ ok: false, retryable: false })
        expect(refused.ok === false && refused.error.hint).toContain("/invite")
    })
})

describe("configuration", () => {
    const factory = (env: Record<string, string>) =>
        slackChannel({ id: "slack", config: {}, env, dir: "/tmp" } as unknown as Parameters<
            typeof slackChannel
        >[0])

    test("both tokens are required, and a swapped pair is refused before any network call", () => {
        expect(() => factory({ SLACK_BOT_TOKEN: "xoxb-1" })).toThrow("SLACK_APP_TOKEN")
        expect(() => factory({ SLACK_APP_TOKEN: "xoxb-1", SLACK_BOT_TOKEN: "xapp-1" })).toThrow(
            "start with xapp-",
        )
        expect(factory({ SLACK_APP_TOKEN: "xapp-1", SLACK_BOT_TOKEN: "xoxb-1" })).toBeInstanceOf(
            SlackTransport,
        )
    })
})

describe("through a real runtime", () => {
    test("a mention runs a turn for the member, and the reply lands in the thread", async () => {
        const fake = slack()
        const dir = mkdtempSync(join(tmpdir(), "slack-runtime-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}\nid: crew\nmodel:\n  main:\n    id: m\n    api: scripted\nchannels:\n  - type: slack\n    id: slack\n    allowFrom: ["U1"]\n`,
        )
        const scripted: ModelTransport = {
            create: (context) => ({
                id: context.id,
                async *chat(): AsyncIterable<ChatChunk> {
                    yield { type: "text", delta: "Here is the summary." }
                    yield { type: "finish", reason: "stop" }
                },
            }),
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: {},
            store: ":memory:",
            startChannels: true,
            modelTransports: { scripted },
            channels: { slack: () => transportFor(fake) },
        })
        await until(() => fake.sockets.length === 1, "socket")
        fake.push({
            type: "app_mention",
            channel: "C1",
            user: "U1",
            text: `<@${BOT}> summarise this thread`,
            ts: "1700.0001",
        })
        await until(() => fake.sent.length === 1, "reply")
        expect(fake.sent[0]?.body).toMatchObject({
            channel: "C1",
            thread_ts: "1700.0001",
            text: "Here is the summary.",
        })
        const [turn] = (await runtime.store.turns.listForAgent("crew", {})).turns
        await runtime.stop()
        expect(turn?.input).toBe("summarise this thread")
        expect(turn?.sessionKey).toBe("slack:C1:1700.0001")
    })
})
