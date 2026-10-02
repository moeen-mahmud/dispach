/**
 * `POST …/schedules/:sid/run` runs the schedule as the scheduler would (pilot.5, #15). A manual run is
 * how a schedule is tested, and the route used to send the role and nothing else: found in the image,
 * where a run limited to `now` showed the model `memory_write` too.
 */

import { afterAll, expect, test } from "bun:test"
import { cleanupWorkspaces, harness, PINNED_MANIFEST, replyFetch } from "./harness.ts"

afterAll(cleanupWorkspaces)

test("a manual run gets the schedule's tools.allow", async () => {
    const bodies: string[] = []
    const inner = replyFetch("It is noon.")
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""))
        return inner(url, init)
    }) as typeof globalThis.fetch
    const { runtime, call } = await harness({ fetch, manifest: PINNED_MANIFEST })
    const created = await call("POST", "/v1/agents/assistant/schedules", {
        body: {
            id: "brief",
            kind: "every",
            expr: "1h",
            task: "Say the time.",
            deliver: "none",
            tools: { allow: ["now"] },
        },
    })
    expect(created.status).toBe(201)
    expect((await call("POST", "/v1/agents/assistant/schedules/brief/run")).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(bodies[0]).toContain("now")
    expect(bodies[0]).not.toContain("memory_write")
    await runtime.stop()
})
