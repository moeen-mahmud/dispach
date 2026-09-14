/**
 * Natural-language tool calling: prose catalogue, line-oriented invocation.
 *
 * Two properties do the work, and both are about small models.
 *
 * **The catalogue is prose, with a mandatory negative example.** A JSON Schema tells a model what
 * is *well-formed*; it says nothing about when to reach for the tool, and routing — not argument
 * formatting — is where small models actually fail. The `Do NOT use when` line is the cheapest
 * available accuracy improvement, so a spec without one renders a visible placeholder rather than
 * quietly dropping the line.
 *
 * **The invocation format is lines, not nested JSON.** A 7B model producing well-formed nested JSON
 * with quoted strings, escaped newlines and balanced braces fails often; the same model producing
 * `key: value` lines almost never does. So the format is line-oriented, and the parser is
 * deliberately tolerant: case-insensitive keywords, bullet prefixes accepted, `END` optional,
 * wrapping code fences ignored. Tolerance here is not sloppiness — every accepted variant is one
 * that was going to arrive anyway, and refusing it would spend a repair step on punctuation.
 *
 * The parser is **schema-free on purpose**. It reports what the model wrote, verbatim, and
 * `coerce.ts` alone decides what that means for a given tool. That split is why the same parse
 * result can be tested against no schema at all, and why a field-matching change cannot break
 * block detection.
 */

import type { ContextBlock } from "../../context/blocks.ts"
import { SLOT } from "../../context/blocks.ts"
import { estimateMessageTokens } from "../../context/tokens.ts"
import { renderTrusted } from "../trust.ts"
import type { FieldError, JsonSchemaNode, ToolIntent, ToolResult, ToolSpec } from "../types.ts"
import type { ParsedOutput, StreamFilter, ToolDialect } from "./dialect.ts"
import { renderNotEnabledText } from "./not-enabled.ts"

/** Opens a multi-line value. */
const HEREDOC_OPEN = "<<<"
/** Closes one, on a line of its own. A line merely *containing* it is content. */
const HEREDOC_CLOSE = ">>>"

// The optional angle brackets are measured, not defensive: `<ACTION: glob>` is one of the three
// shapes deepseek-v4-pro produced. See ATTEMPTED_CALL below for the other two and for why tolerance
// alone cannot be the whole answer.
const ACTION_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?<?\s*action\s*:\s*(.+?)\s*>?\s*$/i
/**
 * A field name has **no spaces**, and that one character class is load-bearing.
 *
 * It used to be `[\w .-]`, which admits a space — so any continuation line of a multi-line value
 * containing a colon was eaten as a new field. Measured, from a real session: an agent debugging a
 * port ran a multi-line shell script, and `lsof -nP -iTCP:7420 -sTCP:LISTEN` was read as the field
 * `lsof -nP -iTCP` with the value `7420 -sTCP:LISTEN`. The call was refused, the model was asked to
 * repair, and it spent a step rewriting a command that was correct.
 *
 * A shell script is the *normal* value for `exec`, and colons are everywhere in one — `lsof -i`,
 * `sed 's/a:b/c/'`, a URL, a timestamp. Tolerating a space in a key bought nothing measurable and
 * cost that. With it gone, such a line is simply value text, which is the safe direction: the worst
 * case is a stray line inside a value the tool then rejects with its own message, rather than a
 * silently truncated argument.
 */
