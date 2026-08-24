/**
 * What an endpoint will tell you about itself, and what it will only tell you by refusing.
 *
 * Pure: every function here takes bytes an endpoint sent and returns a finding. The network lives in
 * `model.ts`, which is what makes the interesting half — *which* of four techniques answered, and
 * whether the answer is a floor or a ceiling — testable against recorded responses rather than
 * against somebody's API key.
 *
 * ## Floors and ceilings are different claims and must never be merged
 *
 * A request that **succeeds** at 100,000 tokens proves the window is *at least* 100,000. It says
 * nothing about the number above it. A request that is **refused with a number in the message** proves
 * the window is *exactly* that number, because the endpoint just said so.
 *
 * The registry's existing comment is honest about being a floor — *"A floor, not a ceiling… Claiming
 * only what was shown"* — and that honesty is precisely how `deepseek-v4-pro` came to be declared at
 * 393,216 against a published 1,048,576 and stayed there. So a floor is reported as a floor, and
 * `--write` refuses to put one in a manifest without being told to: writing a floor as though it were
 * a measurement recreates the bug this phase exists to fix, one generation later.
 *
 * ## Why the techniques are ordered
 *
 * Cheapest first, and every one of them is worth trying because they fail independently:
 *
 * 1. **`GET /models`** — free. Some gateways publish a context length; OpenAI does not, vLLM does.
 * 2. **An over-range `max_tokens`** — free, because the request is refused before a token is
 *    generated. This is the one that yields a *ceiling* on the output limit, and sometimes on the
 *    window, because the refusal is generated from the endpoint's own configuration.
 * 3. **Caching by effect** — two small calls. The only way to answer a question no endpoint answers
 *    directly. It was written on the suspicion that `promptCache: "none"` on every `deepseek-*` row
 *    meant the cache-stable prefix had never been exercised, and the first live run **refuted that**:
 *    DeepSeek reported 1024 of 1115 prompt tokens cached with no cache-control markers sent, which is
 *    exactly what the registry's own comment already said — *"`none` is a statement about the
 *    runtime's job, not the provider's behaviour"*. The technique stays because confirming a comment
 *    with a number is the point, and because an endpoint that stops caching would otherwise be
 *    invisible.
 * 4. **A prompt-size search** — expensive, behind `--window`, and the only technique that can raise a
 *    floor when the endpoint refuses to say anything.
 */

/** Whether a number bounds the window from above, from below, or not at all. */
export type Bound = "ceiling" | "floor"

export type Technique = "metadata" | "refusal" | "search"

export interface WindowFinding {
    readonly technique: Technique
    readonly tokens: number
    readonly bound: Bound
    /** One line naming what was observed, for a report a person has to believe. */
    readonly detail: string
}

export interface CacheFinding {
    /**
     * `undefined` means the endpoint reported no cache field at all — which is not the same as
     * reporting a zero hit, and the two must not be collapsed. A missing field means the question was
     * not answered; a zero means it was answered "no hit on this call", which on a second identical
     * call is evidence of no caching.
     */
    readonly cached: number | undefined
    readonly promptTokens: number
    /** The usage field that carried it — vendors spell this three different ways. */
    readonly field: string | undefined
}

/** The four numbers a `/models` row might carry a window under, across the gateways seen so far. */
const CONTEXT_KEYS = [
    "context_length",
    "context_window",
    "max_context_length",
    // vLLM, which is what an open-weights host is usually running.
    "max_model_len",
] as const

/** The three spellings of "how much of this prompt was a cache hit". */
const CACHE_FIELDS = [
    // DeepSeek: a top-level pair on `usage`.
    ["prompt_cache_hit_tokens", (usage: Record<string, unknown>) => usage.prompt_cache_hit_tokens],
    // OpenAI: nested under `prompt_tokens_details`.
    [
        "prompt_tokens_details.cached_tokens",
        (usage: Record<string, unknown>) => {
            const details = usage.prompt_tokens_details
            return isRecord(details) ? details.cached_tokens : undefined
        },
    ],
    // Anthropic-compatible gateways.
    ["cache_read_input_tokens", (usage: Record<string, unknown>) => usage.cache_read_input_tokens],
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    if (!Number.isInteger(value) || value <= 0) return undefined
    return value
}

/**
 * A context length published by `GET /models`, for the row naming this model.
 *
 * Matched on the row rather than taken from the first entry: an endpoint serving several models
 * returns several rows, and the first one is somebody else's window. A gateway that returns the id in
 * a different shape than the manifest spells it — a vendor prefix, an Ollama tag — is handled by the
 * same suffix rule the capability registry uses, because the two are answering the same question
 * about the same string.
 */
