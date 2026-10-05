/**
 * Subagents (pilot.6): a routed call runs in a throwaway child of the same agent.
 *
 * Driven through a real `Runtime` and read off request bodies and tool handlers, because every rule
 * here crosses the executor, the agent and a second turn: a spread anywhere on that path drops one
 * with nothing failing.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { ActingParticipant } from "../src/loop/sender.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { isChildSession } from "../src/team/child-session.ts"
import type { Tool, ToolProviderFactory } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

// Far past `observationMaxTokens` (2,000), with a fact in the middle, where a cut removes text.
const RAW = `MAILBOX-RAW ${"Subject: quarterly numbers. ".repeat(350)}MIDDLE-FACT ${"Subject: weekly sync. ".repeat(350)}`

const SUBAGENTS = `subagents:
  - name: inbox
    task: Read the mailbox and say what needs attention.
    tools: [mail_list, mail_send, mail_raw]
    route:
      tools: [mail_list]`

function manifest(subagents = SUBAGENTS): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  providers:
    mail: {}
  pinned: [mail_list, mail_send, mail_raw]
${subagents}
`,
    )
    return join(dir, "agent.yaml")
}

/** What the tools saw: every send, and the participant each call carried. */
interface Seen {
    sent: string[]
    participants: (ActingParticipant | null | undefined)[]
}

function mail(seen: Seen): ToolProviderFactory {
    const tool = (
        slug: string,
        mutating: boolean,
        run: () => string,
        trust: "trusted" | "untrusted" = "trusted",
    ): Tool => ({
        spec: {
            slug,
            provider: "mail",
            summary: `The ${slug} tool.`,
            whenToUse: "When asked.",
            whenNotToUse: "Otherwise.",
            mutating,
            tags: [],
            // Trusted, so the only taint a child can carry is the one it inherits.
            trust,
            trustReason: "A test fixture.",
            parameters: {
                type: "object",
                properties: { folder: { type: "string" }, to: { type: "string" } },
            },
        },
        handler: (_args, context) => {
            seen.participants.push(context.actingParticipant)
            return run()
        },
    })
    return () => ({
        id: "mail",
        resolve: async (slugs) =>
            [
                tool("mail_list", false, () => RAW),
                tool("mail_raw", false, () => "Whatever a stranger wrote.", "untrusted"),
                tool("mail_send", true, () => {
                    seen.sent.push("sent")
                    return "Sent."
                }),
            ].filter((entry) => slugs.includes(entry.spec.slug)),
    })
}

/**
 * A scripted model. A request whose catalogue offers `submit_artifact` is the child's; each side's
 * next line is chosen by how many assistant messages its prompt already holds.
 */
