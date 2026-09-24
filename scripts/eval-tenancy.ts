#!/usr/bin/env bun
/**
 * Density: what one silo costs to keep, idle.
 *
 *   bun scripts/eval-tenancy.ts [--counts 1,10,100] [--runs 3] [--node node] [--out evals/tenancy]
 *                               [--entry path/to/cli/dist/index.js]
 *
 * Runs under Node as well (`node scripts/eval-tenancy.ts`), which is how it runs inside the image:
 * `--entry` points at the globally installed package, so the thing measured is the published
 * artefact rather than this checkout's build.
 *
 * Runs the **built** CLI's `serve` under Node — the shipped path — against a fresh sandbox holding N
 * copies of the agent `init --yes` generates, and measures, per run:
 *
 * - `coldStartMs`: spawn → `GET /v1/ready` answering 200. Includes interpreter start, as a cold
 *   silo would.
 * - `idleRssKb`: the median of five `ps` samples one second apart, after ten seconds of quiet. The
 *   post-readiness provider refresh happens inside that settle, so it is not counted as idle.
 * - `resumeMs`: `SIGSTOP` for two seconds, then `SIGCONT` → `GET /v1/health` answering 200. An
 *   **approximation** of a platform suspend (a Fly Machine suspend snapshots the whole VM, and its
 *   restore time is the platform's, not this process's): what it does show is that nothing in the
 *   process needs re-establishing after a freeze before it serves again.
 *
 * Needs `bun run build` first. Makes no model calls and reaches no model endpoint: the key is a
 * placeholder, which is also why nothing here measures a turn.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { arch, cpus, platform, tmpdir, totalmem } from "node:os"
import { join, resolve } from "node:path"
import { BRAND } from "../packages/core/src/brand.ts"

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const ROOT = resolve(import.meta.dirname, "..")
const ENTRY = resolve(ROOT, flag("entry", "packages/cli/dist/index.js"))
const NODE = flag("node", "node")
const COUNTS = flag("counts", "1,10,100").split(",").map(Number)
const RUNS = Math.max(1, Number(flag("runs", "3")))
const OUT = resolve(ROOT, flag("out", "evals/tenancy"))
const SETTLE_MS = 10_000

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

function childEnv(home: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        [`${BRAND.envPrefix}HOME`]: home,
        [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1",
        MODEL_API_KEY: "eval-placeholder",
    }
}

/** One `init --yes` agent, copied N times with its id rewritten. The sandbox is the inventory. */
function sandbox(count: number): string {
    const home = mkdtempSync(join(tmpdir(), "eval-tenancy-"))
    const made = spawnSync(NODE, [ENTRY, "init", "--yes", "--name", "seed", "--user", "ada"], {
        env: childEnv(home),
        encoding: "utf8",
    })
    if (made.status !== 0) throw new Error(`init failed:\n${made.stderr || made.stdout}`)
    const agents = join(home, "agents")
    const seed = join(agents, "seed")
    const manifest = readFileSync(join(seed, "agent.yaml"), "utf8")
    for (let i = 1; i <= count; i += 1) {
        const dir = join(agents, `a${i}`)
        cpSync(seed, dir, { recursive: true })
        writeFileSync(
            join(dir, "agent.yaml"),
            manifest.replace(/^id: seed$/m, `id: a${i}`).replace(/^name: seed$/m, `name: a${i}`),
        )
    }
    rmSync(seed, { recursive: true, force: true })
    // `init` left a store behind holding the seed's rows; a silo starts from nothing.
    rmSync(join(home, "store.db"), { force: true })
    return home
}