export function contextFromModels(payload: unknown, modelId: string): WindowFinding | undefined {
    const data = isRecord(payload) ? payload.data : undefined
    const rows = Array.isArray(data) ? data : Array.isArray(payload) ? payload : undefined
    if (rows === undefined) return undefined

    const wanted = modelId.toLowerCase()
    for (const row of rows) {
        if (!isRecord(row)) continue
        const id = typeof row.id === "string" ? row.id.toLowerCase() : undefined
        if (id === undefined) continue
        // Exact, or the bare name behind a gateway's vendor prefix. Never a loose contains: `gpt-4o`
        // is a substring of `gpt-4o-mini`, and returning the wrong row's window silently would be the
        // worst available outcome for a command whose whole job is to be trusted.
        const matches = id === wanted || id.endsWith(`/${wanted}`) || wanted.endsWith(`/${id}`)
        if (!matches) continue
        for (const key of CONTEXT_KEYS) {
            const tokens = positiveInteger(row[key])
            if (tokens !== undefined) {
                return {
                    technique: "metadata",
                    tokens,
                    // The endpoint published it as a property of the model, so it is what the endpoint
                    // believes rather than something inferred from an acceptance.
                    bound: "ceiling",
                    detail: `GET /models published ${key}: ${tokens}`,
                }
            }
        }
        // The row exists and carries no context field. Worth stopping on rather than continuing to
        // scan: another row matching the same id is not a thing that happens, and reporting a
        // different model's number is worse than reporting nothing.
        return undefined
    }
    return undefined
}

/**
 * A number an endpoint named while refusing.
 *
 * Deliberately narrow. Every candidate is a *labelled* number — "maximum context length is 128000",
 * "max_tokens must be <= 8192" — because an error message is full of numbers that mean nothing here:
 * an HTTP status, a request id, a rate-limit window. A parser that grabbed the largest integer in the
 * string would eventually write a request id into somebody's manifest as a context window.
 *
 * Returns the *largest* labelled match rather than the first: a message naming both the window and
 * the tokens already used ("128000 tokens, however you requested 130000") reads in either order, and
 * the window is the larger of the pair in every real message seen.
 */
export function ceilingFromRefusal(message: string): number | undefined {
    const patterns = [
        // "the valid range of max_tokens is [1, 393216]" — DeepSeek, measured 2026-08-24. The upper
        // bound is the answer and the lower one is a **trap**: the lazy `max_?tokens` pattern below
        // matches the `1` and reported an output cap of 1, which is what a live run found. Kept first
        // for readability only; `Math.max` over every labelled match is what actually saves it, and
        // that rule earned its keep here rather than in the abstract.
        /(?:max_?tokens|context[\s_]?(?:length|window))[^[\]]{0,40}\[\s*\d[\d_,]*\s*,\s*(\d[\d_,]*)\s*\]/i,
        // "This model's maximum context length is 128000 tokens"
        /maximum context length is (\d[\d_,]*)/i,
        // "max_tokens must be <= 8192", "max_tokens: must be less than or equal to 4096"
        /max_?tokens[^.\d]{0,40}?(\d[\d_,]*)/i,
        // "context length of 32768", "context window of 200000"
        /context (?:length|window)(?: of)? (?:is )?(\d[\d_,]*)/i,
        // vLLM: "This model's maximum context length is 4096 tokens. However, you requested..."
        /maximum (?:sequence|model) length (?:is )?(\d[\d_,]*)/i,
    ]
    const found: number[] = []
    for (const pattern of patterns) {
        const match = pattern.exec(message)
        if (match?.[1] === undefined) continue
        const tokens = positiveInteger(Number(match[1].replaceAll(/[,_]/g, "")))
        if (tokens !== undefined) found.push(tokens)
    }
    if (found.length === 0) return undefined
    return Math.max(...found)
}

/** What a `usage` object says about cache hits, in whichever of the three spellings it uses. */
export function cacheFromUsage(usage: unknown): CacheFinding | undefined {
    if (!isRecord(usage)) return undefined
    const promptTokens = positiveInteger(usage.prompt_tokens) ?? 0
    for (const [field, read] of CACHE_FIELDS) {
        const raw = read(usage)
        // Zero is a real answer here and `positiveInteger` would discard it — the difference between
        // "reported no hit" and "did not report" is the whole finding.
        if (typeof raw === "number" && Number.isFinite(raw)) {
            return { cached: raw, promptTokens, field }
        }
    }
    return { cached: undefined, promptTokens, field: undefined }
}

/**
 * The verdict two identical calls support, and nothing stronger.
 *
 * A hit on the second call proves caching. No hit proves nothing on its own — the prefix may be under
 * the endpoint's minimum cacheable size, which for the vendors documenting one is in the hundreds of
 * tokens — so the negative verdict names that possibility instead of asserting `promptCache: "none"`.
 * Writing an unsupported negative into a registry row is how the current rows got there.
 */
