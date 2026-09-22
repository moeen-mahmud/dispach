/**
 * Every request body, as a schema — one validator, and the source of the OpenAPI document.
 *
 * ## Why these are schemas and not nine `typeof` checks
 *
 * They were nine `typeof` checks. Each produced a good error with its own code and a hint carrying
 * real reasoning, and that is precisely what made them expensive to keep: the shape and the sentence
 * lived in the route, so nothing outside the route could describe the body. A generated reference
 * would have had to restate all nine, which is the fourth-list problem this repo keeps paying for
 * (`NO_MANIFEST`, `DOCUMENTED_CTRL_LETTERS`, `THRESHOLD_ORDER`, the route and error tables).
 *
 * So the code and the hint moved **into** the schema as metadata. One `parseBody` reproduces the
 * exact `ErrorDetail` each route used to build by hand, and `z.toJSONSchema` carries the same
 * metadata into the document — so the reference documents the refusal rather than paraphrasing it.
 * Nothing was lost in the move, including the nearest-match suggestion on `from.kind`, which a
 * custom Zod error reproduces.
 *
 * ## What stays out of here
 *
 * A **semantic** check is not a shape check, and the two must not both own a field:
 *
 * - `prepareScheduleWrite` parses cron expressions and durations and checks a delivery target
 *   against the agent's own channels. The schedule body is therefore described here and validated
 *   there — a wire schema cannot know whether `tg` is a channel this agent has.
 * - `keyLabelProblem` decides what a label may contain, which is a display rule.
 * - The provisioning answers are a `Record<string, string>` whose keys are the *wizard's* steps.
 *   Enumerating them here would be a second copy of `STEP_ORDER`, which is exactly what
 *   `GET /v1/provision` exists to avoid.
 *
 * Shape is checked once, here. Meaning is checked once, wherever the meaning lives.
 */

import { type ErrorDetail, nearest, SENDER_KINDS } from "@dispach/core"
import { z } from "zod"

/**
 * A field's refusal, carried on the schema.
 *
 * `code` and `hint` are read back by `parseBody` to build the same `ErrorDetail` the route used to
 * write inline; `description` is what a reader of the document sees. All three end up in the
 * generated JSON Schema, which is deliberate: a reference that names the error code a bad value
 * produces is more useful than one that only describes the happy path.
 */
interface Refusal {
    readonly code: string
    readonly hint: string
    readonly description: string
}

/** Attach a refusal. Split out so every field declares all three rather than some of them. */
function refuse<T extends z.ZodType>(schema: T, refusal: Refusal): T {
    return schema.meta({ ...refusal }) as T
}

/**
 * Annotate a field that has **no refusal of its own**, and say so by not giving it one.
 *
 * The distinction is not cosmetic. `sessionKey`, `stream` and `chunks` first carried
 * `code: "message_text_required"` because they sit in the same schema — so a bad `sessionKey` would
 * have reported a *text* error, which is a lie about which field is wrong and about what to do
 * next. A field with nothing specific to say falls through to `request_body_invalid`, which names
 * the path and points at the document. Borrowing a neighbour's code is worse than having none.
 *
 * Named `annotate` rather than the obvious `describe`, because `describe` is the test runner's
 * global in every file that would import this.
 */
function annotate<T extends z.ZodType>(schema: T, description: string): T {
    return schema.meta({ description }) as T
}

// ─── shared pieces ──────────────────────────────────────────────────────────────────────

/**
 * Who sent this, when it was not the token-holder.
 *
 * `kind` has a custom error rather than Zod's default, because the default ("Invalid option") would
 * drop two things the hand-written refusal carried: the nearest-match suggestion, and the sentence
 * explaining that this field *is* the trust boundary. There is no default value for the same
 * reason — `agent` fences the message and blocks mutating tools for the whole turn, `user` does
 * not, so an unknown value is refused rather than guessed at.
 */
