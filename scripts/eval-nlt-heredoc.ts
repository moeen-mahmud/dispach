/**
 * How often does a real model write a multi-line `exec` argument the NLT parser silently truncates?
 *
 * This exists because the carried backlog forbids fixing the leak from first principles. The failure
 * was found by hand against `python3 <<PY`, and this repo's rule is that the set of malformations is
 * not enumerable — so a tolerance written for the one shape somebody happened to reproduce is the
 * wrong instinct, and worse than the bug because it invites the belief the class is handled. The
 * backstop has to be built against shapes a model actually produces, which means collecting them.
 *
 * ## What it measures
 *
 * One model call per fixture, **nothing executed**. Every task asks for something whose natural
 * argument spans lines; the raw output is kept on every attempt, not only the failures, because the
 * fixture corpus is the deliverable here and a clean wrap is as informative as a truncation — it is
 * the evidence that a backstop firing on it would be a false positive.
 *
 * Each attempt is classified by comparing what the parser produced against the raw text:
 *
 *   `wrapped`     the model used `<<<` / `>>>`; the value survived intact. The good path.
 *   `split`       **the bug.** A heredoc opener is in the parsed argument, its terminator word is
 *                 not, and it turns up in the reply instead. Definitive rather than heuristic:
 *                 a shell heredoc names its own terminator, so the evidence is inside the value.
 *   `orphaned`    intents parsed and the reply looks like abandoned value rather than prose —
 *                 indented, unpunctuated, or code. The same failure without a heredoc to prove it.
 *   `field_error` a bare `word:` line inside the value became a field. The loud variant: `coerceArgs`
 *                 refuses it and the model earns a repair, so this one is survivable today.
 *   `single_line` the model wrote a one-liner. No multi-line value, nothing to lose.
 *   `no_call`     it answered in prose. Not a parser outcome.
 *
 * `split` and `orphaned` are the rate the backstop has to move to zero without moving `wrapped` or
 * a legitimate `single_line` reply off it.
 *
 * Usage:
 *   bun scripts/eval-nlt-heredoc.ts
 *   bun scripts/eval-nlt-heredoc.ts --model deepseek-chat
 *   bun scripts/eval-nlt-heredoc.ts --repeats 2
 *   bun scripts/eval-nlt-heredoc.ts --out evals/nlt-heredoc
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HEREDOC_TASKS, type HeredocTask } from "../evals/fixtures/heredoc.ts"
import { assembleContext } from "../packages/core/src/context/assemble.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { resolveCapabilities } from "../packages/core/src/model/capabilities.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import type { ChatChunk } from "../packages/core/src/model/provider.ts"
import { nltDialect } from "../packages/core/src/tools/dialect/nlt.ts"
import { ToolRegistry } from "../packages/core/src/tools/registry.ts"
import type { Tool, ToolProvider } from "../packages/core/src/tools/types.ts"
import { EXEC_SPEC } from "../packages/tools-system/src/exec.ts"

// ─── the catalogue ───────────────────────────────────────────────────────────────────────

/**
 * The real `exec` spec, not a fixture copy.
 *
 * The argument descriptions are half of what decides how a model writes the value — "exactly as it
 * would be typed at a shell prompt" is an invitation to a heredoc — so a paraphrased spec would
 * measure a tool that does not ship. A script may import a sibling package; hard rule 2 binds
 * `packages/core`, and nothing here runs inside it.
 */
function execOnlyProvider(): ToolProvider {
    const tool: Tool = {
        spec: EXEC_SPEC,
        handler: () => {
            throw new Error(
                "exec was executed. This probe collects output shapes and runs nothing — a handler reached here is a bug in scripts/eval-nlt-heredoc.ts.",
            )
        },
    }
    return {
        id: "eval-system",
        resolve: async (slugs) => (slugs.includes("exec") ? [tool] : []),
        list: async () => ["exec"],
    }
}

interface ModelUnderTest {
    readonly label: string
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv?: string
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
}

