/**
 * A cut observation keeps its whole text, and its marker names the id to read it with (pilot.5).
 *
 * VelaCrew's field report: a project plan over `observationMaxTokens` lost its middle, where its ids
 * were, and the marker only said how many characters were cut. The model re-ran the call until
 * `no_progress`. Compaction's markers already named an id; this is the same pointer one step earlier.
 *
 * The second half is the trust of the read-back. `artifact_read` is a trusted local tool, so before
 * this an untrusted observation read through it cleared the turn's taint, and the write gate with it.
 */

import { type Displaced, displacedId } from "../src/context/compaction/stages.ts"
import { EventBus } from "../src/events/bus.ts"
import { executeIntents } from "../src/tools/execute.ts"
import { localProvider, toolContext } from "../src/tools/local.ts"
import { DEFAULT_POLICY } from "../src/tools/policy.ts"
import { ToolRegistry } from "../src/tools/registry.ts"
import { wrapUntrusted } from "../src/tools/trust.ts"
import type { Tool, ToolIntent, ToolProvider } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const LONG = `HEAD ${"row ".repeat(3000)}MIDDLE-ID-42 ${"row ".repeat(3000)}TAIL`

function fetcher(trust: "trusted" | "untrusted"): ToolProvider {
    const tool: Tool = {
        spec: {
            slug: "plan_fetch",
            provider: "fake",
            summary: "Fetches a plan.",
            whenToUse: "testing",
            whenNotToUse: "not testing",
            mutating: false,
            tags: [],
            parameters: { type: "object", properties: {} },
            trust,
            ...(trust === "trusted" ? { trustReason: "a test fixture" } : {}),
        },
        handler: () => LONG,
    }
    return {
        id: "fake",
        resolve: (slugs) => Promise.resolve(slugs.includes("plan_fetch") ? [tool] : []),
        list: () => Promise.resolve(["plan_fetch"]),
    }
}

async function setup(trust: "trusted" | "untrusted", local: readonly string[] = ["artifact_read"]) {
    const registry = await ToolRegistry.create({
        pinned: ["plan_fetch"],
        local,
        providers: [fetcher(trust)],
    })
    const stored = new Map<string, Displaced>()
    const run = (intent: ToolIntent, keep = true) =>
        executeIntents({
            registry,
            intents: [intent],
            context: toolContext({
                readArtifact: (id) => Promise.resolve(stored.get(id)),
            }),
            bus: new EventBus({ runtimeId: "rt_test" }),
            eventContext: { agentId: "a", sessionKey: "s", turnId: "t" },
            timeoutMs: 1000,
            maxParallel: 4,
            untrustedInTurn: false,
            onMutate: "refuse",
            policy: { ...DEFAULT_POLICY, mode: "allow" },
            observationMaxTokens: 500,
            ...(keep
                ? {
                      keepFull: (artifacts: readonly Displaced[]) => {
                          for (const artifact of artifacts) stored.set(artifact.id, artifact)
                          return Promise.resolve()
                      },
                  }
                : {}),
        })
    return { run, stored }
}

function idIn(text: string): string {
    const match = /artifact_read\("([^"]+)"\)/.exec(text)
    if (match?.[1] === undefined) throw new Error(`no id in: ${text.slice(0, 200)}`)
    return match[1]
}

describe("a cut observation", () => {
    test("names an id that reads back the whole result, middle included", async () => {
        const { run, stored } = await setup("trusted")
        const first = await run({ slug: "plan_fetch", args: {}, callId: "c1" })
        const cut = first.results[0]
        expect(cut?.truncated).toBe(true)
        expect(cut?.output).not.toContain("MIDDLE-ID-42")

        const id = idIn(cut?.output ?? "")
        expect(stored.get(id)?.content).toBe(LONG)
        expect(stored.get(id)?.slug).toBe("plan_fetch")

        const back = await run({ slug: "artifact_read", args: { id }, callId: "c2" })
        expect(back.results[0]?.ok).toBe(true)
        expect(back.results[0]?.output).toContain("HEAD")
        expect(back.results[0]?.trust).toBe("trusted")
    })

    test("an untrusted one reads back untrusted, so the write gate stays closed", async () => {
        const { run } = await setup("untrusted")
        const first = await run({ slug: "plan_fetch", args: {}, callId: "c1" })
        const id = idIn(first.results[0]?.output ?? "")
        expect(id.startsWith("obu_")).toBe(true)

        const back = await run({ slug: "artifact_read", args: { id }, callId: "c2" })
        expect(back.results[0]?.trust).toBe("untrusted")
    })

    test("with no artifact_read in the catalogue the marker names no tool the agent lacks", async () => {
        const { run, stored } = await setup("trusted", [])
        const first = await run({ slug: "plan_fetch", args: {}, callId: "c1" })
        expect(first.results[0]?.truncated).toBe(true)
        expect(first.results[0]?.output).not.toContain("artifact_read")
        expect(stored.size).toBe(0)
    })

    test("with no store the marker is the old one", async () => {
        const { run } = await setup("trusted")
        const first = await run({ slug: "plan_fetch", args: {}, callId: "c1" }, false)
        expect(first.results[0]?.output).toContain("characters cut from the middle")
        expect(first.results[0]?.output).not.toContain("artifact_read")
    })
})

describe("compaction's ids carry trust too", () => {
    test("a fenced untrusted observation is stored under obu_, a plain one under obs_", async () => {
        // `snip` and `micro` store the message as it sat in history, fence included, so the fence is
        // the only record of its trust left by then.
        expect(
            displacedId(
                `OBSERVATION web_fetch — ok\n${wrapUntrusted("web_fetch", "x".repeat(400))}`,
            ),
        ).toMatch(/^obu_/)
        expect(displacedId("OBSERVATION exec — ok\nplain")).toMatch(/^obs_/)

        const [read] = await localProvider().resolve(["artifact_read"])
        expect(read?.trustOf?.({ id: "obu_1_abc" })).toBe("untrusted")
        expect(read?.trustOf?.({ id: "obs_1_abc" })).toBe("trusted")
    })
})
