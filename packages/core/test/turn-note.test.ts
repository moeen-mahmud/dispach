/**
 * The embedder's note about one message (pilot.5, VelaCrew #13).
 *
 * VelaCrew prepended its context block to the text, so it was stored as if the person typed it and the
 * model quoted it back as theirs. Read off request bodies and the store, because the field crosses
 * `Agent.send`, `TurnInput`, assembly and the turn row.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { NOTE_HEADER } from "../src/context/blocks.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const NOTE = "Project: Website Relaunch (id p_42)\nToday is 2026-10-02, Asia/Dhaka"

function manifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "turn-note-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`,
    )
    return join(dir, "agent.yaml")
}

describe("a turn note", () => {
    test("reaches the model as its own block before the text, this turn only, and is never history", async () => {
        const bodies: { messages: { role: string; content: string }[] }[] = []
        const fetch: FetchLike = async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body ?? "{}")))
            const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: "On it." } }] })}\n\n`
            return new Response(`${frame}data: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            })
        }
        const runtime = await Runtime.create({
            agents: [manifest()],
            env: { MODEL_API_KEY: "k" },
            fetch,
        })
        const agent = runtime.agent("test")
        const first = await agent?.send("what's next?", { sessionKey: "api:n", turnNote: NOTE })
        await agent?.send("and after that?", { sessionKey: "api:n" })

        const messages = bodies[0]?.messages ?? []
        const note = messages.at(-2)
        expect(note?.role).toBe("system")
        expect(note?.content).toBe(`${NOTE_HEADER}\n\n${NOTE}`)
        expect(messages.at(-1)).toEqual({ role: "user", content: "what's next?" })

        // The next turn carries no note, and history never held one.
        expect(JSON.stringify(bodies[1])).not.toContain("Website Relaunch")
        const history = await agent?.store.messages.history("test", "api:n")
        expect(JSON.stringify(history)).not.toContain("Website Relaunch")
        // Kept on the turn record, for debugging and replay.
        expect((await agent?.store.turns.get(first?.turnId ?? ""))?.note).toBe(NOTE)
        await runtime.stop()
    })
})
