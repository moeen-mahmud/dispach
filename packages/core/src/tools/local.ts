/**
 * Built-in tools. No network, no provider, no configuration.
 *
 * They exist because a tool layer with nothing in it cannot be exercised, and because the two
 * things every agent asks for first are "what is the date" and "remember this". Everything else is
 * a provider's job.
 *
 * They are opt-in via `tools.local`, never registered implicitly. A tool nobody asked for still
 * costs catalogue tokens and still widens the space the model routes over, which is the one thing
 * that reliably degrades a small model.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
    artifactNotFound,
    artifactUnavailable,
    phaseNotAvailable,
    phaseUnknown,
    workspaceNotEditable,
} from "../errors.ts"
import { PHASE_SET } from "../loop/phases.ts"
import { appendNote, injectedTokens } from "../memory/writer.ts"
import type { Tool, ToolContext, ToolProvider } from "./types.ts"

export const LOCAL_PROVIDER_ID = "local"

/**
 * Where a note goes, relative to the agent's directory.
 *
 * Matches `memory.dir`'s default so that the memory subsystem, when it arrives, indexes what is
 * already here rather than a second location nobody looks at.
 */
export const MEMORY_DIR = "memory"
export const MEMORY_FILE = "notes.md"

const now: Tool = {
    spec: {
        slug: "now",
        provider: LOCAL_PROVIDER_ID,
        summary: "Reports the current date and time.",
        whenToUse:
            "you need today's date or the current time — including to work out what 'tomorrow' or 'in three hours' means",
        whenNotToUse:
            "the person already told you the date or time; use theirs rather than replacing it with the clock",
        mutating: false,
        tags: ["read", "time"],
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    type: "string",
                    description: "IANA name such as Europe/London. Defaults to UTC.",
                },
                format: {
                    type: "string",
                    description: "iso for a machine-readable timestamp, human for a readable one",
                    enum: ["iso", "human"],
                    default: "iso",
                },
            },
        },
    },
    handler(args, context) {
        const at = context.now()
        const zone =
            typeof args.timezone === "string" && args.timezone !== "" ? args.timezone : "UTC"

        if (args.format === "human") {
            // A bad IANA name throws here rather than silently falling back to UTC: a reply that
            // states the time in the wrong zone with no hint of it is worse than a failed call.
            const formatted = new Intl.DateTimeFormat("en-GB", {
                dateStyle: "full",
                timeStyle: "short",
                timeZone: zone,
            }).format(at)
            return `${formatted} (${zone})`
        }

        if (zone === "UTC") return at.toISOString()
        return `${isoInZone(at, zone)} (${zone})`
    },
}

/**
 * ISO-shaped, in a named zone. `toISOString` is UTC-only and `Intl` will not emit ISO, so the
 * parts are assembled by hand — offset included, because a local timestamp without one is
 * ambiguous exactly when it matters.
 */
