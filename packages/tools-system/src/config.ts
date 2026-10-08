/**
 * `config_read` and `config_set` — the agent reading and changing its own `agent.yaml`.
 *
 * ## Why this exists at all
 *
 * Because the alternative is an agent that is illiterate about itself. Asked to do something it has
 * no tool for, an agent without these can only say "I can't" — and a person then has to work out
 * which field, in which file, with which value. The agent already knows what it needs; the only thing
 * missing was a way to say so and a way to do it. That is Moeen's requirement, and it is the right
 * one: a runtime whose own configuration is opaque to the thing being configured is a runtime that
 * makes its owner do the tedious half.
 *
 * ## Why not just let `file_write` at it
 *
 * `agent.yaml` stays in the protected set, and this is the sanctioned route instead, for three
 * reasons that all have the same shape — a whole-file overwrite cannot be checked, and a targeted
 * change can:
 *
 * 1. **Validation.** A set is applied to a parsed document, re-validated against the real schema, and
 *    written only if it still loads. A `file_write` that produces an invalid manifest bricks the agent
 *    on next boot, and the model would report success.
 * 2. **Comments survive.** `parseDocument` keeps them; a regenerated file does not. The manifest is
 *    the file a person reads to understand their agent, and its comments are most of that.
 * 3. **A rule can address it.** `policyArg: "path"` is the *manifest* path, so
 *    `deny: ["config_set(tools.policy*)"]` is expressible. Against `file_write` the only available
 *    rule is "may not write agent.yaml at all".
 *
 * ## The escalation, stated rather than buried
 *
 * `config_set` can add to `tools.policy.allow` and pin new tools. That is privilege escalation, it
 * persists across restarts, and it is exactly what makes the tool useful. Three things bound it:
 *
 * - It is `mutating`, so the write gate applies: a turn that has read untrusted content cannot call it
 *   without a rule or an approval.
 * - A `deny` rule can put the security fields out of reach entirely.
 * - **The floor below.** Two edits are refused whatever the policy says, because their only purpose is
 *   to disable a guard: removing entries from `tools.policy.deny`, and setting
 *   `tools.untrusted.onMutate` to `allow`. A guard the agent can switch off on request is not a guard.
 *   Adding tools and adding allow rules — the things a person actually asks for — are unaffected.
 *
 * That floor is a judgement call rather than a requirement anyone stated, and it is narrow on purpose:
 * everything in the direction of "help me enable this" works, and only the two edits in the direction
 * of "stop checking" do not.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
    AGENT_SETTABLE_PATHS,
    editManifest,
    isHarnessError,
    type MediaProviderFactory,
    parseSettingValue,
    SETTINGS,
    type Tool,
    type ToolHandler,
    type ToolProviderFactory,
} from "@dispach/core"
import { isMap, isSeq, parseDocument, stringify } from "yaml"
import {
    configInvalid,
    configPathUnknown,
    configReadFailed,
    configRefused,
    configValueUnreadable,
} from "./errors.ts"
import { SYSTEM_PROVIDER_ID } from "./paths.ts"

export interface ConfigOptions {
    /** The agent's own directory. The manifest is `agent.yaml` inside it. */
    readonly agentDir: string
    /** Overridden in tests; the runtime always uses the manifest the agent was loaded from. */
    readonly file?: string
    /** Provider factories, so a `tools.providers` edit the provider would refuse is refused. */
    readonly providers?: Readonly<Record<string, ToolProviderFactory>>
    /** Media provider factories, so a `media` edit naming a provider that does not exist is refused. */
    readonly mediaProviders?: Readonly<Record<string, MediaProviderFactory>>
}

/**
 * The settable list moved to `core/manifest/settings.ts`, and the prose with it.
 *
 * Two surfaces edit this file — this tool and the `config` command — and they do not have the same
 * authority. Keeping the paths in one table is what stops the two lists disagreeing on the first field
 * either one grows; what stayed here is the *policy*, below, because two of its three refusals depend
 * on the value and one on a key hidden anywhere inside it, and none of that is a person's rule.
 *
 * `toAgent` on a row carries the clause this reader needs and the person's table does not — "cannot be
 * set to allow", "allowFrom is refused here". The wording is verbatim, because the whole summary was
 * measured at 549 tokens against a 2,000-token observation budget.
 */
const AGENT_ROWS = SETTINGS.filter((entry) => entry.agentListed)

