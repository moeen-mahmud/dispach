/**
 * Agent templates: one authored agent, instantiated many times with different values.
 *
 * `POST /v1/agents` with `{answers}` replays the terminal wizard, which is the right front door for a
 * person and the wrong one for a product creating the same agent for its thousandth customer. A
 * template is a directory the operator writes once: a manifest, a workspace, and a `template.yaml`
 * declaring the variables. This module is the pure half, with no filesystem access: parse the
 * declaration, render the files, and say which environment variables a manifest reads. Reading and
 * writing directories is the CLI's job, as it is for every other agent on disk.
 *
 * ## The rules, and the reason for each
 *
 * - **Substitution only, never a rewritten sentence.** `{{vars.x}}` is replaced by a value and nothing
 *   else changes: decision 4.19's rule for the workspace renderer, applied to templates.
 * - **Namespaced, because `{{UPPER_SNAKE}}` is already taken.** The workspace files `init` writes
 *   carry authoring placeholders a *person* fills (`{{USER}}`, `{{RESPONSIBILITIES}}`,
 *   `{{INPUT_1}}`), so a bare `{{name}}` syntax refused the ordinary generated workspace the first
 *   time one was turned into a template, and would have let a variable called `USER` fill a
 *   human's placeholder. Only `{{vars.x}}` and `{{agent.id}}` / `{{agent.name}}` are this module's;
 *   every other `{{…}}` is left exactly as authored.
 * - **A secret is never substituted.** A variable declaring `secret: MODEL_API_KEY` has its value
 *   written to the agent's `.env` under that name, and a placeholder naming it is refused. A key
 *   substituted into `agent.yaml` would be a literal secret in a manifest, which hard rule 10 makes a
 *   load failure anyway. Better to refuse the template than to produce a manifest that cannot load.
 * - **In a YAML file a placeholder is a whole value, rendered as a quoted scalar.** A value spliced
 *   into YAML as text is an injection: `acme\ntools: {policy: {allow: ["exec(*)"]}}` for a store name
 *   would widen the agent's own policy, and the value may well come from the embedder's customer
 *   rather than the embedder. `key: {{vars.x}}` becomes `key: "<JSON-escaped>"`, which is valid YAML
 *   whatever the value contains. A placeholder anywhere else in a YAML line is refused rather than
 *   guessed at.
 * - **Values are one line.** A control character is refused, newline included.
 *   ponytail: single-line values only. Multi-line values arrive when an embedder needs one, and a
 *   YAML file already quotes them safely.
 * - **Every failure names its file, line or variable, and nothing is written.** The CLI renders
 *   into memory and validates before any file exists.
 */

import { parse as parseYaml } from "yaml"
import { ConfigError } from "../errors.ts"
import { envReferencesIn } from "./env.ts"

/** One declared variable. */
export interface TemplateVar {
    readonly name: string
    readonly description?: string
    /** Required when there is no default. A declared default makes it optional. */
    readonly required: boolean
    readonly default?: string
    /**
     * The environment variable this value is written to, in the agent's `.env`. A secret variable is
     * never substituted into a file, and no route ever reads its value back.
     */
    readonly secret?: string
}

export interface TemplateSpec {
    readonly description?: string
    readonly vars: readonly TemplateVar[]
}

export interface TemplateFile {
    /** Relative to the template (or agent) directory, `/`-separated. */
    readonly relPath: string
    readonly contents: string
}

export interface RenderedTemplate {
    readonly files: readonly TemplateFile[]
    /** What goes into the new agent's `.env`, keyed by variable name. */
    readonly env: Readonly<Record<string, string>>
}

