/**
 * `docs/04-SPEC-WIRE.md` is binding, and until now nothing checked it.
 *
 * The consequence was not theoretical. That document carried rows for six events that did not
 * exist, described a reload that returns a diff, promised a webhook rate limit and a per-skill
 * last-selected time that nothing implements, and declared an envelope field as required that the
 * code has always had optional. Anything written against those rows read `undefined` from a field
 * the spec promised. The document even states, in its own text, that it *removed* six phantom rows
 * — and it had not removed these. **A spec nobody can check is a spec that drifts, and the drift
 * is invisible precisely because the document reads as authoritative.**
 *
 * So: parse only the document, compare against imported values. Never a copy of either side.
 *
 * Patterned on `cli/test/boundaries.test.ts` and `cli/test/examples.test.ts`, which is where this
 * repo already keeps its structural guards. Two of these assertions were **green on arrival**
 * (routes, hints) and are therefore locks rather than fixes — each was revert-checked by deleting
 * one `router.add` and one `hint:` and watching it go red, because a guard that has never failed is
 * a guard nobody has tested.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { EVENT_TYPES } from "@dispach/core"
import { WEB_PATHS } from "../src/web.ts"
import { cleanupWorkspaces, harness } from "./harness.ts"

afterAll(cleanupWorkspaces)

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const SPEC = readFileSync(join(ROOT, "docs", "04-SPEC-WIRE.md"), "utf8")
const SERVER_SRC = resolve(import.meta.dirname, "..", "src")
const CORE_SRC = resolve(ROOT, "packages", "core", "src")

/** Every `.ts` under a directory, recursively, as `{path, text}`. */
function sources(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...sources(full))
        else if (entry.name.endsWith(".ts"))
            out.push({ path: full, text: readFileSync(full, "utf8") })
    }
    return out
}

/**
 * First-cell values of the markdown table whose header row is `header`.
 *
 * Anchored on the table's own header rather than on a nearby heading, and **every caller asserts
 * the result is non-empty** — which is not belt-and-braces, it is the whole reliability of the
 * thing. The first version of this matched "any row whose first cell is a code span" and started
 * reading the error-code table's rows as event types the moment that table was added; the version
 * before *that* located a section by heading and sliced it wrongly, so it returned nothing and the
 * assertion over it passed by having no data. Both failures are silent unless a test demands rows.
 */
function tableRows(header: string): string[] {
    const at = SPEC.indexOf(header)
    if (at === -1) return []
    const rows: string[] = []
    // Skip the header and the `| --- |` separator, then take contiguous table lines.
    for (const line of SPEC.slice(at).split("\n").slice(2)) {
        if (!line.startsWith("|")) break
        const cell = /^\| `([^`]+)`/.exec(line)
        if (cell?.[1] !== undefined) rows.push(cell[1])
    }
    return rows
}

const EVENT_TABLE = "| Type | When | Key `data` |"
const PLANNED_TABLE = "| Event | When | Data | Blocked on |"
const ERROR_TABLE = "| Code | Status | Means |"

/** Types in the live event table — a promise that subscribing works today. */
function documentedEvents(): string[] {
    return tableRows(EVENT_TABLE)
}

/** Types under `### Planned` — documented as designed and not emitted yet. */
function plannedEvents(): string[] {
    return tableRows(PLANNED_TABLE)
}