const KEY_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?([A-Za-z_][\w.-]*?)\s*:\s*(.*)$/
const FENCE_LINE = /^\s*`{3,}\s*[\w+-]*\s*$/
const END_LINE = /^\s*end\s*$/i

/**
 * The XML-shaped near miss, tolerated because a frontier model writes it unprompted.
 *
 * Observed against deepseek-v4-pro on a fresh session with an eight-tool catalogue: asked to use
 * `glob`, it wrote
 *
 *     <action>
 *     glob
 *     pattern: (a correct glob)
 *     </action>
 *
 * with the arguments completely correct. The same model has also emitted its own native
 * `<｜｜DSML｜｜Tool …/>` markup. Angle brackets are what its tool-calling was trained on, and no
 * amount of "exactly like this" in the preamble outvotes that.
 *
 * Untolerated, this is the worst failure shape available: the parser finds no block, so the markup
 * becomes the *reply* — the person is shown a tool call as prose, no repair is requested, and nothing
 * anywhere reports that a tool was attempted. Accepting it is the same kind of tolerance the parser
 * already extends to `- ACTION:`, `1. ACTION:`, a backticked slug and a wrapping fence: NLT's protocol
 * is prose a model imitates, so imitations that are unambiguous are met halfway.
 *
 * Narrow on purpose — the opener alone on its line, the slug on the next — so prose that happens to
 * mention an XML tag mid-sentence is untouched.
 */
const XML_OPEN = /^\s*<\s*action\s*>\s*$/i
const XML_CLOSE = /^\s*<\s*\/\s*action\s*>\s*$/i

/**
 * A line that is *nothing but* an XML tag.
 *
 * The third shape observed from the same model was `<ebml>` wrapped around `<ACTION: glob>` and closed
 * with `</ebml>` — an element name that means nothing to anyone, chosen apparently at random. Listing
 * tag names cannot keep up with that, so any lone tag is treated as protocol debris and dropped.
 *
 * The trade-off, stated: a reply whose entire line is `<div>` loses that line. In three phases of real
 * transcripts no model has written one, and the alternative is a reply that shows the person a tag
 * they did not ask about wrapped round a tool call that never ran.
 */
const LONE_TAG = /^\s*<\/?\s*[A-Za-z_][\w.:-]*\s*\/?\s*>\s*$/

/**
 * Markup that says "this was meant to be a tool call" in a format this parser cannot read.
 *
 * Measured, not guessed. Asked the same question twice against deepseek-v4-pro on fresh sessions with
 * an eight-tool catalogue, it invented **two different** formats:
 *
 *     <action>                            <TOOL_CALL>
 *     glob                                <TOOL>glob</TOOL>
 *     pattern: (a glob)                   <PARAM name="pattern">(a glob)</PARAM>
 *     </action>                           </TOOL_CALL>
 *
 * and in an earlier session its own native `<｜｜DSML｜｜Tool …/>` markup. The first shape is now
 * parsed outright; the lesson of the second is that the set of shapes cannot be enumerated, so
 * tolerance alone is a losing game.
 *
 * What *can* be done reliably is notice that a call was attempted and ask for it again in the right
 * format. That is what the repair step exists for, and one repair is far cheaper than the alternative:
 * with no detection the markup becomes the **reply**, the person is shown protocol debris, no repair
 * is requested, no event fires, and the turn is recorded as a clean answer. Silent, and wrong.
 *
 * Tight on purpose. A closing tag is required, or a vendor marker — prose about markup says
 * "wrap it in an <action> element" and does not close it. Together with the zero-intents condition
 * below, a step that produced a readable block never triggers this: a model that got the format right
 * once is not guessing.
 */
const ATTEMPTED_CALL: readonly RegExp[] = [
    /<\/\s*(?:tool_calls?|toolcalls?|tool|function_call|function|invoke|action|parameters?|params?|arguments?|args?)\s*>/i,
    // DeepSeek's own tool protocol, which leaks through when it decides to use it. Matched on the
    // bare marker rather than its delimiters: those are full-width pipes (U+FF5C), and a pattern
    // written with the ASCII one looks correct and matches nothing — which it did, first time.
    /DSML/,
    /tool[\u2581_]calls?[\u2581_]begin/i,
    // A bare JSON call, which several models fall back to when a text protocol confuses them.
    /^\s*\{\s*"(?:name|tool|tool_name|function)"\s*:/m,
]

/**
 * Did this step attempt a tool call the parser could not read?
 *
 * Only asked when nothing parsed, and answered from the *prose*, which is what the markup became.
 */
function attemptedCall(text: string): FieldError | undefined {
    if (!ATTEMPTED_CALL.some((pattern) => pattern.test(text))) return undefined
    return {
        field: "the block",
        message: "looks like a tool call written in a different format, so nothing ran.",
        hint: "Tool calls in this conversation are plain lines, not tags or JSON. Write `ACTION:` then the tool name, one `name: value` per line after it, then `END` alone on its own line — exactly as the tool list shows. Nothing was executed, so writing it again correctly is safe.",
    }
}

/** Strip the decoration a model puts around a tool name: backticks, quotes, trailing full stop. */
function cleanSlug(raw: string): string {
    return raw
        .replace(/^[`'"*<]+/, "")
        .replace(/[`'"*>]+$/, "")
        .replace(/[.,;:]+$/, "")
        .trim()
}

interface Block {
    readonly slug: string
    /** Key → every occurrence, in order. Repeats are kept: an array field is often written twice. */
    readonly fields: Map<string, string[]>
    /**
     * Keys whose value arrived through `<<<` / `>>>` rather than through bare continuation lines.
     *
     * Recorded because it is the one thing the finished value cannot tell you, and the backstop below
     * turns on it. Two multi-line strings that are byte-identical are a *faithful* value and a
     * *damaged* one depending only on which path built them: the heredoc path pushes each line
     * verbatim, while the continuation path pushes it trimmed — so an unwrapped value has already had
     * its indentation destroyed by the time anything can inspect it.
     *
     * Keyed by field name rather than by occurrence, which is a real limit and a cheap one: a block
     * writing the *same* key twice, once wrapped and once not, has both occurrences read as wrapped
     * and the second escapes the backstop. A repeated key is how an array field is written, and an
     * array whose elements are multi-line shell scripts has not turned up in any transcript. Stated
     * because the alternative — per-occurrence tracking — is the kind of precision that costs a
     * reader more than the case is worth.
     */
    readonly wrapped: Set<string>
}

interface ParseState {
    block: Block | undefined
    /** Field whose value a bare continuation line extends. Cleared by a blank line. */
    openKey: string | undefined
    heredocKey: string | undefined
    heredocLines: string[]
    /** A block just ended, so a fence on the next meaningful line is its closing fence. */
    justClosed: boolean
    /**
     * An `<action>` opener has been seen and the slug is still to come on a following line.
     *
     * A separate flag rather than an empty block, because a block with no slug is not a block: the
     * closer has to be able to tell "opened, never named" from "opened and named", and discard the
     * first rather than emit a call to the empty string.
     */
    awaitingSlug: boolean
    text: string[]
    blocks: Block[]
}

function push(block: Block, key: string, value: string): void {
    const existing = block.fields.get(key)
    if (existing === undefined) block.fields.set(key, [value])
    else existing.push(value)
}

function closeHeredoc(state: ParseState): void {
    if (state.block === undefined || state.heredocKey === undefined) return
    // One trailing blank line is an artefact of writing `>>>` on its own line, not content.
    const lines = [...state.heredocLines]
    if (lines[lines.length - 1] === "") lines.pop()
    push(state.block, state.heredocKey, lines.join("\n"))
    state.block.wrapped.add(state.heredocKey)
    state.heredocKey = undefined
    state.heredocLines = []
}

function closeBlock(state: ParseState): void {
    closeHeredoc(state)
    if (state.block !== undefined) state.blocks.push(state.block)
    state.block = undefined
    state.openKey = undefined
    state.awaitingSlug = false
}

function newState(): ParseState {
    return {
        block: undefined,
        openKey: undefined,
        heredocKey: undefined,
        heredocLines: [],
        justClosed: false,
        awaitingSlug: false,
        text: [],
        blocks: [],
    }
}

/**
 * Consume one complete line.
 *
 * The whole grammar lives here, and both callers drive it: `parseNlt` feeds it every line at once,
 * the stream filter feeds it lines as they arrive. That is deliberate. A separate line classifier for
 * display would be a second parser, and a second parser drifts — the version deciding what the person
 * sees would eventually disagree with the version deciding what actually runs.
 *
 * `fenceIsDecoration` resolves the grammar's one lookahead: whether a fence is about to wrap a block.
 * A whole-output parse answers it by looking ahead; the filter answers it by holding the fence for one
 * line, which is why that is the only place streaming ever waits.
 */
function consumeLine(state: ParseState, line: string, fenceIsDecoration: () => boolean): void {
    const trimmed = line.trim()

    // Inside a heredoc almost nothing is special: this is the one place where the model's own
    // formatting has to survive byte for byte, so only a lone terminator ends it.
    if (state.heredocKey !== undefined) {
        if (trimmed === HEREDOC_CLOSE) {
            closeHeredoc(state)
            return
        }
        // A forgotten `>>>` would otherwise swallow the rest of the output into one field.
        if (END_LINE.test(trimmed)) {
            closeBlock(state)
            state.justClosed = true
            return
        }
        if (ACTION_LINE.test(line)) {
            closeBlock(state)
            const match = ACTION_LINE.exec(line)
            const slug = cleanSlug(match?.[1] ?? "")
            if (slug !== "") state.block = { slug, fields: new Map(), wrapped: new Set() }
            return
        }
        state.heredocLines.push(line)
        return
    }

    const action = ACTION_LINE.exec(line)
    if (action !== null) {
        const slug = cleanSlug(action[1] ?? "")
        closeBlock(state)
        if (slug === "") return
        state.block = { slug, fields: new Map(), wrapped: new Set() }
        return
    }

    // `<action>` on its own line: the block opens and the slug is whatever the next non-empty line
    // says. Handled before the no-block branch below, or the opener would be delivered as prose.
    if (XML_OPEN.test(line)) {
        closeBlock(state)
        state.awaitingSlug = true
        return
    }

    if (state.awaitingSlug) {
        if (trimmed === "") return
        if (XML_CLOSE.test(line)) {
            // Opened and never named. Discarded rather than emitted as a call to the empty string,
            // and not passed through as prose either — the model meant to call something.
            state.awaitingSlug = false
            return
        }
        const slug = cleanSlug(trimmed)
        state.awaitingSlug = false
        if (slug !== "") state.block = { slug, fields: new Map(), wrapped: new Set() }
        return
    }

    if (XML_CLOSE.test(line)) {
        // A stray closer with nothing open. Swallowed rather than shown: it is protocol debris, and
        // a reply ending in `</action>` is a reply nobody wrote.
        if (state.block !== undefined) {
            closeBlock(state)
            state.justClosed = true
        }
        return
    }

    // Any other lone tag — `<ebml>`, `</ebml>`, `<tool_call>` — is dropped without closing a block,
    // because it is a wrapper the model put *around* the call rather than part of it.
    if (LONE_TAG.test(line)) return

    if (state.block === undefined) {
        // A fence that wraps a block belongs to the block, not to the reply — so the one just
        // before an ACTION and the one just after an END are dropped. A fence anywhere else is
        // the model writing markdown at the person, and eating it would mangle their reply.
        if (FENCE_LINE.test(line) && (state.justClosed || fenceIsDecoration())) {
            state.justClosed = false
            return
        }
        state.text.push(line)
        if (trimmed !== "") state.justClosed = false
        return
    }

    if (trimmed === "") {
        // Ends continuation without ending the block: models put blank lines between fields,
        // and gluing whatever follows onto the last value is how prose ends up in an argument.
        state.openKey = undefined
        return
    }

    if (END_LINE.test(trimmed)) {
        closeBlock(state)
        state.justClosed = true
        return
    }

    if (FENCE_LINE.test(line)) return

    const keyed = KEY_LINE.exec(line)
    if (keyed !== null) {
        const key = (keyed[1] ?? "").trim()
        const value = (keyed[2] ?? "").trim()
        if (value === HEREDOC_OPEN) {
            state.heredocKey = key
            state.heredocLines = []
            state.openKey = undefined
        } else {
            push(state.block, key, value)
            state.openKey = key
        }
        return
    }

    if (state.openKey !== undefined) {
        const values = state.block.fields.get(state.openKey)
        const last = values?.[values.length - 1]
        if (values !== undefined && last !== undefined) {
            values[values.length - 1] = last === "" ? trimmed : `${last}\n${trimmed}`
        }
        return
    }

    // A block with no END, followed by prose. The prose is the reply.
    closeBlock(state)
    state.text.push(line)
}

/**
 * A shell heredoc opener, and the terminator word it promises: `<<PY`, `<<'EOF'`, `<<- "SQL"`.
 *
 * Anchored to end-of-line because that is where a real heredoc opener sits — the redirection is the
 * last thing on the line and the body starts on the next. Without the anchor `$((1 << n))` reads as
 * an opener promising a terminator called `n`, and an arithmetic shift would earn a repair.
 *
 * `<<<` is bash's here-*string* and deliberately does not match: the character after `<<` has to
 * begin a word, and `<` does not.
 */
const SHELL_HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/m

/**
 * Was this value damaged on the way in?
 *
 * **The backstop the carried backlog asked for, and it does not work the way that note expected.**
 * The note proposed detecting "prose that reads as a continuation of the value it just abandoned",
 * which is a judgement about intent and therefore the unenumerable-set problem again. Measured
 * against a real endpoint (`evals/nlt-heredoc`, deepseek-chat, 16 attempts) every damaged value
 * shared one *checkable* property instead: it spanned lines without using the protocol's own
 * facility for that. So this asks about conformance, not intent.
 *
 * Two signals, and the second is not redundant:
 *
 * **Unwrapped and multi-line.** `<<<` / `>>>` exists precisely to carry a value across lines. A value
 * that spans lines without it went through the continuation branch, which pushes each line *trimmed*
 * — so `def f(x):` / `    return x * 2` arrives at column zero and is an `IndentationError` rather
 * than a script. Measured at 2 of 16 attempts, and silent: the command runs. The refusal is therefore
 * not conservatism about a value that might be fine; an unwrapped multi-line value is already wrong.
 *
 * **An unterminated shell heredoc.** Catches the case the first signal cannot see: when the blank
 * line falls immediately after the opener, what survives is a *single* line — `python3 - <<'PY'` —
 * and the rest of the script is already the reply. A shell heredoc names its own terminator, so the
 * evidence that the value was cut is inside the value, which makes this signal exact rather than
 * heuristic. Measured at 2 of 16, and the shape the backlog reproduced by hand.
 *
 * What is deliberately *not* a signal: anything about the prose that follows. A block with no `END`
 * followed by a genuine reply is ordinary and must stay free.
 */
function damage(value: string, wrapped: boolean): "unwrapped" | "unterminated" | undefined {
    const opener = SHELL_HEREDOC.exec(value)
    if (opener !== null) {
        const terminator = opener[2] ?? ""
        const closed = new RegExp(`^\\s*${terminator}\\s*$`, "m").test(value)
        if (!closed) return "unterminated"
    }
    if (!wrapped && value.includes("\n")) return "unwrapped"
    return undefined
}

/**
 * What the model is told when a value arrives damaged.
 *
 * Load-bearing prose rather than a formality: this is the entire content of the one repair the parser
 * grants, and the repo's own measurement is that a placeholder in an example is read as an
 * instruction by a small model. `field` is the field name the model wrote, so the message reads as a
 * sentence about that field the way every other `FieldError` in `coerce.ts` does.
 *
 * TODO(moeen): write the two messages. See the request in the conversation — the trade-off is that a
 * terse hint leaves a small model guessing at the wrapped form, while a long one is billed on every
 * repair and buries the one instruction that matters.
 */
function damageError(field: string, kind: "unwrapped" | "unterminated"): FieldError {
    return {
        field,
        message:
            kind === "unwrapped"
                ? "spans several lines but was not wrapped, so its line breaks and indentation could not be kept."
                : "opens a heredoc whose terminator never arrived, so the value was cut short.",
        hint: `Write a value that spans lines between ${HEREDOC_OPEN} and ${HEREDOC_CLOSE}, each on its own line: \`${field}: ${HEREDOC_OPEN}\`, then the value exactly as it should be, then \`${HEREDOC_CLOSE}\`. Everything between them is kept byte for byte, blank lines and indentation included. Nothing was executed, so writing the call again is safe.`,
    }
}

