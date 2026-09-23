/**
 * The pairing interlude: what it shows, and what it must never do.
 *
 * The factory is injected in every case here — **the suite never opens a socket to WhatsApp.** That
 * is not only speed: a test that really connected would pair against somebody's account, and the
 * one thing this package's own README asks for is that a real number is a deliberate choice.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import type { ChannelHost } from "@dispach/core"
import { pairLater, pairWhatsApp } from "../src/lib/init-whatsapp.ts"

/** A transport a test drives: it reports whatever the script says, when the script says it. */
function scripted(script: {
    readonly code?: string
    readonly pairAfterMs?: number
    readonly failWith?: string
    readonly startThrows?: boolean
}) {
    const state = { stopped: false }
    const factory = () =>
        ({
            id: "wa",
            type: "whatsapp",
            limits: { maxMessageChars: 4096, idempotentSend: false },
            start: async (host: ChannelHost) => {
                if (script.startThrows === true) throw new Error("no socket")
                if (script.failWith !== undefined)
                    (host as unknown as { error: (d: unknown) => void }).error({
                        message: script.failWith,
                    })
                if (script.code !== undefined)
                    setTimeout(() => {
                        host.status("needs_input", "enter this", {
                            kind: "pairing_code",
                            payload: script.code as string,
                        })
                    }, 5)
                if (script.pairAfterMs !== undefined)
                    setTimeout(() => host.status("connected", "paired"), script.pairAfterMs)
            },
            stop: async () => {
                state.stopped = true
            },
            send: async () => ({ ok: true as const, id: "x" }),
        }) as never
    return { factory, state }
}

function run(script: Parameters<typeof scripted>[0]) {
    const lines: string[] = []
    const { factory, state } = scripted(script)
    return {
        state,
        lines,
        go: () =>
            pairWhatsApp({
                manifestPath: "/tmp/agent.yaml",
                dir: mkdtempSync(tmpdir()),
                number: "8801711223344",
                channelId: "wa",
                factory,
                codeWaitMs: 300,
                pairWaitMs: 300,
                out: (text) => lines.push(text),
            }),
    }
}

describe("a code is shown where the number was typed", () => {
    test("the code reaches the screen, grouped the way WhatsApp shows it", async () => {
        const probe = run({ code: "K7Q2M4XP" })
        const outcome = await probe.go()
        expect(outcome).toBe("code-shown")
        const text = probe.lines.join("")
        expect(text).toContain("K7Q2 M4XP")
        // Where to type it. A code with no instructions is a string.
        expect(text).toContain("Linked devices")
    })

    test("pairing while it waits is reported as done", async () => {
        const probe = run({ code: "K7Q2M4XP", pairAfterMs: 30 })
        expect(await probe.go()).toBe("paired")
        expect(probe.lines.join("")).toContain("Paired")
    })
})

describe("it never hangs and never fails the init", () => {
    /**
     * The case that matters most: under Bun no code ever arrives. An unbounded wait would turn the
     * last step of onboarding into a hang, on the runtime the container and the binary both use.
     */
    test("no code within the bound returns rather than waiting forever", async () => {
        const probe = run({})
        expect(await probe.go()).toBe("no-code")
        expect(probe.lines.join("")).toContain("No pairing code")
    })

    test("the reason is named when the transport gave one", async () => {
        const probe = run({ failWith: "pairing does not complete under Bun" })
        await probe.go()
        expect(probe.lines.join("")).toContain("under Bun")
    })

    test("a transport that cannot start is an outcome, not a throw", async () => {
        const probe = run({ startThrows: true })
        expect(await probe.go()).toBe("no-code")
    })

    /**
     * Always stopped, including after a successful pair: the credentials are on disk and the
     * agent's own run should hold the socket. Leaving this one open would put two linked devices
     * on one session.
     */
    test("the transport is stopped on every path", async () => {
        for (const script of [{ code: "K7Q2M4XP" }, {}, { code: "A", pairAfterMs: 10 }]) {
            const probe = run(script)
            await probe.go()
            expect(probe.state.stopped).toBe(true)
        }
    })
})

describe("the later route is named", () => {
    test("both surfaces, because either is a complete answer", () => {
        const text = pairLater("milo")
        // One verb that does the whole thing, because "run serve, then run list, then read the
        // code" was three commands standing in for one action.
        expect(text).toContain("channels pair milo wa")
        expect(text).toContain("web UI")
    })
})