function model(child: readonly string[]) {
    const parent: string[] = []
    const children: string[] = []
    const fetch: FetchLike = async (_url, init) => {
        const body = String(init?.body ?? "")
        const isChild = body.includes("submit_artifact")
        ;(isChild ? children : parent).push(body)
        const step = (JSON.parse(body) as { messages: { role: string }[] }).messages.filter(
            (message) => message.role === "assistant",
        ).length
        const script = isChild ? child : ["ACTION: mail_list\nfolder: inbox\nEND"]
        const content = script[step] ?? "Done."
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    return { fetch, parent, children }
}

const LIST_THEN_SUBMIT = [
    "ACTION: mail_list\nfolder: inbox\nEND",
    "ACTION: submit_artifact\nsummary: Two unread, one from Ada about the numbers.\nEND",
]
const SEND_THEN_SUBMIT = [
    "ACTION: mail_send\nto: ada@example.com\nEND",
    "ACTION: submit_artifact\nsummary: Tried to reply.\nEND",
]

async function boot(child: readonly string[], subagents = SUBAGENTS) {
    const seen: Seen = { sent: [], participants: [] }
    const scripted = model(child)
    const runtime = await Runtime.create({
        agents: [manifest(subagents)],
        env: { MODEL_API_KEY: "k" },
        fetch: scripted.fetch,
        toolProviders: { mail: mail(seen) },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    return { runtime, seen, events, ...scripted }
}

describe("a routed call", () => {
    test("runs in a child, and the parent reads the artifact instead of the raw output", async () => {
        const { runtime, parent, children } = await boot(LIST_THEN_SUBMIT)
        const result = await runtime.agent("test")?.send("anything new?", { sessionKey: "api:p" })
        expect(result?.reason).toBe("final")

        // The child made the real call, so the raw output reached it and only it.
        expect(children.some((body) => body.includes("MAILBOX-RAW"))).toBe(true)
        // And it was told what the call was for: the person's own question.
        expect(children[0]).toContain("anything new?")
        // And read all of it: a child's own window is its limit, not the parent's observation cap.
        expect(children[1]).toContain("MIDDLE-FACT")
        const after = parent[1] ?? ""
        expect(after).toContain("Two unread, one from Ada about the numbers.")
        expect(after).toContain("ran in subagent inbox")
        expect(after).not.toContain("MAILBOX-RAW")
        // Harness metadata never reaches a chat-completions body, on a later step either.
        expect(after).not.toContain("turnInput")
        await runtime.stop()
    })

    test("the child's catalogue is its tools plus submit_artifact, and it routes nothing", async () => {
        const { runtime, children, events } = await boot(LIST_THEN_SUBMIT)
        await runtime.agent("test")?.send("anything new?", { sessionKey: "api:p" })
        const first = children[0] ?? ""
        expect(first).toContain("mail_list")
        expect(first).toContain("mail_send")
        // Depth 1: the child's mail_list ran the tool, so one handoff, not a chain of them.
        expect(events.filter((event) => event.type === "handoff.start").length).toBe(1)
        const start = events.find((event) => event.type === "handoff.start")
        const data = start?.data as { sessionKey?: string } | undefined
        expect(String(data?.sessionKey)).toMatch(/^subagent:/)
        await runtime.stop()
    })

    test("the child's usage rows say subagent, under the parent agent", async () => {
        const { runtime, events } = await boot(LIST_THEN_SUBMIT)
        await runtime.agent("test")?.send("anything new?", { sessionKey: "api:p" })
        const roles = events
            .filter((event) => event.type === "model.result")
            .map((event) => ({
                role: (event.data as { role?: string }).role,
                session: event.sessionKey ?? "",
            }))
        expect(roles.filter((row) => row.session.startsWith("subagent:")).length).toBeGreaterThan(0)
        for (const row of roles) {
            expect(row.role).toBe(row.session.startsWith("subagent:") ? "subagent" : "main")
        }
        const usage = await runtime
            .agent("test")
            ?.store.usage.report({ by: ["agent"], agentIds: ["test"], sessionPrefix: "subagent:" })
        expect(usage?.buckets[0]?.calls).toBeGreaterThan(0)
        await runtime.stop()
    })
})

describe("what a child inherits", () => {
    test("a tainted parent starts its child tainted, so the child's write is refused", async () => {
        const { runtime, seen } = await boot(SEND_THEN_SUBMIT)
        await runtime.agent("test")?.send("check the mail", {
            sessionKey: "api:t",
            from: { id: "agent:peer", kind: "agent" },
        })
        // The parent's read was allowed; the child's send was gated by `onMutate: refuse`.
        expect(seen.participants.length).toBe(0)
        expect(seen.sent).toEqual([])
        await runtime.stop()
    })

    test("an untainted parent's child may write", async () => {
        const { runtime, seen } = await boot(SEND_THEN_SUBMIT)
        await runtime.agent("test")?.send("check the mail", { sessionKey: "api:u" })
        expect(seen.sent).toEqual(["sent"])
        await runtime.stop()
    })

    test("a stand-in's child queues its write instead of running it", async () => {
        const { runtime, seen } = await boot(SEND_THEN_SUBMIT)
        const deferred: string[] = []
        await runtime.agent("test")?.send("check the mail", {
            sessionKey: "api:s",
            deferMutations: async (call) => {
                deferred.push(call.slug)
                return "Queued for the owner."
            },
        })
        expect(deferred).toEqual(["mail_send"])
        expect(seen.sent).toEqual([])
        await runtime.stop()
    })

    test("the child's tools act for the parent's participant", async () => {
        const { runtime, seen } = await boot(LIST_THEN_SUBMIT)
        const participant: ActingParticipant = { id: "user:ada", via: "api" }
        await runtime.agent("test")?.send("anything new?", { sessionKey: "api:a", participant })
        expect(seen.participants).toEqual([participant])
        await runtime.stop()
    })

    test("a trusted child's artifact reaches the parent as trusted", async () => {
        const { runtime, events } = await boot(LIST_THEN_SUBMIT)
        await runtime.agent("test")?.send("anything new?", { sessionKey: "api:r" })
        const routed = events.find(
            (event) =>
                event.type === "tool.result" &&
                event.sessionKey === "api:r" &&
                (event.data as { slug?: string }).slug === "mail_list",
        )
        expect((routed?.data as { trust?: string } | undefined)?.trust).toBe("trusted")
        await runtime.stop()
    })
})

test("a child that read untrusted output hands back an untrusted artifact", async () => {
    const { runtime, events } = await boot([
        "ACTION: mail_raw\nfolder: inbox\nEND",
        "ACTION: submit_artifact\nsummary: A stranger's mail.\nEND",
    ])
    await runtime.agent("test")?.send("anything new?", { sessionKey: "api:x" })
    const routed = events.find(
        (event) =>
            event.type === "tool.result" &&
            event.sessionKey === "api:x" &&
            (event.data as { slug?: string }).slug === "mail_list",
    )
    expect((routed?.data as { trust?: string } | undefined)?.trust).toBe("untrusted")
    await runtime.stop()
})

describe("loading a manifest with subagents", () => {
    /** The rule's own code, from inside the load's `manifest_validation_failed`. */
    const refused = async (block: string): Promise<string | undefined> => {
        try {
            await Runtime.create({ agents: [manifest(block)], env: { MODEL_API_KEY: "k" } })
            return undefined
        } catch (error) {
            const details = (error as { details?: { code: string }[] }).details ?? []
            return details.map((detail) => detail.code).join(",")
        }
    }

    test("a tool the parent does not pin is refused", async () => {
        expect(await refused(SUBAGENTS.replace("mail_raw]", "mail_raw, mail_delete]"))).toBe(
            "subagent_tool_not_pinned",
        )
    })

    test("a routed slug the child cannot call is refused", async () => {
        expect(
            await refused(
                SUBAGENTS.replace("tools: [mail_list, mail_send, mail_raw]", "tools: [mail_send]"),
            ),
        ).toBe("subagent_route_outside_tools")
    })

    test("a model role nobody declared is refused", async () => {
        expect(await refused(`${SUBAGENTS}\n    model: cheap`)).toBe("subagent_role_unknown")
    })
})

test("cancelling the parent stops the child, and the child's turn says so", async () => {
    const controller = new AbortController()
    let childStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
        childStarted = resolve
    })
    const fetch: FetchLike = async (_url, init) => {
        const body = String(init?.body ?? "")
        if (body.includes("submit_artifact")) {
            childStarted()
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError")),
                )
            })
        }
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "ACTION: mail_list\nfolder: inbox\nEND" } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    const seen: Seen = { sent: [], participants: [] }
    const runtime = await Runtime.create({
        agents: [manifest()],
        env: { MODEL_API_KEY: "k" },
        fetch,
        toolProviders: { mail: mail(seen) },
    })
    const ends: { session: string; reason: string }[] = []
    runtime.bus.on("turn.end", (event) =>
        ends.push({
            session: event.sessionKey ?? "",
            reason: String((event.data as { reason?: string }).reason),
        }),
    )
    const turn = runtime
        .agent("test")
        ?.send("anything new?", { sessionKey: "api:c", signal: controller.signal })
    await started
    controller.abort()
    const result = await turn
    expect(result?.reason).toBe("stopped")
    expect(ends.find((end) => end.session.startsWith("subagent:"))?.reason).toBe("stopped")
    await runtime.stop()
})

