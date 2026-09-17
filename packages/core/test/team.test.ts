/**
 * Phase 10B — supervisor delegation.
 *
 * The assertion this phase exists for is the **token** one: the supervisor's prompt contains the
 * artifact and not the member's transcript. Everything else here supports it or guards a way it
 * could silently stop being true.
 *
 * Driven through a real `Runtime` with a recording model endpoint, so the manifest expansion, the
 * graph check, the registry injection, the member's own turn and the store row are the production
 * ones. A hand-built `runHandoff` call would test the runner and none of the wiring — and the
 * wiring is where this repo's bugs live.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_TEAM_DEPTH } from "../src/index.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const dirs: string[] = []
// `afterEach` rather than `afterAll`: core's suite also runs under Node's runner through
// `_harness.ts`, whose closed surface has no `afterAll` — and per-test cleanup is the honest
// lifetime anyway, since each test writes its own tree.
afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
})

const ENV = { MODEL_API_KEY: "sk-test" }

function manifest(id: string, extra = ""): string {
    return `apiVersion: dispach/v1
id: ${id}
name: ${id}
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: nlt
  local: [now]
${extra}`
}

const ARTIFACT = `      artifact:
        type: object
        properties:
          finding: { type: string }
        required: [finding]`

/** A supervisor with one member, both written to a temp directory. */
function workspace(
    options: {
        readonly supervisorExtra?: string
        readonly memberExtra?: string
        readonly members?: readonly string[]
    } = {},
): string {
    const dir = mkdtempSync(join(tmpdir(), "team-test-"))
    dirs.push(dir)
    mkdirSync(join(dir, "team"), { recursive: true })
    const ids = options.members ?? ["researcher"]
    const team = `team:
  members:
${ids
    .map(
        (id) => `    - id: ${id}
      manifest: ./team/${id}.yaml
      task: Finds one fact.
${ARTIFACT}`,
    )
    .join("\n")}
${options.supervisorExtra ?? ""}`
    writeFileSync(join(dir, "agent.yaml"), manifest("editor", team))
    for (const id of ids) {
        writeFileSync(join(dir, "team", `${id}.yaml`), manifest(id, options.memberExtra ?? ""))
    }
    return dir
}

/**
 * A model endpoint that answers a scripted sequence **per agent**, and records every request.
 *
 * Per agent rather than one shared queue, because a supervisor and its member both call this and a
 * single queue would make the replies depend on interleaving — which is exactly the kind of test
 * that passes locally and fails on a loaded runner. The agent is identified from the prompt, which
 * is the only thing the fetch sees.
 */
function scriptedFetch(scripts: Readonly<Record<string, readonly string[]>>): {
    fetch: typeof fetch
    bodies: { agent: string; body: Record<string, unknown> }[]
    promptFor: (agent: string) => string
} {
    const bodies: { agent: string; body: Record<string, unknown> }[] = []
    const counts = new Map<string, number>()

    const doFetch = (async (_url: unknown, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>
        const text = JSON.stringify(body.messages ?? [])
        // Identity from the prompt: each agent's identity file names it, and a member's catalogue
        // carries `submit_artifact` while a supervisor's carries `handoff`.
        const agent =
            text.includes('"handoff"') || text.includes("handoff\\n") ? "editor" : "member"
        bodies.push({ agent, body })
        const script = scripts[agent] ?? [""]
        const index = counts.get(agent) ?? 0
        counts.set(agent, index + 1)
        const reply = script[Math.min(index, script.length - 1)] ?? ""
        return new Response(
            [
                `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`,
                "data: [DONE]\n\n",
            ].join(""),
            { status: 200, headers: { "content-type": "text/event-stream" } },
        )
    }) as unknown as typeof fetch

    /** Every message of every request that agent made, concatenated. */
    const promptFor = (agent: string) =>
        bodies
            .filter((entry) => entry.agent === agent)
            .flatMap((entry) =>
                ((entry.body.messages ?? []) as { content?: unknown }[]).map((message) =>
                    typeof message.content === "string"
                        ? message.content
                        : JSON.stringify(message.content),
                ),
            )
            .join("\n")

    return { fetch: doFetch, bodies, promptFor }
}

