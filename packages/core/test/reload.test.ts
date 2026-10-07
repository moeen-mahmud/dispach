/**
 * A reload applies at the agent's next turn boundary instead of refusing a running turn (doc 16 R4).
 *
 * Two models, told apart by the transport that answers — `old` and `new` — so every assertion is
 * about which configuration a turn actually ran on, never about which instance the runtime holds.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AnyEvent, BRAND, type ChatChunk, type ModelTransport, Runtime } from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

/** A transport whose replies are its own name, optionally held until released. */
function model(name: string) {
    let gate: Promise<void> = Promise.resolve()
    let open = () => {}
    const transport: ModelTransport = {
        create: (context) => ({
            id: context.id,
            async *chat(): AsyncIterable<ChatChunk> {
                await gate
                yield { type: "text", delta: name }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
    return {
        transport,
        hold: () => {
            gate = new Promise<void>((resolve) => {
                open = resolve
            })
        },
        release: () => open(),
    }
}

function manifest(dir: string, api: string, extra = "", id = "subject"): string {
    const path = join(dir, "agent.yaml")
    writeFileSync(
        path,
        `apiVersion: ${BRAND.apiVersion}\nid: ${id}\nmodel:\n  main:\n    id: m\n    api: ${api}\n${extra}`,
    )
    return path
}

async function boot(options: { hold?: number; second?: boolean } = {}) {
    const old = model("old")
    const next = model("new")
    const dir = mkdtempSync(join(tmpdir(), "reload-a"))
    const limits = options.hold === undefined ? "" : `limits:\n  reloadHoldMs: ${options.hold}\n`
    const path = manifest(dir, "old", limits)
    const other =
        options.second === true
            ? manifest(mkdtempSync(join(tmpdir(), "reload-b")), "old", "", "other")
            : undefined
    const runtime = await Runtime.create({
        agents: other === undefined ? [path] : [path, other],
        env: {},
        store: ":memory:",
        modelTransports: { old: old.transport, new: next.transport },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    const reloaded = () =>
        new Promise<AnyEvent>((resolve) => {
            const found = events.find((event) => event.type === "agent.reloaded")
            if (found !== undefined) return resolve(found)
            const off = runtime.bus.on("*", (event) => {
                if (event.type !== "agent.reloaded") return
                off()
                resolve(event)
            })
        })
    return { runtime, old, next, dir, path, limits, reloaded, events }
}

async function running(agent: { inFlight: number }): Promise<void> {
    for (let i = 0; i < 200 && agent.inFlight === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe("a reload while a turn is running", () => {
    test("the running turn finishes on the old model; the next one uses the new; no refusal", async () => {
        const { runtime, old, path, limits, reloaded } = await boot()
        const before = runtime.agent("subject")
        old.hold()
        const first = before.send("one")
        await running(before)

        manifest(path.replace(/\/agent\.yaml$/, ""), "new", limits)
        const outcome = await runtime.reload("subject")
        expect(outcome).toEqual({ status: "pending", running: 1, holdAfterMs: 30_000 })

        old.release()
        expect((await first).text).toBe("old")
        const event = await reloaded()
        const data = event.data as {
            ok: boolean
            adopted: string[]
            held: number
            disposed: boolean
        }
        expect([data.ok, data.adopted, data.held, data.disposed]).toEqual([
            true,
            ["subject"],
            0,
            true,
        ])
        expect((await runtime.agent("subject").send("two")).text).toBe("new")
        await runtime.stop()
    })

    test("past the hold bound, a new turn waits and runs on the new model — even sent to the old instance", async () => {
        const { runtime, old, path, reloaded } = await boot({ hold: 0 })
        const before = runtime.agent("subject")
        old.hold()
        const first = before.send("one")
        await running(before)

        manifest(path.replace(/\/agent\.yaml$/, ""), "new", "limits:\n  reloadHoldMs: 0\n")
        await runtime.reload("subject")
        // Held, not refused and not run on the old model: a channel queue or an HTTP handler holds
        // exactly this kind of stale reference.
        const second = before.send("two")
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(before.inFlight).toBe(1)

        old.release()
        expect((await first).text).toBe("old")
        expect((await second).text).toBe("new")
        const data = (await reloaded()).data as { ok: boolean; held: number }
        expect([data.ok, data.held]).toEqual([true, 1])
        await runtime.stop()
    })

    test("a manifest broken on disk is refused at once, and the agent goes on serving", async () => {
        const { runtime, old, path, events } = await boot()
        const before = runtime.agent("subject")
        old.hold()
        const first = before.send("one")
        await running(before)

        writeFileSync(path, "apiVersion: nonsense\n")
        await expect(runtime.reload("subject")).rejects.toThrow()
        old.release()
        expect((await first).text).toBe("old")
        expect(runtime.agent("subject")).toBe(before)
        expect((await before.send("two")).text).toBe("old")

        // Idle, the same: `replace` loads the new manifest before disposing the old instance.
        await expect(runtime.reload("subject")).rejects.toThrow()
        expect(runtime.agent("subject")).toBe(before)
        // Both refusals reach the stream, and so a webhook (pilot.14): before, they only threw.
        const refusals = events.filter(
            (event) =>
                event.type === "agent.reloaded" && (event.data as { ok: boolean }).ok === false,
        )
        expect(refusals.length).toBe(2)
        expect(
            (refusals[0]?.data as { error?: { code: string } } | undefined)?.error?.code,
        ).toBeDefined()
        await runtime.stop()
    })

    test("another agent in the silo keeps its instance", async () => {
        const { runtime, old, path, limits, reloaded } = await boot({ second: true })
        const other = runtime.agent("other")
        old.hold()
        const first = runtime.agent("subject").send("one")
        await running(runtime.agent("subject"))
        manifest(path.replace(/\/agent\.yaml$/, ""), "new", limits)
        await runtime.reload("subject")
        old.release()
        await first
        await reloaded()
        expect(runtime.agent("other")).toBe(other)
        await runtime.stop()
    })

    test("stopping the runtime under a pending reload fails a held turn instead of hanging it", async () => {
        const { runtime, old, path } = await boot({ hold: 0 })
        const before = runtime.agent("subject")
        old.hold()
        void before.send("one").catch(() => {})
        await running(before)
        manifest(path.replace(/\/agent\.yaml$/, ""), "new", "limits:\n  reloadHoldMs: 0\n")
        await runtime.reload("subject")
        const held = before.send("two")
        await runtime.stop()
        const failure = await held.then(
            () => undefined,
            (error: unknown) => (error as { code?: string }).code,
        )
        expect(failure).toBe("reload_abandoned")
        old.release()
    })
})
