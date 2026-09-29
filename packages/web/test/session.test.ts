import { describe, expect, test } from "bun:test"
import { newConversationKey, rememberedSession, rememberSession } from "../src/lib/session.ts"

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
