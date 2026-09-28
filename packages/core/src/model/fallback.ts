/**
 * A role's fallback chain: the primary, then each `fallbacks` entry in order.
 *
 * One provider wrapping several, so nothing above the transport layer changes shape — the loop still
 * calls one `chat`. What it gains is a `{type: "model", id}` chunk when a fallback answered, which is
 * how usage and `model.result` come to name the model that did the work rather than the one the
 * manifest asked for first.
 *
 * **When it moves on, and when it must not.** Only before the first chunk, since a stream cannot
 * un-emit what already reached the screen. Only for a failure that is the endpoint's, not the
 * request's: unreachable, a 5xx, or 408/429 — which reach here only once the transport's own retries
 * are spent, so a fallback starts after the retries rather than instead of them. **Never on a 4xx
 * the caller caused, and never on a 403**: an embedder may use a credential refusal as its budget
 * stop (VelaCrew does), and a fallback that answered anyway would spend past it.
 */

import { isHarnessError } from "../errors.ts"
import type { ChatChunk, ChatRequest, ModelProvider } from "./provider.ts"

export interface FallbackCandidate {
    /** Sent as `ChatRequest.model` to this candidate. */
    readonly model: string
    readonly provider: ModelProvider
}

export interface FallbackInfo {
    readonly from: string
    readonly to: string
    /** The error code or status that moved the call on, e.g. `model_unreachable` or `HTTP 503`. */
    readonly reason: string
}

/** Structural rather than `instanceof`: a transport package may carry its own copy of core. */
export function fallbackReason(error: unknown): string | undefined {
    if (!isHarnessError(error)) return undefined
    if (error.code === "model_unreachable") return error.code
    const status = (error as { status?: unknown }).status
    if (typeof status !== "number") return undefined
    if (status >= 500 || status === 408 || status === 429) return `HTTP ${status}`
    return undefined
}

export function withFallbacks(
    id: string,
    candidates: readonly FallbackCandidate[],
    onFallback?: (info: FallbackInfo) => void,
): ModelProvider {
    return {
        id,
        async *chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
            for (const [index, candidate] of candidates.entries()) {
                let started = false
                try {
                    for await (const chunk of candidate.provider.chat(
                        { ...request, model: candidate.model },
                        signal,
                    )) {
                        if (!started) {
                            started = true
                            if (index > 0) yield { type: "model", id: candidate.model }
                        }
                        yield chunk
                    }
                    return
                } catch (error) {
                    const next = candidates[index + 1]
                    const reason = started || signal.aborted ? undefined : fallbackReason(error)
                    if (next === undefined || reason === undefined) throw error
                    onFallback?.({ from: candidate.model, to: next.model, reason })
                }
            }
        },
    }
}
