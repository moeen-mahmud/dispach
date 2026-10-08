/**
 * `image_generate`: a prompt in, a PNG in the agent's `media/` and on the reply.
 *
 * Registered by declaring `media.image`, the way `team` registers `handoff`. One argument, and no
 * file name: naming the file would be a second decision on every call, which is the shape
 * `memory_write` refuses for the same reason. The file is timestamped under `media/`, where the
 * embedder's file browser and a later `file_read` both find it.
 *
 * `mutating`, because it writes a file and spends money: serialised, never retried by the harness.
 */

import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { HarnessError } from "../errors.ts"
import type { ImageConfig } from "../manifest/schema.ts"
import type { Tool } from "../tools/types.ts"
import { type MediaProvider, withDeadline } from "./provider.ts"

export const IMAGE_GENERATE = "image_generate"
export const MEDIA_DIR = "media"

export interface MediaUsage {
    readonly kind: "transcription" | "image" | "speech"
    readonly provider: string
    readonly model: string
    readonly latencyMs: number
    readonly images?: number
    readonly audioSeconds?: number
    /** Characters spoken, for `speech`. */
    readonly characters?: number
    readonly sessionKey: string
    readonly turnId?: string
    readonly sender?: string
}

const EXTENSION: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}

export function imageGenerateTool(init: {
    readonly provider: MediaProvider
    readonly config: ImageConfig
    /** Records the call and emits `media.result`. Owned by the agent, which holds the store. */
    readonly record: (usage: MediaUsage) => void
}): Tool {
    const generate = init.provider.generateImage
    if (generate === undefined) throw new Error("image_generate needs a provider that generates")
    return {
        spec: {
            slug: IMAGE_GENERATE,
            provider: "media",
            summary: "Generates an image from a description and sends it with your reply.",
            whenToUse:
                "someone asks you to draw, design, illustrate or visualise something, or a picture would answer better than words",
            whenNotToUse:
                "a chart of real data (describe or tabulate it instead), a diagram whose details must be exact, or anything the person did not ask to see",
            mutating: true,
            trust: "trusted",
            trustReason: "the observation is a path the runtime wrote, not text from the provider",
            tags: ["write", "media"],
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "What the image shows, in one or two plain sentences: subject, setting, style. The image model sees only this, never the conversation.",
                    },
                },
                required: ["prompt"],
            },
        },
        async handler(args, context) {
            const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
            if (prompt === "") {
                throw new HarnessError({
                    code: "image_prompt_required",
                    message: "image_generate needs a prompt.",
                    hint: "Describe the image in one or two sentences; the image model sees nothing else.",
                    field: "prompt",
                })
            }
            const started = performance.now()
            const image = await withDeadline(
                // Under the tool deadline too: the harness abandons a handler at `deadlineMs`, and a
                // generation outliving it would write a file into a turn that has moved on.
                Math.min(init.config.timeoutMs, context.deadlineMs),
                "Generating the image",
                (signal) =>
                    generate.call(init.provider, { prompt, size: init.config.size }, signal),
                context.signal,
            )
            const stamp = context.now().toISOString().replace(/[-:]/g, "").slice(0, 15)
            const name = `${stamp}-${randomBytes(3).toString("hex")}.${EXTENSION[image.mimeType] ?? "png"}`
            const dir = join(context.dir, MEDIA_DIR)
            mkdirSync(dir, { recursive: true })
            const path = join(dir, name)
            writeFileSync(path, image.bytes)
            init.record({
                kind: "image",
                provider: init.config.provider,
                model: init.config.model ?? init.config.provider,
                latencyMs: Math.round(performance.now() - started),
                images: 1,
                sessionKey: context.sessionKey,
                // The sender is the agent's to attach, by turn: the same value its token rows carry.
                turnId: context.turnId,
            })
            context.attach?.({ path, mimeType: image.mimeType })
            return `Generated the image and saved it as ${relative(context.dir, path)}. It is attached to your reply; describe it in a sentence rather than repeating the path.`
        },
    }
}
