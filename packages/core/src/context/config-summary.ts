/**
 * Slot 2: what this agent is, as a fact it always has rather than one it must go and look up.
 *
 * ## The failure this exists to prevent
 *
 * An agent was asked to put itself on Telegram. It had `config_set` pinned, `config_set` in
 * `policy.allow`, a `channels` block sitting commented out in its own manifest, and a shipped
 * Telegram transport in the runtime hosting it. It suggested Composio. Told it could use its own
 * configuration, it **started writing a Telegram bridge**.
 *
 * Nothing was broken. Every piece worked and the model never used any of it, because knowing your
 * own configuration was a *choice*: realise you have one, decide to read it, then act. That is
 * two-hop reasoning, which is the shape decision 4.7 refuses for tool discovery and which fails for
 * exactly the same reason here — worse, in fact, since a model that does not know a setting exists
 * has no reason to go looking for it. The catalogue is injected; the workspace is injected; the
 * configuration was not.
 *
 * ## What it is and is not
 *
 * A **summary**, never the manifest. `config_read` returning the whole file measured 2,766 tokens
 * against a 2,000-token observation budget and was middle-cut on every call; this is paid on every
 * turn of every session forever, so it is roughly a tenth of that. It answers "what am I, and how
 * would I change it" — the full settable list with current values stays one `config_read` away,
 * which is the right hop to keep: the *fact* costs nothing, the *detail* is asked for.
 *
 * Byte-stable for the lifetime of the process, because configuration is fixed until restart. That
 * is what lets it sit ahead of the cache breakpoint at no cost.
 */

import type { AgentManifest } from "../manifest/schema.ts"

/**
 * The slug that makes the difference between "here is how to change this" and "here is who to ask".
 *
 * A string literal in core for a tool that lives in `tools-system`, which is a soft coupling and the
 * right trade: the alternative is a block that tells an agent to use a tool it does not have, which
 * is the failure mode this file exists to remove, pointed the other way.
 */
const CONFIG_SET = "config_set"

export interface ConfigSummaryInput {
    readonly manifest: AgentManifest
    /** Absolute path to `agent.yaml`. The agent is told where its settings live. */
    readonly path: string
    /** Resolved context window, after capability resolution. */
    readonly window: number
    /** Slugs actually in the catalogue, so the closing paragraph is true of *this* agent. */
    readonly tools: readonly string[]
    /** Provider ids in manifest order. */
    readonly providers: readonly string[]
    /**
     * Whether channels are actually *started* in this process, not merely configured.
     *
     * The distinction is the whole of a second failure. Slot 2 described the manifest, so an agent
     * running under `run` — where `startChannels` is false — was told "channels: tg (telegram)" and
     * concluded, correctly from what it had been given and wrongly in fact, that the Telegram
     * runtime must have died. It then reported that nothing was listening on port 7420 and that no
     * process was running, *from inside the process*. Describing configuration where the reader
     * needs state is its own kind of lie.
     */
    readonly channelsStarted: boolean
    /**
     * Whether the *scheduler* is running in this process, not whether schedules are configured.
     *
     * The same distinction `channelsStarted` carries, and it has to be stated separately because
     * schedules are reconciled under `run` as well — so "this agent has three schedules" is true of
     * the manifest and says nothing about whether anything will fire them. An agent told it has a
     * morning brief, in a process with no timer, would reasonably report that its brief is set up.
     */
    readonly schedulerStarted: boolean
    /**
     * The generated compaction notice, when `context.compactionNotice` is on.
     *
     * Passed in rather than rendered here: whether `artifact_read` is in the catalogue is the notice's
     * one variable, and `tools` above already carries that — but the *decision* belongs to whoever
     * read the manifest flag, and duplicating it here would put the switch in two places.
     */
    readonly compactionNotice?: string
    /**
     * The catalogue's skill **names**, or `undefined` when no skills block is configured.
     *
     * Zero and absent are different rows on purpose. A configured directory that happens to be empty is a
     * switch that is on with nothing behind it — the agent can be told to expect procedures — while no
     * block at all is a concept the agent does not have. A missing row would read as the second in both
     * cases, which is the mistake decision 5.19 exists to prevent.
     *
     * Names rather than a count, and that was a measured defect rather than a nicety. The row said "1
     * available" and nothing more, so a real agent asked "what skills do you have?" spent **four tool
     * calls and 1,358 output tokens** — `config_read`, two `glob`s and a `file_read` — working out what
     * the one skill was, and its reasoning trace shows it guessing whether `./skills` resolved against the
     * workspace or the agent directory. That is precisely the two-hop shape decision 5.19 put this block
     * here to remove, arrived at again one field further in: a count answers "how many", and every
     * question anybody actually asks is "which".
     *
     * Naming them is not letting the model choose one — the harness still selects, and the sentence below
     * still says so. Cache-safe because the catalogue resolves once at boot, so the row is byte-stable for
     * the session's life.
     */
    readonly skillNames?: readonly string[]
    /** Whether the HTTP surface is actually bound, for the same reason. */
    readonly serverListening: boolean
    /**
     * Another live process holds this agent's serving lease.
     *
     * The third state the three flags above cannot express between them, and its absence was a
     * measured failure: told only that its channel and its scheduler were "NOT running in this
     * session; only `serve` starts them", an agent in a REPL sent its owner off to run `serve` — a
     * command already running in the next terminal, doing both. Every sentence was true of the
     * process rendering it and the conclusion drawn from them was wrong, which is decision 5.17's
     * failure one process boundary out.
     *
     * No pid here, on purpose. Slot 2 is frozen at first use, so a pid is a fact at boot and a guess
     * by turn forty; `run`'s `/status` reads the lease live and names it there, where it is current.
     */
    readonly servedElsewhere: boolean
}

