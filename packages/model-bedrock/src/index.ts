/**
 * AWS Bedrock as a model transport: `model.<role>.api: bedrock-converse`.
 *
 * ```yaml
 * model:
 *   main:
 *     id: eu.anthropic.claude-sonnet-4-6          # a model id, a cross-region profile, or an ARN
 *     api: bedrock-converse
 *     options: { region: eu-west-1 }              # and optionally profile
 * ```
 *
 * No key in the manifest: credentials come from the AWS default chain. The CLI and the image supply
 * this transport to every agent, so no `plugins:` entry is needed; an embedder calling the runtime
 * directly passes `bedrockTransport()` in `RuntimeOptions.modelTransports`, or names this plugin.
 */

import { type Plugin, VERSION } from "@dispach/core"
import { bedrockTransport } from "./transport.ts"

export { classify } from "./errors.ts"
export {
    cachesPrompts,
    converseInput,
    roleWarnings,
    thinkingOff,
    thinkingStyle,
    thinksWithBudget,
} from "./request.ts"
export { toChunks } from "./stream.ts"
export {
    type BedrockOptions,
    bedrockTransport,
    type ConverseSend,
    type SenderFactory,
    sdkSender,
} from "./transport.ts"

export default {
    name: "model-bedrock",
    version: VERSION,
    dispachApi: "^0.2",
    permissions: [
        { kind: "network", hosts: ["bedrock-runtime.*.amazonaws.com"] },
        {
            kind: "env",
            vars: [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_PROFILE",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
            ],
        },
    ],
    setup(ctx) {
        ctx.defineModelTransport("bedrock-converse", bedrockTransport())
    },
} satisfies Plugin
