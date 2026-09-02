#!/usr/bin/env bun
/**
 * Memory retrieval: how fast it is at scale, and what the threshold actually admits.
 *
 *   bun scripts/eval-memory.ts [--passages 5000] [--repeats 5] [--label baseline]
 *
 * Deliberately **not** a model eval. Nothing here calls an endpoint, because the two claims worth
 * measuring are both local: that retrieval stays inside its latency budget over a corpus far larger
 * than any real one, and that the shipped `threshold` admits the answers a person would call correct
 * while refusing the ones they would not.
 *
 * The second half is the one that matters and the one a number alone cannot settle. A threshold is a
 * judgement about which partial matches count, so the fixture states the judgement explicitly —
 * `expect: "hit"` or `expect: "miss"` per question — and the output reports where the shipped default
 * disagrees. That is what makes it a calibration rather than a demonstration: a default nobody has
 * argued with is a default nobody has checked.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_QUESTIONS, memoryCorpus, PADDING_TOPICS } from "../evals/fixtures/memory.ts"
import { fts5Retriever, syncFiles } from "../packages/core/src/memory/fts5.ts"
import { retrieveWithContext, selectPassages } from "../packages/core/src/memory/retriever.ts"
import { openMemoryStore } from "../packages/core/src/store/sqlite/store.ts"

const args = process.argv.slice(2)
function flag(name: string, fallback: number): number {
    const at = args.indexOf(`--${name}`)
    if (at === -1) return fallback
    const value = Number(args[at + 1])
    return Number.isFinite(value) ? value : fallback
}
function textFlag(name: string): string | undefined {
    const at = args.indexOf(`--${name}`)
    const value = at === -1 ? undefined : args[at + 1]
    return value === undefined || value.trim() === "" ? undefined : value
}

const PASSAGES = flag("passages", 5000)
const REPEATS = flag("repeats", 5)
const LABEL = textFlag("label")
/** The shipped relevance floor. */
const THRESHOLD = 0.2
/** Fixed evaluation controls, held across the baseline and retained arms. */
const MAX_ACTIVE = 3
const BUDGET = 600
const NOW = new Date("2026-08-19T12:00:00Z")

const store = await openMemoryStore()
const AGENT = "eval"

// The real notes, plus filler so the corpus statistics are those of a large one. Padding matters:
// `discriminating()` drops a term present in more than half the corpus, so a ten-note corpus and a
// five-thousand-note corpus rank the same query differently, and the small one is not the case being
// claimed about.
const corpus = memoryCorpus(PASSAGES)
await syncFiles({
    store: store.memory,
    agentId: AGENT,
    files: [{ source: "2026-08.md", read: () => corpus, mtimeMs: 1, size: corpus.length }],
    now: NOW,
})
const stats = await store.memory.stats(AGENT)
const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })

// One warm call: the criterion is steady-state retrieval, not SQLite's first touch of a fresh index.
await retrieve({ input: "warm the index up", now: NOW, limit: 5 })

interface Outcome {
    readonly question: string
    readonly category: (typeof MEMORY_QUESTIONS)[number]["category"]
    readonly expect: "hit" | "miss" | "related"
    readonly injected: readonly string[]
    readonly topScore: number
    readonly topLexical: number
    readonly topCoverage: number
    readonly agrees: boolean
    readonly ms: number
}

const outcomes: Outcome[] = []
for (const probe of MEMORY_QUESTIONS) {
    let ms = Number.POSITIVE_INFINITY
    let ranked: Awaited<ReturnType<typeof retrieve>> = []
    for (let i = 0; i < REPEATS; i += 1) {
        const started = performance.now()
        ranked = await retrieveWithContext(retrieve, {
            input: probe.question,
            now: NOW,
            limit: MAX_ACTIVE * 4,
            minimumScore: THRESHOLD,
            ...(probe.previousAssistant === undefined
                ? {}
                : { previousAssistant: probe.previousAssistant }),
        })
        // The *best* of N, not the mean: this measures how fast retrieval is, and a scheduler hiccup
        // on a laptop is not information about the query.
        ms = Math.min(ms, performance.now() - started)
    }

    const injected = selectPassages(ranked, {
        threshold: THRESHOLD,
        maxActive: MAX_ACTIVE,
        budget: BUDGET,
    })
    const texts = injected.map((hit) => hit.passage.text)
    const answer = probe.answer
    const found = answer === undefined ? false : texts.some((t) => t.includes(answer))
    outcomes.push({
        question: probe.question,
        category: probe.category,
        expect: probe.expect,
        injected: texts,
        topScore: ranked[0]?.score ?? 0,
        topLexical: ranked[0]?.lexical ?? 0,
        topCoverage: ranked[0]?.coverage ?? 0,
        agrees: probe.expect === "miss" ? injected.length === 0 : found,
        ms,
    })
}

