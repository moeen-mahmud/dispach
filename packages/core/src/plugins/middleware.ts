/**
 * Middleware: the wrapping shape, and the four places it wraps.
 *
 * ## Why wrapping rather than before/after events
 *
 * Wrapping permits retry, substitution and short-circuit; events permit only observation. Everything
 * an event could do, a wrap point can — and `onEvent` is here too, for the cases that really are only
 * watching. Nothing is lost by choosing wrapping, and a great deal is gained: a retry on a 429 and an
 * approval gate in front of a write are both impossible to express as a notification.
 *
 * ## Composition
 *
 * Manifest order, outermost first. Given plugins `[a, b]`:
 *
 *     a.wrapTurn( b.wrapTurn( core.turn ) )
 *
 * So the first plugin listed sees the call first and the result last. That ordering is the one thing
 * about middleware a person can actually reason about, which is why it follows the order they wrote
 * rather than anything this module decides.
 *
 * ## What is enforced, and what is documentation
 *
 * A middleware that returns `undefined` is a **loud failure**, not a silently empty turn. The rule
 * "always call `next()` unless deliberately short-circuiting, and return a well-formed result when
 * you do" cannot be enforced — a middleware is free to fabricate a result and that is the point of
 * having the hook — but the one shape that is never intentional is returning nothing at all, and
 * catching it here turns a confusing empty reply into a named error.
 *
 * "Never mutate the context argument" is documentation. Freezing it would be a real guard and a real
 * cost on the hot path, and the argument objects hold references (a registry, a bus) that a deep
 * freeze would break. Stated in the spec, unenforced here, and said plainly rather than implied.
 *
 * ## The safety property worth knowing
 *
 * `wrapToolCall` wraps the policy decision as well as the execution. A middleware that short-circuits
 * therefore **refuses** a call; it cannot grant one, because granting means calling `next()`, and
 * `next()` is the policy engine. So an approval middleware can only ever narrow what runs. That is the
 * safe direction and it is a property of where the seam sits, not of anyone's good intentions.
 */

import type { ContextBlock } from "../context/blocks.ts"
import type { AnyEvent } from "../events/types.ts"
import type { TurnSender } from "../loop/sender.ts"
import type { StepResult } from "../loop/step.ts"
import type { ChatRequest } from "../model/provider.ts"
import type { ToolIntent, ToolResult, ToolSpec } from "../tools/types.ts"

/** What a turn's middleware is told about the turn it is wrapping. */
export interface TurnMiddlewareContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    /** What the person said. */
    readonly input: string
    /** Where it came from: `repl`, `api`, `schedule`, a channel id. */
    readonly source: string
    /**
     * Who sent it, when it was not the operator. Absent means the operator's own surface.
     *
     * The fact an approval or audit middleware most wants about a turn and could not otherwise
     * reach: `source` says the message came in over the API and says nothing about who was on the
     * other end of it. `ToolCallMiddlewareContext.tainted` is the consequence of this one — a peer
     * sender makes it true from the first call.
     */
    readonly from?: TurnSender
    /** The turn's cancellation. A middleware that ignores it makes stop unreliable. */
    readonly signal: AbortSignal
}

export interface ContextMiddlewareContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    /** Which step of the turn — context is assembled once per step, not once per turn. */
    readonly step: number
    readonly signal: AbortSignal
}

export interface ModelCallMiddlewareContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    readonly step: number
    /** Which declared role this call is for: `main`, `compactor`, `cheap`. */
    readonly role: string
    readonly model: string
    /** The request as the transport will send it. Read it; do not mutate it. */
    readonly request: ChatRequest
    readonly signal: AbortSignal
}

export interface ToolCallMiddlewareContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    readonly tool: ToolSpec
    readonly intent: ToolIntent
    /** Arguments after coercion — what the handler will actually receive. */
    readonly args: Readonly<Record<string, unknown>>
    /**
     * Whether untrusted output has already entered this turn.
     *
     * The fact an approval middleware most wants and cannot otherwise see: a write is a different
     * proposition before and after a stranger's text reached the model.
     */
    readonly tainted: boolean
    readonly signal: AbortSignal
}

/** What a wrapped turn returns. Narrower than `TurnResult` — a middleware sees the outcome, not the loop's bookkeeping. */
export interface TurnMiddlewareResult {
    readonly text: string
    readonly reason: string
    readonly steps: number
}

