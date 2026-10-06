/**
 * Every failure this package can produce, each with a hint.
 *
 * Built on core's `ConfigError` / `ToolError` for the same reason `tools-system` is: a fetch failure
 * should be reported and rendered exactly like a manifest failure. The package is a provider, not a
 * second error vocabulary.
 *
 * The refusals are worded so the model **reports rather than retries**. A blocked address is not a
 * transient condition, and a refusal that reads like one produces a retry storm against an internal
 * host — the request failing repeatedly is itself the port scan.
 */

import { ConfigError, ToolError } from "@dispach/core"

export function webUrlUnparseable(raw: string, cause: string): ToolError {
    return new ToolError({
        code: "web_url_unparseable",
        message: `That is not a URL: ${JSON.stringify(raw)}`,
        hint: `${cause}. Give a complete absolute URL including the scheme — https://example.com/page, not example.com/page. Parsed with the standard URL parser rather than a pattern, so what is accepted here is exactly what a browser would accept.`,
        field: "url",
    })
}

export function webSchemeRefused(scheme: string): ToolError {
    return new ToolError({
        code: "web_scheme_refused",
        message: `${scheme} URLs are not fetchable.`,
        hint: "Only http and https. This tool reaches the public web and nothing else — a file:// URL reads the disk, which is file_read's job and subject to its rules, and the other schemes reach services that were never designed to be spoken to by an HTTP client.",
        field: "url",
    })
}

export function webCredentialsRefused(): ToolError {
    return new ToolError({
        code: "web_credentials_refused",
        message: "That URL carries a username and password.",
        hint: "Refused rather than stripped: a URL with credentials in it is either a secret that should not be in a conversation, or an attempt to make the host look like something it is not. Fetch the address on its own if the page is public.",
        field: "url",
    })
}

/**
 * The refusal that stops the agent reaching the machine it runs on, or the network around it.
 *
 * Names the address it actually resolved to, not just the hostname. `internal.example.com` refused
 * with no address reads as a bug in the tool; refused as `10.0.4.7 (private, 10.0.0.0/8)` reads as
 * the tool working, and tells whoever is reading the transcript something true about their DNS.
 */
export function webAddressRefused(
    host: string,
    address: string,
    kind: string,
    range: string | undefined,
    hop: number,
): ToolError {
    const where = address === host ? address : `${host} → ${address}`
    return new ToolError({
        code: "web_address_refused",
        message: `${where} is ${kind}${range === undefined ? "" : ` (${range})`} and will not be fetched${hop > 0 ? `, reached by redirect ${hop}` : ""}.`,
        hint: "This is a standing rule with no setting that overrides it. Addresses off the public internet — loopback, link-local, private and carrier-grade NAT ranges — include the cloud metadata endpoint and every service on this machine, so a page that can make this tool fetch one is a page that can read them. Nothing was requested. If the page is genuinely public, check the hostname.",
        field: "url",
    })
}

export function webHostRefused(host: string, why: string): ToolError {
    return new ToolError({
        code: "web_host_refused",
        message: `${host} is not a public hostname: ${why}.`,
        hint: "Nothing was requested. This tool reaches the public web; names that only resolve inside this machine or this network are refused before any lookup happens.",
        field: "url",
    })
}

export function webHostUnresolvable(host: string, cause: string): ToolError {
    return new ToolError({
        code: "web_host_unresolvable",
        message: `${host} could not be resolved: ${cause}`,
        hint: "Refused rather than handed to the HTTP client anyway. The address check happens on what DNS returns, so a name that will not resolve here cannot be checked — and fetching it regardless would mean the one request nobody looked at is the one that failed the lookup. Check the spelling of the host.",
        field: "url",
    })
}

export function webRequestFailed(url: string, cause: string): ToolError {
    return new ToolError({
        code: "web_request_failed",
        message: `The request to ${url} did not complete: ${cause}`,
        hint: "The address passed every check, so this is the network or the far end rather than a refusal. Worth one retry if it reads like a timeout; not worth retrying if the host is simply gone.",
        field: "url",
    })
}

