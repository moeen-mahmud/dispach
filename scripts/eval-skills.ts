#!/usr/bin/env bun
/**
 * Skill indexing: how long a cold scan takes, and how much the cache saves.
 *
 *   bun scripts/eval-skills.ts [--skills 50] [--repeats 7] [--ci]
 *
 * No endpoint, no model, no network — the claim is local, like `eval:memory`'s latency half. This
 * exists because the claim used to be a `toBeLessThan` inside `skills-index.test.ts`, and a
 * wall-clock assertion in the unit suite fails whenever the machine is busy: measured at 2 runs in 3
 * with four builds running beside it, which is what a shared CI runner is every time. Widening the
 * number would have been relaxing the criterion quietly, and the test's own comment refused that. So
 * the criterion moved to where a measurement belongs and the unit test kept the part that is not
 * about time — fifty skills load, the second scan is served from the cache.
 *
 * Cold and warm are separate corpora per repeat: a cold scan is only cold once, and reusing one
 * agent directory would measure the cache from the second repeat onward and report it as a scan.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PROMPT_STYLE } from "../packages/core/src/model/prompt-style.ts"
import { loadSkills } from "../packages/core/src/skills/index.ts"

const args = process.argv.slice(2)
function flag(name: string, fallback: number): number {
    const at = args.indexOf(`--${name}`)
    if (at === -1) return fallback
    const value = Number(args[at + 1])
    return Number.isFinite(value) ? value : fallback
}

const SKILLS = flag("skills", 50)
const REPEATS = flag("repeats", 7)

/**
 * The published criterion, and a ceiling an order of magnitude above it.
 *
 * The criterion is what the phase promised on an idle machine. The ceiling is what `--ci` enforces,
 * and the gap is deliberate: this runs on whatever hardware is going, so the enforced number has to
 * catch a real regression without failing on somebody else's build.
 */
const COLD_CRITERION_MS = 50
const WARM_CRITERION_MS = 5
const COLD_CEILING_MS = 500
const WARM_CEILING_MS = 50

const roots: string[] = []
function corpus(): { dir: string; agent: string } {
    const dir = mkdtempSync(join(tmpdir(), "eval-skills-"))
    const agent = mkdtempSync(join(tmpdir(), "eval-agent-"))
    roots.push(dir, agent)
    for (let index = 0; index < SKILLS; index += 1) {
        const name = `skill-${String(index).padStart(3, "0")}`
        mkdirSync(join(dir, name), { recursive: true })
        writeFileSync(
            join(dir, name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Handles ${name} work for the team.\n---\n\nStep one.\nStep two.\n`,
            "utf8",
        )
    }
    return { dir, agent }
}

function index(dir: string, agent: string) {
    return loadSkills({
        dir,
        maxActive: 1,
        threshold: 0.35,
        style: DEFAULT_PROMPT_STYLE,
        agentDir: agent,
    })
}

const cold: number[] = []
const warm: number[] = []

try {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        const { dir, agent } = corpus()

        const coldStart = performance.now()
        const first = index(dir, agent)
        cold.push(performance.now() - coldStart)

        const warmStart = performance.now()
        const second = index(dir, agent)
        warm.push(performance.now() - warmStart)

        // Asserted rather than assumed: a "warm" figure taken from a cold scan measures nothing, and
        // a cold scan that found the wrong number of skills is not the thing being timed.
        if (first.skills.length !== SKILLS || second.skills.length !== SKILLS) {
            console.error(
                `eval-skills: expected ${SKILLS} skills, scanned ${first.skills.length} then ${second.skills.length}`,
            )
            process.exit(1)
        }
        if (first.cached || !second.cached) {
            console.error(
                `eval-skills: expected cold then cached, got cached=${first.cached} then cached=${second.cached}`,
            )
            process.exit(1)
        }
    }
} finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
}

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) return sorted[middle] ?? 0
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const row = (label: string, values: number[], criterion: number): string =>
    `  ${label.padEnd(6)} median ${median(values).toFixed(2)} ms  (min ${Math.min(...values).toFixed(2)}, ` +
    `max ${Math.max(...values).toFixed(2)})  criterion ${criterion} ms` +
    `${median(values) <= criterion ? "" : "  ← over"}`

console.log(
    `eval-skills · ${SKILLS} skills · ${REPEATS} repeats · ${process.execPath.split("/").pop()}`,
)
console.log(row("cold", cold, COLD_CRITERION_MS))
console.log(row("warm", warm, WARM_CRITERION_MS))
console.log(
    `  saved  ${(median(cold) / Math.max(median(warm), 0.001)).toFixed(1)}× on the second scan`,
)

const over: string[] = []
if (median(cold) > COLD_CEILING_MS)
    over.push(`cold ${median(cold).toFixed(2)} ms > ${COLD_CEILING_MS} ms`)
if (median(warm) > WARM_CEILING_MS)
    over.push(`warm ${median(warm).toFixed(2)} ms > ${WARM_CEILING_MS} ms`)

if (over.length > 0) {
    console.error(
        `\neval-skills: FAIL — ${over.join(", ")}.` +
            `\n  hint: the ceiling is ten times the criterion, so this is a regression rather than a busy machine.` +
            ` A cold scan reads every SKILL.md; a warm one reads one cache file and stats each directory.`,
    )
    process.exit(1)
}

console.log("\neval-skills: ok")
