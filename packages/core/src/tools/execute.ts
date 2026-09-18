/**
 * Running what the model asked for.
 *
 * Four rules, each the answer to a specific way this goes wrong:
 *
 * **Nothing runs if anything in the step is malformed.** A step can carry several blocks. Executing
 * the good ones and repairing the bad one means the model rewrites the whole step, and the mutating
 * call that already succeeded runs a second time. There is no idempotency key available here, so the
 * step is all-or-nothing and the repair asks for all of it again.
 *
 * **Reads batch, writes serialise, declared order holds.** Consecutive read-only calls run
 * concurrently up to `maxParallelTools`; a mutating call is a barrier with nothing beside it. So
 * `read, read, write, read` is two batches around one write, in the order the model wrote them —
 * parallelism never reorders side effects.
 *
 * **A timeout ends the call, not the handler.** Nothing here can kill a handler that ignores its
 * signal; the call is reported as timed out and the handler is abandoned. Reporting a timeout while
 * quietly waiting forever would be the worse lie.
 *
 * **A failed tool is an observation, not an exception.** The model needs to see what went wrong to
 * do anything about it, so the error text goes back as the observation and the turn continues. Only
 * a broken harness throws out of here.
 *
 * **The write gate lives here rather than in the turn**, and that placement is load-bearing.
 * Untrusted content and a mutating call can arrive in the *same step* — a model may write
 * `web_fetch` and `memory_write` together. Groups run serially and a mutating call is alone in its
 * group, so by the time the write starts the fetch has already returned; a gate reading a flag
 * computed before this function was called would let that straight through. The taint therefore
 * accumulates inside the loop, seeded by what earlier steps saw.
 */

import { estimateTokens } from "../context/tokens.ts"
import { type ErrorDetail, toolFailed, toolTimedOut } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { EventContext } from "../events/types.ts"
import { newApprovalId } from "../loop/ids.ts"
import { compose, type Middleware } from "../plugins/middleware.ts"
import { coerceArgs } from "./coerce.ts"
import { authorize, type PolicyConfig } from "./policy.ts"
import type { ToolRegistry } from "./registry.ts"
import { stripControl } from "./sanitise.ts"
import { gatedResult, type OnMutate, refusedResult } from "./trust.ts"
import type { FieldError, Tool, ToolContext, ToolIntent, ToolResult } from "./types.ts"

export interface ExecuteInput {
    readonly registry: ToolRegistry
    readonly intents: readonly ToolIntent[]
    readonly context: ToolContext
    readonly bus: EventBus
    readonly eventContext: EventContext
    readonly timeoutMs: number
    /** Read-only calls only. Mutating calls always run one at a time. */
    readonly maxParallel: number
    /** Above this, an observation is cut to head and tail with a visible marker. */
    readonly observationMaxTokens: number
    /**
     * True when an earlier step in this turn produced untrusted output.
     *
     * Required rather than optional: a caller who forgets to wire the gate should get a compile
     * error, not a silently open one.
     */
    readonly untrustedInTurn: boolean
    /** `tools.untrusted.onMutate`. */
    readonly onMutate: OnMutate
    /** Which slug tainted the turn, so the refusal can name a cause rather than a policy. */
    readonly untrustedSource?: string
    /** Rules deciding which calls run, ask, or are refused. */
    readonly policy: PolicyConfig
    /**
     * Ask a person. Absent means nobody is reachable — an unattended run, a schedule, a pipe — and
     * `tools.policy.onNoApprover` settles what `ask` means there.
     *
     * Returning false denies; throwing is treated as a denial too, because a broken approver must
     * not read as consent.
     */
    readonly approve?: (request: ApprovalRequest) => Promise<boolean>
    /**
     * Plugin middleware wrapping each call.
     *
     * Wraps the **policy decision as well as the execution**, and that placement is the safety
     * property: short-circuiting therefore *refuses* a call and can never grant one, because granting
     * means calling `next()` and `next()` is the policy engine. An approval middleware can only
     * narrow what runs. That is a fact about where the seam sits rather than about anyone's
     * intentions, which is why it is stated here and not left to a plugin author's judgement.
     */
    readonly middleware?: readonly Middleware[]
}

