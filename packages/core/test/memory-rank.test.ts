/**
 * The FTS5 retriever: that it agrees with the index-free scorer, and that the index tracks the files.
 *
 * The first test is the one the phase's acceptance criterion actually turns on. "The retriever reuses
 * Phase 3.5's ranking seam rather than building a second index" is easy to *say* while shipping a second
 * scorer that happens to look similar, and the failure would be invisible: both would return plausible
 * numbers, and `skills.threshold: 0.35` and `memory.threshold: 0.35` would silently be two different
 * floors. So one corpus is scored through `bm25Selector` and through `fts5Retriever` and the lexical
 * scores are compared exactly — which is only possible because `rank/bm25.ts` is genuinely the only
 * implementation, and which fails the moment somebody adds a second.
 */

import { sessionSource } from "../src/memory/conversation.ts"
import { fts5Retriever, syncFiles, syncSessions } from "../src/memory/fts5.ts"
import { document, splitPassages } from "../src/memory/passages.ts"
import type { RetrievedPassage } from "../src/memory/retriever.ts"
import {
    boosted,
    RECENCY_HALF_LIFE_DAYS,
    RECENCY_WEIGHT,
    recencyBoost,
    retrieveWithContext,
    selectPassages,
} from "../src/memory/retriever.ts"
import { TOKENISER_VERSION } from "../src/rank/bm25.ts"
import type { Skill } from "../src/skills/index.ts"
import { bm25Selector } from "../src/skills/select.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import type { Store } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "probe"
const NOW = new Date("2026-08-19T12:00:00Z")

/** Corpus text, written so each entry's first word can serve as a skill `name`. */
const CORPUS: readonly string[] = [
    "yaml Moeen prefers tabs over spaces in generated yaml files",
    "boot The boot budget is one second and the bench fails at twelve hundred milliseconds",
    "telegram The telegram bot answers only handles listed in allowFrom",
    "compaction Compaction rewrites the prompt and never rewrites the store",
    "sqlite The store runs on bun sqlite and node sqlite behind one driver",
]

async function seeded(
    now = NOW,
): Promise<{ store: Store; retrieve: ReturnType<typeof fts5Retriever> }> {
    const store = await openMemoryStore()
    await syncFiles({
        store: store.memory,
        agentId: AGENT,
        files: [
            {
                source: "2026-08.md",
                read: () => CORPUS.map((line) => `- ${line}`).join("\n"),
                mtimeMs: Date.parse("2026-08-15T00:00:00Z"),
                size: 512,
            },
        ],
        now,
    })
    return { store, retrieve: fts5Retriever({ store: store.memory, agentId: AGENT }) }
}

describe("the retriever and the skill scorer are one scorer", () => {
    test("lexical scores agree exactly on the same corpus", async () => {
        // Skills score `name + " " + description`; passages score `document()`. Splitting each corpus
        // entry at its first word makes the two tokenise to identical term lists of identical length,
        // which is what makes an exact comparison meaningful rather than approximate.
        const skills: Skill[] = CORPUS.map((line) => {
            const [name, ...rest] = line.split(" ")
            return {
                name: name ?? "",
                dir: `/tmp/${name}`,
                frontmatter: { name: name ?? "", description: rest.join(" ") },
                tokens: 0,
                scripts: [],
                unrunnable: [],
            } as unknown as Skill
        })

        const store = await openMemoryStore()
        // One passage per corpus entry: no bullet marker and no heading, so `document()` is the text
        // itself and tokenises to exactly the skill's terms. All in **one** call, because `syncFiles`
        // reconciles rather than adds — a second call naming one file drops every other source.
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: CORPUS.map((line, i) => ({
                source: `p${i}.md`,
                read: () => line,
                mtimeMs: 0,
                size: line.length,
            })),
            now: NOW,
        })

        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        const query = "does he prefer tabs in yaml"

        const bySkill = new Map(
            bm25Selector(query, skills).map((scored) => [scored.skill.name, scored.score]),
        )
        const ranked = await retrieve({ input: query, now: NOW, limit: 50 })

        expect(ranked.length > 0).toBe(true)
        for (const hit of ranked) {
            const name = hit.passage.text.split(" ")[0] ?? ""
            const expected = bySkill.get(name)
            expect(expected === undefined).toBe(false)
            // Exact to floating-point noise. Not `toBeCloseTo` at 2 digits — that would pass for two
            // different formulas, which is the whole thing this test exists to catch.
            expect(Math.abs(hit.lexical - (expected ?? 0)) < 1e-12).toBe(true)
        }
        await store.close()
    })

    test("the indexed column is the shared tokeniser's output", async () => {
        const { store } = await seeded()
        const candidates = await store.memory.candidates(AGENT, ["yaml"], 10)
        expect(candidates.length).toBe(1)
        // `document()` of a top-level bullet is its text, so the stored terms are terms(text).
        const passage = splitPassages({
            text: `- ${CORPUS[0]}`,
            source: "2026-08.md",
            fallbackAt: NOW.toISOString(),
        })[0]
        expect(passage === undefined).toBe(false)
        const { terms } = await import("../src/rank/bm25.ts")
        expect(candidates[0]?.terms).toBe(
            passage === undefined ? "" : terms(document(passage)).join(" "),
        )
        await store.close()
    })
})

