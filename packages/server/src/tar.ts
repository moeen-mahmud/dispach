/**
 * A gzipped tar, streamed: what `GET /v1/backup` answers with.
 *
 * Written here rather than taken from a dependency because it is small and fixed: regular files only,
 * POSIX ustar headers, and a PAX `path` record in front of any name ustar's 100-byte field cannot hold.
 * GNU tar, bsdtar and every library reader take that. Read one file at a time, so a large store is
 * never held in memory whole.
 */

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import { createGzip } from "node:zlib"

export interface TarEntry {
    /** The path inside the archive, `/`-separated, no leading slash. */
    readonly name: string
    /**
     * Bytes in hand, or a file on disk. A file's header carries the size `stat` reported and exactly
     * that many bytes follow: one that grew while it was read is cut there, one that shrank is padded
     * with zeros, so a file being written cannot corrupt the archive, only its own entry.
     */
    readonly source: { readonly path: string } | { readonly bytes: Uint8Array }
}

const BLOCK = 512

function octal(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, "0")}\0`
}

function header(name: string, size: number, mtime: number, type: "0" | "x"): Uint8Array {
    const block = new Uint8Array(BLOCK)
    const put = (text: string, offset: number) => {
        block.set(new TextEncoder().encode(text), offset)
    }
    put(name.slice(0, 100), 0)
    put(octal(0o644, 8), 100)
    put(octal(0, 8), 108)
    put(octal(0, 8), 116)
    put(octal(size, 12), 124)
    put(octal(Math.floor(mtime / 1000), 12), 136)
    put("        ", 148)
    put(type, 156)
    put("ustar\0", 257)
    put("00", 263)
    let sum = 0
    for (const byte of block) sum += byte
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
    return block
}

/** A PAX record for a path ustar cannot hold, then the real header with a truncated name. */
function headers(name: string, size: number, mtime: number): Uint8Array[] {
    if (new TextEncoder().encode(name).length <= 100) return [header(name, size, mtime, "0")]
    const body = (length: number) => `${length} path=${name}\n`
    let record = body(0)
    // The record's length counts its own digits, so settle it.
    for (let length = record.length; ; length = record.length) {
        record = body(new TextEncoder().encode(body(length)).length)
        if (new TextEncoder().encode(record).length === length) break
    }
    const bytes = new TextEncoder().encode(record)
    return [
        header("PaxHeader", bytes.length, mtime, "x"),
        ...padded(bytes),
        header(name, size, mtime, "0"),
    ]
}

function padded(bytes: Uint8Array): Uint8Array[] {
    const rest = bytes.length % BLOCK
    return rest === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - rest)]
}

async function* blocks(
    entries: readonly TarEntry[],
    onDone: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
    try {
        yield* entriesOf(entries)
    } finally {
        await onDone()
    }
}

/** Exported for its test: the blocks, before gzip. */
export async function* entriesOf(entries: readonly TarEntry[]): AsyncGenerator<Uint8Array> {
    for (const entry of entries) {
        if ("bytes" in entry.source) {
            yield* headers(entry.name, entry.source.bytes.length, Date.now())
            yield* padded(entry.source.bytes)
            continue
        }
        const info = await stat(entry.source.path)
        yield* headers(entry.name, info.size, info.mtimeMs)
        let written = 0
        if (info.size > 0) {
            for await (const chunk of createReadStream(entry.source.path, { end: info.size - 1 })) {
                const bytes = chunk as Uint8Array
                written += bytes.length
                yield bytes
            }
        }
        if (written < info.size) yield new Uint8Array(info.size - written)
        if (info.size % BLOCK !== 0) yield new Uint8Array(BLOCK - (info.size % BLOCK))
    }
    // Two empty blocks end an archive.
    yield new Uint8Array(BLOCK * 2)
}

/** The archive as a web stream, gzipped. */
export function tarGz(
    entries: readonly TarEntry[],
    onDone: () => Promise<void> = async () => {},
): ReadableStream<Uint8Array> {
    const gzip = Readable.from(blocks(entries, onDone)).pipe(createGzip())
    return Readable.toWeb(gzip) as ReadableStream<Uint8Array>
}
