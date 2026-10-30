/**
 * A small Markdown parser: text in, a block tree out. No HTML in, no HTML out.
 *
 * In-house rather than `marked` or `react-markdown`, and the reason is not size. Model output is
 * untrusted text, and every general renderer either passes raw HTML through or needs a sanitiser
 * bolted on; a parser that has no HTML branch cannot be talked into emitting one. The subset is what
 * a model actually writes in a chat reply: headings, paragraphs, emphasis, inline code, fenced code,
 * lists, quotes, links, tables, rules. Anything else is a paragraph, which is the safe failure.
 *
 * Pure, so `renderToStaticMarkup` tests cover every construct, and streaming is the same parser
 * over a growing string: an unterminated fence renders as code until its closing line arrives.
 */

export type Inline =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "code"; readonly text: string }
    | { readonly kind: "strong"; readonly children: readonly Inline[] }
    | { readonly kind: "em"; readonly children: readonly Inline[] }
    | { readonly kind: "strike"; readonly children: readonly Inline[] }
    /** `href` is already vetted: only `http(s)://` and `mailto:` survive; anything else is text. */
    | { readonly kind: "link"; readonly href: string; readonly children: readonly Inline[] }

export type Block =
    | {
          readonly kind: "heading"
          readonly level: 1 | 2 | 3 | 4 | 5 | 6
          readonly children: readonly Inline[]
      }
    | { readonly kind: "paragraph"; readonly children: readonly Inline[] }
    | {
          readonly kind: "code"
          readonly lang: string
          readonly text: string
          readonly open: boolean
      }
    | { readonly kind: "quote"; readonly children: readonly Block[] }
    | {
          readonly kind: "list"
          readonly ordered: boolean
          readonly start: number
          readonly items: readonly Block[][]
      }
    | {
          readonly kind: "table"
          readonly head: readonly (readonly Inline[])[]
          readonly rows: readonly (readonly Inline[])[][]
          readonly align: readonly ("left" | "center" | "right" | undefined)[]
      }
    | { readonly kind: "rule" }

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export function parseMarkdown(source: string): readonly Block[] {
    return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"))
}

