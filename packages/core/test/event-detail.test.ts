/**
 * Tool events with `tools.eventDetail: redacted` (pilot.5, VelaCrew #16).
 *
 * Read off the bus inside a real turn, because the redactor crosses the manifest, the agent, the tool
 * runtime and the executor, and a conditional spread anywhere on that path drops it with nothing
 * failing.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { EVENT_OUTPUT_CHARS, eventDetail } from "../src/tools/event-detail.ts"
import type { ToolProviderFactory } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const SECRET = "sk-live-0123456789abcdef"

describe("the redactor", () => {
    const detail = eventDetail({ OPENAI_API_KEY: SECRET, HOME: "/home/x", SHORT_TOKEN: "abc" })

    test("replaces values under secret keys, and secret values anywhere", () => {
        const args = detail.args({
            query: `curl -H "Authorization: Bearer ${SECRET}" https://x`,
            apiKey: "whatever-it-is",
            nested: { password: "hunter22", note: "fine" },
            list: [SECRET],
        })
        expect(JSON.stringify(args)).not.toContain(SECRET)
        expect(args.apiKey).toBe("[redacted]")
        expect((args.nested as Record<string, unknown>).password).toBe("[redacted]")
        expect((args.nested as Record<string, unknown>).note).toBe("fine")
        // A value too short to be a secret by itself is not hunted for in text.
        expect(JSON.stringify(detail.args({ q: "abc" }))).toContain("abc")
    })

    test("caps the output and says so", () => {
        const long = `${SECRET} ${"x".repeat(5000)}`
        const out = detail.output(long)
        expect(out.output.length).toBe(EVENT_OUTPUT_CHARS)
        expect(out.outputTruncated).toBe(true)
        expect(out.output).not.toContain(SECRET)
        expect(detail.output("short").outputTruncated).toBe(false)
    })
})

function manifest(eventDetailLine: string): string {
    const dir = mkdtempSync(join(tmpdir(), "event-detail-"))
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
    external: {}
  pinned: [lookup]
${eventDetailLine}
`,
    )
    return join(dir, "agent.yaml")
}

const external: ToolProviderFactory = () => ({
    id: "external",
    resolve: async (slugs) =>
        slugs.includes("lookup")
            ? [
                  {
                      spec: {
                          slug: "lookup",
                          provider: "external",
                          summary: "Look something up.",
                          whenToUse: "When asked.",
                          whenNotToUse: "Otherwise.",
                          mutating: false,
                          tags: [],
                          parameters: {
                              type: "object",
                              properties: { query: { type: "string" }, token: { type: "string" } },
                          },
                      },
                      handler: () => `found it, and the key is ${SECRET}`,
                  },
              ]
            : [],
})

async function turnEvents(eventDetailLine: string): Promise<AnyEvent[]> {
    let call = 0
    const fetch: FetchLike = async () => {
        call += 1
        const content =
            call === 1 ? `ACTION: lookup\nquery: plans for ${SECRET}\ntoken: tok-xyz\nEND` : "Done."
        const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
        return new Response(`${frame}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
        })
    }
    const runtime = await Runtime.create({
        agents: [manifest(eventDetailLine)],
        env: { MODEL_API_KEY: "k", SERVICE_TOKEN: SECRET },
        fetch,
        toolProviders: { external },
    })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))
    await runtime.agent("test")?.send("look it up", { sessionKey: "api:e" })
    await runtime.stop()
    return events
}

describe("inside a real turn", () => {
    test("redacted: the call's arguments and the output reach subscribers, without the secret", async () => {
        const events = await turnEvents("  eventDetail: redacted")
        const call = events.find((event) => event.type === "tool.call")?.data as {
            args?: Record<string, unknown>
        }
        const result = events.find((event) => event.type === "tool.result")?.data as {
            output?: string
            outputTruncated?: boolean
        }
        expect(call.args?.query).toBe("plans for [redacted]")
        expect(call.args?.token).toBe("[redacted]")
        expect(result.output).toBe("found it, and the key is [redacted]")
        expect(result.outputTruncated).toBe(false)
    })

    test("the default carries neither, exactly as before", async () => {
        const events = await turnEvents("")
        const call = events.find((event) => event.type === "tool.call")?.data as Record<
            string,
            unknown
        >
        const result = events.find((event) => event.type === "tool.result")?.data as Record<
            string,
            unknown
        >
        expect(Object.keys(call).sort()).toEqual(["argsHash", "callId", "mutating", "slug"])
        expect(Object.keys(result).includes("output")).toBe(false)
    })
})
