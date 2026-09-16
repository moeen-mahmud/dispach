/**
 * Does delegation actually cost the parent fewer tokens than doing the work in one conversation?
 *
 * Decision 10.2 justifies context-isolated sub-agents with that claim, and `CLAUDE.md`'s rule is
 * explicit: never claim a performance property without a number in `evals/` and a script to
 * reproduce it. Phase 10B's unit tests prove the *isolation* — the supervisor's prompt contains the
 * artifact and not the transcript, asserted on a character count — which is a structural fact and
 * not the economic one. This measures the economic one, against a real endpoint, on the same task.
 *
 * ## The two arms
 *
 * - **delegated** — a supervisor with two members. It hands out two self-contained sub-tasks, gets
 *   two validated artifacts back, and writes the answer itself.
 * - **inline** — one agent with no team, given the same overall task and the same sub-tasks as
 *   instructions to work through in its own conversation.
 *
 * Same endpoint, same overall task, same expected output. What differs is where the intermediate
 * work lives.
 *
 * ## What is counted, and why it is `prompt_tokens` off the wire
 *
 * The figure is the **parent's** billed prompt tokens, summed over every model call the parent
 * makes — read from the endpoint's own `usage.prompt_tokens`, never from `estimateTokens`. This
 * repo measured that estimator running 16–20% *low* on exactly the observation-heavy prompts a
 * long inline conversation produces, so an estimated comparison would be biased in favour of the
 * arm being advocated for. Reporting a number that flatters the feature by construction is worse
 * than reporting none.
 *
 * Total cost across both agents is reported beside it and is **not** the headline. Delegation moves
 * tokens rather than destroying them: the members pay for the work the parent no longer carries,
 * and whether the total falls depends on the members running a cheaper model — which is a
 * configuration choice, not a property of the mechanism. The claim under test is about the parent's
 * context, because that is what runs out.
 *
 * Usage:
 *   bun scripts/eval-handoff.ts --manifest examples/team/agent.yaml
 *   bun scripts/eval-handoff.ts --model <id> --base-url <url> --api-key-env MODEL_API_KEY
 *   bun scripts/eval-handoff.ts --repeats 2 --out evals/handoff/results.json
 *
 * Cost: two turns per repeat, a handful of steps each. On deepseek-v4-pro one repeat measured well
 * under a dollar; check `totalTokens` in the output before running many.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { loadManifest } from "../packages/core/src/manifest/load.ts"
import { Runtime } from "../packages/core/src/runtime/runtime.ts"

const FLAGS = ["model", "base-url", "api-key-env", "manifest", "repeats", "out", "help"] as const

const HELP = `eval-handoff — does delegation cost the parent fewer tokens?

  --manifest <path>      take the model, base URL and key env from an agent
  --model <id>           model id (or MODEL_ID)
  --base-url <url>       endpoint (or MODEL_BASE_URL)
  --api-key-env <name>   env var holding the key (default MODEL_API_KEY when set)
  --repeats <n>          runs per arm (default 1)
  --out <path>           where to write results.json (default evals/handoff/results.json)

Two arms over one task. Reports the PARENT's billed prompt tokens, from the endpoint's own
usage figures — never from estimateTokens, which runs 16-20% low on exactly the
observation-heavy prompts the inline arm produces.
`

function arg(name: string): string | undefined {
    const prefix = `--${name}`
    const argv = process.argv.slice(2)
    for (const [index, token] of argv.entries()) {
        if (token === prefix) return argv[index + 1]
        if (token.startsWith(`${prefix}=`)) return token.slice(prefix.length + 1)
    }
    return undefined
}

function checkFlags(): string | undefined {
    const unknown = process.argv
        .slice(2)
        .filter((token) => token.startsWith("--"))
        .map((token) => token.slice(2).split("=")[0] ?? "")
        .filter((name) => !FLAGS.includes(name as (typeof FLAGS)[number]))
    if (unknown.length === 0) return undefined
    return `eval-handoff: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown
        .map((name) => `--${name}`)
        .join(", ")}. Known: ${FLAGS.map((name) => `--${name}`).join(", ")}.`
}

function loadEnv(): Record<string, string | undefined> {
    try {
        return { ...process.env, ...parseDotEnv(readFileSync(".env", "utf8")) }
    } catch {
        return { ...process.env }
    }
}

interface Target {
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv: string
}

function resolveTarget(env: Record<string, string | undefined>): Target | string {
    const manifestPath = arg("manifest")
    if (manifestPath !== undefined) {
        const main = loadManifest(manifestPath).manifest.model.main
        if (main.apiKeyEnv === undefined) {
            return `eval-handoff: ${manifestPath} declares no apiKeyEnv, so its endpoint cannot be reached from here.`
        }
        return { id: main.id, baseUrl: main.baseUrl, apiKeyEnv: main.apiKeyEnv }
    }
    const id = arg("model") ?? env.MODEL_ID
    if (id === undefined || id === "") {
        return "eval-handoff: name a model with --model, set MODEL_ID, or point at an agent with --manifest."
    }
    const baseUrl = arg("base-url") ?? env.MODEL_BASE_URL ?? env.SMALL_MODEL_BASE_URL
    if (baseUrl === undefined || baseUrl === "") {
        return "eval-handoff: give --base-url, or set MODEL_BASE_URL. There is no default — one pointing at localhost turns 'not configured' into 'connection refused'."
    }
    const apiKeyEnv = arg("api-key-env") ?? "MODEL_API_KEY"
    if (env[apiKeyEnv] === undefined) {
        return `eval-handoff: ${apiKeyEnv} is not set, so ${id} cannot be reached.`
    }
    return { id, baseUrl, apiKeyEnv }
}

// ─── the task ────────────────────────────────────────────────────────────────────────────

/**
 * One overall task with two separable halves, which is the shape delegation is *for*.
 *
 * Deliberately not a task that decomposes badly: if the halves needed to talk to each other, the
 * inline arm would win on correctness and the comparison would be about task fit rather than about
 * token cost. The honest framing of the result is "on a task that decomposes, here is what the
 * parent saves" — and this is such a task.
 */
