/**
 * The wire vocabulary, and nothing else — the part of core a browser can carry.
 *
 * ## The measurement that made this necessary
 *
 * `packages/client` needs exactly two runtime values from core: `EVENT_TYPES`, so the frame mapper
 * discriminates on the real catalogue rather than a name pattern (decision 11.180), and `parseSSE`,
 * so there is one SSE parser in the tree rather than two. It imported both from core's barrel, and
 * a barrel import is an import of *everything*:
 *
 * | Imported from | Browser bundle |
 * | --- | --- |
 * | `@dispach/core` — the barrel | **1.18 MB**, 159 modules |
 * | the two modules directly | **2.82 KB** |
 *
 * Four hundred times, from one line. Zod appears 550 times in that bundle and the YAML parser 149 —
 * a schema validator and a manifest parser shipped to a browser that can never load a manifest. It
 * cost nothing while the only consumer was a Node process; `packages/web` is the consumer that
 * makes it a defect, because the whole JS budget would be spent before a single component existed.
 *
 * ## Why a subpath and not deep imports
 *
 * `@dispach/core/events/types.ts` would work and would make every internal path part of the public
 * surface — a consumer reaching past the entry point is a consumer that breaks when a file moves.
 * A subpath says the thing that is actually true: **this** is the set a non-Node consumer needs, it
 * is small on purpose, and growing it is a decision rather than an accident.
 *
 * ## The rule this entry has to keep
 *
 * Nothing re-exported here may reach a `node:` builtin, a schema validator or a YAML parser,
 * directly or transitively. That is not a style preference — it is the entire point, and it is
 * asserted by a bundle-size test rather than trusted, because the failure mode is silent: adding
 * one convenient export would restore the 1.18 MB with no error anywhere and nothing but a slower
 * page to show for it.
 */

export type {
    AnyEvent,
    EventContext,
    EventDataMap,
    EventEnvelope,
    EventType,
    TurnEndReason,
} from "../events/types.ts"
export { EVENT_TYPES } from "../events/types.ts"
/**
 * `endNote` and `endedBadly`, because the browser is the **fourth** caller of a formatter that
 * exists precisely so there is only one.
 *
 * `turn.end` carries `reason` and no sentence, and `CLAUDE.md` records why: the CLI, the plain path
 * and the channel path all needed the same words, and three copies is how a turn stopped by its
 * step budget came to be reported three different ways — including not at all, which delivered
 * *nothing* to Telegram. A UI composing its own sentence from `reason` would be the fourth version.
 * `turn-end.ts` imports one type and nothing else, so it costs the browser bundle nothing.
 */
export { type EndContext, endedBadly, endNote } from "../loop/turn-end.ts"
export { parseSSE } from "../model/sse.ts"
/**
 * The stream filter, because **the wire carries unfiltered chunks and every client must filter.**
 *
 * Found by streaming a real turn into the browser's reducer and reading `ACTION: now / format:
 * human / END` in a chat bubble. `proseOf`'s own docstring says "a live session shows only the
 * narration — the stream filter strips the block as it arrives", which is true of the *CLI*:
 * `agent.streamFilter()` is applied at `cli/src/run.ts:821`, on that renderer's own path. Nothing
 * strips it on the way to SSE, so `model.chunk` deltas are the model's raw output and a second
 * consumer has to do the same work.
 *
 * That is defensible on the wire — a stream nobody has filtered is the one a debugger wants, and
 * the block is what the *next* model call sees, so removing it upstream would make the firehose
 * disagree with the stored row. But it makes filtering a client's job, and the shape here is no
 * accident: `push` per chunk, `endStep` at `model.result`, `end` at `turn.end` are exactly the
 * boundaries a transcript already has.
 *
 * `@dispach/client` is arguably the better home, since every SSE consumer goes through it — but
 * `tokens()` yielding filtered text would change that package's contract and needs the dialect,
 * which costs a request. Left as its own decision rather than smuggled in here.
 */
export { passThroughFilter, type StreamFilter } from "../tools/dialect/dialect.ts"
export { createNltStreamFilter } from "../tools/dialect/nlt.ts"
