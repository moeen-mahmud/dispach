/**
 * `ask_agent` between one person's agents (decision 15.9, `docs/24-SPEC-PEER-ASK.md`), through a
 * real runtime: who is offered, one hop, what the asked turn reads, shared agents, hot reload, and a
 * remote peer through a fake relay. Every assertion about the asked turn reads the request body the
 * peer's model was sent, because a field set in one layer and dropped by the next has cost this repo
 * six rounds.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type AnyEvent,
    BRAND,
    type ChatChunk,
    type ChatRequest,
    type ModelTransport,
    type RelayClient,
    type RemotePeer,
    Runtime,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

type Step = { tool: string; args: Record<string, unknown> } | { text: string }

/** Plays `script` once per distinct input, then says "ok"; records every request whole. */
function scripted(script: (input: string) => readonly Step[], seen: ChatRequest[]): ModelTransport {
    const progress = new Map<string, number>()
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push(request)
                const input = String(request.messages.find((m) => m.turnInput === true)?.content)
                const index = progress.get(input) ?? 0
                progress.set(input, index + 1)
                const step = script(input)[index] ?? { text: "ok" }
                if ("tool" in step) {
                    yield {
                        type: "tool_call",
                        call: {
                            id: `c${index}`,
                            name: step.tool,
                            arguments: JSON.stringify(step.args),
                        },
                    }
                    yield { type: "finish", reason: "tool_calls" }
                    return
                }
                yield { type: "text", delta: step.text }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

/** An agent with a private `MEMORY.md`, `memory_write` pinned, and `extra` appended. */
function agent(root: string, id: string, carried: string, extra: string, deny = ""): string {
    const dir = join(root, id)
    mkdirSync(join(dir, "workspace"), { recursive: true })
    mkdirSync(join(dir, "memory"), { recursive: true })
    writeFileSync(
        join(dir, "workspace", "MEMORY.md"),
        `---\ntier: volatile\neditable: replace\nbudget: 2000\neviction: oldest\n---\n\n# What I know\n\n- ${carried}\n`,
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
tools:
  dialect: native
  pinned: [memory_write]
  policy:
    allow: [memory_write, ask_agent]
${deny === "" ? "" : `    deny: ["${deny}"]\n`}${extra}`,
    )
    return join(dir, "agent.yaml")
}

const ASKS = "delegation:\n  ask: true\n"

/** milo asks whoever `peer` names; everyone else answers with what is in front of it. */
async function silo(
    extra: Partial<Record<"milo" | "nova" | "bob" | "board", string>> = {},
    options: { readonly relay?: RelayClient; readonly peer?: string; readonly deny?: string } = {},
) {
    const root = mkdtempSync(join(tmpdir(), "peer-ask-"))
    const seen = { milo: [], nova: [], bob: [], board: [] } as Record<string, ChatRequest[]>
    const answer = (id: string) => scripted(() => [{ text: `${id} answers` }], seen[id] ?? [])
    const runtime = await Runtime.create({
        agents: [
            agent(
                root,
                "milo",
                "milo keeps the release checklist",
                extra.milo ?? ASKS,
                options.deny,
            ),
            agent(root, "nova", "nova knows the dentist is on Tuesday", extra.nova ?? ASKS),
            agent(root, "bob", "bob's own private note", extra.bob ?? ASKS),
            agent(root, "board", "board's private scratch note", extra.board ?? ASKS),
        ],
        env: {},
        store: ":memory:",
        ...(options.relay === undefined ? {} : { relay: options.relay }),
        modelTransports: {
            milo: scripted(
                (input) =>
                    input.startsWith("ask")
                        ? [
                              {
                                  tool: "ask_agent",
                                  args: {
                                      peer: options.peer ?? "nova",
                                      question: "When is the dentist appointment and the launch?",
                                  },
                              },
                              { text: "done" },
                          ]
                        : [{ text: "ok" }],
                seen.milo ?? [],
            ),
            nova: scripted(
                // Tries to ask onward; the tool is not in its catalogue.
                () => [
                    { tool: "ask_agent", args: { peer: "milo", question: "you do it" } },
                    { text: "nova answers: Tuesday" },
                ],
                seen.nova ?? [],
            ),
            bob: answer("bob"),
            board: answer("board"),
        },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    const hub = runtime.conversations
    await hub.registerParticipant({ id: "user:ada", name: "Ada" })
    await hub.registerParticipant({ id: "user:bob", name: "Bob" })
    await hub.assign({ agentId: "milo", participantId: "user:ada" })
    await hub.assign({ agentId: "nova", participantId: "user:ada" })
    await hub.assign({ agentId: "bob", participantId: "user:bob" })
    // `board` stays unassigned: a shared agent.
    await runtime.peersSettled()
    const tools = (id: string) =>
        JSON.stringify(
            runtime
                .agent(id)
                .tools.specs()
                .find((spec) => spec.slug === "ask_agent") ?? null,
        )
    const last = (id: string) => JSON.stringify(seen[id]?.at(-1) ?? null)
    const asAda = { from: { id: "user:ada", kind: "user" as const } }
    return { runtime, hub, events, seen, tools, last, asAda }
}

describe("ask_agent in one silo", () => {
    test("offers the same person's agents and shared ones, never another person's", async () => {
        const { runtime, tools } = await silo()
        const offered = tools("milo")
        expect(offered).toContain('"nova"')
        expect(offered).toContain('"board"')
        expect(offered).toContain("shared, answers from its projects")
        expect(offered).not.toContain('"bob"')
        // A shared agent has nobody to act for: it is asked, and never asks.
        expect(tools("board")).toBe("null")
        expect(
            runtime
                .agent("milo")
                .tools.specs()
                .find((s) => s.slug === "ask_agent")?.mutating,
        ).toBe(true)
        await runtime.stop()
    })

    test("both sides opt in: a peer without delegation.ask is not offered", async () => {
        const { runtime, tools } = await silo({ nova: "" })
        expect(tools("milo")).not.toContain('"nova"')
        // And an agent that does not declare it gets no tool at all.
        expect(tools("nova")).toBe("null")
        await runtime.stop()
    })

    test("runs one hop, as the owner, in a fresh session, and returns the answer", async () => {
        const { runtime, events, last, asAda, seen } = await silo()
        const result = await runtime.agent("milo").send("ask nova", asAda)
        expect(last("milo")).toContain("Answer from nova")
        expect(last("milo")).toContain("nova answers: Tuesday")

        const asked = last("nova")
        // One hop: the asked turn's catalogue has neither delegation tool (its attempt was refused).
        const offered = (seen.nova?.at(-1)?.tools ?? []).map((tool) => tool.name)
        expect(offered).toEqual(["memory_write"])
        expect(asked).toContain("another of their agents")
        // The owner asked, so nova reads its own private memory.
        expect(asked).toContain("nova knows the dentist is on Tuesday")

        const [row] = await runtime.store.handoffs.forTurn("milo", result.turnId)
        expect(row?.kind).toBe("ask")
        expect(row?.outcome).toBe("ok")
        expect(row?.memberSession.startsWith("ask:")).toBe(true)
        expect(events.filter((e) => e.type === "peer.ask").length).toBe(1)
        const answered = events.find((e) => e.type === "peer.answer")?.data as { outcome?: string }
        expect(answered?.outcome).toBe("ok")
        await runtime.stop()
    })

    test("the owner asking from a channel is the owner on the other side too", async () => {
        const { runtime, hub, last } = await silo()
        await hub.assign({
            agentId: "milo",
            participantId: "user:ada",
            channelIds: ["telegram:@ada"],
        })
        await runtime.peersSettled()
        await runtime.agent("milo").send("ask nova", {
            participant: { id: "telegram:5551234", via: "channel", handles: ["@ada"] },
        })
        const asked = last("nova")
        expect(asked).toContain("nova knows the dentist is on Tuesday")
        expect(asked).toContain("another of their agents")
        await runtime.stop()
    })

    test("a shared agent answers from its projects, not its private memory, with its whole catalogue", async () => {
        const { runtime, hub, last, asAda } = await silo({}, { peer: "board" })
        await hub.upsertProject({ id: "launch", agents: ["board"] })
        await hub.addNote({ scope: "project:launch", text: "The launch is on Friday" })
        await runtime.agent("milo").send("ask board", asAda)
        const asked = last("board")
        expect(asked).toContain("The launch is on Friday")
        expect(asked).not.toContain("board's private scratch note")
        expect(asked).toContain('"name":"memory_write"')
        await runtime.stop()
    })

    test("a deny rule naming the peer refuses the ask", async () => {
        const { runtime, last, asAda, seen } = await silo({}, { deny: "ask_agent(nova)" })
        await runtime.agent("milo").send("ask nova", asAda)
        expect(last("milo")).toContain("ask_agent(nova)")
        expect(seen.nova?.length).toBe(0)
        await runtime.stop()
    })

    test("an assignment change reloads the agents whose peers it changes", async () => {
        const { runtime, hub, tools, events } = await silo()
        expect(tools("milo")).not.toContain('"bob"')
        await hub.assign({ agentId: "bob", participantId: "user:ada" })
        await runtime.peersSettled()
        expect(tools("milo")).toContain('"bob"')
        expect(
            events.some(
                (e) => e.type === "agent.reloaded" && e.agentId === "milo" && e.data.ok === true,
            ),
        ).toBe(true)
        // An agent whose list did not change is not reloaded.
        expect(events.some((e) => e.type === "agent.reloaded" && e.agentId === "board")).toBe(false)
        await runtime.stop()
    })
})

describe("ask_agent across silos", () => {
    function relay(calls: unknown[], refreshed: string[] = []): RelayClient {
        const peers: RemotePeer[] = [
            { silo: "team", agent: "crm", description: "The team's CRM", shared: true },
        ]
        return {
            cachedPeers: () => peers,
            refreshPeers: async (agentId, participantId) => {
                refreshed.push(`${agentId}:${participantId}`)
                return peers
            },
            ask: async (request) => {
                calls.push(request)
                return {
                    text: "crm answers: 4 open deals",
                    reason: "final",
                    steps: 1,
                    tokens: { prompt: 1, output: 1 },
                }
            },
        }
    }

    test("relays the owner's ask as the owner, and refuses a stranger's turn", async () => {
        const calls: unknown[] = []
        const { runtime, tools, last, asAda } = await silo(
            {},
            { relay: relay(calls), peer: "team/crm" },
        )
        expect(tools("milo")).toContain('"team/crm"')
        expect(tools("milo")).toContain("in another silo")

        await runtime.agent("milo").send("ask crm", asAda)
        expect(last("milo")).toContain("crm answers: 4 open deals")
        const [call] = calls as {
            fromAgent: string
            participantId: string
            silo: string
            agent: string
        }[]
        expect([call?.fromAgent, call?.participantId, call?.silo, call?.agent]).toEqual([
            "milo",
            "user:ada",
            "team",
            "crm",
        ])

        await runtime
            .agent("milo")
            .send("ask crm again", { from: { id: "user:eve", kind: "user" } })
        expect(last("milo")).toContain("only the person this agent works for can ask there")
        expect(calls.length).toBe(1)
        await runtime.stop()
    })

    test("a reload asks the control plane again, for the reloaded agent only", async () => {
        const refreshed: string[] = []
        const { runtime } = await silo({}, { relay: relay([], refreshed) })
        await new Promise((resolve) => setTimeout(resolve, 20))
        refreshed.length = 0
        await runtime.reload("milo")
        await runtime.peersSettled()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(refreshed).toEqual(["milo:user:ada"])
        await runtime.stop()
    })
})
