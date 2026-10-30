/**
 * The pixel wordmark, from the TUI's own renderer — the same one the landing site draws.
 *
 * Never written down: `BRAND.name` goes through `packages/cli/src/lib/wordmark.ts`'s glyph table, so a
 * rename changes nothing here (hard rule 3). Each `█` becomes a unit square, so the browser draws
 * pixels rather than a font's idea of a block glyph.
 */

import { DEFAULT_BRAND } from "@dispach/core/wire"
import type React from "react"
import { wordmark } from "../../cli/src/lib/wordmark.ts"

interface Grid {
    readonly width: number
    readonly height: number
    readonly cells: readonly { readonly x: number; readonly y: number }[]
}

/** The `block` tier: one cell per pixel. 60 columns fits it and is too narrow for `wide`. */
function grid(text: string, columns: number): Grid {
    const mark = wordmark(text, { columns, rows: 5 })
    return {
        width: mark.width,
        height: mark.lines.length,
        cells: mark.lines.flatMap((line, y) =>
            [...line].flatMap((cell, x) => (cell === "█" ? [{ x, y }] : [])),
        ),
    }
}

const NAME = grid(DEFAULT_BRAND.name, 60)
/** The first letter alone, for the favicon and the collapsed mark. */
const INITIAL = grid(DEFAULT_BRAND.name.slice(0, 1), 9)

function Pixels(props: {
    readonly grid: Grid
    readonly height: number
    readonly label?: string
}): React.ReactElement {
    return (
        <svg
            role="img"
            aria-label={props.label ?? DEFAULT_BRAND.name}
            viewBox={`0 0 ${props.grid.width} ${props.grid.height}`}
            height={props.height}
            className="wordmark"
            shapeRendering="crispEdges"
        >
            {props.grid.cells.map(({ x, y }) => (
                <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
            ))}
        </svg>
    )
}

export function Wordmark(props: { readonly height?: number }): React.ReactElement {
    return <Pixels grid={NAME} height={props.height ?? 14} />
}

/** The initial on the dark ground, as an SVG data URI: the favicon, text like everything else here. */
export function faviconHref(): string {
    const pad = 2
    const size = Math.max(INITIAL.width, INITIAL.height) + pad * 2
    const left = (size - INITIAL.width) / 2
    const top = (size - INITIAL.height) / 2
    const rects = INITIAL.cells
        .map(({ x, y }) => `<rect x='${x + left}' y='${y + top}' width='1' height='1'/>`)
        .join("")
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}' shape-rendering='crispEdges'><rect width='${size}' height='${size}' rx='1.5' fill='#121212'/><g fill='#d75fd7'>${rects}</g></svg>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