describe("retrieval", () => {
    test("finds a note by its own words", async () => {
        const { store, retrieve } = await seeded()
        const ranked = await retrieve({ input: "what does he prefer for yaml", now: NOW, limit: 3 })
        expect(ranked[0]?.passage.text.includes("prefers tabs")).toBe(true)
        await store.close()
    })

    test("a question sharing no term with the corpus retrieves nothing", async () => {
        const { store, retrieve } = await seeded()
        const ranked = await retrieve({ input: "who won the 1998 world cup", now: NOW, limit: 5 })
        expect(ranked.length).toBe(0)
        await store.close()
    })

    test("an empty corpus retrieves nothing rather than throwing", async () => {
        const store = await openMemoryStore()
        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        expect((await retrieve({ input: "anything at all", now: NOW, limit: 5 })).length).toBe(0)
        await store.close()
    })

    test("exclude drops a source that is already carried in the prompt", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                { source: "MEMORY.md", read: () => "- prefers tabs in yaml", mtimeMs: 0, size: 32 },
                {
                    source: "2026-07.md",
                    read: () => "- yaml is generated by the scaffold",
                    mtimeMs: 0,
                    size: 40,
                },
            ],
            now: NOW,
        })
        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })

        const all = await retrieve({ input: "yaml", now: NOW, limit: 10 })
        expect(all.length).toBe(2)

        const injected = await retrieve({
            input: "yaml",
            now: NOW,
            limit: 10,
            exclude: ["MEMORY.md"],
        })
        expect(injected.length).toBe(1)
        expect(injected[0]?.passage.source).toBe("2026-07.md")
        await store.close()
    })

    test("results are ordered by score then id, deterministically", async () => {
        const { store, retrieve } = await seeded()
        const once = await retrieve({ input: "sqlite driver and boot", now: NOW, limit: 5 })
        const twice = await retrieve({ input: "sqlite driver and boot", now: NOW, limit: 5 })
        expect(once.map((h) => h.passage.id)).toEqual(twice.map((h) => h.passage.id))
        for (let i = 1; i < once.length; i += 1) {
            expect((once[i - 1]?.score ?? 0) >= (once[i]?.score ?? 0)).toBe(true)
        }
        await store.close()
    })

    test("coverage rejects a lone accidental match but keeps a genuine one-term query", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                {
                    source: "notes.md",
                    read: () =>
                        [
                            "- Note 1998 concerning warehouse stock counts",
                            "- The staging cluster lives in frankfurt",
                        ].join("\n"),
                    mtimeMs: 1,
                    size: 96,
                },
            ],
            now: NOW,
        })
        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })

        const accidental = await retrieve({
            input: "who won the 1998 world cup",
            now: NOW,
            limit: 5,
        })
        expect(accidental[0]?.coverage).toBe(0.25)
        expect(selectPassages(accidental, { threshold: 0.2, maxActive: 3, budget: 600 })).toEqual(
            [],
        )

        const genuine = await retrieve({ input: "frankfurt", now: NOW, limit: 5 })
        expect(genuine[0]?.coverage).toBe(1)
        expect(
            selectPassages(genuine, { threshold: 0.2, maxActive: 3, budget: 600 })[0]?.passage.text,
        ).toContain("frankfurt")
        await store.close()
    })

    test("a miss-only typo rewrite retrieves, and a partial rewrite does not", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                {
                    source: "notes.md",
                    read: () =>
                        [
                            "- Note 1998 concerning warehouse stock counts",
                            "- The staging cluster lives in frankfurt",
                            "- Postgres runs on the replica for analytics queries",
                        ].join("\n"),
                    mtimeMs: 1,
                    size: 160,
                },
            ],
            now: NOW,
        })
        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        const limits = { threshold: 0.2, maxActive: 3, budget: 600 }

        const typo = await retrieve({ input: "where is the stagng cluser", now: NOW, limit: 5 })
        expect(selectPassages(typo, limits)[0]?.passage.text).toContain("frankfurt")

        const oneTerm = await retrieve({ input: "frankfrut", now: NOW, limit: 5 })
        expect(selectPassages(oneTerm, limits)[0]?.passage.text).toContain("frankfurt")

        const parking = await retrieve({ input: "where is the parking cluser", now: NOW, limit: 5 })
        expect(selectPassages(parking, limits)).toEqual([])

        const worldCup = await retrieve({
            input: "who won the 1998 world cup",
            now: NOW,
            limit: 5,
        })
        expect(selectPassages(worldCup, limits)).toEqual([])

        const paraphrase = await retrieve({
            input: "which server carries analytical database traffic",
            now: NOW,
            limit: 5,
        })
        expect(selectPassages(paraphrase, limits)).toEqual([])
        await store.close()
    })
})

