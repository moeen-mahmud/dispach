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

import { createHash } from "node:crypto"
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
    HarnessError,
    isHarnessError,
    manifestEnvReferences,
    parseTemplateSpec,
    parseWorkspaceFile,
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
        writeProvenance(staging, {
            template: input.template,
            name,
            vars: plainVars(readSpec(root), input.vars),
            files: hashes(rendered.files),
        })
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

// ─── Re-rendering an agent's template files (pilot.5, VelaCrew #21) ─────────────────────────

/**
 * What the agent was made from, beside its manifest: the template, the plain vars, and a hash of
 * every file as it was rendered. The hash is what tells a file nobody touched from one somebody (the
 * person, the agent, a `PATCH /config`) edited since, and only the first kind is re-rendered.
 * Secret vars are never in it; they live in `.env`.
 */
const PROVENANCE_FILE = ".template.json"

interface Provenance {
    readonly version: 1
    readonly template: string
    readonly name: string
    readonly vars: Readonly<Record<string, string>>
    readonly files: Readonly<Record<string, string>>
}

function hashOf(contents: string): string {
    return createHash("sha256").update(contents).digest("hex")
}

function hashes(files: readonly TemplateFile[]): Record<string, string> {
    return Object.fromEntries(files.map((file) => [file.relPath, hashOf(file.contents)]))
}

function plainVars(
    spec: TemplateSpec,
    vars: Readonly<Record<string, string>>,
): Record<string, string> {
    const secret = new Set(
        spec.vars.filter((entry) => entry.secret !== undefined).map((e) => e.name),
    )
    return Object.fromEntries(Object.entries(vars).filter(([name]) => !secret.has(name)))
}

function writeProvenance(dir: string, provenance: Omit<Provenance, "version">): void {
    writeFileSync(
        join(dir, PROVENANCE_FILE),
        `${JSON.stringify({ version: 1, ...provenance }, null, 2)}\n`,
        { mode: 0o600 },
    )
}

export interface RerenderResult {
    readonly rendered: readonly string[]
    readonly skipped: readonly {
        readonly file: string
        readonly reason: "edited" | "memory" | "removed"
    }[]
    /** Put every rewritten file back, for when the agent then refuses to load. */
    readonly undo: () => void
}

/**
 * Apply changed vars to an agent made from a template: re-render, and rewrite only the files that are
 * exactly as the template last rendered them.
 *
 * Three things are never rewritten. A file whose contents moved since it was rendered (`edited`),
 * because somebody chose those words. A file that is the agent's memory (`memory`): `MEMORY.md`, and
 * any file declaring `eviction: oldest`, which is how a workspace names its `memory_write` target. And
 * a file that is gone (`removed`), since deleting it was a choice too. `USER.md` is none of those
 * unless edited, so it is re-rendered: for VelaCrew it is where the person's name and role live.
 */
export function rerenderFromTemplate(input: {
    readonly templatesDir: string
    readonly agentDir: string
    readonly vars: Readonly<Record<string, string>>
}): RerenderResult {
    const recordPath = join(input.agentDir, PROVENANCE_FILE)
    if (!existsSync(recordPath)) {
        throw new HarnessError({
            code: "agent_not_from_template",
            message: "This agent has no record of the template it was made from.",
            hint: "Only an agent created with POST /v1/agents {template} on 0.2.0-pilot.5 or later carries one, because re-rendering needs the hash of every file as it was rendered. For an older agent, edit the files directly or create it again from the template.",
        })
    }
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Provenance
    const root = join(input.templatesDir, record.template)
    if (!existsSync(root)) throw templateUnknown(record.template, input.templatesDir)
    const spec = readSpec(root)

    for (const name of Object.keys(input.vars)) {
        const declared = spec.vars.find((entry) => entry.name === name)
        if (declared?.secret !== undefined) {
            throw new HarnessError({
                code: "template_var_secret",
                message: `"${name}" is a secret, and a secret is never rendered into a file.`,
                hint: `Set it with PUT /v1/agents/:id/secrets as ${declared.secret}.`,
                field: `vars.${name}`,
            })
        }
    }

    const vars = { ...record.vars, ...input.vars }
    const rendered = renderTemplate({
        spec,
        files: readTemplateFiles(root),
        id: basename(input.agentDir),
        name: record.name,
        // Secrets were never recorded, so a required secret var counts as present here: it was
        // checked when the agent was created and it lives in `.env`, not in any file.
        vars: {
            ...Object.fromEntries(
                spec.vars
                    .filter((entry) => entry.secret !== undefined && entry.required)
                    .map((entry) => [entry.name, "(in .env)"]),
            ),
            ...vars,
        },
    })

    // `before` is undefined for a file this call created, so undoing removes it.
    const written: { readonly path: string; readonly before: string | undefined }[] = []
    const out: string[] = []
    const skipped: { file: string; reason: "edited" | "memory" | "removed" }[] = []
    const nextHashes: Record<string, string> = { ...record.files }
    try {
        for (const file of rendered.files) {
            const path = join(input.agentDir, file.relPath)
            const recorded = record.files[file.relPath]
            if (!existsSync(path)) {
                if (recorded !== undefined) {
                    skipped.push({ file: file.relPath, reason: "removed" })
                    continue
                }
                // New in the template since the agent was made: nothing to overwrite.
                mkdirSync(dirname(path), { recursive: true })
                writeFileSync(path, file.contents)
                written.push({ path, before: undefined })
                nextHashes[file.relPath] = hashOf(file.contents)
                out.push(file.relPath)
                continue
            }
            const current = readFileSync(path, "utf8")
            if (isMemory(file.relPath, current)) {
                skipped.push({ file: file.relPath, reason: "memory" })
                continue
            }
            if (recorded === undefined || hashOf(current) !== recorded) {
                skipped.push({ file: file.relPath, reason: "edited" })
                continue
            }
            if (current === file.contents) continue
            writeFileSync(path, file.contents)
            written.push({ path, before: current })
            nextHashes[file.relPath] = hashOf(file.contents)
            out.push(file.relPath)
        }
        writeProvenance(input.agentDir, {
            template: record.template,
            name: record.name,
            vars: plainVars(spec, vars),
            files: nextHashes,
        })
    } catch (error) {
        restore(written)
        throw error
    }

    return {
        rendered: out,
        skipped,
        undo: () => {
            restore(written)
            // The record goes back too, or the next re-render compares against hashes of files that
            // were just put back.
            writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
        },
    }
}

function restore(
    written: readonly { readonly path: string; readonly before: string | undefined }[],
): void {
    for (const entry of written) {
        if (entry.before === undefined) rmSync(entry.path, { force: true })
        else writeFileSync(entry.path, entry.before)
    }
}

function isMemory(relPath: string, contents: string): boolean {
    if (basename(relPath) === "MEMORY.md") return true
    if (!relPath.endsWith(".md")) return false
    try {
        return parseWorkspaceFile(relPath, contents).frontmatter.eviction === "oldest"
    } catch {
        return false
    }
}
