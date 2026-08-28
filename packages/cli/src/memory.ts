/**
 * `memory` — search what the agent remembers, or rebuild the index from the files.
 *
 * Both actions are questions about the **index**, not about the files: the files are canonical and a
 * person can already read them with `cat`. What they cannot see is what the retriever would return for
 * a given question, which is the only thing that decides whether a fact reaches the model.
 *
 * ## Why search does not apply the threshold
 *
 * A turn applies `memory.threshold` and injects what clears it. A person running this is usually asking
 * the opposite question — *why did it not recall that?* — and a floor that hid the near-misses would
 * make the command useless for exactly that. So everything ranked is printed, with the ones below the
 * floor marked and excluded from the count. `--all` is therefore about *widening the candidate set*,
 * not about revealing something withheld.
 *
 * The carried file is included for the same reason. A note saved a minute ago is still in `MEMORY.md`
 * and is deliberately excluded from slot 7 — so "still in MEMORY.md, which is why it is not under
 * Remembered" is a real and useful answer that a search hiding it could never give.
 *
 * Neither Ink nor React is imported here: this is a report, and the lazy-Ink boundary is what keeps
 * every non-interactive command under a tenth of a second.
 */

import { Runtime } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { keyValue } from "#lib/render"
import { storePath } from "#lib/sandbox"
import type { MemoryOptions } from "#lib/schema"

/** Enough of a passage to recognize it, on one line. */
const PREVIEW_CHARS = 96

export async function memoryCommand(options: MemoryOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        // The sandbox store — the same one `run` writes to, or this searches an index nothing built.
        store: options.store ?? storePath(),
        toolProviders: TOOL_PROVIDERS,
        scriptRunner: scriptRunner(),
        channels: CHANNELS,
        env: ambientEnv([options.manifestPath]),
    })

    try {
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("The manifest produced no agent.")

        if (options.action === "rebuild") {
            const report = await agent.rebuildMemory()
            if (options.json === true) {
                process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
                return EXIT_OK
            }
            process.stdout.write(
                keyValue([
                    { label: "passages", value: String(report.passages) },
                    { label: "files read", value: String(report.indexed.length) },
                    // Named separately from the files because they answer a different question. A
                    // rebuild re-indexes conversations whether or not anyone asked, since `clear` wipes
                    // both namespaces — so the count is how the person finds out it happened.
                    {
                        label: "conversations",
                        value:
                            report.sessions.length === 0
                                ? "none indexed — memory.includeHistory is off, or there are no sessions yet"
                                : String(report.sessions.length),
                    },
                    {
                        label: "dropped",
                        value: report.dropped.length === 0 ? "" : report.dropped.join(", "),
                    },
                ]),
            )
            // Named rather than counted: after a rebuild every file was read, so a list of them is the
            // information — and an empty one means the memory directory has nothing in it yet.
            process.stdout.write(
                report.indexed.length === 0 && report.sessions.length === 0
                    ? "\nNothing to index. Memory files are written by `memory_write` and by hand, and conversations are indexed at the end of each turn.\n"
                    : `\nRead: ${[...report.indexed, ...report.sessions].join(", ")}\n`,
            )
            return EXIT_OK
        }

        const query = options.query ?? ""
        if (query.trim() === "") {
            process.stderr.write(
                "memory search needs something to search for.\n" +
                    '  hint: quote a phrase — `memory search <agent> "the deploy pipeline"`. An empty query cannot rank anything, which is different from finding nothing.\n',
            )
            return EXIT_FAILURE
        }

        const result = await agent.searchMemory({
            query,
            // `--all` widens the candidate set rather than lowering a floor; the floor is never applied
            // here at all.
            limit: options.limit ?? 10,
        })

        const above = result.hits.filter((hit) => hit.score >= result.threshold)
        const shown = options.all === true ? result.hits : above

        if (options.json === true) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        query,
                        corpus: result.corpus,
                        threshold: result.threshold,
                        carried: result.carried ?? null,
                        hits: shown.map((hit) => ({
                            source: hit.passage.source,
                            at: hit.passage.at,
                            score: hit.score,
                            lexical: hit.lexical,
                            coverage: hit.coverage,
                            tokens: hit.tokens,
                            wouldInject: hit.score >= result.threshold,
                            carried: hit.passage.source === result.carried,
                            text: hit.passage.text,
                        })),
                    },
                    null,
                    2,
                )}\n`,
            )
            return EXIT_OK
        }

        process.stdout.write(
            keyValue([
                {
                    label: "corpus",
                    value: `${result.corpus} passage${result.corpus === 1 ? "" : "s"}`,
                },
                { label: "threshold", value: result.threshold.toFixed(2) },
                { label: "above it", value: String(above.length) },
            ]),
        )

        if (result.corpus === 0) {
            process.stdout.write(
                "\nNothing indexed. `memory_write` fills the carried file, and eviction moves older notes into the memory directory.\n",
            )
            return EXIT_OK
        }
        if (shown.length === 0) {
            process.stdout.write(
                `\nNothing ${options.all === true ? "matched" : `scored above ${result.threshold.toFixed(2)}`}. Try --all, or fewer words: a term present in more than half the corpus is dropped as uninformative.\n`,
            )
            return EXIT_OK
        }

        // `score` and `lexical` both, because a ranking nobody can explain is a ranking nobody trusts:
        // the pair distinguishes "retrieved because it is about your question" from "retrieved because
        // it is recent". A passage below the threshold is marked rather than hidden — the question this
        // command exists for is usually "why was that *not* recalled".
        const sourceWidth = Math.max(6, ...shown.map((hit) => label(hit, result.carried).length))
        process.stdout.write(
            `\n${pad("SCORE", 6)}  ${pad("LEXICAL", 7)}  ${pad("COVER", 5)}  ${pad("SOURCE", sourceWidth)}  ${pad("LEARNED", 10)}  PASSAGE\n`,
        )
        for (const hit of shown) {
            const mark = hit.score >= result.threshold ? " " : "·"
            process.stdout.write(
                `${pad(hit.score.toFixed(3), 6)}  ${pad(hit.lexical.toFixed(3), 7)}  ` +
                    `${pad(hit.coverage.toFixed(2), 5)}  ` +
                    `${pad(label(hit, result.carried), sourceWidth)}  ${pad(hit.passage.at.slice(0, 10), 10)}  ` +
                    `${mark}${preview(hit.passage.text)}\n`,
            )
        }

        if (options.all === true && above.length < shown.length) {
            process.stdout.write(
                `\n${shown.length - above.length} shown below the threshold; a turn would not inject those.\n`,
            )
        }
        if (
            result.carried !== undefined &&
            shown.some((h) => h.passage.source === result.carried)
        ) {
            process.stdout.write(
                `\n${result.carried} is carried in every prompt already, so it is searchable here and deliberately absent from the retrieved block.\n`,
            )
        }
        return EXIT_OK
    } finally {
        await runtime.stop("cli-exit")
    }
}

function preview(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim()
    return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`
}

function pad(text: string, width: number): string {
    return text.length >= width ? text : text + " ".repeat(width - text.length)
}

/** The source, marked when it is the file already carried in every prompt. */
function label(
    hit: { readonly passage: { readonly source: string } },
    carried: string | undefined,
): string {
    return hit.passage.source === carried ? `${hit.passage.source} *` : hit.passage.source
}
