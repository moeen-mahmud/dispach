/**
 * The peer-ask relay (decision 15.10, `docs/24-SPEC-PEER-ASK.md`) against fake silos: who the caller
 * is, who is the same person, what key the target mints, the rate limit, and what deleting a silo
 * takes with it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AddressInfo } from "node:net"
import { BRAND } from "../src/brand.ts"
import { ControlPlane } from "../src/control.ts"
import { Relay } from "../src/relay.ts"
import { createControlServer } from "../src/server.ts"
import { SiloStore } from "../src/store.ts"
import { FakePlacer } from "./fake.ts"

const TOKEN = "operator-token"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup() {
    let clock = Date.parse("2026-10-29T12:00:00.000Z")
    const store = await SiloStore.open(":memory:")
    const placer = new FakePlacer()
    const control = new ControlPlane({
        store,
        placer,
        relayUrl: "http://control:7600",
        now: () => clock,
        readyTimeoutMs: 300,
        log: () => {},
    })
    const relay = new Relay(control, () => clock)
    const server = createControlServer({ control, token: TOKEN, relay })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cleanups.push(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        await placer.closeAll()
        store.close()
    })
    const call = (method: string, path: string, init: { token?: string; body?: unknown } = {}) =>
        fetch(`${base}${path}`, {
            method,
            headers: {
                ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        })
    const fake = (subject: string) => {
        const silo = placer.silos.get(`silo-${subject}`)
        if (silo === undefined) throw new Error(`no silo ${subject}`)
        return silo
    }
    // Ada's personal silo and the team's; Bob is linked only in the team's.
    for (const subject of ["ada", "team"]) {
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject } })
    }
    fake("team").agents = [
        { id: "crm", description: "The team's CRM", ask: true, assignee: null },
        { id: "adas-helper", ask: true, assignee: "user:ada" },
        { id: "bobs-helper", ask: true, assignee: "user:bob" },
        { id: "quiet", ask: false, assignee: null },
    ]
    const link = (principal: string, subject: string, participantId: string) =>
        call("PUT", `/v1/people/${principal}/silos/${subject}`, {
            token: TOKEN,
            body: { participantId },
        })
    await link("p_ada", "ada", "me:ada001")
    await link("p_ada", "team", "user:ada")
    await link("p_bob", "team", "user:bob")
    const relayToken = (subject: string) => fake(subject).env[BRAND.runtime.relayTokenEnv] ?? ""
    const ask = (body: Record<string, unknown>, token = relayToken("ada")) =>
        call("POST", "/v1/relay/ask", {
            token,
            body: {
                participant: "me:ada001",
                toSilo: "team",
                toAgent: "crm",
                question: "How many deals are open?",
                askedBy: "milo",
                sessionKey: "ask:r_1",
                ...body,
            },
        })
    return {
        call,
        fake,
        ask,
        relayToken,
        store,
        advance: (ms: number) => {
            clock += ms
        },
    }
}

describe("the relay token", () => {
    test("every silo gets one and the URL in its environment; control keeps only a hash", async () => {
        const { fake, store, relayToken } = await setup()
        expect(fake("ada").env[BRAND.runtime.relayUrlEnv]).toBe("http://control:7600")
        expect(relayToken("ada").length).toBeGreaterThan(20)
        expect(JSON.stringify(store.get("ada"))).not.toContain(relayToken("ada"))
    })

    test("relay routes refuse the operator's token and a silo token", async () => {
        const { ask, call } = await setup()
        expect((await ask({}, TOKEN)).status).toBe(401)
        expect((await call("GET", "/v1/relay/peers?participant=me:ada001")).status).toBe(401)
    })

    test("recreate mints a new one and the old stops working", async () => {
        const { ask, call, relayToken } = await setup()
        const before = relayToken("ada")
        await call("POST", "/v1/silos/ada/recreate", { token: TOKEN })
        expect(relayToken("ada")).not.toBe(before)
        expect((await ask({}, before)).status).toBe(401)
        expect((await ask({})).status).toBe(200)
    })
})

describe("peers", () => {
    test("the person's own and shared askable agents in their other silos, nobody else's", async () => {
        const { call, relayToken } = await setup()
        const response = await call("GET", "/v1/relay/peers?participant=me:ada001", {
            token: relayToken("ada"),
        })
        const { peers } = (await response.json()) as { peers: { agent: string; shared: boolean }[] }
        expect(peers.map((peer) => [peer.agent, peer.shared])).toEqual([
            ["crm", true],
            ["adas-helper", false],
        ])
    })

    test("an unlinked participant gets an empty list, not an error", async () => {
        const { call, relayToken } = await setup()
        const response = await call("GET", "/v1/relay/peers?participant=user:eve", {
            token: relayToken("ada"),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ peers: [] })
    })
})

describe("ask", () => {
    test("mints a 60-second key bound to the person there, asks with it, and revokes it", async () => {
        const { ask, fake } = await setup()
        const response = await ask({})
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            text: "crm answers: How many deals are open?",
            reason: "final",
            sessionKey: "ask:r_1",
        })
        const team = fake("team")
        const [key] = team.minted
        expect(key?.scope).toEqual({
            participant: "user:ada",
            agents: ["crm"],
            can: ["chat"],
            sessions: "ask:",
            expiresIn: 60,
        })
        expect(key?.revoked).toBe(true)
        const [message] = team.messages
        // Asked with the minted key, never the silo's own token.
        expect(message?.auth).toBe(key?.secret)
        expect(message?.body).toMatchObject({
            from: { id: "user:ada", kind: "user" },
            peerAsk: { askedBy: "ada/milo" },
            sessionKey: "ask:r_1",
        })
    })

    test("an unlinked participant and a foreign silo answer the same 404", async () => {
        const { ask, call } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "elsewhere" } })
        const stranger = await ask({ participant: "user:eve" })
        const foreign = await ask({ toSilo: "elsewhere" })
        expect(stranger.status).toBe(404)
        expect(foreign.status).toBe(404)
        expect(await stranger.json()).toEqual(await foreign.json())
    })

    test("another person's agent, or one that never opted in, gets the same 404 and no key", async () => {
        const { ask, fake } = await setup()
        const bobs = await ask({ toAgent: "bobs-helper" })
        const quiet = await ask({ toAgent: "quiet" })
        const missing = await ask({ toAgent: "nobody" })
        expect([bobs.status, quiet.status, missing.status]).toEqual([404, 404, 404])
        expect(await bobs.json()).toEqual(await quiet.json())
        expect(fake("team").minted).toEqual([])
        expect(fake("team").messages).toEqual([])
        // Ada's own agent there is askable.
        expect((await ask({ toAgent: "adas-helper" })).status).toBe(200)
    })

    test("the rate limit: the default, a per-person override, and back after null", async () => {
        const { ask, call, advance } = await setup()
        await call("PUT", "/v1/relay/config", { token: TOKEN, body: { askRatePerMinute: 2 } })
        expect((await ask({})).status).toBe(200)
        expect((await ask({})).status).toBe(200)
        const limited = await ask({})
        expect(limited.status).toBe(429)
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)

        await call("PUT", "/v1/people/p_ada", { token: TOKEN, body: { askRatePerMinute: 3 } })
        expect((await ask({})).status).toBe(200)
        expect((await ask({})).status).toBe(429)

        await call("PUT", "/v1/people/p_ada", { token: TOKEN, body: { askRatePerMinute: null } })
        const person = await (await call("GET", "/v1/people/p_ada", { token: TOKEN })).json()
        expect(person).toMatchObject({ askRatePerMinute: 2, override: false })

        advance(61_000)
        expect((await ask({})).status).toBe(200)
    })
})

describe("people", () => {
    test("one participant in a silo is one person", async () => {
        const { call } = await setup()
        const clash = await call("PUT", "/v1/people/p_bob/silos/ada", {
            token: TOKEN,
            body: { participantId: "me:ada001" },
        })
        expect(clash.status).toBe(409)
    })

    test("deleting a silo deletes its links", async () => {
        const { call, store } = await setup()
        await call("DELETE", "/v1/silos/team", { token: TOKEN })
        expect(store.links("p_ada").map((link) => link.subject)).toEqual(["ada"])
        expect(store.links("p_bob")).toEqual([])
    })
})
