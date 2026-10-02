/**
 * `@dispach/channel-slack` — Slack, over Socket Mode.
 *
 * ```yaml
 * channels:
 *   - type: slack
 *     id: slack
 *     appTokenEnv: SLACK_APP_TOKEN   # xapp-…, connections:write — opens the socket
 *     botTokenEnv: SLACK_BOT_TOKEN   # xoxb-…, chat:write — sends replies
 *     allowFrom: ["*"]
 * ```
 *
 * The app needs Socket Mode enabled and the bot events `message.im` and `app_mention`. No public
 * endpoint and no SDK: one Web API call opens a WebSocket, one posts each reply (decision 14.26).
 */

import { type ChannelFactory, ConfigError, type Plugin } from "@dispach/core"
import { SlackTransport } from "./transport.ts"

export { plainText, type SlackEvent, toInbound } from "./events.ts"
export {
    type FetchLike,
    SLACK_API,
    SlackTransport,
    type SlackTransportOptions,
    type SocketFactory,
} from "./transport.ts"

function token(
    context: Parameters<ChannelFactory>[0],
    key: string,
    fallback: string,
    prefix: string,
    what: string,
): string {
    const configured = context.config[key]
    const name = typeof configured === "string" && configured !== "" ? configured : fallback
    const value = context.env[name]
    const field = `channels[${context.id}].${key}`
    if (value === undefined || value === "") {
        throw new ConfigError({
            code: "slack_token_missing",
            message: `Channel "${context.id}" needs ${name}, which is not set.`,
            hint: `Put the ${what} in ${name}, in the environment or the .env beside the manifest. The agent starts either way, with this channel reported broken.`,
            field,
        })
    }
    if (!value.startsWith(prefix)) {
        throw new ConfigError({
            code: "slack_token_wrong_kind",
            message: `${name} does not hold a Slack ${what}; those start with ${prefix}.`,
            hint: "Slack issues two tokens and Socket Mode needs both: the app-level token (xapp-…, Basic Information → App-Level Tokens) opens the socket, the bot token (xoxb-…, OAuth & Permissions) sends replies. They are easy to swap.",
            field,
        })
    }
    return value
}

export const slackChannel: ChannelFactory = (context) =>
    new SlackTransport({
        id: context.id,
        appToken: token(context, "appTokenEnv", "SLACK_APP_TOKEN", "xapp-", "app-level token"),
        botToken: token(context, "botTokenEnv", "SLACK_BOT_TOKEN", "xoxb-", "bot token"),
    })

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

export default {
    name: "channel-slack",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [
        { kind: "network", hosts: ["slack.com", "*.slack.com"] },
        { kind: "env", vars: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"] },
    ],
    setup(context) {
        context.defineChannel("slack", slackChannel)
    },
} satisfies Plugin
