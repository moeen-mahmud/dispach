/**
 * Skills through a whole turn, against an injected `fetch`.
 *
 * This file exists because of a bug the unit tests could not see. `assembleContext` handled `skills`
 * correctly and `previewContext` called it directly, so both passed — but `TurnInput` had no `skills`
 * field, and `Agent.send` passed one through a *spread*, which TypeScript does not excess-property-check.
 * The block was silently dropped on the only path that matters. Every layer was individually right.
 *
 * That is the same failure CLAUDE.md records for `ChatMessage.toolCalls`, which three separate copying
 * layers dropped without any of them failing loudly. The lesson generalises: a field threaded through a
 * pipeline needs one test at the *end* of the pipeline, because the middle can be correct everywhere and
 * still not connected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { ScriptRunner, ScriptRunRequest } from "../src/tools/types.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }
const dirs: string[] = []

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

function agent(
    options: {
        readonly scripts?: Readonly<Record<string, string>>
        readonly trusted?: readonly string[]
    } = {},
): string {
    const dir = mkdtempSync(join(tmpdir(), "skills-turn-"))
    dirs.push(dir)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
name: Test Agent
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 8192
  reserveOutput: 512
  files:
    - IDENTITY.md
skills:
  dir: ./skills
  maxActive: 1
  threshold: 0.35
${options.trusted === undefined ? "" : `  trusted: [${options.trusted.join(", ")}]\n`}limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")

    // Four skills, so `discriminating()` has a corpus to work with: with fewer than three every shared
    // term appears in more than half of them and nothing ranks.
    write(dir, "pdf-processing", "Extract text and tables from PDF files and fill PDF forms.", {
        body: "Run the extractor, then check the page count.",
        ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
    })
    write(dir, "chart-builder", "Create bar and line charts from tabular data.", {
        body: "Pick the axes first.",
    })
    write(dir, "git-release", "Cut a tagged release: bump the version and push the tag.", {
        body: "Update the changelog.",
    })
    write(dir, "email-triage", "Sort an inbox into action, waiting and archive.", {
        body: "Start with the oldest.",
    })
    return join(dir, "agent.yaml")
}

function write(
    root: string,
    name: string,
    description: string,
    options: { body: string; scripts?: Readonly<Record<string, string>> },
): void {
    const dir = join(root, "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, "SKILL.md"),
        // Quoted: `git-release`'s description contains ": ", which unquoted is a YAML mapping and
        // fails the parse with BLOCK_AS_IMPLICIT_KEY. Real skills hit this too, and the refusal names it.
        `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${options.body}\n`,
    )
    if (options.scripts === undefined) return
    mkdirSync(join(dir, "scripts"), { recursive: true })
    for (const [file, body] of Object.entries(options.scripts)) {
        writeFileSync(join(dir, "scripts", file), body)
    }
}

function sse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

/** Records every request body, so the test can read the prompt the model was actually sent. */
function recorder(): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = []
    const fetch: FetchLike = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        return sse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\n`,
            "data: [DONE]\n\n",
        ])
    }
    return { fetch, bodies }
}

function prompt(body: Record<string, unknown>): string {
    const messages = body.messages
    if (!Array.isArray(messages)) return ""
    return messages
        .map((message) => String((message as { content?: unknown }).content ?? ""))
        .join("\n---\n")
}

const RUNNER: ScriptRunner = {
    has: () => true,
    run: () => Promise.resolve({ ok: true, output: "12 pages", code: 0, timedOut: false }),
}

describe("a skill reaches the model through send", () => {
    test("the body is in the prompt of a real turn", async () => {
        // The regression test. Before `TurnInput.skills` existed this passed through a spread into
        // `runTurn` and vanished, with `previewContext` still reporting it correctly.
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({ agents: [agent()], env: ENV, fetch })
        try {
            await runtime.agent("test").send("pull the tables out of this pdf")
            expect(prompt(bodies[0] ?? {})).toContain("Run the extractor")
        } finally {
            await runtime.stop()
        }
    })

    test("it is framed, so the model reads it as steps rather than background", async () => {
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({ agents: [agent()], env: ENV, fetch })
        try {
            await runtime.agent("test").send("pull the tables out of this pdf")
            expect(prompt(bodies[0] ?? {})).toContain("pdf-processing procedure applies")
        } finally {
            await runtime.stop()
        }
    })

    test("an unrelated question activates nothing, and no skill body appears", async () => {
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({ agents: [agent()], env: ENV, fetch })
        try {
            await runtime.agent("test").send("who won the 1998 world cup")
            const text = prompt(bodies[0] ?? {})
            expect(text).toContain("You are a test fixture.")
            expect(text.includes("Run the extractor")).toBe(false)
            expect(text.includes("Pick the axes")).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("only the winning skill's body appears, not every skill's", async () => {
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({ agents: [agent()], env: ENV, fetch })
        try {
            await runtime.agent("test").send("pull the tables out of this pdf")
            const text = prompt(bodies[0] ?? {})
            expect(text).toContain("Run the extractor")
            expect(text.includes("Update the changelog")).toBe(false)
        } finally {
            await runtime.stop()
        }
    })
})

describe("scripts through a turn", () => {
    test("the active skill's script is named in the prompt, and slot 1 never mentions it", async () => {
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({
            agents: [agent({ scripts: { "extract.py": "print(1)" } })],
            env: ENV,
            fetch,
            scriptRunner: RUNNER,
        })
        try {
            await runtime.agent("test").send("pull the tables out of this pdf")
            const text = prompt(bodies[0] ?? {})
            expect(text).toContain("skill.pdf-processing.extract")
            expect(text).toContain("this turn only")
        } finally {
            await runtime.stop()
        }
    })

    test("the executor can resolve the script slug for that turn", async () => {
        // The other half of the pair. A body naming a tool the executor has never heard of is an agent
        // reading an instruction it cannot follow.
        const path = agent({ scripts: { "extract.py": "print(1)" } })
        const runtime = await Runtime.create({
            agents: [path],
            env: ENV,
            fetch: recorder().fetch,
            scriptRunner: RUNNER,
        })
        try {
            const found = runtime
                .agent("test")
                .skills?.skills.find((skill) => skill.name === "pdf-processing")
            expect(found?.scripts.map((plan) => plan.slug)).toEqual([
                "skill.pdf-processing.extract",
            ])
            // Not in the resolved catalogue: that is the whole placement decision, and slot 1 is
            // rendered from this registry once at load.
            expect(runtime.agent("test").tools.has("skill.pdf-processing.extract")).toBe(false)
        } finally {
            await runtime.stop()
        }
    })

    test("skills.trusted: a skill not on it keeps its procedure and loses its scripts (pilot.14)", async () => {
        const turn = async (trusted: readonly string[]) => {
            const { fetch, bodies } = recorder()
            const runtime = await Runtime.create({
                agents: [agent({ scripts: { "extract.py": "print(1)" }, trusted })],
                env: ENV,
                fetch,
                scriptRunner: RUNNER,
            })
            try {
                await runtime.agent("test").send("pull the tables out of this pdf")
                return prompt(bodies[0] ?? {})
            } finally {
                await runtime.stop()
            }
        }
        const untrusted = await turn(["chart-builder"])
        expect(untrusted).toContain("Run the extractor")
        expect(untrusted).toContain("which I may not run")
        expect(untrusted).not.toContain("skill.pdf-processing.extract")
        expect(await turn(["pdf-processing"])).toContain("skill.pdf-processing.extract")
    })

    test("without a runner the scripts are named as unavailable rather than hidden", async () => {
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({
            agents: [agent({ scripts: { "extract.py": "print(1)" } })],
            env: ENV,
            fetch,
        })
        try {
            await runtime.agent("test").send("pull the tables out of this pdf")
            // No runner means the scripts were never discovered, so there is nothing to name — and the
            // body still arrives. A skill carrying prose is a valid skill.
            expect(prompt(bodies[0] ?? {})).toContain("Run the extractor")
        } finally {
            await runtime.stop()
        }
    })

    test("a script's deadline is clamped under the harness's own", async () => {
        const seen: ScriptRunRequest[] = []
        const path = agent({ scripts: { "extract.py": "print(1)" } })
        const runtime = await Runtime.create({
            agents: [path],
            env: ENV,
            fetch: recorder().fetch,
            scriptRunner: {
                has: () => true,
                run: (request) => {
                    seen.push(request)
                    return Promise.resolve({ ok: true, output: "", code: 0, timedOut: false })
                },
            },
        })
        try {
            const skill = runtime
                .agent("test")
                .skills?.skills.find((entry) => entry.name === "pdf-processing")
            expect(skill?.scripts.length).toBe(1)
        } finally {
            await runtime.stop()
        }
    })
})

describe("the cache-stable prefix survives activation", () => {
    test("the leading system message is byte-identical whether a skill activated or not", async () => {
        // Asserted on the wire, not on `assembleContext`'s output. This is the assertion that would have
        // caught a per-turn script entry rendered into slot 1 — which would have worked perfectly and
        // quietly multiplied the bill, because prompt caching has no failure mode that reports itself.
        const { fetch, bodies } = recorder()
        const runtime = await Runtime.create({
            agents: [agent({ scripts: { "extract.py": "print(1)" } })],
            env: ENV,
            fetch,
            scriptRunner: RUNNER,
        })
        try {
            const target = runtime.agent("test")
            await target.send("pull the tables out of this pdf", { sessionKey: "local:a" })
            await target.send("who won the 1998 world cup", { sessionKey: "local:b" })

            const first = leadingSystem(bodies[0] ?? {})
            const second = leadingSystem(bodies[1] ?? {})
            expect(first).toBe(second)
            expect(first.length).toBeGreaterThan(0)
        } finally {
            await runtime.stop()
        }
    })
})

/** Everything up to the first non-system message: slots 0–2, the cached prefix. */
function leadingSystem(body: Record<string, unknown>): string {
    const messages = body.messages
    if (!Array.isArray(messages)) return ""
    const out: string[] = []
    for (const message of messages) {
        const entry = message as { role?: unknown; content?: unknown }
        if (entry.role !== "system") break
        out.push(String(entry.content ?? ""))
    }
    return out.join("\n---\n")
}
