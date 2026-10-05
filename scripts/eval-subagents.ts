/**
 * Is routing bulk tool work to a subagent worth it, against keeping it in the parent's context?
 *
 * Decision 14.69 routes a call like a mailbox listing to a throwaway child so the parent reads an
 * artifact instead of the raw output. The unit tests prove the isolation (the parent's request holds
 * the artifact, not the output). This measures whether that is worth paying for, against a real
 * endpoint, on ten bulk-read tasks of two turns each (`evals/subagents/fixtures.ts`).
 *
 * ## The arms
 *
 * - **inline** — no subagents. Compaction on, `artifact_read` in the catalogue, so an observation over
 *   `observationMaxTokens` is cut with a pointer to the whole of it (pilot.5). This is the baseline to
 *   beat: the cut already keeps a big result out of the parent's prompt.
 * - **routed** — the task's tool is routed to a child on `main`.
 * - **routed-cheap** — the same, with the child on `--subagent-model`. Only run when that is given.
 *
 * ## What is counted
 *
 * Billed tokens off the endpoint's own `usage`, never estimates (`estimateTokens` runs 16-20% low on
 * observation-heavy prompts, which would flatter one arm by construction). The parent's prompt tokens
 * are the context claim; the total, and its cost at the prices given, is the bill. A turn passes when
 * its reply holds every required fact, which is checked by string and can be read by eye.
 *
 * The claim the docs make is whatever this table says. If `routed` does not beat `inline`, the
 * honest result is that routing pays only with a cheaper child model, or not at all.
 *
 * Usage:
 *   bun scripts/eval-subagents.ts --model <id> --base-url <url> [--api-key-env MODEL_API_KEY]
 *   bun scripts/eval-subagents.ts ... --subagent-model <cheap id> [--subagent-base-url <url>]
 *   bun scripts/eval-subagents.ts ... --price-main 0.27,1.10 --price-subagent 0.07,0.28
 *   bun scripts/eval-subagents.ts ... --tasks mail-triage,logs --arms inline,routed
 *
 * Cost: per arm, ten tasks of two turns, each a few model calls over a 2-6k-token observation.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FixtureTask, passes, TASKS } from "../evals/subagents/fixtures.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { Runtime } from "../packages/core/src/runtime/runtime.ts"
import type { Tool, ToolProviderFactory } from "../packages/core/src/tools/types.ts"

const FLAGS = [
    "model",
    "base-url",
    "api-key-env",
    "subagent-model",
    "subagent-base-url",
    "subagent-api-key-env",
    "price-main",
    "price-subagent",
    "tasks",
    "arms",
    "repeats",
    "out",
    "help",
] as const

const HELP = `eval-subagents — is routing bulk tool work to a subagent worth it?

  --model <id>                  the agent's model (or MODEL_ID)
  --base-url <url>              its endpoint (or MODEL_BASE_URL)
  --api-key-env <name>          env var holding its key (default MODEL_API_KEY)
  --subagent-model <id>         a cheaper model for the routed-cheap arm (skipped without it)
  --subagent-base-url <url>     its endpoint (default: --base-url)
  --subagent-api-key-env <name> its key (default: --api-key-env)
  --price-main <in,out>         USD per million prompt,output tokens for --model
  --price-subagent <in,out>     the same for --subagent-model
  --tasks <ids>                 a comma-separated subset of the ten tasks
  --arms <names>                inline,routed,routed-cheap (default: all that can run)
  --repeats <n>                 runs of each task per arm (default 1); a hosted endpoint varies
  --out <path>                  results.json (default evals/subagents/results.json)

Tokens are the endpoint's own usage figures. A turn passes when its reply holds every required fact.
`

type Arm = "inline" | "routed" | "routed-cheap"

function arg(name: string): string | undefined {
    const prefix = `--${name}`
    const argv = process.argv.slice(2)
    for (const [index, token] of argv.entries()) {
        if (token === prefix) return argv[index + 1]
        if (token.startsWith(`${prefix}=`)) return token.slice(prefix.length + 1)
    }
    return undefined
}

function unknownFlags(): readonly string[] {
    return process.argv
        .slice(2)
        .filter((token) => token.startsWith("--"))
        .map((token) => token.slice(2).split("=")[0] ?? "")
        .filter((name) => !FLAGS.includes(name as (typeof FLAGS)[number]))
}

function loadEnv(): Record<string, string | undefined> {
    try {
        return { ...process.env, ...parseDotEnv(readFileSync(".env", "utf8")) }
    } catch {
        return { ...process.env }
    }
}

interface Endpoint {
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv: string
}

/** `in,out` USD per million tokens. */
function price(flag: string): { readonly input: number; readonly output: number } | undefined {
    const raw = arg(flag)
    if (raw === undefined) return undefined
    const [input, output] = raw.split(",").map(Number)
    if (
        input === undefined ||
        output === undefined ||
        Number.isNaN(input) ||
        Number.isNaN(output)
    ) {
        throw new Error(
            `--${flag} takes "<input>,<output>" in USD per million tokens, e.g. 0.27,1.10`,
        )
    }
    return { input, output }
}

