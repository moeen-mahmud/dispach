/**
 * The container-credentials endpoint, read by Dispach itself so a refusal keeps its reason (pilot.9).
 *
 * The SDK's HTTP provider keeps a 4xx body's `Code` and `Message` (capitalised only), and then its retry
 * wrapper rebuilds the error from `String(error)`, which drops even those; the default chain then moves
 * on and the turn reads `bedrock_credentials_missing`. So an embedder that refuses credentials once a
 * user's credit is spent (`403 {"code": "credit_exhausted"}`) could not tell its own user why. Fetched
 * here, the endpoint's code becomes the turn's error code.
 *
 * Used only when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set and the URI is one the SDK itself would
 * accept (HTTPS, or the loopback and container-agent addresses); anything else stays with the SDK's
 * default chain, exactly as before.
 */

import { readFile } from "node:fs/promises"

export interface AwsCredentials {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
    readonly expiration?: Date
}

/**
 * A 4xx or 5xx from the endpoint, with its own code when the body carried one. A 4xx is a refusal; a
 * 5xx is the vending service failing (pilot.10), classified apart because it is worth retrying.
 */
export class CredentialsRefusedError extends Error {
    override readonly name = "CredentialsRefusedError"
    readonly status: number
    readonly code: string | undefined
    readonly detail: string | undefined
    constructor(status: number, code: string | undefined, detail: string | undefined) {
        super(
            `The credentials endpoint ${status >= 500 ? "failed" : "refused"} with status ${status}${code === undefined ? "" : ` (${code})`}${detail === undefined ? "" : `: ${detail}`}`,
        )
        this.status = status
        this.code = code
        this.detail = detail
    }
}

/** The addresses the SDK allows over plain HTTP: loopback and the ECS and EKS agents. */
const PLAIN_HTTP = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "169.254.170.2",
    "169.254.170.23",
    "[fd00:ec2::23]",
])

/** Refreshed this long before it expires, so a turn never starts on a credential about to lapse. */
const EARLY_MS = 5 * 60_000

export function containerCredentials(
    env: Readonly<Record<string, string | undefined>>,
    fetchLike: typeof fetch = fetch,
): (() => Promise<AwsCredentials>) | undefined {
    const uri = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    if (uri === undefined || uri === "") return undefined
    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return undefined
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && PLAIN_HTTP.has(url.hostname))) {
        return undefined
    }
    let cached: AwsCredentials | undefined
    return async () => {
        if (
            cached?.expiration !== undefined &&
            cached.expiration.getTime() - Date.now() > EARLY_MS
        ) {
            return cached
        }
        const tokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
        const token =
            tokenFile !== undefined && tokenFile !== ""
                ? (await readFile(tokenFile, "utf8")).trim()
                : env.AWS_CONTAINER_AUTHORIZATION_TOKEN
        const response = await fetchLike(url, {
            headers: token === undefined || token === "" ? {} : { authorization: token },
            signal: AbortSignal.timeout(5_000),
        })
        const text = await response.text()
        let body: Record<string, unknown> = {}
        try {
            const parsed: unknown = JSON.parse(text)
            if (typeof parsed === "object" && parsed !== null)
                body = parsed as Record<string, unknown>
        } catch {
            // Not JSON: the status alone says what happened.
        }
        const field = (...names: string[]) => {
            for (const name of names)
                if (typeof body[name] === "string") return body[name] as string
            return undefined
        }
        if (response.status >= 400) {
            throw new CredentialsRefusedError(
                response.status,
                field("code", "Code"),
                field("message", "Message"),
            )
        }
        const accessKeyId = field("AccessKeyId")
        const secretAccessKey = field("SecretAccessKey")
        if (!response.ok || accessKeyId === undefined || secretAccessKey === undefined) {
            throw new Error(
                `The credentials endpoint answered ${response.status} without AccessKeyId and SecretAccessKey.`,
            )
        }
        const token_ = field("Token")
        const expiry = field("Expiration")
        cached = {
            accessKeyId,
            secretAccessKey,
            ...(token_ === undefined ? {} : { sessionToken: token_ }),
            ...(expiry === undefined ? {} : { expiration: new Date(expiry) }),
        }
        return cached
    }
}
