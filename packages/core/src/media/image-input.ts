/**
 * Images sent with a message (pilot.5, #12): read, checked, and handed to a transport as base64.
 *
 * **A path, preferably.** An embedder has usually already saved the upload inside the agent's
 * directory, so `{path}` keeps the request small and the bytes where they are. The path is relative
 * to the agent's directory and must stay inside it once symlinks are resolved: the same rule a write
 * root uses, applied to a read the caller chooses. Inline `{data, mediaType}` is the fallback.
 *
 * **The bytes decide the type.** PNG, JPEG, GIF and WebP are what Bedrock's `ImageBlock` and the
 * OpenAI-compatible `image_url` both take, and each is recognised by its magic bytes. A file that is
 * none of them is refused without its content reaching anyone, which is also why a path that happens
 * to name `.env` gets nowhere.
 *
 * The caps are the strictest documented ones: 3.75 MB per image (Claude on Bedrock) and five per
 * message, which keeps a request under Nova's 25 MB payload.
 */

import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"
import { imageRefused } from "../errors.ts"
import type { ImageInput } from "../model/provider.ts"

export const MAX_IMAGE_BYTES = 3_932_160
export const MAX_IMAGES_PER_MESSAGE = 5
/**
 * What one image is assumed to cost in prompt tokens. The estimate cannot see pixels, and Claude
 * bills an image near this at its documented maximum size; an underestimate is the direction that
 * overflows, so this is the high end.
 */
export const IMAGE_TOKENS = 1600

/** As a caller sends it; parsed JSON leaves an absent field `undefined`. */
export interface ImageSpec {
    readonly path?: string | undefined
    readonly data?: string | undefined
    readonly mediaType?: string | undefined
}

type MediaType = ImageInput["mediaType"]

export function sniffImage(bytes: Uint8Array): MediaType | undefined {
    const at = (i: number) => bytes[i] ?? -1
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png"
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg"
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif"
    const riff = at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    const webp = at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
    if (riff && webp) return "image/webp"
    return undefined
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Every image of one message, or a refusal naming the first that is wrong. */
export async function readImages(
    agentDir: string,
    specs: readonly ImageSpec[],
): Promise<ImageInput[]> {
    if (specs.length > MAX_IMAGES_PER_MESSAGE) {
        throw imageRefused(
            "image_count_exceeded",
            `${specs.length} images were sent with one message; at most ${MAX_IMAGES_PER_MESSAGE} are.`,
            "Send the rest in a following message.",
        )
    }
    const images: ImageInput[] = []
    for (const [index, spec] of specs.entries()) {
        images.push(await readImage(agentDir, spec, `images[${index}]`))
    }
    return images
}

async function readImage(agentDir: string, spec: ImageSpec, field: string): Promise<ImageInput> {
    if (spec.path !== undefined && spec.data !== undefined) {
        throw imageRefused(
            "image_source_ambiguous",
            "An image named both a path and inline data.",
            'Send one: { "path": "files/…/shot.png" }, or { "data": "<base64>", "mediaType": "image/png" }.',
            field,
        )
    }
    if (spec.path !== undefined) return await fromPath(agentDir, spec.path, field)
    if (spec.data !== undefined) return fromData(spec.data, spec.mediaType, field)
    throw imageRefused(
        "image_source_missing",
        "An image named neither a path nor data.",
        'Send { "path": "files/…/shot.png" } (relative to the agent\'s directory), or { "data": "<base64>", "mediaType": "image/png" }.',
        field,
    )
}

async function fromPath(agentDir: string, path: string, field: string): Promise<ImageInput> {
    if (path.trim() === "" || isAbsolute(path)) {
        throw imageRefused(
            "image_path_invalid",
            `The image path "${path}" is not relative to the agent's directory.`,
            "Name the file relative to the agent's directory, e.g. files/<conversation>/shot.png.",
            field,
        )
    }
    // Lexically first, before the filesystem is touched: a path that names something outside the
    // directory is refused the same way whether or not that thing exists, so the refusal cannot be
    // used to probe which files exist on the host.
    const lexical = resolve(agentDir, path)
    const base = resolve(agentDir)
    if (lexical !== base && !lexical.startsWith(`${base}${sep}`)) throw outside(path, field)
    let real: string
    let root: string
    try {
        root = await realpath(agentDir)
        real = await realpath(resolve(agentDir, path))
    } catch {
        throw imageRefused(
            "image_not_found",
            `No file at "${path}" in the agent's directory.`,
            "Save the image inside the agent's directory first, then name it relative to that directory.",
            field,
        )
    }
    // After symlinks, so a link inside the directory cannot point a read outside it.
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw outside(path, field)
    const info = await stat(real)
    if (!info.isFile()) {
        throw imageRefused(
            "image_not_found",
            `"${path}" is not a file.`,
            "Name an image file, not a directory.",
            field,
        )
    }
    if (info.size > MAX_IMAGE_BYTES) throw tooLarge(path, info.size, field)
    const bytes = new Uint8Array(await readFile(real))
    const mediaType = sniffImage(bytes)
    if (mediaType === undefined) throw unsupported(path, field)
    return { mediaType, data: Buffer.from(bytes).toString("base64"), ref: path }
}

function fromData(data: string, declared: string | undefined, field: string): ImageInput {
    const clean = data.replace(/\s+/g, "")
    if (clean === "" || clean.length % 4 !== 0 || !BASE64.test(clean)) {
        throw imageRefused(
            "image_data_invalid",
            "The image's data is not base64.",
            'Send the file\'s bytes base64-encoded, with no "data:" prefix.',
            field,
        )
    }
    const { mediaType } = imageFromBytes(
        new Uint8Array(Buffer.from(clean, "base64")),
        "upload",
        field,
    )
    if (declared !== undefined && declared !== mediaType) {
        throw imageRefused(
            "image_media_type_mismatch",
            `The image was declared ${declared} and its bytes are ${mediaType}.`,
            "Leave mediaType out, or send the type the file really is.",
            field,
        )
    }
    return { mediaType, data: clean, ref: "upload" }
}

/**
 * Bytes a transport already fetched — a channel's photo — checked the way an upload is: size, then
 * the magic bytes decide the type. `ref` is what history keeps in place of the image.
 */
export function imageFromBytes(bytes: Uint8Array, ref: string, field = "image"): ImageInput {
    if (bytes.length > MAX_IMAGE_BYTES) throw tooLarge(ref, bytes.length, field)
    const mediaType = sniffImage(bytes)
    if (mediaType === undefined) throw unsupported(ref, field)
    return { mediaType, data: Buffer.from(bytes).toString("base64"), ref }
}

function outside(path: string, field: string) {
    return imageRefused(
        "image_path_invalid",
        `The image path "${path}" leads outside the agent's directory.`,
        "Images are read from inside the agent's directory only. Copy the file there first.",
        field,
    )
}

function tooLarge(what: string, size: number, field: string) {
    return imageRefused(
        "image_too_large",
        `"${what}" is ${size} bytes; an image may be at most ${MAX_IMAGE_BYTES}.`,
        "Resize or compress it first.",
        field,
    )
}

function unsupported(what: string, field: string) {
    return imageRefused(
        "image_unsupported",
        `"${what}" is not a PNG, JPEG, GIF or WebP image.`,
        "Convert it to one of those formats first.",
        field,
    )
}

/** The line history keeps where an image was, so a later turn knows one was sent and where. */
export function imageReference(image: ImageInput): string {
    return `[image: ${image.ref}]`
}