const role = (endpoint: Endpoint) =>
    `{ id: ${JSON.stringify(endpoint.id)}, baseUrl: ${JSON.stringify(endpoint.baseUrl)}, apiKeyEnv: ${endpoint.apiKeyEnv} }`

/** The agent for one task in one arm: the task's tool pinned, routed or not. */
function manifest(
    task: FixtureTask,
    arm: Arm,
    main: Endpoint,
    cheap: Endpoint | undefined,
): string {
    const slug = task.tool.slug
    const routed = arm !== "inline"
    return `apiVersion: dispach/v1
id: evalagent
model:
  main: ${role(main)}
${arm === "routed-cheap" && cheap !== undefined ? `  subagent: ${role(cheap)}\n` : ""}tools:
  providers:
    work: {}
  pinned: [${slug}]
  local: [artifact_read]
${
    routed
        ? `subagents:
  - name: reader
    task: >-
      Make the one call you are handed and read everything it returns. Report what answers the
      person's question, and anything they are likely to ask next about it. Keep ids, names, dates,
      amounts and file names exactly as written.
    tools: [${slug}]
    route:
      tools: [${slug}]
    maxSteps: 6
`
        : ""
}`
}

/** The task's tool, returning its fixture every call. Trusted: every arm reads the same bytes. */
function provider(task: FixtureTask): ToolProviderFactory {
    const tool: Tool = {
        spec: {
            slug: task.tool.slug,
            provider: "work",
            summary: task.tool.summary,
            whenToUse: "The person asks about what this tool lists.",
            whenNotToUse: "The answer is already in the conversation.",
            mutating: false,
            tags: ["read"],
            trust: "trusted",
            trustReason: "An eval fixture.",
            parameters: { type: "object", properties: task.tool.parameters },
        },
        handler: () => task.tool.output(),
    }
    return () => ({
        id: "work",
        resolve: async (slugs) => (slugs.includes(tool.spec.slug) ? [tool] : []),
    })
}

interface Usage {
    prompt: number
    output: number
    calls: number
}

interface RunResult {
    readonly task: string
    readonly repeat: number
    readonly arm: Arm
    readonly passed: readonly boolean[]
    readonly replies: readonly string[]
    readonly reasons: readonly string[]
    readonly parent: Usage
    readonly child: Usage
    readonly reported: boolean
    readonly handoffs: readonly string[]
}

async function runTask(
    task: FixtureTask,
    arm: Arm,
    main: Endpoint,
    cheap: Endpoint | undefined,
    env: Record<string, string | undefined>,
): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), "eval-subagents-"))
    writeFileSync(join(dir, "agent.yaml"), manifest(task, arm, main, cheap))
    const runtime = await Runtime.create({
        agents: [join(dir, "agent.yaml")],
        env,
        store: ":memory:",
        toolProviders: { work: provider(task) },
    })
    const parent: Usage = { prompt: 0, output: 0, calls: 0 }
    const child: Usage = { prompt: 0, output: 0, calls: 0 }
    let reported = true
    const handoffs: string[] = []
    runtime.bus.on("model.result", (event) => {
        const data = event.data as {
            promptTokens?: number
            outputTokens?: number
            promptTokensReported?: boolean
            role?: string
        }
        if (data.promptTokensReported !== true) reported = false
        const into = data.role === "subagent" ? child : parent
        into.prompt += data.promptTokens ?? 0
        into.output += data.outputTokens ?? 0
        into.calls += 1
    })
    runtime.bus.on("handoff.result", (event) => {
        const data = event.data as { outcome: string; errorCode?: string }
        handoffs.push(
            data.errorCode === undefined ? data.outcome : `${data.outcome}:${data.errorCode}`,
        )
    })

    const passed: boolean[] = []
    const replies: string[] = []
    const reasons: string[] = []
    try {
        const agent = runtime.agent("evalagent")
        if (agent === undefined) throw new Error("the eval agent did not load")
        for (const [turn, { ask }] of task.turns.entries()) {
            const result = await agent.send(ask, { sessionKey: `eval:${task.id}` })
            replies.push(result.text)
            reasons.push(result.reason)
            passed.push(passes(task, turn, result.text))
        }
    } finally {
        await runtime.stop()
        rmSync(dir, { recursive: true, force: true })
    }
    return {
        task: task.id,
        repeat: 0,
        arm,
        passed,
        replies,
        reasons,
        parent,
        child,
        reported,
        handoffs,
    }
}

function cost(
    usage: Usage,
    rates: { readonly input: number; readonly output: number } | undefined,
): number | undefined {
    return rates === undefined
        ? undefined
        : (usage.prompt * rates.input + usage.output * rates.output) / 1_000_000
}

