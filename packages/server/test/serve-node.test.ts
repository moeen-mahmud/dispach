/**
 * The Node adapter, driven over a real socket.
 *
 * Every install ships this adapter and the suite runs under Bun, so without `engine: "node"` nothing
 * here would ever exercise it. `/v1/ws` under Node answered 501 until 0.1.3 — acceptable while the
 * container ran under Bun, and "absent from every install" once it did not. These tests hold the
 * upgrade to the same behaviour the Bun adapter has: the subprotocol echoed, the credential read from
 * it, the frames answered by the one shared bridge, and a hostile origin refused before any of that.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { serve } from "../src/serve.ts"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

/** Open a socket and resolve with its first frame, or reject with the close event. */
function firstFrame(
    url: string,
    protocols?: string[],
    headers?: Record<string, string>,
): Promise<{ frame: Record<string, unknown>; ws: WebSocket; protocol: string }> {
    return new Promise((resolve, reject) => {
        // Bun's `WebSocket` takes `{ protocols, headers }`, which is how a test sets an `Origin`.
        const ws = new WebSocket(url, { protocols, ...(headers === undefined ? {} : { headers }) })
        ws.addEventListener("message", (event) => {
            resolve({
                frame: JSON.parse(String(event.data)) as Record<string, unknown>,
                ws,
                protocol: ws.protocol,
            })
        })
        ws.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)))
        ws.addEventListener("error", () => reject(new Error("socket error")))
    })
}

describe("/v1/ws under Node", () => {
    test("upgrades, echoes the subprotocol, and answers frames through the bridge", async () => {
        const { runtime } = await harness()
        const running = await serve({
            runtime,
            host: "127.0.0.1",
            port: 0,
            token: TOKEN,
            engine: "node",
        })
        try {
            expect(running.websocket).toBe(true)
            const wsUrl = `${running.url.replace("http", "ws")}/v1/ws?agentId=assistant`
            const opened = await firstFrame(wsUrl, ["dispach.bearer", TOKEN])
            // The browser closes a socket whose offered protocol was not echoed — so the echo is
            // asserted, not the mere opening.
            expect(opened.protocol).toBe("dispach.bearer")
            expect(opened.frame).toEqual({ type: "ws.open", agentId: "assistant", chunks: false })

            const pong = new Promise<Record<string, unknown>>((resolve) => {
                opened.ws.addEventListener(
                    "message",
                    (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
                    { once: true },
                )
            })
            opened.ws.send(JSON.stringify({ type: "ping" }))
            expect(await pong).toEqual({ type: "pong" })
            opened.ws.close()
        } finally {
            await running.stop()
            await runtime.stop()
        }
    })

    /**
     * Both refusals are observed as a socket that never opens, because that is all Bun can show:
     * this suite runs the Node adapter through Bun's `node:http` shim, and the shim does not deliver
     * a write made on an `upgrade` socket — so the 403 and 401 bodies the adapter sends arrive as
     * an empty close here. They arrive intact under real Node, which the CI `bundle` job asserts
     * with raw `Upgrade` requests against the installed package ("ws handshake, hostile" → 403).
     */
    test("refuses a bad credential and a hostile origin without upgrading", async () => {
        const { runtime } = await harness()
        const running = await serve({
            runtime,
            host: "127.0.0.1",
            port: 0,
            token: TOKEN,
            engine: "node",
        })
        try {
            const wsUrl = `${running.url.replace("http", "ws")}/v1/ws`
            await expect(firstFrame(wsUrl, ["dispach.bearer", "wrong"])).rejects.toThrow()
            // The origin guard sits before authentication on this path — a browser does not apply
            // same-origin to WebSocket, so this is the only thing refusing a cross-origin handshake.
            // A valid credential with a hostile origin must still not open.
            await expect(
                firstFrame(wsUrl, ["dispach.bearer", TOKEN], { origin: "https://evil.example" }),
            ).rejects.toThrow()
            // And the same credential with no origin opens, so the refusal above was the origin's.
            const opened = await firstFrame(wsUrl, ["dispach.bearer", TOKEN])
            expect(opened.frame.type).toBe("ws.open")
            opened.ws.close()
        } finally {
            await running.stop()
            await runtime.stop()
        }
    })
})
