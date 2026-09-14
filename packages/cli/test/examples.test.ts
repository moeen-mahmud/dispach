/**
 * Every example validates, and every command its README documents exists.
 *
 * Phase 11's acceptance is "every example runs as documented", and nothing tested a sentence. The
 * consequence was `telegram-assistant`, which carried *"Incomplete by design, for now — needs the
 * tiered workspace (Phase 3.5) and the Telegram channel (Phase 4)"* for considerably longer than
 * either of those took to build. Both shipped; the note did not move, and a reader has no way to
 * tell a current limitation from a stale one.
 *
 * Validation rather than execution, deliberately: running an example needs a real endpoint and a
 * real key, which is a different kind of test and belongs in `evals/`. What this catches is the
 * class that actually rots — a manifest whose fields drifted out of the schema, a README naming a
 * command that no longer exists, an example whose env file went missing.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { COMMANDS } from "#lib/commands"
import { validateCommand } from "#validate"

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "..", "examples")

/** Directories holding a manifest. `workspace-template` is files to copy, not an agent. */
const WITH_MANIFEST = readdirSync(EXAMPLES).filter(
    (name) =>
        statSync(join(EXAMPLES, name)).isDirectory() &&
        existsSync(join(EXAMPLES, name, "agent.yaml")),
)

/** Run one validate with stdout captured, so a green suite is not a wall of manifest reports. */
async function validateQuietly(manifestPath: string): Promise<{ code: number; output: string }> {
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    // biome-ignore lint/suspicious/noExplicitAny: capturing stdout for one call
    ;(process.stdout as any).write = (chunk: string) => {
        written.push(String(chunk))
        return true
    }
    try {
        const code = await validateCommand({ manifestPath, json: true })
        return { code, output: written.join("") }
    } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restoring
        ;(process.stdout as any).write = original
    }
}

test("the set of examples is what this test thinks it is", () => {
    // A new example added without a manifest would otherwise be silently unexercised — the
    // discovery is a glob, so the guard has to be the count.
    expect(WITH_MANIFEST.sort()).toEqual(["minimal", "reference", "telegram-assistant"])
})

describe("every example validates", () => {
    for (const name of WITH_MANIFEST) {
        test(name, async () => {
            // Keys the manifests name, stubbed. A validator that needed real credentials would be
            // one nobody could run, which is the failure `readManifestHeader` exists to avoid
            // elsewhere.
            const before = { ...process.env }
            process.env.MODEL_API_KEY = "test-key"
            process.env.MODEL_ID = "gpt-4o-mini"
            process.env.MODEL_BASE_URL = "https://api.openai.com/v1"
            process.env.TELEGRAM_BOT_TOKEN = "test-token"
            process.env.DEEPSEEK_API_KEY = "test-key"
            try {
                const { code, output } = await validateQuietly(join(EXAMPLES, name, "agent.yaml"))
                expect({ name, code, ok: output.includes('"ok": true') }).toEqual({
                    name,
                    code: 0,
                    ok: true,
                })
            } finally {
                for (const key of Object.keys(process.env)) delete process.env[key]
                Object.assign(process.env, before)
            }
        })
    }
})

describe("every README documents commands that exist", () => {
    const names = new Set(COMMANDS.map((spec) => spec.name))

    for (const name of readdirSync(EXAMPLES).filter((entry) =>
        statSync(join(EXAMPLES, entry)).isDirectory(),
    )) {
        const readme = join(EXAMPLES, name, "README.md")
        if (!existsSync(readme)) continue

        test(name, () => {
            const text = readFileSync(readme, "utf8")
            // `dispach <command>` anywhere in the prose or the fenced blocks.
            const invoked = [...text.matchAll(/\bdispach\s+([a-z-]+)/g)]
                .map((match) => match[1] ?? "")
                .filter((candidate) => candidate !== "")
            const unknown = [...new Set(invoked)].filter((candidate) => !names.has(candidate))
            expect({ name, unknown }).toEqual({ name, unknown: [] })
        })
    }
})

describe("an example that documents a .env has one to copy", () => {
    for (const name of readdirSync(EXAMPLES).filter((entry) =>
        statSync(join(EXAMPLES, entry)).isDirectory(),
    )) {
        const readme = join(EXAMPLES, name, "README.md")
        if (!existsSync(readme)) continue
        const text = readFileSync(readme, "utf8")
        if (!text.includes(".env.example")) continue

        test(name, () => {
            // `cp .env.example .env` as the first documented step, against a file that is not
            // there, is a README that fails on line one.
            expect(existsSync(join(EXAMPLES, name, ".env.example"))).toBe(true)
        })
    }
})
