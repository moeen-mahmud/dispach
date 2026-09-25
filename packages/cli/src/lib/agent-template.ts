/**
 * Agent templates on disk: listing them, and creating an agent from one.
 *
 * The rendering rules are core's (`manifest/template.ts`, which is pure and has the YAML parser this
 * package deliberately does not). This module is the filesystem half, and it holds the one promise
 * the route makes: **a request that fails leaves nothing behind, and a request that succeeds leaves
 * an agent `run` would load.**
 *
 * So an agent is rendered into memory, written to a staging directory *outside* the agents
 * directory, loaded there by the same check `init` runs, and only then renamed into place. The
 * staging directory is a sibling rather than a dot-directory inside `agents/`, because `listAgents`
 * reads any directory with an `agent.yaml` as an agent. A concurrent listing would otherwise see a
 * half-validated one under a real id.
 *
 * Templates are written by the operator (baked into an image, mounted, copied onto a volume) and
 * never uploaded through the API. A template decides what every agent made from it can do, so
 * authoring one is the operator's act, the same line that keeps the agent's directory off the wire.
 */

import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
    HarnessError,
    isHarnessError,
    manifestEnvReferences,
    parseTemplateSpec,
    renderTemplate,
    type TemplateFile,
    type TemplateSpec,
} from "@dispach/core"
import { applySecret } from "#lib/config-apply"
import { slugify } from "#lib/init-flow"
import { checkAgentLoads, type ProvisionResult, writeAgentFiles } from "#lib/provision"

const SPEC_FILE = "template.yaml"
/** A template name is a directory name and nothing else: no separators, no `..`, no dotfiles. */
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** One template, as a client picking one needs to see it. Never a value, and never a secret's. */
export interface TemplateSummary {
    readonly name: string
    readonly description?: string
    readonly vars: readonly {
        readonly name: string
        readonly description?: string
        readonly required: boolean
        readonly default?: string
        /** A secret is written to the agent's `.env` and never returned. */
        readonly secret: boolean
    }[]
    /**
     * Why this template cannot be used, when it cannot.
     *
     * Listed rather than hidden, for the reason `listAgents` shows a broken directory: an operator
     * who put a template in place and cannot see it has no way to learn it has a typo.
     */
    readonly problem?: { readonly code: string; readonly message: string; readonly hint: string }
}

export function listTemplates(dir: string): readonly TemplateSummary[] {
    let entries: string[]
    try {
        entries = readdirSync(dir)
    } catch {
        // No templates directory is the normal state for a sandbox that has none.
        return []
    }
    const out: TemplateSummary[] = []
    for (const name of entries.sort()) {
        if (!TEMPLATE_NAME.test(name)) continue
        const root = join(dir, name)
        if (!lstatSync(root).isDirectory()) continue
        try {
            const spec = readSpec(root)
            out.push({
                name,
                ...(spec.description === undefined ? {} : { description: spec.description }),
                vars: spec.vars.map((entry) => ({
                    name: entry.name,
                    ...(entry.description === undefined ? {} : { description: entry.description }),
                    required: entry.required,
                    ...(entry.default === undefined ? {} : { default: entry.default }),
                    secret: entry.secret !== undefined,
                })),
            })
        } catch (error) {
            if (!isHarnessError(error)) throw error
            out.push({
                name,
                vars: [],
                problem: { code: error.code, message: error.message, hint: error.hint },
            })
        }
    }
    return out
}

function readSpec(root: string): TemplateSpec {
    const path = join(root, SPEC_FILE)
    if (!existsSync(path)) {
        throw new HarnessError({
            code: "template_spec_missing",
            message: `${basename(root)} has no ${SPEC_FILE}.`,
            hint: `A template is an agent directory with a ${SPEC_FILE} beside agent.yaml declaring its variables. An empty one (\`vars: {}\`) is valid.`,
        })
    }
    return parseTemplateSpec(readFileSync(path, "utf8"), `${basename(root)}/${SPEC_FILE}`)
}

/**
 * Every file under a template, except its spec.
 *
 * **Symlinks are refused, not followed.** A template is copied into a new agent, and a symlink in one
 * is a way to copy whatever it points at, the host's own files included, into a directory an agent
 * reads. Binary files are refused too, because the renderer is a text substitution and a byte it
 * cannot represent would be silently corrupted.
 * ponytail: text-only templates. Copy binaries verbatim when a template needs an image.
 */