const MODELS: readonly ModelUnderTest[] = [
    {
        label: "deepseek-chat",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    {
        label: "gpt-4o-mini",
        id: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
    },
]

function smallModel(env: Record<string, string | undefined>): ModelUnderTest | undefined {
    const id = env.SMALL_MODEL_ID
    const baseUrl = env.SMALL_MODEL_BASE_URL
    if (id === undefined || id === "" || baseUrl === undefined || baseUrl === "") return undefined
    return {
        label: `${id} (open-weight)`,
        id,
        baseUrl,
        ...(env.SMALL_MODEL_API_KEY === undefined || env.SMALL_MODEL_API_KEY === ""
            ? {}
            : { apiKeyEnv: "SMALL_MODEL_API_KEY" }),
        ...(env.SMALL_MODEL_REASONING === undefined
            ? {}
            : {
                  reasoningEffort: env.SMALL_MODEL_REASONING as
                      | "none"
                      | "minimal"
                      | "low"
                      | "medium"
                      | "high",
              }),
    }
}

const IDENTITY = `You are a careful assistant with access to tools.

You work on this machine. Reply directly when no tool is needed.`

// ─── classification ──────────────────────────────────────────────────────────────────────

type Shape =
    | "wrapped"
    | "split"
    | "orphaned"
    | "indent_lost"
    | "field_error"
    | "single_line"
    | "unknown_tool"
    | "no_call"

/** `<<PY`, `<<'EOF'`, `<<-"SQL"` — the opener, and the terminator word it promises. */
const HEREDOC_OPENER = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/

/**
 * Does this reply read as an abandoned value rather than as something written to a person?
 *
 * Only consulted when a block parsed *and* left prose behind, which is already the suspicious case.
 * Deliberately loose: a false `orphaned` here costs a line in a report somebody reads, while the
 * equivalent looseness inside the parser would cost a repair turn. The two thresholds are not the
 * same decision and this one is not evidence for that one.
 */
function readsAsAbandonedValue(text: string): boolean {
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    if (lines.length === 0) return false
    const first = lines[0] ?? ""
    // Indentation is the strongest single signal: nobody indents the first line of a reply.
    if (/^\s+\S/.test(first)) return true
    // A lone terminator word, a closing brace, a shell keyword ending a block.
    if (/^(done|fi|esac|EOF|PY|SQL|YAML|\}|\)|;;)\s*$/.test(first)) return true
    // Code-ish punctuation density with no sentence in sight.
    const codeish = /[=;{}()[\]<>|&]|^\s*(print|echo|import|def|for|if|while|return|cat)\b/
    return codeish.test(first) && !/[.!?]\s*$/.test(first)
}

interface Attempt {
    readonly task: string
    readonly shape: Shape
    /** The parsed `command`, so a split can be read rather than described. */
    readonly command?: string
    /** What the parser handed back as the reply. Empty on a clean call. */
    readonly reply: string
    /** Set when the parser reported the output unreadable. Today: never, on the split path. */
    readonly malformed: readonly string[]
    readonly note?: string
    /** The model's complete output. The corpus this probe exists to produce. */
    readonly raw: string
    readonly latencyMs: number
}

