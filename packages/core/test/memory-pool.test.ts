/**
 * `agents:<P>`, the memory one person's agents share (decisions 15.8, 15.13): a save lands in the
 * agent's own file *and* the pool, a sibling recalls it, and nobody reads it for somebody else.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChatChunk,
    type ChatMessage,
    isHarnessError,
    type ModelTransport,
    Runtime,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

const NOTE = "Moeen's dentist is Dr Rahman on Lake Road"

/** Saves `NOTE` when asked to remember, otherwise answers; records every request. */
function model(seen: ChatMessage[][]): ModelTransport {
    const wrote = new Set<string>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push([...request.messages])
                const input = String(request.messages.findLast((m) => m.role === "user")?.content)
                if (input.includes("remember") && !wrote.has(input)) {
                    wrote.add(input)
                    yield {
                        type: "tool_call",
                        call: {
                            id: "w1",
                            name: "memory_write",
                            arguments: JSON.stringify({ text: NOTE }),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                yield { type: "text", delta: "ok" }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

function agentDir(root: string, id: string, shared = true): string {
    const dir = join(root, id)
    mkdirSync(join(dir, "workspace"), { recursive: true })
    writeFileSync(
        join(dir, "workspace", "MEMORY.md"),
        "---\ntier: volatile\neditable: replace\nbudget: 2000\n---\n\n# What I know\n",
    )
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: ${id}
model:
  main:
    id: m
    api: ${id}
    capabilities:
      nativeTools: true
context:
  workspace: ./workspace
  volatile:
    - MEMORY.md
memory:
  dir: ./memory
  threshold: 0.05
  shared: ${shared}
tools:
  dialect: native
  pinned: [memory_write]
  policy:
    allow: [memory_write]
standIn:
  enabled: true
  escalateAfterMs: 0
`,
    )
    return join(dir, "agent.yaml")
}

async function owned(options: { readonly secondShares?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "pool-"))
    const seen = { milo: [] as ChatMessage[][], ivy: [] as ChatMessage[][] }
    const runtime = await Runtime.create({
        agents: [agentDir(root, "milo"), agentDir(root, "ivy", options.secondShares ?? true)],
        env: {},
        store: ":memory:",
        modelTransports: { milo: model(seen.milo), ivy: model(seen.ivy) },
    })
    const hub = runtime.conversations
    await hub.registerParticipant({ id: "me:k7m2xp", name: "Moeen", role: "admin" })
    await hub.registerParticipant({ id: "user:root", name: "Root", role: "admin" })
    await hub.assign({ agentId: "milo", participantId: "me:k7m2xp" })
    await hub.assign({ agentId: "ivy", participantId: "me:k7m2xp" })
    const asOwner = { participant: { id: "me:k7m2xp", via: "api" as const } }
    const last = (id: keyof typeof seen) => JSON.stringify(seen[id].at(-1) ?? [])
    return { runtime, hub, root, seen, last, asOwner }
}

describe("the owner's shared memory pool", () => {
    test("a save stays in the agent's own file and reaches its sibling", async () => {
        const { runtime, root, last, asOwner } = await owned()
        await runtime.agent("milo").send("please remember my dentist", asOwner)
        // The original is where it always was: in context on every one of milo's turns.
        expect(readFileSync(join(root, "milo", "workspace", "MEMORY.md"), "utf8")).toContain(NOTE)
        const pool = await runtime.store.conversations.notes("agents:me:k7m2xp")
        expect(pool.map((note) => [note.text, note.writtenBy])).toEqual([[NOTE, "agent:milo"]])

        await runtime.agent("ivy").send("who is my dentist on Lake Road?", asOwner)
        expect(last("ivy")).toContain("Dr Rahman")
        await runtime.stop()
    })

    test("the writer is not shown its own copy a second time", async () => {
        const { runtime, last, asOwner } = await owned()
        await runtime.agent("milo").send("please remember my dentist", asOwner)
        // Another conversation, so the save's own tool call is not in the history being counted.
        await runtime.agent("milo").send("who is my dentist on Lake Road?", {
            ...asOwner,
            sessionKey: "api:later",
        })
        // Once, from MEMORY.md; never again from the pool.
        expect(last("milo").split("Dr Rahman").length - 1).toBe(1)
        await runtime.stop()
    })

    test("a stand-in reads none of it: it is private memory, shared only among the owner's agents", async () => {
        const { runtime, last, asOwner } = await owned()
        await runtime.agent("milo").send("please remember my dentist", asOwner)
        await runtime.agent("ivy").send("who is Moeen's dentist on Lake Road?", {
            participant: { id: "user:bob", via: "api", onBehalfOf: "me:k7m2xp" },
        })
        expect(last("ivy")).not.toContain("Dr Rahman")
        await runtime.stop()
    })

    test("memory.shared: false opts out both ways", async () => {
        const { runtime, last, asOwner } = await owned({ secondShares: false })
        await runtime.agent("milo").send("please remember my dentist", asOwner)
        await runtime.agent("ivy").send("who is my dentist on Lake Road?", asOwner)
        expect(last("ivy")).not.toContain("Dr Rahman")
        await runtime.agent("ivy").send("please remember my dentist", asOwner)
        const writers = (await runtime.store.conversations.notes("agents:me:k7m2xp")).map(
            (note) => note.writtenBy,
        )
        expect(writers).toEqual(["agent:milo"])
        await runtime.stop()
    })

    test("only the owner, or the operator, reads or writes it through the API; another admin does not", async () => {
        const { runtime, hub } = await owned()
        const code = async (work: () => Promise<unknown>) => {
            try {
                await work()
                return "ok"
            } catch (error) {
                if (isHarnessError(error)) return error.code
                throw error
            }
        }
        expect(await code(() => hub.notes("agents:me:k7m2xp", "user:root"))).toBe(
            "memory_scope_forbidden",
        )
        expect(
            await code(() =>
                hub.addNote({ scope: "agents:me:k7m2xp", text: "x", authorId: "user:root" }),
            ),
        ).toBe("memory_scope_forbidden")
        expect(
            await code(() =>
                hub.addNote({ scope: "agents:me:k7m2xp", text: "x", authorId: "me:k7m2xp" }),
            ),
        ).toBe("ok")
        expect(await code(() => hub.notes("agents:me:k7m2xp"))).toBe("ok")
        await runtime.stop()
    })
})