/** What a person is being asked to allow. */
export interface ApprovalRequest {
    /**
     * This question's identity, minted per ask.
     *
     * Not `callId`, which a dialect numbers within a step — see `newApprovalId`. An approver that
     * hands a question to something else (an HTTP client, a queue, another process) needs an id it
     * can be answered by, and this is it.
     */
    readonly approvalId: string
    /**
     * Which agent is asking.
     *
     * **This was deliberately absent, and the reason expired.** The division was that an
     * `ApprovalRequest` describes the *call* while the agent, session and turn ride on the
     * `approval.requested` event — true and tidy while a served process hosted one agent. It stops
     * being safe the moment one hosts several: `RuntimeOptions.approve` is a single process-wide
     * callback, so a question that cannot say who asked it cannot be listed per agent, and
     * `GET /v1/agents/:id/approvals` returned every agent's pending questions regardless of `:id`.
     * That is a disclosure, not an inconvenience.
     *
     * The event still carries the full context, for the reasons below. This is the smaller fact the
     * approver itself cannot do without.
     */
    readonly agentId: string
    readonly slug: string
    readonly callId: string
    /**
     * The command or path a rule would match — what the person actually needs to read.
     *
     * **Escape sequences are stripped before it gets here**, in core rather than in whichever front
     * end draws the prompt. `git status\x1b[2K\x1b[1G && rm -rf ~` displays on a real terminal as
     * `git status`: the escape erases the line and moves the cursor home, so everything after it
     * overwrites what a person already read. A prompt that can be made to show a different command
     * than the one about to run is worse than no prompt, because it is believed.
     *
     * Stripping is done once, here, because "the front end will handle it" is how one of them ends
     * up not handling it — and the one that doesn't is the one being read at the moment it matters.
     */
    readonly match?: string
    readonly mutating: boolean
    /** Why it is being asked rather than allowed outright. */
    readonly reason: string
    /**
     * The turn's cancellation, so an approver holding a question can drop it.
     *
     * **A courtesy, not the guarantee.** Core races the approver against this signal itself and
     * denies when it wins, so an approver that ignores the field is still correct and a hung
     * question still ends the turn. What the field buys is that an approver holding resources — a
     * pending promise in a map, a row, a socket — can release them instead of leaking one per
     * abandoned approval. Relying on every approver remembering to check it would be the
     * fail-open direction; relying only on the race would leak.
     */
    readonly signal: AbortSignal
}

export interface ExecuteOutcome {
    readonly results: readonly ToolResult[]
    /**
     * Non-empty when the step could not be executed as written. Exactly one repair follows; a
     * second failure is an honest error rather than another attempt.
     */
    readonly repair: readonly FieldError[]
}

/** A resolved, coerced call: what will actually run. */
export interface PlannedCall {
    readonly intent: ToolIntent
    readonly tool: Tool
    readonly args: Readonly<Record<string, unknown>>
}

/**
 * Resolves to a denial when the turn is abandoned, and never resolves otherwise.
 *
 * Never-resolving is correct inside a `Promise.race`: the approver is the other arm, and a timer
 * here would be a second deadline racing `limits.turnTimeoutMs`. This repo has a recorded bug from
 * exactly that shape — a tool that outlives the harness leaves a process with nothing referencing
 * it — so there is deliberately one clock, the turn's, and this only listens to it.
 *
 * The listener is registered with `once`, so a resolved race leaves nothing attached to a signal
 * that lives as long as the turn does.
 */
export function abandonedWhen(signal: AbortSignal): Promise<{ granted: false; by: "abandoned" }> {
    if (signal.aborted) return Promise.resolve({ granted: false, by: "abandoned" })
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ granted: false, by: "abandoned" }), {
            once: true,
        })
    })
}

/**
 * What the model is told, and it must not read as a person having said no.
 *
 * An abandoned approval is the turn ending underneath the question — nobody refused anything — and
 * an `error` is the approver being broken. Reporting either as "not approved" would put a decision
 * in somebody's mouth, and on the `error` path it would hide a fault behind a plausible outcome.
 */
function reasonFor(slug: string, by: "approver" | "error" | "abandoned"): string {
    if (by === "abandoned") {
        return `${slug} was waiting on an approval when the turn ended, so it did not run. Nobody declined it.`
    }
    if (by === "error") {
        return `${slug} was not run: the approver failed before anyone could answer. A broken prompt is not consent.`
    }
    return `${slug} was not approved.`
}

