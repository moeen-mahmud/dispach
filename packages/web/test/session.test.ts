import { describe, expect, test } from "bun:test"
import {
    conversationLabel,
    newConversationKey,
    rememberedSession,
    rememberSession,
    sharesConversations,
} from "../src/lib/session.ts"

describe("a conversation the browser opens", () => {
    test("gets a key of its own, never api:default", () => {
        const key = newConversationKey(() => new Uint8Array([0, 1, 2, 31, 32, 255]))
        expect(key).toBe("web:012z0z")
        expect(newConversationKey((n) => crypto.getRandomValues(new Uint8Array(n)))).toMatch(
            /^web:[0-9a-hjkmnp-tv-z]{6}$/,
        )
    })

    test("is reopened after a reload only for the agent it belongs to", () => {
        const stored = rememberSession("quill", "web:abc123")
        expect(rememberedSession(stored, "quill")).toBe("web:abc123")
        expect(rememberedSession(stored, "other")).toBeUndefined()
        expect(rememberedSession(null, "quill")).toBeUndefined()
    })
})

describe("conversationLabel", () => {
    test("a person's own conversation is You, the one before a new conversation is earlier", () => {
        expect(conversationLabel({ sessionKey: "owner:me:k7m2xp", head: true })).toBe("You")
        expect(
            conversationLabel({
                sessionKey: "owner:me:k7m2xp",
                head: false,
                lastActivityAt: "2026-10-28T09:00:00.000Z",
            }),
        ).toBe("You · earlier, 2026-10-28")
        expect(conversationLabel({ sessionKey: "owner:me:k7m2xp~ab12cd", head: true })).toBe("You")
    })

    test("a participant's is their id, and every other key is shown as it is", () => {
        expect(conversationLabel({ sessionKey: "peer:user:ada~ab12cd" })).toBe("user:ada")
        expect(conversationLabel({ sessionKey: "tg:5550123" })).toBe("tg:5550123")
        expect(conversationLabel({ sessionKey: "web:a1b2c3", head: true })).toBe("web:a1b2c3")
    })

    test("only owner and peer scopes share a conversation", () => {
        expect(sharesConversations("owner")).toBe(true)
        expect(sharesConversations("peer")).toBe(true)
        expect(sharesConversations("channel-peer")).toBe(false)
        expect(sharesConversations(undefined)).toBe(false)
    })
})
