#!/usr/bin/env bun
/**
 * Scenario evals: a real agent, a real model, mocked tools, and a judge — layer 2 of testing an agent.
 *
 *   bun run eval:scenarios <suite-dir> [--runs 3] [--threshold 0.8] [--out <file>] [--only <name>]
 *
 * A suite is a directory holding `suite.yaml` and `scenarios/*.yaml`:
 *
 * - `suite.yaml` names the agent under test (a path to its `agent.yaml`), declares the **mocked
 *   tools** every scenario may call, and carries **calibration**: replies of known verdict, judged
 *   first. A judge that gets one wrong ends the run before a single scenario is scored.
 * - A scenario is one conversation. Each step has a `prompt`, the `expected_calls` (a hard check on
 *   the call log: `in_order` by default, or `exact` / `any_order`), three or four **binary**
 *   `criteria` a person could check in five seconds, and the `mocks` its tools return.
 *
 * ## The rules this follows, and why
 *
 * - **The model is never mocked.** Only its tools are. A faked answer makes a suite that verifies
 *   nothing; `packages/*` tests are where the harness is tested against a fake endpoint.
 * - **What code can decide, code decides.** Which tools were called with which arguments is a fact
 *   about the call log, never a question for the judge.
 * - **The judge is a different model** from the agent's (refused otherwise), answers pass or fail
 *   per criterion, and never gives a score.
 * - **Pass counts over runs, never one verdict.** "4 of 5" is the measurement; the threshold is a
 *   fraction of runs per scenario, and any scenario below it exits non-zero.
 * - **Prompt changes are deploys.** Rerun this before changing a template, a prompt or a model.
 *
 * Each run gets a fresh copy of the agent directory and an in-memory store, so `memory_write` and
 * friends never touch the source, and runs cannot leak into each other.
 *
 * The agent's model reads its key from the environment and the `.env` beside its manifest, as
 * always. The judge reads `JUDGE_BASE_URL`, `JUDGE_MODEL` and the key named by `JUDGE_API_KEY_ENV`
 * (default `JUDGE_API_KEY`), from the process environment or `./.env`.
 */

import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { Runtime } from "../packages/core/src/runtime/runtime.ts"
import type { Tool, ToolProvider, ToolProviderFactory } from "../packages/core/src/tools/types.ts"
import { type Call, checkCalls } from "./scenario-check.ts"

// ─── the files ───────────────────────────────────────────────────────────────────────────

const ToolDecl = z.object({
    /** The provider this tool stands in for — `composio`, `system`, `web` — or `scenario`. */
    provider: z.string().min(1).default("scenario"),
    summary: z.string().min(1),
    when_to_use: z.string().min(1),
    when_not_to_use: z.string().min(1).optional(),
    mutating: z.boolean().default(false),
    parameters: z
        .object({
            type: z.literal("object"),
            properties: z.record(z.string(), z.unknown()),
            required: z.array(z.string()).optional(),
        })
        .default({ type: "object", properties: {} }),
})

const Suite = z.object({
    agent: z.string().min(1),
    tools: z.record(z.string(), ToolDecl).default({}),
    calibration: z
        .array(
            z.object({
                criterion: z.string().min(1),
                reply: z.string(),
                expect: z.enum(["pass", "fail"]),
            }),
        )
        .min(2, "calibration needs at least one reply that passes and one that fails"),
})

const Step = z.object({
    prompt: z.string().min(1),
    expected_calls: z
        .array(
            z.object({
                slug: z.string().min(1),
                args: z.record(z.string(), z.unknown()).optional(),
            }),
        )
        .default([]),
    order: z.enum(["exact", "in_order", "any_order"]).default("in_order"),
    criteria: z
        .array(z.string().min(1))
        .min(1)
        .max(4, "four criteria at most: each must be checkable in five seconds"),
    mocks: z.record(z.string(), z.unknown()).default({}),
})

const Scenario = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    steps: z.array(Step).min(1),
})

type SuiteFile = z.infer<typeof Suite>
type ScenarioFile = z.infer<typeof Scenario>