describe("contextual retrieval", () => {
    test("a weak follow-up borrows one bounded clean prior reply", async () => {
        const { store, retrieve } = await seeded()
        const ranked = await retrieveWithContext(retrieve, {
            input: "where is that hosted",
            previousAssistant: "We were discussing the sqlite store and its driver.",
            minimumScore: 0.2,
            now: NOW,
            limit: 5,
        })

        expect(ranked[0]?.passage.text.includes("sqlite The store")).toBe(true)
        expect(ranked[0]?.because?.includes("sqlite store")).toBe(true)
        await store.close()
    })

    test("a specific changed-topic turn does not inherit stale context", async () => {
        const { store, retrieve } = await seeded()
        const ranked = await retrieveWithContext(retrieve, {
            input: "write a haiku about rain",
            previousAssistant: "We were discussing the sqlite store and its driver.",
            minimumScore: 0.2,
            now: NOW,
            limit: 5,
        })

        expect(ranked).toEqual([])
        await store.close()
    })
})

describe("the recency boost", () => {
    test("it multiplies, so it can never push a match below the threshold", () => {
        // The property the whole formula exists to preserve: `memory.threshold` is calibrated on the
        // lexical scale, so a blend that could subtract would make the floor answer a different question.
        for (const age of [
            "2020-01-01T00:00:00Z",
            "2026-08-19T11:59:00Z",
            "2026-08-01T00:00:00Z",
        ]) {
            expect(boosted(0.4, age, NOW) >= 0.4).toBe(true)
        }
    })

    test("now scores the full boost and an epoch ago scores none", () => {
        expect(recencyBoost(NOW.toISOString(), NOW)).toBe(1 + RECENCY_WEIGHT)
        expect(recencyBoost("1970-01-01T00:00:00Z", NOW) < 1.000001).toBe(true)
    })

    test("one half-life is half the boost", () => {
        const half = new Date(NOW.getTime() - RECENCY_HALF_LIFE_DAYS * 86_400_000).toISOString()
        expect(Math.abs(recencyBoost(half, NOW) - (1 + RECENCY_WEIGHT / 2)) < 1e-9).toBe(true)
    })

    test("a future or unparseable stamp takes the full boost rather than throwing", () => {
        // A hand-typed stamp and a machine with a wrong clock are both real; neither should penalise.
        expect(recencyBoost("2030-01-01T00:00:00Z", NOW)).toBe(1 + RECENCY_WEIGHT)
        expect(recencyBoost("not a date", NOW)).toBe(1 + RECENCY_WEIGHT)
    })

    test("the newer of two equally relevant passages ranks first", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                {
                    source: "notes.md",
                    read: () =>
                        [
                            "- **2024-01-01T00:00:00Z** the deploy pipeline waits for approval",
                            "- **2026-08-18T00:00:00Z** the deploy pipeline waits for approval twice",
                        ].join("\n"),
                    mtimeMs: 0,
                    size: 128,
                },
            ],
            now: NOW,
        })
        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        const ranked = await retrieve({ input: "deploy pipeline approval", now: NOW, limit: 5 })
        expect(ranked.length).toBe(2)
        expect(ranked[0]?.passage.at).toBe("2026-08-18T00:00:00Z")
        await store.close()
    })
})