/**
 * Split a model's output into invocation blocks and reply text.
 *
 * Exported for the parser tests, which are the ones that matter here: this function is the entire
 * surface between a model's prose habits and the executor.
 */
export function parseNlt(output: string): ParsedOutput {
    const lines = output.split(/\r\n|\r|\n/)
    const state = newState()

    for (let index = 0; index < lines.length; index += 1) {
        consumeLine(state, lines[index] ?? "", () => nextMeaningfulIsAction(lines, index))
    }

    closeBlock(state)

    const damaged: FieldError[] = []
    const intents: ToolIntent[] = state.blocks.map((block, index) => {
        for (const [key, values] of block.fields) {
            for (const value of values) {
                const kind = damage(value, block.wrapped.has(key))
                if (kind !== undefined) damaged.push(damageError(key, kind))
            }
        }
        return {
            // Deterministic, so a parser test can assert one. Uniqueness comes from the step id in
            // the event envelope, which is where a call is actually identified.
            callId: `c${index + 1}`,
            slug: block.slug,
            args: Object.fromEntries(
                [...block.fields].map(([key, values]) => [
                    key,
                    values.length === 1 ? values[0] : values,
                ]),
            ),
        }
    })

    const text = state.text.join("\n").trim()
    // Reported *alongside* the intents rather than instead of them. The loop reads `malformed` first
    // and makes the step all-or-nothing, so a damaged value stops the call it belongs to — and
    // carrying the intents means the repair names the tool the model was reaching for. Dropping them
    // here would report "nothing parsed", which is both untrue and less useful.
    if (intents.length > 0) {
        return damaged.length === 0 ? { intents, text } : { intents, text, malformed: damaged }
    }

    // Nothing parsed. If the prose is markup rather than prose, say so instead of delivering it.
    const attempted = attemptedCall(text)
    return attempted === undefined ? { intents, text } : { intents, text, malformed: [attempted] }
}