/**
 * Render the block. Always non-empty — an agent with no tools still has a model and a manifest.
 *
 * Every line is derived from the manifest rather than written per feature, so a section added later
 * is one entry here and not a new special case: the point Moeen made is that this must be true of
 * every configuration, not of channels.
 */
export function renderConfigSummary(input: ConfigSummaryInput): string {
    const { manifest, path } = input
    const name = manifest.name === undefined ? manifest.id : `${manifest.id} (${manifest.name})`

    const rows: [string, string][] = [
        [
            "model",
            `${manifest.model.main.id} · ${manifest.tools.dialect} dialect · ${input.window} token window`,
        ],
        ["tools", describeTools(input)],
        ["skills", describeSkills(manifest, input.skillNames)],
        ["memory", describeMemory(manifest)],
        ["channels", describeChannels(manifest, input.channelsStarted, input.servedElsewhere)],
        ["schedules", describeSchedules(manifest, input.schedulerStarted, input.servedElsewhere)],
        ["http api", describeServer(manifest, input.serverListening, input.servedElsewhere)],
        ["permissions", describePermissions(manifest)],
    ]

    const width = Math.max(...rows.map(([label]) => label.length))
    const table = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n")

    return [
        "# Configuration",
        "",
        `I am ${name}. My settings are a file on disk: ${path}`,
        "",
        table,
        "",
        closing(input.tools.includes(CONFIG_SET)),
        // Appended to slot 2 rather than given a slot of its own, because it is the same kind of fact
        // as every row above it: something the runtime does to this agent that the agent cannot see.
        // A separate slot would also have to be placed relative to the cache breakpoint, and there is
        // no reading under which this varies per turn.
        ...(input.compactionNotice === undefined ? [] : ["", input.compactionNotice]),
    ].join("\n")
}

/**
 * The paragraph that does the actual work.
 *
 * "Configuration, not something to build" is aimed squarely at the observed failure. The prohibition
 * is explicit about the three wrong routes a capable model reaches for — writing code, installing
 * something, editing the manifest with a file tool — because each is individually plausible and the
 * agent tried the first one.
 */
