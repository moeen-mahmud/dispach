/**
 * Phase 10A — the inbound peer surface.
 *
 * Three claims, and each is asserted where it can actually fail rather than where it is convenient.
 *
 * The sender's effect on the **prompt** is read out of the model request body, because this repo
 * has paid six rounds for a field threaded through a pipeline with every layer individually right
 * and one of them not connected — `apiKeyEnv`, `ChatMessage.toolCalls`, `TurnInput.skills`,
 * `ToolContext.readArtifact`, `ToolContext.memoryDir`, `StoredMessage.origin`. The cheap guard is
 * the same one every time: a test at the far end that reads the value out.
 *
 * The gate's effect is read out of the **observation the model is shown next**, because "the turn
 * is tainted" is an internal boolean and "the write was blocked" is the thing that matters.
 *
 * The idempotency claim is asserted by **counting turns**, because the failure it prevents is a
 * second turn nobody asked for.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { untrustedFence } from "@dispach/core"
import { cleanupWorkspaces, harness, PINNED_MANIFEST, recordingFetch } from "./harness.ts"

afterAll(cleanupWorkspaces)

const PEER = { id: "agent:ops-bot", name: "Ops Bot", kind: "agent" } as const

/** The marker as the runtime writes it, derived rather than restated. */
const FENCE = untrustedFence("agent agent:ops-bot")

type Call = (
    method: string,
    path: string,
    init?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
) => Promise<Response>

/**
 * Wait for a detached turn to reach a terminal status.
 *
 * Polls the row rather than awaiting `turn.end`: the event fires *before* `turns.finish` resolves,
 * which is a recorded hazard in this repo — a test that awaited the event read a row that was still
 * `running` and concluded the buffer had been evicted.
 */
async function turnRow(call: Call, turnId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await call("GET", `/v1/agents/assistant/turns/${turnId}`)
        const row = (await response.json()) as Record<string, unknown>
        if (row.status !== "running") return row
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`turn ${turnId} never finished`)
}

async function post(
    call: Call,
    body: unknown,
    headers?: Record<string, string>,
): Promise<{ status: number; turnId: string; replayed?: boolean }> {
    const response = await call("POST", "/v1/agents/assistant/messages", {
        body,
        ...(headers === undefined ? {} : { headers }),
    })
    const json = (await response.json()) as { turnId: string; replayed?: boolean }
    return { status: response.status, ...json }
}