/**
 * Could this partial line still turn into something the parser would swallow?
 *
 * The answer decides how long streaming waits. `ACTION` and a fence are the only line starts that get
 * removed, so a partial is held only while it remains a plausible prefix of one — at most six
 * characters, and nothing at all once the line has diverged. Mid-line prose never waits.
 */
function mightBecomeStructure(partial: string): boolean {
    // A bullet or list marker that has not yet been followed by anything could still precede ACTION.
    if (/^\s*(?:[-*+]|\d+[.)]?)?\s*$/.test(partial)) return true

    const head = partial.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, "").toLowerCase()

    // A leading `<` is stripped before the ACTION check because `<ACTION: glob>` is one of the shapes
    // a real model produced, and the parser accepts it — so the filter has to hold it too, or the
    // bracket reaches the screen a moment before the rest of the line is swallowed.
    const bare = head.startsWith("<") ? head.slice(1) : head
    if ("action:".startsWith(bare) || bare.startsWith("action:")) return true

    // A lone tag is swallowed whole, so anything that is still a *prefix of one* waits — the complete
    // form included, since `<ebml>` is only known to be debris once the line ends.
    if (/^<\/?$/.test(head) || /^<\/?[a-z_][\w.:-]*>?$/.test(head)) return true

    return /^`{1,3}[\w+-]*$/.test(head)
}

/**
 * Strip one trailing carriage return.
 *
 * Deltas are split on `\n`, so CRLF leaves the `\r` at the end of the line. A lone `\r` as a line
 * terminator is deliberately not handled here: no `/chat/completions` endpoint sends one, and guessing
 * would mean buffering every line to find out.
 */
function stripCr(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line
}

export function createNltStreamFilter(): StreamFilter {
    // Reassigned at every step boundary: `parse` runs per step, so an unterminated block does not
    // continue into the next one. What persists across steps is the whitespace bookkeeping below,
    // which is what makes the reply read as one message.
    let state = newState()
    /** Characters since the last newline, carriage return included. */
    let partial = ""
    /** How much of the visible partial has been handed back, so nothing is emitted twice. */
    let emitted = 0
    /** A fence awaiting the next line, which is the only thing that can classify it. */
    let heldFence: string | undefined
    /** Whitespace held back: interior once more text follows, trailing if nothing does. */
    let pending = ""
    let started = false

    /**
     * Whitespace is never emitted on its own.
     *
     * `parse` trims the finished reply, and a stream cannot un-emit — so blank lines and indentation
     * wait here until non-blank text proves they were interior. What is still waiting at the end was
     * trailing, and is dropped. Without this the screen ends with a blank line the transcript does
     * not have, and the two disagree about what was said.
     */
    const emit = (text: string): string => {
        if (text === "") return ""
        if (text.trim() === "") {
            pending += text
            return ""
        }
        const out = pending + text
        pending = ""
        if (started) return out
        started = true
        return out.replace(/^\s+/, "")
    }

    /** Feed one complete line. Returns the part of it that belongs to the person, or undefined. */
    const consume = (line: string, next: string | undefined): string | undefined => {
        const before = state.text.length
        consumeLine(state, line, () => next !== undefined && ACTION_LINE.test(next))
        // The line reached the reply iff the parser pushed it as text. Anything else was structure.
        return state.text.length > before ? line : undefined
    }

    /** A consumed line, minus whatever of it already streamed, plus its line break. */
    const show = (line: string, next: string | undefined, alreadyEmitted: number): string => {
        const kept = consume(line, next)
        if (kept === undefined) return ""
        return emit(kept.slice(alreadyEmitted)) + emit("\n")
    }

    const flushHeldFence = (next: string | undefined): string => {
        if (heldFence === undefined) return ""
        const fence = heldFence
        heldFence = undefined
        return show(fence, next, 0)
    }

    return {
        push(delta) {
            let out = ""
            partial += delta

            let newline = partial.indexOf("\n")
            while (newline !== -1) {
                const line = stripCr(partial.slice(0, newline))
                partial = partial.slice(newline + 1)

                out += flushHeldFence(line)

                // A fence cannot be classified until the next line is known — it is decoration if a
                // block follows it, and the person's own markdown otherwise.
                if (state.block === undefined && FENCE_LINE.test(line) && !state.justClosed) {
                    heldFence = line
                } else {
                    out += show(line, undefined, emitted)
                }

                emitted = 0
                newline = partial.indexOf("\n")
            }

            // Emit the incomplete line eagerly, unless it could still become structure — inside a
            // block nothing is emitted at all, which is what keeps the protocol off the screen. A
            // trailing carriage return waits for the newline it belongs to.
            const visible = stripCr(partial)
            if (
                state.block === undefined &&
                // An `<action>` opener has been seen and this line is its slug — structure, even
                // though no block is open yet. Without this the slug streams to the screen a moment
                // before the parser swallows it, and the reply reads "glob" above its own tool row.
                // A stream cannot un-emit, which is why the check has to be here rather than after.
                !state.awaitingSlug &&
                heldFence === undefined &&
                !mightBecomeStructure(visible)
            ) {
                out += emit(visible.slice(emitted))
                emitted = visible.length
            }

            return out
        },

        endStep() {
            const out = flush()
            // Assigned, not appended: the loop joins each step's *trimmed* prose, so a line break
            // left over from the end of this step is replaced by the paragraph break rather than
            // added to it. Queued rather than emitted, because the break belongs to the reply only
            // if the next step has something to say.
            pending = "\n\n"
            state = newState()
            return out
        },

        end: flush,
    }

    /** Release the unterminated final line, if the parser calls it prose. */
    function flush(): string {
        let out = flushHeldFence(undefined)
        const visible = stripCr(partial)
        if (visible !== "") {
            // No newline: the last line of a step ends where the step ends.
            const kept = consume(visible, undefined)
            if (kept !== undefined) out += emit(kept.slice(emitted))
        }
        partial = ""
        emitted = 0
        heldFence = undefined
        return out
    }
}

/** Is the next non-blank line an ACTION? Decides whether a fence is decoration or content. */
function nextMeaningfulIsAction(lines: readonly string[], from: number): boolean {
    for (let i = from + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (line.trim() === "") continue
        return ACTION_LINE.test(line)
    }
    return false
}

/**
 * The example is concrete, and that is the whole point of it.
 *
 * It used to read `ACTION: tool_name` / `field: value`, which a large model reads as metasyntax and a
 * small one reads as instruction. Measured on qwen3.5:9b: it wrote `field: title` / `value: Renew my
 * passport` — perfect reasoning about *which* tool and *which* arguments, encoded through the
 * placeholder words as though they were the format. NLT accuracy was 27% against native's 92%, and
 * every one of those failures was this. `evals/tools/README.md` carries the before and after.
 *
 * So the example uses a tool that does not exist in any catalogue this ships with, with field names
 * that look like field names. The disclaimer after it is phrased positively — "take them from the list
 * below" rather than "these are not your tools" — because a model that mishandles metasyntax is not
 * the model to hand a negation to.
 */
const PREAMBLE = `# Tools