function fail(message: string, hint: string): never {
    process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`)
    process.exit(1)
}

function readYaml<T>(path: string, schema: z.ZodType<T>): T {
    const parsed = schema.safeParse(parseYaml(readFileSync(path, "utf8")))
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        fail(
            `${relative(process.cwd(), path)}: ${issue?.path.join(".") || "(root)"} — ${issue?.message ?? "invalid"}`,
            "Scenario files are checked before anything runs, so a typo costs nothing. See scripts/eval-scenarios.ts for the shape.",
        )
    }
    return parsed.data
}

// ─── the mocked tools ────────────────────────────────────────────────────────────────────

/** Mutable per step: which results the tools hand back, and what was called. */
interface Stage {
    mocks: Record<string, unknown>
    calls: Call[]
}

/**
 * One factory per provider id the suite impersonates. A pinned slug nobody mocks is not resolved,
 * so the load fails naming it — a scenario that silently lacked a tool would measure the gap.
 */
function mockProviders(suite: SuiteFile, stage: Stage): Record<string, ToolProviderFactory> {
    const ids = new Set([
        "scenario",
        "system",
        "web",
        "composio",
        ...Object.values(suite.tools).map((t) => t.provider),
    ])
    const factories: Record<string, ToolProviderFactory> = {}
    for (const id of ids) {
        factories[id] = (): ToolProvider => {
            const tools: Tool[] = Object.entries(suite.tools)
                .filter(([, decl]) => decl.provider === id)
                .map(([slug, decl]) => ({
                    spec: {
                        slug,
                        provider: id,
                        summary: decl.summary,
                        whenToUse: decl.when_to_use,
                        ...(decl.when_not_to_use === undefined
                            ? {}
                            : { whenNotToUse: decl.when_not_to_use }),
                        mutating: decl.mutating,
                        // Scenario results are written by the suite's author, not by a stranger.
                        trust: "trusted",
                        trustReason: "a scenario mock: the suite's author wrote the result",
                        tags: [],
                        parameters: decl.parameters as Tool["spec"]["parameters"],
                    },
                    handler: (args) => {
                        stage.calls.push({ slug, args })
                        if (!(slug in stage.mocks)) {
                            throw new Error(
                                `${slug} has no mock in this step. hint: add it under the step's mocks, or it was the wrong tool to call.`,
                            )
                        }
                        const value = stage.mocks[slug]
                        return typeof value === "string" ? value : JSON.stringify(value)
                    },
                }))
            return {
                id,
                resolve: async (slugs) => tools.filter((tool) => slugs.includes(tool.spec.slug)),
                list: async () => tools.map((tool) => tool.spec.slug),
            }
        }
    }
    return factories
}

// ─── the judge ───────────────────────────────────────────────────────────────────────────

interface Judge {
    readonly model: string
    verdict(
        criterion: string,
        conversation: string,
        reply: string,
    ): Promise<{ pass: boolean; reason: string } | { error: string }>
}

