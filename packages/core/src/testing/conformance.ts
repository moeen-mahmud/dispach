/**
 * `@dispach/core/testing` — the conformance suite every plugin runs against.
 *
 * ## Why it is assertions rather than a test file
 *
 * It returns findings and throws nothing. A plugin author's test runner is theirs — `bun test`,
 * `node --test`, Vitest — and a suite that assumed one would be unusable by two thirds of them. So
 * this reports and the caller decides, which is the same reasoning that makes `ruleBudgetFailure`
 * return a finding instead of throwing: each caller applies its own policy.
 *
 * ## What it can and cannot check
 *
 * It checks the contract's *mechanical* half — the shape, the version range, the setup budget, that
 * `setup` registers something and does not do work. It cannot check the half that matters most:
 * whether `send()` is really idempotent, whether `resolve()` really throws on an unknown slug,
 * whether the plugin really avoids the network. Those are properties of code this suite calls once,
 * and a plugin that fails them fails them under conditions a conformance run does not create.
 *
 * Said plainly because a suite advertised as proving more than it does is worse than no suite: it
 * invites the belief that passing means safe. Passing means *well-formed*.
 */

import { EventBus } from "../events/bus.ts"
import { SETUP_BUDGET_MS } from "../plugins/loader.ts"
import type { Logger, Permission, Plugin, PluginContext } from "../plugins/plugin.ts"
import { satisfies } from "../plugins/semver.ts"
import { VERSION } from "../version.ts"

export interface Finding {
    /** `error` fails conformance; `warning` is a smell the author should see and may accept. */
    readonly level: "error" | "warning"
    readonly check: string
    readonly message: string
    /** What to do about it. Required, for the same reason every `ErrorDetail` carries one. */
    readonly hint: string
}

export interface ConformanceResult {
    readonly ok: boolean
    readonly findings: readonly Finding[]
    /** What `setup` registered, so a caller can assert a plugin registers what it claims to. */
    readonly registered: readonly string[]
    readonly setupMs: number
}

export interface ConformanceOptions {
    /** Config to hand `setup`, validated against the plugin's own schema first. Default `{}`. */
    readonly config?: Readonly<Record<string, unknown>>
    /** Host version to check the range against. Defaults to this build's. */
    readonly hostVersion?: string
}

const SILENT: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function isPermission(value: unknown): value is Permission {
    if (value === null || typeof value !== "object") return false
    const kind = (value as { kind?: unknown }).kind
    return (
        kind === "network" || kind === "env" || kind === "fs" || kind === "exec" || kind === "store"
    )
}

/**
 * Run the suite against a plugin.
 *
 * Calls `setup` exactly once, with a context whose `define*` methods record rather than wire
 * anything up — so a plugin under conformance registers into a void and nothing it hands over is
 * ever constructed. That is deliberate: constructing a channel transport would read a token, and a
 * conformance run must work on a machine with no credentials configured.
 */