To use a tool, write an ACTION block. Start each line at the left margin, exactly like this:

ACTION: weather_lookup
city: Lisbon
units: celsius
END

That block is an example of the shape only. Your own tools are listed below — take the tool name and
every field name from that list, spelled exactly as it is written there.

Rules for a block:
- One field per line, written as \`name: value\`, where \`name\` is one of that tool's own field names.
- For a value spanning several lines, open it with \`${HEREDOC_OPEN}\` and close it with \`${HEREDOC_CLOSE}\` alone on its own line.
- Finish every block with \`END\` alone on its own line.
- Several blocks are allowed. They run in the order you write them.
- Use only the tools listed below, only their listed fields, and always give every required field.

Anything you write outside a block is shown to the person you are talking to, so keep explanations
short and keep them out of the block. When no tool fits, simply reply — never invent a tool, and
never guess a value for a required field you have not been given.`

function typeLabel(node: JsonSchemaNode): string {
    if (node.type === "array") {
        const item = node.items?.type
        return item === undefined ? "list" : `list of ${item}`
    }
    return node.type
}

function fieldLine(name: string, node: JsonSchemaNode, required: boolean, pad: number): string {
    const parts: string[] = []
    parts.push(required ? "(required" : "(optional")
    // `string` is the overwhelming default and naming it on every line is noise the model has to
    // read past. Anything else is worth the tokens, because it changes what it must write.
    parts.push(node.type === "string" ? ")" : `, ${typeLabel(node)})`)
    const head = `  ${name.padEnd(pad)} ${parts.join("")}`

    const notes: string[] = []
    if (node.description !== undefined && node.description.trim() !== "") {
        notes.push(node.description.trim())
    }
    if (node.enum !== undefined && node.enum.length > 0) {
        notes.push(`one of: ${node.enum.map((value) => String(value)).join(" | ")}`)
    }
    if (node.default !== undefined) notes.push(`defaults to ${JSON.stringify(node.default)}`)

    return notes.length === 0 ? head : `${head} ${notes.join("; ")}`
}

