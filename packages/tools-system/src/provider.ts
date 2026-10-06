/**
 * The system `ToolProvider`.
 *
 * Everything here is local, so `resolve()` is synchronous in everything but its signature: there is
 * no cache, no network, and no `refresh()`. That is the whole reason this can be a provider rather
 * than a set of built-ins — hard rule 4 forbids network I/O before `runtime.ready`, and a provider
 * with nothing to fetch has nothing to defer.
 *
 * ## Why these are not built into core
 *
 * Core is what an embedder runs *other people's* agents on — VelaOps provisions a container per
 * agent. A shell tool in core is a shell tool every provisioned agent has, with no way for the
 * platform to decline it. As a package it is a line in the embedder's provider table: present in
 * `dispach run`, absent wherever it should be.
 *
 * ## Trust
 *
 * Every tool declares its trust explicitly rather than relying on the registry's default for provider
 * tools, and the two answers are not the same. Anything that returns bytes off the disk or the
 * network is `untrusted`: a file may have been downloaded five minutes ago, a filename is
 * attacker-controlled, and `curl` through `exec` is the entire internet. The three *writers* are
 * `trusted`, because what they return is a sentence this runtime composed and never any of the
 * content — marking them untrusted would mean a write tainted the turn and gated the next write,
 * which is the once-per-turn trap arrived at by accident instead of by design.
 *
 * Declaring either way explicitly is also what keeps the registry's `tool_trust_overridden` warning
 * meaningful: if this package left the field off, the thing that warning exists to catch would be
 * indistinguishable from a package that simply forgot.
 */

import {
    ConfigError,
    type MediaProviderFactory,
    type Tool,
    type ToolAvailability,
    type ToolProvider,
    type ToolProviderContext,
    type ToolProviderFactory,
} from "@dispach/core"
import { configTools } from "./config.ts"
import { childEnv, type EnvPolicy, envPolicy } from "./env.ts"
import { execTool } from "./exec.ts"
import { fileTools } from "./files.ts"
import { SYSTEM_PROVIDER_ID } from "./paths.ts"
import { resolveRoots } from "./root.ts"
import { reapBackgrounded } from "./run.ts"
import { searchTools } from "./search.ts"
import { ShellSessions } from "./session.ts"

export interface SystemProviderOptions {
    /** The manifest's environment layered over the ambient one. Values, not names. */
    readonly env: Readonly<Record<string, string | undefined>>
    /**
     * The agent's own directory. The protected set is anchored to it, so the manifest and the
     * workspace files are identified by where they are rather than only by what they are called.
     */
    readonly dir: string
    /** The runtime's provider factories, so `config_set` can have a `tools.providers` edit checked. */
    readonly providers?: Readonly<Record<string, ToolProviderFactory>>
    /** The runtime's media providers, so a `media` edit is checked before it is written. */
    readonly mediaProviders?: Readonly<Record<string, MediaProviderFactory>>
    /**
     * Extra protected patterns from `tools.providerConfig.protect`.
     *
     * Widening only. There is deliberately no setting that removes something from the protected set:
     * the set contains the policy file, so a setting able to unprotect it would be a setting able to
     * unprotect itself.
     */
    readonly protect?: readonly string[]
    /** Extra writable directories. Absolute, or relative to the agent directory. */
    readonly writeRoots?: readonly string[]
}

function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

export class SystemProvider implements ToolProvider {
    readonly id = SYSTEM_PROVIDER_ID

    /**
     * One per provider instance, and a provider instance is one per agent. Two agents in the same
     * runtime therefore never inherit each other's working directory — which they would if this were
     * module state, and which would be a surprising way to leak one agent's activity into another's.
     */
    readonly #sessions = new ShellSessions()
    readonly #tools: readonly Tool[]