const TASK =
    "Write one short paragraph for a developer audience explaining SQLite's WAL mode. First gather the facts, then write the prose."

const SUB_TASKS = [
    "Gather three short factual claims about SQLite's WAL mode: what it changes about concurrency, what the extra files are, and one caveat.",
    "Turn those three claims into one short paragraph for a developer audience. No headings.",
]

const MEMBER_SOUL = `You are a specialist working on one task handed to you by another agent.

<rules>
- You were given everything you need. Do not ask questions — there is nobody to answer them.
- When the work is done, call \`submit_artifact\` with every required field filled in.
- If you genuinely cannot fill in a required field, say what is missing in your reply and do not call the tool with a guess.
</rules>
`

function manifestFor(target: Target, id: string, extra: string): string {
    return `apiVersion: dispach/v1
id: ${id}
name: ${id}
model:
  main:
    id: ${target.id}
    baseUrl: ${target.baseUrl}
    apiKeyEnv: ${target.apiKeyEnv}
context:
  workspace: .
  static:
    - SOUL.md
tools:
  dialect: nlt
  local: [now]
${extra}`
}

/** Both arms written to one temp tree, so nothing about the filesystem differs between them. */
function buildArms(target: Target): { dir: string; delegated: string; inline: string } {
    const dir = mkdtempSync(join(tmpdir(), "eval-handoff-"))
    mkdirSync(join(dir, "team"), { recursive: true })

    writeFileSync(
        join(dir, "SOUL.md"),
        `You are an editor. You coordinate two specialists and write the final answer yourself.

<rules>
- Delegate fact-gathering and prose to your team members. Do not do their work yourself.
- Give a member everything it needs in one instruction. It has no history and cannot ask you anything.
- The final reply is yours to write.
</rules>
`,
    )
    writeFileSync(join(dir, "team", "SOUL.md"), MEMBER_SOUL)
    writeFileSync(
        join(dir, "team", "researcher.yaml"),
        manifestFor(target, "researcher", "limits:\n  maxSteps: 8\n"),
    )
    writeFileSync(
        join(dir, "team", "writer.yaml"),
        manifestFor(target, "writer", "limits:\n  maxSteps: 8\n"),
    )

    const delegated = join(dir, "delegated.yaml")
    writeFileSync(
        delegated,
        manifestFor(
            target,
            "editor",
            `team:
  members:
    - id: researcher
      manifest: ./team/researcher.yaml
      task: Gathers short factual claims on a narrow technical topic.
      artifact:
        type: object
        properties:
          claims:
            type: array
            items: { type: string }
        required: [claims]
    - id: writer
      manifest: ./team/writer.yaml
      task: Turns a list of claims into one short paragraph of prose.
      artifact:
        type: object
        properties:
          paragraph: { type: string }
        required: [paragraph]
`,
        ),
    )

    // The inline arm gets **no team** and the same sub-tasks as instructions, so the work it does
    // is the same work — just in its own conversation. Anything else would compare two tasks.
    const inline = join(dir, "inline.yaml")
    mkdirSync(join(dir, "solo"), { recursive: true })
    writeFileSync(
        join(dir, "solo", "SOUL.md"),
        `You are an editor working alone.

<rules>
- Work through the task in stages: gather the facts first, then write the prose.
- Write out the intermediate facts before writing the final paragraph.
- The final reply is the finished paragraph.
</rules>
`,
    )
    writeFileSync(
        inline,
        manifestFor(target, "solo", "").replace("workspace: .", "workspace: ./solo"),
    )

    return { dir, delegated, inline }
}