function isoInZone(at: Date, zone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "longOffset",
    }).formatToParts(at)

    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
    const offset = get("timeZoneName").replace("GMT", "")
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset === "" ? "Z" : offset}`
}

/**
 * Writes a note to a file, and nothing more.
 *
 * The first version of this returned "NOT SAVED — this build has no memory store", which was
 * truthful and a trap: asked to save something, a real model retried until the step budget ran out.
 * Measured against DeepSeek — three attempts, no reply, an honest `max_steps` failure. A mutating
 * tool that can never succeed is not a mutating tool, it is a loop.
 *
 * So it appends to a markdown file under the agent's own directory, which is exactly where the
 * memory subsystem will look: files are canonical for memory, and the retriever indexes this
 * directory when it lands. Write-only until then. That is a missing half, not a lie — the note is
 * genuinely on disk, and the observation says where.
 */
const memoryWrite: Tool = {
    spec: {
        slug: "memory_write",
        provider: LOCAL_PROVIDER_ID,
        summary: "Saves a short note for later recall.",
        whenToUse:
            "the person tells you something durable about themselves or their work that later conversations should know",
        whenNotToUse:
            "for anything already in this conversation, for secrets or credentials, or to store your own reasoning",
        mutating: true,
        tags: ["write", "memory"],
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "The note, in one or two sentences." },
                tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
            },
            required: ["text"],
        },
    },
    async handler(args, context) {
        const text = typeof args.text === "string" ? args.text.trim() : ""
        const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag)) : []
        const stamped = context.now().toISOString()
        const labels = tags.length === 0 ? "" : ` _(${tags.join(", ")})_`
        const line = `\n- **${stamped}**${labels} ${text}\n`

        const target = context.writeTarget

        // A workspace that declares a memory file and makes it read-only is refused out loud. The
        // tempting alternative — quietly falling back to the default file — would put the note
        // somewhere the agent's own context never reads from, so the model would be told it saved
        // something it will never see again. `editable` is enforced, not advisory.
        if (target?.mode === "refused") {
            throw workspaceNotEditable(target.name, target.reason ?? "none")
        }

        if (target?.path !== undefined) {
            // Eviction needs both a ceiling and somewhere to put what it displaces. With either
            // missing this degrades to a plain append — the pre-Phase-6 behaviour, which is honest
            // about what it does rather than dropping notes because nowhere was configured to keep
            // them.
            // `eviction: oldest` is the author's declaration that this file accumulates notes and may
            // be trimmed. Without it the append still happens and the shortfall is still reported — the
            // agent is simply not allowed to delete lines out of a file nobody said that about.
            if (
                target.budget !== undefined &&
                context.memoryDir !== undefined &&
                target.eviction === "oldest"
            ) {
                const result = await appendNote({
                    path: target.path,
                    name: target.name,
                    budget: target.budget,
                    archiveDir: context.memoryDir,
                    text,
                    tags,
                    now: context.now(),
                })
                // The shortfall is surfaced to the model, not swallowed. It means the *next load* will
                // fail on this file, and the model is the only participant here who can stop writing
                // to it — telling it "saved" and letting boot fail later is the silent-failure shape
                // hard rule 8 forbids.
                if (result.shortfall !== undefined) {
                    return `Saved to ${result.file}, but it is still over budget: ${result.shortfall}. Ask the person to raise the budget or shorten the file — the agent will not load until they do.`
                }
                if (result.evicted === 0) return `Saved to ${result.file}.`
                return `Saved to ${result.file}. Moved ${result.evicted} older ${result.evicted === 1 ? "note" : "notes"} into ${result.archives.join(", ")}, still searchable.`
            }

            await appendFile(target.path, line, "utf8")
            // Over budget with no eviction declared is reported here, because the thing that fails is
            // the *next load* — and by then nobody is looking at this observation. Hard rule 8: the
            // agent is told now, while it can stop writing to the file.
            if (target.budget !== undefined) {
                const over = injectedTokens(await readFile(target.path, "utf8")) - target.budget
                if (over > 0) {
                    return `Saved to ${target.name}, which is now ${over} tokens over its ${target.budget}-token budget. The agent will not load until that is fixed: add \`eviction: oldest\` to its frontmatter so older notes move to the memory directory, or raise the budget.`
                }
            }
            // Named rather than described, because the model sees this file's contents in slot 3 on
            // the next turn and the two should be recognisably the same thing.
            return `Saved to ${target.name}.`
        }

        // No workspace declared anywhere to write. The agent's own directory it is — the same place
        // the memory subsystem will index when it lands.
        const dir = join(context.dir, MEMORY_DIR)
        await mkdir(dir, { recursive: true })
        await appendFile(join(dir, MEMORY_FILE), line, "utf8")

        return `Saved to ${MEMORY_DIR}/${MEMORY_FILE}.`
    },
}

/**
 * How much of a displaced observation one call returns.
 *
 * Sized against `limits.observationMaxTokens`, whose default is 2,000, and deliberately under it. The
 * lesson is recorded for `config_read`: an observation that does not fit the budget gets middle-cut by
 * the executor, and a middle-cut reference document makes a model read it again — 2,766 tokens against
 * a 2,000 budget cost one real session three reads and 8,040 output tokens to change one line. A tool
 * whose entire job is retrieving something large has to page rather than hope.
 */
const ARTIFACT_PAGE_TOKENS = 1200

/** Characters per token, matching `estimateTokens`. Approximate is fine; over-running the budget is not. */
const ARTIFACT_PAGE_CHARS = ARTIFACT_PAGE_TOKENS * 3