export async function conformance(
    plugin: Plugin,
    options: ConformanceOptions = {},
): Promise<ConformanceResult> {
    const findings: Finding[] = []
    const registered: string[] = []
    const hostVersion = options.hostVersion ?? VERSION

    const error = (check: string, message: string, hint: string): void => {
        findings.push({ level: "error", check, message, hint })
    }
    const warn = (check: string, message: string, hint: string): void => {
        findings.push({ level: "warning", check, message, hint })
    }

    if (typeof plugin.name !== "string" || plugin.name === "") {
        error(
            "name",
            "The plugin has no name.",
            "`name` is how events, errors and `plugins` output refer to this plugin. It must be unique within a runtime.",
        )
    }
    if (satisfies(plugin.version, "*") === undefined) {
        error(
            "version",
            `\`version\` is ${JSON.stringify(plugin.version)}, which is not a plain semver triple.`,
            "Write it as `major.minor.patch`. It is reported verbatim in `plugin.loaded`, and a version nobody can compare is a version nobody can act on.",
        )
    }

    const decided = satisfies(hostVersion, plugin.dispachApi)
    if (decided === undefined) {
        error(
            "dispachApi",
            `\`dispachApi\` is ${JSON.stringify(plugin.dispachApi)}, which the host cannot check.`,
            "Supported: `*`, an exact version, `^`, `~`, space-separated comparators, and `||`. A range the host cannot parse is refused rather than assumed satisfied, so this plugin would not load.",
        )
    } else if (!decided) {
        warn(
            "dispachApi",
            `\`dispachApi\` ${plugin.dispachApi} does not admit this host (${hostVersion}).`,
            "Correct if you are testing against a host you do not support. A warning rather than an error, because running the suite on a newer host than the plugin targets is a normal thing to do.",
        )
    }
    if (plugin.dispachApi.trim() === "*") {
        warn(
            "dispachApi",
            "`dispachApi` is `*`, which accepts every host version including ones that do not exist yet.",
            "Narrow it to the range you have actually tested. A plugin that never refuses to load is a plugin that fails at runtime instead, somewhere else, with nothing pointing back at the skew.",
        )
    }

    for (const [index, permission] of (plugin.permissions ?? []).entries()) {
        if (!isPermission(permission)) {
            error(
                "permissions",
                `\`permissions[${index}]\` is not one of the declared kinds.`,
                "Kinds are network, env, fs, exec and store. Advisory in v1 — but authors who declare accurately before enforcement lands are the ones who will not have to scramble afterwards.",
            )
        }
    }

    let config: unknown = options.config ?? {}
    if (plugin.configSchema !== undefined) {
        const parsed = plugin.configSchema.safeParse(config)
        if (parsed.success) config = parsed.data
        else {
            warn(
                "configSchema",
                "The schema refused the config this suite passed.",
                "Pass a valid `config` through `conformance(plugin, { config })`. The default is `{}`, which a schema with required fields correctly rejects.",
            )
        }
    }

    const context: PluginContext = {
        defineChannel: (id) => registered.push(`channel:${id}`),
        defineToolProvider: (id) => registered.push(`toolProvider:${id}`),
        defineScriptRunner: () => registered.push("scriptRunner"),
        config,
        agentId: "conformance",
        paths: {
            workspace: "/nonexistent/conformance",
            state: "/nonexistent/conformance/.state",
            manifest: "/nonexistent/conformance/agent.yaml",
        },
        env: {},
        logger: SILENT,
        events: new EventBus({ runtimeId: "conformance" }),
    }

    const started = performance.now()
    try {
        await plugin.setup(context)
    } catch (cause) {
        error(
            "setup",
            `\`setup\` threw: ${cause instanceof Error ? cause.message : String(cause)}`,
            "`setup` registers capabilities and does no work, so it must succeed with an empty environment and a workspace that does not exist. Read a token in the factory you register, not here — that runs only when an agent actually uses the capability.",
        )
    }
    const setupMs = Math.round((performance.now() - started) * 100) / 100

    if (setupMs > SETUP_BUDGET_MS) {
        error(
            "setup budget",
            `\`setup\` took ${setupMs} ms against a ${SETUP_BUDGET_MS} ms budget.`,
            "Move the work into the factory you register. A channel connects in `start()`, which runs after readiness; a provider resolves from its cache at boot and refreshes afterwards. Hard rule 4: no network I/O before `runtime.ready`.",
        )
    }

    if (registered.length === 0) {
        warn(
            "setup",
            "`setup` registered nothing.",
            "A plugin that registers no channel, tool provider or script runner extends nothing. Correct only for a plugin that exists to carry middleware, which arrives in Phase 9B.",
        )
    }

    return {
        ok: findings.every((finding) => finding.level !== "error"),
        findings,
        registered,
        setupMs,
    }
}

/** One-line-per-finding rendering, for a test runner's failure output. */
export function formatFindings(result: ConformanceResult): string {
    if (result.findings.length === 0) return "conformance: ok"
    return result.findings
        .map(
            (finding) =>
                `${finding.level}: ${finding.check} — ${finding.message}\n  hint: ${finding.hint}`,
        )
        .join("\n")
}
