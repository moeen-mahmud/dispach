/**
 * The pilot monitor — layer 3 of testing an agent: cheap checks on every real turn, and alerts on a
 * falling *rolling rate*, never on one failure.
 *
 * Every silo the control plane creates is subscribed, with the silo's own token, to the events the
 * rates need. They arrive as Standard Webhooks at `/hooks/<subject>`, signed with that
 * subscription's secret and verified here (this package imports nothing from the runtime, so the
 * verification is its own few lines). A redelivery keeps its `webhook-id`, so a retry is ignored
 * rather than counted twice.
 *
 * What it reports, over the last N turns: the share that did not end `final`, the reasons, steps,
 * duration and first-token percentiles, tokens per turn, tool errors, and lost deliveries. What it
 * alerts on, once on crossing and once on recovery: the non-final share, the tool error share, and —
 * immediately, because a lost message is a Sev-1 — any delivery that exhausted its retries.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { BRAND } from "./brand.ts"
import { ControlError } from "./placer.ts"
import type { MonitorEvent, Silo, SiloStore } from "./store.ts"

/** What a silo is subscribed to. `model.result` carries `firstTokenMs`; `turn.end` the rest. */
export const MONITORED_TYPES = [
    "turn.end",
    "model.result",
    "tool.result",
    "delivery.failed",
    "approval.requested",
] as const

export interface AlertRules {
    /** How many recent turns a rate is taken over. */
    readonly window: number
    /** Fewer turns than this in the window and no rate alert fires: four turns are not a trend. */
    readonly minTurns: number
    readonly nonFinal: number
    readonly toolErrors: number
}

export const DEFAULT_RULES: AlertRules = {
    window: 50,
    minTurns: 20,
    nonFinal: 0.05,
    toolErrors: 0.1,
}

export interface MonitorOptions {
    readonly store: SiloStore
    /** Where a silo reaches this process: `http://control:7600` on a Docker network. */
    readonly hookUrl: string
    readonly rules?: AlertRules
    /** Sends one alert line. Defaults to stderr. */
    readonly alert?: (text: string) => Promise<void>
    readonly log?: (line: string) => void
    readonly now?: () => number
}

/** A silo request made with the silo's own token — the control plane's `siloFetch`. */
export type SiloFetch = (silo: Silo, path: string, init?: RequestInit) => Promise<Response>

const TOLERANCE_S = 300

/** Standard Webhooks verification: `v1,<base64 HMAC-SHA256(id.ts.body)>`, any of several. */
export function verifySignature(
    secret: string,
    headers: { id?: string; timestamp?: string; signature?: string },
    body: string,
    nowS: number,
): boolean {
    const { id, timestamp, signature } = headers
    if (id === undefined || timestamp === undefined || signature === undefined) return false
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest()
    return signature.split(" ").some((part) => {
        const [version, value] = part.split(",")
        if (version !== "v1" || value === undefined) return false
        const given = Buffer.from(value, "base64")
        return given.length === expected.length && timingSafeEqual(given, expected)
    })
}