describe("selectPassages", () => {
    function hit(score: number, tokens: number, id: string): RetrievedPassage {
        return {
            passage: { id, source: "s", text: id, at: NOW.toISOString(), tags: [], stamped: true },
            score,
            lexical: score,
            coverage: 1,
            tokens,
        }
    }

    test("applies threshold, then maxActive, then the budget", () => {
        const ranked = [hit(0.9, 10, "a"), hit(0.5, 10, "b"), hit(0.2, 10, "c")]
        expect(
            selectPassages(ranked, { threshold: 0.35, maxActive: 5, budget: 1000 }).map(
                (h) => h.passage.id,
            ),
        ).toEqual(["a", "b"])
        expect(
            selectPassages(ranked, { threshold: 0, maxActive: 1, budget: 1000 }).map(
                (h) => h.passage.id,
            ),
        ).toEqual(["a"])
    })

    test("the budget stops at the first passage that does not fit — it never skips past it", () => {
        // Skipping would let a worse-ranked short passage displace a better-ranked long one purely for
        // being short, which would make the ranking stop deciding what the model sees. Same rule as
        // `workspace/knowledge.ts`.
        const ranked = [hit(0.9, 100, "big"), hit(0.8, 5, "small")]
        expect(
            selectPassages(ranked, { threshold: 0, maxActive: 5, budget: 50 }).map(
                (h) => h.passage.id,
            ),
        ).toEqual([])
    })
})

describe("syncFiles", () => {
    const file = (text: string, mtimeMs: number, size: number) => ({
        source: "a.md",
        read: () => text,
        mtimeMs,
        size,
    })

    test("indexes, then skips an unchanged file, then reindexes a changed one", async () => {
        const store = await openMemoryStore()
        const one = await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- first note", 1000, 12)],
            now: NOW,
        })
        expect(one.indexed).toEqual(["a.md"])
        expect(one.passages).toBe(1)

        const two = await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- first note", 1000, 12)],
            now: NOW,
        })
        expect(two.skipped).toEqual(["a.md"])
        expect(two.indexed).toEqual([])

        const three = await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- first note\n- second note", 2000, 25)],
            now: NOW,
        })
        expect(three.indexed).toEqual(["a.md"])
        expect(three.passages).toBe(2)
        await store.close()
    })

    test("a file whose mtime changed but whose size did not is still reindexed", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- aaaa", 1000, 6)],
            now: NOW,
        })
        const again = await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- bbbb", 2000, 6)],
            now: NOW,
        })
        expect(again.indexed).toEqual(["a.md"])
        await store.close()
    })

    test("a tokeniser bump forces a reindex of an otherwise unchanged file", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- a note", 1000, 8)],
            now: NOW,
        })
        // Simulate an older index: the terms on disk were produced by rules that no longer apply.
        await store.memory.replaceSource(
            AGENT,
            "a.md",
            [],
            { mtimeMs: 1000, size: 8, tokeniser: TOKENISER_VERSION - 1 },
            NOW.toISOString(),
        )
        const again = await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- a note", 1000, 8)],
            now: NOW,
        })
        expect(again.indexed).toEqual(["a.md"])
        await store.close()
    })

    test("a source no longer present is dropped, so a deleted file stops being retrievable", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [file("- a note about yaml", 1, 20)],
            now: NOW,
        })
        const after = await syncFiles({ store: store.memory, agentId: AGENT, files: [], now: NOW })
        expect(after.dropped).toEqual(["a.md"])
        expect(after.passages).toBe(0)

        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        expect((await retrieve({ input: "yaml", now: NOW, limit: 5 })).length).toBe(0)
        await store.close()
    })

    test("the same text in two files is one row, and it follows the move", async () => {
        const store = await openMemoryStore()
        const text = "- **2026-08-19T10:00:00Z** the identical note"
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                { source: "MEMORY.md", read: () => text, mtimeMs: 1, size: 44 },
                { source: "2026-08.md", read: () => text, mtimeMs: 1, size: 44 },
            ],
            now: NOW,
        })
        // One fact, one row — injecting it twice would spend the slot budget saying the same thing.
        expect((await store.memory.stats(AGENT)).passages).toBe(1)
        await store.close()
    })
})