const NO_NEGATIVE_GUIDANCE =
    "no guidance was supplied for this tool — if it does not clearly match what was asked, prefer another tool or reply without one"

export function renderNltEntry(spec: ToolSpec): string {
    const required = new Set(spec.parameters.required ?? [])
    const names = Object.keys(spec.parameters.properties)
    const pad = names.reduce((longest, name) => Math.max(longest, name.length), 0)

    const lines = [`### ${spec.slug}`, spec.summary.trim()]
    if (spec.whenToUse.trim() !== "") lines.push(`Use when: ${spec.whenToUse.trim()}`)
    lines.push(
        `Do NOT use when: ${
            spec.whenNotToUse === undefined || spec.whenNotToUse.trim() === ""
                ? NO_NEGATIVE_GUIDANCE
                : spec.whenNotToUse.trim()
        }`,
    )
    // On its own line rather than beside the name: anything appended to the header is something a
    // model will faithfully copy into `ACTION:`.
    if (spec.mutating) lines.push("Changes state: yes — only use it when the person asked for it.")

    if (names.length === 0) {
        lines.push("Fields: none — write the ACTION line and END.")
    } else {
        lines.push("Fields:")
        for (const name of names) {
            const node = spec.parameters.properties[name]
            if (node === undefined) continue
            lines.push(fieldLine(name, node, required.has(name), pad))
        }
    }

    return lines.join("\n")
}

