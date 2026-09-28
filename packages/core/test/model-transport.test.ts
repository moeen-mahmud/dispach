/**
 * `model.<role>.api` selects a transport: the built-in `chat-completions`, one the host supplies, or
 * one a plugin registers with `defineModelTransport`. Read at the far end — the provider that
 * actually answered a turn — because a transport chosen and never called is the failure a seam test
 * that stops at resolution cannot see.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { BRAND } from "../src/brand.ts"
import { loadManifest } from "../src/manifest/load.ts"
import type { ChatChunk, ChatRequest, ModelProvider } from "../src/model/provider.ts"
import type { ModelTransport, ModelTransportContext } from "../src/model/transport.ts"
import type { Plugin } from "../src/plugins/plugin.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

function manifest(model: string, extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "transport-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}\nid: carrier\nmodel:\n  main:\n${model}\n${extra}`,
    )
    return join(dir, "agent.yaml")
}

/** A transport that answers every request with a fixed reply and records what it was built from. */
function recording(reply: string) {
    const built: ModelTransportContext[] = []
    const requests: ChatRequest[] = []
    const transport: ModelTransport = {
        optionsSchema: z.object({ region: z.string().min(1) }).strict(),
        create(context): ModelProvider {
            built.push(context)
            return {
                id: context.id,
                async *chat(request): AsyncIterable<ChatChunk> {
                    requests.push(request)
                    yield { type: "text", delta: reply }
                    yield { type: "finish", reason: "stop" }
                },
            }
        },
    }
    return { transport, built, requests }
}

const FAKE =
    "    id: some.model-v1:0\n    api: fake-converse\n    options:\n      region: eu-west-1"

describe("model transports", () => {
    test("a transport the host supplies answers the turn, with its options parsed", async () => {
        const fake = recording("from the fake transport")
        const runtime = await Runtime.create({
            agents: [manifest(FAKE)],
            store: ":memory:",
            env: {},
            modelTransports: { "fake-converse": fake.transport },
        })
        const reply = await runtime.agent("carrier").send("hi")
        await runtime.stop()
        expect(reply.text).toBe("from the fake transport")
        expect(fake.built[0]?.id).toBe("fake-converse:main")
        expect(fake.built[0]?.options).toEqual({ region: "eu-west-1" })
        expect(fake.requests[0]?.model).toBe("some.model-v1:0")
    })

    test("a plugin registers one with defineModelTransport", async () => {
        const fake = recording("from the plugin")
        const plugin: Plugin = {
            name: "fixture-transport",
            version: "1.0.0",
            dispachApi: "*",
            setup(ctx) {
                ctx.defineModelTransport("fake-converse", fake.transport)
            },
        }
        const runtime = await Runtime.create({
            agents: [manifest(FAKE, "plugins:\n  - fixture-transport\n")],
            store: ":memory:",
            env: {},
            builtInPlugins: { "fixture-transport": plugin },
        })
        const reply = await runtime.agent("carrier").send("hi")
        await runtime.stop()
        expect(reply.text).toBe("from the plugin")
    })

    test("an unknown api refuses the load, naming what is registered", async () => {
        let code = ""
        let message = ""
        try {
            await Runtime.create({ agents: [manifest(FAKE)], store: ":memory:", env: {} })
        } catch (error) {
            code = (error as { code?: string }).code ?? ""
            message = (error as Error).message
        }
        expect(code).toBe("model_transport_unknown")
        expect(message).toContain("chat-completions")
    })

    test("options the transport's schema refuses fail the load, naming the field", async () => {
        const fake = recording("unused")
        let field = ""
        try {
            await Runtime.create({
                agents: [
                    manifest("    id: m\n    api: fake-converse\n    options:\n      zone: x"),
                ],
                store: ":memory:",
                env: {},
                modelTransports: { "fake-converse": fake.transport },
            })
        } catch (error) {
            field = (error as { field?: string }).field ?? ""
        }
        expect(field).toBe("model.main.options")
        expect(fake.built).toEqual([])
    })

    test("baseUrl is still required for chat-completions, and only for it", () => {
        const missing = manifest("    id: gpt-4o-mini\n    apiKeyEnv: MODEL_API_KEY")
        expect(() => loadManifest(missing, { env: { MODEL_API_KEY: "k" } })).toThrow(/baseUrl/)
        const elsewhere = manifest(FAKE)
        expect(() => loadManifest(elsewhere, { env: {} })).not.toThrow()
    })
})