/**
 * Edits refused whatever the policy says.
 *
 * All in the direction of "stop checking", or of widening reach. Every other field above, including
 * the ones that grant new powers, is settable — granting a capability is what a person asks for;
 * disabling a check is not, and neither is deciding who may reach the agent or from where. That
 * second category is `writeRoots`' rule generalised: enabling a tool answers *what may I do*, and a
 * write root, an allowlist and a bind address all answer *who and where* — the person's by
 * definition.
 *
 * **Checked before the settable list, not after.** A floored path is deliberately absent from that
 * list, so a settable-first order would refuse it as "not a setting" and the reason a person actually
 * needs would never be printed. That ordering bug already happened once with `onMutate`, where the
 * floor turned out to be unreachable and the one value that must be refused was refused by accident.
 *
 * `value` is optional because two of the three depend only on the path, and those have to fire before
 * the value is even parsed.
 */
function floorRefusal(path: string, value?: unknown): string | undefined {
    const key = path.toLowerCase()
    const ALLOW_FROM =
        "who is allowed to talk to you is not yours to decide. It is the inbound gate, so an agent that could widen it could be talked into widening it by the very message it is reading — put the handle in agent.yaml yourself; a refused message prints the exact line"
    const SERVER_REACH =
        "where the API listens, and what authenticates it, is not yours to decide — the same reason writeRoots is refused. Enabling it on 127.0.0.1 is settable; binding anywhere reachable is a person's call"
    const WRITE_ROOTS =
        "widening where you may write is not yours to do. Asked to create a file, an agent granted itself the whole home directory and then wrote there — which is what this refusal exists to prevent"

    // Any segment, either spelling. `writeRoots` moved from `tools.providerConfig` to
    // `tools.providers.system` when the map replaced the scalar, and a floor pinned to the old path
    // would have been a floor with a new way round it — the setting the agent may not touch is the
    // one whose location changed.
    if (key.split(".").includes("writeroots")) return WRITE_ROOTS
    // And not through the parent, either: `tools.providers` is settable so the agent can turn on the
    // web provider when asked, which means the *value* is a place a writeRoots list could hide.
    if (key.startsWith("tools.providers") && containsKey(value, "writeroots")) return WRITE_ROOTS
    // What a command's environment holds is containment too (pilot.9): an agent that could set
    // `env: inherit` back could hand its own shell every secret the scrub was there to keep out.
    const CHILD_ENV =
        "what your commands can see of the environment is not yours to widen. The scrub keeps the runtime's credentials out of anything you run; a person lists a variable your commands need"
    // Where a provider sends its requests (pilot.10): an agent that could set a baseUrl could point
    // Composio or the web backends at a server of its choosing and hand it the token and every query.
    // Composio's was settable this way before web had one.
    const API_ADDRESS =
        "where a provider sends its requests, and so its credentials, is not yours to decide. A person sets a provider's baseUrl"
    if (key.startsWith("tools.providers") && key.split(".").includes("baseurl")) return API_ADDRESS
    if (key.startsWith("tools.providers") && containsKey(value, "baseurl")) return API_ADDRESS
    // Which skills may run code (pilot.14): an agent that could add a name could make any skill it was
    // handed, a community one or one a person uploaded, run its scripts.
    const SKILL_TRUST =
        "which skills may run code is not yours to decide. A person lists them in skills.trusted"
    if (key === "skills.trusted" || (key === "skills" && containsKey(value, "trusted"))) {
        return SKILL_TRUST
    }
    // Where the file tools may read (pilot.14): an agent that could turn `confineReads` off could read
    // the other agents' notes the setting was there to keep out of reach.
    const READ_REACH =
        "which files you may read is not yours to widen. A person sets tools.providers.system.confineReads"
    if (key.startsWith("tools.providers") && key.split(".").includes("confinereads"))
        return READ_REACH
    if (key.startsWith("tools.providers") && containsKey(value, "confinereads")) return READ_REACH
    if (key.startsWith("tools.providers") && key.split(".").includes("env")) return CHILD_ENV
    if (key.startsWith("tools.providers") && containsKey(value, "env")) return CHILD_ENV
    // Same two shapes as `writeRoots`: the path itself, and the key hidden inside a value. `channels`
    // is settable so the agent can set up a bot when asked, which makes its value a place an
    // allowFrom could ride along in.
    if (key.split(".").includes("allowfrom")) return ALLOW_FROM
    if (key === "channels" && containsKey(value, "allowfrom")) return ALLOW_FROM
    // `server` is not settable as a whole — only `enabled` and `port` — but the floor names the two
    // fields rather than relying on that, so moving one into a settable parent later cannot open it.
    if (key === "server.host" || key === "server.tokenenv") return SERVER_REACH
    if (key === "server" && (containsKey(value, "host") || containsKey(value, "tokenenv"))) {
        return SERVER_REACH
    }
    if (key === "tools.policy.deny") {
        return "removing or replacing the deny rules is the one edit whose only purpose is to remove a restriction someone deliberately set"
    }
    if (
        value !== undefined &&
        key === "tools.untrusted.onmutate" &&
        String(value).toLowerCase() === "allow"
    ) {
        return 'setting the write gate to "allow" turns off the check that stops text from outside the conversation driving a tool that changes things'
    }
    return undefined
}