function readTemplateFiles(root: string, rel = ""): TemplateFile[] {
    const out: TemplateFile[] = []
    for (const entry of readdirSync(join(root, rel)).sort()) {
        const relPath = rel === "" ? entry : `${rel}/${entry}`
        if (relPath === SPEC_FILE) continue
        const full = join(root, relPath)
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) {
            throw new HarnessError({
                code: "template_symlink",
                message: `${relPath} in the template is a symbolic link.`,
                hint: "A template is copied into every agent made from it, and a link would copy whatever it points at. Replace it with the file itself.",
                field: relPath,
            })
        }
        if (stat.isDirectory()) {
            out.push(...readTemplateFiles(root, relPath))
            continue
        }
        const bytes = readFileSync(full)
        if (bytes.includes(0)) {
            throw new HarnessError({
                code: "template_binary_file",
                message: `${relPath} in the template is not a text file.`,
                hint: "Templates are rendered by text substitution, which would corrupt a binary file. Leave it out of the template and add it to the agent afterwards.",
                field: relPath,
            })
        }
        out.push({ relPath, contents: bytes.toString("utf8") })
    }
    return out
}

export interface TemplateRequest {
    readonly templatesDir: string
    /** The sandbox's agents directory. Injected, never computed here, so a test can redirect it. */
    readonly agentDirBase: string
    readonly template: string
    readonly name: string
    readonly vars: Readonly<Record<string, string>>
}

export function provisionFromTemplate(input: TemplateRequest): ProvisionResult {
    if (!TEMPLATE_NAME.test(input.template)) {
        throw templateUnknown(input.template, input.templatesDir)
    }
    const root = join(input.templatesDir, input.template)
    if (!existsSync(root) || !lstatSync(root).isDirectory()) {
        throw templateUnknown(input.template, input.templatesDir)
    }

    const name = input.name.trim()
    if (name === "") {
        throw new HarnessError({
            code: "provision_name_required",
            message: "An agent made from a template needs a name.",
            hint: 'Send { "template": "…", "name": "Acme store", "vars": {…} }. The id every route keys on is derived from the name, and a template can use it as {{agent.name}} and {{agent.id}}.',
            field: "name",
        })
    }
    const id = slugify(name)
    const targetDir = join(input.agentDirBase, id)
    if (existsSync(targetDir)) {
        throw new HarnessError({
            code: "provision_agent_exists",
            message: `An agent directory named "${id}" already exists.`,
            hint: "The id is derived from the name, so pick a different name. Nothing is overwritten: replacing an agent's workspace is exactly the loss provisioning exists to prevent.",
            field: "name",
        })
    }

    const rendered = renderTemplate({
        spec: readSpec(root),
        files: readTemplateFiles(root),
        id,
        name,
        vars: input.vars,
    })

    const staging = join(
        dirname(input.agentDirBase),
        `.${basename(input.agentDirBase)}-staging`,
        `${id}-${crypto.randomUUID().slice(0, 8)}`,
    )
    mkdirSync(staging, { recursive: true })
    try {
        writeAgentFiles(staging, rendered.files)
        const manifestPath = join(staging, "agent.yaml")
        for (const [variable, value] of Object.entries(rendered.env)) {
            applySecret(manifestPath, variable, value)
        }
        // Every variable the manifest reads and nothing supplied is stubbed for this check only: an
        // agent may be created before its key exists, which is what the secrets route is for. What
        // the check proves is structure (schema, budgets, tiers, rules), not credentials.
        const manifest = rendered.files.find((file) => file.relPath === "agent.yaml")
        const overlay: Record<string, string> = {}
        for (const ref of manifestEnvReferences(manifest?.contents ?? "")) {
            if (rendered.env[ref.name] === undefined) overlay[ref.name] = "(pending)"
        }
        checkAgentLoads(manifestPath, overlay)

        mkdirSync(input.agentDirBase, { recursive: true })
        renameSync(staging, targetDir)
    } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        throw error
    }

    return {
        agentId: id,
        dir: targetDir,
        manifestPath: join(targetDir, "agent.yaml"),
        files: [
            ...rendered.files.map((file) => file.relPath),
            ...(Object.keys(rendered.env).length > 0 ? [".env"] : []),
        ],
    }
}

function templateUnknown(name: string, dir: string): HarnessError {
    const known = listTemplates(dir).map((entry) => entry.name)
    return new HarnessError({
        code: "template_not_found",
        message: `No template called ${JSON.stringify(name)}.`,
        hint:
            known.length === 0
                ? `This server has no templates. An operator adds one as a directory under ${dir}.`
                : `Templates here: ${known.join(", ")}. GET /v1/templates lists them with their variables.`,
        field: "template",
    })
}