function closing(canChange: boolean): string {
    if (!canChange) {
        return [
            "All of that is configuration, not something to build. It is decided before I start and",
            "I have no tool to change it — so if something I need is switched off, the answer is to",
            "say which setting it is and why, not to write code that works around it.",
        ].join("\n")
    }
    return [
        "All of that is configuration, not something to build. To add a channel, enable a tool or",
        `change a limit, I edit it with ${CONFIG_SET} — never by writing code, installing a package,`,
        "or editing the file above with a file tool. `config_read` lists every setting I may change,",
        "with its current value. A change takes effect when I next start, not in this conversation.",
    ].join("\n")
}

function describeTools(input: ConfigSummaryInput): string {
    const count = input.tools.length
    if (count === 0) return "none — I answer from context alone"
    const from = input.providers.length === 0 ? "built in" : `from ${input.providers.join(", ")}`
    return `${count} available, ${from}`
}

/**
 * Skills, as the model needs to understand them.
 *
 * It says *harness-side* explicitly. Without that a model told it has twelve skills reasonably concludes
 * it should choose one, and decision 6.2's whole point is that it does not get to: the choice is made
 * before the turn starts, from the input. An agent that believes otherwise spends tokens deliberating
 * about a decision that has already been taken.
 */
/** Beyond this many, the row names some and counts the rest: slot 2 is a summary, not the catalogue. */
const NAMED = 12

function describeSkills(manifest: AgentManifest, names: readonly string[] | undefined): string {
    const configured = manifest.skills
    if (configured === undefined || names === undefined) {
        return "none — no skills directory is configured, so no procedures are available"
    }
    if (names.length === 0) {
        return `configured at ${configured.dir} and empty — the directory exists and holds no skills yet`
    }
    const shown = [...names].slice(0, NAMED).join(", ")
    const rest = names.length - Math.min(names.length, NAMED)
    return (
        `${names.length} available — ${shown}${rest === 0 ? "" : `, and ${rest} more`}. ` +
        `At most ${configured.maxActive} per turn. ` +
        "Selected for me by the harness from what was just asked — I do not choose one, and one that " +
        "applies is already in my context under its own heading, so I can say what I have without " +
        "looking for it."
    )
}

/**
 * Memory, and specifically whether anything survives the end of a conversation.
 *
 * The row exists because its absence was measured. An agent with memory configured, three excerpts of
 * its own earlier sessions in slot 7, and correct reasoning about them — *"all from conversations on
 * 2026-08-19"* — still finished its reply with **"the transcripts themselves don't carry over"**. It had
 * no row telling it otherwise, so it fell back on what a stateless assistant is right to assume, and
 * asserted it over the evidence in its own context.
 *
 * That is decision 5.17's rule applied to the one capability that had been left out of it: anything the
 * runtime can be configured to do gets a row, an absent capability says `none` rather than being omitted,
 * because a missing row reads as "no such concept" while a `none` row reads as a switch that is off.
 *
 * `includeHistory` is named separately from the notes on purpose. They are different promises — one says
 * "what I chose to write down survives", the other says "what was said survives" — and an agent that
 * conflates them either over-claims about a session nobody saved a note in, or under-claims exactly the
 * way this one did.
 */
function describeMemory(manifest: AgentManifest): string {
    const configured = manifest.memory
    if (configured === undefined || configured.maxActive === 0) {
        return "none — nothing carries past this conversation"
    }
    // Terse on purpose. Slot 2 is billed on every turn of every session, and a `context.test.ts` guard
    // caps the whole block — the first version of this row cost 25 tokens over it on its own. What
    // survives is only what changes the model's behaviour: that memory exists, what is in it, and that
    // it arrives without being fetched. The security property (tool output is never indexed) is real and
    // is *not* here: the model takes no action on it, and the manifest is where it belongs.
    const scope = configured.includeHistory
        ? "my notes and earlier conversations are both searched"
        : "my notes are searched; earlier conversations are not, so what I do not write down is lost"
    return `${scope} — up to ${configured.maxActive} a turn, already in my context when I answer`
}