export const SenderSchema = z
    .object({
        id: refuse(z.string().trim().min(1), {
            code: "sender_invalid",
            hint: 'Send { "from": { "id": "agent:ops-bot", "kind": "agent" } }, or omit it entirely for a turn the token-holder is sending itself.',
            description: "Stable identifier for the sender. Appears on the turn row and in events.",
        }),
        kind: refuse(
            z.enum(SENDER_KINDS, {
                error: (issue) => {
                    const got = typeof issue.input === "string" ? issue.input : undefined
                    const guess = got === undefined ? undefined : nearest(got, SENDER_KINDS)
                    return `from.kind must be one of: ${SENDER_KINDS.join(", ")}.${
                        guess === undefined ? "" : ` Did you mean "${guess}"?`
                    }`
                },
            }),
            {
                code: "sender_invalid",
                hint: 'This field decides the trust boundary — "agent" fences the message and blocks mutating tools for the turn, "user" does not — so there is no default and an unknown value is refused rather than guessed at. A turn the token-holder is sending itself omits "from".',
                description:
                    'The trust boundary. "agent" fences the text as data and blocks mutating tools for the whole turn.',
            },
        ),
        name: refuse(z.string().optional(), {
            code: "sender_invalid",
            hint: "A display name, shown beside the sender id. Omit it rather than sending an empty string.",
            description: "Human-readable name for the sender.",
        }),
    })
    .meta({
        description:
            "Attribution for a turn somebody other than the token-holder is sending. Omit for your own.",
    })

/**
 * `"none"` or an explicit `{channel, to}`.
 *
 * A bare channel id is deliberately not accepted: an API turn has no originating conversation, so
 * there is no recipient to infer from one — and a delivery to nobody is the failure this refusal
 * exists to prevent.
 */
export const DeliverSchema = refuse(
    z.union([z.literal("none"), z.object({ channel: z.string().min(1), to: z.string().min(1) })]),
    {
        code: "deliver_invalid",
        hint: 'A bare channel id is not enough on an API turn: the request has no originating conversation, so there is no recipient to infer. Send { "channel": "tg", "to": "12345" }, or "none" to read the reply from the event stream.',
        description: 'Where the reply goes. "none" leaves it on the event stream and in the store.',
    },
)

// ─── one schema per body ────────────────────────────────────────────────────────────────

/** `POST /v1/agents/:id/messages` */
export const MessageBody = z.object({
    text: refuse(z.string().trim().min(1), {
        code: "message_text_required",
        hint: 'Send { "text": "..." }. An empty turn would be billed for a full prompt and produce nothing.',
        description: "What to say to the agent.",
    }),
    sessionKey: annotate(
        z.string().min(1).optional(),
        "Which conversation this belongs to. Defaults to `api:default`.",
    ),
    deliver: DeliverSchema.optional(),
    from: SenderSchema.optional(),
    stream: annotate(
        z.boolean().optional(),
        "Stream the turn's events inline as SSE rather than returning a handle.",
    ),
    chunks: annotate(
        z.boolean().optional(),
        "Include per-token `model.chunk` frames. Off by default — the reader decides.",
    ),
})

/** `POST /v1/agents/:id/approvals/:approvalId` */
export const ApprovalBody = z.object({
    granted: refuse(z.boolean(), {
        code: "approval_decision_required",
        hint: 'Send { "granted": true } or { "granted": false }. There is no default: one direction would deny a call over a typo and the other would grant one, and neither is a decision anybody made.',
        description: "Whether the blocked tool call may proceed.",
    }),
})

/** `POST /v1/keys` */
/**
 * How far a minted key reaches. Every field optional; **all of them absent is an unscoped key**,
 * which is byte-identical to what `POST /v1/keys` has always produced.
 *
 * `expiresIn` is **relative going in and absolute coming back**. A client sending an absolute
 * instant would be asserting agreement with this server's clock, which is exactly the thing two
 * machines are worst at; seconds-from-now needs no agreement at all, and the response reports the
 * `expiresAt` this server computed so the caller can see what it decided.
 */
