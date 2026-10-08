/**
 * An agent that will not load is still reachable over the API (pilot.15, VelaCrew): diagnosed by
 * `GET /v1/agents/:id`, repaired through its config and workspace files, then started. It used to
 * answer 404 on every route, so only a shell inside the container could fix it.
 */

import { afterAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

const WITH_SOUL = `${MANIFEST}context:
  workspace: ./workspace
  static:
    - SOUL.md
  budgets:
    static: 200
`
const SMALL = "---\ntier: static\n---\nI am the assistant.\n"
const HUGE = `---\ntier: static\n---\n${"word ".repeat(2000)}\n`

type Body = Record<string, unknown> & { error?: { code: string } }

test("a broken agent is diagnosed, repaired over the API, and started", async () => {
    let file = ""
    const { call, runtime, dir } = await harness({
        manifest: WITH_SOUL,
        files: { "workspace/SOUL.md": SMALL },
        resolveAgent: (id) => (id === "assistant" ? file : undefined),
    })
    file = join(dir, "agent.yaml")
    const soul = join(dir, "workspace", "SOUL.md")
    const put = (content: string) =>
        call("PUT", "/v1/agents/assistant/workspace/SOUL.md", { body: { content } })

    // Running: a write that would stop it loading is refused and the old text stays.
    const refused = await put(HUGE)
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as Body).error?.code).toBe("workspace_budget_exceeded")
    expect(readFileSync(soul, "utf8")).toBe(SMALL)

    // Broken behind its back, as a template change did, and no longer hosted.
    writeFileSync(soul, HUGE)
    await runtime.dispose("assistant")
    const broken = (await (await call("GET", "/v1/agents/assistant")).json()) as Body
    expect(broken.status).toBe("failed")
    expect(broken.error?.code).toBe("workspace_budget_exceeded")

    // Raising the budget is one way back, and it says the agent is not running yet.
    const raised = (await (
        await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "context.budgets.static", value: "5000" },
        })
    ).json()) as Body
    expect(raised).toMatchObject({ changed: true, applied: false })
    expect((raised.pending as { code: string }).code).toBe("agent_not_running")
    expect(((await (await call("GET", "/v1/agents/assistant")).json()) as Body).status).toBe(
        "not_running",
    )

    // Rewriting the file is the other, and an unknown file is refused.
    const fixed = (await (await put(SMALL)).json()) as Body
    expect(fixed).toMatchObject({ written: true, loads: true, applied: false })
    expect(
        (await call("PUT", "/v1/agents/assistant/workspace/agent.yaml", { body: { content: "x" } }))
            .status,
    ).toBe(404)

    const started = await call("POST", "/v1/agents/assistant/start")
    expect(started.status).toBe(200)
    expect(runtime.list().some((agent) => agent.id === "assistant")).toBe(true)
    await runtime.stop()
})
