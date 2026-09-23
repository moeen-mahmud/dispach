/**
 * What a channel listing may claim, and what it may not.
 *
 * Written after both halves were reported as broken by somebody using them. The listing said
 * `wa whatsapp connected` for a WhatsApp channel that had never been paired in its life, and a
 * footer explaining that this is only the manifest did not undo the word in the table — the reply
 * was "it says whatsapp is connected, after i add my number, but it didn't show any code to pair".
 * A disclaimer under a claim does not cancel the claim.
 *
 * Nothing tested `channelsOf` before this file, which is part of why it shipped that way.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@dispach/core"
import { channelsOf } from "../src/lib/channel-actions.ts"

function agent(options: { pairWith?: string; creds?: unknown } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "channels-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: listed
model:
  main:
    id: test-model
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
  - type: whatsapp
    id: wa
    authDir: ./.whatsapp
${options.pairWith === undefined ? "" : `    pairWith: "${options.pairWith}"\n`}    allowFrom: []
`,
        "utf8",
    )
    if (options.creds !== undefined) {
        mkdirSync(join(dir, ".whatsapp"), { recursive: true })
        writeFileSync(join(dir, ".whatsapp", "creds.json"), JSON.stringify(options.creds), "utf8")
    }
    return join(dir, "agent.yaml")
}

const wa = (path: string) => channelsOf(path).find((channel) => channel.id === "wa")

describe("a manifest listing reports what the manifest says", () => {
    test("pairWith is carried, because it decides how pairing happens", () => {
        expect(wa(agent({ pairWith: "8801711223344" }))?.pairWith).toBe("8801711223344")
        // Absent means a QR. The renderer described the method with a constant before this field
        // existed, and that constant said "paired by QR" for a channel that pairs by code.
        expect(wa(agent())?.pairWith).toBeUndefined()
    })
})

describe("`linked` is a claim about a pairing, not about a file", () => {
    /**
     * The measured defect. Baileys writes `creds.json` the moment it connects, carrying freshly
     * generated keys and `registered: false` — so testing for the file reported a channel as
     * linked while the same row said `needs_input`, in one line of one live run.
     */
    test("credentials that exist but are not registered are not linked", () => {
        const path = agent({ pairWith: "8801711223344", creds: { registered: false, me: null } })
        expect(wa(path)?.paired).toBe(false)
    })

    test("registered credentials are linked", () => {
        const path = agent({ pairWith: "8801711223344", creds: { registered: true } })
        expect(wa(path)?.paired).toBe(true)
    })

    test("no session directory at all is not linked", () => {
        expect(wa(agent({ pairWith: "8801711223344" }))?.paired).toBe(false)
    })

    /**
     * Unreadable reads as **not** linked. The cost of saying "not linked yet" about a working
     * channel is a person re-running a command; the cost of the reverse is somebody waiting for a
     * pairing that nothing is going to offer.
     */
    test("a corrupt creds file is not linked rather than a thrown listing", () => {
        const dir = mkdtempSync(join(tmpdir(), "channels-bad-"))
        const path = agent({ pairWith: "8801711223344", creds: { registered: true } })
        void dir
        const broken = join(path, "..", ".whatsapp", "creds.json")
        writeFileSync(broken, "{not json", "utf8")
        expect(() => channelsOf(path)).not.toThrow()
        expect(wa(path)?.paired).toBe(false)
    })

    test("a channel with no pairing concept carries no claim either way", () => {
        // `paired` is WhatsApp's question. Telegram has a token, and answering "not linked" about
        // it would invent a state the channel does not have.
        const tg = channelsOf(agent()).find((channel) => channel.id === "tg")
        expect(tg?.paired).toBeUndefined()
    })
})