/** Is `name` a key anywhere in this value, at any depth? Case-insensitive; arrays included. */
function containsKey(value: unknown, name: string): boolean {
    if (Array.isArray(value)) return value.some((entry) => containsKey(entry, name))
    if (typeof value !== "object" || value === null) return false
    return Object.entries(value as Record<string, unknown>).some(
        ([key, nested]) => key.toLowerCase() === name || containsKey(nested, name),
    )
}

function manifestPath(options: ConfigOptions): string {
    return options.file ?? join(options.agentDir, "agent.yaml")
}

export const CONFIG_READ_SPEC: Tool["spec"] = {
    slug: "config_read",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Reads this agent's own configuration and lists what can be changed in it.",
    whenToUse:
        "you need to know how you are configured, or what would have to change for you to do something you currently cannot — which tool to enable, which permission rule to add",
    whenNotToUse:
        "for anything that is not your own configuration; an ordinary file is file_read. You do not need to read it before every answer, only when the question is about how you are set up",
    mutating: false,
    trust: "trusted",
    trustReason:
        "The manifest is the runtime's own file, written and validated by the runtime. Fencing it would put a warning about strangers around the agent's own settings.",
    policyArg: "path",
    tags: ["read", "config"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description:
                    "A single setting, such as tools.pinned. Omit to see the whole configuration and every setting that can be changed.",
            },
        },
    },
}

export const CONFIG_SET_SPEC: Tool["spec"] = {
    slug: "config_set",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Changes one setting in this agent's own configuration.",
    whenToUse:
        "the person asks you to change how you are configured, or asks you to do something that needs a tool or permission you do not have and tells you to go ahead and enable it",
    whenNotToUse:
        "on your own initiative. Say what you would change and why, and let them ask — and never to remove a restriction someone set, which is refused anyway. The change takes effect when the agent next starts, not in this conversation",
    mutating: true,
    trust: "trusted",
    trustReason:
        "It reports the old and new value of one setting the runtime just validated, and nothing else.",
    policyArg: "path",
    tags: ["write", "config"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description:
                    "The setting, as a dotted path: tools.pinned, tools.policy.allow, model.main.temperature. config_read with no path lists them.",
            },
            value: {
                type: "string",
                description:
                    'The new value, written the way it would appear in the file: a bare word, a number, or a list as ["a", "b"]. Replaces what is there.',
            },
        },
        required: ["path", "value"],
    },
}

/**
 * Read a value the model wrote. `parseSettingValue`'s rules, this tool's error.
 *
 * The parsing is core's so the two surfaces cannot disagree about whether `["a", "b"]` is a list; the
 * refusal stays here because it is prose addressed to a model, and it is the only explanation it will
 * get for why nothing happened.
 */
export function parseValue(raw: string): unknown {
    try {
        return parseSettingValue(raw)
    } catch (cause) {
        throw configValueUnreadable(raw, cause instanceof Error ? cause.message : String(cause))
    }
}

