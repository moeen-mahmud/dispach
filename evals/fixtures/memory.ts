/**
 * The memory retrieval fixture: a corpus, and questions with a *stated expectation*.
 *
 * The expectation is the point. Latency can be measured without judgement, but a threshold is a
 * judgement about which partial matches count — so each question says whether a person would call the
 * retrieval correct, and the eval reports where the shipped default disagrees. Without that half the
 * eval only demonstrates that retrieval runs.
 *
 * Two properties of the corpus are load-bearing rather than decorative:
 *
 * 1. **The notes are distinct.** `discriminating()` drops any query term present in more than half the
 *    corpus, so a corpus of near-identical notes has no informative vocabulary and retrieves nothing.
 *    A test fixture hit exactly that and it read as a broken retriever.
 * 2. **It is padded to a realistic size.** The same query ranks differently over ten notes and over
 *    five thousand, because document frequency decides which terms count toward the normalisation. A
 *    ten-note measurement is not evidence about the corpus a real agent accumulates.
 */

/** Topics the padding draws from, so the filler has vocabulary rather than one repeated sentence. */
export const PADDING_TOPICS: readonly string[] = [
    "invoice reconciliation",
    "container registry mirrors",
    "quarterly board reporting",
    "seed data snapshots",
    "on-call rotation handover",
    "font licensing renewals",
    "warehouse stock counts",
    "translation review cycles",
]

/** The notes the questions are actually about. Each states one durable fact, distinctly. */
const NOTES: readonly string[] = [
    "The deploy pipeline waits for a manual approval gate before production.",
    "Postgres runs on the replica for analytics queries, never on the primary.",
    "Commit messages are lowercase and imperative, with no trailing period.",
    "The staging cluster lives in frankfurt and mirrors production weekly.",
    "Backups are verified by restoring them into a scratch project every month.",
    "The mobile build signs with a hardware key kept in the office safe.",
    "Support tickets escalate to the on-call engineer after four hours.",
    "The changelog is generated from merge commits, so squash titles matter.",
    "Load tests run against a seeded snapshot rather than live data.",
    "Secrets rotate on the first working day of each quarter.",
    "Design review happens before implementation, never after a branch opens.",
    "The API gateway rate-limits per token rather than per source address.",
]

export interface MemoryProbe {
    readonly question: string
    readonly category:
        | "direct"
        | "paraphrase"
        | "followup"
        | "metadata"
        | "typo"
        | "abstention"
        | "unsupported"
    /** Clean prior reply available to automatic recall. Present only for conversational probes. */
    readonly previousAssistant?: string
    /**
     * `hit` — the corpus answers this and a turn should inject it.
     * `miss` — nothing in the corpus is relevant and a turn should inject nothing.
     * `related` — a passage is topically relevant but does not answer the question. Reported
     * separately because retrieval cannot prove answerability without becoming a second model.
     */
    readonly expect: "hit" | "miss" | "related"
    /** A substring of the note that ought to be retrieved. Absent only for a `miss`. */
    readonly answer?: string
}

/**
 * Questions phrased the way a person asks them, not as keyword queries.
 *
 * The interesting ones are the partial matches — "how does the deploy approval work" shares two terms
 * with its answer and not the third — because that is exactly where the threshold decides, and where
 * `0.35` and `0.20` disagree. The `miss` questions are as important: a retriever that volunteers
 * something on every turn stops being informative, and a floor that admits everything is not a floor.
 */
export const MEMORY_QUESTIONS: readonly MemoryProbe[] = [
    {
        question: "how does the deploy approval work",
        category: "direct",
        expect: "hit",
        answer: "manual approval gate",
    },
    {
        question: "which database do analytics queries hit",
        category: "direct",
        expect: "hit",
        answer: "replica",
    },
    {
        question: "what style are commit messages",
        category: "direct",
        expect: "hit",
        answer: "lowercase and imperative",
    },
    { question: "where does staging live", category: "direct", expect: "hit", answer: "frankfurt" },
    {
        question: "how often are backups verified",
        category: "direct",
        expect: "hit",
        answer: "every month",
    },
    {
        question: "how is the mobile build signed",
        category: "direct",
        expect: "hit",
        answer: "hardware key",
    },
    {
        question: "when do support tickets escalate",
        category: "direct",
        expect: "hit",
        answer: "four hours",
    },
    {
        question: "how is the changelog produced",
        category: "direct",
        expect: "hit",
        answer: "merge commits",
    },
    {
        question: "what data do load tests use",
        category: "direct",
        expect: "hit",
        answer: "seeded snapshot",
    },
    {
        question: "how often do secrets rotate",
        category: "direct",
        expect: "hit",
        answer: "each quarter",
    },
    {
        question: "when does design review happen",
        category: "direct",
        expect: "hit",
        answer: "before implementation",
    },
    {
        question: "how does rate limiting work",
        category: "direct",
        expect: "hit",
        answer: "per token",
    },
    {
        question: "frankfurt",
        category: "direct",
        expect: "hit",
        answer: "frankfurt",
    },
    {
        question: "which server carries analytical database traffic",
        category: "paraphrase",
        expect: "hit",
        answer: "replica",
    },
    {
        question: "where is that one hosted",
        category: "followup",
        previousAssistant: "We were discussing the staging cluster.",
        expect: "hit",
        answer: "frankfurt",
    },
    {
        question: "what is the style rule",
        category: "metadata",
        expect: "hit",
        answer: "lowercase and imperative",
    },
    {
        question: "where is the stagng cluser",
        category: "typo",
        expect: "hit",
        answer: "frankfurt",
    },
    {
        question: "frankfrut",
        category: "typo",
        expect: "hit",
        answer: "frankfurt",
    },
    { question: "who won the 1998 world cup", category: "abstention", expect: "miss" },
    { question: "what is the capital of peru", category: "abstention", expect: "miss" },
    {
        question: "please write me a haiku about rain",
        category: "abstention",
        previousAssistant: "The staging cluster lives in frankfurt.",
        expect: "miss",
    },
    { question: "what time is my dentist appointment", category: "abstention", expect: "miss" },
    {
        question: "where is the parking cluser",
        category: "abstention",
        expect: "miss",
    },
]

/**
 * The corpus as one markdown file: the real notes, then padding to `total` passages.
 *
 * Stamps are spread across months so the recency boost has something to order by — with one date the
 * boost is a constant and reorders nothing, which would make the eval silent about it.
 */
export function memoryCorpus(total: number): string {
    const lines: string[] = []
    for (const [i, note] of NOTES.entries()) {
        const month = `${(i % 8) + 1}`.padStart(2, "0")
        const tag = i === 2 ? "style" : i === 9 ? "security" : i === 11 ? "gateway" : "project"
        lines.push(`- **2026-${month}-1${i % 9}T10:00:00Z** _(${tag})_ ${note}`)
    }
    let n = 0
    while (lines.length < total) {
        const topic = PADDING_TOPICS[n % PADDING_TOPICS.length]
        const month = `${(n % 8) + 1}`.padStart(2, "0")
        lines.push(
            `- **2026-${month}-0${(n % 9) + 1}T10:00:00Z** _(filler)_ ` +
                `Note ${n} concerning ${topic}: step ${n % 37} of the ${topic} procedure ` +
                `depends on schedule ${n % 53} and owner ${n % 29}.`,
        )
        n += 1
    }
    return lines.join("\n")
}
