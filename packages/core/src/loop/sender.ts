/**
 * Who sent a turn's input, and what follows from the answer.
 *
 * The channel path has always carried this: `InboundMessage` has `peerId`, `senderHandle` and
 * `senderName`, and `allowFrom` reasons over them. The **API** path carried nothing — so on half
 * the runtime's own inbound surface there was no way to say "this is not my owner typing", which
 * makes a multi-user front end and an agent-to-agent message equally unexpressible. This module is
 * that missing axis for `POST /messages`, and it is deliberately smaller than `RawInbound`: an API
 * caller has no provider ids and no thread, only an identity and a claim about what kind of thing
 * it is.
 *
 * ## `kind` decides trust, and nothing else may
 *
 * There is no separate `trust` field, and its absence is the design. The dangerous configuration is
 * `kind: "agent"` beside `trust: "trusted"` — a peer's message declared safe — and the only way to
 * make that unrepresentable is to derive one from the other. A caller who genuinely wants a peer's
 * text treated as trusted has to write `kind: "user"`, which is a sentence about what they believe
 * rather than a flag that quietly widens a boundary. Same reasoning as `exec` having no `env` map
 * and `memory_write` no file argument: the field looks like a convenience and is a hole.
 *
 * Two kinds, not three. A `service` kind was drafted and dropped: a scheduler or a webhook relaying
 * text the operator's own configuration composed is not a *sender* at all, and the honest way to
 * say so is to omit `from`, which behaves exactly as this runtime did before this module existed.
 * An ambiguous default on a field that decides a trust boundary is worse than no field.
 *
 * ## What the fence does and does not buy
 *
 * `frameSenderInput` reuses `wrapUntrusted` from `tools/trust.ts` rather than writing a second
 * fence. That is the same rule that makes both dialects call `renderTrusted`: two boundaries can
 * disagree about the marker, its neutralisation and its notice, and one cannot. It is also why the
 * fence is *not* the security property — a model can be persuaded by text inside an intact fence.
 * The part that holds is that an untrusted sender starts the turn **tainted**, so the write gate
 * (`tools.untrusted.onMutate`) applies from step one rather than from whenever a tool happens to
 * return something. Measured motivation: AgentLeak reports inter-agent messages leaking sensitive
 * data 68.8% of the time against 27.2% in final outputs, so a peer's message is not merely as
 * untrustworthy as a fetched page — it is the worse case.
 */

import { type Trust, wrapUntrusted } from "../tools/trust.ts"

/** What kinds of sender a caller may declare. Exported so a surface can validate against it. */
export const SENDER_KINDS = ["user", "agent"] as const

export type SenderKind = (typeof SENDER_KINDS)[number]

/** Who sent this turn's input, when it was not the operator holding the API token. */
export interface TurnSender {
    /**
     * Stable identity in the caller's own namespace: `agent:ops-bot`, `user:018f…`, an email.
     *
     * Opaque to this runtime, which never parses it — it is carried onto the turn row and the
     * `turn.start` event so an audit can answer "who asked for this" after the process is gone.
     */
    readonly id: string
    /** A human-facing name, for the prompt's frame and for a listing. Decoration, not identity. */
    readonly name?: string
    readonly kind: SenderKind
}

/**
 * Whether this turn's input is data or instructions.
 *
 * Absent `from` is `trusted`, which is what keeps every existing caller byte-identical: the REPL,
 * a schedule, a channel turn and an API call with no sender all assemble exactly the prompt they
 * assembled before.
 */
export function trustOfSender(from: TurnSender | undefined): Trust {
    return from?.kind === "agent" ? "untrusted" : "trusted"
}

/**
 * How the sender is named in a refusal and in the fence.
 *
 * The id rather than the name, because a refusal naming "Ops Bot" tells an operator less than one
 * naming `agent:ops-bot` — and a name is attacker-supplied in exactly the case that matters.
 */
export function senderLabel(from: TurnSender): string {
    return `${from.kind} ${from.id}`
}

/**
 * The input as the prompt should carry it.
 *
 * Trusted input is returned **unchanged** — not re-wrapped, not annotated — so the common path
 * cannot drift. Untrusted input is fenced with the marker every untrusted observation already
 * uses, labelled with the sender rather than with a tool slug, and the sender's declared name is
 * put *inside* the fence where it belongs: a name supplied by the party being fenced is the last
 * thing that should appear in runtime prose above it.
 */
export function frameSenderInput(input: string, from: TurnSender | undefined): string {
    if (trustOfSender(from) === "trusted" || from === undefined) return input
    const named = from.name === undefined ? "" : `${from.name}\n`
    return wrapUntrusted(senderLabel(from), `${named}${input}`)
}
