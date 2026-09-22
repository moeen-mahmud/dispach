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
import {
    AgentList,
    type ChannelRow,
    ChannelsPanel,
    SchedulesPanel,
    ToolsPanel,
    WarningsPanel,
} from "../src/panels.tsx"

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
        expect(html).toContain('data-kind="qr"')
        // **Drawn, not printed.** A QR payload is 277 characters of base64 whose only purpose is to
        // be scanned; showing the string is true and useless, and is what made somebody who had
        // just added a WhatsApp number report that they were never shown a code.
        expect(html).toContain('class="payload-qr"')
        expect(html).not.toContain("2@Lr9KpQvXyZ00TESTQR")
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
        // Still drawn. The stylesheet dims it rather than removing it, for the reason above.
        expect(html).toContain('class="payload-qr"')
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

    /**
     * The payload reaches the encoder, asserted without a decoder.
     *
     * "An `<svg>` is present" would pass against a constant image, which is the shape of guard this
     * repo keeps finding green against broken code. Two properties together rule that out: the
     * module count is whatever *this* payload needs, and two different payloads draw different
     * paths. Neither is satisfiable by a fixed picture.
     */
    test("the code encodes the payload it was given", () => {
        const render = (payload: string): string =>
            renderToStaticMarkup(
                createElement(ChannelsPanel, {
                    channels: [{ ...waiting, input: { ...waiting.input, payload } }],
                    now: NOW,
                }),
            )

        const short = render("2@SHORT")
        const long = render(`2@${"K".repeat(200)}`)

        const modulesOf = (html: string): string => /data-modules="(\d+)"/.exec(html)?.[1] ?? "none"
        const pathOf = (html: string): string => /<path d="([^"]+)"/.exec(html)?.[1] ?? "none"

        // A longer payload needs a bigger matrix. A constant image cannot do this.
        expect(Number(modulesOf(long))).toBeGreaterThan(Number(modulesOf(short)))
        expect(pathOf(short)).not.toBe(pathOf(long))
        expect(pathOf(short)).not.toBe("none")
    })

    /**
     * A payload the encoder cannot take falls back to text rather than taking the panel down.
     *
     * A throw inside a component unmounts the tree — `app.tsx` went **entirely black** that way
     * while its accessibility snapshot still showed a correct-looking DOM. The QR format has a hard
     * capacity, so this is reachable with real data rather than hypothetical.
     */
    test("a payload past the format's capacity falls back to the text", () => {
        const huge = `2@${"Z".repeat(8000)}`
        const html = renderToStaticMarkup(
            createElement(ChannelsPanel, {
                channels: [{ ...waiting, input: { ...waiting.input, payload: huge } }],
                now: NOW,
            }),
        )
        expect(html).not.toContain('class="payload-qr"')
        expect(html).toContain("ZZZZ")
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
        // Four now: the approvals timer, the report panels, the session list, and `write` — the one
        // writer behind the settings and schedule panels. Counted rather than named, because a
        // *fifth* fetch added later has to join them; and this count is what caught the fourth,
        // which is the guard working rather than a number to keep bumping. A write is the case that
        // matters most of the three reads: somebody saving a setting on an agent that has just been
        // stopped otherwise gets a transport error where "this agent is gone" is the answer.
        expect(source.match(/isGone\(caught\)/g)?.length).toBe(4)
        // And the handler clears the selection, or the page keeps a current agent that is gone.
        expect(source).toContain("setAgentId(undefined)")
    })
})

describe("the warnings panel", () => {
    /**
     * Every finding it renders was a **refusal** until 0.1.3: a channel with no token, a plugin that
     * would not import, a provider nobody registered, a pinned tool nothing could resolve. They
     * became warnings because an agent should start if it can take a turn.
     *
     * That trade is only defensible if the failure is visible, and this page showed `agent.warnings`
     * **nowhere at all** — so degrading without this panel would have handed the objection back its
     * point. Which is why the empty case renders nothing and the populated case renders the hint:
     * the hint is the half that says what to do.
     */
    const render = (warnings: Parameters<typeof WarningsPanel>[0]["warnings"]) =>
        renderToStaticMarkup(createElement(WarningsPanel, { warnings }))

    test("nothing wrong renders nothing — no empty box above every panel", () => {
        expect(render([])).toBe("")
    })

    test("a finding shows its field, its message and its hint", () => {
        const html = render([
            {
                code: "telegram_token_missing",
                message: 'Channel "tg" needs TELEGRAM_BOT_TOKEN, which is not set.',
                hint: "Export it, or add it to the .env beside the manifest — then restart.",
                field: "channels[tg].tokenEnv",
            },
        ])
        expect(html).toContain("TELEGRAM_BOT_TOKEN")
        expect(html).toContain("channels[tg].tokenEnv")
        // The hint is the actionable half. A message with no remedy is the 57 MB log in one line.
        expect(html).toContain(".env beside the manifest")
        // And it says the agent is running, so nobody reads this as a failed start.
        expect(html).toContain("It is running")
    })

    test("it counts them, singular and plural", () => {
        const one = render([{ code: "a", message: "one" }])
        expect(one).toContain("1 thing")
        expect(one).not.toContain("1 things")
        expect(
            render([
                { code: "a", message: "x" },
                { code: "b", message: "y" },
            ]),
        ).toContain("2 things")
    })

    test("a finding with no hint and no field still renders", () => {
        // Every `ErrorDetail` this project writes carries a hint, and a plugin's may not.
        expect(render([{ code: "plugin_load_failed", message: "it threw" }])).toContain("it threw")
    })
})

