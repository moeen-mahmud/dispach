/**
 * The three meta tools: find an app's tools, connect an account, run code in the remote workbench.
 *
 * ## Why these exist at all
 *
 * Composio's catalogue is ~25,000 tools across ~1,000 toolkits, which is why `tools.pinned` exists
 * and why `available()` could never enumerate it. The consequence went unnoticed until someone asked
 * a generated agent to connect their Gmail: there was **no route**. `tools --warm` refreshes the
 * slugs already in `pinned`, so a slug had to be known before it could be warmed and warmed before
 * it could be pinned. The only way through was composio.dev in a browser, and nothing in the product
 * said so. The agent spent 4,417 output tokens working out that the path did not exist.
 *
 * ## Why this is not the runtime search decision 4.7 refuses
 *
 * That decision is about the *working set*: search-then-execute is two-hop reasoning and small models
 * fail it, so the tools an agent works with are fixed at load. That still holds here, exactly. What
 * these do is **setup**, not work — `composio_search` finds a slug and caches its schema, the model
 * writes it into `tools.pinned` with `config_set`, and after a restart it is an ordinary pinned tool:
 * one hop, phase-scopable, visible in `tools`. The two-hop shape happens once, when a person is
 * already pausing to click an OAuth link, and never again on a real task.
 *
 * The alternative considered and rejected was a `composio_execute(slug, args)` that runs anything
 * discovered, which would have made every Composio task two-hop forever.
 *
 * ## Observation size is load-bearing
 *
 * `config_read` once returned 2,766 tokens against a 2,000-token `observationMaxTokens`, so it was
 * middle-cut on every call and a real model read it three times in one turn — 8,040 output tokens to
 * change one line. A search hit can carry a dozen tools with full JSON schemas, which is far worse.
 * So the observation is a *summary*: slugs, one line each, connection status, and the next step. The
 * schemas go to the cache, which is where resolution reads them from anyway.
 */

import type { Tool, ToolContext, ToolSpec } from "@dispach/core"
import { composioNoMatch } from "./errors.ts"
import { type ComposioTool, isMutating, isUnannotated } from "./map.ts"

/** How many tools a single search reports. The cache keeps every schema it was given regardless. */
const MAX_REPORTED = 8

/** Slugs are `TOOLKIT_ACTION`; a summary longer than this is trimmed to keep the list scannable. */
const MAX_SUMMARY = 100

export const SEARCH_SLUG = "composio_search"
export const CONNECT_SLUG = "composio_connect"
export const WORKBENCH_SLUG = "composio_workbench"

/** Every slug this provider answers for without a cache or a network call. */
export const META_SLUGS: readonly string[] = [SEARCH_SLUG, CONNECT_SLUG, WORKBENCH_SLUG]

/**
 * What a meta tool needs from the provider, without importing it.
 *
 * An interface rather than the class so the handlers are testable against a stub with no HTTP, no
 * filesystem and no key — the same reason `fetch` is injected into the client.
 */
export interface MetaContext {
    /** Runs a meta tool, opening or recovering a session as needed. */
    call(
        slug: string,
        args: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
    ): Promise<{ readonly ok: boolean; readonly data: unknown; readonly error?: string }>
    /**
     * Fetch these slugs' real schemas and write them to the resolution cache.
     *
     * **The router's own `tool_schemas` are not usable for this, and finding that out was the
     * whole reason this is a separate step.** They come back in a thinner shape — `tool_slug`
     * rather than `slug`, `input_schema` rather than `input_parameters`, and *no `tags` field at
     * all*. Caching one directly fails three ways at once and all of them silently: the mapper
     * reads `input_parameters`, so a pinned `GMAIL_SEND_EMAIL` would be handed to the model with
     * **no arguments**; every tool would be assumed mutating for want of a `readOnlyHint`, so
     * reading your own inbox would serialise and hold a write slot; and the map does not reliably
     * contain every slug the same response recommends.
     *
     * `GET /tools/{slug}` returns all of it. It is also exactly what `--warm` already does, so
     * discovery and the hand-typed path converge on one cache written one way.
     */
    fetchSchemas(
        slugs: readonly string[],
        signal?: AbortSignal,
    ): Promise<Readonly<Record<string, ComposioTool>>>
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined
}

