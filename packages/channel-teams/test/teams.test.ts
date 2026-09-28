/**
 * The Teams channel against a fake Microsoft: a real RSA key signing real JWTs, the connector's
 * OpenID metadata and JWKS, Entra's token endpoint, and a Bot Connector that records replies.
 * Activity shapes follow the Bot Framework reference (personal chat, channel post with a mention).
 */

import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChannelHost,
    type ChatChunk,
    type ModelTransport,
    type RawInbound,
    Runtime,
} from "@dispach/core"
import {
    BotFrameworkAuth,
    type FetchLike,
    ISSUER,
    OPENID_METADATA,
    type TeamsActivity,
    TeamsTransport,
    toInbound,
} from "../src/index.ts"

const APP = "00000000-0000-0000-0000-00000000a99a"
const TENANT = "11111111-1111-1111-1111-111111111111"
const SERVICE = "https://smba.trafficmanager.net/emea/"
const BOT = "28:bot"

function keyPair(kid: string) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string }
    return { privateKey, jwk: { ...jwk, kid, endorsements: ["msteams"] } }
}

function jwt(
    privateKey: ReturnType<typeof keyPair>["privateKey"],
    kid: string,
    claims: Record<string, unknown>,
): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const head = part({ alg: "RS256", typ: "JWT", kid })
    const body = part(claims)
    const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString(
        "base64url",
    )
    return `${head}.${body}.${signature}`
}

