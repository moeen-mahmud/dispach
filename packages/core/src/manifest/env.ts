/**
 * `${VAR}` expansion and `.env` loading.
 *
 * An unset variable is a load failure naming the variable — never an expansion to the empty
 * string. The alternative surfaces three layers away as a 401 from a provider, and that
 * translation costs an afternoon every time.
 */

import { envVarMissing } from "../errors.ts"

export type EnvSource = Record<string, string | undefined>

/** `${NAME}` only. `$NAME` is not expanded, so shell-looking strings pass through untouched. */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Minimal `.env` parser — `KEY=value`, `export KEY=value`, `#` comments, single or double
 * quotes, backslash escapes inside double quotes only.
 *
 * Hand-rolled because core's dependency allowlist is a YAML parser and a schema validator,
 * and this is twenty lines.
 */
export function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {}

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line === "" || line.startsWith("#")) continue

        const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line
        const eq = withoutExport.indexOf("=")
        if (eq <= 0) continue

        const key = withoutExport.slice(0, eq).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

        let value = withoutExport.slice(eq + 1).trim()

        const quote = value.charAt(0)
        if ((quote === '"' || quote === "'") && value.length >= 2) {
            // A quoted value ends at its matching close quote, so an inline
            // comment after it is not part of the value ("K="v" # note").
            const close = value.lastIndexOf(quote)
            if (close > 0) {
                let inner = value.slice(1, close)
                if (quote === '"') {
                    // One left-to-right pass, so an escaped backslash followed
                    // by n stays a backslash and an n, not a newline (the
                    // writer escapes this way).
                    inner = inner.replace(/\\\\|\\n|\\r|\\t|\\"/g, (m) => {
                        if (m === "\\\\") return "\\"
                        if (m === "\\n") return "\n"
                        if (m === "\\r") return "\r"
                        if (m === "\\t") return "\t"
                        return '"'
                    })
                }
                out[key] = inner
                continue
            }
        }

        // Unquoted values end at an inline comment.
        const comment = value.indexOf(" #")
        if (comment !== -1) value = value.slice(0, comment).trimEnd()

        out[key] = value
    }

    return out
}

/** Which env references a string contains. Used for reporting, not expansion. */
export function envReferencesIn(value: string): string[] {
    return [...value.matchAll(ENV_REFERENCE)].map((match) => match[1] ?? "")
}

function expandString(value: string, env: EnvSource, path: string): string {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
        const resolved = env[name]
        if (resolved === undefined) throw envVarMissing(name, path)
        return resolved
    })
}

/**
 * Recursively expand `${VAR}` in every string leaf, reporting the dotted path of any
 * unresolved reference.
 */
export function expandEnvDeep(value: unknown, env: EnvSource, path = ""): unknown {
    if (typeof value === "string") return expandString(value, env, path === "" ? "(root)" : path)

    if (Array.isArray(value)) {
        return value.map((item, index) => expandEnvDeep(item, env, `${path}[${index}]`))
    }

    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
            out[key] = expandEnvDeep(item, env, path === "" ? key : `${path}.${key}`)
        }
        return out
    }

    return value
}

/**
 * Merge a parsed `.env` under the real environment. The real environment always wins, so a
 * committed `.env` cannot override what an operator explicitly exported.
 *
 * A snapshot, suitable for load-time checks. For anything read *later* — an API key on every
 * request — use `layeredEnv`, which stays live.
 */
/** One variable the ambient environment took away from the agent's own `.env`. */
export interface EnvOverride {
    readonly key: string
    /** What the `.env` beside the manifest said. Absent for a name that looks like a secret. */
    readonly mine?: string
    /** What the ambient environment said instead. Absent for the same reason. */
    readonly theirs?: string
}

/** Names whose values never appear in a message, however useful the diff would be. */
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/**
 * Variables where the agent's own `.env` and the ambient environment disagree.
 *
 * The layering is deliberate and stays: an operator's explicit export has to beat a committed file,
 * or a container cannot configure the agent it is running. What is not acceptable is the layering
 * being **silent**. A sandbox agent whose `.env` names `deepseek-v4-flash` ran on `deepseek-v4-pro`
 * for a whole session because a `.env` in the directory the binary was launched from said so, and
 * the banner reported the model it was actually using — correctly, and unhelpfully, since the person
 * had just written the other one and had no reason to look.
 *
 * Only a genuine disagreement counts. A variable the ambient environment supplies and the `.env`
 * does not is the normal case and says nothing; identical values are not an override.
 */
export function envOverrides(dotEnv: Record<string, string>, real: EnvSource): EnvOverride[] {
    const out: EnvOverride[] = []
    for (const [key, mine] of Object.entries(dotEnv)) {
        const theirs = real[key]
        if (theirs === undefined || theirs === mine) continue
        out.push(SECRETISH.test(key) ? { key } : { key, mine, theirs })
    }
    return out
}

export function mergeEnv(dotEnv: Record<string, string>, real: EnvSource): EnvSource {
    const merged: EnvSource = { ...dotEnv }
    for (const [key, value] of Object.entries(real)) {
        if (value !== undefined) merged[key] = value
    }
    return merged
}

/**
 * A live view of the same two layers: reads hit the real environment first, then the `.env`
 * beside the manifest.
 *
 * Both properties matter and a plain merge only gives one of them.
 *
 * - **Live**, because the API key is read on every request so that rotating it needs no restart.
 *   A snapshot taken at load would pin the old value forever.
 * - **Not global**, because the alternative is `process.env[key] ??= value`, which is what
 *   dotenv libraries do and what a runtime hosting several agents from several directories must
 *   not do — agent A's `.env` would silently become agent B's configuration.
 */
export function layeredEnv(dotEnv: Record<string, string>, real: EnvSource): EnvSource {
    return new Proxy({} as Record<string, string | undefined>, {
        get: (_target, key: string | symbol) =>
            typeof key === "string" ? (real[key] ?? dotEnv[key]) : undefined,
        has: (_target, key: string | symbol) =>
            typeof key === "string" && (real[key] !== undefined || dotEnv[key] !== undefined),
        ownKeys: () => [...new Set([...Object.keys(dotEnv), ...Object.keys(real)])],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })
}