function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined
}

function firstLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim()
    return flat.length <= MAX_SUMMARY ? flat : `${flat.slice(0, MAX_SUMMARY - 1)}…`
}

// ─── search ──────────────────────────────────────────────────────────────────────────────

export const SEARCH_SPEC: ToolSpec = {
    slug: SEARCH_SLUG,
    provider: "composio",
    summary:
        "Finds tools for connecting to an outside app — email, calendar, chat, issue trackers.",
    whenToUse:
        "the person wants this agent to reach one of their other accounts and no pinned tool does it. " +
        "Describe the action and its object in plain English, like 'send an email' or 'create a " +
        "calendar event' — never a product name alone and never a tool slug. This finds the tools and " +
        "records their definitions; it does not run them and does not enable them.",
    whenNotToUse:
        "a pinned tool already does the job, or the person asked to read a web page — that is " +
        "web_fetch. This searches an app catalogue, never the web.",
    // Read-only in the sense the flag actually governs: it may run in parallel with other reads, and
    // it is safe to retry. It does write discovered schemas to the resolution cache, which is the
    // runtime's own file and idempotent — writing the same schema twice changes nothing, so calling
    // this mutating would serialise it and suppress its retry for no benefit.
    mutating: false,
    // Descriptions come from whoever published the toolkit, not from this runtime.
    trust: "untrusted",
    tags: ["composio", "read"],
    parameters: {
        type: "object",
        properties: {
            use_case: {
                type: "string",
                description:
                    "What the person wants done, as an action and its object: 'send an email', " +
                    "'list upcoming calendar events', 'create an issue'. Plain English, one task.",
            },
        },
        required: ["use_case"],
    },
}

interface SearchHit {
    readonly slug: string
    readonly summary: string
    readonly toolkit: string
    readonly mutating: boolean
    /** True when `mutating` was assumed from silence rather than declared. */
    readonly assumed: boolean
}

/** The slugs the router recommended, best first, deduplicated. */
function slugsFrom(data: Readonly<Record<string, unknown>>): readonly string[] {
    const ordered: string[] = []
    for (const result of asArray(data.results)) {
        const record = asRecord(result)
        if (record === undefined) continue
        // Primary before related: the ranking is the provider's and reordering it here would be this
        // runtime second-guessing a retrieval system with no information to do it better.
        for (const list of [record.primary_tool_slugs, record.related_tool_slugs]) {
            for (const slug of asArray(list)) {
                if (typeof slug === "string" && !ordered.includes(slug)) ordered.push(slug)
            }
        }
    }
    return ordered.slice(0, MAX_REPORTED)
}

/** One line per tool, from the schema that was actually fetched. */
function hitsFrom(
    slugs: readonly string[],
    schemas: Readonly<Record<string, ComposioTool>>,
): readonly SearchHit[] {
    const out: SearchHit[] = []
    for (const slug of slugs) {
        const tool = schemas[slug]
        // A slug whose schema could not be fetched is unusable: pinning it would fail the next load,
        // so offering it would hand the model a suggestion that breaks its own agent.
        if (tool === undefined) continue
        const description = tool.description ?? tool.human_description ?? ""
        out.push({
            slug,
            summary: description === "" ? "no description supplied" : firstLine(description),
            toolkit: tool.toolkit?.slug ?? "",
            mutating: isMutating(tool),
            assumed: isUnannotated(tool),
        })
    }
    return out
}

interface ConnectionStatus {
    readonly toolkit: string
    readonly connected: boolean
}

