/**
 * Templates and secrets on disk, end to end: what a template produces, and what a failure leaves.
 *
 * The fixture is a **real generated agent** turned into a template (its `id` and `name` replaced by
 * placeholders, its `.env` removed), so the load check runs against the workspace `init` actually
 * writes rather than a toy manifest that would pass for the wrong reason. Every assertion reads the
 * files back, never the return value alone: a field threaded through a pipeline needs its test at
 * the far end, which this repo has relearned six times.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, type HarnessError, loadManifest } from "@dispach/core"
import { secretStatus, writeSecrets } from "#lib/agent-secrets"
import { listTemplates, provisionFromTemplate } from "#lib/agent-template"
import { provisionAgent } from "#lib/provision"

const dirs: string[] = []
afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

const SPEC = `description: Support agent for one store
vars:
  store: { description: The store's display name }
  apiKey: { secret: MODEL_API_KEY }
`

/** A sandbox with `agents/` and `templates/support/`, built from a real generated agent. */
function sandbox(): { root: string; agents: string; templates: string } {
    const root = mkdtempSync(join(tmpdir(), "template-test-"))
    dirs.push(root)
    const agents = join(root, "agents")
    const templates = join(root, "templates")
    const base = provisionAgent({
        answers: { user: "you", name: "base", apiKey: "sk-base" },
        defaults: { agentDirBase: join(root, "scratch") },
    })
    const template = join(templates, "support")
    cpSync(base.dir, template, { recursive: true })
    rmSync(join(template, ".env"))
    const manifest = readFileSync(join(template, "agent.yaml"), "utf8")
        .replace(/^id: .*$/m, "id: {{agent.id}}")
        .replace(/^name: .*$/m, "name: {{agent.name}}")
    writeFileSync(join(template, "agent.yaml"), manifest)
    writeFileSync(join(template, "workspace", "USER.md"), "You work for {{vars.store}}.\n")
    writeFileSync(join(template, "template.yaml"), SPEC)
    return { root, agents, templates }
}

function codeOf(run: () => unknown): string {
    try {
        run()
    } catch (error) {
        return (error as HarnessError).code
    }
    return "(no error)"
}

describe("provisionFromTemplate", () => {
    test("writes an agent that loads, under the derived id, with its secret at 0600", () => {
        const box = sandbox()
        const result = provisionFromTemplate({
            templatesDir: box.templates,
            agentDirBase: box.agents,
            template: "support",
            name: "Acme Store",
            vars: { store: "Acme", apiKey: "sk-acme" },
        })
        expect(result.agentId).toBe("acme-store")
        expect(result.dir).toBe(join(box.agents, "acme-store"))

        const loaded = loadManifest(result.manifestPath)
        expect(loaded.manifest.id).toBe("acme-store")
        expect(loaded.manifest.name).toBe("Acme Store")
        expect(readFileSync(join(result.dir, "workspace", "USER.md"), "utf8")).toBe(
            "You work for Acme.\n",
        )
        const env = join(result.dir, ".env")
        expect(readFileSync(env, "utf8")).toContain("MODEL_API_KEY=sk-acme")
        expect(statSync(env).mode & 0o777).toBe(0o600)
        // The spec is the template's, not the agent's.
        expect(existsSync(join(result.dir, "template.yaml"))).toBe(false)
    })

    test("a hostile name cannot change the agent's policy", () => {
        const box = sandbox()
        const baseline = loadManifest(
            provisionFromTemplate({
                templatesDir: box.templates,
                agentDirBase: box.agents,
                template: "support",
                name: "plain",
                vars: { store: "a", apiKey: "k" },
            }).manifestPath,
        ).manifest.tools
        const hostile = provisionFromTemplate({
            templatesDir: box.templates,
            agentDirBase: box.agents,
            template: "support",
            name: 'x", tools: {policy: {allow: ["exec(*)"]}}, y: "',
            vars: { store: "a", apiKey: "k" },
        })
        expect(loadManifest(hostile.manifestPath).manifest.tools).toEqual(baseline)
    })

    test("a failed request leaves nothing behind, staging included", () => {
        const box = sandbox()
        expect(
            codeOf(() =>
                provisionFromTemplate({
                    templatesDir: box.templates,
                    agentDirBase: box.agents,
                    template: "support",
                    name: "Acme",
                    vars: {},
                }),
            ),
        ).toBe("template_vars_missing")

        // A failure *after* staging: a manifest that renders and does not load.
        const manifest = join(box.templates, "support", "agent.yaml")
        writeFileSync(manifest, `${readFileSync(manifest, "utf8")}\nnotAField: true\n`)
        expect(
            codeOf(() =>
                provisionFromTemplate({
                    templatesDir: box.templates,
                    agentDirBase: box.agents,
                    template: "support",
                    name: "Acme",
                    vars: { store: "a" },
                }),
            ),
        ).not.toBe("(no error)")
        expect(existsSync(join(box.agents, "acme"))).toBe(false)
        const staging = join(box.root, ".agents-staging")
        expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])
    })

    test("refuses an existing agent, an unknown template, and a path for a name", () => {
        const box = sandbox()
        const request = {
            templatesDir: box.templates,
            agentDirBase: box.agents,
            template: "support",
            name: "Acme",
            vars: { store: "a" },
        }
        provisionFromTemplate(request)
        expect(codeOf(() => provisionFromTemplate(request))).toBe("provision_agent_exists")
        expect(codeOf(() => provisionFromTemplate({ ...request, template: "nope" }))).toBe(
            "template_not_found",
        )
        expect(codeOf(() => provisionFromTemplate({ ...request, template: "../agents" }))).toBe(
            "template_not_found",
        )
    })

    test("a symlink in a template is refused rather than followed", () => {
        const box = sandbox()
        symlinkSync("/etc/hosts", join(box.templates, "support", "workspace", "hosts.md"))
        expect(
            codeOf(() =>
                provisionFromTemplate({
                    templatesDir: box.templates,
                    agentDirBase: box.agents,
                    template: "support",
                    name: "Acme",
                    vars: { store: "a" },
                }),
            ),
        ).toBe("template_symlink")
    })
})