export function webStatusFailed(url: string, status: number, statusText: string): ToolError {
    return new ToolError({
        code: "web_status_failed",
        message: `${url} answered ${status}${statusText === "" ? "" : ` ${statusText}`}.`,
        hint: `${status === 404 ? "The page is not there — check the URL against a search result rather than guessing at the path." : status === 403 || status === 401 ? "The page requires credentials or refuses automated clients. There is no setting that supplies either; treat the page as unavailable and say so." : "A server-side failure. One retry is reasonable; a second is not."}`,
        field: "url",
    })
}

export function webTooManyRedirects(url: string, max: number): ToolError {
    return new ToolError({
        code: "web_too_many_redirects",
        message: `${url} redirected more than ${max} times.`,
        hint: "Followed manually and re-checked at every hop, which is why the count is low — a redirect chain is the standard way to get a checked URL to end up somewhere unchecked. A chain this long is a redirect loop or a tracker, not a page.",
        field: "url",
    })
}

export function webContentUnusable(url: string, type: string): ToolError {
    return new ToolError({
        code: "web_content_unusable",
        message: `${url} returned ${type}, which has no text to extract.`,
        hint: "Refused rather than decoded: a binary rendered as text is thousands of meaningless tokens and no information. This tool reads HTML, plain text, JSON and similar. PDF and image extraction are deliberately not in scope.",
        field: "url",
    })
}

export function webSearchKeyMissing(backend: string, variable: string): ConfigError {
    return new ConfigError({
        code: "web_search_key_missing",
        message: `The ${backend} search backend needs ${variable} and it is not set.`,
        hint: `Set ${variable} in the .env beside agent.yaml, or in the environment. The manifest names the variable and never holds the key — a manifest with a literal key fails validation.`,
        field: "tools.providers.web.apiKeyEnv",
    })
}

export function webSearchFailed(backend: string, status: number, detail: string): ToolError {
    return new ToolError({
        code: "web_search_failed",
        message: `${backend} answered ${status}: ${detail}`,
        hint: `${status === 401 || status === 403 ? "The API key was rejected. Check the value of the variable named in tools.providers.web.apiKeyEnv — the manifest holds the name, the .env holds the key." : status === 429 ? "Rate limited. This is the backend's own quota; nothing in the manifest raises it." : "A failure at the search backend rather than in the query."}`,
    })
}

export function webConfigInvalid(key: string, why: string): ConfigError {
    return new ConfigError({
        code: "web_config_invalid",
        message: `tools.providers.web.${key} ${why}`,
        hint: "Refused rather than defaulted around: a search backend silently different from the one configured returns different results with nothing reporting why.",
        field: `tools.providers.web.${key}`,
    })
}

export function webFirecrawlKeyMissing(variable: string): ConfigError {
    return new ConfigError({
        code: "web_firecrawl_key_missing",
        message: `Firecrawl needs ${variable} and it is not set.`,
        hint: `Set ${variable} in the .env beside agent.yaml, or in the environment (or ${variable}_FILE naming a file that holds it). tools.providers.web.firecrawl.apiKeyEnv names a different variable if you need one.`,
        field: "tools.providers.web.firecrawl.apiKeyEnv",
    })
}

export function webFirecrawlFailed(operation: string, status: number, detail: string): ToolError {
    return new ToolError({
        code: status === 402 ? "web_firecrawl_credits" : "web_firecrawl_failed",
        message: `Firecrawl ${operation} answered ${status}: ${detail}`,
        hint:
            status === 402
                ? "The Firecrawl account is out of credits. Nothing here can fix that; say so rather than trying another page."
                : status === 401 || status === 403
                  ? "The Firecrawl key was rejected. Check the value of the variable named in tools.providers.web.firecrawl.apiKeyEnv."
                  : status === 429
                    ? "Rate limited by Firecrawl. Wait before the next call; nothing in the manifest raises it."
                    : "A failure at Firecrawl rather than in the request. The page may block its crawler; try another source.",
    })
}