export function configReadHandler(options: ConfigOptions): ToolHandler {
    return async (args) => {
        const file = manifestPath(options)
        let source: string
        try {
            source = await readFile(file, "utf8")
        } catch (cause) {
            throw configReadFailed(file, String(cause))
        }

        const asked = typeof args.path === "string" ? args.path.trim() : ""
        if (asked !== "") {
            const doc = parseDocument(source)
            const value = doc.getIn(asked.split("."), false)
            if (value === undefined) {
                return `${asked} is not set in this configuration. It can be — see config_read with no path for the full list.`
            }
            return `${asked}:\n${stringify(isMap(value) || isSeq(value) ? value.toJS(doc) : value).trimEnd()}`
        }

        // A summary with the current values, not the file.
        //
        // Returning the whole manifest was the obvious thing and measured at 2,766 tokens against a
        // 2,000-token observation budget — so every call was middle-cut, and a real model read it
        // three times in one turn trying to find what the cut had removed. Eight thousand output
        // tokens to change one line. What it actually needs is "what can I change, and what is it
        // now", which is a fifth the size and directly actionable.
        const doc = parseDocument(source)
        const rows = AGENT_ROWS.map((entry) => {
            const current = doc.getIn(entry.path.split("."), false)
            // Lists inline as `[a, b]` rather than as block YAML flattened onto one line, which
            // renders `- a - b` and reads as a subtraction.
            const value = isMap(current) || isSeq(current) ? current.toJS(doc) : current
            const shown =
                value === undefined || value === null
                    ? "(not set)"
                    : Array.isArray(value)
                      ? // `String(entry)` on an object writes `[object Object]` — the same defect
                        // this file's YAML writer had for a map value and then again for a sequence
                        // of maps. `channels` is a list of objects, so it landed here third.
                        //
                        // JSON for those, not flattened YAML: collapsing a block's newlines produced
                        // `[type: telegram id: tg tokenEnv: …]`, which reads as one run-on string
                        // rather than as fields. JSON is what the model writes back anyway.
                        `[${value.map((entry) => (typeof entry === "object" && entry !== null ? JSON.stringify(entry) : String(entry))).join(", ")}]`
                      : stringify(value).trim()
            const means =
                entry.toAgent === undefined ? entry.means : `${entry.means}. ${entry.toAgent}`
            return `- ${entry.path} = ${shown}\n    ${means}`
        }).join("\n")

        return [
            `This agent is ${doc.get("name") ?? doc.get("id")}, configured at ${file}.`,
            "",
            "Settings config_set can change, with their current values:",
            rows,
            "",
            ...contextFiles(doc),
            "Anything not on this list is not settable from a conversation. A change takes effect when the agent next starts, not in the current conversation.",
            "",
            "Some edits are refused whatever the rules say. Removing a check: replacing tools.policy.deny, or setting tools.untrusted.onMutate to allow. Deciding reach: a writeRoots list anywhere, the system provider's env, any provider's baseUrl, a channel's allowFrom, and server.host or server.tokenEnv. Enabling a capability is what a person asks you for; where you may write, who may talk to you, and what address you listen on are theirs — name what you need and why, and let them add it.",
            "",
            `The whole file, comments and all, is at ${file} — read it with file_read if that tool is enabled, or ask the person to open it.`,
        ].join("\n")
    }
}

/**
 * The workspace files the manifest loads, read-only (pilot.15, VelaCrew). Told "check your config",
 * a model called this tool, found no context section, and concluded that nothing loaded its files,
 * trusting the tool over the files' own text in its prompt. So the section names them and says
 * where they already are. Not settable here: which files define the agent is the person's.
 */
function contextFiles(doc: ReturnType<typeof parseDocument>): string[] {
    const list = (path: string[]): string[] => {
        const value = doc.getIn(path, false)
        const plain = isMap(value) || isSeq(value) ? value.toJS(doc) : value
        if (Array.isArray(plain)) return plain.map(String)
        return typeof plain === "string" && plain !== "" ? [plain] : []
    }
    const rows = (
        [
            ["context.soul.file", list(["context", "soul", "file"])],
            ["context.static", list(["context", "static"])],
            ["context.files", list(["context", "files"])],
            ["context.volatile", list(["context", "volatile"])],
            ["context.reminder", list(["context", "reminder"])],
        ] as const
    )
        .filter(([, names]) => names.length > 0)
        .map(([path, names]) => `- ${path} = [${names.join(", ")}]`)
    if (rows.length === 0) return []
    return [
        "Context files (read-only here). These files are loaded into my instructions every turn, under their names, so I never need to read them; volatile ones only in private conversations:",
        ...rows,
        "",
    ]
}