function judgeFromEnv(env: Readonly<Record<string, string | undefined>>): Judge {
    const baseUrl = env.JUDGE_BASE_URL
    const model = env.JUDGE_MODEL
    const keyEnv = env.JUDGE_API_KEY_ENV ?? "JUDGE_API_KEY"
    const key = env[keyEnv]
    if (baseUrl === undefined || model === undefined) {
        fail(
            "No judge configured",
            "Set JUDGE_BASE_URL and JUDGE_MODEL (an OpenAI-compatible endpoint, and a different model from the agent's), and the key in JUDGE_API_KEY or the variable JUDGE_API_KEY_ENV names.",
        )
    }
    return {
        model,
        async verdict(criterion, conversation, reply) {
            const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
                },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    messages: [
                        {
                            role: "system",
                            content:
                                'You check one criterion against an assistant\'s reply. Judge only the stated criterion, literally, as a fact about the reply — not its quality, tone or helpfulness beyond what the criterion says. Answer with JSON only: {"pass": true|false, "reason": "<one short sentence>"}.',
                        },
                        {
                            role: "user",
                            content: `Conversation so far:\n${conversation}\n\nThe assistant's reply to judge:\n<<<\n${reply}\n>>>\n\nCriterion: ${criterion}`,
                        },
                    ],
                }),
            })
            if (!response.ok)
                return {
                    error: `judge answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
                }
            const body = (await response.json()) as {
                choices?: { message?: { content?: string } }[]
            }
            const text = body.choices?.[0]?.message?.content ?? ""
            const json = /\{[\s\S]*\}/.exec(text)?.[0]
            try {
                const parsed = JSON.parse(json ?? "") as { pass?: unknown; reason?: unknown }
                if (typeof parsed.pass !== "boolean")
                    return { error: `judge gave no boolean: ${text.slice(0, 200)}` }
                return {
                    pass: parsed.pass,
                    reason: typeof parsed.reason === "string" ? parsed.reason : "",
                }
            } catch {
                return { error: `judge reply was not JSON: ${text.slice(0, 200)}` }
            }
        },
    }
}

// ─── running ─────────────────────────────────────────────────────────────────────────────

interface Failure {
    readonly run: number
    readonly step: number
    readonly kind: "calls" | "criterion" | "turn" | "judge"
    readonly detail: string
    readonly reply?: string
}

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const suiteDir = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"))
if (suiteDir === undefined) {
    fail(
        "No suite given",
        "bun run eval:scenarios evals/scenarios/example [--runs 3] [--threshold 0.8]",
    )
}
const SUITE_DIR = resolve(suiteDir)
const RUNS = Math.max(1, Number(flag("runs", "3")))
const THRESHOLD = Number(flag("threshold", "0.8"))
const ONLY = flag("only", "")
const OUT = resolve(flag("out", join(SUITE_DIR, "results.json")))

const suite = readYaml(join(SUITE_DIR, "suite.yaml"), Suite)
const agentManifest = resolve(SUITE_DIR, suite.agent)
if (!existsSync(agentManifest)) {
    fail(
        `The suite's agent is not at ${agentManifest}`,
        "`agent:` in suite.yaml is a path to an agent.yaml, relative to the suite directory.",
    )
}
const scenarioDir = join(SUITE_DIR, "scenarios")
const scenarios: ScenarioFile[] = readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .sort()
    .map((file) => readYaml(join(scenarioDir, file), Scenario))
    .filter((scenario) => ONLY === "" || scenario.name === ONLY)
if (scenarios.length === 0)
    fail(`No scenarios in ${scenarioDir}`, "Add a YAML file per scenario under scenarios/.")

const dotEnv = existsSync(".env") ? parseDotEnv(readFileSync(".env", "utf8")) : {}
const processEnv: Record<string, string | undefined> = { ...dotEnv, ...process.env }
const judge = judgeFromEnv(processEnv)

/** Boot a fresh copy of the agent, with this stage's mocks behind its providers. */
async function boot(stage: Stage): Promise<{ runtime: Runtime; home: string }> {
    const home = mkdtempSync(join(tmpdir(), "eval-scenarios-"))
    const copy = join(home, "agent")
    cpSync(dirname(agentManifest), copy, { recursive: true })
    const runtime = await Runtime.create({
        agents: [join(copy, basename(agentManifest))],
        env: processEnv,
        store: ":memory:",
        toolProviders: mockProviders(suite, stage),
    })
    return { runtime, home }
}

// Calibration first: a judge that misreads a known case would make every number below noise.
for (const case_ of suite.calibration) {
    const verdict = await judge.verdict(case_.criterion, "(calibration)", case_.reply)
    const got = "error" in verdict ? `error: ${verdict.error}` : verdict.pass ? "pass" : "fail"
    if (got !== case_.expect) {
        fail(
            `The judge (${judge.model}) called a calibration case "${got}", expected "${case_.expect}": ${case_.criterion}`,
            "Nothing was scored. Use a stronger judge model, or rewrite the criterion as a plainer fact about the reply.",
        )
    }
}
process.stdout.write(`judge ${judge.model} calibrated on ${suite.calibration.length} cases\n`)

