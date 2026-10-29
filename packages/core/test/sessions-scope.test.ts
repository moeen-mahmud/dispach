/**
 * `sessions.scope` (`docs/23-SPEC-SESSIONS.md`): one conversation per person across surfaces, read off
 * a real runtime with a stub channel — the key each turn ran in, the history the model was shown, and
 * where each reply was sent.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChannelFactory,
    type ChannelHost,
    type ChatChunk,
    type ChatMessage,
    type ModelTransport,
    Runtime,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** Answers `re: <input>`, recording what each request held. `hold` keeps a turn open until released. */
function model(seen: ChatMessage[][], hold?: Promise<void>): ModelTransport {
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push([...request.messages])
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                if (hold !== undefined && input.includes("slow")) await hold
                yield { type: "text", delta: `re: ${input}` }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

async function boot(scope: string | undefined, options: { hold?: Promise<void> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "scope-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: milo
model:
  main:
    id: scripted
    api: scripted
${scope === undefined ? "" : `sessions:\n  scope: ${scope}\n`}channels:
  - type: stub
    id: tg
    allowFrom: ["*"]
`,
    )
    const seen: ChatMessage[][] = []
    const sent: { recipient: string; text: string }[] = []
    let host: ChannelHost | undefined
    const stub: ChannelFactory = (context) => ({
        id: context.id,
        type: "stub",
        limits: { maxMessageChars: 4096, idempotentSend: false },
        start: async (h: ChannelHost) => {
            host = h
        },
        stop: async () => {},
        send: async (message) => {
            sent.push({ recipient: message.recipient, text: message.text })
            return { ok: true as const, providerMessageId: String(sent.length) }
        },
    })
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { scripted: model(seen, options.hold) },
        channels: { stub },
        startChannels: true,
    })
    const agent = runtime.agent("milo")
    const assign = (channelIds: string[] = ["stub:@Moeen"]) =>
        agent.store.conversations.assign({
            agentId: "milo",
            participantId: "me:k7m2xp",
            channelIds,
            assignedAt: new Date().toISOString(),
        })
    /** A Telegram-shaped message: a numeric id, and the handle the owner wrote into `channelIds`. */
    const telegram = async (text: string, from = { id: "5550123", handle: "moeen" }) => {
        const before = sent.length
        host?.receive({
            peerId: from.id,
            senderHandle: from.handle,
            text,
            receivedAt: new Date().toISOString(),
        })
        for (let i = 0; i < 100 && sent.length === before; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }
    return { runtime, agent, seen, sent, assign, telegram }
}

describe("sessions.scope: owner", () => {
    test("the owner's Telegram and web turns share one conversation; each reply goes where it was asked", async () => {
        const { runtime, agent, seen, sent, assign, telegram } = await boot("owner")
        await assign()

        await telegram("my dentist is on Friday")
        const web = await agent.send("when is my dentist?", { sessionKey: "web:a1b2c3" })

        expect(web.sessionKey).toBe("owner:me:k7m2xp")
        // The web turn was shown the Telegram exchange as history, not left to recall.
        expect(seen.at(-1)?.map((m) => m.content)).toContain("my dentist is on Friday")
        // The Telegram reply went to the Telegram chat; the web turn sent nothing to a channel.
        expect(sent).toEqual([{ recipient: "5550123", text: "re: my dentist is on Friday" }])
        const keys = (await agent.store.sessions.list("milo")).map((s) => s.sessionKey)
        expect(keys).toEqual(["owner:me:k7m2xp"])
        await runtime.stop()
    })

    test("a stranger on the channel keeps their own conversation", async () => {
        const { runtime, agent, assign, telegram } = await boot("owner")
        await assign()
        await telegram("hello", { id: "999", handle: "eve" })
        const keys = (await agent.store.sessions.list("milo")).map((s) => s.sessionKey)
        expect(keys).toEqual(["tg:999"])
        await runtime.stop()
    })

    test("a peer agent, a schedule, a room and a child keep the key they were given", async () => {
        const { runtime, agent, assign } = await boot("owner")
        await assign()
        const kept = [
            await agent.send("x", {
                sessionKey: "api:a2a-t1",
                from: { id: "acme", kind: "agent" },
            }),
            await agent.send("x", { sessionKey: "tg:5550123", source: "schedule:brief" }),
            await agent.send("x", { sessionKey: "room:r1" }),
            await agent.send("x", { sessionKey: "ask:run1", peerAsk: { askedBy: "user:bob" } }),
        ].map((result) => result.sessionKey)
        expect(kept).toEqual(["api:a2a-t1", "tg:5550123", "room:r1", "ask:run1"])
        await runtime.stop()
    })

    test("rotating starts a fresh conversation that the channel continues in; the old one stays", async () => {
        const { runtime, agent, seen, assign, telegram } = await boot("owner")
        await assign()
        await agent.send("old topic", { sessionKey: "web:x" })
        const rotated = await agent.rotateSession()
        expect(rotated?.previous).toBe("owner:me:k7m2xp")
        expect(rotated?.sessionKey).toMatch(/^owner:me:k7m2xp~[0-9a-hjkmnp-tv-z]{6}$/)

        await telegram("new topic")
        expect(seen.at(-1)?.map((m) => m.content)).not.toContain("old topic")
        const keys = (await agent.store.sessions.list("milo")).map((s) => s.sessionKey).sort()
        expect(keys).toEqual(["owner:me:k7m2xp", rotated?.sessionKey].sort())
        // Naming the old head on purpose still continues it.
        const back = await agent.send("and again", { sessionKey: "owner:me:k7m2xp" })
        expect(back.sessionKey).toBe(rotated?.sessionKey)
        const old = await agent.send("explicit", { sessionKey: rotated?.sessionKey ?? "" })
        expect(old.sessionKey).toBe(rotated?.sessionKey)
        await runtime.stop()
    })

    test("two turns in the owner's conversation run one after the other", async () => {
        let release = () => {}
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })
        const { runtime, agent, seen, assign } = await boot("owner", { hold })
        await assign()
        const first = agent.send("slow one", { sessionKey: "web:a" })
        const second = agent.send("quick one", { sessionKey: "local:b" })
        await new Promise((resolve) => setTimeout(resolve, 30))
        // The second is queued behind the first rather than racing it through the same history.
        expect(seen.length).toBe(1)
        release()
        await Promise.all([first, second])
        expect(seen[1]?.map((m) => m.content)).toContain("re: slow one")
        await runtime.stop()
    })

    test("unassigned, owner scope is channel-peer and says so", async () => {
        const { runtime, agent } = await boot("owner")
        expect(agent.warnings.map((w) => w.code)).toContain("sessions_scope_unassigned")
        const result = await agent.send("x", { sessionKey: "web:a" })
        expect(result.sessionKey).toBe("web:a")
        await agent.store.conversations.assign({
            agentId: "milo",
            participantId: "me:k7m2xp",
            assignedAt: new Date().toISOString(),
        })
        await agent.checkSessionScope()
        expect(agent.warnings.map((w) => w.code)).not.toContain("sessions_scope_unassigned")
        await runtime.stop()
    })
})

describe("sessions.scope: peer and channel-peer", () => {
    test("peer: a registered participant gets one conversation across surfaces", async () => {
        const { runtime, agent, assign, telegram } = await boot("peer")
        await assign()
        await agent.store.conversations.upsertParticipant({
            id: "user:ada",
            kind: "human",
            role: "member",
            channelIds: ["stub:@ada"],
            createdAt: new Date().toISOString(),
        })
        await telegram("hi from ada", { id: "777", handle: "Ada" })
        const api = await agent.send("still ada", { from: { id: "user:ada", kind: "user" } })
        expect(api.sessionKey).toBe("peer:user:ada")
        const keys = (await agent.store.sessions.list("milo")).map((s) => s.sessionKey)
        expect(keys).toEqual(["peer:user:ada"])
        await runtime.stop()
    })

    test("the default is channel-peer: assigned or not, the key sent is the key used", async () => {
        const { runtime, agent, assign } = await boot(undefined)
        await assign()
        expect((await agent.send("x", { sessionKey: "web:a" })).sessionKey).toBe("web:a")
        expect(await agent.rotateSession()).toBeUndefined()
        expect(agent.warnings.map((w) => w.code)).not.toContain("sessions_scope_unassigned")
        await runtime.stop()
    })
})
