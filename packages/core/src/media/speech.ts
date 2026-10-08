/**
 * A reply as something to say out loud (pilot.15): markup out, then cut into pieces a provider takes
 * in one request.
 *
 * Markup is removed because a voice reading `**` or a URL's punctuation aloud is worse than not
 * hearing it; the words stay. A piece ends at a sentence where one fits, then at a space, and only a
 * single unbroken run longer than the limit is cut mid-word. Nothing is dropped: a long reply becomes
 * several voice notes, never a truncated one.
 */

/** The reply's words without markdown markup. Code blocks are left out: nobody wants one read. */
export function speakable(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

/** `text` in pieces of at most `max` characters, each ending at a sentence or a space where possible. */
export function speechChunks(text: string, max: number): readonly string[] {
    const chunks: string[] = []
    let rest = text.trim()
    while (rest.length > max) {
        const window = rest.slice(0, max)
        const sentence = Math.max(
            window.lastIndexOf(". "),
            window.lastIndexOf("! "),
            window.lastIndexOf("? "),
            window.lastIndexOf("\n"),
        )
        const space = window.lastIndexOf(" ")
        const cut = sentence > 0 ? sentence + 1 : space > 0 ? space : max
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
    }
    if (rest !== "") chunks.push(rest)
    return chunks
}