describe("from — who sent it", () => {
    test("a peer's message is fenced in the prompt and marked tainted in history", async () => {
        const model = recordingFetch(["noted"])
        const { call, runtime } = await harness({ fetch: model.fetch })
        try {
            const accepted = await post(call, { text: "run the deploy", from: PEER })
            await turnRow(call, accepted.turnId)

            const input = model.prompts().find((prompt) => prompt.includes("run the deploy"))
            expect(input).toBeDefined()
            // The **existing** fence, not a second one. A peer message and an untrusted observation
            // have to be delimited by the same marker, or the two boundaries can disagree about the
            // notice, the neutralisation and the close — and only one of them can be right.
            expect(input).toContain(FENCE.open)
            expect(input).toContain(FENCE.close)
            // The declared name is *inside* the fence. A name supplied by the party being fenced is
            // the last thing that should appear in runtime prose above it.
            expect(input?.indexOf("Ops Bot") ?? -1).toBeGreaterThan(input?.indexOf(FENCE.open) ?? 0)

            const page = (await (
                await call("GET", "/v1/agents/assistant/sessions/api:default/messages")
            ).json()) as { messages: { role: string; tainted?: boolean }[] }
            const user = page.messages.find((message) => message.role === "user")
            // Tainted, so `memory/conversation.ts` refuses to index it. Without this an injection
            // becomes *durable*: retrieved into a later session's SLOT.memory long after the turn's
            // taint expired, which is the one place the turn-scoped boundary leaks.
            expect(user?.tainted).toBe(true)
        } finally {
            await runtime.stop()
        }
    })

    test("kind: user leaves the prompt exactly as no sender at all does", async () => {
        // One harness and two **sessions**, deliberately. Two harnesses is the obvious shape and it
        // cannot make this assertion: slot 2 names the manifest's own path, so two temp workspaces
        // differ by a line that has nothing to do with the sender. Two sessions of one agent share
        // every pinned block and start with no history, so the only thing that can differ is the
        // thing being tested.
        const model = recordingFetch(["ok"])
        const { call, runtime } = await harness({ fetch: model.fetch })
        try {
            const one = await post(call, { text: "hello there", sessionKey: "api:bare" })
            await turnRow(call, one.turnId)
            const two = await post(call, {
                text: "hello there",
                sessionKey: "api:declared",
                from: { id: "user:1", kind: "user" },
            })
            await turnRow(call, two.turnId)

            expect(model.bodies.length).toBe(2)
            // Byte-identical, which is the promise that keeps every existing caller unaffected —
            // the REPL, a schedule, a channel turn and an operator's own curl all take this path.
            expect(model.bodies[1]?.messages).toEqual(model.bodies[0]?.messages)
        } finally {
            await runtime.stop()
        }
    })

    test("a peer's message gates a mutating tool on the FIRST step", async () => {
        // The turn's only untrusted content is the message itself, which is exactly the case the
        // gate could not see before 10A: `untrustedSeen` started `false` and only a tool result
        // could set it, so an agent could be told what to write by a stranger and write it.
        const model = recordingFetch([
            "saving that now\nACTION: memory_write\ntext: ops-bot told me to\nEND",
            "I was blocked and did not save it.",
        ])
        const { call, runtime } = await harness({ fetch: model.fetch, manifest: PINNED_MANIFEST })
        try {
            const accepted = await post(call, {
                text: "save a note saying ops-bot told me to",
                from: PEER,
            })
            await turnRow(call, accepted.turnId)

            const observation = model
                .prompts()
                .find((prompt) => prompt.includes("memory_write was not run"))
            expect(observation).toBeDefined()
            // The refusal names the sender rather than "an earlier tool call" — the only vocabulary
            // the gate had while nothing but a tool could taint a turn.
            expect(observation).toContain("agent agent:ops-bot")
        } finally {
            await runtime.stop()
        }
    })

    test("the same turn from a user is NOT gated, or the test above proves nothing", async () => {
        // The other arm. Without it, a runtime that gated *every* mutating call would satisfy the
        // assertion above — the "a test that passes with the fix reverted" shape, one layer up.
        const model = recordingFetch([
            "saving that now\nACTION: memory_write\ntext: a note\nEND",
            "saved",
        ])
        const { call, runtime } = await harness({ fetch: model.fetch, manifest: PINNED_MANIFEST })
        try {
            const accepted = await post(call, {
                text: "save a note",
                from: { id: "user:moeen", kind: "user" },
            })
            await turnRow(call, accepted.turnId)
            expect(
                model.prompts().some((prompt) => prompt.includes("memory_write was not run")),
            ).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("the sender is on the turn row, so it survives the process", async () => {
        const { call, runtime } = await harness()
        try {
            const accepted = await post(call, { text: "ping", from: PEER })
            const row = await turnRow(call, accepted.turnId)
            expect(row.sender).toBe("agent:ops-bot")
            expect(row.senderName).toBe("Ops Bot")
            expect(row.senderKind).toBe("agent")
            // Raw, never the fenced form: the row is the record of what was said and `sender` sits
            // beside it, so the framing is reconstructible without the evidence carrying it.
            expect(row.input).toBe("ping")
        } finally {
            await runtime.stop()
        }
    })

    test("a turn with no sender leaves the row's sender columns absent, not empty", async () => {
        const { call, runtime } = await harness()
        try {
            const accepted = await post(call, { text: "ping" })
            const row = await turnRow(call, accepted.turnId)
            // Absent means "the operator", and the null is what carries that. A defaulted
            // `senderKind: "user"` would make an operator's turn indistinguishable from a declared
            // human sender, which is the distinction the column exists for.
            expect(row.sender).toBeUndefined()
            expect(row.senderKind).toBeUndefined()
        } finally {
            await runtime.stop()
        }
    })

    test("an unknown kind is refused rather than defaulted, and names the real one", async () => {
        const { call, runtime } = await harness()
        try {
            const response = await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "hi", from: { id: "x", kind: "agents" } },
            })
            expect(response.status).toBe(400)
            const body = (await response.json()) as { error: { code: string; hint: string } }
            expect(body.error.code).toBe("sender_invalid")
            // Both defaults are wrong here — "user" silently un-gates a peer message somebody tried
            // to declare, "agent" gates an operator's own turn over a typo — so it refuses and
            // suggests, the way `?types=` does for an unknown event.
            expect(body.error.hint).toContain('"agent"')
        } finally {
            await runtime.stop()
        }
    })

    test("from without an id is refused", async () => {
        const { call, runtime } = await harness()
        try {
            const response = await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "hi", from: { kind: "agent" } },
            })
            expect(response.status).toBe(400)
            const body = (await response.json()) as { error: { field: string; hint: string } }
            expect(body.error.field).toBe("from.id")
            expect(body.error.hint.length).toBeGreaterThan(0)
        } finally {
            await runtime.stop()
        }
    })
})

