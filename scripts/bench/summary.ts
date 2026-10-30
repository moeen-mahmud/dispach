#!/usr/bin/env bun
/**
 * The published benchmark: one summary over the current sweep and the rival harnesses.
 *
 *   bun scripts/bench/summary.ts            write evals/harness/summary.json and the docs page
 *   bun scripts/bench/summary.ts --check    fail when either is stale
 *
 * The landing page, the docs page and anything shared outside read this one file, so a number cannot
 * differ between them. Every figure goes through `report.ts`'s `summarise`: the same Wilson interval,
 * and throttled rows left out of the rate. Which run directory each arm comes from is the one thing
 * written by hand, in SOURCES below.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { BRAND } from "../../packages/core/src/brand.ts"
import { type Arm, load } from "./report.ts"

const ROOT = resolve(import.meta.dirname, "..", "..")
const RUNS = join(ROOT, "evals", "harness", "runs")
const OUT = join(ROOT, "evals", "harness", "summary.json")
const PAGE = join(ROOT, "developer-docs", "runtime", "benchmarks.md")
const README = join(ROOT, "README.md")
const CHECK = process.argv.includes("--check")

/** The sweep this summary publishes, and where each rival arm was measured. */
const SWEEP = { dir: "sweep-4f3e00a", commit: "4f3e00a" }
const RIVALS = {
    hermes: { name: "Hermes", version: "0.19.0" },
    openclaw: { name: "OpenClaw", version: "2026.10.5" },
} as const
const RIVAL_DIRS = ["sweep-bfaf549", "h2h-cachefix", "sweep-552660a"]
/** An arm stopped before it finished: shown as partial, never as a rate. */
const PAUSED: Record<string, string> = { "nlt.qwen3.5-9b": "paused-qwen-nlt" }

