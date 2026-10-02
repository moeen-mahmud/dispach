/** Small string helpers that must stay linear on input a stranger wrote. */
/**
 * Remove every `<!-- … -->`, an unclosed one left as it is — what `/<!--[\s\S]*?-->/g` did, in one
 * pass. The regex rescanned from every `<!--` with no close, which is quadratic on a page of them,
 * and `web_fetch` runs this on pages a stranger wrote.
 */
export function stripHtmlComments(text: string, replacement = ""): string {
    let out = ""
    let from = 0
    for (;;) {
        const open = text.indexOf("<!--", from)
        if (open === -1) break
        const close = text.indexOf("-->", open + 4)
        if (close === -1) break
        out += text.slice(from, open) + replacement
        from = close + 3
    }
    return out + text.slice(from)
}

/** A URL with its trailing slashes removed, without the quadratic rescan `/\/+$/` does. */
export function trimTrailingSlashes(value: string): string {
    let end = value.length
    while (end > 0 && value[end - 1] === "/") end -= 1
    return value.slice(0, end)
}