// ─── running an arm ──────────────────────────────────────────────────────────────────────

interface ArmResult {
    readonly arm: string
    /** The parent's billed prompt tokens, summed over its own model calls. The headline. */
    readonly parentPromptTokens: number
    readonly parentOutputTokens: number
    /** Every agent's prompt tokens. Reported, not the headline — see the file comment. */
    readonly totalPromptTokens: number
    readonly totalOutputTokens: number
    readonly parentSteps: number
    readonly reason: string
    readonly reported: boolean
    readonly text: string
}

/**
 * `usage` is read off the bus rather than off `TurnResult`, and only when the endpoint reported it.
 *
 * `model.result` carries the wire's own figures per call, which is what makes "the parent's billed
 * prompt tokens" a measurement rather than a sum of estimates. `reported` is the guard: an endpoint
 * that sends no `usage` makes every number here an estimate, and a comparison of two estimates from
 * a biased estimator is not a result. The script says so rather than printing a ratio.
 */
async function runArm(
    arm: string,
    manifestPath: string,
    parentId: string,
    input: string,
): Promise<ArmResult> {
    const runtime = await Runtime.create({ agents: [manifestPath] })
    let parentPrompt = 0
    let parentOutput = 0
    let totalPrompt = 0
    let totalOutput = 0
    let reported = false

    runtime.bus.on("model.result", (event) => {
        const data = event.data as {
            promptTokens?: number
            outputTokens?: number
            promptTokensReported?: boolean
        }
        const prompt = data.promptTokens ?? 0
        const output = data.outputTokens ?? 0
        if (data.promptTokensReported === true) reported = true
        totalPrompt += prompt
        totalOutput += output
        if (event.agentId === parentId) {
            parentPrompt += prompt
            parentOutput += output
        }
    })

    try {
        const result = await runtime.agent(parentId).send(input)
        return {
            arm,
            parentPromptTokens: parentPrompt,
            parentOutputTokens: parentOutput,
            totalPromptTokens: totalPrompt,
            totalOutputTokens: totalOutput,
            parentSteps: result.steps,
            reason: result.reason,
            reported,
            text: result.text,
        }
    } finally {
        await runtime.stop()
    }
}