const stage: Stage = { mocks: {}, calls: [] }
const probe = await boot(stage)
const agentModel = probe.runtime.list()[0]?.describe().model ?? "(unknown)"
await probe.runtime.stop()
rmSync(probe.home, { recursive: true, force: true })
if (agentModel === judge.model) {
    fail(
        `The judge is the agent's own model (${agentModel})`,
        "A model grading its own replies agrees with itself. Point JUDGE_MODEL at a different model.",
    )
}
process.stdout.write(
    `agent model ${agentModel} · ${scenarios.length} scenario(s) × ${RUNS} run(s)\n\n`,
)

const results: { name: string; passed: number; runs: number; rate: number; failures: Failure[] }[] =
    []
let judgeErrors = 0
let judgeCalls = 0

for (const scenario of scenarios) {
    let passed = 0
    const failures: Failure[] = []
    for (let run = 1; run <= RUNS; run += 1) {
        const { runtime, home } = await boot(stage)
        const agent = runtime.list()[0]
        let ok = agent !== undefined
        const transcript: string[] = []
        try {
            for (const [index, step] of scenario.steps.entries()) {
                if (agent === undefined) break
                stage.mocks = step.mocks
                stage.calls = []
                const result = await agent.send(step.prompt, { sessionKey: `api:scenario-${run}` })
                transcript.push(`user: ${step.prompt}`)
                if (result.reason !== "final") {
                    ok = false
                    failures.push({
                        run,
                        step: index + 1,
                        kind: "turn",
                        detail: `turn ended ${result.reason}`,
                        reply: result.text,
                    })
                    break
                }
                const callProblem = checkCalls(step.expected_calls, stage.calls, step.order)
                if (callProblem !== undefined) {
                    ok = false
                    failures.push({
                        run,
                        step: index + 1,
                        kind: "calls",
                        detail: callProblem,
                        reply: result.text,
                    })
                }
                for (const criterion of step.criteria) {
                    judgeCalls += 1
                    const verdict = await judge.verdict(
                        criterion,
                        transcript.join("\n"),
                        result.text,
                    )
                    if ("error" in verdict) {
                        judgeErrors += 1
                        ok = false
                        failures.push({
                            run,
                            step: index + 1,
                            kind: "judge",
                            detail: verdict.error,
                        })
                    } else if (!verdict.pass) {
                        ok = false
                        failures.push({
                            run,
                            step: index + 1,
                            kind: "criterion",
                            detail: `${criterion} — ${verdict.reason}`,
                            reply: result.text,
                        })
                    }
                }
                transcript.push(`assistant: ${result.text}`)
            }
        } finally {
            await runtime.stop()
            rmSync(home, { recursive: true, force: true })
        }
        if (ok) passed += 1
    }
    const rate = passed / RUNS
    results.push({ name: scenario.name, passed, runs: RUNS, rate, failures })
    process.stdout.write(
        `${rate >= THRESHOLD ? "ok  " : "FAIL"}  ${scenario.name}: ${passed} of ${RUNS}\n`,
    )
    for (const f of failures.slice(0, 3))
        process.stdout.write(`        run ${f.run} step ${f.step} ${f.kind}: ${f.detail}\n`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(
    OUT,
    `${JSON.stringify(
        {
            measuredAt: new Date().toISOString(),
            suite: relative(process.cwd(), SUITE_DIR),
            agentModel,
            judgeModel: judge.model,
            runs: RUNS,
            threshold: THRESHOLD,
            judgeErrors,
            results,
        },
        null,
        2,
    )}\n`,
)
process.stdout.write(`\nwrote ${relative(process.cwd(), OUT)}\n`)

// A judge that could not answer is not a verdict; past a fifth of its calls the numbers are noise.
if (judgeCalls > 0 && judgeErrors / judgeCalls > 0.2) {
    fail(
        `The judge failed ${judgeErrors} of ${judgeCalls} calls`,
        "The results were written but mean little. Check the judge endpoint and key, then rerun.",
    )
}
const below = results.filter((r) => r.rate < THRESHOLD)
if (below.length > 0) {
    fail(
        `${below.length} scenario(s) below the ${THRESHOLD} threshold: ${below.map((b) => b.name).join(", ")}`,
        "Read the failures in the results file before changing anything: a calls failure is routing, a criterion failure is the reply.",
    )
}
