/**
 * The Phase 26 acceptance, against the real runtime image in real Docker.
 *
 *   CONTROL_E2E=1 bun test test/e2e.test.ts --timeout 300000
 *
 * Skipped without `CONTROL_E2E`, with the reason in the test name, because it starts containers.
 * A model endpoint runs in this process; silos reach it at `host.docker.internal` (Docker Desktop
 * resolves that by default; on Linux, run the daemon with `--add-host` or set `E2E_MODEL_HOST`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { BRAND } from "../src/brand.ts"
import { ControlPlane } from "../src/control.ts"
import { DockerPlacer } from "../src/placer.ts"
import { createControlServer, UNAUTHORIZED } from "../src/server.ts"
import { SiloStore } from "../src/store.ts"

const ENABLED = process.env.CONTROL_E2E === "1"
const TOKEN = "e2e-operator-token"
const SUBJECTS = [`e2e-a-${process.pid}`, `e2e-b-${process.pid}`, `e2e-c-${process.pid}`] as const
const [A, B, C] = SUBJECTS

let model: Server
let control: ControlPlane
let server: Server
let store: SiloStore
let base = ""
let templates = ""
const keys: Record<string, string> = {}
const timings: Record<string, number[]> = {}

/** Streams a short reply the way an OpenAI-compatible endpoint does, one word per frame. */
function modelServer(): Server {
    return createServer((req, res) => {
        req.resume()
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" })
            for (const word of ["Hello ", "from ", "the ", "mock."]) {
                res.write(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`,
                )
            }
            res.end("data: [DONE]\n\n")
        })
    })
}

const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
            ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })

/** Send a message through the proxy; resolve with ms to the first token and to the end. */
async function turn(
    subject: string,
): Promise<{ firstTokenMs: number; endMs: number; text: string }> {
    const started = performance.now()
    const response = await call(`/silos/${subject}/v1/agents/helper/messages`, {
        token: keys[subject] ?? "",
        body: { text: "hello", stream: true, chunks: true, sessionKey: "api:e2e" },
    })
    expect(response.status).toBe(202)
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error("no body")
    const decoder = new TextDecoder()
    let buffer = ""
    let firstTokenMs = -1
    let text = ""
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at = buffer.indexOf("\n\n")
        while (at !== -1) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            at = buffer.indexOf("\n\n")
            const type = /^event: (.+)$/m.exec(frame)?.[1]
            const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "{}"
            if (type === "model.chunk" && firstTokenMs < 0)
                firstTokenMs = performance.now() - started
            if (type === "model.chunk") {
                text += (JSON.parse(data) as { data: { delta: string } }).data.delta
            }
            if (type === "turn.end") {
                await reader.cancel()
                return { firstTokenMs, endMs: performance.now() - started, text }
            }
        }
    }
    throw new Error("stream ended without turn.end")
}

const dockerState = (subject: string) =>
    execFileSync("docker", [
        "inspect",
        "--format",
        "{{.State.Status}}",
        `${BRAND.siloPrefix}${subject}`,
    ])
        .toString()
        .trim()

const record = (name: string, ms: number) => {
    timings[name] = [...(timings[name] ?? []), Math.round(ms)]
}

describe.skipIf(!ENABLED)("e2e against the real runtime (CONTROL_E2E=1)", () => {
    beforeAll(async () => {
        model = modelServer()
        await new Promise<void>((resolve) => model.listen(0, "0.0.0.0", resolve))
        const modelHost = process.env.E2E_MODEL_HOST ?? "host.docker.internal"
        const modelUrl = `http://${modelHost}:${(model.address() as AddressInfo).port}/v1`

        templates = mkdtempSync(join(tmpdir(), "control-templates-"))
        const dir = join(templates, "e2e")
        mkdirSync(dir)
        writeFileSync(
            join(dir, "template.yaml"),
            "description: e2e\nvars:\n  apiKey: { secret: MODEL_API_KEY }\n",
        )
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.runtime.apiVersion}\nid: {{agent.id}}\nname: {{agent.name}}\nmodel:\n  main:\n    id: mock\n    baseUrl: ${modelUrl}\n    apiKeyEnv: MODEL_API_KEY\n`,
        )

        store = await SiloStore.open(":memory:")
        control = new ControlPlane({
            store,
            placer: new DockerPlacer({
                templatesDir: templates,
                // The first operator setting a silo needs: its receiver is private, and the runtime
                // refuses private webhook targets unless the operator names them.
                siloEnv: { [BRAND.runtime.webhookAllowEnv]: modelHost },
            }),
            idleMs: 1_000,
            log: () => {},
        })
        server = createControlServer({ control, token: TOKEN })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    afterAll(async () => {
        for (const subject of SUBJECTS) await control.remove(subject).catch(() => {})
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        model.closeAllConnections()
        await new Promise((resolve) => model.close(resolve))
        rmSync(templates, { recursive: true, force: true })
        store.close()
        process.stdout.write(`\nE2E TIMINGS ${JSON.stringify(timings)}\n`)
    })

    test("two silos, each with an agent made from a template through the proxy", async () => {
        // A and B only: C is created empty later, so that what the restore puts in it is provable.
        for (const subject of [A, B]) {
            const started = performance.now()
            const created = await call("/v1/silos", { token: TOKEN, body: { subject } })
            expect(created.status).toBe(201)
            record("createToReadyMs", performance.now() - started)
            const minted = await call(`/v1/silos/${subject}/keys`, {
                token: TOKEN,
                body: { label: "embedder" },
            })
            expect(minted.status).toBe(201)
            keys[subject] = ((await minted.json()) as { secret: string }).secret

            const agent = await call(`/silos/${subject}/v1/agents`, {
                token: keys[subject],
                body: { template: "e2e", name: "helper", vars: { apiKey: "not-a-real-key" } },
            })
            expect(agent.status).toBe(201)
        }
    })

    test("a silo's credential reaches nothing in another silo", async () => {
        const keyA = keys[A] ?? ""
        const keyB = keys[B] ?? ""
        const probes: [string, string, unknown?][] = [
            [`/silos/${B}/v1/agents`, keyA],
            [`/silos/${B}/v1/agents/helper`, keyA],
            [`/silos/${B}/v1/usage`, keyA],
            [`/silos/${B}/v1/events`, keyA],
            [`/silos/${B}/v1/agents/helper/messages`, keyA, { text: "hi" }],
            [`/silos/${A}/v1/agents`, keyB],
            [`/silos/${A}/v1/keys`, keyB],
            // The operator's own token opens no silo: the proxy forwards credentials, it adds none.
            [`/silos/${A}/v1/agents`, TOKEN],
        ]
        for (const [path, token, body] of probes) {
            const response = await call(path, { token, ...(body === undefined ? {} : { body }) })
            expect(`${path} ${response.status}`).toBe(`${path} 401`)
            expect(await response.json()).toEqual(UNAUTHORIZED)
        }
        // And an unknown subject is indistinguishable from all of the above.
        const unknown = await call("/silos/nobody-here/v1/agents", { token: keyA })
        expect(unknown.status).toBe(401)
        expect(await unknown.json()).toEqual(UNAUTHORIZED)
        // Its own key still works in its own silo.
        expect((await call(`/silos/${A}/v1/agents`, { token: keyA })).status).toBe(200)
    })

    test("a real turn streams through the proxy", async () => {
        for (let i = 0; i < 3; i += 1) {
            const warm = await turn(A)
            expect(warm.text).toBe("Hello from the mock.")
            record("warmFirstTokenMs", warm.firstTokenMs)
        }
    })

    test("an idle silo suspends, and a message wakes it", async () => {
        for (let i = 0; i < 3; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_500))
            await control.sweep()
            expect(store.get(A)?.status).toBe("paused")
            expect(dockerState(A)).toBe("paused")

            const woken = await turn(A)
            expect(woken.text).toBe("Hello from the mock.")
            expect(dockerState(A)).toBe("running")
            record("wakeFirstTokenMs", woken.firstTokenMs)
        }
    })

    test("an operator setting reaches the silo: a private webhook target is now accepted", async () => {
        const hook = await call(`/silos/${A}/v1/webhooks`, {
            token: keys[A] ?? "",
            body: {
                url: `http://${process.env.E2E_MODEL_HOST ?? "host.docker.internal"}:9/hook`,
                types: ["turn.end"],
            },
        })
        expect(hook.status).toBe(201)
        // Removed again: a subscription to a dead port keeps a retry owed, which keeps the silo
        // (correctly) busy for everything below that waits on idle.
        const { subscriptionId } = (await hook.json()) as { subscriptionId: string }
        await call(`/silos/${A}/v1/webhooks/${subscriptionId}`, {
            method: "DELETE",
            token: keys[A] ?? "",
        })
        // By name through the environment, never on the command line.
        const inspected = execFileSync("docker", [
            "inspect",
            "--format",
            "{{json .Config.Env}}",
            `${BRAND.siloPrefix}${A}`,
        ]).toString()
        expect(inspected).toContain(BRAND.runtime.webhookAllowEnv)
    })

    test("recreate replaces the container and keeps the agents and keys", async () => {
        const before = execFileSync("docker", [
            "inspect",
            "--format",
            "{{.Id}}",
            `${BRAND.siloPrefix}${A}`,
        ]).toString()
        expect(
            (await call(`/v1/silos/${A}/recreate`, { method: "POST", token: TOKEN })).status,
        ).toBe(200)
        const after = execFileSync("docker", [
            "inspect",
            "--format",
            "{{.Id}}",
            `${BRAND.siloPrefix}${A}`,
        ]).toString()
        expect(after).not.toBe(before)
        const agents = await call(`/silos/${A}/v1/agents`, { token: keys[A] ?? "" })
        expect(agents.status).toBe(200)
        expect(await agents.text()).toContain("helper")
        expect((await turn(A)).text).toBe("Hello from the mock.")
    })

    test("a backup of one silo restores into another, agents, history and keys included", async () => {
        // The turn just before may still owe a delivery; a backup waits for idle rather than
        // freezing a silo mid-write, so ask until it is.
        let backup = await call(`/v1/silos/${A}/backup`, { token: TOKEN })
        for (let i = 0; i < 40 && backup.status === 409; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            backup = await call(`/v1/silos/${A}/backup`, { token: TOKEN })
        }
        const started = performance.now()
        expect(backup.status).toBe(200)
        const archive = Buffer.from(await backup.arrayBuffer())
        record("backupMs", performance.now() - started)
        record("backupKb", archive.length / 1024)
        // The operator's templates are mounted into every silo and are not the user's data.
        const listing = gunzipSync(archive).toString("latin1")
        expect(listing).toContain("store.db")
        expect(listing).not.toContain("template.yaml")
        expect(store.get(A)?.status).toBe("paused")

        const createdC = await call("/v1/silos", { token: TOKEN, body: { subject: C } })
        expect(createdC.status).toBe(201)
        // Empty before the restore — the restore, not the setup, is what puts the agent there.
        const minted = (await (
            await call(`/v1/silos/${C}/keys`, { token: TOKEN, body: { label: "c" } })
        ).json()) as { secret: string }
        const empty = await call(`/silos/${C}/v1/agents`, { token: minted.secret })
        expect(await empty.text()).not.toContain("helper")
        const restoreStarted = performance.now()
        const restored = await fetch(`${base}/v1/silos/${C}/backup`, {
            method: "PUT",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip" },
            body: archive,
        })
        expect(`${restored.status} ${restored.status === 200 ? "" : await restored.text()}`).toBe(
            "200 ",
        )
        record("restoreMs", performance.now() - restoreStarted)

        // The key minted in A lives in A's store, so the restored copy honours it.
        const agents = await call(`/silos/${C}/v1/agents`, { token: keys[A] ?? "" })
        expect(agents.status).toBe(200)
        expect(await agents.text()).toContain("helper")
        const turns = (await (
            await call(`/silos/${C}/v1/agents/helper/turns`, { token: keys[A] ?? "" })
        ).json()) as { turns: unknown[] }
        expect(turns.turns.length).toBeGreaterThan(0)
        // Owned by the runtime's user, or the next write would fail.
        keys[C] = keys[A] ?? ""
        expect((await turn(C)).text).toBe("Hello from the mock.")
    })

    test("delete removes the container and its volume", async () => {
        await control.remove(B)
        const volumes = execFileSync("docker", ["volume", "ls", "--format", "{{.Name}}"]).toString()
        expect(volumes).not.toContain(`${BRAND.siloPrefix}${B}`)
        expect(store.get(B)).toBeUndefined()
    })
})