async function main(): Promise<number> {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        process.stdout.write(HELP)
        return 0
    }
    const unknown = unknownFlags()
    if (unknown.length > 0) {
        process.stderr.write(
            `eval-subagents: unknown flag ${unknown.map((name) => `--${name}`).join(", ")}. Known: ${FLAGS.map((name) => `--${name}`).join(", ")}.\n`,
        )
        return 2
    }
    const env = loadEnv()
    const id = arg("model") ?? env.MODEL_ID
    const baseUrl = arg("base-url") ?? env.MODEL_BASE_URL
    const apiKeyEnv = arg("api-key-env") ?? "MODEL_API_KEY"
    if (id === undefined || baseUrl === undefined) {
        process.stderr.write(
            "eval-subagents: give --model and --base-url (or MODEL_ID and MODEL_BASE_URL).\n",
        )
        return 2
    }
    if (env[apiKeyEnv] === undefined) {
        process.stderr.write(
            `eval-subagents: ${apiKeyEnv} is not set, so ${id} cannot be reached.\n`,
        )
        return 2
    }
    const main: Endpoint = { id, baseUrl, apiKeyEnv }
    const cheapId = arg("subagent-model")
    const cheap: Endpoint | undefined =
        cheapId === undefined
            ? undefined
            : {
                  id: cheapId,
                  baseUrl: arg("subagent-base-url") ?? baseUrl,
                  apiKeyEnv: arg("subagent-api-key-env") ?? apiKeyEnv,
              }
    const mainPrice = price("price-main")
    const cheapPrice = price("price-subagent") ?? mainPrice

    const wanted = arg("arms")?.split(",") ?? ["inline", "routed", "routed-cheap"]
    const arms = wanted.filter(
        (arm): arm is Arm =>
            (arm === "inline" || arm === "routed" || arm === "routed-cheap") &&
            (arm !== "routed-cheap" || cheap !== undefined),
    )
    if (wanted.includes("routed-cheap") && cheap === undefined && arg("arms") !== undefined) {
        process.stderr.write("eval-subagents: routed-cheap needs --subagent-model.\n")
        return 2
    }
    const only = arg("tasks")?.split(",")
    const tasks = TASKS.filter((task) => only === undefined || only.includes(task.id))

    const repeats = Math.max(1, Number(arg("repeats") ?? "1"))
    const results: RunResult[] = []
    for (let repeat = 0; repeat < repeats; repeat += 1)
        for (const task of tasks) {
            for (const arm of arms) {
                const result = { ...(await runTask(task, arm, main, cheap, env)), repeat }
                results.push(result)
                process.stdout.write(
                    `${task.id.padEnd(12)} ${arm.padEnd(13)} ${result.passed.map((ok) => (ok ? "pass" : "FAIL")).join(" ")}  parent ${result.parent.prompt} prompt  child ${result.child.prompt} prompt${result.handoffs.length > 0 ? `  [${result.handoffs.join(",")}]` : ""}\n`,
                )
            }
        }

    const summary = arms.map((arm) => {
        const rows = results.filter((result) => result.arm === arm)
        const sum = (pick: (row: RunResult) => number) =>
            rows.reduce((total, row) => total + pick(row), 0)
        const parent = {
            prompt: sum((r) => r.parent.prompt),
            output: sum((r) => r.parent.output),
            calls: sum((r) => r.parent.calls),
        }
        const child = {
            prompt: sum((r) => r.child.prompt),
            output: sum((r) => r.child.output),
            calls: sum((r) => r.child.calls),
        }
        const parentCost = cost(parent, mainPrice)
        const childCost = cost(child, arm === "routed-cheap" ? cheapPrice : mainPrice)
        return {
            arm,
            turnsPassed: sum((r) => r.passed.filter(Boolean).length),
            turns: sum((r) => r.passed.length),
            parentPromptTokens: parent.prompt,
            totalTokens: parent.prompt + parent.output + child.prompt + child.output,
            ...(parentCost === undefined || childCost === undefined
                ? {}
                : { costUsd: Number((parentCost + childCost).toFixed(4)) }),
            allReported: rows.every((row) => row.reported),
        }
    })

    process.stdout.write("\narm            passed   parent prompt   total tokens   cost\n")
    for (const row of summary) {
        process.stdout.write(
            `${row.arm.padEnd(14)} ${`${row.turnsPassed}/${row.turns}`.padEnd(8)} ${String(row.parentPromptTokens).padStart(13)}   ${String(row.totalTokens).padStart(12)}   ${"costUsd" in row ? `$${row.costUsd}` : "—"}${row.allReported ? "" : "   (some usage estimated, not reported)"}\n`,
        )
    }

    const out = arg("out") ?? "evals/subagents/results.json"
    writeFileSync(
        out,
        `${JSON.stringify(
            {
                ranAt: new Date().toISOString(),
                model: main.id,
                repeats,
                ...(cheap === undefined ? {} : { subagentModel: cheap.id }),
                prices: { main: mainPrice, subagent: cheapPrice },
                summary,
                results,
            },
            null,
            2,
        )}\n`,
    )
    process.stdout.write(`\nwrote ${out}\n`)
    return 0
}

process.exit(await main())
