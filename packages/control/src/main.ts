#!/usr/bin/env node
/**
 * The entry point: read the environment, open the store, serve, sweep.
 *
 * Every setting is an environment variable named from `BRAND.envPrefix`, and the only secret is the
 * operator token — read from the environment, never from a file this process writes.
 */

import { BRAND } from "./brand.ts"
import { ControlPlane } from "./control.ts"
import { DockerPlacer } from "./placer.ts"
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

const token = env("TOKEN")
if (token === undefined) {
    process.stderr.write(
        `${BRAND.envPrefix}TOKEN is not set.\n  hint: export it with a long random value (openssl rand -base64 32). It authenticates every operator route; there is no default, so a control plane is never reachable without one.\n`,
    )
    process.exit(1)
}

const store = await SiloStore.open(env("DB") ?? "control.db")
const placer = new DockerPlacer({
    ...(env("IMAGE") === undefined ? {} : { image: env("IMAGE") as string }),
    ...(env("NETWORK") === undefined ? {} : { network: env("NETWORK") as string }),
    ...(env("TEMPLATES") === undefined ? {} : { templatesDir: env("TEMPLATES") as string }),
})
const control = new ControlPlane({
    store,
    placer,
    idleMs: number("IDLE_MS", 60_000),
    wakeMarginMs: number("WAKE_MARGIN_MS", 30_000),
    sweepMs: number("SWEEP_MS", 5_000),
})
const host = env("HOST") ?? "127.0.0.1"
const port = number("PORT", 7600)
const server = createControlServer({ control, token })

server.listen(port, host, () => {
    process.stdout.write(
        `${BRAND.slug} on http://${host}:${port} · ${store.list().length} silo(s)\n`,
    )
    control.start()
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