export const KeyScopeBody = z.object({
    agents: z.array(z.string().min(1)).optional().meta({
        code: "key_scope_agents_invalid",
        hint: 'Send { "agents": ["milo"] } — a list of agent ids. Omit it for a key that reaches every agent. An id naming no agent on this server is reported rather than silently matching nothing.',
        description: "Agent ids this key may reach. Absent means all of them.",
    }),
    sessions: z.string().min(1).optional().meta({
        code: "key_scope_sessions_invalid",
        hint: 'Send { "sessions": "team_42:" } — a session-key prefix, with an optional trailing "*". A prefix rather than a list, because the conversations this key will cover do not exist yet when it is minted.',
        description: "Session-key prefix. Absent means every session.",
    }),
    can: z
        .array(z.enum(["read", "chat", "write", "admin"]))
        .optional()
        .meta({
            code: "key_scope_can_invalid",
            hint: 'Send { "can": ["chat", "read"] }. The four are read (every GET), chat (send a message, answer an approval, stop a turn), write (schedules, phase, clearing a session) and admin (keys, provisioning, start/stop/reload). Absent means all four; an empty array means none, and is honoured as written.',
            description: "Capabilities this key may exercise. Absent means all four.",
        }),
    expiresIn: z.number().int().positive().optional().meta({
        code: "key_scope_expires_invalid",
        hint: 'Send { "expiresIn": 3600 } — whole seconds from now, as a number. Relative rather than an absolute instant, because that would need the caller and this server to agree about the clock; the response reports the absolute expiresAt this server computed.',
        description: "Seconds until this key stops authenticating. Absent means never.",
    }),
})

export const KeyBody = z.object({
    label: refuse(z.string(), {
        code: "key_label_required",
        hint: 'Send { "label": "my browser" }. A label is required rather than defaulted because it is the only thing distinguishing two credentials in a listing, and "key 2" is a name nobody can act on when deciding which to revoke.',
        description: "How this credential is shown in a listing. Required; see `keyLabelProblem`.",
    }),
    scope: KeyScopeBody.optional().meta({
        code: "key_scope_invalid",
        hint: 'Send { "scope": { "agents": ["milo"], "can": ["chat"] } }, or omit it entirely for a key that reaches everything — which is what every key minted before scopes existed does.',
        description: "Opt-in narrowing. Absent is an unscoped key.",
    }),
})

/** `POST /v1/agents/:id/sessions/:key/phase` */
export const PhaseBody = z.object({
    phase: refuse(z.string().min(1), {
        code: "phase_invalid",
        hint: "Send the name of a phase this agent's manifest declares. `GET /v1/agents/:id` lists them.",
        description: "The phase to move this session into.",
    }),
})

/** `POST /v1/agents/:id/stop` — the reason is optional and free text. */
export const StopBody = z.object({
    reason: refuse(z.string().optional(), {
        code: "agent_stop_invalid",
        hint: "A short note, recorded on the row and shown wherever the agent is reported as off.",
        description: "Why, for whoever reads the listing later.",
    }),
})

/**
 * `PATCH /v1/agents/:id/config`
 *
 * The **value is text**, exactly as it is at a terminal, and core's `parseSettingValue` reads it —
 * one parser for the person's two editors, which is what that function's own docstring asks for:
 * *"the two must not disagree about whether `["a", "b"]` is a list of two strings"*, one accepting it
 * and the other storing the literal characters. A browser sending real JSON loses nothing, because
 * `["a", "b"]` and `{k: v}` are valid in both languages; what it gains is that `40` means the number
 * on both surfaces and `tools.pinned: "exec"` cannot become a one-character tool list on either.
 *
 * `confirm` is the person's acknowledgement of the two edits whose only purpose is to stop a check
 * running — carried as a field rather than a query flag because it belongs to the edit it approves.
 */