async function until(url: string, deadlineMs: number): Promise<number> {
    const started = performance.now()
    while (performance.now() - started < deadlineMs) {
        try {
            const response = await fetch(url)
            if (response.ok) return performance.now() - started
        } catch {
            // Not listening yet.
        }
        await sleep(5)
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`)
}

/** Resident set, in KiB. `/proc` where there is one — the slim image has no `ps`. */
function rssKb(pid: number): number {
    try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8")
        const line = status.split("\n").find((l) => l.startsWith("VmRSS:"))
        if (line !== undefined) return Number(line.replace(/\D+/g, ""))
    } catch {
        // Not Linux.
    }
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })
    return Number(out.stdout.trim())
}

async function stopped(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    const exited = new Promise((done) => child.once("exit", done))
    child.kill("SIGTERM")
    await Promise.race([exited, sleep(10_000)])
    if (child.exitCode === null) child.kill("SIGKILL")
}

interface Run {
    readonly coldStartMs: number
    readonly idleRssKb: number
    readonly resumeMs: number
    readonly agentsHosted: number
}

async function measure(count: number, port: number): Promise<Run> {
    const home = sandbox(count)
    const base = `http://127.0.0.1:${port}`
    const spawned = performance.now()
    const child = spawn(NODE, [ENTRY, "serve", "--port", String(port)], {
        env: childEnv(home),
        stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
    })
    try {
        await until(`${base}/v1/ready`, 120_000)
        const coldStartMs = performance.now() - spawned
        const health = (await (await fetch(`${base}/v1/health`)).json()) as { agents: number }

        await sleep(SETTLE_MS)
        const samples: number[] = []
        for (let i = 0; i < 5; i += 1) {
            samples.push(rssKb(child.pid ?? 0))
            await sleep(1_000)
        }

        child.kill("SIGSTOP")
        await sleep(2_000)
        const resumed = performance.now()
        child.kill("SIGCONT")
        await until(`${base}/v1/health`, 10_000)
        const resumeMs = performance.now() - resumed

        return { coldStartMs, idleRssKb: median(samples), resumeMs, agentsHosted: health.agents }
    } catch (error) {
        throw new Error(`${count} agents: ${String(error)}\n${stderr.slice(-2000)}`)
    } finally {
        await stopped(child)
        rmSync(home, { recursive: true, force: true })
    }
}

const results: Record<string, { runs: Run[]; median: Omit<Run, "agentsHosted"> }> = {}
let port = 7700
for (const count of COUNTS) {
    const runs: Run[] = []
    for (let r = 0; r < RUNS; r += 1) {
        const run = await measure(count, port++)
        if (run.agentsHosted !== count) {
            throw new Error(`asked for ${count} agents and the server hosts ${run.agentsHosted}`)
        }
        runs.push(run)
        console.log(
            `${String(count).padStart(4)} agents  run ${r + 1}: ready ${run.coldStartMs.toFixed(0)} ms, idle ${(run.idleRssKb / 1024).toFixed(1)} MB, resume ${run.resumeMs.toFixed(1)} ms`,
        )
    }
    results[String(count)] = {
        runs,
        median: {
            coldStartMs: median(runs.map((r) => r.coldStartMs)),
            idleRssKb: median(runs.map((r) => r.idleRssKb)),
            resumeMs: median(runs.map((r) => r.resumeMs)),
        },
    }
}

const nodeVersion = spawnSync(NODE, ["--version"], { encoding: "utf8" }).stdout.trim()
mkdirSync(OUT, { recursive: true })
writeFileSync(
    join(OUT, "results.json"),
    `${JSON.stringify(
        {
            measuredAt: new Date().toISOString(),
            environment: {
                node: nodeVersion,
                platform: platform(),
                arch: arch(),
                cpu: cpus()[0]?.model ?? "unknown",
                cpus: cpus().length,
                memoryMb: Math.round(totalmem() / 1024 / 1024),
            },
            entry: ENTRY,
            agent: "init --yes (system, web and composio providers named; starter skill; no channels)",
            settleMs: SETTLE_MS,
            results,
        },
        null,
        2,
    )}\n`,
)
console.log(`\nwrote ${join(OUT, "results.json")}`)
