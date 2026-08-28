/**
 * What `deliver.to` takes, derived from addresses this agent has actually been reached on.
 *
 * The question exists because a handle is the form a person recognises and, on Telegram, the form
 * that cannot work for a private chat — `chat_id` accepts `@name` only for a channel. `allowFrom`
 * holds handles, so copying one into `deliver.to` is the obvious move and produces a schedule that
 * fires perfectly and delivers nothing.
 *
 * Observed rather than resolved: Telegram will not tell a bot the chat id behind an `@name`, so the
 * only trustworthy source is an id a real inbound message already arrived on.
 */

import { describe, expect, test } from "bun:test"
import { recipientsFrom } from "../src/schedules.ts"

const session = (channel: string, peerId: string, lastActivityAt: string) => ({
    channel,
    peerId,
    lastActivityAt,
})

describe("recipientsFrom", () => {
    test("keeps only channels the agent declares", () => {
        // `local`, `api` and `schedule` are sessions and are not places a reply can be sent. Listing
        // them under a heading that says "what deliver.to takes" would be four wrong answers beside
        // one right one — and `schedule:` rows in particular are this agent's own runs.
        const rows = recipientsFrom(
            [
                session("tg", "1195568132", "2026-08-27T14:06:52.421Z"),
                session("local", "5veszy", "2026-08-27T14:29:03.794Z"),
                session("schedule", "hi-every-15", "2026-08-27T14:43:50.642Z"),
                session("api", "moeen", "2026-08-27T13:00:00.000Z"),
            ],
            ["tg"],
        )
        expect(rows).toEqual([
            { channelId: "tg", address: "1195568132", lastSeen: "2026-08-27T14:06:52.421Z" },
        ])
    })

    test("one row per address, carrying the most recent contact", () => {
        // A peer opens a new session per thread, so the raw rows repeat. Three lines for one person
        // is a list that has to be read twice to answer a one-value question.
        const rows = recipientsFrom(
            [
                session("tg", "1195568132", "2026-08-27T10:00:00.000Z"),
                session("tg", "1195568132", "2026-08-27T14:06:52.421Z"),
                session("tg", "1195568132", "2026-08-27T12:00:00.000Z"),
            ],
            ["tg"],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.lastSeen).toBe("2026-08-27T14:06:52.421Z")
    })

    test("groups by channel, newest first inside one", () => {
        const rows = recipientsFrom(
            [
                session("wa", "4477000000", "2026-08-27T09:00:00.000Z"),
                session("tg", "111", "2026-08-27T08:00:00.000Z"),
                session("tg", "222", "2026-08-27T14:00:00.000Z"),
            ],
            ["tg", "wa"],
        )
        expect(rows.map((row) => `${row.channelId}:${row.address}`)).toEqual([
            "tg:222",
            "tg:111",
            "wa:4477000000",
        ])
    })

    test("an agent nobody has messaged has no addresses, rather than a wrong one", () => {
        expect(recipientsFrom([], ["tg"])).toEqual([])
        // And a declared channel with no traffic contributes nothing — there is no address to
        // invent for it, which is the whole reason this is derived from sessions.
        expect(recipientsFrom([session("tg", "1", "2026-08-27T09:00:00.000Z")], ["wa"])).toEqual([])
    })
})
