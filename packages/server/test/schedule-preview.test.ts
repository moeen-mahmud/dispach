/**
 * `GET …/schedules/preview` answers what an expression means with core's own parser, so a form can
 * show the next runs before the write and a refusal reads exactly as the write's would.
 */

import { afterAll, expect, test } from "bun:test"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

test("a cron preview lists ascending instants in the asked zone; every and at too", async () => {
    const { runtime, call } = await harness({ manifest: MANIFEST })
    const cron = await call(
        "GET",
        "/v1/agents/assistant/schedules/preview?kind=cron&expr=0%208%20*%20*%20*&timezone=Asia/Dhaka&count=3",
    )
    expect(cron.status).toBe(200)
    const body = (await cron.json()) as { zone: string; next: string[]; jitterMs: number }
    expect(body.zone).toBe("Asia/Dhaka")
    expect(body.next).toHaveLength(3)
    const times = body.next.map((iso) => Date.parse(iso))
    expect(times[1]).toBeGreaterThan(times[0] ?? 0)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(86_400_000)
    // 08:00 Dhaka is 02:00 UTC.
    expect(body.next[0]?.endsWith("T02:00:00.000Z")).toBe(true)

    const every = (await (
        await call("GET", "/v1/agents/assistant/schedules/preview?kind=every&expr=15m&count=2")
    ).json()) as { next: string[] }
    expect(every.next).toHaveLength(2)

    const at = (await (
        await call(
            "GET",
            "/v1/agents/assistant/schedules/preview?kind=at&expr=2030-01-01T00:00:00Z",
        )
    ).json()) as { next: string[] }
    expect(at.next).toEqual(["2030-01-01T00:00:00.000Z"])
    await runtime.stop()
})

test("a bad expression is the write's own refusal, hint included, and is not a schedule id", async () => {
    const { runtime, call } = await harness({ manifest: MANIFEST })
    const bad = await call("GET", "/v1/agents/assistant/schedules/preview?kind=cron&expr=nope")
    expect(bad.status).toBe(400)
    const error = (await bad.json()) as { error: { code: string; hint: string } }
    expect(error.error.hint.length).toBeGreaterThan(0)
    expect(error.error.code).not.toBe("schedule_not_found")
    await runtime.stop()
})
