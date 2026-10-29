/**
 * Renders `lib/markdown.ts`'s tree. No `dangerouslySetInnerHTML` anywhere in this file, by design:
 * the parser emits no HTML and this component writes none, so model output cannot script the page.
 */

/* biome-ignore-all lint/suspicious/noArrayIndexKey: the tree is re-parsed from text on every render and has no identity of its own, so a position is the stable key; a content hash would collide on repeated paragraphs */

import type React from "react"
import { useState } from "react"
import { type Block, type Inline, parseMarkdown } from "./lib/markdown.ts"

export function Markdown(props: { readonly text: string }): React.ReactElement {
    return <>{renderBlocks(parseMarkdown(props.text), "")}</>
}

function renderBlocks(blocks: readonly Block[], prefix: string): React.ReactNode[] {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: the switch is exhaustive over Block
    return blocks.map((block, index) => {
        const key = `${prefix}${index}`
        switch (block.kind) {
            case "heading": {
                const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                return <Tag key={key}>{renderInline(block.children, key)}</Tag>
            }
            case "paragraph":
                return <p key={key}>{renderInline(block.children, key)}</p>
            case "code":
                return <CodeBlock key={key} lang={block.lang} text={block.text} open={block.open} />
            case "quote":
                return <blockquote key={key}>{renderBlocks(block.children, `${key}.`)}</blockquote>
            case "list": {
                const items = block.items.map((item, itemIndex) => (
                    <li key={`${key}.${itemIndex}`}>
                        {renderBlocks(item, `${key}.${itemIndex}.`)}
                    </li>
                ))
                return block.ordered ? (
                    <ol key={key} start={block.start}>
                        {items}
                    </ol>
                ) : (
                    <ul key={key}>{items}</ul>
                )
            }
            case "table":
                return (
                    <div key={key} className="md-table">
                        <table>
                            <thead>
                                <tr>
                                    {block.head.map((cell, cellIndex) => (
                                        <th
                                            key={`${key}.h${cellIndex}`}
                                            style={alignStyle(block.align[cellIndex])}
                                        >
                                            {renderInline(cell, `${key}.h${cellIndex}`)}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {block.rows.map((row, rowIndex) => (
                                    <tr key={`${key}.r${rowIndex}`}>
                                        {row.map((cell, cellIndex) => (
                                            <td
                                                key={`${key}.r${rowIndex}.${cellIndex}`}
                                                style={alignStyle(block.align[cellIndex])}
                                            >
                                                {renderInline(
                                                    cell,
                                                    `${key}.r${rowIndex}.${cellIndex}`,
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            case "rule":
                return <hr key={key} />
        }
    })
}

function alignStyle(
    align: "left" | "center" | "right" | undefined,
): React.CSSProperties | undefined {
    return align === undefined ? undefined : { textAlign: align }
}

function renderInline(nodes: readonly Inline[], prefix: string): React.ReactNode[] {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: the switch is exhaustive over Inline
    return nodes.map((node, index) => {
        const key = `${prefix}i${index}`
        switch (node.kind) {
            case "text":
                return node.text
            case "code":
                return <code key={key}>{node.text}</code>
            case "strong":
                return <strong key={key}>{renderInline(node.children, key)}</strong>
            case "em":
                return <em key={key}>{renderInline(node.children, key)}</em>
            case "strike":
                return <del key={key}>{renderInline(node.children, key)}</del>
            case "link":
                return (
                    <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
                        {renderInline(node.children, key)}
                    </a>
                )
        }
    })
}

function CodeBlock(props: {
    readonly lang: string
    readonly text: string
    readonly open: boolean
}): React.ReactElement {
    const [copied, setCopied] = useState(false)
    return (
        <div className={`md-code${props.open ? " open" : ""}`}>
            <div className="md-code-head">
                <span>{props.lang || "text"}</span>
                <button
                    type="button"
                    onClick={() => {
                        void navigator.clipboard
                            ?.writeText(props.text)
                            .then(() => {
                                setCopied(true)
                                setTimeout(() => setCopied(false), 1200)
                            })
                            .catch(() => undefined)
                    }}
                >
                    {copied ? "copied" : "copy"}
                </button>
            </div>
            <pre>
                <code>{props.text}</code>
            </pre>
        </div>
    )
}