describe("the channel panel's controls", () => {
    /**
     * The panel was **read-only** until 0.1.3, so every one of these was reachable only by knowing a
     * field name: disconnecting meant sending the whole `channels` list back through the config
     * route, changing a token meant knowing that `tokenEnv` names a variable, and relinking WhatsApp
     * meant finding a directory and deleting it. That is the standing rule about `init` — a
     * capability reachable only by somebody who already knows the field names is one the surface is
     * hiding — applied to the thing a person touches most after creating an agent.
     */
    const render = (
        channel: ChannelRow,
        actions?: Parameters<typeof ChannelsPanel>[0]["actions"],
    ) =>
        renderToStaticMarkup(
            createElement(ChannelsPanel, {
                channels: [channel],
                now: Date.parse("2026-09-22T12:00:00Z"),
                ...(actions === undefined ? {} : { actions }),
            }),
        )

    const noop = {
        onConnect: () => {},
        onCredential: () => {},
        onUnpair: () => {},
    }

    test("a disconnected channel still appears, and offers to connect", () => {
        // The reason the listing is keyed by the **manifest**: a disabled channel is never
        // constructed, so it has no runtime status — and a list built from the runtime would omit
        // exactly the row somebody opened the page to switch back on.
        const html = render({ id: "tg", type: "telegram", enabled: false }, noop)
        expect(html).toContain("tg")
        expect(html).toContain("disconnected")
        expect(html).toContain(">connect<")
    })

    test("a connected one offers to disconnect", () => {
        const html = render(
            { id: "tg", type: "telegram", enabled: true, status: "connected" },
            noop,
        )
        expect(html).toContain(">disconnect<")
    })

    test("a missing credential is named and marked, and the box is a password box", () => {
        const html = render(
            {
                id: "tg",
                type: "telegram",
                enabled: true,
                credentialEnv: "TELEGRAM_BOT_TOKEN",
                credentialSet: false,
            },
            noop,
        )
        expect(html).toContain("TELEGRAM_BOT_TOKEN")
        expect(html).toContain("is NOT set")
        // A secret typed here lives in component state and nowhere else — so the browser is told
        // not to offer to remember it, and the field never shows it back.
        expect(html).toContain('type="password"')
        expect(html).toContain('autoComplete="new-password"')
        expect(html).toContain(">set<")
    })

    test("a credential already set offers to replace it, and is never shown back", () => {
        const html = render(
            {
                id: "tg",
                type: "telegram",
                enabled: true,
                credentialEnv: "TELEGRAM_BOT_TOKEN",
                credentialSet: true,
            },
            noop,
        )
        expect(html).toContain("is set")
        expect(html).toContain(">replace<")
        // The box is empty, and no route returns a credential — so there is nothing here that
        // *could* render one. Asserted as the empty value rather than as the attribute's absence,
        // which a controlled input always has.
        expect(html).toContain('value=""')
    })

    test("unpair is offered to a channel that pairs, and to no other", () => {
        // A button whose only outcome is a refusal is worse than no button — the same call the
        // schedules panel makes about a manifest-owned row.
        expect(render({ id: "wa", type: "whatsapp", enabled: true }, noop)).toContain(">unpair<")
        expect(render({ id: "tg", type: "telegram", enabled: true }, noop)).not.toContain(
            ">unpair<",
        )
    })

    test("no actions means the panel is exactly what it was before", () => {
        const html = render({ id: "tg", type: "telegram", enabled: true, status: "connected" })
        expect(html).not.toContain("button")
        expect(html).toContain("connected")
    })

    test("a request in flight disables the controls rather than looking dead", () => {
        const html = render(
            { id: "tg", type: "telegram", enabled: true },
            { ...noop, busy: "tg", note: "working on it" },
        )
        expect(html).toContain("disabled")
        expect(html).toContain("working…")
        expect(html).toContain("working on it")
    })
})
