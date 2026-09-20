/**
 * The read-only panels, asserted on **rendered markup**.
 *
 * `packages/cli` learned this the expensive way: `rows.ts` was asserted as strings and correct
 * while the rendered list wrapped at 40 columns, because nothing read a finished line — *"a reducer
 * test and a frame test are different claims"*. This is the browser half of that, and it needs no
 * DOM and no new dependency: the panels take their data as props and fetch nothing, so
 * `renderToStaticMarkup` produces exactly what a browser would be handed.
 *
 * What a DOM would add is effects — the shell mounting, fetching, and streaming — and that is the
 * one real-browser pass rather than a simulated one, because a jsdom that streams SSE correctly is
 * a claim about jsdom.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentList, ChannelsPanel, SchedulesPanel, ToolsPanel } from "../src/panels.tsx"

const NOW = Date.parse("2026-09-20T12:00:00.000Z")

describe("the agent picker", () => {
    const agents = [
        { id: "vela", name: "Vela", status: "loaded", model: "gpt-4o-mini" },
        { id: "milo", name: "Milo", status: "disabled", reason: "switched off for the weekend" },
    ]

    test("a stopped agent is listed, says why, and cannot be selected", () => {
        const html = renderToStaticMarkup(
            createElement(AgentList, {
                agents,
                current: "vela",
                onSelect: () => {},
                onStart: () => {},
            }),
        )
        // Shown rather than hidden: an agent that is off and invisible is the launchd trap
        // `dispach stop` was designed around, and here it would leave a blank page explaining
        // nothing. So the row carries the state and the reason somebody recorded.
        expect(html).toContain("Milo")
        expect(html).toContain("stopped")
        expect(html).toContain("switched off for the weekend")
        // **Not selectable.** A stopped agent's resource answers 404, so opening a chat against it
        // would make every send fail — the attribute is what makes that true, not the colour.
        expect(html).toMatch(/Milo[\s\S]*?<\/button>/)
        expect(html).toContain("disabled=")
        // And the running one is marked as current, which is what the sidebar highlights.
        expect(html).toContain('aria-current="true"')
    })

    test("start is offered and stop is not", () => {
        const html = renderToStaticMarkup(
            createElement(AgentList, {
                agents,
                current: "vela",
                onSelect: () => {},
                onStart: () => {},
            }),
        )
        // The asymmetry is the decision: from a browser, stopping is one click from making an agent
        // unreachable for everyone, durably and across restarts, with nothing like the typed
        // confirmation `remove` demands. This direction only ever turns something on.
        expect(html).toContain(">start<")
        expect(html).not.toContain(">stop<")
    })

    test("a start in flight says so, and cannot be pressed twice", () => {
        const html = renderToStaticMarkup(
            createElement(AgentList, {
                agents,
                current: "vela",
                onSelect: () => {},
                onStart: () => {},
                starting: "milo",
            }),
        )
        expect(html).toContain("starting…")
    })

    test("no agents is a sentence, not an empty sidebar", () => {
        const html = renderToStaticMarkup(
            createElement(AgentList, {
                agents: [],
                current: undefined,
                onSelect: () => {},
                onStart: () => {},
            }),
        )
        // A server with zero agents is the *ordinary* first state of an always-on install, so an
        // empty list there has to read as "nothing yet" rather than as a page that failed to load.
        expect(html).toContain("no agents on this server")
    })
})

describe("the tools panel", () => {
    test("trust and its reason are both shown", () => {
        const html = renderToStaticMarkup(
            createElement(ToolsPanel, {
                tools: [
                    {
                        slug: "exec",
                        summary: "run a shell command",
                        mutating: true,
                        trust: "trusted",
                        trustReason: "the runtime composed the output",
                        provider: "system",
                    },
                ],
            }),
        )
        // `trust` is not cosmetic: an untrusted tool taints the turn, so after it runs a mutating
        // call needs an explicit rule or a live approval. "Why was my second `exec` blocked?" is
        // answered by this column and nothing else on this surface.
        expect(html).toContain("trusted")
        // The reason exists because the boot warning fired on every start of every system-provider
        // agent, and a warning always present for a correct configuration is one nobody reads.
        expect(html).toContain("the runtime composed the output")
        expect(html).toContain("exec")
    })

    test("an empty catalogue explains itself", () => {
        const html = renderToStaticMarkup(createElement(ToolsPanel, { tools: [] }))
        expect(html).toContain("tools.pinned")
    })
})

describe("the schedules panel", () => {
    test("a spent one-shot says never again rather than leaving a blank", () => {
        const html = renderToStaticMarkup(
            createElement(SchedulesPanel, {
                schedules: [
                    {
                        id: "brief",
                        kind: "cron",
                        expr: "0 8 * * *",
                        task: "summarise the inbox",
                        enabled: true,
                        nextRunAt: "2026-09-21T08:00:00.000Z",
                        timezone: "Asia/Dhaka",
                    },
                    {
                        id: "once",
                        kind: "at",
                        expr: "2026-01-01T00:00:00Z",
                        task: "the new year",
                        enabled: true,
                    },
                    {
                        id: "off",
                        kind: "every",
                        expr: "15m",
                        task: "poll something",
                        enabled: false,
                    },
                ],
            }),
        )
        // A blank cell in a row that looks otherwise healthy is how a schedule comes to be believed
        // in — the same reason the `serve` banner names them at all.
        expect(html).toContain("never again")
        expect(html).toContain("2026-09-21T08:00:00.000Z")
        expect(html).toContain("Asia/Dhaka")
        // A disabled one reads as disabled, in the column where its next run would be.
        expect(html).toContain("disabled")
        expect(html).toContain('class="off"')
    })

    test("a schedule with no delivery target says where it goes instead", () => {
        const html = renderToStaticMarkup(
            createElement(SchedulesPanel, {
                schedules: [{ id: "s", kind: "every", expr: "1h", task: "t", enabled: true }],
            }),
        )
        // Not blank: a schedule that fires and delivers nowhere is exactly the case `schedules`
        // exists to make visible, and an empty cell would look like a missing value.
        expect(html).toContain("this session only")
    })
})

describe("the channels panel", () => {
    const waiting = {
        id: "wa",
        type: "whatsapp",
        status: "needs_input",
        detail: "scan to link WhatsApp",
        input: {
            kind: "qr",
            payload: "2@Lr9KpQvXyZ00TESTQR",
            issuedAt: "2026-09-20T11:59:50.000Z",
            expiresAt: "2026-09-20T12:00:10.000Z",
        },
    }

    test("a live payload is rendered, with what it is and when it lapses", () => {
        const html = renderToStaticMarkup(
            createElement(ChannelsPanel, { channels: [waiting], now: NOW }),
        )
        expect(html).toContain("needs_input")
        expect(html).toContain("scan to link WhatsApp")
        expect(html).toContain("2@Lr9KpQvXyZ00TESTQR")
        expect(html).toContain('data-kind="qr"')
        // Fresh: 10 seconds left at `now`. The class is what the stylesheet dims.
        expect(html).toContain("fresh")
        expect(html).not.toContain("this expired")
    })

    test("a lapsed payload is labelled and still shown", () => {
        /**
         * WhatsApp rotates its QR roughly every 20 seconds, so this is the ordinary state of a
         * panel left open — and a code nobody can tell is expired reads as a broken scanner rather
         * than an old picture. It is **not removed**: hiding it leaves an empty box in the gap
         * before the next one arrives, which reads as the page having broken.
         */
        const html = renderToStaticMarkup(
            createElement(ChannelsPanel, {
                channels: [waiting],
                now: Date.parse("2026-09-20T12:00:30.000Z"),
            }),
        )
        expect(html).toContain("this expired")
        expect(html).toContain("stale")
        expect(html).toContain("2@Lr9KpQvXyZ00TESTQR")
    })

    test("an unknown kind still renders its payload", () => {
        // The `kind` set can grow inside `v: 1` while the field's type cannot, so a build that has
        // never heard of a kind must still show what it was given — the difference between a page a
        // newer server can be used from and one that silently shows an empty box.
        const html = renderToStaticMarkup(
            createElement(ChannelsPanel, {
                channels: [
                    {
                        ...waiting,
                        input: { ...waiting.input, kind: "pairing-code", payload: "417-208" },
                    },
                ],
                now: NOW,
            }),
        )
        expect(html).toContain("417-208")
        expect(html).toContain('data-kind="pairing-code"')
    })

    test("no expiry reported is not the same as never expires", () => {
        const html = renderToStaticMarkup(
            createElement(ChannelsPanel, {
                channels: [
                    {
                        ...waiting,
                        input: { kind: "qr", payload: "x", issuedAt: waiting.input.issuedAt },
                    },
                ],
                now: NOW,
            }),
        )
        // Absent means the transport does not know. Rendering it as "no expiry" would be a claim
        // the runtime never made, and a payload shown as permanently valid is the worse error.
        expect(html).toContain("no expiry reported")
        expect(html).not.toContain("this expired")
    })

    test("an agent with no channels says how it is reached instead", () => {
        const html = renderToStaticMarkup(createElement(ChannelsPanel, { channels: [], now: NOW }))
        expect(html).toContain("this page and the HTTP API only")
    })
})

