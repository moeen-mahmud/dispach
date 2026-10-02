/** `POST /v1/agents/:id/tools/refresh` (pilot.5, VelaCrew #20). The mechanics are core's test. */

import { afterAll, expect, test } from "bun:test"
import { cleanupWorkspaces, harness, PINNED_MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

test("a bare POST refreshes every provider and reloads nothing when nothing moved", async () => {
    const { runtime, call } = await harness({ manifest: PINNED_MANIFEST })
    const before = runtime.agent("assistant")
    const response = await call("POST", "/v1/agents/assistant/tools/refresh")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { reload: string; added: string[] }
    expect(body.reload).toBe("none")
    expect(body.added).toEqual([])
    expect(runtime.agent("assistant")).toBe(before)

    const unknown = await call("POST", "/v1/agents/assistant/tools/refresh", {
        body: { providers: ["composio"] },
    })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        "tools_refresh_provider_unknown",
    )
    await runtime.stop()
})
