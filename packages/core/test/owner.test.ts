/**
 * `owner.ts`: a channel sender is the owner by the handle they wrote into `channelIds`, the way
 * `allowFrom` already matched them (decision 15.7).
 */

import type { ActingParticipant } from "../src/loop/sender.ts"
import { isOwner, resolveParticipant } from "../src/runtime/owner.ts"
import { describe, expect, test } from "./_harness.ts"

const telegram = (id: string, handles: string[] = []): ActingParticipant => ({
    id: `telegram:${id}`,
    via: "channel",
    handles,
})

describe("isOwner", () => {
    const assignment = {
        participantId: "me:k7m2xp",
        channelIds: ["telegram:@Moeen_M", "whatsapp:+880 1711-223344"],
    }

    test("the owner's own id, from the API", () => {
        expect(isOwner(assignment, { id: "me:k7m2xp", via: "api" })).toBe(true)
    })

    test("Telegram stamps a numeric id; the handle the owner wrote still matches", () => {
        expect(isOwner(assignment, telegram("5550123", ["moeen_m", "5550123"]))).toBe(true)
    })

    test("WhatsApp carries digits; the contact-card form matches", () => {
        const sender: ActingParticipant = {
            id: "whatsapp:8801711223344",
            via: "channel",
            handles: ["8801711223344"],
        }
        expect(isOwner(assignment, sender)).toBe(true)
    })

    test("a stranger, and the same handle on a different channel type, are not", () => {
        expect(isOwner(assignment, telegram("999", ["someone"]))).toBe(false)
        expect(
            isOwner(assignment, { id: "slack:moeen_m", via: "channel", handles: ["moeen_m"] }),
        ).toBe(false)
    })

    test("an API caller cannot claim a handle: only a channel vouches for one", () => {
        expect(isOwner(assignment, { id: "telegram:x", via: "api", handles: ["moeen_m"] })).toBe(
            false,
        )
    })

    test("a stand-in acts for someone else, never as the owner", () => {
        expect(isOwner(assignment, { id: "me:k7m2xp", via: "api", onBehalfOf: "me:k7m2xp" })).toBe(
            false,
        )
    })

    test("`*` lets anybody in through allowFrom and makes nobody the owner", () => {
        expect(
            isOwner({ participantId: "p", channelIds: ["telegram:*"] }, telegram("1", ["a"])),
        ).toBe(false)
    })

    test("the exact pilot.15 form still matches", () => {
        expect(isOwner({ participantId: "p", channelIds: ["telegram:42"] }, telegram("42"))).toBe(
            true,
        )
    })
})

describe("resolveParticipant", () => {
    const people = [
        { id: "user:ada", channelIds: ["telegram:@ada"] },
        { id: "user:bob", channelIds: ["telegram:@bob"] },
    ]

    test("by id, by a channel handle, and nobody for a stranger", () => {
        expect(resolveParticipant(people, { id: "user:bob", via: "api" })).toBe("user:bob")
        expect(resolveParticipant(people, telegram("77", ["Ada"]))).toBe("user:ada")
        expect(resolveParticipant(people, telegram("88", ["eve"]))).toBeUndefined()
    })
})