/** What every template has without declaring it: the derived id, and the name the caller sent. */
export const TEMPLATE_BUILTINS: readonly string[] = ["agent.id", "agent.name"]

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** `{{vars.x}}` or `{{agent.x}}`. Captures the namespace and the name; nothing else is ours. */
const PLACEHOLDER = /\{\{\s*(vars|agent)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
/** Non-global, so `.test` carries no `lastIndex` from one line to the next. */
const HAS_PLACEHOLDER = /\{\{\s*(?:vars|agent)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/
/** `key: {{vars.x}}`, `- {{vars.x}}` or `- key: {{vars.x}}`, with an optional trailing comment. */
const YAML_WHOLE_VALUE =
    /^(\s*(?:-\s+)?(?:[A-Za-z0-9_.-]+:\s+)?)\{\{\s*((?:vars|agent)\.[A-Za-z_][A-Za-z0-9_]*)\s*\}\}(\s+#.*)?\s*$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/

function isYaml(relPath: string): boolean {
    return relPath.endsWith(".yaml") || relPath.endsWith(".yml")
}

/**
 * Parse `template.yaml`. Throws with the file and field named, never returns a partial spec.
 *
 * ```yaml
 * description: Support agent for one store
 * vars:
 *   store:  { description: The store's display name }
 *   tone:   { default: friendly }
 *   apiKey: { secret: MODEL_API_KEY }
 * ```
 */
export function parseTemplateSpec(text: string, source: string): TemplateSpec {
    let raw: unknown
    try {
        raw = parseYaml(text)
    } catch (error) {
        throw new ConfigError({
            code: "template_spec_invalid",
            message: `${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
            hint: "template.yaml declares the template's variables. Fix the syntax the parser names; nothing was created.",
            field: source,
        })
    }
    const doc = (raw ?? {}) as Record<string, unknown>
    if (typeof doc !== "object" || Array.isArray(doc)) {
        throw specError(source, "(root)", "is not a mapping")
    }
    const description = doc.description
    if (description !== undefined && typeof description !== "string") {
        throw specError(source, "description", "is not a string")
    }

    const declared = (doc.vars ?? {}) as Record<string, unknown>
    if (typeof declared !== "object" || Array.isArray(declared)) {
        throw specError(source, "vars", "is not a mapping of variable names")
    }
    const vars: TemplateVar[] = []
    for (const [name, value] of Object.entries(declared)) {
        const at = `vars.${name}`
        if (!VAR_NAME.test(name)) throw specError(source, at, "is not a valid variable name")
        const entry = (value ?? {}) as Record<string, unknown>
        if (typeof entry !== "object" || Array.isArray(entry)) {
            throw specError(source, at, "is not a mapping")
        }
        for (const key of Object.keys(entry)) {
            if (!["description", "default", "secret", "required"].includes(key)) {
                throw specError(
                    source,
                    `${at}.${key}`,
                    "is not a field. The fields are description, default, secret and required",
                )
            }
        }
        for (const key of ["description", "default", "secret"] as const) {
            if (entry[key] !== undefined && typeof entry[key] !== "string") {
                throw specError(source, `${at}.${key}`, "is not a string")
            }
        }
        if (entry.required !== undefined && typeof entry.required !== "boolean") {
            throw specError(source, `${at}.required`, "is not true or false")
        }
        const secret = entry.secret as string | undefined
        if (secret !== undefined && !VAR_NAME.test(secret)) {
            throw specError(source, `${at}.secret`, "is not an environment variable name")
        }
        const fallback = entry.default as string | undefined
        if (secret !== undefined && fallback !== undefined) {
            throw new ConfigError({
                code: "template_secret_default",
                message: `${source} gives the secret "${name}" a default.`,
                hint: "A default secret is a credential committed to the template and shared by every agent made from it. Remove the default; send the value per agent, or set it later with PUT /v1/agents/:id/secrets.",
                field: `${at}.default`,
            })
        }
        vars.push({
            name,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            // A secret with no explicit `required` is optional: an agent may be created now and have
            // its key set later, which is what the secrets route exists for.
            required:
                (entry.required as boolean | undefined) ??
                (fallback === undefined && secret === undefined),
            ...(fallback === undefined ? {} : { default: fallback }),
            ...(secret === undefined ? {} : { secret }),
        })
    }
    return { ...(typeof description === "string" ? { description } : {}), vars }
}

function specError(source: string, field: string, what: string): ConfigError {
    return new ConfigError({
        code: "template_spec_invalid",
        message: `${source}: ${field} ${what}.`,
        hint: "template.yaml has two keys, description and vars; each variable takes description, default, secret (an env variable name) and required. Nothing was created.",
        field,
    })
}

/**
 * Render every file with the given values.
 *
 * `vars` is what the caller sent. Every failure is thrown before anything is returned, and all the
 * missing variables are named at once rather than one per request.
 */
export function renderTemplate(input: {
    readonly spec: TemplateSpec
    readonly files: readonly TemplateFile[]
    readonly id: string
    readonly name: string
    readonly vars: Readonly<Record<string, string>>
}): RenderedTemplate {
    const declared = new Map(input.spec.vars.map((entry) => [entry.name, entry]))

    for (const key of Object.keys(input.vars)) {
        if (!declared.has(key)) {
            const known = [...declared.keys()]
            throw new ConfigError({
                code: "template_var_unknown",
                message: `"${key}" is not a variable this template declares.`,
                hint:
                    known.length === 0
                        ? "This template declares no variables. GET /v1/templates lists each template's variables."
                        : `It declares ${known.join(", ")}. GET /v1/templates lists them with their descriptions.`,
                field: `vars.${key}`,
            })
        }
    }

    const missing = input.spec.vars.filter(
        (entry) =>
            entry.required && input.vars[entry.name] === undefined && entry.default === undefined,
    )
    if (missing.length > 0) {
        throw new ConfigError({
            code: "template_vars_missing",
            message: `This template needs ${missing.map((entry) => entry.name).join(", ")}, and ${missing.length === 1 ? "it was" : "they were"} not sent.`,
            hint: "Send each in vars. GET /v1/templates lists every variable, which are required and what each is for.",
            field: `vars.${missing[0]?.name ?? ""}`,
        })
    }

    const values = new Map<string, string>([
        ["agent.id", input.id],
        ["agent.name", input.name],
    ])
    const env: Record<string, string> = {}
    for (const entry of input.spec.vars) {
        const value = input.vars[entry.name] ?? entry.default
        if (value === undefined) continue
        if (CONTROL.test(value)) {
            throw new ConfigError({
                code: "template_value_invalid",
                message: `The value for "${entry.name}" contains a control character.`,
                hint: "Template values are one line of text. A newline in a substituted value is how a value becomes structure, so it is refused rather than escaped.",
                field: `vars.${entry.name}`,
            })
        }
        if (entry.secret !== undefined) {
            // An empty secret is no secret: it would fail the load exactly as a missing one does.
            if (value !== "") env[entry.secret] = value
        } else values.set(`vars.${entry.name}`, value)
    }
    if (CONTROL.test(input.name)) {
        throw new ConfigError({
            code: "template_value_invalid",
            message: "The agent's name contains a control character.",
            hint: "A name is one line of text.",
            field: "name",
        })
    }

    const files: TemplateFile[] = []
    for (const file of input.files) {
        if (file.relPath === ".env" || file.relPath.endsWith("/.env")) {
            throw new ConfigError({
                code: "template_env_file",
                message: `The template ships ${file.relPath}.`,
                hint: "A .env in a template is a credential shared by every agent made from it. Declare the value as a secret variable instead; each agent's .env is written from what its own request sent.",
                field: file.relPath,
            })
        }
        files.push({
            relPath: file.relPath,
            contents: renderFile(file, values, declared),
        })
    }

    const manifest = files.find((file) => file.relPath === "agent.yaml")
    if (manifest === undefined) {
        throw new ConfigError({
            code: "template_manifest_missing",
            message: "The template has no agent.yaml at its root.",
            hint: "A template is an agent directory with a template.yaml beside its manifest. Put the manifest at the template's root.",
            field: "agent.yaml",
        })
    }
    const parsed = parseYaml(manifest.contents) as Record<string, unknown> | null
    if (parsed?.id !== input.id) {
        throw new ConfigError({
            code: "template_id_mismatch",
            message: `The rendered agent.yaml declares id ${JSON.stringify(parsed?.id)}, not "${input.id}".`,
            hint: "Write `id: {{agent.id}}` in the template's agent.yaml. The id is derived from the name the caller sends and every route keys on it, so a manifest declaring anything else would be an agent its own directory does not name.",
            field: "agent.yaml:id",
        })
    }
    const read = new Set(manifestEnvReferences(manifest.contents).map((ref) => ref.name))
    for (const entry of input.spec.vars) {
        if (entry.secret !== undefined && !read.has(entry.secret)) {
            throw new ConfigError({
                code: "template_secret_unread",
                message: `The secret "${entry.name}" is written to ${entry.secret}, which agent.yaml never reads.`,
                hint: `Reference it from the manifest, as an *Env field (apiKeyEnv: ${entry.secret}) or as \${${entry.secret}}. A credential written somewhere nothing reads is one the caller believes is in use.`,
                field: `vars.${entry.name}.secret`,
            })
        }
    }
    return { files, env }
}

function renderFile(
    file: TemplateFile,
    values: ReadonlyMap<string, string>,
    declared: ReadonlyMap<string, TemplateVar>,
): string {
    const lines = file.contents.split("\n")
    return lines
        .map((line, index) => {
            const where = `${file.relPath}:${index + 1}`
            for (const match of line.matchAll(PLACEHOLDER)) {
                const [space, name] = [match[1] ?? "", match[2] ?? ""]
                const entry = space === "vars" ? declared.get(name) : undefined
                if (entry?.secret !== undefined) {
                    throw new ConfigError({
                        code: "template_secret_placeholder",
                        message: `${where} substitutes the secret "${name}".`,
                        hint: `A secret is written to the agent's .env, never into a file. Read it where it is needed as \${${entry.secret}}, or through an *Env field.`,
                        field: where,
                    })
                }
                if (space === "vars" ? entry === undefined : !values.has(`agent.${name}`)) {
                    throw new ConfigError({
                        code: "template_placeholder_unknown",
                        message: `${where} uses {{${space}.${name}}}, which the template does not declare.`,
                        hint: `Declare ${name} under vars in template.yaml, or use a built-in: ${TEMPLATE_BUILTINS.map((b) => `{{${b}}}`).join(", ")}. Any other {{…}} is left as written.`,
                        field: where,
                    })
                }
            }
            if (!isYaml(file.relPath) || !HAS_PLACEHOLDER.test(line)) {
                return line.replace(
                    PLACEHOLDER,
                    (_all, space: string, name: string) => values.get(`${space}.${name}`) ?? "",
                )
            }
            const whole = YAML_WHOLE_VALUE.exec(line)
            if (whole === null) {
                throw new ConfigError({
                    code: "template_placeholder_placement",
                    message: `${where} puts a placeholder inside a YAML value.`,
                    hint: "In a YAML file a placeholder must be the whole value, unquoted: `name: {{agent.name}}` or `- {{vars.tag}}`. It is rendered as a quoted string, so a value can never become structure. Build a longer string in the workspace files instead.",
                    field: where,
                })
            }
            // An optional variable left empty still renders, as an empty string.
            const value = values.get(whole[2] ?? "") ?? ""
            return `${whole[1] ?? ""}${JSON.stringify(value)}${whole[3] ?? ""}`
        })
        .join("\n")
}

/**
 * Every environment variable a manifest reads, from its raw text, before anything is expanded.
 *
 * Two spellings: `${NAME}` anywhere in a string, and the value of any field whose key ends in `Env`
 * (`apiKeyEnv`, `tokenEnv`, `secretTokenEnv`), which name a variable rather than expand one.
 *
 * **From the text, deliberately.** `loadManifest` refuses a manifest whose variables are unset, and
 * "which variables does this agent need" is asked about exactly that agent: one not served because
 * its key is missing. `path` is the dotted field, so a caller can exclude one by meaning (the
 * server's own token) rather than by name.
 */
export function manifestEnvReferences(
    text: string,
): readonly { readonly name: string; readonly path: string }[] {
    const out: { name: string; path: string }[] = []
    const seen = new Set<string>()
    const add = (name: string, path: string): void => {
        if (name === "" || seen.has(`${name}@${path}`)) return
        seen.add(`${name}@${path}`)
        out.push({ name, path })
    }
    const walk = (value: unknown, path: string, key: string): void => {
        if (typeof value === "string") {
            if (key.endsWith("Env") && VAR_NAME.test(value)) add(value, path)
            for (const name of envReferencesIn(value)) add(name, path)
        } else if (Array.isArray(value)) {
            value.forEach((item, index) => {
                walk(item, `${path}.${index}`, key)
            })
        } else if (value !== null && typeof value === "object") {
            for (const [child, item] of Object.entries(value)) {
                walk(item, path === "" ? child : `${path}.${child}`, child)
            }
        }
    }
    walk(parseYaml(text), "", "")
    return out
}