function statusesFrom(data: Readonly<Record<string, unknown>>): readonly ConnectionStatus[] {
    const out: ConnectionStatus[] = []
    for (const entry of asArray(data.toolkit_connection_statuses)) {
        const record = asRecord(entry)
        const toolkit = str(record?.toolkit)
        if (toolkit === undefined) continue
        out.push({ toolkit, connected: record?.has_active_connection === true })
    }
    return out
}

/**
 * The observation, written for a model that has to decide what to do next.
 *
 * Ends with the concrete next step rather than a list of facts, because the sequence — pin, then
 * restart, and connect first if the account is not linked — is the part no model can infer from a
 * catalogue listing, and getting it wrong is what the transcript that motivated this looked like.
 */
export function renderSearch(
    useCase: string,
    hits: readonly SearchHit[],
    statuses: readonly ConnectionStatus[],
): string {
    const lines = [`Tools that can "${useCase}":`, ""]
    for (const hit of hits) {
        // `read` / `write` on every line, never a marker on some. A search for "send an email"
        // returned eight tools and all eight were tagged "(changes things)" — including
        // OUTLOOK_GET_MAIL_TIPS, which reads — because an unannotated tool is assumed mutating and
        // 37 of 100 sampled tools carry no hint. A label present on everything says nothing, and a
        // label absent from some asks a small model to infer what the absence means.
        lines.push(`  ${hit.mutating ? "write" : "read "}  ${hit.slug}`)
        lines.push(`         ${hit.summary}`)
    }
    if (hits.some((hit) => hit.assumed)) {
        lines.push("")
        lines.push(
            "Some of those are marked write because they say nothing either way, not because they " +
                "are known to change things. Composio leaves a third of its catalogue unannotated " +
                "and the safe reading is the one taken here.",
        )
    }

    const unconnected = statuses.filter((entry) => !entry.connected).map((entry) => entry.toolkit)
    const connected = statuses.filter((entry) => entry.connected).map((entry) => entry.toolkit)

    lines.push("")
    if (connected.length > 0) {
        lines.push(`Already connected: ${connected.join(", ")}.`)
    }
    if (unconnected.length > 0) {
        lines.push(
            `Not connected yet: ${unconnected.join(", ")}. Call composio_connect for each before these tools can run.`,
        )
    }

    lines.push("")
    lines.push(
        "These are not enabled yet. To enable them, add the slugs you need to tools.pinned with " +
            "config_set — their definitions are already saved, so no other setup is needed. " +
            "config_set says which become usable in this conversation; the rest work from the " +
            "person's next message, with no restart. Pin only what the task needs.",
    )
    return lines.join("\n")
}

export function searchTool(context: MetaContext): Tool {
    return {
        spec: SEARCH_SPEC,
        handler: async (args, toolContext: ToolContext) => {
            const useCase = String(args.use_case ?? "").trim()
            const result = await context.call(
                "COMPOSIO_SEARCH_TOOLS",
                {
                    queries: [{ use_case: useCase }],
                    // A fresh discovery session per search. Threading one across turns would buy
                    // Composio's cached planning fields and cost a second piece of cross-turn state
                    // whose staleness nothing here could detect.
                    session: { generate_id: true },
                },
                toolContext.signal,
            )
            if (!result.ok) {
                return `The search failed: ${result.error ?? "no detail supplied"}`
            }

            const data = asRecord(result.data) ?? {}
            const slugs = slugsFrom(data)
            if (slugs.length === 0) throw composioNoMatch(useCase)

            // Only the slugs about to be shown. Fetching the rest would spend requests on schemas
            // nobody reads and cache tools the model was never offered — which is how a slug nobody
            // saw ends up pinnable.
            const schemas = await context.fetchSchemas(slugs, toolContext.signal)
            const hits = hitsFrom(slugs, schemas)
            if (hits.length === 0) throw composioNoMatch(useCase)

            return renderSearch(useCase, hits, statusesFrom(data))
        },
    }
}

// ─── connect ─────────────────────────────────────────────────────────────────────────────

