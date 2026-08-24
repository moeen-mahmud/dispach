/**
 * `model probe` — ask the endpoint what it can actually do, instead of guessing from its name.
 *
 * Every `init` preset's default model has an unverified context window and nothing has ever said so.
 * `deepseek-v4-pro` is declared at 393,216 against a published 1,048,576, and `claude-*` is one
 * registry row for every Claude model ever released.
 *
 * The third suspicion this was built on turned out to be wrong, which is worth keeping written down:
 * `promptCache: "none"` on every `deepseek-*` row looked like a cost bug, and the registry comment
 * beside those rows had already answered it — the field says the *runtime* places no breakpoints, not
 * that the provider does not cache. The first live run measured 1024 of 1115 prompt tokens cached, so
 * the comment was right and the alarm was not. Nothing in core reads the field at all today; its only
 * consumer is a line of `validate`'s output.
 *
 * ## What it costs, and why the order is what it is
 *
 * Two of the four techniques are free. `GET /models` is a metadata read. The over-range `max_tokens`
 * request is **refused before a token is generated**, so it is billed for nothing — which is what
 * makes it the best technique here rather than merely a clever one: it asks the endpoint to state its
 * own limit and the endpoint answers in the error message.
 *
 * The caching probe sends two small calls, and is the only way to answer a question no endpoint
 * exposes directly. The window search is behind `--window` because it is the one that spends real
 * money, and it prints what it will spend before it spends it.
 *
 * ## Every role, not just main
 *
 * An agent can run three models on three endpoints, and until Phase 7D only main's window was
 * reported anywhere at all. A compactor quietly running on `CONSERVATIVE`'s 8,192 is the configuration
 * decision 12.x calls *"the intended production shape and usually the biggest available cost win"*, so
 * it is exactly the one that must not be silently wrong. Roles that fall back to main are skipped
 * rather than probed twice — they are the same endpoint and the same model.
 */