function classify(raw: string, task: HeredocTask): Omit<Attempt, "raw" | "latencyMs" | "task"> {
    const parsed = nltDialect.parse({ text: raw, calls: [] })
    const malformed = (parsed.malformed ?? []).map((error) => `${error.field}: ${error.message}`)
    const reply = parsed.text

    if (parsed.intents.length === 0) {
        return { shape: "no_call", reply, malformed, note: task.id }
    }

    // The catalogue holds `exec` alone, and a model handed one tool will still reach for `file_write`
    // when a task is shaped like writing a file. That is a routing outcome and `evals/tools` measures
    // it; counted separately here so it cannot be read as a parser failure. It was one, briefly — the
    // first run classified two of these as "no command argument parsed", which is true of an intent
    // that was never an `exec` call and says nothing about the value the parser kept.
    const first = parsed.intents.find((intent) => intent.slug === "exec")
    if (first === undefined) {
        return {
            shape: "unknown_tool",
            reply,
            malformed,
            note: `called ${parsed.intents.map((intent) => intent.slug).join(", ")}`,
        }
    }

    const command = typeof first.args.command === "string" ? first.args.command : undefined
    if (command === undefined) {
        return { shape: "field_error", reply, malformed, note: "no command argument parsed" }
    }

    // A field the tool does not declare is the loud variant: a bare `word:` line inside the value
    // became a key. Detected from the argument names rather than by running `coerceArgs`, so the
    // probe reports the shape without depending on the coercer's current strictness.
    const declared = new Set(Object.keys(EXEC_SPEC.parameters.properties ?? {}))
    const strays = Object.keys(first.args).filter((name) => !declared.has(name))
    if (strays.length > 0) {
        return {
            shape: "field_error",
            command,
            reply,
            malformed,
            note: `stray fields: ${strays.join(", ")}`,
        }
    }

    const opener = HEREDOC_OPENER.exec(command)
    if (opener !== null) {
        const terminator = opener[1] ?? ""
        const closed = new RegExp(`^\\s*${terminator}\\s*$`, "m").test(command)
        if (closed) return { shape: "wrapped", command, reply, malformed }
        const leaked = new RegExp(`^\\s*${terminator}\\s*$`, "m").test(reply)
        return {
            shape: "split",
            command,
            reply,
            malformed,
            note: leaked
                ? `terminator ${terminator} landed in the reply`
                : `terminator ${terminator} is nowhere — the value was cut`,
        }
    }

    if (reply.trim() !== "" && readsAsAbandonedValue(reply)) {
        return { shape: "orphaned", command, reply, malformed, note: "reply reads as value" }
    }

    if (!command.includes("\n")) return { shape: "single_line", command, reply, malformed }

    // A multi-line value that was *not* wrapped survives the split and still arrives damaged: the
    // continuation branch pushes the **trimmed** line, so every leading space is gone. Found here
    // rather than reasoned about — `def f(x):` / `    return x * 2` came back with the body at
    // column zero, which is an `IndentationError` rather than a script. Loud at the shell, which is
    // why it ranks below `split`, but it means an unwrapped multi-line value is never usable for
    // anything whitespace-sensitive.
    const indentedInRaw = raw
        .split("\n")
        .filter((line) => /^\s+\S/.test(line))
        .map((line) => line.trim())
    const flattened = command.split("\n").map((line) => line.trim())
    const lost = indentedInRaw.some(
        (line) =>
            line !== "" &&
            flattened.includes(line) &&
            !new RegExp(`^\\s+${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(command),
    )
    if (lost) {
        return {
            shape: "indent_lost",
            command,
            reply,
            malformed,
            note: "continuation lines trimmed",
        }
    }

    return { shape: "wrapped", command, reply, malformed }
}

// ─── the run ─────────────────────────────────────────────────────────────────────────────

interface ModelResult {
    readonly model: string
    readonly attempts: readonly Attempt[]
}

async function runModel(
    model: ModelUnderTest,
    registry: ToolRegistry,
    env: Record<string, string | undefined>,
    repeats: number,
): Promise<ModelResult> {
    const provider = createChatCompletionsProvider({
        baseUrl: model.baseUrl,
        ...(model.apiKeyEnv === undefined ? {} : { apiKeyEnv: model.apiKeyEnv }),
        env,
        retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 4000 },
    })

    const specs = registry.specs()
    const blocks = nltDialect.renderCatalogue(specs)
    const capabilities = resolveCapabilities(model.id)
    const attempts: Attempt[] = []

    for (const task of HEREDOC_TASKS) {
        for (let pass = 0; pass < repeats; pass += 1) {
            const assembled = assembleContext({
                identity: IDENTITY,
                toolBlocks: blocks,
                history: [],
                input: task.prompt,
                window: capabilities.contextWindow,
                reserveOutput: Math.min(2048, capabilities.maxOutput),
            })

            const started = performance.now()
            let raw = ""
            try {
                const stream = provider.chat(
                    {
                        model: model.id,
                        messages: assembled.messages,
                        temperature: 0,
                        maxTokens: Math.min(2048, capabilities.maxOutput),
                        ...(model.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: model.reasoningEffort }),
                    },
                    AbortSignal.timeout(180_000),
                )
                for await (const chunk of stream as AsyncIterable<ChatChunk>) {
                    if (chunk.type === "text") raw += chunk.delta
                }
            } catch (error) {
                attempts.push({
                    task: task.id,
                    shape: "no_call",
                    reply: "",
                    malformed: [],
                    note: `transport: ${error instanceof Error ? error.message : String(error)}`,
                    raw,
                    latencyMs: Math.round(performance.now() - started),
                })
                continue
            }

            attempts.push({
                task: task.id,
                ...classify(raw, task),
                raw,
                latencyMs: Math.round(performance.now() - started),
            })
            process.stdout.write(".")
        }
    }
    process.stdout.write("\n")
    return { model: model.label, attempts }
}

function flag(name: string, argv: readonly string[]): string | undefined {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
}

async function main(argv: readonly string[]): Promise<number> {
    const env = { ...process.env, ...parseDotEnv(".env") }
    const only = flag("model", argv)
    const repeats = Number(flag("repeats", argv) ?? "1")
    const out = flag("out", argv) ?? "evals/nlt-heredoc"

    const all = [
        ...MODELS,
        ...(smallModel(env) === undefined ? [] : [smallModel(env) as ModelUnderTest]),
    ]
    const candidates = all
        .filter((model) => only === undefined || model.label.includes(only) || model.id === only)
        .filter((model) => {
            if (model.apiKeyEnv === undefined) return true
            const key = env[model.apiKeyEnv]
            if (key === undefined || key === "") {
                console.log(`skipping ${model.label}: ${model.apiKeyEnv} is not set`)
                return false
            }
            return true
        })

    if (candidates.length === 0) {
        console.error(
            "eval-nlt-heredoc: no model is reachable. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, or configure SMALL_MODEL_BASE_URL.",
        )
        return 1
    }

    const registry = await ToolRegistry.create({
        pinned: ["exec"],
        providers: [execOnlyProvider()],
    })

    const startedAt = new Date().toISOString()
    const results: ModelResult[] = []
    for (const model of candidates) {
        console.log(`\n${model.label} · ${HEREDOC_TASKS.length} tasks × ${repeats}`)
        results.push(await runModel(model, registry, env, repeats))
    }

    for (const result of results) {
        const counts = new Map<Shape, number>()
        for (const attempt of result.attempts) {
            counts.set(attempt.shape, (counts.get(attempt.shape) ?? 0) + 1)
        }
        const leaked = (counts.get("split") ?? 0) + (counts.get("orphaned") ?? 0)
        const damaged = leaked + (counts.get("indent_lost") ?? 0)
        console.log(`\n${result.model}`)
        for (const [shape, count] of [...counts].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${shape.padEnd(12)} ${count}`)
        }
        console.log(
            `  silently truncated: ${leaked}/${result.attempts.length}` +
                `  · value damaged at all: ${damaged}/${result.attempts.length}` +
                `  (reported as malformed: ${result.attempts.filter((a) => a.malformed.length > 0).length})`,
        )
        for (const attempt of result.attempts.filter(
            (entry) =>
                entry.shape === "split" ||
                entry.shape === "orphaned" ||
                entry.shape === "indent_lost",
        )) {
            console.log(`    ${attempt.task}: ${attempt.note ?? ""}`)
        }
    }

    mkdirSync(out, { recursive: true })
    writeFileSync(
        join(out, "results.json"),
        `${JSON.stringify({ startedAt, repeats, results }, null, 2)}\n`,
    )
    console.log(`\nwritten to ${join(out, "results.json")}`)
    return 0
}

main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
})
