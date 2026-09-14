/**
 * `@dispach/tools-system` — the agent acting on the machine it runs on.
 *
 * A harness that cannot run a command is not a harness. This is the package that makes the runtime
 * peer to the tools it is modelled on rather than a channel-resident assistant, and it is deliberately
 * the one package whose every tool is governed by `tools.policy` and the trust gate from the first
 * line of code rather than from a later hardening pass.
 */

import type { Plugin } from "@dispach/core"
import { systemFromConfig } from "./provider.ts"
import { SystemScriptRunner } from "./scripts.ts"

export {
    CONFIG_READ_SPEC,
    CONFIG_SET_SPEC,
    type ConfigOptions,
    configReadHandler,
    configSetHandler,
    configTools,
    parseValue,
    SETTABLE_PATHS,
} from "./config.ts"
export {
    execCommandEmpty,
    execPtyUnavailable,
    execSpawnFailed,
    execWorkdirMissing,
} from "./errors.ts"
export {
    DEFAULT_TIMEOUT_MS,
    EXEC_SPEC,
    type ExecOptions,
    effectiveTimeout,
    execFromContext,
    execHandler,
    execTool,
    MAX_TIMEOUT_MS,
    render,
} from "./exec.ts"
export {
    humanBytes,
    INLINE_CAP,
    type Observation,
    readOutput,
    stripLeadingEcho,
} from "./output.ts"
export { SYSTEM_PROVIDER_ID, spillDir } from "./paths.ts"
export {
    SYSTEM_READONLY_SLUGS,
    SYSTEM_TOOL_SLUGS,
    SystemProvider,
    type SystemProviderOptions,
    systemFromConfig,
} from "./provider.ts"
export {
    backgroundable,
    backgroundedCommands,
    buildWrapper,
    commandLine,
    MAX_BACKGROUNDED,
    type RunEnding,
    type RunRequest,
    type RunResult,
    readStatus,
    reapBackgrounded,
    runCommand,
} from "./run.ts"
export {
    SystemScriptRunner,
    type SystemScriptRunnerOptions,
} from "./scripts.ts"
export { ShellSessions } from "./session.ts"
/**
 * Exported so the CLI edits `agent.yaml` the same way `config_set` does.
 *
 * A whole-file round trip through the YAML parser *reflows* the document — a comment between two
 * top-level keys belongs to the end of the first, so re-emitting indents a section header into the
 * section above and one change produces a thirty-line diff. Two ways of writing this file would mean
 * one of them eventually being the reflowing one.
 */

/** Package version, kept in step with `package.json` by a test. See `@dispach/core`'s `VERSION`. */
export const VERSION = "0.1.0"

/**
 * This package as a plugin — the shell, the file tools, and the runner skill scripts use.
 *
 * **Naming it grants nothing.** The provider supplies `exec`, `file_write` and the rest only once a
 * manifest selects `system` under `tools.providers` *and* pins the slugs it wants; `tools.policy`
 * then decides which commands run. That separation is the reason this is a plugin at all rather than
 * something core ships: core is what an embedder runs *other people's* agents on, and a shell tool
 * there is one every provisioned agent gets with no way to decline it.
 *
 * The script runner is registered unconditionally, and that is a different kind of thing from the
 * provider: there is nothing for a manifest to select between, and a skill's `scripts/` is only
 * reachable once a skill ships one and that skill activates — both the workspace's decision. Without
 * it a skill's scripts are silently never discovered, which reads as the runtime being broken.
 */
export default {
    name: "system",
    version: VERSION,
    dispachApi: "^0.1",
    permissions: [
        { kind: "exec", commands: ["*"] },
        { kind: "fs", paths: ["<workspace>"], mode: "write" },
    ],
    setup(context) {
        context.defineToolProvider("system", systemFromConfig)
        context.defineScriptRunner(new SystemScriptRunner({ env: context.env }))
    },
} satisfies Plugin