export function cacheVerdict(
    first: CacheFinding | undefined,
    second: CacheFinding | undefined,
    minimumPrefix: number,
): { readonly supported: boolean | undefined; readonly detail: string } {
    if (first === undefined || second === undefined) {
        return {
            supported: undefined,
            detail: "no usage came back, so the question was not answered",
        }
    }
    if (second.field === undefined) {
        return {
            supported: undefined,
            detail: "the endpoint reported usage with no cache field in it — unknown, not absent",
        }
    }
    const hit = second.cached ?? 0
    if (hit > 0) {
        return {
            supported: true,
            detail: `the second identical call reported ${hit} cached of ${second.promptTokens} prompt tokens, via ${second.field}`,
        }
    }
    return {
        supported: false,
        detail: `${second.field} came back 0 on an identical repeat of a ${minimumPrefix}-token prefix — evidence of no caching, not proof: a longer prefix may still hit`,
    }
}

export interface RoleProbe {
    readonly role: string
    readonly modelId: string
    readonly baseUrl: string
    /** What the manifest and registry currently believe, for the comparison line. */
    readonly declared: number
    readonly declaredSource: string
    readonly findings: readonly WindowFinding[]
    readonly cache: { readonly supported: boolean | undefined; readonly detail: string }
    /** An `outputCeiling` the refusal named, when it named one separately from the window. */
    readonly outputCeiling: number | undefined
    readonly failures: readonly string[]
}

/**
 * The strongest claim the findings support.
 *
 * A ceiling beats a floor however large the floor is, because they are different claims rather than
 * competing estimates: a floor of 900,000 and a ceiling of 128,000 means the search was measuring
 * something other than the window, and taking the larger would publish a number the endpoint has
 * already contradicted. Among findings of the same kind the largest wins — a bigger floor is a
 * stronger floor, and two ceilings that disagree are an endpoint contradicting itself, where the
 * higher one is the one it refused *with*.
 */
export function bestFinding(findings: readonly WindowFinding[]): WindowFinding | undefined {
    const ceilings = findings.filter((entry) => entry.bound === "ceiling")
    const pool = ceilings.length > 0 ? ceilings : findings
    return pool.reduce<WindowFinding | undefined>(
        (best, entry) => (best === undefined || entry.tokens > best.tokens ? entry : best),
        undefined,
    )
}

/**
 * A paste-ready registry row for `capabilities.ts`.
 *
 * Printed rather than written, deliberately: changing a shipped default affects every agent that ever
 * runs that model, and the one thing worse than a wrong number in the registry is a wrong number that
 * arrived there without anybody reading it. `--write` touches the manifest, which is one agent.
 */
export function registryRow(
    modelId: string,
    tokens: number,
    outputCeiling: number | undefined,
): string {
    const pattern = `${modelId.split(":")[0]}*`
    return [
        "    {",
        `        pattern: "${pattern}",`,
        "        capabilities: {",
        `            contextWindow: ${tokens.toLocaleString("en-US").replaceAll(",", "_")},`,
        ...(outputCeiling === undefined
            ? []
            : [
                  `            maxOutput: ${outputCeiling.toLocaleString("en-US").replaceAll(",", "_")},`,
              ]),
        "            // the other fields are unchanged — this row reports only what was measured",
        "        },",
        "    },",
    ].join("\n")
}

/**
 * The comment `--write` leaves beside the number it writes.
 *
 * This is the whole of decision 3.8's "measured" case: there is no schema field saying a number was
 * measured, because a field like that is settable by hand and would turn a fact into a claim. A dated
 * comment naming the endpoint is for the person reading the file in six months, and nothing parses it.
 */
export function measuredComment(host: string, isoDate: string, detail: string): string {
    return `measured ${isoDate} against ${host} — ${detail}`
}

/**
 * What a `--window` search will spend, in tokens, before it runs.
 *
 * Tokens rather than dollars, and that is a deliberate departure from the plan as written. Pricing is
 * per-vendor, changes without notice, and a table of it in this repo would be wrong within a quarter —
 * a confidently wrong dollar figure is worse than an honest token count the person can multiply by a
 * number they actually know. `--price` accepts that number when they want the arithmetic done.
 *
 * The doubling search sends each size once, so the total is the sum of the sizes, which is a hair
 * under twice the largest — the standard geometric-series result, stated because a reader checking the
 * estimate against the requests will otherwise expect the sum of a linear scan.
 */
export function searchCost(start: number, ceiling: number): { requests: number; tokens: number } {
    let size = Math.max(1, start)
    let tokens = 0
    let requests = 0
    while (size < ceiling) {
        tokens += size
        requests += 1
        size *= 2
    }
    tokens += ceiling
    requests += 1
    return { requests, tokens }
}
