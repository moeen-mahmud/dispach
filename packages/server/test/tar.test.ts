/**
 * A file that changes size between its header and its read cannot corrupt the archive (pilot.11):
 * the entry holds exactly the size the header says, cut or zero-padded.
 */

import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { entriesOf } from "../src/tar.ts"

async function blocksWhile(change: (path: string) => void, initial: string) {
    const path = join(mkdtempSync(join(tmpdir(), "tar-")), "f.txt")
    writeFileSync(path, initial)
    const out: Uint8Array[] = []
    let first = true
    for await (const chunk of entriesOf([{ name: "f.txt", source: { path } }])) {
        out.push(chunk)
        // The header has been written from `stat`; now the file moves under it.
        if (first) change(path)
        first = false
    }
    const all = new Uint8Array(out.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of out) {
        all.set(chunk, at)
        at += chunk.length
    }
    return all
}

describe("tar", () => {
    test("a file that grows mid-read is cut at its stated size", async () => {
        const all = await blocksWhile((path) => appendFileSync(path, "x".repeat(2000)), "hello")
        // header + one data block + the two closing blocks
        expect(all.length).toBe(512 * 4)
        expect(new TextDecoder().decode(all.subarray(512, 517))).toBe("hello")
        expect(all[517]).toBe(0)
    })

    test("a file that shrinks mid-read is padded to its stated size", async () => {
        const all = await blocksWhile((path) => truncateSync(path, 2), "x".repeat(700))
        expect(all.length).toBe(512 * 5)
        expect(all.subarray(512 + 2, 512 + 700).every((byte) => byte === 0)).toBe(true)
    })
})