/** A fake Microsoft. `keys` is mutable so a test can rotate them. */
function microsoft(keys: object[]) {
    const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    let tokenCalls = 0
    let jwksCalls = 0
    let reply: () => Response = () => Response.json({ id: "sent-1" })
    const fetch: FetchLike = async (url, init) => {
        if (url === OPENID_METADATA) return Response.json({ jwks_uri: "https://keys.example/jwks" })
        if (url === "https://keys.example/jwks") {
            jwksCalls += 1
            return Response.json({ keys })
        }
        if (url.startsWith("https://login.microsoftonline.com/")) {
            tokenCalls += 1
            return Response.json({ access_token: "bot-token", expires_in: 3600 })
        }
        sent.push({
            url,
            auth: new Headers(init?.headers).get("authorization"),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return reply()
    }
    return {
        fetch,
        sent,
        calls: () => ({ tokenCalls, jwksCalls }),
        replyWith: (make: () => Response) => {
            reply = make
        },
    }
}

const PERSONAL: TeamsActivity = {
    type: "message",
    id: "a1",
    timestamp: "2026-09-29T10:00:00.000Z",
    serviceUrl: SERVICE,
    channelId: "msteams",
    from: { id: "29:ada", name: "Ada", aadObjectId: "aad-ada" },
    recipient: { id: BOT, name: "Crew" },
    conversation: { id: "a:personal-1", conversationType: "personal", tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: "what is on my plate?",
}

const CHANNEL_POST: TeamsActivity = {
    ...PERSONAL,
    id: "c1",
    conversation: {
        id: "19:abc@thread.tacv2;messageid=1700",
        conversationType: "channel",
        tenantId: TENANT,
    },
    text: "<at>Crew</at> summarise this thread for <at>Bob</at>",
    entities: [
        { type: "mention", mentioned: { id: BOT, name: "Crew" }, text: "<at>Crew</at>" },
        { type: "mention", mentioned: { id: "29:bob", name: "Bob" }, text: "<at>Bob</at>" },
    ],
}

function setup(options: { tenantId?: string } = {}) {
    const key = keyPair("k1")
    const keys: object[] = [key.jwk]
    const ms = microsoft(keys)
    const dir = mkdtempSync(join(tmpdir(), "teams-"))
    const auth = new BotFrameworkAuth({
        appId: APP,
        password: "pw",
        tenantId: TENANT,
        fetch: ms.fetch,
    })
    const transport = new TeamsTransport({
        id: "teams",
        dir,
        auth,
        fetch: ms.fetch,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    })
    const received: RawInbound[] = []
    const host = {
        receive: (message: RawInbound) => received.push(message),
        status: () => {},
    } as unknown as ChannelHost
    const bearer = (claims: Record<string, unknown> = {}, signer = key) =>
        `Bearer ${jwt(signer.privateKey, signer.jwk.kid, {
            iss: ISSUER,
            aud: APP,
            exp: Math.floor(Date.now() / 1000) + 600,
            nbf: Math.floor(Date.now() / 1000) - 10,
            serviceUrl: SERVICE,
            ...claims,
        })}`
    const deliver = (activity: TeamsActivity, authorization: string) =>
        transport.webhook({ body: activity, headers: { authorization } })
    return { transport, host, received, bearer, deliver, ms, keys, dir, key }
}

describe("verifying the connector", () => {
    test("a genuine activity is read; every forgery is refused and nothing in it reaches the agent", async () => {
        const { transport, host, received, bearer, deliver } = setup()
        await transport.start(host)
        expect((await deliver(PERSONAL, bearer())).status).toBe(200)
        expect(received).toHaveLength(1)

        const stranger = keyPair("k1")
        for (const forged of [
            bearer({ aud: "some-other-bot" }),
            bearer({ iss: "https://evil.example" }),
            bearer({ exp: Math.floor(Date.now() / 1000) - 3600 }),
            bearer({ serviceUrl: "https://evil.example/" }),
            bearer({ serviceUrl: undefined }),
            bearer({}, stranger),
            "Bearer not.a.jwt",
            "",
        ]) {
            expect((await deliver(PERSONAL, forged)).status).toBe(401)
        }
        expect(received).toHaveLength(1)
    })

    test("a rotated key is fetched once, instead of refusing every message until a restart", async () => {
        const { transport, host, received, deliver, ms, keys, bearer } = setup()
        await transport.start(host)
        await deliver(PERSONAL, bearer())
        const rotated = keyPair("k2")
        keys.push(rotated.jwk)
        expect((await deliver({ ...PERSONAL, id: "a2" }, bearer({}, rotated))).status).toBe(200)
        expect(received).toHaveLength(2)
        expect(ms.calls().jwksCalls).toBe(2)
    })

    test("another organisation's activity is accepted and not read", async () => {
        const { transport, host, received, deliver, bearer } = setup({ tenantId: TENANT })
        await transport.start(host)
        const elsewhere = {
            ...PERSONAL,
            channelData: { tenant: { id: "22222222-2222-2222-2222-222222222222" } },
        }
        expect((await deliver(elsewhere, bearer())).status).toBe(200)
        expect(received).toHaveLength(0)
    })
})

describe("when the agent answers", () => {
    test("always in a personal chat; in a channel only when mentioned, with the mention removed", () => {
        expect(toInbound(PERSONAL)?.text).toBe("what is on my plate?")
        const post = toInbound(CHANNEL_POST)
        expect(post?.text).toBe("summarise this thread for Bob")
        // The thread is the session: the conversation id carries its root message.
        expect(post?.peerId).toBe("19:abc@thread.tacv2;messageid=1700")
        // The person, by the Entra id an embedder knows them by, never the channel.
        expect(post?.senderId).toBe("aad-ada")
        expect(toInbound({ ...CHANNEL_POST, entities: [] })).toBeUndefined()
        expect(toInbound({ ...PERSONAL, from: { id: BOT } })).toBeUndefined()
        expect(toInbound({ ...PERSONAL, type: "conversationUpdate" })).toBeUndefined()
    })
})

describe("replies", () => {
    test("posted to the conversation's service with the bot's token, which is cached", async () => {
        const { transport, host, deliver, bearer, ms } = setup()
        await transport.start(host)
        await deliver(PERSONAL, bearer())
        const message = {
            channelId: "teams",
            recipient: "a:personal-1",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        }
        expect(await transport.send({ ...message, text: "one" })).toEqual({
            ok: true,
            providerMessageId: "sent-1",
        })
        await transport.send({ ...message, text: "two" })
        expect(ms.sent[0]?.url).toBe(`${SERVICE}v3/conversations/a%3Apersonal-1/activities`)
        expect(ms.sent[0]?.auth).toBe("Bearer bot-token")
        expect(ms.sent[0]?.body).toMatchObject({
            type: "message",
            text: "one",
            textFormat: "markdown",
        })
        expect(ms.calls().tokenCalls).toBe(1)
    })

    test("a conversation's address survives a restart, so a schedule can deliver there", async () => {
        const first = setup()
        await first.transport.start(first.host)
        await first.deliver(PERSONAL, first.bearer())
        const again = new TeamsTransport({
            id: "teams",
            dir: first.dir,
            auth: new BotFrameworkAuth({ appId: APP, password: "pw", fetch: first.ms.fetch }),
            fetch: first.ms.fetch,
        })
        const result = await again.send({
            channelId: "teams",
            recipient: "a:personal-1",
            text: "your 9am brief",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(true)
    })

    test("an unknown conversation fails permanently; throttling retries; a 403 does not", async () => {
        const { transport, host, deliver, bearer, ms } = setup()
        await transport.start(host)
        const message = {
            channelId: "teams",
            text: "x",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        }
        const unknown = await transport.send({ ...message, recipient: "a:never-seen" })
        expect(unknown).toMatchObject({
            ok: false,
            retryable: false,
            error: { code: "teams_conversation_unknown" },
        })

        await deliver(PERSONAL, bearer())
        ms.replyWith(
            () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
        )
        expect(await transport.send({ ...message, recipient: "a:personal-1" })).toMatchObject({
            ok: false,
            retryable: true,
            retryAfterMs: 2000,
        })
        ms.replyWith(() => new Response("forbidden", { status: 403 }))
        expect(await transport.send({ ...message, recipient: "a:personal-1" })).toMatchObject({
            ok: false,
            retryable: false,
        })
    })
})

describe("through a real runtime", () => {
    test("a mention in a channel runs a turn for the member, and the reply lands in the thread", async () => {
        const key = keyPair("k1")
        const ms = microsoft([key.jwk])
        const dir = mkdtempSync(join(tmpdir(), "teams-runtime-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}\nid: crew\nmodel:\n  main:\n    id: m\n    api: scripted\nchannels:\n  - type: teams\n    id: teams\n    allowFrom: ["*"]\n`,
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
            channels: {
                teams: (context) =>
                    new TeamsTransport({
                        id: context.id,
                        dir: context.dir,
                        auth: new BotFrameworkAuth({ appId: APP, password: "pw", fetch: ms.fetch }),
                        fetch: ms.fetch,
                    }),
            },
        })
        const token = jwt(key.privateKey, "k1", {
            iss: ISSUER,
            aud: APP,
            exp: Math.floor(Date.now() / 1000) + 600,
            serviceUrl: SERVICE,
        })
        const outcome = await runtime.channels.handleWebhook("crew", "teams", {
            body: CHANNEL_POST,
            headers: { authorization: `Bearer ${token}` },
        })
        expect(outcome.status).toBe(200)
        for (
            let i = 0;
            i < 200 && ms.sent.every((entry) => entry.body.type !== "message");
            i += 1
        ) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const reply = ms.sent.find((entry) => entry.body.type === "message")
        expect(reply?.body.text).toBe("Here is the summary.")
        expect(reply?.url).toContain(encodeURIComponent("19:abc@thread.tacv2;messageid=1700"))
        const [turn] = (await runtime.store.turns.listForAgent("crew", {})).turns
        await runtime.stop()
        expect(turn?.input).toBe("summarise this thread for Bob")
    })
})