function parseBlocks(lines: readonly string[]): Block[] {
    const out: Block[] = []
    let i = 0
    while (i < lines.length) {
        const line = lines[i] ?? ""
        if (line.trim() === "") {
            i++
            continue
        }
        const fence = FENCE.exec(line)
        if (fence) {
            const marker = fence[2] ?? "```"
            const lang = fence[3] ?? ""
            const body: string[] = []
            let j = i + 1
            let closed = false
            for (; j < lines.length; j++) {
                const candidate = lines[j] ?? ""
                if (
                    candidate.trim().startsWith(marker[0] ?? "`") &&
                    candidate.trim().length >= marker.length &&
                    /^[`~]+\s*$/.test(candidate.trim())
                ) {
                    closed = true
                    break
                }
                body.push(candidate)
            }
            out.push({ kind: "code", lang, text: body.join("\n"), open: !closed })
            i = closed ? j + 1 : j
            continue
        }
        const heading = HEADING.exec(line)
        if (heading) {
            const level = Math.min(6, (heading[1] ?? "#").length) as Block extends {
                level: infer L
            }
                ? L
                : never
            out.push({
                kind: "heading",
                level: level as 1 | 2 | 3 | 4 | 5 | 6,
                children: parseInline(heading[2] ?? ""),
            })
            i++
            continue
        }
        if (RULE.test(line)) {
            out.push({ kind: "rule" })
            i++
            continue
        }
        if (QUOTE.test(line)) {
            const inner: string[] = []
            while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
                inner.push((QUOTE.exec(lines[i] ?? "") ?? [])[1] ?? "")
                i++
            }
            out.push({ kind: "quote", children: parseBlocks(inner) })
            continue
        }
        if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1] ?? "")) {
            const head = cells(line).map(parseInline)
            const align = cells(lines[i + 1] ?? "").map((cell) => {
                const left = cell.startsWith(":")
                const right = cell.endsWith(":")
                return left && right ? "center" : right ? "right" : left ? "left" : undefined
            })
            const rows: Inline[][][] = []
            i += 2
            while (i < lines.length && TABLE_ROW.test(lines[i] ?? "")) {
                rows.push(cells(lines[i] ?? "").map(parseInline))
                i++
            }
            out.push({ kind: "table", head, rows, align })
            continue
        }
        const bullet = BULLET.exec(line)
        const numbered = NUMBERED.exec(line)
        if (bullet || numbered) {
            const ordered = numbered !== null
            const indent = (bullet ?? numbered ?? [])[1]?.length ?? 0
            const start = ordered ? Number(numbered?.[2] ?? "1") : 1
            const items: Block[][] = []
            while (i < lines.length) {
                const current = lines[i] ?? ""
                const match = (ordered ? NUMBERED : BULLET).exec(current)
                if (!match || (match[1]?.length ?? 0) !== indent) break
                const item: string[] = [match[3] ?? ""]
                i++
                // Continuation: deeper-indented lines, or blank lines followed by deeper lines.
                while (i < lines.length) {
                    const next = lines[i] ?? ""
                    if (next.trim() === "") {
                        const after = lines[i + 1] ?? ""
                        if (after.trim() !== "" && leading(after) > indent) {
                            item.push("")
                            i++
                            continue
                        }
                        break
                    }
                    if (leading(next) > indent) {
                        item.push(next.slice(Math.min(leading(next), indent + 2)))
                        i++
                        continue
                    }
                    // A lazy continuation line: not a new list item at this level, not indented.
                    const sibling = (ordered ? NUMBERED : BULLET).exec(next)
                    const other = (ordered ? BULLET : NUMBERED).exec(next)
                    if (
                        (sibling && (sibling[1]?.length ?? 0) === indent) ||
                        other ||
                        FENCE.test(next) ||
                        HEADING.test(next) ||
                        QUOTE.test(next) ||
                        TABLE_ROW.test(next)
                    )
                        break
                    item.push(next)
                    i++
                }
                items.push(parseBlocks(item))
            }
            out.push({ kind: "list", ordered, start, items })
            continue
        }
        // Paragraph: until a blank line or a block opener.
        const para: string[] = [line]
        i++
        while (i < lines.length) {
            const next = lines[i] ?? ""
            if (
                next.trim() === "" ||
                FENCE.test(next) ||
                HEADING.test(next) ||
                RULE.test(next) ||
                QUOTE.test(next) ||
                BULLET.test(next) ||
                NUMBERED.test(next) ||
                (TABLE_ROW.test(next) && TABLE_SEP.test(lines[i + 1] ?? ""))
            )
                break
            para.push(next)
            i++
        }
        out.push({ kind: "paragraph", children: parseInline(para.join("\n")) })
    }
    return out
}

function leading(line: string): number {
    return line.length - line.trimStart().length
}

function cells(row: string): string[] {
    const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "")
    const out: string[] = []
    let current = ""
    for (let k = 0; k < trimmed.length; k++) {
        const ch = trimmed[k]
        if (ch === "\\" && trimmed[k + 1] === "|") {
            current += "|"
            k++
        } else if (ch === "|") {
            out.push(current.trim())
            current = ""
        } else current += ch
    }
    out.push(current.trim())
    return out
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i

/** Inline parse. Code spans first, because nothing inside one is markup. */
export function parseInline(text: string): Inline[] {
    const out: Inline[] = []
    let buffer = ""
    const flush = () => {
        if (buffer !== "") {
            out.push({ kind: "text", text: buffer })
            buffer = ""
        }
    }
    let i = 0
    while (i < text.length) {
        const rest = text.slice(i)
        const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest)
        if (code) {
            flush()
            out.push({ kind: "code", text: (code[2] ?? "").replace(/^ (?=\S)| (?<=\S)$/g, "") })
            i += code[0].length
            continue
        }
        const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
        if (link) {
            flush()
            const href = link[2] ?? ""
            if (SAFE_HREF.test(href))
                out.push({ kind: "link", href, children: parseInline(link[1] ?? "") })
            else out.push(...parseInline(link[1] ?? ""))
            i += link[0].length
            continue
        }
        const bare = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)
        if (bare) {
            flush()
            out.push({ kind: "link", href: bare[0], children: [{ kind: "text", text: bare[0] }] })
            i += bare[0].length
            continue
        }
        const wrapped =
            /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest) ??
            /^(~~)(?=\S)([\s\S]*?\S)\1/.exec(rest) ??
            /^(\*|_)(?=\S)([^*_\n]+?\S|\S)\1(?![*_\w])/.exec(rest)
        if (wrapped && !(wrapped[1] === "_" && i > 0 && /\w/.test(text[i - 1] ?? ""))) {
            flush()
            const marker = wrapped[1] ?? ""
            const kind = marker === "~~" ? "strike" : marker.length === 2 ? "strong" : "em"
            out.push({ kind, children: parseInline(wrapped[2] ?? "") })
            i += wrapped[0].length
            continue
        }
        if (
            text[i] === "\\" &&
            i + 1 < text.length &&
            /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1] ?? "")
        ) {
            buffer += text[i + 1]
            i += 2
            continue
        }
        buffer += text[i]
        i++
    }
    flush()
    return out
}

/** Plain text of a block tree, for copy buttons and tests. */
export function plainText(blocks: readonly Block[]): string {
    const inline = (nodes: readonly Inline[]): string =>
        nodes
            .map((node) =>
                node.kind === "text" || node.kind === "code" ? node.text : inline(node.children),
            )
            .join("")
    return (
        blocks
            // biome-ignore lint/suspicious/useIterableCallbackReturn: the switch is exhaustive over Block
            .map((block) => {
                switch (block.kind) {
                    case "heading":
                    case "paragraph":
                        return inline(block.children)
                    case "code":
                        return block.text
                    case "quote":
                        return plainText(block.children)
                    case "list":
                        return block.items.map((item) => plainText(item)).join("\n")
                    case "table":
                        return [block.head, ...block.rows]
                            .map((row) => row.map(inline).join(" | "))
                            .join("\n")
                    case "rule":
                        return ""
                }
            })
            .join("\n")
    )
}