/**
 * Reads back what the compaction ladder displaced.
 *
 * The pointer left in history carries the id, so this is a one-hop follow rather than a search — the
 * model is never asked to guess an id, which is why there is no `list` argument and no way to browse.
 * `from` exists because the alternative is a tool that promises a large observation and returns a
 * truncation of it; it defaults to the beginning, so the common call is still one argument.
 */
const artifactRead: Tool = {
    spec: {
        slug: "artifact_read",
        provider: LOCAL_PROVIDER_ID,
        summary: "Reads back a tool result that compaction replaced with a pointer.",
        whenToUse:
            "a compaction marker in this conversation names an id, and you need the tool result it replaced",
        whenNotToUse:
            "for anything still written out in the conversation, or to explore — every id comes from a marker, so there is nothing to browse",
        mutating: false,
        tags: ["read", "context"],
        parameters: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    // No example value, deliberately. A placeholder in a prompt is read as an
                    // instruction: the NLT preamble showed `field: value` once and qwen3.5:9b wrote
                    // `value: <the value>`, scoring 27% against native's 92%. A live deepseek session
                    // kept insisting the id "cannot be guessed" with a marker in front of it — the same
                    // shape, because what it had been shown was an ellipsis.
                    description:
                        "The id printed inside the compaction marker, copied character for character.",
                },
                from: {
                    type: "integer",
                    description:
                        "Character offset to continue from. Omit for the beginning; a truncated reply says the number to pass.",
                },
            },
            required: ["id"],
        },
    },
    async handler(args, context) {
        const id = typeof args.id === "string" ? args.id.trim() : ""
        const from = typeof args.from === "number" && args.from > 0 ? Math.floor(args.from) : 0

        if (context.readArtifact === undefined) throw artifactUnavailable()
        const artifact = await context.readArtifact(id)
        if (artifact === undefined) throw artifactNotFound(id)

        const what = artifact.slug === undefined ? "observation" : `${artifact.slug} observation`
        const slice = artifact.content.slice(from, from + ARTIFACT_PAGE_CHARS)
        const end = from + slice.length
        const header = `Compacted ${what}, ${artifact.tokens} tokens${from === 0 ? "" : `, from character ${from}`}:`

        if (end >= artifact.content.length) return `${header}\n${slice}`
        // The number to pass next, stated rather than left to arithmetic. A model that has to compute
        // an offset gets it wrong and then reads the same page twice.
        return `${header}\n${slice}\n\n[cut here — ${artifact.content.length - end} characters remain; continue with artifact_read(id, from: ${end})]`
    },
}

/**
 * Move the session to another phase.
 *
 * Built per agent rather than declared as a constant, because the phase *names* belong in the schema:
 * an `enum` is refused by the coercion layer before the handler runs, and a model that has to guess a
 * phase name from prose gets it wrong in a way that costs a step. The same reasoning puts the other
 * phases and what they add into the description — a model told nothing about `act` reports that it
 * cannot write, which is decision 4.53's failure. Counts rather than slugs, or the constraint the phase
 * exists to impose is undone by the sentence explaining it.
 *
 * Added per turn through `withTools`, the same seam a skill's script tools use, and rebuilt whenever
 * the phase changes — because `current` and `others` are facts about the phase, not about the agent.
 * `mutating` is
 * **false**: it changes what the agent may do, not anything in the world, and marking it true would
 * serialise it behind a write slot and suppress its retry for no gain.
 */