const hits = outcomes.filter((o) => o.expect === "hit")
const misses = outcomes.filter((o) => o.expect === "miss")
const related = outcomes.filter((o) => o.expect === "related")
const recall = hits.filter((o) => o.agrees).length / Math.max(1, hits.length)
const restraint = misses.filter((o) => o.agrees).length / Math.max(1, misses.length)
const truePositives = hits.filter((o) => o.agrees).length
const falseNegatives = hits.length - truePositives
const falsePositives = misses.filter((o) => !o.agrees).length
const precision = truePositives / Math.max(1, truePositives + falsePositives)
const f1 =
    precision + recall === 0
        ? 0
        : (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall)
const slowest = Math.max(...outcomes.map((o) => o.ms))
const median = [...outcomes.map((o) => o.ms)].sort((a, b) => a - b)[
    Math.floor(outcomes.length / 2)
] as number

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length))
console.log(
    `corpus      ${stats.passages} passages, avg ${(stats.totalLength / stats.passages).toFixed(2)} terms`,
)
console.log(`threshold   ${THRESHOLD}  maxActive ${MAX_ACTIVE}  budget ${BUDGET}`)
console.log(`repeats     ${REPEATS} per question, best-of reported`)
console.log()
console.log(
    `${pad("", 4)}${pad("ms", 7)}${pad("score", 7)}${pad("lex", 7)}${pad("cover", 7)}${pad("want", 9)}question`,
)
for (const o of outcomes) {
    console.log(
        `${pad(o.agrees ? "  ok" : "  XX", 4)}${pad(o.ms.toFixed(2), 7)}${pad(o.topScore.toFixed(3), 7)}${pad(o.topLexical.toFixed(3), 7)}${pad(o.topCoverage.toFixed(2), 7)}${pad(o.expect, 9)}${o.question}`,
    )
}
console.log()
console.log(
    `recall      ${(recall * 100).toFixed(1)}%  (${hits.filter((o) => o.agrees).length}/${hits.length} questions whose answer is in the corpus)`,
)
console.log(
    `restraint   ${(restraint * 100).toFixed(1)}%  (${misses.filter((o) => o.agrees).length}/${misses.length} questions with no answer, where nothing should be injected)`,
)
console.log(
    `related     ${related.filter((o) => o.agrees).length}/${related.length} topically relevant passages found; answerability is deliberately not scored`,
)
console.log(`precision   ${(precision * 100).toFixed(1)}%`)
console.log(`f1          ${(f1 * 100).toFixed(1)}%`)
console.log()
console.log("by category")
for (const category of [...new Set(outcomes.map((outcome) => outcome.category))]) {
    const group = outcomes.filter((outcome) => outcome.category === category)
    const correct = group.filter((outcome) => outcome.agrees).length
    console.log(
        `  ${pad(category, 12)} ${((100 * correct) / Math.max(1, group.length)).toFixed(1)}%  (${correct}/${group.length})`,
    )
}
console.log(
    `latency     median ${median.toFixed(2)} ms, slowest ${slowest.toFixed(2)} ms over ${stats.passages} passages`,
)

const disagreements = outcomes.filter((o) => !o.agrees)
if (disagreements.length > 0) {
    console.log()
    console.log("where the shipped threshold disagrees with the fixture:")
    for (const o of disagreements) {
        console.log(
            `  ${o.expect === "miss" ? "volunteered" : "withheld"}  ${o.topScore.toFixed(3)}  ${o.question}`,
        )
    }
}

const out = join(
    import.meta.dirname,
    "..",
    "evals",
    "memory",
    LABEL === undefined ? "results.json" : `results-${LABEL}.json`,
)
writeFileSync(
    out,
    `${JSON.stringify(
        {
            corpus: { passages: stats.passages, averageLength: stats.totalLength / stats.passages },
            settings: {
                threshold: THRESHOLD,
                maxActive: MAX_ACTIVE,
                budget: BUDGET,
                repeats: REPEATS,
            },
            recall,
            restraint,
            related: {
                retrieved: related.filter((outcome) => outcome.agrees).length,
                total: related.length,
            },
            precision,
            f1,
            confusion: {
                truePositives,
                falsePositives,
                falseNegatives,
                trueNegatives: misses.length - falsePositives,
            },
            categories: Object.fromEntries(
                [...new Set(outcomes.map((outcome) => outcome.category))].map((category) => {
                    const group = outcomes.filter((outcome) => outcome.category === category)
                    return [
                        category,
                        {
                            correct: group.filter((outcome) => outcome.agrees).length,
                            total: group.length,
                        },
                    ]
                }),
            ),
            latencyMs: { median, slowest },
            padding: PADDING_TOPICS,
            outcomes,
        },
        null,
        2,
    )}\n`,
)
console.log(`\nwrote ${out}`)
await store.close()
