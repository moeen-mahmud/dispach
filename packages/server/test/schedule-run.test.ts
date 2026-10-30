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

test("a PATCH of one field keeps every other field the schedule was written with", async () => {
    /**
     * The route rebuilds the whole schedule from the stored row before validating, and a field that
     * rebuild did not name was erased by a patch that never mentioned it: `{expr: "1m"}` dropped
     * `timeoutMs`, `maxSteps` and `tools`, found live. So the fixture sets every optional field the
     * write accepts, and the assertion is that nothing but the patched field moved.
     */
    const manifest = PINNED_MANIFEST.replace(
        "    apiKeyEnv: MODEL_API_KEY\n",
        "    apiKeyEnv: MODEL_API_KEY\n  fast:\n    id: gpt-4o-mini\n    baseUrl: https://api.example.com/v1\n    apiKeyEnv: MODEL_API_KEY\n",
    )
    const { runtime, call } = await harness({ manifest })
    const created = await call("POST", "/v1/agents/assistant/schedules", {
        body: {
            id: "full",
            kind: "cron",
            expr: "0 9 * * *",
            timezone: "Asia/Dhaka",
            task: "Digest",
            deliver: "none",
            session: "shared",
            role: "fast",
            tools: { allow: ["now"] },
            timeoutMs: 90_000,
            maxSteps: 12,
        },
    })
    expect(created.status).toBe(201)
    const before = (await created.json()) as Record<string, unknown>
    const patched = await call("PATCH", "/v1/agents/assistant/schedules/full", {
        body: { expr: "0 10 * * *" },
    })
    expect(patched.status).toBe(200)
    const after = (await patched.json()) as Record<string, unknown>
    const kept = (row: Record<string, unknown>) => {
        const {
            expr: _expr,
            nextRunAt: _next,
            anchorAt: _anchor,
            updatedAt: _updated,
            ...rest
        } = row
        return rest
    }
    expect(kept(after)).toEqual(kept(before))
    expect(after.expr).toBe("0 10 * * *")
    await runtime.stop()
})
