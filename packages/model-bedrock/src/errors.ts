/**
 * What an SDK failure means for the loop: retry it, or stop with a typed error that says why.
 *
 * Read by `name` and `$metadata.httpStatusCode`, which every SDK exception carries — never by
 * `instanceof` against SDK classes, which would load the SDK to classify an error the SDK threw.
 * The status on the resulting `ModelError` is what core's fallback chain reads, so a 403 stays a
 * 403 all the way up: **AccessDenied is terminal and never falls back**, because an embedder may
 * revoke a credential as its budget stop.
 */

import { ModelError } from "@dispach/core"

/** Worth another attempt on this model, with backoff, before anything has streamed. */
const RETRYABLE: Record<string, number> = {
    ThrottlingException: 429,
    ServiceUnavailableException: 503,
    InternalServerException: 500,
    ModelNotReadyException: 503,
    ModelStreamErrorException: 500,
    ModelTimeoutException: 408,
}

const NETWORK = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|TimeoutError/

export interface Classified {
    readonly retryable: boolean
    readonly status: number | undefined
    readonly error: ModelError
}

function describe(error: unknown): { name: string; message: string; status: number | undefined } {
    if (typeof error !== "object" || error === null) {
        return { name: "Error", message: String(error), status: undefined }
    }
    const shape = error as {
        name?: unknown
        message?: unknown
        $metadata?: { httpStatusCode?: unknown }
    }
    const status = shape.$metadata?.httpStatusCode
    return {
        name: typeof shape.name === "string" ? shape.name : "Error",
        message: typeof shape.message === "string" ? shape.message : String(error),
        status: typeof status === "number" ? status : undefined,
    }
}

