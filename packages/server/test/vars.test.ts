/**
 * `PATCH /v1/agents/:id/vars` (pilot.5, VelaCrew #21). The re-render itself is the CLI's test; this
 * proves the route: the gate, the reload, and that a result the agent refuses is put back.
 */

import { afterAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Provisioner } from "../src/handler.ts"
import { cleanupWorkspaces, harness, TOKEN } from "./harness.ts"

afterAll(cleanupWorkspaces)

function provisioner(rerender: NonNullable<Provisioner["rerender"]>): Provisioner {
    const unused = () => {
        throw new Error("not used here")
    }
    return {
        steps: () => [],
        create: unused,
        templates: () => [],
        createFromTemplate: unused,
        rerender,
    }
}

test("without a re-renderer the route says so", async () => {
    const { runtime, call } = await harness()
    const response = await call("PATCH", "/v1/agents/assistant/vars", {
        body: { vars: { a: "b" } },
    })
    expect(response.status).toBe(501)
    await runtime.stop()
})

test("rewritten files reload the agent, and nothing rewritten reloads nothing", async () => {
    let rendered: string[] = ["workspace/USER.md"]
    const { runtime, call } = await harness({
        token: TOKEN,
        provision: provisioner(() => ({ rendered, skipped: [], undo: () => {} })),
    })
    const before = runtime.agent("assistant")
    const first = await call("PATCH", "/v1/agents/assistant/vars", { body: { vars: { a: "b" } } })
    expect(first.status).toBe(200)
    expect(((await first.json()) as { reload: string }).reload).toBe("loaded")
    expect(runtime.agent("assistant")).not.toBe(before)

    rendered = []
    const second = await call("PATCH", "/v1/agents/assistant/vars", { body: { vars: { a: "c" } } })
    expect(((await second.json()) as { reload: string }).reload).toBe("none")
    await runtime.stop()
})

test("a result the agent will not load is put back, and the refusal is returned", async () => {
    let path = ""
    let original = ""
    const { runtime, call } = await harness({
        token: TOKEN,
        provision: provisioner(({ agentDir }) => {
            path = join(agentDir, "agent.yaml")
            original = readFileSync(path, "utf8")
            writeFileSync(path, "apiVersion: dispach/v1\nid: assistant\nmodel: not-a-map\n")
            return {
                rendered: ["agent.yaml"],
                skipped: [],
                undo: () => writeFileSync(path, original),
            }
        }),
    })
    const response = await call("PATCH", "/v1/agents/assistant/vars", {
        body: { vars: { a: "b" } },
    })
    expect(response.status).toBe(400)
    expect(readFileSync(path, "utf8")).toBe(original)
    // Still serving the instance it had.
    expect(runtime.agent("assistant")).toBeDefined()
    await runtime.stop()
})

test("an unauthenticated network-reachable server may not rewrite files", async () => {
    const { runtime, call } = await harness({
        provision: provisioner(() => ({ rendered: [], skipped: [], undo: () => {} })),
    })
    const response = await call("PATCH", "/v1/agents/assistant/vars", {
        body: { vars: { a: "b" } },
    })
    expect(response.status).toBe(403)
    await runtime.stop()
})