/** Display names, in the order the tables list them. */
const MODELS: readonly [key: string, name: string][] = [
    ["opus-5.5", "Claude Opus 5.5"],
    ["sonnet-5.5", "Claude Sonnet 5.5"],
    ["haiku-5.5", "Claude Haiku 5.5"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["gemini-4-argon", "Gemini 4 Argon"],
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ["grok-4.7", "Grok 4.7"],
    ["glm-5.3", "GLM 5.3"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["kimi-k3", "Kimi K3"],
    ["gemma4-26b-a4b", "Gemma 4 26B-A4B"],
    ["qwen3.5-9b", "qwen3.5-9b"],
    ["gpt-oss-20b", "gpt-oss-20b"],
]

export interface Cell {
    readonly pass: number
    readonly n: number
    readonly rate: number
    readonly low: number
    readonly high: number
    /** Tasks passed on every trial (pass^k), beside the pass rate. */
    readonly passK: { readonly pass: number; readonly tasks: number }
    readonly cost: number
    readonly measured: string
    readonly paused?: true
}

/**
 * Pass^k over an arm: tasks where every trial passed. `arm.tasks` already counts
 * each task once however its rows were sharded (`load` merges `<arm>.rN.jsonl`
 * shards into one arm) and already leaves throttled rows out (`summarise` scores
 * only what was measured), so a throttled trial never counts against its task.
 */
export function passK(arm: Arm): Cell["passK"] {
    const tasks = Object.values(arm.tasks)
    return { pass: tasks.filter((t) => t.pass === t.n).length, tasks: tasks.length }
}

const dateOf = (dir: string, arm: string): string => {
    const lines = readFileSync(join(RUNS, dir, `${arm}.jsonl`), "utf8")
        .trim()
        .split("\n")
    return (JSON.parse(lines[0] ?? "{}") as { at?: string }).at?.slice(0, 10) ?? ""
}

function cell(arm: Arm, measured: string, paused = false): Cell {
    const { pass, n, rate, low, high } = arm.overall
    return {
        pass,
        n,
        rate,
        low,
        high,
        passK: passK(arm),
        cost: arm.cost,
        measured,
        ...(paused ? { paused } : {}),
    }
}

export function build() {
    const sweep = new Map(load(join(RUNS, SWEEP.dir)).map((a) => [a.arm, a]))
    for (const [arm, sub] of Object.entries(PAUSED)) {
        const found = load(join(RUNS, SWEEP.dir, sub)).find((a) => a.arm === arm)
        if (found !== undefined) sweep.set(`${arm} (paused)`, found)
    }
    // The newest directory wins when two hold the same rival arm.
    const rivals = new Map<string, { arm: Arm; dir: string }>()
    for (const dir of RIVAL_DIRS)
        for (const arm of load(join(RUNS, dir)))
            if (/^(hermes|openclaw)\./.test(arm.arm)) rivals.set(arm.arm, { arm, dir })

    const sweepDate = (arm: string) =>
        existsSync(join(RUNS, SWEEP.dir, `${arm}.jsonl`))
            ? dateOf(SWEEP.dir, arm)
            : dateOf(SWEEP.dir, `${arm}.r1`)
    const models = MODELS.map(([key, name]) => {
        const dispach = (dialect: string) => {
            const arm = sweep.get(`${dialect}.${key}`)
            if (arm !== undefined) return cell(arm, sweepDate(`${dialect}.${key}`))
            const paused = sweep.get(`${dialect}.${key} (paused)`)
            return paused === undefined ? undefined : cell(paused, "2026-10-23", true)
        }
        const rival = (h: keyof typeof RIVALS) => {
            const found = rivals.get(`${h}.${key}`)
            if (found === undefined) return undefined
            const file = existsSync(join(RUNS, found.dir, `${h}.${key}.jsonl`))
                ? `${h}.${key}`
                : `${h}.${key}.r1`
            return cell(found.arm, dateOf(found.dir, file))
        }
        return {
            key,
            name,
            native: dispach("native"),
            nlt: dispach("nlt"),
            hermes: rival("hermes"),
            openclaw: rival("openclaw"),
        }
    })
    return {
        generatedBy: "scripts/bench/summary.ts",
        tasks: 25,
        repeats: 5,
        sweep: { ...SWEEP, harness: BRAND.name },
        rivals: RIVALS,
        models,
    }
}

const pct = (c: Cell) => `${Math.round(c.rate * 100)}%`
const score = (c: Cell | undefined) =>
    c === undefined
        ? "not measured"
        : c.paused
          ? `paused at ${c.pass}/${c.n}`
          : `${c.pass}/${c.n} (${pct(c)})`
const money = (c: Cell | undefined) => (c === undefined ? "" : `$${c.cost.toFixed(2)}`)
/** Pass^k as a column: a paused arm ran no full sweep, so it has no all-trials figure. */
const all5 = (c: Cell | undefined) =>
    c === undefined ? "not measured" : c.paused ? "paused" : `${c.passK.pass}/${c.passK.tasks}`

/** The head-to-head table: the docs page and the root README both carry it. */
export function table(summary: ReturnType<typeof build>): string {
    const { hermes, openclaw } = summary.rivals
    const rows = summary.models.filter((m) => m.hermes !== undefined)
    const both = (c: Cell | undefined) => `${score(c)} · ${money(c)}`
    return [
        `| Model | ${BRAND.name} | ${hermes.name} ${hermes.version} | ${openclaw.name} ${openclaw.version} |`,
        "| --- | --- | --- | --- |",
        ...rows.map(
            (m) => `| ${m.name} | ${both(m.native)} | ${both(m.hermes)} | ${both(m.openclaw)} |`,
        ),
    ].join("\n")
}

/** The README's copy sits between two markers, so the rest of the README stays hand-written. */
export function readme(text: string, summary: ReturnType<typeof build>): string {
    const start = "<!-- benchmark:start -->"
    const end = "<!-- benchmark:end -->"
    const from = text.indexOf(start)
    const to = text.indexOf(end)
    if (from === -1 || to < from)
        throw new Error(
            `README.md has no ${start} … ${end} block.\n  hint: put both markers where the table goes.`,
        )
    return `${text.slice(0, from + start.length)}\n${table(summary)}\n${text.slice(to)}`
}

export function page(summary: ReturnType<typeof build>): string {
    const name = BRAND.name
    const { hermes, openclaw } = summary.rivals
    const h2h = summary.models.filter((m) => m.hermes !== undefined)
    const dates = (h: "hermes" | "openclaw") =>
        [...new Set(h2h.map((m) => m[h]?.measured).filter((d) => d !== undefined))].sort()
    const span = (d: string[]) => (d.length > 1 ? `${d.at(0)} to ${d.at(-1)}` : (d[0] ?? ""))
    return `<!-- Generated by ${summary.generatedBy} from evals/harness/runs. Edit that script, not this page. -->

# Benchmarks

${name} is measured on ${summary.tasks} multi-turn agent tasks, ${summary.repeats} times each, against the
same tools and pinned model providers as two other open-source harnesses. Each task is graded on the tools'
final state, never on the reply's wording. Every run is committed, with its replies, under
[\`evals/harness/\`](https://github.com/moeen-mahmud/dispach/tree/main/evals/harness).

## Against other harnesses

Tasks passed out of ${summary.tasks * summary.repeats}, and what the ${summary.tasks * summary.repeats} runs cost
on OpenRouter. ${name} uses native tool calls. ${name} was measured at \`${summary.sweep.commit}\`;
${hermes.name} ${hermes.version} on ${span(dates("hermes"))} and ${openclaw.name} ${openclaw.version} on
${span(dates("openclaw"))}, with the same tasks, isolation and providers.

${table(summary)}

With 125 runs an arm, a gap of a few runs is noise: the 95% intervals are in
[\`evals/harness/summary.json\`](https://github.com/moeen-mahmud/dispach/blob/main/evals/harness/summary.json).

## Tool-call dialects

${name} can call tools through the provider's native function calling or through NLT, a plain-text
format. \`init\` writes native wherever the model supports it. The all 5 columns count tasks passed
on every trial (pass^k): what a user who repeats a task cares about, beside the rate over runs.

| Model | Native | Native all 5 | NLT | NLT all 5 |
| --- | --- | --- | --- | --- |
${summary.models.map((m) => `| ${m.name} | ${score(m.native)} | ${all5(m.native)} | ${score(m.nlt)} | ${all5(m.nlt)} |`).join("\n")}

## How it is run

- **Tasks:** single calls, chains, recall across turns, abstention, recovery from injected tool failures,
  and long files ([\`scripts/bench/tasks.ts\`](https://github.com/moeen-mahmud/dispach/blob/main/scripts/bench/tasks.ts)).
- **Isolation:** every harness runs in its own container, its state restored before every attempt.
- **Scoring:** a run that errors scores 0. A run the provider rate-limited is re-run, not scored.
- **Limits:** one benchmark of our own design, each harness on its own defaults. Where ${name} loses,
  and why, is written up in the
  [benchmark README](https://github.com/moeen-mahmud/dispach/blob/main/evals/harness/README.md).
`
}

if (import.meta.main) {
    const summary = build()
    const json = `${JSON.stringify(summary, null, 4)}\n`
    const md = page(summary)
    const root = readme(readFileSync(README, "utf8"), summary)
    if (CHECK) {
        const stale = [
            [OUT, json],
            [PAGE, md],
            [README, root],
        ].filter(
            ([file, text]) => !existsSync(file ?? "") || readFileSync(file ?? "", "utf8") !== text,
        )
        if (stale.length > 0) {
            console.error(
                `benchmark summary is stale: ${stale.map(([f]) => f).join(", ")}\n  hint: run bun scripts/bench/summary.ts and commit the result.`,
            )
            process.exit(1)
        }
        console.log("benchmark summary: current")
    } else {
        writeFileSync(OUT, json)
        writeFileSync(PAGE, md)
        writeFileSync(README, root)
        console.log(`wrote ${OUT}, ${PAGE} and the README table`)
    }
}