describe("the event catalogue matches the spec", () => {
    test("every documented event exists, and every event is documented", () => {
        const documented = new Set(documentedEvents())
        const planned = new Set(plannedEvents())
        const real = new Set<string>(EVENT_TYPES)
        // A renamed table header makes `tableRows` return nothing, which would pass every
        // comparison below by having no data. Demanded here so that failure is loud.
        expect(documented.size).toBeGreaterThan(30)

        // A planned row is documented-but-absent on purpose, so it is excluded here and asserted
        // separately below.
        const phantom = [...documented].filter((type) => !real.has(type) && !planned.has(type))
        const undocumented = [...real].filter((type) => !documented.has(type))

        expect({ phantom, undocumented }).toEqual({ phantom: [], undocumented: [] })
    })

    test("a planned event is one that really does not exist yet", () => {
        // The point of the `### Planned` table is that it goes **red** the day the event ships:
        // whoever emits `handoff.start` has to move its row up into the live table, which is the
        // one moment anybody is thinking about it. A planned row that quietly became real is how
        // the phantom rows got there in the first place.
        const planned = plannedEvents()
        const real = new Set<string>(EVENT_TYPES)
        expect(planned.filter((type) => real.has(type))).toEqual([])

        // An **empty** planned table is a legitimate state — it is what shipping everything looks
        // like, and 10B produced it — but it is also what a renamed header or a broken slicer
        // produces, and those want opposite responses. This guard used to demand a non-empty table
        // for exactly that reason, and then went red for correct code the day the last planned
        // event shipped.
        //
        // So the parser is proven independently of the contents: an empty table has to be
        // *declared* empty in prose. Whoever deletes that sentence to add a row has to write a row,
        // and whoever breaks the slicer gets a failure rather than a pass on no data.
        if (planned.length === 0) {
            expect(SPEC.includes("**Nothing is planned and unshipped.**")).toBe(true)
        }
    })

    test("every documented event is emitted by something", () => {
        // Declared-implies-emitted. `agent.error` was in `EventDataMap` and this table from Phase 1
        // and emitted by **nothing, ever** — so it had a renderer case reachable only from a test
        // that constructed one by hand. Vocabulary with no emitter makes the catalogue look richer
        // than it is, and a consumer written against it waits forever.
        const emitted = new Set<string>()
        for (const file of [...sources(CORE_SRC), ...sources(SERVER_SRC)]) {
            for (const match of file.text.matchAll(/\.emit\(\s*"([a-z0-9.]+)"/g)) {
                emitted.add(match[1] ?? "")
            }
        }
        // `error` is emitted through a helper rather than a literal call, and a `bus.emit(type)`
        // forwarding a variable cannot be found by scanning. Exempted by name so the exemption is
        // visible rather than a hole in the regex.
        const forwarded = new Set(["error"])
        const orphans = documentedEvents().filter(
            (type) =>
                !emitted.has(type) && !forwarded.has(type) && !new Set(plannedEvents()).has(type),
        )
        expect(orphans).toEqual([])
    })
})

describe("the envelope matches the spec", () => {
    test("the documented fields are the fields, with the same optionality", () => {
        // Parsed from both sides rather than compared against a list: `EventEnvelope` is a type,
        // so nothing at runtime can reflect it, and a hand-kept copy of its fields is the drift
        // this file exists to stop. The spec declared `agentId` **required** while the code has
        // always had it optional — a client that trusted the document would have dereferenced it.
        const types = readFileSync(join(CORE_SRC, "events", "types.ts"), "utf8")
        const block = types.slice(
            types.indexOf("export interface EventEnvelope"),
            types.indexOf("export type TurnEndReason"),
        )
        const code = [...block.matchAll(/^\s+readonly (\w+)(\??):/gm)].map(
            (match) => `${match[1]}${match[2] === "?" ? "?" : ""}`,
        )

        const specBlock = SPEC.slice(SPEC.indexOf("interface Event {"))
        const documented = [
            ...specBlock.slice(0, specBlock.indexOf("}")).matchAll(/^\s{2}(\w+)(\??):/gm),
        ].map((match) => `${match[1]}${match[2] === "?" ? "?" : ""}`)

        expect(documented).toEqual(code)
    })
})

describe("the routes match the spec", () => {
    /**
     * Read from the `router.add(...)` calls rather than from `Router#routes()`.
     *
     * `routes()` exists and is load-bearing — the dispatcher derives `Allow` from it — but reaching
     * it from a test means building a handler, which means a runtime, and the table is a property
     * of the *source* either way. Scanning the calls reads the real registrations with no API
     * widened for a test's convenience.
     */
    function codeRoutes(): Set<string> {
        const handler = readFileSync(join(SERVER_SRC, "handler.ts"), "utf8")
        return new Set(
            [...handler.matchAll(/router\.add\(\s*"([A-Z]+)",\s*"([^"]+)"/g)].map(
                (match) => `${match[1]} ${match[2]}`,
            ),
        )
    }

    function specRoutes(): Set<string> {
        return new Set(
            // `/v1` **or** the three browser-surface paths, which are the only routes this
            // server answers outside the API. Widened by naming them rather than by accepting any
            // path: a bare `\/\S*` would match a line of prose that happens to start with a verb
            // and a slash, and a guard that matches prose is one that goes green on a typo.
            [
                ...SPEC.matchAll(
                    /^(GET|POST|PATCH|DELETE|PUT)\s+(\/(?:v1[^\s?→]*|assets\/[^\s?→]*|))(?=[\s?]|$)/gm,
                ),
            ].map((match) => `${match[1]} ${match[2]}`),
        )
    }

    test("every documented route is registered", () => {
        // `/v1/ws` is the one exemption and it is real: the WebSocket upgrade is answered by
        // `serve.ts` before the HTTP router sees the request, so it is documented and correctly
        // absent from this table. Named here so the exemption is a decision rather than a gap.
        const upgrade = new Set(["GET /v1/ws"])
        const missing = [...specRoutes()].filter(
            (route) => !codeRoutes().has(route) && !upgrade.has(route),
        )
        expect(missing).toEqual([])
    })

    test("every registered route is documented", () => {
        const undocumented = [...codeRoutes()].filter((route) => !specRoutes().has(route))
        expect(undocumented).toEqual([])
    })
})

describe("the browser surface", () => {
    /**
     * The three routes and the asset table are two lists, so they get a guard.
     *
     * Writing them as literals is what made the spec guard able to see them at all — a
     * `for (const path of WEB_PATHS)` loop registered the same routes and stayed invisible to a
     * scanner that reads string literals, so they were undocumented and reported as compliant.
     * Literals bought that visibility and cost this: `WEB_ASSETS` can now gain a file that nothing
     * serves, or lose one that a route still points at. Both are red here.
     */
    test("every asset has a route and every route has an asset", () => {
        const handler = readFileSync(join(SERVER_SRC, "handler.ts"), "utf8")
        const registered = new Set(
            [...handler.matchAll(/router\.add\(\s*"GET",\s*"(\/(?!v1)[^"]*)"/g)].map(
                (match) => match[1] ?? "",
            ),
        )
        expect([...registered].sort()).toEqual([...WEB_PATHS].sort())
    })

    test("the shell and its assets need no credential", () => {
        // Derived from `WEB_PATHS` in `isOpenPath` rather than matched by prefix, so this asserts
        // the *set* rather than a rule. A `startsWith("/assets/")` would open any future path under
        // that directory, and the list of things served from a directory grows without anybody
        // re-reading the auth rule.
        const handler = readFileSync(join(SERVER_SRC, "handler.ts"), "utf8")
        expect(handler).toContain("WEB_PATHS.includes(pathname)")
    })
})

describe("the error codes match the spec", () => {
    test("every code the server can return is documented", () => {
        const literals = new Set<string>()
        for (const file of sources(SERVER_SRC)) {
            for (const match of file.text.matchAll(/code:\s*"([a-z0-9_]+)"/g)) {
                literals.add(match[1] ?? "")
            }
        }
        // `notFound(kind, id)` builds `<kind>_not_found`, so those four never appear as literals
        // and a scan for literals alone would miss the codes a client meets most often.
        for (const kind of ["agent", "session", "turn", "schedule"]) {
            literals.add(`${kind}_not_found`)
        }

        const documented = new Set(tableRows(ERROR_TABLE))
        expect(documented.size).toBeGreaterThan(15)
        expect([...literals].filter((code) => !documented.has(code)).sort()).toEqual([])
    })
})

describe("every reachable failure carries a hint", () => {
    /**
     * Hard rule 7, driven rather than read.
     *
     * The error-code table above proves a code is *documented*; this proves the response a client
     * actually receives is usable. They are different claims, and the gap between them is where
     * `turnTimeout` and `turnStopped` lived for several phases — written in Phase 1 with hints
     * included, invoked by nothing, so a timed-out turn returned three empty error columns and
     * exit 0.
     *
     * Green on arrival, which makes it a **lock** rather than a fix. Revert-checked by deleting one
     * `hint:` and watching it go red, because a guard that has never failed is a guard nobody has
     * tested.
     */
    const cases: { name: string; method: string; path: string; body?: unknown; code: string }[] = [
        { name: "no route", method: "GET", path: "/v1/nope", code: "not_found" },
        {
            name: "unknown agent",
            method: "GET",
            path: "/v1/agents/ghost",
            code: "agent_not_found",
        },
        {
            name: "unknown turn",
            method: "GET",
            path: "/v1/agents/assistant/turns/t_ghost/stream",
            code: "turn_not_found",
        },
        {
            name: "unknown session",
            method: "GET",
            path: "/v1/agents/assistant/sessions/nope",
            code: "session_not_found",
        },
        {
            name: "wrong method",
            method: "DELETE",
            path: "/v1/agents/assistant",
            code: "method_not_allowed",
        },
        {
            name: "HEAD on a stream",
            method: "HEAD",
            path: "/v1/events",
            code: "method_not_allowed",
        },
        {
            name: "empty message text",
            method: "POST",
            path: "/v1/agents/assistant/messages",
            body: { text: "   " },
            code: "message_text_required",
        },
        {
            name: "unknown event type",
            method: "GET",
            path: "/v1/events?types=turn.ended",
            code: "unknown_event_type",
        },
        {
            name: "reload",
            method: "POST",
            path: "/v1/agents/assistant/reload",
            code: "reload_not_supported",
        },
        {
            name: "stopping a turn with no handle",
            method: "POST",
            path: "/v1/agents/assistant/turns/t_ghost/stop",
            code: "turn_not_running",
        },
    ]

    test("ten failures, each with a code and a non-empty hint", async () => {
        const { call, runtime } = await harness()
        const seen: Record<string, string> = {}

        for (const scenario of cases) {
            const response = await call(scenario.method, scenario.path, {
                ...(scenario.body === undefined ? {} : { body: scenario.body }),
            })
            expect(response.status).toBeGreaterThanOrEqual(400)
            const body = (await response.json()) as {
                error?: { code?: string; message?: string; hint?: string }
            }
            seen[scenario.name] = body.error?.code ?? "(no code)"
            expect(body.error?.message ?? "").not.toBe("")
            // The expensive part of a failure is almost never the failure — it is that the failure
            // did not say what was wrong.
            expect(body.error?.hint ?? "").not.toBe("")
        }

        expect(seen).toEqual(
            Object.fromEntries(cases.map((scenario) => [scenario.name, scenario.code])),
        )
        await runtime.stop()
    })

    test("the unknown-event-type hint names the nearest real type", async () => {
        // `?types=turn.ended` is the plural nobody can keep straight, and before `EVENT_TYPES`
        // existed it opened a stream that matched nothing and stayed open forever.
        const { call, runtime } = await harness()
        const body = (await (await call("GET", "/v1/events?types=turn.ended")).json()) as {
            error: { hint: string }
        }
        expect(body.error.hint).toContain("turn.end")
        await runtime.stop()
    })
})