const DELEGATES =
    "Let me ask.\nACTION: handoff\nmember: researcher\ntask: Find one fact about WAL.\nEND"
const SUBMITS =
    "Found it.\nACTION: submit_artifact\nfinding: WAL lets readers and one writer run concurrently.\nEND"

describe("a supervisor delegates", () => {
    test("the artifact reaches the supervisor and the transcript does not", async () => {
        // **The assertion this phase exists for.** Isolation is not a property of anybody being
        // careful: the member runs in its own session, so there is no history to leak, and the
        // supervisor's only view of the work is the observation the `handoff` tool returns.
        const model = scriptedFetch({
            editor: [DELEGATES, "WAL mode lets readers and one writer run at once."],
            member: [SUBMITS, "done"],
        })
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: model.fetch,
        })
        try {
            const result = await runtime.agent("editor").send("Tell me about WAL mode.")
            expect(result.reason).toBe("final")

            const supervisorPrompt = model.promptFor("editor")
            // The artifact is there, as JSON, in the observation.
            expect(
                supervisorPrompt.includes("WAL lets readers and one writer run concurrently"),
            ).toBe(true)
            // And the member's own prose is **not**. "Found it." is the member's narration outside
            // its ACTION block — it reached the member's own transcript and must never reach here.
            expect(supervisorPrompt.includes("Found it.")).toBe(false)
            // Nor the member's identity, nor its catalogue: a leaked sub-prompt is the token cost
            // this phase exists to avoid, and it would look like nothing at all.
            expect(supervisorPrompt.includes("submit_artifact")).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("the member is TOLD it has submit_artifact, not merely given it", async () => {
        // The guard for a bug that shipped and had no symptom in any unit test. A turn tool is
        // layered onto the registry through `withTools`, and slot 1's catalogue is rendered **once
        // at load** — so `submit_artifact` was executable and undocumented, and three real handoffs
        // in a row came back `no_artifact` with the member's own reasoning reading "No tool needed.
        // Just reply." It was right about what it could see.
        //
        // Nothing here caught it because a scripted fixture emits its `ACTION` block regardless of
        // the catalogue: the prompt was never under test. So this reads the member's prompt.
        const model = scriptedFetch({
            editor: [DELEGATES, "ok"],
            member: [SUBMITS, "done"],
        })
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: model.fetch,
        })
        try {
            await runtime.agent("editor").send("Tell me about WAL mode.")
            const memberPrompt = model.promptFor("member")
            // **In the catalogue**, which is the half the first fix got wrong: described only in the
            // input, a real member reasoned "we cannot call a tool not in available tools" and
            // declined. Two occurrences prove both halves — the rendered catalogue entry and the
            // obligation in the task — so this cannot pass on one of them.
            expect(memberPrompt.split("submit_artifact").length - 1 >= 2).toBe(true)
            expect(memberPrompt.includes("Returns your finished answer")).toBe(true)
            // And the fields, by name and requiredness — a tool it knows about but whose shape it
            // has to guess is the next version of the same failure.
            expect(memberPrompt.includes("finding (string), required")).toBe(true)
            // And the sentence that makes the call necessary rather than optional. The model's
            // instinct is that its reply *is* the answer, which is true everywhere else.
            expect(memberPrompt.includes("its own does not reach the agent that asked")).toBe(true)
        } finally {
            await runtime.stop()
        }
    })

    test("the supervisor's prompt grows by the artifact, not by the work", async () => {
        // The same claim as a number rather than as a substring, because "does not contain" is
        // satisfied by a prompt that contains nothing. Two runs of the same delegation where the
        // member's transcript differs enormously and the supervisor's prompt barely moves.
        const short = scriptedFetch({
            editor: [DELEGATES, "ok"],
            member: [SUBMITS, "done"],
        })
        const long = scriptedFetch({
            editor: [DELEGATES, "ok"],
            member: [
                // Four steps of verbose work before submitting. All of it in the member's session.
                `Thinking at length. ${"x".repeat(4000)}\nACTION: now\nEND`,
                `Still working. ${"y".repeat(4000)}\nACTION: now\nEND`,
                `Nearly there. ${"z".repeat(4000)}\nACTION: now\nEND`,
                SUBMITS,
                "done",
            ],
        })

        const sizeOf = async (model: ReturnType<typeof scriptedFetch>): Promise<number> => {
            const runtime = await Runtime.create({
                agents: [join(workspace(), "agent.yaml")],
                env: ENV,
                fetch: model.fetch,
            })
            try {
                await runtime.agent("editor").send("Tell me about WAL mode.")
                return model.promptFor("editor").length
            } finally {
                await runtime.stop()
            }
        }

        const cheap = await sizeOf(short)
        const expensive = await sizeOf(long)
        // 12,000 characters of member work, and the supervisor pays for none of it. Generous bound
        // rather than equality: the observation carries a step count and a token count that do
        // differ, and pinning those would make this test about the footer's wording.
        expect(expensive - cheap).toBeLessThan(200)
        expect(long.promptFor("member").length).toBeGreaterThan(cheap)
    })

    test("two handoffs to one member do not share history", async () => {
        // **Run it twice before believing it.** One handoff cannot catch this: the member is a
        // different `agent_id`, so its rows never collide with the supervisor's whatever the
        // session is called, and a fixed session name looks perfectly isolated for exactly one
        // delegation. The leak is the *second* one inheriting the first's transcript — which is
        // history a member was promised it would not have, from a task it was never told about.
        //
        // Asserted by reverting `handoff:${newRunId()}` to a constant and watching this go red; the
        // single-handoff isolation test stays green through that change, which is why it is not
        // enough on its own.
        const model = scriptedFetch({
            editor: [
                DELEGATES,
                "Let me ask again.\nACTION: handoff\nmember: researcher\ntask: Find a second fact.\nEND",
                "ok",
            ],
            member: [SUBMITS, "SECOND-CALL-MARKER\nACTION: submit_artifact\nfinding: second.\nEND"],
        })
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: model.fetch,
        })
        try {
            const result = await runtime.agent("editor").send("Two facts please.")
            const rows = await runtime
                .agent("editor")
                .store.handoffs.forTurn("editor", result.turnId)
            expect(rows.length).toBe(2)
            // Different sessions, which is the mechanism.
            expect(rows[0]?.memberSession).not.toBe(rows[1]?.memberSession)

            // And the consequence, read off the store rather than off the mechanism: the second
            // delegation's transcript holds only its own work.
            const second = await runtime
                .agent("researcher")
                .store.messages.history("researcher", rows[1]?.memberSession ?? "")
            expect(second.some((message) => message.content.includes("Find a second fact"))).toBe(
                true,
            )
            expect(
                second.some((message) => message.content.includes("Find one fact about WAL")),
            ).toBe(false)
            expect(second.some((message) => message.content.includes("Found it."))).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("a member that never submits is a typed failure naming its own reason", async () => {
        const model = scriptedFetch({
            editor: [DELEGATES, "They could not do it, so here is what I know myself."],
            member: ["I cannot do this without knowing which database you mean."],
        })
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: model.fetch,
        })
        try {
            const result = await runtime.agent("editor").send("Tell me about WAL mode.")
            // The supervisor's turn **completed**. A member's difficulty is information, not an
            // exception — decision 4.26, and a throw past the loop would have lost the turn.
            expect(result.reason).toBe("final")
            const prompt = model.promptFor("editor")
            expect(prompt.includes("finished without returning an answer")).toBe(true)
            // The member's own sentence, which is the thing the supervisor can act on — more useful
            // than a list of unfilled fields would have been.
            expect(prompt.includes("without knowing which database you mean")).toBe(true)
            // And a terminal instruction, because a truthful refusal with no alternative produces a
            // retry storm: `memory_write` once returned an honest "NOT SAVED" and a real model
            // retried until the step budget ran out.
            expect(prompt.includes("unchanged will end the same way")).toBe(true)
        } finally {
            await runtime.stop()
        }
    })

    test("the delegation is recorded, with a pointer to the member's transcript", async () => {
        const model = scriptedFetch({
            editor: [DELEGATES, "ok"],
            member: [SUBMITS, "done"],
        })
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: model.fetch,
        })
        try {
            const result = await runtime.agent("editor").send("Tell me about WAL mode.")
            const rows = await runtime
                .agent("editor")
                .store.handoffs.forTurn("editor", result.turnId)
            expect(rows.length).toBe(1)
            expect(rows[0]?.memberId).toBe("researcher")
            expect(rows[0]?.outcome).toBe("ok")
            expect(rows[0]?.artifact).toContain("WAL lets readers")
            expect(rows[0]?.endedAt).toBeDefined()

            // The load-bearing column: the supervisor's prompt holds only the artifact, so without
            // this pointer "what did the member actually say" is unanswerable from any surface.
            const transcript = await runtime
                .agent("researcher")
                .store.messages.history("researcher", rows[0]?.memberSession ?? "")
            expect(transcript.length).toBeGreaterThan(0)
            expect(transcript.some((message) => message.content.includes("Found it."))).toBe(true)
        } finally {
            await runtime.stop()
        }
    })
})