export function configSetHandler(options: ConfigOptions): ToolHandler {
    return async (args, context) => {
        const file = manifestPath(options)
        const path = typeof args.path === "string" ? args.path.trim() : ""
        const raw = typeof args.value === "string" ? args.value : String(args.value ?? "")

        // The floor first. Two of its three entries depend only on the path, and they name paths that
        // are deliberately not in the settable list — so checking the list first would answer "not a
        // setting" and swallow the reason that matters.
        const pathFloor = floorRefusal(path)
        if (pathFloor !== undefined) throw configRefused(path, pathFloor)

        if (!AGENT_SETTABLE_PATHS.includes(path)) {
            throw configPathUnknown(path, AGENT_SETTABLE_PATHS)
        }

        const value = parseValue(raw)

        const valueFloor = floorRefusal(path, value)
        if (valueFloor !== undefined) throw configRefused(path, valueFloor)

        // Placing, validating and writing is `editManifest` — one writer for every surface, because
        // the three that existed made the guarantee depend on which caller you were. Its errors are
        // translated rather than propagated: this reader is a model, and the prose it gets back is the
        // only explanation it will have of why nothing happened.
        let result: Awaited<ReturnType<typeof editManifest>>
        try {
            result = await editManifest({
                file,
                path: path.split("."),
                value,
                ...(options.providers === undefined ? {} : { providers: options.providers }),
                ...(options.mediaProviders === undefined
                    ? {}
                    : { mediaProviders: options.mediaProviders }),
            })
        } catch (cause) {
            // `isHarnessError`, not `instanceof`: this package and core are separate copies in a
            // bundle, and a class check across them fails silently (CLAUDE.md).
            if (isHarnessError(cause) && cause.code === "manifest_edit_unreadable") {
                throw configReadFailed(file, String(cause.cause ?? cause.message))
            }
            if (isHarnessError(cause) && cause.code === "manifest_edit_invalid") {
                // The detail after the colon; the sentence around it is written for a person.
                const detail = cause.message.slice(cause.message.indexOf(": ") + 2)
                throw configInvalid(path, raw, detail)
            }
            // A provider refusing its own config (a malformed MCP server): its sentence and hint are
            // the explanation the model has, so they reach it rather than a bare code.
            if (isHarnessError(cause)) {
                throw configInvalid(path, raw, `${cause.message} ${cause.hint ?? ""}`.trim())
            }
            throw cause
        }

        const wasSet = result.before !== undefined
        // A pin takes effect now where it can (pilot.14): the turn adds what a provider resolves from
        // its cache, a slug `composio_search` just found, and queues a reload for the rest. Where no
        // turn can take it, the old sentence stands, and it is still true.
        const pinned =
            path === "tools.pinned" && Array.isArray(value) && context.pinTools !== undefined
                ? await context.pinTools(value.map(String))
                : undefined
        const effect =
            pinned === undefined
                ? "The configuration still validates. This takes effect when the agent next starts — nothing in the current conversation changes, so do not try the new tool yet."
                : pinned.length > 0
                  ? `The configuration still validates. Usable now, in this conversation: ${pinned.join(", ")}. Anything else listed here works from the person's next message, once the agent reloads after this turn.`
                  : "The configuration still validates. The new tools work from the person's next message: the agent reloads once this turn ends, with no restart. Tell them it is ready for their next message; do not try the tool in this turn."
        return [
            `Set ${path} in ${file}.`,
            wasSet ? `It was: ${stringify(result.before).trim()}` : "It was not set before.",
            `It is now: ${stringify(value).trim()}`,
            "",
            effect,
            ...pendingSecrets(result.manifest, value),
        ].join("\n")
    }
}

/**
 * The env variables a change has just made load-bearing, and that only a person can supply.
 *
 * Without this the flow has a trap in it: an agent asked to set up Telegram writes a channel naming
 * `TELEGRAM_BOT_TOKEN`, reports success, asks for a restart — and the restart *fails to load*,
 * because the factory reads that variable at boot. The agent cannot fix it either: `.env` is a
 * protected path, deliberately, since it holds every secret the agent has.
 *
 * So the write is allowed and the debt is named in the same breath. Allowed rather than refused
 * because the alternative is a chicken and egg — a person is not going to put a token in a `.env`
 * for a channel nobody has declared yet.
 */
function pendingSecrets(manifest: { channels?: readonly unknown[] }, written: unknown): string[] {
    // Only for a write that could have introduced one. A note about bot tokens on every
    // `limits.maxSteps` change is a note nobody reads.
    if (!containsKey(written, "tokenenv") && !containsKey(written, "apikeyenv")) return []

    const names = new Set<string>()
    for (const channel of manifest.channels ?? []) {
        const env = (channel as { tokenEnv?: unknown }).tokenEnv
        if (typeof env === "string" && env !== "") names.add(env)
    }
    if (names.size === 0) return []

    return [
        "",
        `This will NOT start until ${[...names].join(" and ")} ${names.size === 1 ? "is" : "are"} set in the .env beside the manifest — the value is read at boot, and a missing one fails the load rather than the first message. You cannot write that file; it is protected because it holds every secret here. Tell the person the variable name and where it goes.`,
    ]
}

export function configTools(options: ConfigOptions): readonly Tool[] {
    return [
        { spec: CONFIG_READ_SPEC, handler: configReadHandler(options) },
        { spec: CONFIG_SET_SPEC, handler: configSetHandler(options) },
    ]
}

/**
 * For the "not enabled" hint and for tests. Re-exported from core rather than derived again — the
 * derivation is what made these two lists able to disagree in the first place.
 */
export const SETTABLE_PATHS: readonly string[] = AGENT_SETTABLE_PATHS
