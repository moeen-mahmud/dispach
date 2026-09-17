/**
 * A skill's scripts, as tools — built per turn and gone when the skill deactivates.
 *
 * ## Why these are not in the slot-1 catalogue
 *
 * Decision 6.6 says a script is visible only while its skill is active, and `ToolRuntime.blocks` is
 * documented as "Slot 1, rendered once at agent load. Byte-stable, or prompt caching stops working".
 * Both cannot be satisfied in slot 1. So the *catalogue* never sees these: they are described inside the
 * skill's own slot-5 block, which is after breakpoint A and varies per turn by design, and the executor
 * is handed them for the turn through `ToolRegistry.withTools`.
 *
 * That failure had no symptom worth mentioning, which is why the placement is written down twice. A
 * per-turn slot-1 entry would have worked perfectly and quietly multiplied the bill.
 *
 * ## Arguments
 *
 * One optional `args` array of strings, passed through after the script path. Deliberately not a map, an
 * object, or an `env` field:
 *
 * - An `env` map would be invisible to the policy engine, which matches a command — the same hole that
 *   keeps `exec` from having one. `PATH=/tmp/evil` beside a script is authorised by a rule that never saw
 *   the half deciding what ran.
 * - A structured argument object would need a per-script schema, and there is nowhere to declare one: a
 *   `SKILL.md` has no field for it and inventing one leaves the spec.
 *
 * So the contract is the shell's: a list of strings the script parses itself, with the skill's body
 * telling the model what they mean. `trust` is `untrusted` because a script's output is bytes produced by
 * a folder somebody downloaded, and `mutating` is `true` because nothing here can know whether it writes
 * — the safe direction, and the same default a provider tool with no annotation gets.
 */

import { skillScriptFailed } from "../errors.ts"
import type { ScriptRunner, Tool, ToolSpec } from "../tools/types.ts"
import type { Skill } from "./index.ts"
import type { ScriptPlan } from "./scripts.ts"

/** Under the harness's own ceiling, so the child is killed before the handler is abandoned. */
const DEADLINE_MARGIN_MS = 5_000

export interface SkillToolOptions {
    readonly skill: Skill
    readonly runner: ScriptRunner
}

export function skillScriptTools(options: SkillToolOptions): readonly Tool[] {
    return options.skill.scripts.map((plan) => scriptTool(options.skill, plan, options.runner))
}

export function scriptSpec(skill: Skill, plan: ScriptPlan): ToolSpec {
    return {
        slug: plan.slug,
        provider: "skill",
        summary: `Run scripts/${plan.file} from the ${skill.name} skill.`,
        whenToUse: `When the ${skill.name} procedure calls for it. Its steps say what this script does and what arguments it expects.`,
        whenNotToUse: `Outside the ${skill.name} procedure. It is available only while that skill is active, and it is not a general-purpose command runner — that is exec, if this agent has it.`,
        // True because nothing here can know otherwise, and a write mislabelled as a read runs in
        // parallel *and* is retried, so the side effect happens twice. Same default, same reason, as a
        // provider tool arriving with no annotation.
        mutating: true,
        trust: "untrusted",
        tags: ["skill", skill.name],
        parameters: {
            type: "object",
            properties: {
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: `Arguments passed to the script after its path, exactly as a shell would pass them. The ${skill.name} procedure describes what it expects.`,
                },
            },
        },
    }
}

function scriptTool(skill: Skill, plan: ScriptPlan, runner: ScriptRunner): Tool {
    return {
        spec: scriptSpec(skill, plan),
        handler: async (args, context) => {
            const extra = Array.isArray(args.args) ? args.args.map((value) => String(value)) : []
            const path = `${SCRIPTS}/${plan.file}`

            // Absent interpreter means the shebang decides, and then the script *is* the command — with
            // `./` so it resolves against the skill directory rather than PATH.
            const command = plan.interpreter ?? `./${path}`
            const argv = plan.interpreter === undefined ? extra : [...plan.args, path, ...extra]

            const result = await runner.run({
                command,
                args: argv,
                cwd: skill.dir,
                // Under the harness's ceiling, not equal to it. `limits.toolTimeoutMs` *abandons* a
                // handler rather than killing it, so a tie leaves a process running with nothing
                // referencing it — which is how the orphan count got to 33.
                timeoutMs: Math.max(1_000, context.deadlineMs - DEADLINE_MARGIN_MS),
                signal: context.signal,
            })

            if (result.ok) return result.output
            throw skillScriptFailed(skill.name, plan.file, result, plan.interpreter)
        },
    }
}

const SCRIPTS = "scripts"

/**
 * The scripts section appended to an active skill's slot-5 block.
 *
 * Named "available now" on purpose: these appear and disappear with the skill, and a model that has been
 * told a tool exists in slot 1 has been told something permanent. Empty string when there are none, so a
 * prose-only skill costs nothing.
 *
 * A skill whose scripts could not be built — no runner supplied — says so rather than omitting them.
 * Decision 4.53's lesson twice over: an absent capability the model cannot see is one it will invent a
 * workaround for, and `--system none` taught the same thing about a provider left unnamed.
 */
export function renderScripts(skill: Skill, runnerAvailable: boolean): string {
    if (skill.scripts.length === 0) return ""
    if (!runnerAvailable) {
        return [
            "## Scripts this skill ships, which I cannot run",
            "",
            ...skill.scripts.map((plan) => `- scripts/${plan.file}`),
            "",
            "This runtime was built without a script runner, so these are documentation only. I should follow the steps above by hand and say so if a step needs one of these.",
        ].join("\n")
    }

    return [
        "## Scripts available now",
        "",
        ...skill.scripts.map((plan) => `- ${plan.slug} — runs scripts/${plan.file}`),
        "",
        "These are callable for this turn only, because they belong to this skill. Arguments go in `args`, as a list of strings.",
    ].join("\n")
}