describe("a member is loaded but not served", () => {
    test("list() excludes members and agent() still resolves them", async () => {
        // The boundary is the *served* surface, not the process: every HTTP route resolves through
        // `withAgent`, which reads `list()`, so an addressable member would be a route around
        // whatever policy its supervisor carries. The handoff runner needs `agent(id)`.
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: scriptedFetch({}).fetch,
        })
        try {
            expect(runtime.list().map((agent) => agent.id)).toEqual(["editor"])
            expect(
                runtime
                    .all()
                    .map((agent) => agent.id)
                    .sort(),
            ).toEqual(["editor", "researcher"])
            expect(runtime.agent("researcher").id).toBe("researcher")
            expect(runtime.team("editor").map((member) => member.id)).toEqual(["researcher"])
            expect(runtime.team("researcher")).toEqual([])
        } finally {
            await runtime.stop()
        }
    })

    test("declaring team: is what registers handoff — there is no second switch", async () => {
        const withTeam = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: scriptedFetch({}).fetch,
        })
        try {
            expect(
                withTeam
                    .agent("editor")
                    .tools.specs()
                    .map((spec) => spec.slug),
            ).toContain("handoff")
            // And the member does **not** have it, which is the acceptance criterion: a member
            // lacks `handoff` unless it declares its own team.
            expect(
                withTeam
                    .agent("researcher")
                    .tools.specs()
                    .map((spec) => spec.slug),
            ).not.toContain("handoff")
        } finally {
            await withTeam.stop()
        }
    })
})

