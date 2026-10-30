/**
 * The command palette: ⌘K or Ctrl+K anywhere, type, ↑/↓, enter. Props only; the shell owns the key
 * that opens it and what a pick does. Escape and a click outside close it, and so does a pick, so
 * there is never a palette left open over the page it just navigated.
 */

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { type PaletteEntry, rankEntries } from "./lib/palette.ts"

export function Palette(props: {
    readonly entries: readonly PaletteEntry[]
    readonly onPick: (entry: PaletteEntry) => void
    readonly onClose: () => void
}): React.ReactElement {
    const [query, setQuery] = useState("")
    const [cursor, setCursor] = useState(0)
    const input = useRef<HTMLInputElement>(null)
    const shown = rankEntries(props.entries, query)
    const at = Math.min(cursor, Math.max(shown.length - 1, 0))
    useEffect(() => input.current?.focus(), [])
    return (
        <div className="palette-layer">
            {/* A real button behind the dialog: a click outside closes, and so does its Enter. */}
            <button
                type="button"
                className="palette-backdrop"
                aria-label="close"
                tabIndex={-1}
                onClick={props.onClose}
            />
            <div className="palette" role="dialog" aria-label="go to">
                <input
                    ref={input}
                    value={query}
                    placeholder="Go to a page or an agent…"
                    aria-label="search pages and agents"
                    onChange={(event) => {
                        setQuery(event.target.value)
                        setCursor(0)
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") props.onClose()
                        else if (event.key === "ArrowDown") {
                            event.preventDefault()
                            setCursor(Math.min(at + 1, shown.length - 1))
                        } else if (event.key === "ArrowUp") {
                            event.preventDefault()
                            setCursor(Math.max(at - 1, 0))
                        } else if (event.key === "Enter") {
                            const entry = shown[at]
                            if (entry !== undefined) props.onPick(entry)
                        }
                    }}
                />
                {shown.length === 0 ? (
                    <p className="empty">Nothing matches "{query}".</p>
                ) : (
                    <ul className="palette-list">
                        {shown.map((entry, index) => (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    className="palette-item"
                                    aria-current={index === at}
                                    onMouseEnter={() => setCursor(index)}
                                    onClick={() => props.onPick(entry)}
                                >
                                    <span>{entry.label}</span>
                                    <span className="sub">{entry.hint}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    )
}
