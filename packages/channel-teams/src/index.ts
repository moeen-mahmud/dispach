/**
 * `@dispach/channel-teams` — Microsoft Teams, over the Bot Framework's plain HTTPS surface.
 *
 * ```yaml
 * channels:
 *   - type: teams
 *     id: teams
 *     appId: 00000000-0000-0000-0000-000000000000   # the bot's Entra app id (not a secret)
 *     passwordEnv: TEAMS_APP_PASSWORD               # the client secret, by env var name
 *     tenantId: 11111111-1111-1111-1111-111111111111 # single-tenant bot; also drops other tenants
 *     allowFrom: ["*"]
 * ```
 *
 * Register the bot's messaging endpoint as `https://<host>/v1/channels/<id>/webhook/<agent>`. No SDK:
 * verifying the connector's JWT, a client-credentials token and one POST per reply are all of it
 * (decision 14.25).
 */

import { type ChannelFactory, ConfigError, type Plugin } from "@dispach/core"
import { BotFrameworkAuth } from "./auth.ts"
import { TeamsTransport } from "./transport.ts"

export type { TeamsAccount, TeamsActivity } from "./activity.ts"
export { mentionsBot, plainText, tenantOf, toInbound } from "./activity.ts"
export {
    AuthRefused,
    BotFrameworkAuth,
    type FetchLike,
    ISSUER,
    OPENID_METADATA,
    TokenRefused,
} from "./auth.ts"
export { TeamsTransport, type TeamsTransportOptions } from "./transport.ts"

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function stringField(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = config[key]
    return typeof value === "string" && value !== "" ? value : undefined
}

export const teamsChannel: ChannelFactory = (context) => {
    const field = (name: string) => `channels[${context.id}].${name}`
    const appId = stringField(context.config, "appId")
    if (appId === undefined || !GUID.test(appId)) {
        throw new ConfigError({
            code: "teams_app_id_invalid",
            message: `Channel "${context.id}" needs appId, the bot's Entra application id.`,
            hint: "It is the GUID on the Azure Bot resource (Configuration → Microsoft App ID). Not a secret, so it is written here; the password goes in an env var named by passwordEnv. The agent starts either way, with this channel reported broken.",
            field: field("appId"),
        })
    }
    const passwordEnv = stringField(context.config, "passwordEnv") ?? "TEAMS_APP_PASSWORD"
    const password = context.env[passwordEnv]
    if (password === undefined || password === "") {
        throw new ConfigError({
            code: "teams_password_missing",
            message: `Channel "${context.id}" needs ${passwordEnv}, which is not set.`,
            hint: `Put the bot's client secret in ${passwordEnv}, in the environment or the .env beside the manifest. It is refused here rather than at the first reply, because an unset variable needs no round trip to Microsoft to discover.`,
            field: field("passwordEnv"),
        })
    }
    const tenantId = stringField(context.config, "tenantId")
    if (tenantId !== undefined && !GUID.test(tenantId)) {
        throw new ConfigError({
            code: "teams_tenant_invalid",
            message: `Channel "${context.id}" declares tenantId "${tenantId}", which is not a tenant id.`,
            hint: "The Entra tenant (directory) id, a GUID. Omit it only for a legacy multi-tenant bot registration.",
            field: field("tenantId"),
        })
    }
    return new TeamsTransport({
        id: context.id,
        dir: context.dir,
        auth: new BotFrameworkAuth({
            appId,
            password,
            ...(tenantId === undefined ? {} : { tenantId }),
        }),
        ...(tenantId === undefined ? {} : { tenantId }),
    })
}

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

export default {
    name: "channel-teams",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [
        {
            kind: "network",
            hosts: [
                "login.botframework.com",
                "login.microsoftonline.com",
                "smba.trafficmanager.net",
            ],
        },
        { kind: "env", vars: ["TEAMS_APP_PASSWORD"] },
    ],
    setup(context) {
        context.defineChannel("teams", teamsChannel)
    },
} satisfies Plugin
