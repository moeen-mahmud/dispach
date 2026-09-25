/**
 * A placer whose silos are small HTTP servers standing in for the runtime's `/v1`: they
 * authenticate their own token and the keys minted in them, answer `/v1/activity` from settable
 * state, and stream a turn. A paused fake refuses every request with 503, so a proxy that forwarded
 * to a silo it had not woken fails loudly instead of passing.
 *
 * The real runtime is exercised by `e2e.test.ts`; this is what makes the rest fast and exact.
 */

import { randomBytes } from "node:crypto"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Readable } from "node:stream"
import { gunzipSync, gzipSync } from "node:zlib"
import type { PlacedSilo, Placer } from "../src/placer.ts"
import { UNAUTHORIZED } from "../src/server.ts"

export interface FakeSilo {
    readonly name: string
    server: Server
    readonly keys: Set<string>
    /** What the silo's volume holds, as far as backup and restore can tell. */
    data: string
    stopped: boolean
    paused: boolean
    idle: boolean
    nextWakeAt?: string
    /** Every path the silo was asked for, with the credential presented. */
    readonly seen: { path: string; auth: string }[]
    /** Resolve to end a held stream. */
    release?: () => void
}

export class FakePlacer implements Placer {
    readonly silos = new Map<string, FakeSilo>()
    readonly calls: string[] = []
    /** When set, `/v1/ready` never answers 200, to exercise the not-ready path. */
    neverReady = false

    async create(subject: string, token: string): Promise<PlacedSilo> {
        const name = `silo-${subject}`
        const silo: FakeSilo = {
            name,
            keys: new Set([token]),
            data: `data of ${subject}`,
            stopped: false,
            paused: false,
            idle: true,
            seen: [],
            server: createServer((req, res) => {
                const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "")
                const path = req.url ?? "/"
                silo.seen.push({ path, auth })
                const json = (status: number, body: unknown) => {
                    res.writeHead(status, { "content-type": "application/json" })
                    res.end(JSON.stringify(body))
                }
                if (silo.paused || silo.stopped) return json(503, { error: { code: "fake_down" } })
                if (path === "/v1/ready")
                    return json(this.neverReady ? 503 : 200, { status: "ready" })
                if (!silo.keys.has(auth)) {
                    return json(401, UNAUTHORIZED)
                }
                if (path === "/v1/activity") {
                    return json(200, {
                        idle: silo.idle,
                        ...(silo.nextWakeAt === undefined ? {} : { nextWakeAt: silo.nextWakeAt }),
                    })
                }
                if (path === "/v1/keys" && req.method === "POST") {
                    const secret = `k_${randomBytes(8).toString("hex")}`
                    silo.keys.add(secret)
                    return json(201, { keyId: "key_1", secret })
                }
                if (path.startsWith("/v1/usage")) {
                    return json(200, { buckets: [{ calls: 3 }], query: path })
                }
                if (path === "/v1/stream") {
                    res.writeHead(200, { "content-type": "text/event-stream" })
                    res.write("event: hello\ndata: {}\n\n")
                    silo.release = () => res.end("event: bye\ndata: {}\n\n")
                    return
                }
                return json(200, { path, method: req.method })
            }),
        }
        await new Promise<void>((resolve) => silo.server.listen(0, "127.0.0.1", resolve))
        this.silos.set(name, silo)
        this.calls.push(`create ${name}`)
        return { name, baseUrl: await this.address(name) }
    }

    /** Same volume (keys, data), new container: a new server on a new port. */
    async recreate(subject: string, _token: string): Promise<PlacedSilo> {
        const name = `silo-${subject}`
        const silo = this.#get(name)
        const handler = silo.server.listeners("request")[0] as RequestListener
        silo.server.closeAllConnections()
        await new Promise((resolve) => silo.server.close(resolve))
        silo.server = createServer(handler)
        await new Promise<void>((resolve) => silo.server.listen(0, "127.0.0.1", resolve))
        silo.paused = false
        silo.stopped = false
        this.calls.push(`recreate ${name}`)
        return { name, baseUrl: await this.address(name) }
    }

    async exportData(name: string): Promise<Readable> {
        const silo = this.#get(name)
        this.calls.push(`export ${name} paused=${silo.paused}`)
        return Readable.from([gzipSync(silo.data)])
    }

    async importData(name: string, tar: Readable): Promise<void> {
        const silo = this.#get(name)
        const chunks: Buffer[] = []
        for await (const chunk of tar) chunks.push(chunk as Buffer)
        silo.data = gunzipSync(Buffer.concat(chunks)).toString()
        silo.stopped = true
        silo.paused = false
        this.calls.push(`import ${name}`)
    }

    async start(name: string): Promise<void> {
        this.#get(name).stopped = false
        this.calls.push(`start ${name}`)
    }

    async pause(name: string): Promise<void> {
        this.#get(name).paused = true
        this.calls.push(`pause ${name}`)
    }

    async wake(name: string): Promise<void> {
        this.#get(name).paused = false
        this.calls.push(`wake ${name}`)
    }

    async remove(name: string): Promise<void> {
        const silo = this.#get(name)
        silo.server.closeAllConnections()
        await new Promise((resolve) => silo.server.close(resolve))
        this.silos.delete(name)
        this.calls.push(`remove ${name}`)
    }

    async address(name: string): Promise<string> {
        const { port } = this.#get(name).server.address() as AddressInfo
        return `http://127.0.0.1:${port}`
    }

    async closeAll(): Promise<void> {
        for (const name of [...this.silos.keys()]) await this.remove(name)
    }

    #get(name: string): FakeSilo {
        const silo = this.silos.get(name)
        if (silo === undefined) throw new Error(`no fake silo ${name}`)
        return silo
    }
}