export function classify(
    error: unknown,
    modelId: string,
    region: string,
    field: string,
): Classified {
    const { name, message, status } = describe(error)

    const retryStatus = RETRYABLE[name]
    if (retryStatus !== undefined) {
        const code = status ?? retryStatus
        return {
            retryable: true,
            status: code,
            error: new ModelError({
                code: "model_http_error",
                message: `Bedrock ${name} for ${modelId} in ${region}.`,
                detail: message,
                hint:
                    name === "ThrottlingException"
                        ? "Bedrock is throttling this account or model. Retries were spent; raise the model's quota in Service Quotas, spread load across a cross-region inference profile (eu., us., global.), or add a fallback."
                        : "Bedrock reported a service-side failure and retries were spent. It is usually transient; a fallback under model.<role>.fallbacks covers it.",
                field,
                status: code,
                cause: error,
            }),
        }
    }

    // The container endpoint, read by Dispach (`credentials.ts`), refused and said why. Its own code is
    // the turn's error code when it is one (`credit_exhausted`), so an embedder that refused once a
    // user's credit ran out can tell that user so; a 4xx stays terminal and never falls back.
    if (name === "CredentialsRefusedError") {
        const shape = error as { status?: unknown; code?: unknown; detail?: unknown }
        const refusedStatus = typeof shape.status === "number" ? shape.status : 403
        const own =
            typeof shape.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(shape.code)
                ? shape.code
                : undefined
        // A 5xx is the vending service failing, not deciding: transient, so retried and reported as
        // such, where it used to reach the turn as a generic model error (VelaCrew, pilot.10).
        if (refusedStatus >= 500) {
            return {
                retryable: true,
                status: refusedStatus,
                error: new ModelError({
                    code: own ?? "bedrock_credentials_unavailable",
                    message: `The AWS credentials endpoint could not issue credentials for Bedrock (${modelId} in ${region}): status ${refusedStatus}${own === undefined ? "" : `, ${own}`}${typeof shape.detail === "string" ? ` — ${shape.detail}` : ""}.`,
                    hint: "The container-credentials endpoint failed rather than declined: the service vending credentials is down or could not reach its own source. It is usually temporary; Dispach retried, and the next turn asks again.",
                    field,
                    status: refusedStatus,
                    cause: error,
                }),
            }
        }
        return {
            retryable: false,
            status: refusedStatus,
            error: new ModelError({
                code: own ?? "bedrock_credentials_refused",
                message: `The AWS credentials endpoint refused to issue credentials for Bedrock (${modelId} in ${region}): status ${refusedStatus}${own === undefined ? "" : `, ${own}`}${typeof shape.detail === "string" ? ` — ${shape.detail}` : ""}.`,
                hint: "The container-credentials endpoint answered and declined: the decision of the service vending credentials (a budget or credit stop, a revoked user), not a missing configuration. Its own code is this error's code. Dispach does not retry it.",
                field,
                status: refusedStatus,
                cause: error,
            }),
        }
    }

    // The credentials endpoint answered, and said no — a refusal, not an absence. The SDK keeps only
    // the status (its retry wrapper re-throws `String(error)`, dropping the body), so that is what is
    // carried: an embedder vending credentials can make a 403 its budget stop and tell it apart from a
    // missing chain (pilot.4).
    const refused = /responded with status: (\d{3})/.exec(message)
    if (name === "CredentialsProviderError" && refused !== null) {
        return {
            retryable: false,
            status: Number(refused[1]),
            error: new ModelError({
                code: "bedrock_credentials_refused",
                message: `The AWS credentials endpoint refused to issue credentials for Bedrock (${modelId} in ${region}): status ${refused[1]}.`,
                hint: "The container-credentials endpoint answered and declined, which is the endpoint's decision rather than a missing configuration — a vending service may refuse once a budget is spent. Check that service; Dispach does not retry it.",
                field,
                status: Number(refused[1]),
                cause: error,
            }),
        }
    }

    if (name === "CredentialsProviderError" || /Could not load credentials/i.test(message)) {
        return {
            retryable: false,
            status: undefined,
            error: new ModelError({
                code: "bedrock_credentials_missing",
                message: `No AWS credentials were found for Bedrock (${modelId} in ${region}).`,
                hint: "Credentials come from the default AWS chain: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the process environment, a container-credentials endpoint (AWS_CONTAINER_CREDENTIALS_FULL_URI), EKS Pod Identity, or the instance role. Never a manifest field. For a named profile, set options.profile.",
                field,
                cause: error,
            }),
        }
    }

    // AWS's own text goes in `detail`, never `message` (pilot.14, VelaCrew): an access refusal names
    // the assumed-role ARN and the account, and `message` is what an embedder shows to people.
    if (name === "AccessDeniedException" || status === 403) {
        return {
            retryable: false,
            status: 403,
            error: new ModelError({
                code: "model_access_denied",
                message: `Bedrock refused ${modelId} in ${region}: these credentials may not invoke it.`,
                detail: message,
                hint: /being verified/i.test(message)
                    ? "The AWS account is new and AWS is still verifying it, which it says takes under two hours. Nothing in the manifest or the IAM policy changes this; retry once the account is verified."
                    : 'Either the credential is invalid or expired (Bedrock says "security token … invalid"), or it is not allowed to invoke this model. For the second, check the IAM policy grants bedrock:InvokeModelWithResponseStream on the model or inference profile, and that model access is enabled in the Bedrock console for this region. An embedder that revokes credentials as a budget stop lands here on purpose, which is why this never falls back.',
                field,
                status: 403,
                cause: error,
            }),
        }
    }

    if (name === "ResourceNotFoundException" || status === 404) {
        return {
            retryable: false,
            status: 404,
            error: new ModelError({
                code: "model_not_found",
                message: `Bedrock has no model ${modelId} in ${region}.`,
                detail: message,
                hint: /use case details/i.test(message)
                    ? "Anthropic models on Bedrock need a one-time use-case form per AWS account: Bedrock console → Model catalog → an Anthropic model → submit the use case details. It applies about 15 minutes after submission."
                    : "Check the model id and region together: a cross-region profile id starts with its geography (eu., us., apac., global.), and a base model id needs on-demand access in that exact region.",
                field,
                status: 404,
                cause: error,
            }),
        }
    }

    if (NETWORK.test(`${name} ${message}`)) {
        return {
            retryable: true,
            status: undefined,
            error: new ModelError({
                code: "model_unreachable",
                message: `Cannot reach Bedrock in ${region}.`,
                detail: message,
                hint: "Check outbound HTTPS to bedrock-runtime.<region>.amazonaws.com from this host; a default-deny network policy needs that endpoint listed.",
                field,
                cause: error,
            }),
        }
    }

    const code = status ?? 400
    return {
        retryable: false,
        status: code,
        error: new ModelError({
            code: "model_http_error",
            message: `Bedrock ${name} for ${modelId}.`,
            detail: message,
            hint:
                name === "ValidationException"
                    ? "Bedrock refused the request as malformed. Its own words, in `detail`, name the field; a model that does not support a feature asked for (tools, thinking, prompt caching) is the usual cause."
                    : "Bedrock refused the request. Its own words are in `detail`.",
            field,
            status: code,
            cause: error,
        }),
    }
}