export const ConfigBody = z.object({
    path: refuse(z.string().min(1), {
        code: "config_path_unknown",
        hint: "GET /v1/agents/:id/config lists every field this surface may change, with what each one does.",
        description:
            "A dotted path, exactly as it appears in the manifest — `tools.pinned`, `model.main.id`.",
    }),
    value: refuse(z.string(), {
        code: "config_value_unreadable",
        hint: 'Text, the way it is typed at a terminal: a bare word, a number, true or false, a list as ["a", "b"], or a map as {k: v}. Quote anything containing a colon or a "#".',
        description: "The new value, as text. Read by the same parser the `config` command uses.",
    }),
    confirm: annotate(
        z.boolean().optional(),
        "Required only for a field whose own row carries a `confirm` sentence. Absent is not consent.",
    ),
})

/**
 * `PATCH /v1/agents/:id/channels/:channelId` — connect, disconnect, or set the credential.
 *
 * Both fields optional and at least one required, which the route checks rather than the schema:
 * "send something" is a sentence, and Zod's version of it is a union whose error names neither
 * field. The credential is **write-only** — nothing reads one back, so there is no `GET` that could.
 */
export const ChannelPatchBody = z.object({
    enabled: annotate(
        z.boolean().optional(),
        "Switch the channel on or off. It takes effect at the agent's next start, because a channel is constructed at boot.",
    ),
    credential: refuse(z.string().min(1).optional(), {
        code: "channel_credential_unreadable",
        hint: "The value goes into the .env beside the manifest at 0600, under the variable that channel's own entry names. Send a non-empty string; an empty one fails the load exactly as a missing variable does.",
        description:
            "The channel's credential — a Telegram bot token. Never returned by any route; only whether it is set.",
    }),
})

/** `POST /v1/agents` — see the module comment for why the answers are not enumerated here. */
export const ProvisionBody = z.object({
    answers: refuse(
        z.record(
            z.string(),
            // The **value's** own refusal, so a wrong-typed answer reports "invalid" rather than
            // the record's "required". `metaAt` descends into a record's value type for this.
            refuse(z.string(), {
                code: "provision_answer_invalid",
                hint: "Answers arrive as strings from the terminal and from here, and are validated per step. Send the value as a string — including a boolean-looking choice, whose values are named in GET /v1/provision.",
                description: "One answer. Always text, whatever the step's type looks like.",
            }),
        ),
        {
            code: "provision_answers_required",
            hint: 'Send { "answers": { "name": "milo", … } }. Every step you leave out takes its default, exactly as `init --yes` does with flags; GET /v1/provision lists them.',
            description:
                "A subset of the wizard's steps, as strings. `GET /v1/provision` lists every step with its prompt, default and choices.",
        },
    ),
})

// ─── the one validator ──────────────────────────────────────────────────────────────────

/**
 * Parse a body against its schema, or build the refusal the route used to build by hand.
 *
 * The `code`, `hint` and `field` all come from the failing field's own metadata, so a route no
 * longer decides what a malformed body says — which is what stops nine routes drifting into nine
 * dialects of the same refusal. A field with no metadata falls back to a generic code, and that
 * fallback is deliberately ugly to read in a test: a schema shipped without a refusal is a missing
 * decision rather than a default.
 */
