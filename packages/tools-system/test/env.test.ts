/**
 * What a child process sees of the environment (pilot.9): `exec` and a skill's scripts, through the
 * plugin's own setup, so the provider and the runner it registers are proven to share one policy.
 */

import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    type PluginContext,
    type ScriptRunner,
    type ToolProviderFactory,
    toolContext,
} from "@dispach/core"
import plugin from "../src/index.ts"

const ENV = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    LC_ALL: "C",
    DISPACH_API_TOKEN: "runtime-secret",
    GITHUB_TOKEN: "gh-token",
}

async function boot(config: Record<string, unknown>) {
    let factory: ToolProviderFactory | undefined
    let runner: ScriptRunner | undefined
    const context = {
        env: ENV,
        defineToolProvider: (_id: string, made: ToolProviderFactory) => {
            factory = made
        },
        defineScriptRunner: (made: ScriptRunner) => {
            runner = made
        },
    } as unknown as PluginContext
    await plugin.setup(context)
    const dir = mkdtempSync(join(tmpdir(), "env-"))
    const provider = await factory?.({ dir, env: ENV, config, agentId: "a" })
    const [exec] = (await provider?.resolve(["exec"])) ?? []
    const viaExec = String(
        await exec?.handler({ command: "env" }, toolContext({ agentId: "a", dir })),
    )
    const viaScript =
        (
            await runner?.run({
                command: "sh",
                args: ["-c", "env"],
                cwd: dir,
                timeoutMs: 5000,
                signal: new AbortController().signal,
            })
        )?.output ?? ""
    return { viaExec, viaScript }
}

test("by default a command still sees the whole environment, as before", async () => {
    const { viaExec, viaScript } = await boot({})
    expect(viaExec).toContain("DISPACH_API_TOKEN=runtime-secret")
    expect(viaScript).toContain("DISPACH_API_TOKEN=runtime-secret")
})

test("env: scrub keeps the runtime's secrets out of exec and skill scripts alike", async () => {
    const { viaExec, viaScript } = await boot({ env: "scrub" })
    for (const out of [viaExec, viaScript]) {
        expect(out).not.toContain("runtime-secret")
        expect(out).not.toContain("gh-token")
        expect(out).toContain("HOME=/tmp")
        expect(out).toContain("LC_ALL=C")
    }
})

test("a list scrubs and passes the names it gives", async () => {
    const { viaExec, viaScript } = await boot({ env: ["GITHUB_TOKEN"] })
    for (const out of [viaExec, viaScript]) {
        expect(out).toContain("GITHUB_TOKEN=gh-token")
        expect(out).not.toContain("runtime-secret")
    }
})

test("anything else is refused at load, naming the field", async () => {
    await expect(boot({ env: "none" })).rejects.toThrow(/tools.providers.system.env/)
})
