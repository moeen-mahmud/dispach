/**
 * Every manifest field a *surface* may change, in one table, with who may change it.
 *
 * ## Why one table and not two
 *
 * There are two editors of `agent.yaml`: `config_set`, which the agent calls, and the `config`
 * command, which a person runs. They do not have the same authority — decision 11.29 draws the line,
 * and it is a real one: *enabling a capability answers "what may I do"; a write root, an allowlist and
 * a bind address answer "who and where", and those are the person's by definition*. An agent that
 * could widen its own inbound gate could be talked into widening it by the very message it is reading.
 *
 * The temptation is therefore two lists. That is the drift `session-commands.ts` was written to end:
 * the palette is generated from `COMMANDS` precisely so a flag added in one place cannot go missing in
 * the other. A hand-kept second list of settings would diverge on the first field either surface grew.
 *
 * So the *paths* live here once, and what differs is carried per row rather than per list.
 *
 * ## What is not here
 *
 * **Policy.** This table says a field exists and who owns it; it does not decide a particular edit.
 * The agent's refusals are `floorRefusal` in `tools-system/config.ts`, because two of them depend on
 * the *value* (`onMutate: allow` is refused where `onMutate: confirm` is fine) and one depends on a key
 * hidden anywhere inside it. Those are the agent's policy and they stay with the agent's tool. The
 * person's confirmations are `confirm` below, because the same two edits are theirs to make and worth
 * being sure about.
 *
 * A row's presence is not permission. `agentListed` decides whether `config_read` mentions it —
 * `tools.policy.deny` is listed *and* floored on purpose, so the agent's refusal names the real reason
 * instead of "not a setting", an ordering bug that has already happened once with `onMutate`.
 */

/** A field, its meaning, and who owns it. */
export interface Setting {
    /** Dotted, as it appears in the file. `[]` marks a list whose entries hold the field. */
    readonly path: string
    /**
     * What it does, addressed to a person reading a table.
     *
     * Kept free of "not yours to decide" phrasing: that clause is true of the agent and false of the
     * reader of `config list`, who is exactly the person it defers to.
     */
    readonly means: string
    /**
     * Appended by `config_read`, where the reader is the agent.
     *
     * The refusals belong here rather than in `means` for the reason above, and the prose is carried
     * verbatim from the tool that measured it: the whole summary is 549 tokens against a 2,000-token
     * observation budget, having once been the entire 2,766-token manifest.
     */
    readonly toAgent?: string
    /**
     * Whether `config_read` lists it at all.
     *
     * False for fields only a person ever sets. Not the same as "the agent may set it": a floored path
     * has to stay listed or its refusal is answered by the settable check first, with the wrong reason.
     */
    readonly agentListed: boolean
    /**
     * Why a person is asked to confirm, when they are.
     *
     * Only for the two edits whose purpose is to stop a check running. Everything else applies without
     * ceremony — a confirmation that fires on `limits.maxSteps` is one nobody reads by the time it
     * fires on the write gate.
     */
    readonly confirm?: string
    /**
     * Set by something other than a dotted path, and what instead.
     *
     * `allowFrom` is a key inside a list *entry*, and the source editor matches `key:` at an indent —
     * it cannot index a sequence. Rewriting the whole `channels` list to change one handle is the
     * dead-end shape this surface exists to remove, so the field has its own action, which also gets
     * to validate the handle against the service that issues it.
     */
    readonly via?: string
}

