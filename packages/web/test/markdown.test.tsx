import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { parseInline, parseMarkdown, plainText } from "../src/lib/markdown.ts"
import { Markdown } from "../src/Markdown.tsx"

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe("markdown blocks", () => {
    test("headings, paragraphs, rules", () => {
        const out = html("# Title\n\nSome *text* here.\n\n---\n\n## Sub")
        expect(out).toContain("<h1>Title</h1>")
        expect(out).toContain("<p>Some <em>text</em> here.</p>")
        expect(out).toContain("<hr/>")
        expect(out).toContain("<h2>Sub</h2>")
    })

    test("fenced code keeps its text verbatim and names the language; an open fence still renders", () => {
        const out = html("```ts\nconst a = <b>1</b>\n```")
        expect(out).toContain("<span>ts</span>")
        expect(out).toContain("const a = &lt;b&gt;1&lt;/b&gt;")
        expect(out).not.toContain(" open")
        expect(html("```sh\necho hi")).toContain("md-code open")
    })

    test("lists: bullets, numbers with a start, nesting, lazy continuation", () => {
        const out = html("- one\n- two\n  - deep\n3. three\n4. four\ncontinued")
        expect(out).toContain(
            "<ul><li><p>one</p></li><li><p>two</p><ul><li><p>deep</p></li></ul></li></ul>",
        )
        expect(out).toContain(
            '<ol start="3"><li><p>three</p></li><li><p>four\ncontinued</p></li></ol>',
        )
    })

    test("quotes and tables", () => {
        const out = html("> a quote\n> more\n\n| h1 | h2 |\n|:--|--:|\n| a | b |")
        expect(out).toContain("<blockquote><p>a quote\nmore</p></blockquote>")
        expect(out).toContain('<th style="text-align:left">h1</th>')
        expect(out).toContain('<td style="text-align:right">b</td>')
    })
})

describe("markdown inline", () => {
    test("strong, em, strike, code, escaped characters", () => {
        expect(html("**b** _i_ ~~s~~ `c` \\*lit\\*")).toContain(
            "<p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code> *lit*</p>",
        )
    })

    test("underscores inside words are not emphasis", () => {
        expect(html("snake_case_name")).toContain("<p>snake_case_name</p>")
    })

    test("links: http(s) and mailto become anchors, anything else is text", () => {
        const out = html("[ok](https://x.y) [bad](javascript:void0) https://bare.example/path.")
        expect(out).toContain(
            '<a href="https://x.y" target="_blank" rel="noreferrer noopener">ok</a>',
        )
        expect(out).not.toContain("javascript:")
        expect(out).toContain("</a> bad <a")
        expect(out).toContain('href="https://bare.example/path"')
    })

    test("raw HTML is text, never markup", () => {
        const out = html("<script>alert(1)</script> <img src=x onerror=alert(1)>")
        expect(out).not.toContain("<script>")
        expect(out).toContain("&lt;script&gt;")
        expect(out).not.toContain("<img")
    })
})

describe("plain text", () => {
    test("round-trips the visible words", () => {
        expect(plainText(parseMarkdown("# A\n\n**b** and `c`\n\n- d\n- e"))).toBe(
            "A\nb and c\nd\ne",
        )
        expect(parseInline("just text")).toEqual([{ kind: "text", text: "just text" }])
    })
})