/** The match argument as text. A non-string argument cannot be pattern-matched, so it is not. */
function stringArg(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

/** Stable across key order, because the same call written two ways is the same call. */
export function hashArgs(args: Readonly<Record<string, unknown>>): string {
    const canonical = JSON.stringify(
        Object.keys(args)
            .sort()
            .map((key) => [key, args[key]]),
    )
    // FNV-1a: not cryptographic, and does not need to be — this identifies a repeat, it does not
    // protect anything. Cheap matters, because it runs on every call.
    let hash = 0x811c9dc5
    for (let i = 0; i < canonical.length; i += 1) {
        hash ^= canonical.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

function truncate(
    output: string,
    maxTokens: number,
): { readonly text: string; readonly truncated: boolean } {
    if (maxTokens <= 0 || estimateTokens(output) <= maxTokens) {
        return { text: output, truncated: false }
    }
    // Head and tail, because the useful parts of a long observation are at both ends: what it is at
    // the top, and the result or error at the bottom. The middle is rows.
    const budget = Math.max(200, Math.floor(maxTokens * 3.8))
    const head = output.slice(0, Math.floor(budget * 0.6))
    const tail = output.slice(-Math.floor(budget * 0.4))
    const elided = output.length - head.length - tail.length
    return {
        text: `${head}\n\n[… ${elided} characters cut from the middle of this observation to fit the context budget …]\n\n${tail}`,
        truncated: true,
    }
}

/**
 * Resolve and coerce every intent before any of them runs.
 *
 * Exported because "what would this step do" is worth asking without doing it — the eval harness
 * scores routing and arguments separately from execution.
 */
export function planIntents(
    registry: ToolRegistry,
    intents: readonly ToolIntent[],
): { readonly planned: readonly PlannedCall[]; readonly repair: readonly FieldError[] } {
    const planned: PlannedCall[] = []
    const repair: FieldError[] = []

    for (const intent of intents) {
        if (!registry.has(intent.slug)) {
            const known = registry.specs().map((spec) => spec.slug)
            // Dialect-neutral wording, and the field is the bare slug. This used to read
            // `ACTION: <slug>` with a hint about ACTION blocks — correct under NLT and nonsense under
            // native, where it would tell the model to fix a block it never wrote. The dialect owns
            // how a repair is *phrased for its protocol*; this layer says only what is wrong, and the
            // bare slug is what `native` matches its per-call messages against.
            repair.push({
                field: intent.slug,
                message: "is not a tool that exists.",
                hint:
                    known.length === 0
                        ? "No tools are available in this conversation. Reply without calling a tool."
                        : `Use one of these exactly as written: ${known.join(", ")}.`,
            })
            continue
        }

        const tool = registry.resolve(intent.slug)
        const coerced = coerceArgs(tool.spec, intent.args)
        if (coerced.ok) {
            planned.push({ intent, tool, args: coerced.args })
            continue
        }
        // Prefixed with the slug: with two blocks in a step, `to: is required` alone does not say
        // which block to fix.
        for (const error of coerced.errors) {
            repair.push({ ...error, field: `${intent.slug}.${error.field}` })
        }
    }

    return { planned, repair }
}

/**
 * Authorise one call, then run it or refuse it.
 *
 * Both refusal shapes answer with the intent's own `callId`, which is what keeps the native
 * protocol's "every announced call is answered" invariant true whichever way this goes.
 */
/**
 * `decideAndRun` with the agent's middleware around it.
 *
 * Composed per call rather than once per turn because `tainted` changes *within* a turn — the third
 * untrusted result flips it — and the context handed to a middleware has to describe the call being
 * made rather than the one that started the batch.
 *
 * `compose` returns the core function unchanged when nothing implements the hook, so an agent with no
 * tool middleware pays one array filter per call and no closures at all.
 */
async function wrapped(
    entry: PlannedCall,
    input: ExecuteInput,
    tainted: boolean,
    source: string,
): Promise<ToolResult> {
    const middleware = input.middleware ?? []
    if (middleware.length === 0) return decideAndRun(entry, input, tainted, source)

    const run = compose(middleware, "wrapToolCall", () =>
        decideAndRun(entry, input, tainted, source),
    )
    return run({
        agentId: input.context.agentId,
        sessionKey: input.context.sessionKey,
        turnId: input.context.turnId,
        tool: entry.tool.spec,
        intent: entry.intent,
        args: entry.args,
        tainted,
        signal: input.context.signal,
    })
}

async function decideAndRun(
    entry: PlannedCall,
    input: ExecuteInput,
    tainted: boolean,
    source: string,
): Promise<ToolResult> {
    const { spec } = entry.tool
    const call = { callId: entry.intent.callId, slug: spec.slug }
    const match = spec.policyArg === undefined ? undefined : stringArg(entry.args[spec.policyArg])

    let decision = authorize({
        policy: input.policy,
        query: { slug: spec.slug, ...(match === undefined ? {} : { match }) },
        mutating: spec.mutating,
        tainted,
        onMutate: input.onMutate,
        approver: input.approve !== undefined,
    })

    if (decision.effect === "ask" && input.approve !== undefined) {
        const approvalId = newApprovalId()
        const request: ApprovalRequest = {
            approvalId,
            agentId: input.context.agentId,
            ...call,
            ...(match === undefined ? {} : { match: stripControl(match) }),
            mutating: spec.mutating,
            reason: decision.reason,
            signal: input.context.signal,
        }

        // Emitted **before** asking, and by core rather than by the approver. A front end that
        // emitted its own would make the question visible only to itself — so a second observer of
        // the session, the firehose, or an audit log would see the turn simply stop.
        //
        // The event carries the full `eventContext` — agent, session and turn. The request carries
        // the agent alone: that is the one part an approver cannot work without once a process hosts
        // several agents, and the session and turn stay off it because an approver answers a
        // *question about a call*, not about a conversation.
        input.bus.emit(
            "approval.requested",
            {
                approvalId,
                slug: request.slug,
                callId: request.callId,
                ...(request.match === undefined ? {} : { match: request.match }),
                mutating: request.mutating,
                reason: request.reason,
            },
            input.eventContext,
        )

        // Three ways this ends and only one of them is somebody's decision.
        //
        // A thrown approver denies: a prompt that crashed is not consent, and treating it as such
        // is the one failure mode this layer exists to prevent. An aborted turn denies too, and the
        // race is what makes "wait for an answer" safe to implement — without it an unanswered
        // question holds the step open forever, the turn never reaches its own timeout check, and a
        // `running` row outlives the process with nothing able to tell it from a live one.
        const outcome = await Promise.race([
            input
                .approve(request)
                .then((granted) => ({ granted, by: "approver" as const }))
                .catch(() => ({ granted: false, by: "error" as const })),
            abandonedWhen(input.context.signal),
        ])

        input.bus.emit(
            "approval.resolved",
            { approvalId, slug: request.slug, granted: outcome.granted, by: outcome.by },
            input.eventContext,
        )

        decision = outcome.granted
            ? { effect: "allow", reason: "A person approved this call." }
            : { effect: "deny", reason: reasonFor(spec.slug, outcome.by) }
    }

    if (decision.effect === "allow") return runOne(entry, input)

    // Both refusal shapes emit `tool.gated` and nothing else. No `tool.call` and no `tool.result`:
    // nothing ran, and a consumer pairing the two would otherwise hold an orphan forever. A policy
    // refusal reports here too — a blocked call that emits no event at all is invisible to every
    // surface at once, which is the failure this whole layer exists to prevent.
    input.bus.emit(
        "tool.gated",
        {
            slug: call.slug,
            callId: call.callId,
            reason: decision.reason,
            policy: input.onMutate,
        },
        input.eventContext,
    )
    return decision.gated === true
        ? gatedResult(call, source, input.onMutate)
        : refusedResult(call, decision.reason)
}

export async function executeIntents(input: ExecuteInput): Promise<ExecuteOutcome> {
    const { planned, repair } = planIntents(input.registry, input.intents)

    if (repair.length > 0) {
        input.bus.emit(
            "tool.repair",
            {
                slugs: [...new Set(input.intents.map((intent) => intent.slug))],
                errors: repair.map((error) => `${error.field}: ${error.message}`),
            },
            input.eventContext,
        )
        return { results: [], repair }
    }

    const results: ToolResult[] = []
    let tainted = input.untrustedInTurn
    let source = input.untrustedSource ?? "an earlier tool call"

    for (const group of batch(planned, input.maxParallel)) {
        // `all` rather than `allSettled`: runOne never rejects, so a rejection here is a bug in the
        // harness and should surface as one instead of being folded into a tool failure.
        const settled = await Promise.all(
            // Decided per entry rather than per group. `batch` puts a mutating call alone today,
            // and neither the gate nor the policy should quietly depend on that staying true.
            // Position is preserved either way, so `results` still answers every announced call in
            // order — which the native protocol requires.
            group.map((entry) => wrapped(entry, input, tainted, source)),
        )
        results.push(...settled)

        // No `ok` guard. A failed untrusted call still lands upstream bytes in the context, because
        // `toolFailed` interpolates the cause's own message into the observation — and for an HTTP
        // tool that message routinely carries a fragment of the response body.
        if (!tainted) {
            const first = settled.find((result) => result.trust === "untrusted")
            if (first !== undefined) {
                tainted = true
                source = first.slug
            }
        }
    }

    return { results, repair: [] }
}

/**
 * Group into runs of consecutive read-only calls, capped at `maxParallel`, with every mutating call
 * alone in its own group. Order is preserved, so a write never overtakes a read written before it.
 */
export function batch(
    planned: readonly PlannedCall[],
    maxParallel: number,
): readonly PlannedCall[][] {
    const groups: PlannedCall[][] = []
    const cap = Math.max(1, maxParallel)

    for (const entry of planned) {
        const current = groups[groups.length - 1]
        const canJoin =
            current !== undefined &&
            current.length < cap &&
            !entry.tool.spec.mutating &&
            current.every((member) => !member.tool.spec.mutating)
        if (canJoin && current !== undefined) current.push(entry)
        else groups.push([entry])
    }

    return groups
}

async function runOne(entry: PlannedCall, input: ExecuteInput): Promise<ToolResult> {
    const { intent, tool, args } = entry
    const started = performance.now()

    input.bus.emit(
        "tool.call",
        {
            slug: tool.spec.slug,
            callId: intent.callId,
            argsHash: hashArgs(args),
            mutating: tool.spec.mutating,
        },
        input.eventContext,
    )

    const settle = (ok: boolean, output: string, error?: ErrorDetail): ToolResult => {
        const capped = truncate(output, input.observationMaxTokens)
        const result: ToolResult = {
            callId: intent.callId,
            slug: tool.spec.slug,
            ok,
            output: capped.text,
            ...(error === undefined ? {} : { error }),
            latencyMs: Math.round(performance.now() - started),
            bytes: output.length,
            truncated: capped.truncated,
            // Unreachable for anything that came through a `ToolRegistry` — every tool there has
            // been normalised — but `ToolSpec.trust` is optional in the type, so the fallback has to
            // exist. It is `trusted` because the only specs that bypass the registry are ones core
            // itself constructed.
            trust: tool.spec.trust ?? "trusted",
        }
        input.bus.emit(
            "tool.result",
            {
                slug: result.slug,
                callId: result.callId,
                ok: result.ok,
                latencyMs: result.latencyMs,
                bytes: result.bytes,
                truncated: result.truncated,
                trust: result.trust,
            },
            input.eventContext,
        )
        return result
    }

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), input.timeoutMs)
    // The turn's cancellation and this call's timeout are different outcomes, so they stay separate
    // controllers and the handler is handed the union.
    const signal = AbortSignal.any([input.context.signal, timeout.signal])

    try {
        const output = await Promise.race([
            Promise.resolve(
                tool.handler(args, { ...input.context, signal, deadlineMs: input.timeoutMs }),
            ),
            new Promise<never>((_, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        reject(
                            timeout.signal.aborted
                                ? toolTimedOut(tool.spec.slug, input.timeoutMs)
                                : new DOMException("aborted", "AbortError"),
                        )
                    },
                    { once: true },
                )
            }),
        ])
        return settle(true, output)
    } catch (caught) {
        // A cancelled turn is not a failed tool. Reported as an aborted call so the transcript says
        // what happened, and the turn's own cancellation handling takes it from here.
        if (isAbortError(caught) && !timeout.signal.aborted) {
            return settle(false, "The call was cancelled before it finished.", {
                code: "tool_cancelled",
                message: `${tool.spec.slug} was cancelled.`,
                hint: "The turn was stopped while this tool was running. Any side effect it had already caused still happened.",
            })
        }
        const detail = toolFailed(tool.spec.slug, caught).toDetail()
        return settle(false, `${detail.message}\n${detail.hint}`, detail)
    } finally {
        clearTimeout(timer)
    }
}

function isAbortError(value: unknown): boolean {
    return value instanceof Error && value.name === "AbortError"
}
