#!/usr/bin/env node
/**
 * The entry point: read the environment, open the store, serve, sweep.
 *
 * Every setting is an environment variable named from `BRAND.envPrefix`, and the only secret is the
 * operator token — read from the environment, never from a file this process writes.
 */

import { BRAND } from "./brand.ts"
import { ControlPlane } from "./control.ts"
import { type AlertRules, DEFAULT_RULES, Monitor, telegramAlert } from "./monitor.ts"
import { ControlError, DockerPlacer, resolveSiloEnv } from "./placer.ts"
import { createControlServer } from "./server.ts"
import { SiloStore } from "./store.ts"

const env = (name: string): string | undefined => {
    const value = process.env[`${BRAND.envPrefix}${name}`]
    return value === undefined || value.trim() === "" ? undefined : value
}

function number(name: string, fallback: number): number {
    const raw = env(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(
            `${BRAND.envPrefix}${name}=${raw} is not a positive number.\n  hint: unset it for the default (${fallback}), or give a number of the unit its name says.\n`,
        )
        process.exit(1)
    }
    return value
}

/** `SUSPEND=on|off`, default off. Anything else refuses the boot rather than guessing. */
function suspendSetting(): boolean {
    const raw = env("SUSPEND")
    if (raw === undefined || raw === "off") return false
    if (raw === "on") return true
    process.stderr.write(
        `${BRAND.envPrefix}SUSPEND=${raw} is not on or off.\n  hint: leave it unset for always-on silos (the default), or set it to "on" to pause idle silos — which silences their WhatsApp and Telegram long-poll channels while they sleep.\n`,
    )
    process.exit(1)
}

const token = env("TOKEN")
if (token === undefined) {
    process.stderr.write(
        `${BRAND.envPrefix}TOKEN is not set.\n  hint: export it with a long random value (openssl rand -base64 32). It authenticates every operator route; there is no default, so a control plane is never reachable without one.\n`,
    )
    process.exit(1)
}

let siloEnv: Record<string, string> = {}
try {
    siloEnv = resolveSiloEnv(env("SILO_ENV"), process.env, `${BRAND.envPrefix}SILO_ENV`)
} catch (error) {
    if (!(error instanceof ControlError)) throw error
    process.stderr.write(`${error.message}\n  hint: ${error.hint}\n`)
    process.exit(1)
}

const image = env("IMAGE") ?? BRAND.runtime.image
if (image.endsWith(":latest") || !image.includes(":")) {
    // Said, not refused: `latest` is right on a laptop. On a host it means two silos created a day
    // apart can run different runtimes, and `recreate` silently upgrades whatever it touches.
    process.stderr.write(
        `note: silos run ${image}, which is not pinned.\n  hint: set ${BRAND.envPrefix}IMAGE to a version tag in production, and roll it out with POST /v1/silos/<subject>/recreate.\n`,
    )
}

// Every setting is checked before anything is opened: a refused boot leaves nothing behind.
const suspend = suspendSetting()
const hookUrl = env("HOOK_URL")
const rules: AlertRules = {
    window: number("ALERT_WINDOW", DEFAULT_RULES.window),
    minTurns: number("ALERT_MIN_TURNS", DEFAULT_RULES.minTurns),
    nonFinal: number("ALERT_NON_FINAL", DEFAULT_RULES.nonFinal),
    toolErrors: number("ALERT_TOOL_ERRORS", DEFAULT_RULES.toolErrors),
}
const alertToken = env("ALERT_TG_TOKEN")
const alertChat = env("ALERT_TG_CHAT")
if ((alertToken === undefined) !== (alertChat === undefined)) {
    process.stderr.write(
        `${BRAND.envPrefix}ALERT_TG_TOKEN and ${BRAND.envPrefix}ALERT_TG_CHAT go together.\n  hint: set both to send pilot alerts to a Telegram chat, or neither to write them to stderr.\n`,
    )
    process.exit(1)
}
const store = await SiloStore.open(env("DB") ?? "control.db")
const placer = new DockerPlacer({
    image,
    siloEnv,
    ...(env("NETWORK") === undefined ? {} : { network: env("NETWORK") as string }),
    ...(env("TEMPLATES") === undefined ? {} : { templatesDir: env("TEMPLATES") as string }),
})
const monitor =
    hookUrl === undefined
        ? undefined
        : new Monitor({
              store,
              hookUrl,
              rules,
              ...(alertToken === undefined || alertChat === undefined
                  ? {}
                  : { alert: telegramAlert(alertToken, alertChat) }),
          })
const control = new ControlPlane({
    ...(monitor === undefined ? {} : { monitor }),
    store,
    placer,
    suspend,
    idleMs: number("IDLE_MS", 60_000),
    wakeMarginMs: number("WAKE_MARGIN_MS", 30_000),
    sweepMs: number("SWEEP_MS", 5_000),
})
const host = env("HOST") ?? "127.0.0.1"
const port = number("PORT", 7600)
const server = createControlServer({
    control,
    token,
    ...(monitor === undefined ? {} : { monitor }),
})

server.listen(port, host, () => {
    process.stdout.write(
        `${BRAND.slug} on http://${host}:${port} · ${store.list().length} silo(s)` +
            (Object.keys(siloEnv).length === 0
                ? ""
                : ` · silo env: ${Object.keys(siloEnv).join(", ")}`) +
            "\n",
    )
    control.start()
    if (monitor === undefined) {
        process.stdout.write(`  monitor off — set ${BRAND.envPrefix}HOOK_URL to turn it on\n`)
    } else {
        process.stdout.write(`  monitor on · silos report to ${hookUrl}/hooks/<subject>\n`)
        void control.watchAll()
    }
})

const shutdown = () => {
    control.stop()
    server.close(() => {
        store.close()
        process.exit(0)
    })
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