describe("listTemplates", () => {
    test("lists a broken template with its problem instead of hiding it", () => {
        const box = sandbox()
        mkdirSync(join(box.templates, "broken"))
        writeFileSync(join(box.templates, "broken", "template.yaml"), "vars: [nope]\n")
        const listed = listTemplates(box.templates)
        expect(listed.map((entry) => entry.name)).toEqual(["broken", "support"])
        expect(listed[0]?.problem?.code).toBe("template_spec_invalid")
        expect(listed[1]?.vars).toEqual([
            {
                name: "store",
                description: "The store's display name",
                required: true,
                secret: false,
            },
            { name: "apiKey", required: false, secret: true },
        ])
    })

    test("a sandbox with no templates directory has none, and says nothing", () => {
        expect(listTemplates(join(tmpdir(), "no-such-templates-dir"))).toEqual([])
    })
})

describe("secrets", () => {
    test("the settable set is what the manifest reads, minus the server's own token", () => {
        const box = sandbox()
        const agent = provisionFromTemplate({
            templatesDir: box.templates,
            agentDirBase: box.agents,
            template: "support",
            name: "Acme",
            vars: { store: "a" },
        })
        const names = secretStatus(agent.manifestPath).map((entry) => entry.name)
        expect(names).toContain("MODEL_API_KEY")
        const manifest = loadManifest(agent.manifestPath, {
            env: { ...process.env, MODEL_API_KEY: "x", [`${BRAND.envPrefix}API_TOKEN`]: "x" },
        }).manifest
        expect(names).not.toContain(manifest.server.tokenEnv)
    })

    test("all or nothing, write-only at 0600, and an unread name is refused", () => {
        const box = sandbox()
        const agent = provisionFromTemplate({
            templatesDir: box.templates,
            agentDirBase: box.agents,
            template: "support",
            name: "Acme",
            vars: { store: "a" },
        })
        const env = join(agent.dir, ".env")
        expect(
            codeOf(() =>
                writeSecrets(agent.manifestPath, { MODEL_API_KEY: "sk-1", NOT_READ: "x" }),
            ),
        ).toBe("secret_not_referenced")
        // The valid half of that request was not written either.
        expect(existsSync(env) ? readFileSync(env, "utf8") : "").not.toContain("sk-1")

        const result = writeSecrets(agent.manifestPath, { MODEL_API_KEY: "sk-2" })
        expect(result.written).toEqual(["MODEL_API_KEY"])
        expect(readFileSync(env, "utf8")).toContain("MODEL_API_KEY=sk-2")
        expect(statSync(env).mode & 0o777).toBe(0o600)
        expect(secretStatus(agent.manifestPath).find((e) => e.name === "MODEL_API_KEY")?.set).toBe(
            true,
        )
    })
})
