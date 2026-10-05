/**
 * HTML to something a model can read.
 *
 * No parser, and that is a decision rather than a shortcut. A DOM library is a dependency whose whole
 * purpose is to be correct about malformed markup written by strangers — which is precisely the input
 * this receives, and precisely the reason not to run a large attack surface over it. What is needed
 * here is far less than a DOM: drop the parts that are not prose, drop the tags, keep the text.
 *
 * The failure mode of the regex approach is a stray `<` in prose eating a few words. The failure mode
 * of the parser approach is a parser bug reachable from any page the agent fetches. The first is
 * visible in the observation; the second is not.
 *
 * **This is not sanitisation.** Nothing here tries to remove instruction-like phrasing, and decision
 * 4.27 explains why: it does not work, and an unreliable filter invites the belief that the problem is
 * handled. The output is delimited and labelled untrusted by the runtime, which is the control that
 * actually holds.
 */

import { stripHtmlComments } from "@dispach/core"

/** Elements whose content is code, styling or metadata rather than prose. Dropped whole. */
const DROPPED = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head"]

/** Elements that end a line of prose, so the text does not run together into one paragraph. */
const BREAKING =
    /<\/?(?:p|div|br|hr|section|article|header|footer|nav|aside|main|h[1-6]|li|tr|td|th|blockquote|pre|figcaption|dt|dd)\b[^>]*>/gi

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    times: "×",
    middot: "·",
    bull: "•",
    copy: "©",
    reg: "®",
    trade: "™",
    deg: "°",
    eacute: "é",
    egrave: "è",
    agrave: "à",
    ccedil: "ç",
    uuml: "ü",
    ouml: "ö",
    auml: "ä",
}

export function decodeEntities(value: string): string {
    return value.replace(
        /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
        (whole, body: string) => {
            if (body.startsWith("#")) {
                const code =
                    body.startsWith("#x") || body.startsWith("#X")
                        ? Number.parseInt(body.slice(2), 16)
                        : Number.parseInt(body.slice(1), 10)
                // Surrogates and out-of-range code points come back as themselves rather than throwing:
                // a malformed entity in the middle of a page is not a reason to fail the whole fetch.
                if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
                if (code >= 0xd800 && code <= 0xdfff) return whole
                return String.fromCodePoint(code)
            }
            return NAMED_ENTITIES[body.toLowerCase()] ?? whole
        },
    )
}

export interface Extracted {
    readonly title?: string
    readonly text: string
}

/** The `<title>`, decoded and collapsed. Absent rather than empty when there isn't one. */
export function extractTitle(html: string): string | undefined {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    if (match === null) return undefined
    const title = collapse(decodeEntities(match[1] ?? ""))
    return title === "" ? undefined : title
}

export function htmlToText(html: string): string {
    let text = html

    for (const tag of DROPPED) {
        // Both the well-formed case and the truncated one: a page cut off at maxBytes mid-`<script>`
        // would otherwise leak its own source into the observation, which is exactly the content this
        // is here to drop. The unterminated form runs second and eats to the end.
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ")
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ")
    }

    text = stripHtmlComments(text, " ")
    text = text.replace(BREAKING, "\n")
    text = text.replace(/<[^>]*>/g, " ")
    text = decodeEntities(text)

    return text
        .split("\n")
        .map((line) => collapse(line))
        .filter((line, index, lines) => line !== "" || (lines[index - 1] ?? "") !== "")
        .join("\n")
        .trim()
}

function collapse(value: string): string {
    return value.replace(/\s+/g, " ").trim()
}

/**
 * Turn a response body into text, by content type.
 *
 * JSON is passed through rather than stripped: it is already text a model reads well, and running
 * tag-removal over it would eat any string containing a `<`.
 */
export function extract(body: string, contentType: string): Extracted {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    if (type.includes("html") || type.includes("xml")) {
        const title = extractTitle(body)
        return { text: htmlToText(body), ...(title === undefined ? {} : { title }) }
    }
    return { text: body.trim() }
}

/** Content types with text in them. Anything else is refused rather than rendered as mojibake. */
export function isTextual(contentType: string): boolean {
    const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    // An absent Content-Type is treated as text: plenty of small servers omit it, and the body is
    // about to be decoded as UTF-8 either way — which produces readable text or obvious rubbish, both
    // of which are better than refusing a page that was fine.
    if (type === "") return true
    if (type.startsWith("text/")) return true
    return /^application\/(?:json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|javascript|x-ndjson)$/.test(
        type,
    )
}
