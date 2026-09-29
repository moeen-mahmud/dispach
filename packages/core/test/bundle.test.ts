/**
 * Export and import a slice of an agent (doc 16 R11), through a real runtime: a fact moves from one
 * agent to another and is recalled there, twice-imported changes nothing, and a bundle the agent could
 * not load leaves nothing behind.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BRAND,
    type ChatChunk,
    type ChatMessage,
    exportBundle,
    importBundle,
    isHarnessError,
    type ModelTransport,
    Runtime,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

function model(seen: ChatMessage[][]): ModelTransport {
    return {
        create: (context) => ({
            id: context.id,
            async *chat(request): AsyncIterable<ChatChunk> {
                seen.push([...request.messages])
                yield { type: "text", delta: "ok" }
                yield { type: "finish", reason: "stop" }
            },
        }),
    }
}

function agentDir(root: string, id: string, files: Record<string, string>): string {
    const dir = join(root, id)
    for (const sub of ["workspace", "memory", "knowledge"])
        mkdirSync(join(dir, sub), { recursive: true })
    writeFileSync(
        join(dir, "workspace", "MEMORY.md"),
        `---\ntier: volatile\neditable: replace\nbudget: 2000\neviction: oldest\n---\n\n# What I know\n\n${files.carried ?? ""}\n`,
    )
    for (const [path, content] of Object.entries(files)) {
        if (path !== "carried") writeFileSync(join(dir, path), content)
    }
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: ${id}
model:
  main:
    id: m
    api: ${id}
    capabilities:
      nativeTools: true
context:
  workspace: ./workspace
  volatile:
    - MEMORY.md
memory:
  dir: ./memory
  threshold: 0.05
knowledge:
  dir: ./knowledge
tools:
  dialect: native
`,
    )
    return dir
}

const KNOWLEDGE =
    "---\nkeywords: [deploy]\n---\n\nDeploys go out on Tuesdays through the blue pipeline.\n"

async function pair() {
    const root = mkdtempSync(join(tmpdir(), "bundle-"))
    const aDir = agentDir(root, "alpha", {
        carried: "- **2026-09-01T10:00:00.000Z** The client's fiscal year ends in March",
        "memory/2026-08.md": "- **2026-08-12T10:00:00.000Z** The staging password rotates weekly\n",
        "knowledge/deploys.md": KNOWLEDGE,
    })
    const bDir = agentDir(root, "beta", {
        carried: "- **2026-09-02T10:00:00.000Z** Beta keeps its own notes",
    })
    const seen = { alpha: [] as ChatMessage[][], beta: [] as ChatMessage[][] }
    const runtime = await Runtime.create({
        agents: [join(aDir, "agent.yaml"), join(bDir, "agent.yaml")],
        env: {},
        store: ":memory:",
        modelTransports: { alpha: model(seen.alpha), beta: model(seen.beta) },
    })
    const reload = async () => {
        const outcome = await runtime.reload("beta")
        return outcome.status
    }
    const last = () => JSON.stringify(seen.beta.at(-1) ?? [])
    return { runtime, aDir, bDir, reload, last }
}

async function refusal(work: () => Promise<unknown>): Promise<{ code: string; field?: string }> {
    try {
        await work()
    } catch (error) {
        if (isHarnessError(error))
            return {
                code: error.code,
                ...(error.field === undefined ? {} : { field: error.field }),
            }
        throw error
    }
    throw new Error("expected a refusal")
}

describe("an agent bundle", () => {
    test("a fact exported from one agent and imported into another is recalled there, and survives a rebuild", async () => {
        const { runtime, reload, last } = await pair()
        const bundle = exportBundle(runtime.agent("alpha"))
        expect(bundle.files.map((f) => f.path)).toEqual([
            "MEMORY.md",
            "memory/2026-08.md",
            "knowledge/deploys.md",
        ])

        const report = await importBundle({ agent: runtime.agent("beta"), bundle, reload })
        expect(report.added).toEqual(["memory/2026-08.md", "knowledge/deploys.md"])
        expect(report.merged).toEqual([{ path: "MEMORY.md", notes: 1 }])
        expect(report.reload).toBe("loaded")

        await runtime
            .agent("beta")
            .send(
                "when does the fiscal year end, how does the staging password work, and when do we deploy?",
            )
        expect(last()).toContain("fiscal year ends in March") // carried, after the reload
        expect(last()).toContain("Beta keeps its own notes") // merged, not replaced
        expect(last()).toContain("staging password rotates weekly") // the archive, recalled
        expect(last()).toContain("blue pipeline") // knowledge, activated

        await runtime.agent("beta").rebuildMemory()
        await runtime
            .agent("beta")
            .send("remind me about the staging password rotation", { sessionKey: "local:later" })
        expect(last()).toContain("staging password rotates weekly")
        await runtime.stop()
    })

    test("a bundle of only MEMORY.md still reloads, because the carried file is read at load", async () => {
        const { runtime, reload, last } = await pair()
        const report = await importBundle({
            agent: runtime.agent("beta"),
            bundle: exportBundle(runtime.agent("alpha"), ["MEMORY.md"]),
            reload,
        })
        expect(report.reload).toBe("loaded")
        await runtime.agent("beta").send("anything at all")
        expect(last()).toContain("fiscal year ends in March")
        await runtime.stop()
    })

    test("importing the same bundle twice changes nothing the second time", async () => {
        const { runtime, bDir, reload } = await pair()
        const bundle = exportBundle(runtime.agent("alpha"))
        await importBundle({ agent: runtime.agent("beta"), bundle, reload })
        const carried = readFileSync(join(bDir, "workspace", "MEMORY.md"), "utf8")
        const again = await importBundle({ agent: runtime.agent("beta"), bundle, reload })
        expect(again.added).toEqual([])
        expect(again.merged).toEqual([])
        expect([...again.skipped].sort()).toEqual([
            "MEMORY.md",
            "knowledge/deploys.md",
            "memory/2026-08.md",
        ])
        expect(again.reload).toBe("none")
        expect(readFileSync(join(bDir, "workspace", "MEMORY.md"), "utf8")).toBe(carried)
        await runtime.stop()
    })

    test("a bundle the agent would not load is rolled back entirely, and the agent keeps answering", async () => {
        const { runtime, bDir, reload } = await pair()
        const carried = readFileSync(join(bDir, "workspace", "MEMORY.md"), "utf8")
        const bad = {
            version: 1,
            agentId: "alpha",
            exportedAt: new Date().toISOString(),
            files: [
                { path: "MEMORY.md", content: "- a note that must not survive the rollback" },
                {
                    path: "memory/2026-07.md",
                    content: "- an archive note that must not survive either",
                },
                // No keywords: loadKnowledge refuses it, so the reload does.
                { path: "knowledge/broken.md", content: "no frontmatter at all" },
            ],
        }
        const outcome = await refusal(() =>
            importBundle({ agent: runtime.agent("beta"), bundle: bad, reload }),
        )
        expect(outcome.code).toBe("bundle_import_refused")
        expect(readFileSync(join(bDir, "workspace", "MEMORY.md"), "utf8")).toBe(carried)
        expect(existsSync(join(bDir, "memory", "2026-07.md"))).toBe(false)
        expect(existsSync(join(bDir, "knowledge", "broken.md"))).toBe(false)
        expect((await runtime.agent("beta").send("still there?")).text).toBe("ok")
        await runtime.stop()
    })

    test("a knowledge file that exists is kept under skip and replaced under overwrite", async () => {
        const { runtime, bDir, reload } = await pair()
        writeFileSync(
            join(bDir, "knowledge", "deploys.md"),
            "---\nkeywords: [deploy]\n---\n\nBeta's own deploy notes.\n",
        )
        const bundle = exportBundle(runtime.agent("alpha"), ["knowledge/"])
        const kept = await importBundle({ agent: runtime.agent("beta"), bundle, reload })
        expect(kept.skipped).toEqual(["knowledge/deploys.md"])
        const replaced = await importBundle({
            agent: runtime.agent("beta"),
            bundle,
            mode: "overwrite",
            reload,
        })
        expect(replaced.overwritten).toEqual(["knowledge/deploys.md"])
        expect(readFileSync(join(bDir, "knowledge", "deploys.md"), "utf8")).toBe(KNOWLEDGE)
        await runtime.stop()
    })

    test("nothing outside memory and knowledge can be carried, and nothing is written when one path is wrong", async () => {
        const { runtime, bDir, reload } = await pair()
        const bundle = (path: string) => ({
            version: 1,
            agentId: "x",
            exportedAt: "",
            files: [
                { path: "memory/ok.md", content: "- fine" },
                { path, content: "x" },
            ],
        })
        for (const path of [
            "agent.yaml",
            ".env",
            "skills/pdf/SKILL.md",
            "memory/../agent.yaml",
            "memory/sub/deep.md",
            "memory/session:local:x.md",
            "knowledge/.hidden.md",
            "/etc/passwd",
        ]) {
            const outcome = await refusal(() =>
                importBundle({ agent: runtime.agent("beta"), bundle: bundle(path), reload }),
            )
            expect([path, outcome.code, outcome.field]).toEqual([
                path,
                "bundle_path_not_allowed",
                "files.1.path",
            ])
        }
        expect(existsSync(join(bDir, "memory", "ok.md"))).toBe(false)
        expect(
            (
                await refusal(() =>
                    importBundle({ agent: runtime.agent("beta"), bundle: { version: 2 }, reload }),
                )
            ).code,
        ).toBe("bundle_version_unsupported")
        await runtime.stop()
    })
})