function percentile(values: readonly number[], p: number): number | undefined {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export interface Rates {
    readonly turns: number
    readonly nonFinalRate: number
    readonly reasons: Readonly<Record<string, number>>
    readonly steps: { readonly p50?: number; readonly max?: number }
    readonly durationMs: { readonly p50?: number; readonly p95?: number }
    readonly firstTokenMs: { readonly p50?: number; readonly p95?: number }
    readonly tokensPerTurn?: number
    readonly toolCalls: number
    readonly toolErrorRate: number
    readonly deliveriesLost: number
    readonly approvalsRequested: number
}

export class Monitor {
    readonly #store: SiloStore
    readonly #hookUrl: string
    readonly #rules: AlertRules
    readonly #alert: (text: string) => Promise<void>
    readonly #log: (line: string) => void
    readonly #now: () => number
    /** Rules currently firing, so each alerts once on crossing and once on recovery. */
    readonly #firing = new Set<string>()

    constructor(options: MonitorOptions) {
        this.#store = options.store
        this.#hookUrl = options.hookUrl.replace(/\/+$/, "")
        this.#rules = options.rules ?? DEFAULT_RULES
        this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
        this.#alert =
            options.alert ??
            (async (text) => {
                this.#log(`ALERT ${text}`)
            })
        this.#now = options.now ?? Date.now
    }

    /**
     * Subscribe a silo, once. A refusal is logged and left for the next `attachAll` rather than
     * failing the silo: an unmonitored silo still serves its user, and `report()` names it.
     */
    async attach(silo: Silo, siloFetch: SiloFetch): Promise<void> {
        if (this.#store.hook(silo.subject) !== undefined) return
        const response = await siloFetch(silo, "/v1/webhooks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                url: `${this.#hookUrl}/hooks/${encodeURIComponent(silo.subject)}`,
                types: MONITORED_TYPES,
            }),
        })
        const body = (await response.json()) as {
            subscriptionId?: string
            secret?: string
            error?: { code: string; message: string; hint: string }
        }
        if (!response.ok || body.subscriptionId === undefined || body.secret === undefined) {
            this.#log(
                `monitor: ${silo.subject} not subscribed: ${body.error?.code ?? response.status} ${body.error?.message ?? ""}\n  hint: ${
                    body.error?.code === "webhook_target_refused"
                        ? `the silo refuses a private address it has not been allowed. Add the control plane's host to DISPACH_WEBHOOK_ALLOW and name it in DISPACH_CONTROL_SILO_ENV, then recreate the silo.`
                        : (body.error?.hint ?? "see the silo's own error above.")
                }`,
            )
            return
        }
        this.#store.setHook(silo.subject, body.subscriptionId, body.secret)
        this.#log(`monitor: ${silo.subject} subscribed`)
    }

    /**
     * Subscribe again from scratch, after a restore replaced the silo's store.
     *
     * The archive carries the *source* silo's subscription: restored into another subject, that silo
     * would report as the source, and its own subscription is gone. So every subscription in it that
     * points at this monitor is deleted and a fresh one made.
     */
    async reattach(silo: Silo, siloFetch: SiloFetch): Promise<void> {
        const listed = await siloFetch(silo, "/v1/webhooks")
        const body = (await listed.json()) as {
            webhooks?: { subscriptionId: string; url: string }[]
        }
        for (const hook of body.webhooks ?? []) {
            if (hook.url.startsWith(`${this.#hookUrl}/hooks/`)) {
                await siloFetch(silo, `/v1/webhooks/${encodeURIComponent(hook.subscriptionId)}`, {
                    method: "DELETE",
                })
            }
        }
        this.#store.deleteHook(silo.subject)
        await this.attach(silo, siloFetch)
    }

    /**
     * Record one delivery. Throws `401` for anything not signed by that silo's subscription — the
     * route is reachable by whoever can reach this port, so an unsigned body is noise at best.
     */
    async receive(
        subject: string,
        headers: { id?: string; timestamp?: string; signature?: string },
        body: string,
    ): Promise<void> {
        const hook = this.#store.hook(subject)
        if (
            hook === undefined ||
            !verifySignature(hook.secret, headers, body, Math.floor(this.#now() / 1000))
        ) {
            throw new ControlError({
                code: "hook_unverified",
                message: "Not a delivery this control plane subscribed to.",
                hint: "Deliveries are signed by the silo with the subscription's secret; this one did not verify, or the subject has no subscription.",
                status: 401,
            })
        }
        const envelope = JSON.parse(body) as {
            type: string
            ts: string
            agentId?: string
            turnId?: string
            data?: Record<string, unknown>
        }
        const data = envelope.data ?? {}
        const num = (value: unknown) => (typeof value === "number" ? value : undefined)
        const tokens = data.tokens as { prompt?: number; output?: number } | undefined
        const error = data.error as { code?: string; message?: string } | undefined
        const event: MonitorEvent = {
            webhookId: headers.id ?? "",
            subject,
            type: envelope.type,
            at: envelope.ts,
            ...(envelope.agentId === undefined ? {} : { agentId: envelope.agentId }),
            ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
            ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
            ...(num(data.steps) === undefined ? {} : { steps: num(data.steps) as number }),
            ...(num(data.durationMs) === undefined
                ? {}
                : { durationMs: num(data.durationMs) as number }),
            ...(num(data.firstTokenMs) === undefined
                ? {}
                : { firstTokenMs: num(data.firstTokenMs) as number }),
            ...(num(tokens?.prompt ?? data.promptTokens) === undefined
                ? {}
                : { promptTokens: num(tokens?.prompt ?? data.promptTokens) as number }),
            ...(num(tokens?.output ?? data.outputTokens) === undefined
                ? {}
                : { outputTokens: num(tokens?.output ?? data.outputTokens) as number }),
            ...(typeof data.ok === "boolean" ? { ok: data.ok } : {}),
            ...(envelope.type === "tool.result" && typeof data.slug === "string"
                ? { detail: data.slug }
                : {}),
            ...(envelope.type === "delivery.failed"
                ? {
                      detail: `${data.exhausted === true ? "exhausted" : "retrying"}: ${error?.code ?? ""} ${error?.message ?? ""}`.trim(),
                  }
                : {}),
            ...(envelope.type === "approval.requested" && typeof data.slug === "string"
                ? { detail: data.slug }
                : {}),
        }
        if (!this.#store.recordEvent(event)) return
        if (event.type === "delivery.failed" && data.exhausted === true) {
            await this.#send(
                `lost message in ${subject} (agent ${event.agentId ?? "?"}): ${event.detail ?? ""}`,
            )
        }
        if (event.type === "turn.end" || event.type === "tool.result") await this.#evaluate()
    }

    /** Rates over the last `window` turns, overall or for one silo. */
    rates(subject?: string, window = this.#rules.window): Rates {
        const turns = this.#store.events("turn.end", window, subject)
        // A turn's model and tool events happen *before* its turn.end, so the window opens at the
        // oldest turn's start (its end minus its duration), and those events are counted by turn id —
        // not by the end time, which cut the oldest turn's own first-token and tool rows off.
        const starts = turns.map((t) => Date.parse(t.at) - (t.durationMs ?? 0))
        const since = new Date(
            starts.length === 0 ? this.#now() : Math.min(...starts),
        ).toISOString()
        const inWindow = new Set(turns.flatMap((t) => (t.turnId === undefined ? [] : [t.turnId])))
        const ofTheseTurns = (e: MonitorEvent) => e.turnId !== undefined && inWindow.has(e.turnId)
        const tools = this.#store.eventsSince("tool.result", since, subject).filter(ofTheseTurns)
        const results = this.#store.eventsSince("model.result", since, subject).filter(ofTheseTurns)
        const lost = this.#store
            .eventsSince("delivery.failed", since, subject)
            .filter((e) => e.detail?.startsWith("exhausted") === true)
        const approvals = this.#store.eventsSince("approval.requested", since, subject)

        // A turn's first token is its first model call's; later steps start after tools ran.
        const firstByTurn = new Map<string, number>()
        for (const result of results) {
            if (
                result.turnId !== undefined &&
                result.firstTokenMs !== undefined &&
                !firstByTurn.has(result.turnId)
            ) {
                firstByTurn.set(result.turnId, result.firstTokenMs)
            }
        }
        const reasons: Record<string, number> = {}
        for (const turn of turns)
            reasons[turn.reason ?? "unknown"] = (reasons[turn.reason ?? "unknown"] ?? 0) + 1
        const nonFinal = turns.filter((t) => t.reason !== "final").length
        const toolErrors = tools.filter((t) => t.ok === false).length
        const tokens = turns.map((t) => (t.promptTokens ?? 0) + (t.outputTokens ?? 0))
        const steps = turns.map((t) => t.steps ?? 0)
        const durations = turns.flatMap((t) => (t.durationMs === undefined ? [] : [t.durationMs]))
        const firsts = turns.flatMap((t) => {
            const value = t.turnId === undefined ? undefined : firstByTurn.get(t.turnId)
            return value === undefined ? [] : [value]
        })
        return {
            turns: turns.length,
            nonFinalRate: turns.length === 0 ? 0 : nonFinal / turns.length,
            reasons,
            steps: {
                ...(steps.length === 0
                    ? {}
                    : { p50: percentile(steps, 50) as number, max: Math.max(...steps) }),
            },
            durationMs: {
                ...(durations.length === 0
                    ? {}
                    : {
                          p50: percentile(durations, 50) as number,
                          p95: percentile(durations, 95) as number,
                      }),
            },
            firstTokenMs: {
                ...(firsts.length === 0
                    ? {}
                    : {
                          p50: percentile(firsts, 50) as number,
                          p95: percentile(firsts, 95) as number,
                      }),
            },
            ...(tokens.length === 0
                ? {}
                : { tokensPerTurn: Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) }),
            toolCalls: tools.length,
            toolErrorRate: tools.length === 0 ? 0 : toolErrors / tools.length,
            deliveriesLost: lost.length,
            approvalsRequested: approvals.length,
        }
    }

    /** Overall, per silo, and which silos have no subscription. */
    report(silos: readonly Silo[]) {
        return {
            rules: this.#rules,
            firing: [...this.#firing],
            overall: this.rates(),
            silos: silos.map((silo) => ({ subject: silo.subject, ...this.rates(silo.subject) })),
            unmonitored: silos
                .filter((silo) => this.#store.hook(silo.subject) === undefined)
                .map((s) => s.subject),
        }
    }

    /** Turns that did not end `final`, failed tool calls and lost deliveries — the rows to label. */
    failures(limit = 50) {
        const turns = this.#store.events("turn.end", limit * 4).filter((t) => t.reason !== "final")
        const tools = this.#store.events("tool.result", limit * 4).filter((t) => t.ok === false)
        const lost = this.#store.events("delivery.failed", limit)
        return [...turns, ...tools, ...lost]
            .sort((a, b) => (a.at < b.at ? 1 : -1))
            .slice(0, limit)
            .map((e) => ({
                at: e.at,
                subject: e.subject,
                agentId: e.agentId,
                turnId: e.turnId,
                type: e.type,
                ...(e.reason === undefined ? {} : { reason: e.reason }),
                ...(e.detail === undefined ? {} : { detail: e.detail }),
            }))
    }

    async #evaluate(): Promise<void> {
        const rates = this.rates()
        if (rates.turns < this.#rules.minTurns) return
        await this.#rule(
            "non-final turns",
            rates.nonFinalRate > this.#rules.nonFinal,
            `${(rates.nonFinalRate * 100).toFixed(1)}% of the last ${rates.turns} turns did not end final (limit ${(this.#rules.nonFinal * 100).toFixed(0)}%): ${JSON.stringify(rates.reasons)}`,
        )
        await this.#rule(
            "tool errors",
            rates.toolCalls > 0 && rates.toolErrorRate > this.#rules.toolErrors,
            `${(rates.toolErrorRate * 100).toFixed(1)}% of ${rates.toolCalls} tool calls failed (limit ${(this.#rules.toolErrors * 100).toFixed(0)}%)`,
        )
    }

    async #rule(name: string, crossed: boolean, detail: string): Promise<void> {
        if (crossed && !this.#firing.has(name)) {
            this.#firing.add(name)
            await this.#send(`${name}: ${detail}`)
        } else if (!crossed && this.#firing.has(name)) {
            this.#firing.delete(name)
            await this.#send(`recovered — ${name}`)
        }
    }

    async #send(text: string): Promise<void> {
        try {
            await this.#alert(text)
        } catch (error) {
            // An alert that could not be sent is still an alert: said where somebody reads logs.
            this.#log(`ALERT (not delivered: ${String(error)}) ${text}`)
        }
    }
}

/** An alert sender posting to one Telegram chat through the Bot API. */
export function telegramAlert(token: string, chatId: string): (text: string) => Promise<void> {
    return async (text) => {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${BRAND.slug}: ${text}` }),
        })
        if (!response.ok)
            throw new Error(
                `Telegram answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
            )
    }
}