    constructor(options: SystemProviderOptions) {
        const roots = resolveRoots(options.dir, options.writeRoots ?? [])
        const shared = {
            sessions: this.#sessions,
            agentDir: options.dir,
            roots,
            ...(options.protect === undefined ? {} : { protect: options.protect }),
        }
        this.#tools = [
            execTool({ sessions: this.#sessions, env: options.env, roots }),
            ...fileTools(shared),
            ...searchTools({ sessions: this.#sessions, roots }),
            ...configTools({
                agentDir: options.dir,
                ...(options.providers === undefined ? {} : { providers: options.providers }),
                ...(options.mediaProviders === undefined
                    ? {}
                    : { mediaProviders: options.mediaProviders }),
            }),
        ]
    }

    /**
     * Every tool this provider offers, whether or not the manifest pinned it.
     *
     * The registry uses this to tell the model what it *could* have. Bounded by construction — eight
     * entries — which is why the method is optional on `ToolProvider` rather than required: a provider
     * with twenty-five thousand tools has nothing useful to say here and omits it.
     */
    available(): Promise<readonly ToolAvailability[]> {
        return Promise.resolve(
            this.#tools.map((tool) => ({ slug: tool.spec.slug, summary: tool.spec.summary })),
        )
    }

    /**
     * Omits what it does not recognise rather than throwing, exactly like the Composio provider: the
     * registry diffs the answer against the request and names every missing slug at once with the
     * nearest match, so failing on the first would report one typo and hide the other three.
     */
    resolve(slugs: readonly string[]): Promise<readonly Tool[]> {
        const wanted = new Set(slugs.map(normalise))
        return Promise.resolve(this.#tools.filter((tool) => wanted.has(normalise(tool.spec.slug))))
    }

    /**
     * Kill anything `exec` left running in the background. Called once, from `Runtime.stop`.
     *
     * This provider is the reason `ToolProvider.stop` exists: it is the only one that owns an OS
     * process. `exec` backgrounds a command that outruns its deadline rather than discarding its
     * work — deliberate — and "left running" was `unref()` and nothing else, so the child outlived
     * the whole runtime with its output going to a temp file nobody would open. A day of test runs
     * left 33 orphaned shells, a load average of 351, and a 132-second `runtime.ready`.
     *
     * Killed by process *group*: `sh -c "a | b | c"` killed by pid orphans two of the three.
     */
    stop(): Promise<readonly string[]> {
        return Promise.resolve(reapBackgrounded())
    }

    list(): Promise<readonly string[]> {
        return Promise.resolve(this.#tools.map((tool) => tool.spec.slug))
    }
}

/** Slugs a manifest may pin from this provider. */
export const SYSTEM_TOOL_SLUGS: readonly string[] = [
    "exec",
    "file_read",
    "file_write",
    "file_edit",
    "glob",
    "grep",
    "config_read",
    "config_set",
]

/**
 * The read-only subset, for a manifest that wants an agent which can look and not touch.
 *
 * Worth naming rather than leaving people to assemble: getting it wrong by one slug is the
 * difference between an agent that can read a repository and one that can rewrite it.
 */
export const SYSTEM_READONLY_SLUGS: readonly string[] = ["file_read", "glob", "grep"]

const CONFIG_KEYS = ["protect", "writeRoots", "env"] as const

export function systemFromConfig(
    context: ToolProviderContext,
    onPolicy?: (policy: EnvPolicy) => void,
): SystemProvider {
    const unknown = Object.keys(context.config).filter(
        (key) => !CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number]),
    )
    if (unknown.length > 0) {
        throw new ConfigError({
            code: "system_config_unknown",
            message: `tools.providerConfig has ${unknown.length === 1 ? "a key" : "keys"} the system provider does not read: ${unknown.join(", ")}.`,
            hint: `Accepted keys are ${CONFIG_KEYS.join(", ")} — extra paths the file tools refuse to write, and extra directories they may write. Refused rather than ignored, because a protection that looks applied and is not is worse than a rejected manifest.`,
            field: "tools.providerConfig",
        })
    }

    const protect = context.config.protect
    const writeRoots = context.config.writeRoots
    const policy = envPolicy(context.config.env)
    // The same policy reaches the skill-script runner this agent's plugin setup registered.
    onPolicy?.(policy)
    return new SystemProvider({
        env: childEnv(context.env, policy),
        dir: context.dir,
        ...(context.providers === undefined ? {} : { providers: context.providers }),
        ...(context.mediaProviders === undefined ? {} : { mediaProviders: context.mediaProviders }),
        ...(Array.isArray(protect) ? { protect: protect.map((entry) => String(entry)) } : {}),
        ...(Array.isArray(writeRoots)
            ? { writeRoots: writeRoots.map((entry) => String(entry)) }
            : {}),
    })
}