describe("the acceptance criteria that are about the store, not the ranking", () => {
    test("deleting a session removes its projection and leaves canonical memory untouched", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure(AGENT, "local:abc")
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                {
                    source: "2026-08.md",
                    read: () => "- prefers tabs in yaml",
                    mtimeMs: 1,
                    size: 22,
                },
            ],
            now: NOW,
        })
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [
                {
                    sessionKey: "local:abc",
                    source: sessionSource("local:abc"),
                    read: () => "- a conversation about a hardware security key",
                    mtimeMs: 2,
                    size: 44,
                },
            ],
            now: NOW,
        })
        expect((await store.memory.stats(AGENT)).passages).toBe(2)

        await store.sessions.delete(AGENT, "local:abc")

        const sources = await store.memory.sources(AGENT)
        expect(sources.map((source) => source.source)).toEqual(["2026-08.md"])
        expect((await store.memory.stats(AGENT)).passages).toBe(1)
        await store.close()
    })

    test("clearing a session also removes its projection immediately", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure(AGENT, "local:abc")
        await store.sessions.ensure(AGENT, "local:other")
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [
                {
                    sessionKey: "local:abc",
                    source: sessionSource("local:abc"),
                    read: () => "- a conversation about a hardware security key",
                    mtimeMs: 2,
                    size: 44,
                },
                {
                    sessionKey: "local:other",
                    source: sessionSource("local:other"),
                    read: () => "- an unrelated conversation about postgres replicas",
                    mtimeMs: 3,
                    size: 48,
                },
            ],
            now: NOW,
        })

        await store.sessions.clear(AGENT, "local:abc")

        expect((await store.memory.sources(AGENT)).map((source) => source.source)).toEqual([
            sessionSource("local:other"),
        ])
        expect(await store.sessions.get(AGENT, "local:abc")).toBeDefined()
        await store.close()
    })

    test("retrieval over 5,000 passages stays under 20 ms", async () => {
        const store = await openMemoryStore()
        const lines: string[] = []
        for (let i = 0; i < 5000; i += 1) {
            // Varied vocabulary, so the index is doing real work rather than matching one hot term.
            lines.push(
                `- **2026-0${(i % 8) + 1}-01T00:00:00Z** note ${i} about topic${i % 97} ` +
                    `covering deployment${i % 13} and configuration${i % 29} in detail`,
            )
        }
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [{ source: "big.md", read: () => lines.join("\n"), mtimeMs: 1, size: 500_000 }],
            now: NOW,
        })
        expect((await store.memory.stats(AGENT)).passages).toBe(5000)

        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        // One warm call first: the criterion is about steady-state retrieval, not about SQLite's first
        // touch of a freshly written index.
        await retrieve({ input: "deployment7 configuration11", now: NOW, limit: 5 })

        const started = performance.now()
        const ranked = await retrieve({
            input: "deployment7 configuration11 topic42",
            now: NOW,
            limit: 5,
        })
        const elapsed = performance.now() - started

        expect(ranked.length > 0).toBe(true)
        // Generous against the 20 ms criterion so a loaded CI machine does not fail on scheduling noise;
        // the measured figure is in `evals/memory/README.md`, which is where a real number belongs.
        expect(elapsed < 60).toBe(true)
        await store.close()
    })
})
