/**
 * Voice notes in and photos out, against a fake Bot API that records what it was sent.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChannelHost, RawInbound } from "@dispach/core"
import { TelegramApi } from "../src/api.ts"
import { TelegramTransport } from "../src/transport.ts"

const TOKEN = "123456:AAtest-token-never-real"

function bot() {
    const calls: { url: string; body: RequestInit["body"] }[] = []
    const fetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url: input, body: init?.body })
        if (input.endsWith("/getFile")) {
            return Response.json({ ok: true, result: { file_path: "voice/file_7.oga" } })
        }
        if (input.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]))
        return Response.json({ ok: true, result: { message_id: 9, chat: { id: 1 }, date: 0 } })
    }
    const transport = new TelegramTransport({
        id: "tg",
        token: TOKEN,
        mode: "webhook",
        webhookUrl: "https://bot.test/hook",
        api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
    })
    const received: RawInbound[] = []
    const host = {
        receive: (message: RawInbound) => received.push(message),
        status: () => {},
        error: () => {},
    } as unknown as ChannelHost
    return { transport, host, received, calls }
}

describe("Telegram media", () => {
    test("a voice note arrives as audio, and is downloaded only when asked", async () => {
        const { transport, host, received, calls } = bot()
        await transport.start(host)
        await transport.webhook({
            headers: {},
            body: {
                update_id: 1,
                message: {
                    message_id: 5,
                    from: { id: 42, is_bot: false, first_name: "Ada" },
                    chat: { id: 42, type: "private" },
                    date: 1_700_000_000,
                    voice: { file_id: "F1", duration: 3, mime_type: "audio/ogg", file_size: 900 },
                },
            },
        })
        expect(received).toHaveLength(1)
        const audio = received[0]?.audio
        expect(received[0]?.text).toBe("")
        expect(audio?.durationS).toBe(3)
        expect(audio?.sizeBytes).toBe(900)
        expect(calls.some((call) => call.url.endsWith("/getFile"))).toBe(false)

        const bytes = await audio?.fetch(new AbortController().signal)
        expect([...(bytes ?? [])]).toEqual([1, 2, 3])
        expect(calls.at(-1)?.url).toBe(`https://api.telegram.org/file/bot${TOKEN}/voice/file_7.oga`)
    })

    test("an attachment is sent as a photo in the thread, with the chunk's text as its caption", async () => {
        const { transport, calls } = bot()
        const dir = mkdtempSync(join(tmpdir(), "tg-media-"))
        const path = join(dir, "cube.png")
        writeFileSync(path, new Uint8Array([0x89, 0x50]))
        const result = await transport.send({
            channelId: "tg",
            recipient: "-1001",
            text: "",
            thread: "12",
            attachment: { path, mimeType: "image/png" },
            idempotencyKey: "k",
            chunkIndex: 1,
            chunkTotal: 2,
        })
        expect(result).toEqual({ ok: true, providerMessageId: "9" })
        const call = calls.at(-1)
        expect(call?.url.endsWith("/sendPhoto")).toBe(true)
        const form = call?.body as FormData
        expect(form.get("chat_id")).toBe("-1001")
        expect(form.get("message_thread_id")).toBe("12")
        expect((form.get("photo") as File).name).toBe("cube.png")
        // An empty caption is not sent: Telegram would render it as a blank line under the photo.
        expect(form.has("caption")).toBe(false)
    })
})