export function parseBody<TSchema extends z.ZodObject>(
    schema: TSchema,
    value: unknown,
):
    | { readonly ok: true; readonly value: z.output<TSchema> }
    | { readonly ok: false; readonly error: ErrorDetail } {
    // `?? {}` so a missing body is reported per *field* — "the body has no text" rather than "the
    // body is not an object", which is the sentence somebody sending `{}` needs.
    const result = schema.safeParse(value ?? {})
    if (result.success) return { ok: true, value: result.data }

    const issue = result.error.issues[0]
    const path = (issue?.path ?? []).filter((part) => typeof part === "string") as string[]
    const meta = metaAt(schema, path)

    /**
     * The fallback, written as a literal object so the spec guard can *see* it.
     *
     * That guard scans `packages/server/src` for `code: "…"` and demands every hit appear in the
     * wire spec's table — so `meta?.code ?? "request_body_invalid"` emitted a code the guard was
     * blind to. A documented-codes check that cannot see a code is the `includeHistory` shape:
     * correct when written, quietly incomplete ever after.
     */
    const generic: ErrorDetail = {
        code: "request_body_invalid",
        message:
            path.length === 0
                ? (issue?.message ?? "The request body is invalid.")
                : `${path.join(".")}: ${issue?.message}`,
        hint: "The field above is the one to fix. GET /v1/openapi.json describes every body this server accepts, including the error code each field produces.",
    }

    return {
        ok: false,
        error: {
            ...generic,
            ...(meta?.code === undefined ? {} : { code: meta.code }),
            ...(meta?.hint === undefined ? {} : { hint: meta.hint }),
            ...(path.length === 0 ? {} : { field: path.join(".") }),
        },
    }
}

/**
 * The refusal declared nearest the failing field, walking **down** the path.
 *
 * Reading `shape[path[0]]` alone was wrong and the test for `from.kind` caught it: the metadata is
 * on `kind`, and the first segment is `from`, whose own meta is a description of the object — so
 * the hint fell back to the generic one and the sentence about the trust boundary was lost. The
 * walk keeps the **last** refusal it saw, so a nested field with none still inherits its parent's
 * rather than dropping to the generic: an imprecise hint that is about the right thing beats a
 * correct one that is about nothing.
 *
 * Optionals are unwrapped because a field is usually declared `.optional()` and the metadata sits
 * on the inner type. Anything this cannot descend into — a union, a record — stops the walk and
 * keeps whatever it had, which is the honest answer rather than a guess about which branch failed.
 */
function metaAt(schema: z.ZodType, path: readonly string[]): Partial<Refusal> | undefined {
    let current: z.ZodType | undefined = schema
    let best = readRefusal(schema)

    for (const key of path) {
        current = descend(current, key)
        if (current === undefined) break
        best = readRefusal(current) ?? best
    }
    return best
}

/** A field's own `code`/`hint`, if it declared any. */
function readRefusal(schema: z.ZodType | undefined): Partial<Refusal> | undefined {
    const meta = schema?.meta() as Partial<Refusal> | undefined
    if (meta?.code === undefined && meta?.hint === undefined) return undefined
    return meta
}

/**
 * One step into an object's shape — or into a record's value type.
 *
 * The record case is not incidental. `ProvisionBody`'s `answers` is a `Record<string, string>`, so
 * a non-string value fails at `answers.<step>` — and without descending, the walk stopped at
 * `answers` and reported **`provision_answers_required`** for a value that was present and merely
 * the wrong type. "Required" for a wrong-typed value is the same lie as a `sessionKey` error
 * claiming the text is missing.
 */
function descend(schema: z.ZodType | undefined, key: string): z.ZodType | undefined {
    const inner = unwrap(schema)
    const shape = (inner as unknown as { shape?: Record<string, z.ZodType> } | undefined)?.shape
    if (shape?.[key] !== undefined) return unwrap(shape[key])
    // A record has one value type for every key, so the key itself does not narrow anything.
    const valueType = (inner as unknown as { def?: { valueType?: z.ZodType } } | undefined)?.def
        ?.valueType
    return valueType === undefined ? undefined : unwrap(valueType)
}

/** `.optional()` and friends wrap the type the metadata is on. */
function unwrap(schema: z.ZodType | undefined): z.ZodType | undefined {
    let current = schema
    for (let guard = 0; guard < 8 && current !== undefined; guard += 1) {
        const next = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType
        if (next === undefined) return current
        current = next
    }
    return current
}