import {
    bearerHeaders,
    editManifest,
    endpointUrl,
    HarnessError,
    loadManifest,
    modelsUrl,
    windowReport,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { askYesNo } from "#lib/confirm"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import {
    bestFinding,
    type CacheFinding,
    cacheFromUsage,
    cacheVerdict,
    ceilingFromRefusal,
    contextFromModels,
    measuredComment,
    type RoleProbe,
    registryRow,
    searchCost,
    type WindowFinding,
} from "#lib/probe"
import { CHANNEL_IDS, PROVIDER_IDS } from "#lib/providers"
import { keyValue, section } from "#lib/render"

/**
 * A `max_tokens` no endpoint can honour, chosen to be refused rather than clamped.
 *
 * Large enough that nothing serves it, small enough to stay inside a 32-bit signed integer — a value
 * past that is rejected by some gateways as a *type* error, whose message names no limit and answers
 * nothing.
 */
const IMPOSSIBLE_MAX_TOKENS = 2_000_000_000

/**
 * The prefix length the caching probe repeats.
 *
 * Vendors that document a minimum cacheable prefix put it in the hundreds of tokens, so a two-word
 * probe would report "no caching" for every endpoint on earth and the negative would be worthless.
 * This is deliberately over that line and still costs a fraction of a cent.
 */
const CACHE_PREFIX_TOKENS = 1024

/** Where a `--window` search starts, and the ceiling it refuses to climb past without being asked. */
const SEARCH_START = 8192
const SEARCH_LIMIT = 2_097_152

export interface ModelOptions {
    readonly manifestPath: string
    readonly window: boolean
    /** Dollars per million input tokens, for the one arithmetic step this cannot know. */
    readonly price?: number
    readonly write: boolean
    /** Skip the `--window` spend prompt. Never widens anything else. */
    readonly yes: boolean
    readonly json: boolean
    /** Injected by tests. Production passes nothing and gets the global. */
    readonly fetch?: typeof globalThis.fetch
}

interface Endpoint {
    readonly chat: string
    readonly models: string
    readonly headers: Record<string, string>
    readonly modelId: string
}

/** A word of roughly one token, repeated — good enough to size a prompt, which is all this needs. */
function filler(tokens: number): string {
    return "context ".repeat(Math.max(1, tokens))
}

async function readBody(response: Response): Promise<{ text: string; json: unknown }> {
    const text = await response.text()
    try {
        return { text, json: JSON.parse(text) }
    } catch {
        return { text, json: undefined }
    }
}

/** The message an endpoint put in its error body, wherever it put it. */
function errorMessage(json: unknown, fallback: string): string {
    if (typeof json === "object" && json !== null) {
        const record = json as Record<string, unknown>
        const error = record.error
        if (typeof error === "string") return error
        if (typeof error === "object" && error !== null) {
            const message = (error as Record<string, unknown>).message
            if (typeof message === "string") return message
        }
        if (typeof record.message === "string") return record.message
    }
    return fallback
}

/** Technique 1: metadata. Free, and absent on more endpoints than it is present. */
async function probeMetadata(
    endpoint: Endpoint,
    doFetch: typeof globalThis.fetch,
    failures: string[],
): Promise<WindowFinding | undefined> {
    try {
        const response = await doFetch(endpoint.models, { headers: endpoint.headers })
        if (!response.ok) {
            failures.push(`GET /models answered ${response.status}`)
            return undefined
        }
        const { json } = await readBody(response)
        const finding = contextFromModels(json, endpoint.modelId)
        if (finding === undefined) failures.push("GET /models published no context length")
        return finding
    } catch (cause) {
        failures.push(
            `GET /models failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return undefined
    }
}

/**
 * Technique 2: ask for an impossible output and read the refusal.
 *
 * The refusal is free and it is *authoritative* — the endpoint generated the number from its own
 * configuration rather than from a table somebody maintained. Two numbers can come back: an output
 * ceiling (`max_tokens must be <= 8192`) and sometimes the window itself.
 */
async function probeRefusal(
    endpoint: Endpoint,
    doFetch: typeof globalThis.fetch,
    failures: string[],
): Promise<{ window: WindowFinding | undefined; outputCeiling: number | undefined }> {
    try {
        const response = await doFetch(endpoint.chat, {
            method: "POST",
            headers: { "content-type": "application/json", ...endpoint.headers },
            body: JSON.stringify({
                model: endpoint.modelId,
                messages: [{ role: "user", content: "hi" }],
                max_tokens: IMPOSSIBLE_MAX_TOKENS,
            }),
        })
        const { text, json } = await readBody(response)
        if (response.ok) {
            // It served the request rather than refusing it, which means `max_tokens` was clamped
            // silently. That is a real finding about the endpoint and not a probe failure — and it is
            // the shape CLAUDE.md warns about: an endpoint that ignores a parameter says nothing.
            failures.push(
                "the endpoint accepted an impossible max_tokens rather than refusing it — it clamps silently, so this technique cannot measure it",
            )
            return { window: undefined, outputCeiling: undefined }
        }
        const message = errorMessage(json, text.slice(0, 400))
        const named = ceilingFromRefusal(message)
        if (named === undefined) {
            failures.push(`the refusal named no number: ${message.slice(0, 160)}`)
            return { window: undefined, outputCeiling: undefined }
        }
        // A number under the declared window is an *output* ceiling, not a context one: no endpoint
        // refuses a two-token prompt for being too long. Above it, the refusal is about the window.
        const looksLikeOutput = /max_?tokens/i.test(message)
        return {
            window: looksLikeOutput
                ? undefined
                : {
                      technique: "refusal",
                      tokens: named,
                      bound: "ceiling",
                      detail: `refused an over-range request naming ${named}`,
                  },
            outputCeiling: looksLikeOutput ? named : undefined,
        }
    } catch (cause) {
        failures.push(
            `the over-range request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return { window: undefined, outputCeiling: undefined }
    }
}

/** One small call, returning what it reported about caching. */
async function cacheCall(
    endpoint: Endpoint,
    doFetch: typeof globalThis.fetch,
    prompt: string,
): Promise<CacheFinding | undefined> {
    const response = await doFetch(endpoint.chat, {
        method: "POST",
        headers: { "content-type": "application/json", ...endpoint.headers },
        body: JSON.stringify({
            model: endpoint.modelId,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1,
        }),
    })
    if (!response.ok) return undefined
    const { json } = await readBody(response)
    const usage =
        typeof json === "object" && json !== null
            ? (json as Record<string, unknown>).usage
            : undefined
    return cacheFromUsage(usage)
}

/**
 * Technique 3: the same prompt twice, looking for a hit on the second.
 *
 * The single most consequential line in this command's output. It is also the one whose *negative*
 * must be stated carefully — a miss proves nothing on its own, because the prefix may be under the
 * endpoint's minimum, and `cacheVerdict` says so rather than concluding `none`.
 */
async function probeCache(
    endpoint: Endpoint,
    doFetch: typeof globalThis.fetch,
    failures: string[],
): Promise<{ supported: boolean | undefined; detail: string }> {
    const prompt = `${filler(CACHE_PREFIX_TOKENS)}\nReply with the single character x.`
    try {
        const first = await cacheCall(endpoint, doFetch, prompt)
        const second = await cacheCall(endpoint, doFetch, prompt)
        return cacheVerdict(first, second, CACHE_PREFIX_TOKENS)
    } catch (cause) {
        failures.push(
            `the caching probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return { supported: undefined, detail: "the probe did not complete" }
    }
}

/**
 * Technique 4: grow a prompt until it is refused.
 *
 * Doubling rather than binary search, and the difference is the point: a binary search needs an upper
 * bound to bisect against, and not knowing the upper bound is the entire problem. Doubling finds the
 * bracket, and the *refusal* that ends it usually names the real number — at which point the search
 * has bought a ceiling rather than the floor it was aiming for, which is a better result than it was
 * designed to get.
 */
async function probeSearch(
    endpoint: Endpoint,
    doFetch: typeof globalThis.fetch,
    failures: string[],
): Promise<WindowFinding | undefined> {
    let size = SEARCH_START
    let lastAccepted = 0
    while (size <= SEARCH_LIMIT) {
        let response: Response
        try {
            response = await doFetch(endpoint.chat, {
                method: "POST",
                headers: { "content-type": "application/json", ...endpoint.headers },
                body: JSON.stringify({
                    model: endpoint.modelId,
                    messages: [{ role: "user", content: filler(size) }],
                    max_tokens: 1,
                }),
            })
        } catch (cause) {
            failures.push(
                `the search stopped at ${size}: ${cause instanceof Error ? cause.message : String(cause)}`,
            )
            break
        }
        if (response.ok) {
            // The *reported* count, never the requested one. `filler` repeats a word and a word is not
            // a token, so the sizes this loop chooses are only roughly tokens — and a floor is a claim
            // about a number, so labelling it with an estimate would make the one honest output of
            // this technique dishonest. The endpoint counted the prompt; take its answer.
            const { json } = await readBody(response)
            const usage =
                typeof json === "object" && json !== null
                    ? (json as Record<string, unknown>).usage
                    : undefined
            const counted =
                typeof usage === "object" && usage !== null
                    ? (usage as Record<string, unknown>).prompt_tokens
                    : undefined
            lastAccepted =
                typeof counted === "number" && Number.isFinite(counted) ? counted : lastAccepted
            size *= 2
            continue
        }
        const { text, json } = await readBody(response)
        const named = ceilingFromRefusal(errorMessage(json, text.slice(0, 400)))
        if (named !== undefined) {
            return {
                technique: "search",
                tokens: named,
                bound: "ceiling",
                detail: `refused a ${size}-token prompt and named ${named}`,
            }
        }
        break
    }
    if (lastAccepted === 0) return undefined
    return {
        technique: "search",
        tokens: lastAccepted,
        // A floor and nothing more. The endpoint accepted this and never said what it would refuse.
        bound: "floor",
        detail: `accepted a prompt the endpoint counted at ${lastAccepted} tokens; nothing above it named a number`,
    }
}

function renderRole(probe: RoleProbe, price: number | undefined): string {
    const best = bestFinding(probe.findings)
    const verdict =
        best === undefined
            ? "nothing measured — every technique came back empty"
            : `${best.tokens} (${best.bound}) · ${best.detail}`
    const agreement =
        best === undefined
            ? ""
            : best.tokens === probe.declared
              ? "matches what is configured"
              : best.bound === "ceiling" && best.tokens > probe.declared
                ? `configured value is ${probe.declared}, which is ${(best.tokens - probe.declared).toLocaleString("en-US")} tokens short`
                : `configured value is ${probe.declared}`
    const cache =
        probe.cache.supported === undefined
            ? `unknown — ${probe.cache.detail}`
            : probe.cache.supported
              ? `yes — ${probe.cache.detail}`
              : `no — ${probe.cache.detail}`

    return [
        section(`  ${probe.role} · ${probe.modelId}`),
        keyValue([
            { label: "endpoint", value: probe.baseUrl },
            { label: "configured", value: `${probe.declared} (${probe.declaredSource})` },
            { label: "measured", value: verdict },
            { label: "agreement", value: agreement },
            {
                label: "output cap",
                value: probe.outputCeiling === undefined ? "" : String(probe.outputCeiling),
            },
            { label: "prompt cache", value: cache },
            ...(price === undefined
                ? []
                : [{ label: "price", value: `$${price}/Mtok input, as given` }]),
        ]),
        ...(probe.failures.length === 0
            ? []
            : [
                  // Printed rather than swallowed. A technique that found nothing is information about
                  // the endpoint — "it clamps max_tokens silently" is a fact worth knowing — and a
                  // report that showed only successes would look like the probe had nothing to say.
                  "    what did not answer:",
                  ...probe.failures.map((line) => `      · ${line}`),
              ]),
        ...(best === undefined || best.bound !== "ceiling"
            ? []
            : [
                  "",
                  "    registry row, if this model should ship with it:",
                  registryRow(probe.modelId, best.tokens, probe.outputCeiling)
                      .split("\n")
                      .map((line) => `    ${line}`)
                      .join("\n"),
              ]),
    ].join("\n")
}

export async function modelCommand(options: ModelOptions): Promise<number> {
    const doFetch = options.fetch ?? globalThis.fetch
    try {
        const loaded = loadManifest(options.manifestPath, {
            knownProviders: PROVIDER_IDS,
            knownChannels: CHANNEL_IDS,
            env: ambientEnv([options.manifestPath]),
        })
        const { manifest } = loaded
        // Only roles carrying their own configuration. A fallback role is the same model on the same
        // endpoint, so probing it again would spend money to learn the same thing twice.
        const roles = windowReport(manifest).filter((entry) => entry.role === entry.configuredAs)

        // Decided before the loop so the question is asked once rather than once per role, and
        // *not* by returning early: the two free techniques cost nothing, so declining the search is
        // a reason to skip the search and no reason to skip them. An earlier version returned here
        // and printed "the free techniques still ran above", which they had not — a sentence
        // asserting something that did not happen, found by reading the output rather than the code.
        let searchApproved = false
        if (options.window) {
            const cost = searchCost(SEARCH_START, SEARCH_LIMIT)
            const perRole = cost.tokens * roles.length
            const dollars =
                options.price === undefined
                    ? ""
                    : ` ≈ $${((perRole / 1_000_000) * options.price).toFixed(2)}`
            process.stdout.write(
                `--window will send up to ${cost.requests} requests per role, about ${perRole.toLocaleString("en-US")} input tokens in total${dollars}.\n` +
                    "That is an upper bound: the search stops at the first refusal, and the refused request generates nothing.\n" +
                    "Tokens rather than dollars unless --price says otherwise: a price table in this repo would be wrong within a quarter.\n",
            )
            // An estimate a person cannot act on is decoration. `askYesNo` answers **no** on a
            // non-TTY, so a pipe or a CI run is told rather than charged — the same asymmetry
            // `remove` uses, and the reason `--yes` exists for the scripted case.
            searchApproved = options.yes || (await askYesNo("spend it?"))
            process.stdout.write(
                searchApproved
                    ? "\n"
                    : "\nSkipping the search. The free techniques below still run — re-run with --window --yes to search without asking.\n\n",
            )
        }

        const probes: RoleProbe[] = []
        for (const entry of roles) {
            const config = manifest.model[entry.role] ?? manifest.model.main
            const endpoint: Endpoint = {
                chat: endpointUrl(config.baseUrl),
                models: modelsUrl(config.baseUrl),
                headers: bearerHeaders(config.apiKeyEnv, loaded.env, `model.${entry.role}`),
                modelId: config.id,
            }
            const failures: string[] = []
            const findings: WindowFinding[] = []

            const metadata = await probeMetadata(endpoint, doFetch, failures)
            if (metadata !== undefined) findings.push(metadata)

            const refusal = await probeRefusal(endpoint, doFetch, failures)
            if (refusal.window !== undefined) findings.push(refusal.window)

            const cache = await probeCache(endpoint, doFetch, failures)

            if (searchApproved) {
                const searched = await probeSearch(endpoint, doFetch, failures)
                if (searched !== undefined) findings.push(searched)
            }

            probes.push({
                role: entry.role,
                modelId: config.id,
                baseUrl: config.baseUrl,
                declared: entry.window.contextWindow,
                declaredSource: entry.window.source,
                findings,
                cache,
                outputCeiling: refusal.outputCeiling,
                failures,
            })
        }

        if (options.json) {
            process.stdout.write(`${JSON.stringify({ agent: manifest.id, probes }, null, 2)}\n`)
            return EXIT_OK
        }

        const applied = options.write
            ? await writeMeasured(loaded.path, probes)
            : { written: [], refused: [] }

        process.stdout.write(
            [
                `probed ${manifest.id} · ${probes.length} role${probes.length === 1 ? "" : "s"}`,
                ...probes.map((probe) => renderRole(probe, options.price)),
                "",
                ...(options.write
                    ? [
                          ...(applied.written.length === 0
                              ? []
                              : [
                                    "  written to the manifest:",
                                    ...applied.written.map((l) => `    ${l}`),
                                ]),
                          // Refusals are printed, never silent. "Nothing happened" and "nothing needed
                          // to happen" are different, and a --write that reported neither would look
                          // like it had worked.
                          ...(applied.refused.length === 0
                              ? []
                              : ["  not written:", ...applied.refused.map((l) => `    ${l}`)]),
                          "  A restart picks it up — an agent's settings are fixed for its lifetime.",
                      ]
                    : [writeNote(probes)]),
                "",
            ].join("\n"),
        )
        return EXIT_OK
    } catch (error) {
        if (error instanceof HarnessError) {
            process.stderr.write(`${error.format()}\n`)
            return EXIT_FAILURE
        }
        throw error
    }
}

/**
 * Write the measured window into the manifest — and refuse to write a floor.
 *
 * The refusal is the feature. A floor says "at least this much" and writing it as `contextWindow`
 * turns it into "exactly this much" the moment anybody reads the file: that is precisely how
 * `deepseek-v4-pro` came to sit at 393,216 against a published 1,048,576, and a command that
 * recreated it one generation later would be worse than no command. Only a **ceiling** — a number the
 * endpoint named while refusing — is written.
 *
 * Through `editManifest`, never by re-serialising: a whole-file rewrite cannot be validated, and
 * `parseDocument` → `setIn` → `String(doc)` reflows comments into the wrong section.
 */
async function writeMeasured(
    file: string,
    probes: readonly RoleProbe[],
): Promise<{ written: string[]; refused: string[] }> {
    const written: string[] = []
    const refused: string[] = []
    for (const probe of probes) {
        const best = bestFinding(probe.findings)
        if (best === undefined) {
            refused.push(`${probe.role}: nothing measured`)
            continue
        }
        if (best.bound !== "ceiling") {
            refused.push(
                `${probe.role}: ${best.tokens} is a floor, not a window — the endpoint accepted it and never said what it would refuse`,
            )
            continue
        }
        if (best.tokens === probe.declared) {
            refused.push(`${probe.role}: already ${best.tokens}, nothing to change`)
            continue
        }
        await editManifest({
            file,
            path: ["model", probe.role, "capabilities", "contextWindow"],
            value: best.tokens,
        })
        written.push(`${probe.role}: ${probe.declared} → ${best.tokens}`)
    }
    return { written, refused }
}

/**
 * The paste-ready line, for the run that did not pass `--write`.
 *
 * The comment is the whole of decision 3.8's "measured" case: there is no schema field claiming a
 * number was measured, because such a field is settable by hand and would turn a fact into a claim.
 * A dated comment naming the endpoint is for the person reading the file in six months.
 */
function writeNote(probes: readonly RoleProbe[]): string {
    const ceilings = probes.filter((probe) => bestFinding(probe.findings)?.bound === "ceiling")
    if (ceilings.length === 0) {
        return "  Nothing measured a ceiling, so there is nothing worth writing down. A floor is not a window."
    }
    const first = ceilings[0]
    const best = first === undefined ? undefined : bestFinding(first.findings)
    if (first === undefined || best === undefined) return ""
    const host = new URL(first.baseUrl).host
    return [
        "  --write records this. By hand, it is one line under the role, and the comment is the point:",
        `    contextWindow: ${best.tokens}`,
        `    # ${measuredComment(host, new Date().toISOString().slice(0, 10), best.detail)}`,
    ].join("\n")
}