function block(content: string): ContextBlock {
    return {
        slot: SLOT.tools,
        role: "system",
        content,
        // Pinned because compaction reliably eats initial instructions, and a model that has
        // forgotten the invocation format produces tool calls nothing can parse.
        pinned: true,
        tokens: estimateMessageTokens(content),
        label: "tools",
    }
}

function renderObservationText(result: ToolResult): string {
    // Three states, not two. "failed" invites a retry, and a gated call is not going to succeed on
    // the next attempt — a truthful-but-retryable refusal once made a real model retry until the
    // step budget ran out (see the note on `memory_write`).
    const state = result.gated === true ? "blocked" : result.ok ? "ok" : "failed"
    // `renderTrusted` owns the fence and the `(no output)` placeholder, so this dialect and `native`
    // cannot end up delimiting the same bytes two different ways.
    return `OBSERVATION ${result.slug} — ${state}\n${renderTrusted(result)}`
}

export const nltDialect: ToolDialect = {
    id: "nlt",

    renderCatalogue(specs, notEnabled) {
        if (specs.length === 0) return []
        const entries = specs.map(renderNltEntry).join("\n\n")
        // Appended to the catalogue block rather than added as a second one: both are settled at
        // load and neither varies per turn, so they are one fixed statement rather than two.
        const extra = renderNotEnabledText(notEnabled)
        return [
            block(
                `${PREAMBLE}\n\n## Available tools\n\n${entries}${extra === "" ? "" : `\n\n${extra}`}`,
            ),
        ]
    },

    // The whole protocol is in the text, so the request carries no `tools` key at all and a
    // text-dialect body is byte-for-byte what it was before native existed.
    requestTools: () => undefined,

    // `parseNlt` keeps its string signature: it is a text parser, and giving it the envelope would
    // imply it might read the other half. It never does.
    parse: (output) => parseNlt(output.text),

    createStreamFilter: createNltStreamFilter,

    // The *raw* text, blocks and all, so the next call sees the call it made rather than a
    // cleaned-up version that no longer explains the observation following it.
    renderCall: (output) => ({ role: "assistant", content: output.text }),

    renderObservation(results) {
        const body = results.map(renderObservationText).join("\n\n")
        return [
            {
                role: "user",
                content: `${body}\n\nContinue. Write another ACTION block if more is needed, or reply to the person if the task is done.`,
            },
        ]
    },

    renderRepair(errors) {
        const lines = errors.map((error) => `- ${error.field}: ${error.message} ${error.hint}`)
        return [
            {
                role: "user",
                content: [
                    "That ACTION block could not be used:",
                    "",
                    ...lines,
                    "",
                    "Write the block again, corrected. This is the only retry — if you cannot fill a required field, say so in a plain reply instead of guessing.",
                ].join("\n"),
            },
        ]
    },
}