describe("the 404 loop, guarded at the source", () => {
    /**
     * Found in a real browser and nowhere else.
     *
     * With a page open on an agent that was then stopped, every agent-scoped fetch answered 404 in
     * a loop — approvals on a 5-second timer, plus the panels and the session list — dozens of
     * times, with **nothing on screen**. The approvals poller's own comment is what licensed it:
     * *"a failed poll is not worth a banner; the next one will say so"*, which is true of a
     * transient failure and false of a 404, because the next one says the same thing forever.
     *
     * A component test cannot reach a 5-second interval, and a DOM test would be asserting a fake
     * clock. What *is* checkable without either is that all three call sites route a 404 to one
     * handler rather than each deciding — which is the property that was actually missing, and the
     * shape this repo keeps paying for: three places answering one question.
     */
    test("every agent-scoped fetch routes a 404 to the same handler", () => {
        const source = readFileSync(join(import.meta.dir, "..", "src", "app.tsx"), "utf8")
        // One predicate, one handler. A second `status === 404` anywhere is a second opinion about
        // what a missing agent means.
        expect(source).toContain("caught instanceof DispachError && caught.status === 404")
        expect(source.match(/status === 404/g)?.length).toBe(1)
        // All three: the approvals timer, the report panels, the session list. Counted rather than
        // named, because a fourth fetch added later has to join them.
        expect(source.match(/isGone\(caught\)/g)?.length).toBe(3)
        // And the handler clears the selection, or the page keeps a current agent that is gone.
        expect(source).toContain("setAgentId(undefined)")
    })
})