/*
 * There is deliberately no phase row here, and the reason is worth keeping.
 *
 * A phase is **per session** and changes mid-turn; slot 2 is memoised **per agent** and frozen at first
 * use, because it sits in the cache-stable prefix (5.17). Putting the phase in it would have made two
 * sessions in one process render each other's phase — a wrong statement in the one block that exists to
 * stop the runtime lying about its own state. The current phase lives in `phase_set`'s description
 * instead, which is slot 1, already rebuilt per phase, and therefore cannot go stale.
 */

/**
 * The schedules row.
 *
 * Named as `none` rather than omitted when there are none, for the reason every row here follows: a
 * missing row reads as "no such concept" and sends an agent off to invent one, while a `none` row
 * reads as a switch that is off. Trimmed hard — slot 2 is billed on every turn of every session, so
 * a new capability earns a row and a wordier sentence does not.
 */
function describeSchedules(manifest: AgentManifest, started: boolean, elsewhere: boolean): string {
    const schedules = manifest.schedules.filter((schedule) => schedule.enabled)
    if (manifest.schedules.length === 0) return "none"

    const named = schedules
        .slice(0, 3)
        .map((schedule) => `${schedule.id} (${schedule.kind} ${schedule.expr})`)
        .join(", ")
    const rest = schedules.length > 3 ? `, +${schedules.length - 3} more` : ""
    const disabled = manifest.schedules.length - schedules.length
    const off = disabled === 0 ? "" : `; ${disabled} disabled`

    if (started) return `${named}${rest}${off}`
    // The three-way split every state row here now makes. "Not in this session" alone is true and
    // sends the reader to start something that is already started — see `ConfigSummaryInput.servedElsewhere`.
    if (elsewhere)
        return `${named}${rest}${off} — armed in another process serving me, not in this one`
    return `${named}${rest}${off} — configured but NOT running in this session; only \`serve\` starts the scheduler, \`run\` does not`
}

function describeChannels(manifest: AgentManifest, started: boolean, elsewhere: boolean): string {
    const enabled = manifest.channels.filter((channel) => channel.enabled)
    if (enabled.length === 0) {
        // Named as absent rather than omitted. A missing row reads as "this agent has no such
        // concept", which is what sent one off to build a bridge; a row saying `none` reads as a
        // switch that is off.
        return "none — I am reached through the CLI and the HTTP API only"
    }
    const list = enabled.map((channel) => `${channel.id} (${channel.type})`).join(", ")
    // State, not configuration. Told only the configuration, an agent under `run` reported that the
    // Telegram runtime was not up — from inside the running process — and offered to write a
    // LaunchAgent. The clause is what stops that: it is not broken, it is not started here.
    if (started) return `${list} — connected in this session`
    if (elsewhere) return `${list} — connected in another process serving me, not in this one`
    return `${list} — configured but NOT running in this session; only \`serve\` starts channels, \`run\` does not`
}

function describeServer(manifest: AgentManifest, listening: boolean, elsewhere: boolean): string {
    if (!manifest.server.enabled) return "off"
    if (listening) return `on, ${manifest.server.host}:${manifest.server.port}`
    if (elsewhere) {
        return `on at ${manifest.server.host}:${manifest.server.port} in another process serving me, not in this one`
    }
    return `enabled in config but NOT listening in this session; only \`serve\` binds it`
}

function describePermissions(manifest: AgentManifest): string {
    const policy = manifest.tools.policy
    const rules = policy.allow.length + policy.deny.length
    return `mode ${policy.mode} · ${rules} rule${rules === 1 ? "" : "s"} · untrusted writes ${manifest.tools.untrusted.onMutate}`
}