// ─── main ────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        process.stdout.write(HELP)
        return 0
    }
    const flagError = checkFlags()
    if (flagError !== undefined) {
        process.stderr.write(`${flagError}\n`)
        return 2
    }

    const env = loadEnv()
    const target = resolveTarget(env)
    if (typeof target === "string") {
        process.stderr.write(`${target}\n`)
        return 2
    }

    const repeats = Number.parseInt(arg("repeats") ?? "1", 10)
    if (!Number.isInteger(repeats) || repeats < 1) {
        process.stderr.write("eval-handoff: --repeats must be a positive integer.\n")
        return 2
    }

    const { dir, delegated, inline } = buildArms(target)
    const attempts: ArmResult[] = []

    try {
        process.stdout.write(
            `eval-handoff: ${target.id} at ${target.baseUrl}, ${repeats} repeat(s)\n`,
        )
        for (let pass = 0; pass < repeats; pass += 1) {
            attempts.push(await runArm("delegated", delegated, "editor", TASK))
            // The inline arm is handed the sub-tasks explicitly, so it does the same work rather
            // than a vaguer version of it.
            attempts.push(
                await runArm(
                    "inline",
                    inline,
                    "solo",
                    `${TASK}\n\nWork through these in order:\n1. ${SUB_TASKS[0]}\n2. ${SUB_TASKS[1]}`,
                ),
            )
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }

    const mean = (arm: string, pick: (result: ArmResult) => number): number => {
        const rows = attempts.filter((result) => result.arm === arm)
        return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / rows.length
    }

    const parentDelegated = mean("delegated", (result) => result.parentPromptTokens)
    const parentInline = mean("inline", (result) => result.parentPromptTokens)
    const everyReported = attempts.every((result) => result.reported)

    const report = {
        model: target.id,
        baseUrl: target.baseUrl,
        repeats,
        at: new Date().toISOString(),
        /** False makes every figure below an estimate. See the file comment. */
        usageReportedByEndpoint: everyReported,
        parentPromptTokens: { delegated: parentDelegated, inline: parentInline },
        totalPromptTokens: {
            delegated: mean("delegated", (result) => result.totalPromptTokens),
            inline: mean("inline", (result) => result.totalPromptTokens),
        },
        attempts,
    }

    const out = arg("out") ?? join("evals", "handoff", "results.json")
    mkdirSync(join(out, ".."), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

    process.stdout.write(
        `\n  parent prompt tokens   delegated ${Math.round(parentDelegated)}  ·  inline ${Math.round(parentInline)}\n` +
            `  total prompt tokens    delegated ${Math.round(report.totalPromptTokens.delegated)}  ·  inline ${Math.round(report.totalPromptTokens.inline)}\n`,
    )

    if (!everyReported) {
        // Stated rather than silently folded in. A comparison of two `estimateTokens` figures is
        // not a measurement, and the estimator's 16-20% low bias lands hardest on the inline arm —
        // which is the arm this feature is being compared *against*.
        process.stdout.write(
            "\n  At least one call reported no usage, so these are ESTIMATES and the comparison is not a result.\n" +
                "  Set model.main.streamUsage: true, or use an endpoint that reports usage.\n",
        )
        process.stdout.write(`\n  written to ${out}\n`)
        return 1
    }

    if (parentInline === 0) {
        process.stdout.write("\n  The inline arm spent nothing, which means it did not run.\n")
        return 1
    }

    const saved = 1 - parentDelegated / parentInline
    process.stdout.write(
        `  parent saving          ${(saved * 100).toFixed(1)}%\n\n  written to ${out}\n`,
    )
    // One endpoint, and `00-DECISIONS.md` records a hosted MoE moving 4.2pp between two identical
    // runs — so this is a lead at n=1 and a result only across repeats and endpoints. The exit code
    // is about whether it *ran*, never about whether the number was flattering.
    return 0
}

main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((error: unknown) => {
        process.stderr.write(
            `eval-handoff: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exitCode = 1
    })