export const CONNECT_SPEC: ToolSpec = {
    slug: CONNECT_SLUG,
    provider: "composio",
    summary: "Starts linking one of the person's accounts, and returns the link they must open.",
    whenToUse:
        "a tool needs an account that is not connected yet. Takes a toolkit name like 'gmail' or " +
        "'slack'. It returns a web address the person has to open themselves — this agent cannot " +
        "complete the sign-in, so pass the address on and wait for them to say it is done.",
    whenNotToUse:
        "the account already shows as connected, or the person has not asked for that app. This " +
        "starts a sign-in flow against their real account.",
    // The safe direction, and the one the provider default already takes. It reaches outward and
    // opens a pending authorisation against a real account — not a read by any reading of the word.
    mutating: true,
    trust: "untrusted",
    // So a rule can name one app: deny composio_connect(slack) permits gmail and refuses slack. A
    // tool whose target only appears inside its arguments is a tool no policy can constrain.
    policyArg: "toolkit",
    tags: ["composio", "write"],
    parameters: {
        type: "object",
        properties: {
            toolkit: {
                type: "string",
                description:
                    "The app to connect, lowercase and by itself: gmail, slack, notion, " +
                    "googlecalendar. Not a tool slug and not a sentence.",
            },
        },
        required: ["toolkit"],
    },
}

/**
 * Any URL in the response, wherever Composio put it.
 *
 * The reference documents `results` as "connection results for each toolkit" and does not say which
 * field carries the redirect — so this walks the object rather than reading a path that is a guess.
 * A wrong path here fails as "connected, no link", which reads to a model as success and leaves the
 * person with nothing to click; a walk degrades to finding nothing, which is reported as a failure.
 */
export function findUrl(value: unknown, depth = 0): string | undefined {
    if (depth > 6) return undefined
    if (typeof value === "string") {
        return /^https?:\/\/\S+$/.test(value.trim()) ? value.trim() : undefined
    }
    for (const entry of Array.isArray(value) ? value : Object.values(asRecord(value) ?? {})) {
        const found = findUrl(entry, depth + 1)
        if (found !== undefined) return found
    }
    return undefined
}

/**
 * What to tell the person, from what the endpoint actually sends.
 *
 * Measured against the live API rather than the reference, because they disagree. The docs describe
 * a `summary` object with `active_connections`; the response carries `{message, results}` and no
 * `summary` at all, with each toolkit under `results.<name>` as
 * `{toolkit, status, redirect_url, instruction}`. A renderer written to the documented shape reads
 * `active_connections` as 0 forever and reports "no link" on a call that returned one.
 *
 * The entry's own `instruction` field is deliberately **not** passed through. It is a third party's
 * prose telling a model what to do next, arriving through a tool marked `untrusted` — the exact
 * shape the write gate exists for. Composio's copy is good; that is not the point.
 */
export function renderConnect(toolkit: string, data: Readonly<Record<string, unknown>>): string {
    const entry = asRecord(asRecord(data.results)?.[toolkit])
    const status = str(entry?.status)?.toLowerCase()
    // The documented path first, then a walk — the two have already disagreed once, and a wrong
    // path fails as "connected, no link", which reads as success and leaves nothing to click.
    const url = str(entry?.redirect_url) ?? findUrl(data.results) ?? findUrl(data)

    if (status === "active") {
        return `${toolkit} is already connected — nothing to do. Its tools work as soon as they are pinned.`
    }
    if (url === undefined) {
        return `Composio returned no sign-in link for ${toolkit}${status === undefined ? "" : ` (status: ${status})`}. ${str(data.message) ?? "No detail was supplied."}`
    }
    return [
        `To connect ${toolkit}, the person needs to open this and sign in:`,
        "",
        `  ${url}`,
        "",
        "Give them that address and stop — this agent cannot complete a sign-in on their behalf, and " +
            "the connection is not usable until they have. When they say it is done, the account " +
            "stays connected for future sessions with no further sign-in.",
    ].join("\n")
}