export interface Middleware {
    /** Named so events, errors and `plugins` output can say which one did something. */
    readonly name: string
    wrapTurn?(
        context: TurnMiddlewareContext,
        next: () => Promise<TurnMiddlewareResult>,
    ): Promise<TurnMiddlewareResult>
    wrapContext?(
        context: ContextMiddlewareContext,
        next: () => Promise<readonly ContextBlock[]>,
    ): Promise<readonly ContextBlock[]>
    /**
     * Wraps a whole model *step*, not the raw chunk stream.
     *
     * The spec first described this as wrapping an `AsyncIterable<ChatChunk>`, and that shape cannot
     * do the job it exists for: a stream that has already been partially consumed cannot be retried,
     * so "retry on a 429" — the canonical use — would be unimplementable. Wrapping the step means
     * `next()` re-runs the request from the beginning, which is what a retry actually needs.
     *
     * The cost, stated: a middleware here cannot see or transform individual deltas, so it cannot
     * redact a token as it streams. That belongs in `wrapContext`, before the prompt is sent, which
     * is the only place a redaction is reliable anyway.
     */
    wrapModelCall?(
        context: ModelCallMiddlewareContext,
        next: () => Promise<StepResult>,
    ): Promise<StepResult>
    wrapToolCall?(
        context: ToolCallMiddlewareContext,
        next: () => Promise<ToolResult>,
    ): Promise<ToolResult>
    /**
     * Fire and forget. Must not throw and must not block — anything slow goes on a queue you own.
     *
     * A throw here is caught and turned into a bus error rather than allowed to kill the emit, because
     * one plugin's observer must not be able to stop the runtime reporting to everybody else's.
     */
    onEvent?(event: AnyEvent): void
}

/** Which hook a composition is for. */
type Hook = "wrapTurn" | "wrapContext" | "wrapModelCall" | "wrapToolCall"

/**
 * A hook's context and result types, derived from the `Middleware` declaration itself.
 *
 * `compose` used to take free type parameters, and its one `as any` dispatch meant nothing checked
 * that a call site's `core` matched what the interface promised a plugin author. It did not:
 * `wrapModelCall` was declared over `AsyncIterable<ChatChunk>` and wired over `StepResult`, so a
 * plugin written against the published type would have received the wrong thing at runtime and the
 * compiler had no way to say so. Deriving both sides from one declaration closes that by
 * construction — a mismatched call site now fails to compile.
 */
type HookContext<H extends Hook> = Parameters<NonNullable<Middleware[H]>>[0]
type HookResult<H extends Hook> = Awaited<ReturnType<NonNullable<Middleware[H]>>>

/**
 * A middleware that returned nothing.
 *
 * The one shape that is never intentional. Short-circuiting is legitimate and returning a fabricated
 * result is how it is spelled; returning `undefined` is a forgotten `return`, and without this it
 * surfaces as an empty reply, a prompt with no blocks, or a tool result whose fields are all
 * undefined — three different confusing symptoms of one trivial mistake, none of which name the
 * plugin that caused them.
 */
function returnedNothing(name: string, hook: Hook): Error {
    const error = new Error(
        `Middleware "${name}" returned nothing from ${hook}. ` +
            `hint: call next() and return its result, or — if you meant to short-circuit — return a ` +
            `well-formed result of your own. A middleware may replace a result; it may not omit one.`,
    )
    error.name = "MiddlewareError"
    return error
}

/**
 * Compose one hook across a list of middleware, outermost first.
 *
 * Returns `core` unchanged when nothing implements the hook, so an agent with middleware that only
 * wraps tool calls pays nothing at all on the turn, context and model paths. That matters more than
 * it looks: these are per step and per call, and a chain of no-op closures on the hot path is exactly
 * the kind of cost that does not show up in any one measurement.
 */
export function compose<H extends Hook>(
    middlewares: readonly Middleware[],
    hook: H,
    core: (context: HookContext<H>) => Promise<HookResult<H>>,
): (context: HookContext<H>) => Promise<HookResult<H>> {
    type C = HookContext<H>
    type R = HookResult<H>
    const applicable = middlewares.filter((middleware) => typeof middleware[hook] === "function")
    if (applicable.length === 0) return core

    return async (context: C): Promise<R> => {
        // Built inside out so the *first* middleware listed ends up outermost.
        let next: () => Promise<R> = () => core(context)
        for (let index = applicable.length - 1; index >= 0; index -= 1) {
            const middleware = applicable[index]
            if (middleware === undefined) continue
            const inner = next
            next = async (): Promise<R> => {
                // One dispatcher over four hook shapes. The cast is confined to this line, and the
                // signature above is what makes it safe: `HookContext` and `HookResult` are derived
                // from the `Middleware` declaration, so a call site handing `compose` the wrong kind
                // of `core` no longer compiles. It used to, which is how `wrapModelCall` came to be
                // declared over one type and wired over another.
                const wrap = middleware[hook] as (
                    context: C,
                    next: () => Promise<R>,
                ) => Promise<R | undefined>
                const result = await wrap.call(middleware, context, inner)
                if (result === undefined) throw returnedNothing(middleware.name, hook)
                return result
            }
        }
        return next()
    }
}

/**
 * Deliver an event to every middleware that watches, swallowing throws.
 *
 * Swallowed rather than propagated because the alternative is that one plugin's observer stops the
 * runtime reporting to everyone else's — the bus already treats a subscriber throw this way, and a
 * middleware watching events is a subscriber with a different spelling.
 */
export function notify(
    middlewares: readonly Middleware[],
    event: AnyEvent,
    onError: (error: unknown, name: string) => void,
): void {
    for (const middleware of middlewares) {
        if (typeof middleware.onEvent !== "function") continue
        try {
            middleware.onEvent(event)
        } catch (error) {
            onError(error, middleware.name)
        }
    }
}