describe("the team graph is checked at load", () => {
    const write = (files: Readonly<Record<string, string>>): string => {
        const dir = mkdtempSync(join(tmpdir(), "team-graph-"))
        dirs.push(dir)
        for (const [path, body] of Object.entries(files)) {
            const full = join(dir, path)
            mkdirSync(join(full, ".."), { recursive: true })
            writeFileSync(full, body)
        }
        return dir
    }

    const teamBlock = (id: string, path: string) => `team:
  members:
    - id: ${id}
      manifest: ${path}
      task: Does a thing.
${ARTIFACT}
`

    test("a cycle is refused by name, before anything runs", async () => {
        // Caught at **load**, against the manifests, rather than at the third hop of a turn
        // somebody is waiting on. Every edge is a path, so the whole graph is static.
        const dir = write({
            "agent.yaml": manifest("a", teamBlock("b", "./b.yaml")),
            "b.yaml": manifest("b", teamBlock("a", "./agent.yaml")),
        })
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: scriptedFetch({}).fetch,
            })
            throw new Error("expected a refusal")
        } catch (error) {
            // The code, not the class: `toMatchObject` is outside the harness's closed
            // matcher list, and the code is what a caller switches on anyway.
            expect((error as { code?: string }).code).toBe("team_cycle")
        }
    })

    test("a chain deeper than the cap is refused, and names the chain", async () => {
        const dir = write({
            "agent.yaml": manifest("a", teamBlock("b", "./b.yaml")),
            "b.yaml": manifest("b", teamBlock("c", "./c.yaml")),
            "c.yaml": manifest("c", teamBlock("d", "./d.yaml")),
            "d.yaml": manifest("d"),
        })
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: scriptedFetch({}).fetch,
            })
            throw new Error("expected a refusal")
        } catch (error) {
            const detail = error as { code?: string; message?: string; hint?: string }
            expect(detail.code).toBe("team_too_deep")
            expect(detail.message).toContain("a → b → c → d")
            // No manifest field raises it, and the refusal says so rather than leaving somebody
            // looking for one.
            expect(detail.hint).toContain("no manifest field to raise it")
        }
    })

    test("exactly the cap is allowed, or the guard above proves nothing", async () => {
        // The other arm. Without it, a runtime that refused *every* nested team would satisfy the
        // two assertions above — the passes-with-the-fix-reverted shape, one level up.
        const dir = write({
            "agent.yaml": manifest("a", teamBlock("b", "./b.yaml")),
            "b.yaml": manifest("b", teamBlock("c", "./c.yaml")),
            "c.yaml": manifest("c"),
        })
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: scriptedFetch({}).fetch,
        })
        try {
            expect(MAX_TEAM_DEPTH).toBe(2)
            expect(
                runtime
                    .all()
                    .map((agent) => agent.id)
                    .sort(),
            ).toEqual(["a", "b", "c"])
            // The middle agent has both: it receives handoffs and makes them.
            expect(
                runtime
                    .agent("b")
                    .tools.specs()
                    .map((spec) => spec.slug),
            ).toContain("handoff")
        } finally {
            await runtime.stop()
        }
    })

    test("a member whose manifest has a different id is refused", async () => {
        // Checked rather than trusted, because nothing downstream would notice: the `handoff`
        // argument, the session key, the events and the stored row would each use whichever id
        // their layer happened to have.
        const dir = write({
            "agent.yaml": manifest("a", teamBlock("researcher", "./other.yaml")),
            "other.yaml": manifest("somebodyelse"),
        })
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: scriptedFetch({}).fetch,
            })
            throw new Error("expected a refusal")
        } catch (error) {
            // The code, not the class: `toMatchObject` is outside the harness's closed
            // matcher list, and the code is what a caller switches on anyway.
            expect((error as { code?: string }).code).toBe("team_member_id_mismatch")
        }
    })

    test("two members with one id naming different files is refused", async () => {
        const dir = write({
            "agent.yaml": manifest(
                "a",
                `team:
  members:
    - id: dup
      manifest: ./one.yaml
      task: One.
${ARTIFACT}
    - id: dup
      manifest: ./two.yaml
      task: Two.
${ARTIFACT}
`,
            ),
            "one.yaml": manifest("dup"),
            "two.yaml": manifest("dup"),
        })
        try {
            await Runtime.create({
                agents: [join(dir, "agent.yaml")],
                env: ENV,
                fetch: scriptedFetch({}).fetch,
            })
            throw new Error("expected a refusal")
        } catch (error) {
            // The code, not the class: `toMatchObject` is outside the harness's closed
            // matcher list, and the code is what a caller switches on anyway.
            expect((error as { code?: string }).code).toBe("team_member_conflict")
        }
    })
})