export function connectTool(context: MetaContext): Tool {
    return {
        spec: CONNECT_SPEC,
        handler: async (args, toolContext: ToolContext) => {
            const toolkit = String(args.toolkit ?? "")
                .trim()
                .toLowerCase()
            const result = await context.call(
                "COMPOSIO_MANAGE_CONNECTIONS",
                { toolkits: [toolkit] },
                toolContext.signal,
            )
            if (!result.ok) {
                return `Could not start the connection for ${toolkit}: ${result.error ?? "no detail supplied"}`
            }
            return renderConnect(toolkit, asRecord(result.data) ?? {})
        },
    }
}

// ─── workbench ───────────────────────────────────────────────────────────────────────────

export const WORKBENCH_SPEC: ToolSpec = {
    slug: WORKBENCH_SLUG,
    provider: "composio",
    summary: "Runs Python in a Composio-hosted sandbox, for reshaping large tool output.",
    whenToUse:
        "a tool returned more data than is worth reading in full and it needs filtering, counting or " +
        "reshaping first. The sandbox keeps its files and variables for the rest of the task.",
    whenNotToUse:
        "the work belongs on this machine — that is exec, which the permission rules can actually " +
        "constrain. This runs somewhere else, under no rule written here.",
    mutating: true,
    trust: "untrusted",
    tags: ["composio", "write"],
    parameters: {
        type: "object",
        properties: {
            code: {
                type: "string",
                description: "Python to run in the sandbox. Print what should come back.",
            },
        },
        required: ["code"],
    },
}

/**
 * Composio calls this argument `code_to_execute`; the tool exposes it as `code`.
 *
 * Renamed rather than passed through because the model fills this in, and the shorter name is the
 * one it reaches for. The mapping is here, verified against the live endpoint — which is the only
 * way it could have been: the published reference does not document this tool's arguments, and the
 * first call with `code` came back "Validation error: Required at code_to_execute".
 */
const WORKBENCH_ARG = "code_to_execute"

/**
 * What the sandbox printed, rather than the envelope it came in.
 *
 * The raw reply is `{results, stdout, stderr, error, sandbox_id_suffix}`, and returning it as JSON
 * spends the observation budget on field names and a sandbox id nothing reads. A run that printed
 * `42` should observe as `42`. Empty output is stated rather than rendered as blank, which reads to
 * a model as a tool that returned nothing because it failed.
 */
export function renderWorkbench(data: unknown): string {
    const record = asRecord(data)
    if (record === undefined) return typeof data === "string" ? data : JSON.stringify(data, null, 2)

    const parts: string[] = []
    const stdout = str(record.stdout)
    const stderr = str(record.stderr)
    const error = str(record.error)
    const results = str(record.results)

    if (stdout !== undefined) parts.push(stdout.trimEnd())
    if (results !== undefined) parts.push(results.trimEnd())
    if (stderr !== undefined) parts.push(`stderr:\n${stderr.trimEnd()}`)
    if (error !== undefined) parts.push(`error:\n${error.trimEnd()}`)

    return parts.length === 0 ? "The code ran and printed nothing." : parts.join("\n")
}

export function workbenchTool(context: MetaContext): Tool {
    return {
        spec: WORKBENCH_SPEC,
        handler: async (args, toolContext: ToolContext) => {
            const result = await context.call(
                "COMPOSIO_REMOTE_WORKBENCH",
                { [WORKBENCH_ARG]: String(args.code ?? "") },
                toolContext.signal,
            )
            if (!result.ok) {
                return `The workbench failed: ${result.error ?? "no detail supplied"}`
            }
            return renderWorkbench(result.data)
        },
    }
}

/** The meta tools, by slug. Static: no cache is consulted and no request is made to build these. */
export function metaTools(context: MetaContext): Readonly<Record<string, Tool>> {
    return {
        [SEARCH_SLUG]: searchTool(context),
        [CONNECT_SLUG]: connectTool(context),
        [WORKBENCH_SLUG]: workbenchTool(context),
    }
}