describe("a child's events", () => {
    test("carry the parent's turn and session, and the handoff names the call it answers", async () => {
        const { runtime, events } = await boot(LIST_THEN_SUBMIT)
        const result = await runtime.agent("test")?.send("anything new?", { sessionKey: "api:e" })
        const child = events.filter((event) => event.sessionKey?.startsWith("subagent:"))
        expect(child.length).toBeGreaterThan(0)
        for (const event of child) {
            expect(event.parentTurnId).toBe(result?.turnId)
            expect(event.parentSessionKey).toBe("api:e")
        }
        // The parent's own events carry no parent.
        const own = events.filter((event) => event.sessionKey === "api:e")
        expect(own.every((event) => event.parentTurnId === undefined)).toBe(true)

        const call = own.find(
            (event) =>
                event.type === "tool.call" &&
                (event.data as { slug?: string }).slug === "mail_list",
        )
        const start = events.find((event) => event.type === "handoff.start")
        const data = start?.data as { kind?: string; name?: string; callId?: string } | undefined
        expect(data?.kind).toBe("self")
        expect(data?.name).toBe("inbox")
        expect(data?.callId).toBe((call?.data as { callId?: string } | undefined)?.callId)
        await runtime.stop()
    })

    test("reach a turn's stream only when it asks, without ending it", async () => {
        const { runtime } = await boot(LIST_THEN_SUBMIT)
        const turnId = "turn_parent"
        runtime.streams.open(turnId)
        const plain: string[] = []
        const nested: { type: string; turnId?: string }[] = []
        runtime.streams.attach(turnId, (event) => plain.push(event.type))
        runtime.streams.attach(
            turnId,
            (event) =>
                nested.push({
                    type: event.type,
                    ...(event.turnId ? { turnId: event.turnId } : {}),
                }),
            { children: true },
        )
        await runtime.agent("test")?.send("anything new?", { sessionKey: "api:s", turnId })

        expect(plain.filter((type) => type === "turn.end").length).toBe(1)
        const ends = nested.filter((event) => event.type === "turn.end")
        expect(ends.length).toBe(2)
        // The child ends first, and the parent's own end is still the last thing on its stream.
        expect(ends.at(-1)?.turnId).toBe(turnId)
        expect(nested.at(-1)?.turnId).toBe(turnId)
        expect(runtime.streams.state(turnId)).toBe("ended")

        // A late attach replays the child's events in place.
        const replay = runtime.streams.attach(turnId, () => {}, { children: true })?.replay ?? []
        const firstChild = replay.findIndex((event) => event.turnId !== turnId)
        const handoffResult = replay.findIndex((event) => event.type === "handoff.result")
        expect(firstChild).toBeGreaterThan(0)
        expect(firstChild).toBeLessThan(handoffResult)
        expect(
            runtime.streams
                .attach(turnId, () => {})
                ?.replay.every((event) => event.turnId === turnId),
        ).toBe(true)
        await runtime.stop()
    })
})

test("a delegation's own session is not a conversation", () => {
    expect(isChildSession("subagent:r_1")).toBe(true)
    expect(isChildSession("handoff:r_1")).toBe(true)
    expect(isChildSession("local:3c2dc5")).toBe(false)
    expect(isChildSession("api:subagent:x")).toBe(false)
})

test("a submit in the same step as the call it reports on is refused, so nothing invented reaches the parent", async () => {
    const { runtime, parent, events } = await boot([
        "ACTION: mail_list\nfolder: inbox\nEND\nACTION: submit_artifact\nsummary: INVENTED before the result existed.\nEND",
        "ACTION: submit_artifact\nsummary: Read it: Two unread, one from Ada.\nEND",
    ])
    await runtime.agent("test")?.send("anything new?", { sessionKey: "api:alone" })
    const after = parent[1] ?? ""
    expect(after).not.toContain("INVENTED")
    expect(after).toContain("Read it: Two unread, one from Ada.")
    const gated = events.find(
        (event) =>
            event.type === "tool.gated" &&
            (event.data as { slug?: string }).slug === "submit_artifact",
    )
    expect((gated?.data as { reason?: string } | undefined)?.reason).toContain(
        "same step as mail_list",
    )
    await runtime.stop()
})