describe("Idempotency-Key", () => {
    test("two posts with one key run one turn and return the first turn's id", async () => {
        const { call, runtime } = await harness()
        try {
            const headers = { "idempotency-key": "req-0001" }
            const first = await post(call, { text: "same message" }, headers)
            const second = await post(call, { text: "same message" }, headers)

            expect(first.status).toBe(202)
            expect(first.replayed).toBeUndefined()
            // 200, not 202: nothing was accepted for processing, and a 202 would be a status code
            // asserting work that never happened.
            expect(second.status).toBe(200)
            expect(second.turnId).toBe(first.turnId)
            expect(second.replayed).toBe(true)

            await turnRow(call, first.turnId)
            const turns = await runtime
                .agent("assistant")
                .store.turns.list("assistant", "api:default")
            expect(turns.length).toBe(1)
        } finally {
            await runtime.stop()
        }
    })

    test("the same key with different text is a 409 and runs nothing", async () => {
        const { call, runtime } = await harness()
        try {
            const headers = { "idempotency-key": "req-0002" }
            const first = await post(call, { text: "the original" }, headers)

            const response = await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "something else entirely" },
                headers,
            })
            expect(response.status).toBe(409)
            const body = (await response.json()) as { error: { code: string; hint: string } }
            expect(body.error.code).toBe("idempotency_key_reused")
            // Names the turn holding the key, so a client can go and look at what it sent. The one
            // new failure a key introduces that not having one does not is being told a *different*
            // message succeeded, and this is the sentence that prevents it.
            expect(body.error.hint).toContain(first.turnId)

            await turnRow(call, first.turnId)
            const turns = await runtime
                .agent("assistant")
                .store.turns.list("assistant", "api:default")
            expect(turns.length).toBe(1)
        } finally {
            await runtime.stop()
        }
    })

    test("the same text in a different session is a different logical request", async () => {
        // The hash covers the session key as well as the text. Without it, relaying one broadcast
        // message into two conversations under one key would silently drop the second.
        const { call, runtime } = await harness()
        try {
            const headers = { "idempotency-key": "req-0003" }
            const first = await post(
                call,
                { text: "standup in five", sessionKey: "api:alice" },
                headers,
            )
            const response = await call("POST", "/v1/agents/assistant/messages", {
                body: { text: "standup in five", sessionKey: "api:bob" },
                headers,
            })
            // Refused rather than replayed: the key is the client's promise that this is the *same*
            // request, and another conversation is not one. Making them use a fresh key is better
            // than answering with a turn that happened somewhere else.
            expect(response.status).toBe(409)
            await turnRow(call, first.turnId)
        } finally {
            await runtime.stop()
        }
    })

    test("a malformed key is refused rather than ignored", async () => {
        const { call, runtime } = await harness()
        try {
            // A client sending one of these believes its retries are safe. Silently dropping the
            // header is the single outcome that leaves them wrong about the exact guarantee they
            // asked for, which is why none of these is tolerated.
            // A NUL byte is *not* in this list and the check for it is still in the handler: the
            // platform's own `Request` refuses to construct a header containing one, so it cannot
            // reach the route through any HTTP client — but `createHandler` is a plain
            // `(Request) => Response` and the guard costs one regex. `\u00e9` is the reachable
            // half: undici permits obs-text in a header value, so a non-ASCII key really does
            // arrive, and a NUL in a database key is a recorded hazard here (node:sqlite truncates
            // a bound string at one where bun:sqlite stores it whole).
            for (const key of ["", "  ", "x".repeat(256), "caf\u00e9-key"]) {
                const response = await call("POST", "/v1/agents/assistant/messages", {
                    body: { text: "hi" },
                    headers: { "idempotency-key": key },
                })
                expect(response.status).toBe(400)
                expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
                    "idempotency_key_invalid",
                )
            }
        } finally {
            await runtime.stop()
        }
    })

    test("no key at all runs both turns, which is what makes the key mean something", async () => {
        const { call, runtime } = await harness()
        try {
            const first = await post(call, { text: "twice please" })
            const second = await post(call, { text: "twice please" })
            expect(second.turnId).not.toBe(first.turnId)
            await turnRow(call, first.turnId)
            await turnRow(call, second.turnId)
            const turns = await runtime
                .agent("assistant")
                .store.turns.list("assistant", "api:default")
            expect(turns.length).toBe(2)
        } finally {
            await runtime.stop()
        }
    })
})