export function phaseSetTool(init: {
    readonly phases: readonly string[]
    readonly current: string
    readonly others: readonly { readonly name: string; readonly adds: number }[]
}): Tool {
    const others =
        init.others.length === 0
            ? ""
            : ` Other phases: ${init.others
                  .map(
                      (other) =>
                          `${other.name} (adds ${other.adds} tool${other.adds === 1 ? "" : "s"})`,
                  )
                  .join(", ")}.`
    return {
        spec: {
            slug: PHASE_SET,
            provider: LOCAL_PROVIDER_ID,
            // The *current* phase is named here rather than in slot 2, and that placement is load-bearing:
            // a phase is per session and changes mid-turn, while slot 2 is memoised per agent and frozen
            // at first use because it sits in the cache-stable prefix. Slot 1 is already rebuilt per
            // phase, so this is the one place the fact cannot go stale or leak between sessions.
            summary: `You are in the "${init.current}" phase. This moves to another phase, which changes the tools you have.${others}`,
            whenToUse:
                "the tools you need are not in this phase — check what the other phases add and move to the one that has them",
            // Written against a measured failure, not from taste. On the first `eval:phases` run the
            // triage arm lost 12.5pp against the full catalogue, and every extra failure was in the
            // `restraint` group — tasks whose correct answer is to call nothing. One of them was a
            // literal `phase_set` call, which names the mechanism: being told you are in a restricted
            // phase with more tools elsewhere reads as an instruction to move. So the refusal case is
            // stated first and concretely, because "when not to" is the half a model skims.
            whenNotToUse:
                "most turns — you already have the tool you need, the person only wants an answer or a draft, or the right response is to call no tool at all. Being in a narrow phase is not a reason to move out of it",
            mutating: false,
            tags: ["read", "control"],
            parameters: {
                type: "object",
                properties: {
                    to: {
                        type: "string",
                        description: "The phase to move to.",
                        enum: [...init.phases],
                    },
                },
                required: ["to"],
            },
        },
        async handler(args, context) {
            const to = typeof args.to === "string" ? args.to.trim() : ""
            if (!init.phases.includes(to)) throw phaseUnknown(to, init.phases)
            if (context.setPhase === undefined) throw phaseNotAvailable()
            if (to === init.current) return `Already in ${to}. Nothing changed.`
            await context.setPhase(to)
            // Names the effect rather than confirming the call: the tools change *now*, in this turn,
            // and a model that does not know that waits for the next one.
            return `Now in ${to}. Your tools have changed — the catalogue for this phase is in effect from your next reply in this turn.`
        },
    }
}

const LOCAL_TOOLS: readonly Tool[] = [now, memoryWrite, artifactRead]

/**
 * Slugs a manifest may name in `tools.local`.
 *
 * `phase_set` is deliberately absent: it is registered by the runtime when a manifest declares more than
 * one phase, and a hand-pinned one on a single-phase agent would be a tool with nowhere to go.
 */
export const LOCAL_TOOL_SLUGS: readonly string[] = LOCAL_TOOLS.map((tool) => tool.spec.slug)

export function localProvider(): ToolProvider {
    return {
        id: LOCAL_PROVIDER_ID,
        resolve(slugs) {
            const wanted = new Set(slugs.map((slug) => slug.toLowerCase().replace(/[\s_.-]+/g, "")))
            return Promise.resolve(
                LOCAL_TOOLS.filter((tool) =>
                    wanted.has(tool.spec.slug.toLowerCase().replace(/[\s_.-]+/g, "")),
                ),
            )
        },
        list() {
            return Promise.resolve(LOCAL_TOOL_SLUGS)
        },
    }
}

/** For tests and for tools that need a context without a turn behind them. */
export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        agentId: overrides.agentId ?? "agent",
        sessionKey: overrides.sessionKey ?? "local:default",
        turnId: overrides.turnId ?? "t_none",
        dir: overrides.dir ?? process.cwd(),
        signal: overrides.signal ?? new AbortController().signal,
        deadlineMs: overrides.deadlineMs ?? 120_000,
        now: overrides.now ?? (() => new Date()),
        ...(overrides.writeTarget === undefined ? {} : { writeTarget: overrides.writeTarget }),
        // Listed explicitly, and it was dropped once by being absent from this literal — the fourth
        // time that has happened in this repo (`apiKeyEnv`, `ChatMessage.toolCalls`,
        // `TurnInput.skills`). A hand-built object is not excess-property-checked, so a field the
        // funnel does not name is lost with no type error. Anything added to `ToolContext` belongs here
        // and wants a test that reads the value out at the far end.
        ...(overrides.readArtifact === undefined ? {} : { readArtifact: overrides.readArtifact }),
        ...(overrides.setPhase === undefined ? {} : { setPhase: overrides.setPhase }),
        ...(overrides.memoryDir === undefined ? {} : { memoryDir: overrides.memoryDir }),
    }
}