export const SETTINGS: readonly Setting[] = [
    {
        // The list is the *current* set. It said "now, memory_write" for two phases after
        // `artifact_read` landed, which a real `config list` showed sitting in the value beside a
        // description that did not mention it — the cheapest kind of wrong documentation to find and
        // the easiest to leave.
        path: "tools.local",
        means: "built-in tools: now, memory_write, artifact_read",
        agentListed: true,
    },
    {
        path: "tools.providers",
        means: "where tools come from, as a map — {system: {}} for shell and files, {web: {backend: tavily, apiKeyEnv: TAVILY_API_KEY}} for the internet. Several at once",
        toAgent: "A writeRoots key inside is refused",
        agentListed: true,
    },
    {
        path: "tools.pinned",
        means: "the tools from those providers this agent may call",
        agentListed: true,
    },
    {
        path: "tools.policy.allow",
        means: 'rules permitting a call: "exec", or narrower like "exec(git *)". Also what lets a mutating tool run in a turn that has read untrusted content',
        agentListed: true,
    },
    {
        path: "tools.policy.deny",
        means: "rules refusing a call. Beats any allow rule",
        toAgent:
            "Replacing these is refused: it is the one edit whose only purpose is to remove a restriction someone set",
        agentListed: true,
        confirm:
            "Deny rules are the restrictions that beat every allow rule. Replacing them removes whatever was deliberately put out of reach.",
    },
    {
        path: "tools.policy.mode",
        means: "allow | ask | deny — for calls no rule mentions",
        agentListed: true,
    },
    {
        path: "tools.untrusted.onMutate",
        means: "refuse | confirm | allow — what happens when a tool that changes something is asked for in a turn that has read outside content",
        toAgent: 'Cannot be set to "allow"',
        agentListed: true,
        confirm:
            'Setting this to "allow" turns off the check that stops text from outside the conversation driving a tool that changes things. A fetched page that says "now delete the backups" would be acted on.',
    },
    {
        path: "tools.dialect",
        means: "nlt | native — how tool calls are written",
        agentListed: true,
    },
    { path: "model.main.id", means: "the model this agent runs on", agentListed: true },
    { path: "model.main.temperature", means: "0 to 2", agentListed: true },
    { path: "limits.maxSteps", means: "tool calls allowed in one turn", agentListed: true },
    {
        path: "limits.toolTimeoutMs",
        means: "how long any single tool may take",
        agentListed: true,
    },
    {
        path: "context.observationMaxTokens",
        means: "how much of a tool's output reaches the model",
        agentListed: true,
    },
    {
        path: "channels",
        means: "how people reach this agent, as a list — [{type: telegram, id: tg, tokenEnv: TELEGRAM_BOT_TOKEN, mode: longpoll}]. The token goes in the .env",
        toAgent:
            "The token itself goes in the .env, which only a person can write. allowFrom is refused here: who may talk to you is not yours to decide",
        agentListed: true,
    },
    {
        path: "delivery",
        means: "where a reply goes when a turn has no origin — {default: tg}. Names a channel id, not a channel type",
        agentListed: true,
    },
    {
        // Settable for the same reason `channels` is: asked to run something every morning, an agent
        // that cannot write this can only describe the YAML and hand it back — which is the "make
        // your owner do the tedious half" failure `config_read` exists to end. Measured live before
        // this row existed: asked to send a message every five minutes, the agent correctly reported
        // that `schedules` was "not one of the settings I can change from a conversation", and there
        // the request stopped.
        //
        // `deliver.to` is deliberately NOT floored, and it is the one field here worth a second
        // thought: it is the first place the agent chooses a *recipient* rather than a channel. It
        // stays open because a schedule with no addressee is not a feature, and because the message
        // still leaves through a channel a person configured with a token only a person can supply —
        // but if that ever needs closing, it closes the way `allowFrom` did, by key inside the value.
        path: "schedules",
        means: 'what runs unattended, as a list — [{id, kind: cron|every|at, expr, task, deliver}]. expr is a 5- or 6-field cron, a duration like 15m, or an ISO instant; deliver is {channel, to} or the literal "none"',
        // `deliver.to` gets a sentence of its own, next to the field being filled in, because that
        // is where a small model looks. Measured: an agent copied the @handle out of `allowFrom` —
        // the obvious move, since that is the recognisable form — and every scheduled send came back
        // `Bad Request: chat not found` while the schedule itself fired perfectly every 15 minutes.
        // Naming the failing form is what makes the right one findable; describing only the right
        // one leaves the wrong one looking equally plausible.
        toAgent:
            "Only `serve` fires these; under `run` they are validated and listed and no timer starts. deliver.to is the address a reply is *sent* to — on Telegram the numeric chat id, never an @handle, which addresses a channel and not a person. It is the id inbound messages arrive on, so read it off your own session keys (tg:<id>); allowFrom holds handles and confers nothing here. Set role to name a model other than main. The whole list is replaced, so read it first",
        agentListed: true,
    },
    {
        path: "server.enabled",
        means: "true | false — serve the HTTP API on 127.0.0.1",
        toAgent: "host and tokenEnv are refused: binding anywhere reachable is not yours to decide",
        agentListed: true,
    },
    { path: "server.port", means: "port for the HTTP API", agentListed: true },

    // ── the person's, and only ever the person's ────────────────────────────────────────────────
    //
    // Not listed to the agent: unlike the two floored paths above, there is no refusal worth
    // reaching. `config_read` naming a field the agent can never set would be an invitation to try,
    // and the reason it cannot is not something a better-phrased error improves.
    {
        path: "channels[].allowFrom",
        means: "who may talk to this agent through a channel. Empty or absent refuses everyone — a bot that is connected, healthy and answering nobody is almost always this",
        agentListed: false,
        via: "config allow",
    },
    {
        path: "server.host",
        means: "the address the HTTP API binds. 127.0.0.1 is local only; anything else is reachable from the network",
        agentListed: false,
    },
    {
        path: "server.tokenEnv",
        means: "the env var holding the bearer token the API requires. Without it the API is unauthenticated",
        agentListed: false,
    },
    {
        path: "tools.providers.<id>.writeRoots",
        means: "the directories a file tool may write to, for that provider. Nothing outside them is writable — and this binds file tools only, never exec, which carries its target inside a shell string",
        agentListed: false,
    },
]

/** Exact-path lookup. `undefined` for anything no surface may set. */
export function settingByPath(path: string): Setting | undefined {
    return SETTINGS.find((entry) => entry.path === path)
}

/**
 * Paths `config_read` lists and `config_set` accepts.
 *
 * Derived rather than written down again — the pair had been two hand-kept lists for one commit and
 * that is exactly long enough for them to disagree.
 */
export const AGENT_SETTABLE_PATHS: readonly string[] = SETTINGS.filter(
    (entry) => entry.agentListed,
).map((entry) => entry.path)

/** Paths `config set` accepts: everything with a real dotted path, whoever owns it. */
export const PERSON_SETTABLE_PATHS: readonly string[] = SETTINGS.filter(
    (entry) => entry.via === undefined && !entry.path.includes("<") && !entry.path.includes("["),
).map((entry) => entry.path)
