/**
 * The control plane against fake silos: lifecycle, the proxy's credential rules, and the sweep.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AddressInfo } from "node:net"
import { gunzipSync } from "node:zlib"
import { BRAND } from "../src/brand.ts"
import { ControlPlane } from "../src/control.ts"
import { ControlError, resolveSiloEnv } from "../src/placer.ts"
import { createControlServer } from "../src/server.ts"
import { SiloStore } from "../src/store.ts"
import { FakePlacer } from "./fake.ts"

const TOKEN = "operator-token"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup(options: { idleMs?: number; wakeMarginMs?: number } = {}) {
    let clock = Date.parse("2026-09-24T12:00:00.000Z")
    const store = await SiloStore.open(":memory:")
    const placer = new FakePlacer()
    const control = new ControlPlane({
        store,
        placer,
        idleMs: options.idleMs ?? 60_000,
        wakeMarginMs: options.wakeMarginMs ?? 30_000,
        now: () => clock,
        readyTimeoutMs: 300,
        log: () => {},
    })
    const server = createControlServer({ control, token: TOKEN })
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
    const mint = async (subject: string) =>
        (
            (await (
                await call("POST", `/v1/silos/${subject}/keys`, {
                    token: TOKEN,
                    body: { label: "t" },
                })
            ).json()) as { secret: string }
        ).secret
    return {
        base,
        store,
        placer,
        control,
        call,
        mint,
        advance: (ms: number) => {
            clock += ms
        },
        fake: (subject: string) => {
            const silo = placer.silos.get(`silo-${subject}`)
            if (silo === undefined) throw new Error(`no silo ${subject}`)
            return silo
        },
    }
}

describe("silo lifecycle", () => {
    test("create is idempotent per subject, and nothing returned carries the silo's token", async () => {
        const { call, store } = await setup()
        const first = await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "user_1" } })
        expect(first.status).toBe(201)
        const again = await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "user_1" } })
        expect(again.status).toBe(200)
        expect(((await again.json()) as { created: boolean }).created).toBe(false)

        const token = store.get("user_1")?.token ?? "missing"
        const listing = await (await call("GET", "/v1/silos", { token: TOKEN })).text()
        expect(listing).toContain("user_1")
        expect(listing).not.toContain(token)
    })

    test("a subject that cannot be a container name is refused with a hint", async () => {
        const { call } = await setup()
        const response = await call("POST", "/v1/silos", {
            token: TOKEN,
            body: { subject: "../etc; rm -rf /" },
        })
        expect(response.status).toBe(400)
        const error = ((await response.json()) as { error: { code: string; hint: string } }).error
        expect(error.code).toBe("subject_invalid")
        expect(error.hint.length).toBeGreaterThan(0)
    })

    test("a silo that never becomes ready is removed, not left half-created", async () => {
        const { call, placer, store, control } = await setup()
        placer.neverReady = true
        const response = await call("POST", "/v1/silos", {
            token: TOKEN,
            body: { subject: "slow" },
        })
        expect(response.status).toBe(502)
        expect(store.get("slow")).toBeUndefined()
        expect(placer.calls).toContain("remove silo-slow")
        expect(control.store.list()).toEqual([])
    })

    test("delete removes the silo and its row", async () => {
        const { call, placer, store } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "gone" } })
        expect((await call("DELETE", "/v1/silos/gone", { token: TOKEN })).status).toBe(200)
        expect(store.get("gone")).toBeUndefined()
        expect(placer.calls).toContain("remove silo-gone")
    })

    test("operator routes refuse a missing token and a silo key alike", async () => {
        const { call, mint } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")
        expect((await call("GET", "/v1/silos")).status).toBe(401)
        expect((await call("GET", "/v1/silos", { token: key })).status).toBe(401)
    })
})

describe("the proxy", () => {
    test("forwards the caller's credential and never the silo's token", async () => {
        const { call, mint, fake, store } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")
        const response = await call("GET", "/silos/a/v1/agents?x=1", { token: key })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ path: "/v1/agents?x=1", method: "GET" })
        const seen = fake("a").seen.find((entry) => entry.path === "/v1/agents?x=1")
        expect(seen?.auth).toBe(key)
        expect(seen?.auth).not.toBe(store.get("a")?.token)
    })

    test("a key from one silo reaches nothing in another", async () => {
        const { call, mint } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "b" } })
        const keyA = await mint("a")
        expect((await call("GET", "/silos/a/v1/agents", { token: keyA })).status).toBe(200)
        expect((await call("GET", "/silos/b/v1/agents", { token: keyA })).status).toBe(401)
        // Nor does the operator's own token: the proxy adds nothing.
        expect((await call("GET", "/silos/a/v1/agents", { token: TOKEN })).status).toBe(401)
    })

    test("an unknown subject answers exactly as a bad key does, and no credential wakes nothing", async () => {
        const { call, control, placer, store } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const bad = await call("GET", "/silos/a/v1/agents", { token: "wrong" })
        const unknown = await call("GET", "/silos/nobody/v1/agents", { token: "wrong" })
        expect(unknown.status).toBe(bad.status)
        expect(await unknown.json()).toEqual(await bad.json())

        await control.pause("a")
        const before = placer.calls.length
        expect((await call("GET", "/silos/a/v1/agents")).status).toBe(401)
        expect(placer.calls.length).toBe(before)
        expect(store.get("a")?.status).toBe("paused")
    })

    test("a message to a paused silo wakes it first", async () => {
        const { call, mint, control, store, placer } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")
        await control.pause("a")
        const response = await call("GET", "/silos/a/v1/agents", { token: key })
        // The fake answers 503 while paused, so a 200 proves the wake came before the forward.
        expect(response.status).toBe(200)
        expect(store.get("a")?.status).toBe("running")
        expect(placer.calls.filter((c) => c === "wake silo-a").length).toBe(1)
    })

    test("a burst of requests to a paused silo shares one wake", async () => {
        const { call, mint, control, placer } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")
        await control.pause("a")
        const answers = await Promise.all(
            Array.from({ length: 5 }, () => call("GET", "/silos/a/v1/agents", { token: key })),
        )
        expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
        expect(placer.calls.filter((c) => c === "wake silo-a").length).toBe(1)
    })
})

describe("the sweep", () => {
    test("an idle silo is paused after the quiet period, with the wake time it reported", async () => {
        const { call, control, store, advance, fake } = await setup({ idleMs: 60_000 })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        fake("a").nextWakeAt = "2026-09-24T13:00:00.000Z"

        advance(30_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("running")

        advance(31_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("paused")
        expect(store.get("a")?.nextWakeAt).toBe("2026-09-24T13:00:00.000Z")
    })

    test("a busy silo is not paused, and neither is one holding an open stream", async () => {
        const { call, mint, control, store, advance, fake } = await setup({ idleMs: 1_000 })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")

        fake("a").idle = false
        advance(5_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("running")

        // Idle as far as the silo knows, but a client is reading a stream through the proxy.
        fake("a").idle = true
        const stream = await call("GET", "/silos/a/v1/stream", { token: key })
        const reader = stream.body?.getReader()
        await reader?.read()
        advance(5_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("running")

        fake("a").release?.()
        while (!(await reader?.read())?.done) {
            // drain
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        advance(5_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("paused")
    })

    test("a paused silo is woken the margin before its next schedule", async () => {
        const { call, control, store, advance, fake } = await setup({
            idleMs: 1_000,
            wakeMarginMs: 30_000,
        })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        // Due ten minutes after the fake clock's start.
        fake("a").nextWakeAt = "2026-09-24T12:10:00.000Z"
        advance(2_000)
        await control.sweep()
        expect(store.get("a")?.status).toBe("paused")

        advance(9 * 60_000) // 12:09:02 — still more than 30 s out
        await control.sweep()
        expect(store.get("a")?.status).toBe("paused")

        advance(30_000) // 12:09:32 — inside the margin
        await control.sweep()
        expect(store.get("a")?.status).toBe("running")

        // And it stays awake for the quiet period rather than being re-paused on the next pass.
        await control.sweep()
        expect(store.get("a")?.status).toBe("running")
    })

    test("usage lists every silo, waking a paused one to answer", async () => {
        const { call, control, store } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "b" } })
        await control.pause("b")
        const body = (await (
            await call("GET", "/v1/usage?by=model&evil=1", { token: TOKEN })
        ).json()) as {
            silos: { subject: string; query: string }[]
            failed: unknown[]
        }
        expect(body.silos.map((s) => s.subject)).toEqual(["a", "b"])
        // Only the documented parameters are forwarded.
        expect(body.silos[0]?.query).toBe("/v1/usage?by=model")
        expect(body.failed).toEqual([])
        expect(store.get("b")?.status).toBe("running")
    })
})

describe("operator settings reach silos by name", () => {
    test("names resolve from the environment; a bad name, the token and an unset one are refused", () => {
        const env = { A_B: "1", DISPACH_WEBHOOK_ALLOW: "10.0.0.0/8" }
        expect(resolveSiloEnv(" A_B , DISPACH_WEBHOOK_ALLOW,", env, "S")).toEqual(env)
        expect(resolveSiloEnv(undefined, env, "S")).toEqual({})
        const code = (list: string) => {
            try {
                resolveSiloEnv(list, env, "S")
                return "accepted"
            } catch (error) {
                return error instanceof ControlError ? error.code : "other"
            }
        }
        expect(code("A-B")).toBe("silo_env_invalid")
        expect(code(BRAND.runtime.tokenEnv)).toBe("silo_env_invalid")
        expect(code("MISSING")).toBe("silo_env_unset")
    })
})

describe("recreate, backup and restore", () => {
    test("recreate moves the silo to a new container; its keys and data survive", async () => {
        const { call, mint, store, fake } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        const key = await mint("a")
        const before = store.get("a")?.baseUrl
        const response = await call("POST", "/v1/silos/a/recreate", { token: TOKEN })
        expect(response.status).toBe(200)
        expect(store.get("a")?.baseUrl).not.toBe(before)
        expect((await call("GET", "/silos/a/v1/agents", { token: key })).status).toBe(200)
        expect(fake("a").data).toBe("data of a")
    })

    test("a busy silo is neither recreated nor backed up", async () => {
        const { call, fake, placer, store } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        fake("a").idle = false
        for (const [method, path] of [
            ["POST", "/v1/silos/a/recreate"],
            ["GET", "/v1/silos/a/backup"],
        ] as const) {
            const response = await call(method, path, { token: TOKEN })
            expect(response.status).toBe(409)
            expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
                "silo_busy",
            )
        }
        expect(
            placer.calls.filter((c) => c.startsWith("recreate") || c.startsWith("export")),
        ).toEqual([])
        expect(store.get("a")?.status).toBe("running")
    })

    test("a backup is taken from a paused silo, and restores into another", async () => {
        const { call, placer, store, fake, mint, base } = await setup()
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "a" } })
        await call("POST", "/v1/silos", { token: TOKEN, body: { subject: "b" } })
        const backup = await call("GET", "/v1/silos/a/backup", { token: TOKEN })
        expect(backup.status).toBe(200)
        expect(backup.headers.get("content-type")).toBe("application/gzip")
        const archive = Buffer.from(await backup.arrayBuffer())
        expect(gunzipSync(archive).toString()).toBe("data of a")
        // Paused before the copy, and left paused.
        expect(placer.calls).toContain("export silo-a paused=true")
        expect(store.get("a")?.status).toBe("paused")

        const restored = await fetch(`${base}/v1/silos/b/backup`, {
            method: "PUT",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip" },
            body: archive,
        })
        expect(restored.status).toBe(200)
        expect(fake("b").data).toBe("data of a")
        expect(store.get("b")?.status).toBe("running")
        const key = await mint("b")
        expect((await call("GET", "/silos/b/v1/agents", { token: key })).status).toBe(200)
    })
})
