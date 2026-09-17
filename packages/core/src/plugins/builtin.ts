/**
 * The two middleware the spec uses as worked examples, shipped rather than printed.
 *
 * They are here because a documented example nobody runs is an example that rots — and because both
 * answer a question this runtime already had and could not express. Retry-on-429 is the case that
 * decided middleware should wrap a *step* rather than a chunk stream; approval is what finally makes
 * `tools.untrusted.onMutate: confirm` reachable, which has been a settable value with no way to
 * supply the approver it needs since the field was added.
 *
 * Both are constructed by a caller — an embedder, or a plugin that wants them — rather than switched
 * on by a manifest. Middleware that appeared without anybody naming it would be the opposite of what
 * the plugin list is for.
 */

import type { ModelError } from "../errors.ts"
import { newApprovalId } from "../loop/ids.ts"
import { type ApprovalRequest, abandonedWhen } from "../tools/execute.ts"
import type { Middleware } from "./middleware.ts"

export interface RetryOptions {
    /** Total attempts including the first. Two means one retry. */
    readonly attempts?: number
    readonly baseDelayMs?: number
    readonly maxDelayMs?: number
    /** Injected so a test does not sleep. */
    readonly sleep?: (ms: number) => Promise<void>
    /** Told about each retry, for a caller that wants to log or count them. */
    readonly onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void
}

/** HTTP statuses worth trying again. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

function statusOf(error: unknown): number | undefined {
    const status = (error as { status?: unknown } | undefined)?.status
    return typeof status === "number" ? status : undefined
}

/** `Retry-After` in seconds, when the endpoint said so. Honoured over our own backoff. */
function retryAfterMs(error: unknown): number | undefined {
    const value = (error as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds
    return typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined
}

/**
 * Retry a model step on a rate limit or a transient upstream failure.
 *
 * **This wraps the step, which is the whole reason `wrapModelCall` has the shape it does.** A stream
 * that has already been consumed cannot be replayed, so a middleware over `AsyncIterable<ChatChunk>`
 * could observe a 429 and do nothing about it. `next()` here re-runs the request from the beginning.
 *
 * The transport has its own retry, and this does not replace it: that one covers a connection that
 * failed before a response, this one covers a response that arrived and said no. They compose —
 * a middleware retry re-enters the transport, which may itself retry the connection.
 *
 * `Retry-After` wins over the backoff when the endpoint sends one. Ignoring it is how a client that
 * is already being rate-limited makes the problem worse, and the header is the endpoint telling you
 * exactly what it wants.
 */
export function retryMiddleware(options: RetryOptions = {}): Middleware {
    const attempts = Math.max(1, options.attempts ?? 3)
    const baseDelayMs = options.baseDelayMs ?? 500
    const maxDelayMs = options.maxDelayMs ?? 8000
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

    return {
        name: "retry",
        async wrapModelCall(context, next) {
            let lastError: unknown
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                try {
                    return await next()
                } catch (error) {
                    lastError = error
                    const status = statusOf(error)
                    // A status this does not recognise is not retried. Retrying a 400 spends money
                    // and time on a request that will fail identically, and hides the real error
                    // behind whichever attempt happened to be last.
                    if (status === undefined || !RETRYABLE.has(status)) throw error
                    if (attempt === attempts) throw error
                    // Cancellation outranks the retry policy. A turn that was stopped must not keep
                    // making requests because a middleware thought the failure looked transient.
                    if (context.signal.aborted) throw error

                    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
                    const delayMs = retryAfterMs(error) ?? backoff
                    options.onRetry?.({ attempt, delayMs, status })
                    await sleep(delayMs)
                }
            }
            // Unreachable: the loop either returns or throws. Present because the compiler cannot
            // see that, and throwing the real error beats returning a fabricated result.
            throw lastError as ModelError
        },
    }
}

export interface ApprovalOptions {
    /**
     * Ask a person. `false` denies, and a throw denies too — a prompt that crashed is not consent,
     * which is the one failure mode this whole layer exists to prevent.
     */
    readonly ask: (request: ApprovalRequest) => Promise<boolean>
    /** Which calls to ask about. Default: every mutating one. */
    readonly when?: (context: { mutating: boolean; tainted: boolean; slug: string }) => boolean
}

/**
 * Ask before a mutating tool runs.
 *
 * **It can only refuse.** `wrapToolCall` wraps the policy decision as well as the execution, so
 * granting means calling `next()` — and `next()` is the policy engine, which may still refuse. A
 * middleware cannot authorise what the policy denies, and that is a property of where the seam sits
 * rather than of this function being careful.
 *
 * Which makes it a *second* gate rather than a replacement for the first. `tools.policy` is the
 * person's standing instruction, written down; this is the question asked in the moment. An agent
 * can have both, and the answer is the intersection.
 *
 * A denial returns a well-formed failed `ToolResult` rather than throwing, so the model sees an
 * honest observation and adapts. Throwing would kill the turn, which is the behaviour decision 4.26
 * rejected: a refused tool is information the agent can work with.
 */
export function approvalMiddleware(options: ApprovalOptions): Middleware {
    const when = options.when ?? ((context) => context.mutating)

    return {
        name: "approval",
        async wrapToolCall(context, next) {
            const wanted = when({
                mutating: context.tool.mutating,
                tainted: context.tainted,
                slug: context.tool.slug,
            })
            if (!wanted) return next()

            // Raced against the turn's signal for the same reason core's own seam is: an
            // unanswered question otherwise holds the step open forever, the turn never reaches its
            // timeout check, and a `running` row outlives the process.
            //
            // Unlike core's seam this gate does **not** reach the event stream, and that is a
            // stated limit rather than an oversight: `ToolCallMiddlewareContext` carries no bus, and
            // giving a plugin one would hand every middleware the ability to forge runtime events.
            // A plugin author supplying `ask` is the same person rendering the prompt, so the
            // question is not invisible to whoever asked it — but anything that needs a *second*
            // observer belongs on `AgentOptions.approve`, which core emits around.
            const { granted } = await Promise.race([
                options
                    .ask({
                        approvalId: newApprovalId(),
                        slug: context.tool.slug,
                        callId: context.intent.callId,
                        mutating: context.tool.mutating,
                        reason: context.tainted
                            ? `${context.tool.slug} changes something, and untrusted content has already entered this turn.`
                            : `${context.tool.slug} changes something.`,
                        signal: context.signal,
                    })
                    .then((answer) => ({ granted: answer }))
                    .catch(() => ({ granted: false })),
                abandonedWhen(context.signal),
            ])

            if (granted) return next()

            return {
                callId: context.intent.callId,
                slug: context.tool.slug,
                ok: false,
                output: `${context.tool.slug} was not approved, so nothing ran.`,
                error: {
                    code: "denied_by_approval",
                    message: `${context.tool.slug} was not approved.`,
                    hint: "A person was asked and declined. Do not retry the same call — say what you were about to do and why, and let them decide.",
                },
                latencyMs: 0,
                bytes: 0,
                truncated: false,
                // The refusal is the runtime's own text, not a stranger's, so it carries no taint.
                trust: "trusted",
            }
        },
    }
}
