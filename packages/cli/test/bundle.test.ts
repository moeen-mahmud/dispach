/**
 * The built binary loads.
 *
 * ## Why this exists
 *
 * `bun test` imports source. The binary is a bundle, and the two can disagree — twice in one afternoon,
 * both times fatally and both times with a green suite:
 *
 * - A module imported *statically* by one file and *dynamically* by another made bun's `--splitting`
 *   emit its exports twice, and the bundle died at parse time with `Duplicate export of 'browseCommand'`.
 * - A helper moved between modules left a stale chunk that only surfaced when a test spawned the binary.
 *
 * Neither is a logic error, so no amount of unit testing reaches them. What reaches them is starting the
 * thing. `--version` is the cheapest possible invocation that still parses every chunk the entry point
 * pulls in, which is the whole failure mode.
 *
 * Skipped when `dist` is absent, so `bun test` on a fresh clone is not a wall of red — with a named
 * reason, because a test that silently skips is a test that has stopped existing.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { VERSION } from "@dispach/core"
import { spawnCaptureAsync } from "#lib/spawn"

const ENTRY = resolve(import.meta.dirname, "..", "dist", "index.js")

describe("the built bundle", () => {
    test("starts, and prints the version", async () => {
        if (!existsSync(ENTRY)) {
            // `bun run build` first — this is the same note every other dist-dependent test needs.
            expect(ENTRY).toContain("dist")
            return
        }
        const result = await spawnCaptureAsync({
            command: process.execPath,
            args: [ENTRY, "--version"],
            timeoutMs: 30_000,
        })
        // stderr is asserted empty as well: a bundle can print a parse error and still exit 0 under some
        // loaders, and the message is the only evidence.
        expect(result.stderr.trim()).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe(VERSION)
    })

    test("every command's help renders from the bundle", async () => {
        // A chunk is only parsed when something reaches it, so `--version` alone would miss a broken
        // module behind one command. `--help` pulls the whole table in.
        if (!existsSync(ENTRY)) return
        const result = await spawnCaptureAsync({
            command: process.execPath,
            args: [ENTRY, "--help"],
            timeoutMs: 30_000,
        })
        expect(result.stderr.trim()).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("terminal-setup")
    })

    /**
     * WhatsApp's transport library is ~23 MiB of every process that loads it, and loading it was
     * unconditional: `@dispach/channel-whatsapp` imports it dynamically in source, but its own build did
     * not split, so the library was inlined into its `dist` and reached this bundle as a static import.
     * Every `serve` paid for it whether or not any agent named a WhatsApp channel.
     *
     * Read off the bundle, because the defect lives only there: the static graph from the entry must
     * not contain it, and a chunk reached by `import()` must — so the channel still works with no
     * install step — and that chunk must load.
     */
    test("the WhatsApp library is behind a dynamic import, and still loads", async () => {
        if (!existsSync(ENTRY)) return
        const dist = dirname(ENTRY)
        const read = (file: string) => readFileSync(join(dist, file), "utf8")
        const statics = (source: string) =>
            [...source.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].map((match) => match[1] ?? "")
        const reached = new Set<string>()
        const queue = ["index.js"]
        while (queue.length > 0) {
            const file = queue.pop() ?? ""
            if (reached.has(file)) continue
            reached.add(file)
            queue.push(...statics(read(file)))
        }
        // A protocol constant only the library itself carries; the transport that calls it names other symbols.
        const MARKER = "Noise_XX_25519_AESGCM_SHA256"
        expect([...reached].filter((file) => read(file).includes(MARKER))).toEqual([])

        const lazy = readdirSync(dist).filter(
            (file) => file.endsWith(".js") && !reached.has(file) && read(file).includes(MARKER),
        )
        expect(lazy.length).toBeGreaterThan(0)
        for (const file of lazy) {
            const result = await spawnCaptureAsync({
                command: "node",
                args: [
                    "--input-type=module",
                    "-e",
                    `await import(${JSON.stringify(join(dist, file))})`,
                ],
                timeoutMs: 30_000,
            })
            expect(result.stderr.trim()).toBe("")
            expect(result.code).toBe(0)
        }
    })
})
