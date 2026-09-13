/**
 * `@dispach/channel-telegram` — the Telegram channel, registered by type name.
 *
 * ```ts
 * Runtime.create({ agents: ["./agent.yaml"], channels: { telegram: telegramChannel } })
 * ```
 *
 * The manifest entry:
 *
 * ```yaml
 * channels:
 *   - type: telegram
 *     id: tg
 *     tokenEnv: TELEGRAM_BOT_TOKEN
 *     mode: longpoll            # or webhook
 *     allowFrom: ["@moeen"]     # inbound only, and closed by default
 * ```
 */

import { type ChannelFactory, ConfigError, type Plugin } from "@dispach/core"
import { TelegramApi } from "./api.ts"
import { type TelegramMode, TelegramTransport } from "./transport.ts"

export type {
    TelegramChat,
    TelegramMe,
    TelegramMessage,
    TelegramResponse,
    TelegramUpdate,
    TelegramUser,
} from "./api.ts"
export { TelegramApi, TelegramApiError } from "./api.ts"
export type { TelegramMode, TelegramTransportOptions } from "./transport.ts"
export { TelegramTransport, toInbound } from "./transport.ts"

/**
 * Construct a Telegram transport from a manifest entry.
 *
 * **The token is read here, at boot, and a missing one is a hard failure.** That is deliberately
 * different from a *wrong* token, which is a network fact and must not block readiness (decision
 * 8.9's neighbour): an unset environment variable is a configuration mistake, knowable without a
 * packet, and hard rule 10's whole point is that the manifest names the variable so the failure can
 * name it too.
 */
export const telegramChannel: ChannelFactory = (context) => {
    const config = context.config
    const tokenEnv = stringField(config, "tokenEnv") ?? "TELEGRAM_BOT_TOKEN"
    const token = context.env[tokenEnv]

    if (token === undefined || token === "") {
        throw new ConfigError({
            code: "telegram_token_missing",
            message: `Channel "${context.id}" needs ${tokenEnv}, which is not set.`,
            hint: `Export ${tokenEnv}, or add it to the .env beside the manifest. Get a token from @BotFather with /newbot. This fails at load rather than at the first poll, because an unset variable is a configuration mistake and does not need a network round trip to discover.`,
            field: `channels[${context.id}].tokenEnv`,
        })
    }

    const mode = stringField(config, "mode") ?? "longpoll"
    if (mode !== "longpoll" && mode !== "webhook") {
        throw new ConfigError({
            code: "telegram_mode_invalid",
            message: `Channel "${context.id}" declares mode "${mode}".`,
            hint: "mode is longpoll or webhook. Long-poll needs no inbound connectivity and is the right default for a laptop or a private network; webhook needs a public HTTPS URL and is lower latency.",
            field: `channels[${context.id}].mode`,
        })
    }

    const secretEnv = stringField(config, "secretTokenEnv")
    const secretToken = secretEnv === undefined ? undefined : context.env[secretEnv]
    if (secretEnv !== undefined && (secretToken === undefined || secretToken === "")) {
        throw new ConfigError({
            code: "telegram_secret_missing",
            message: `Channel "${context.id}" names secretTokenEnv ${secretEnv}, which is not set.`,
            hint: `Export ${secretEnv} with any random string, or remove secretTokenEnv. Naming a variable and leaving it empty would start a webhook that verifies nothing, which is worse than one that never claimed to.`,
            field: `channels[${context.id}].secretTokenEnv`,
        })
    }

    const baseUrl = stringField(config, "apiBaseUrl")
    const webhookUrl = stringField(config, "webhookUrl")

    return new TelegramTransport({
        id: context.id,
        token,
        mode: mode as TelegramMode,
        ...(webhookUrl === undefined ? {} : { webhookUrl }),
        ...(secretToken === undefined || secretToken === "" ? {} : { secretToken }),
        ...(baseUrl === undefined ? {} : { api: new TelegramApi({ token, baseUrl }) }),
    })
}

function stringField(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = config[key]
    return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * Package version, declared to the host and kept in step with `package.json` by a test.
 *
 * A constant rather than a `package.json` import: the bundle targets Node with `--packages=external`,
 * and a JSON import resolves differently under Bun, Node and a bundler. `changeset version` bumps
 * the manifest and knows nothing about this, which is what the test is for — the same arrangement
 * `@dispach/core` uses for `VERSION`.
 */
export const VERSION = "0.1.0"

/**
 * This package as a plugin.
 *
 * The factory above is unchanged and still exported: `Runtime.create({ channels: { telegram } })`
 * remains supported for an embedder wiring things up directly, and the plugin is a thin registration
 * over the same seam rather than a second implementation of it. Two ways in, one code path.
 *
 * `setup` registers and does nothing else — no token is read, no socket is opened. The token check
 * lives in the factory, which runs when an agent's manifest actually declares a Telegram channel;
 * doing it here would refuse to *load the plugin* on an agent that never uses it.
 */
export default {
    name: "telegram",
    version: VERSION,
    dispachApi: "^0.1",
    permissions: [
        { kind: "network", hosts: ["api.telegram.org"] },
        // The default. A manifest naming a different `tokenEnv` is declaring a variable this list
        // cannot know, which is one honest limit of an advisory vocabulary (decision 7.5).
        { kind: "env", vars: ["TELEGRAM_BOT_TOKEN"] },
    ],
    setup(context) {
        context.defineChannel("telegram", telegramChannel)
    },
} satisfies Plugin
