/**
 * `X_FILE=/run/secrets/x` sets `X` from that file, unless `X` is already set (pilot.9, VelaCrew).
 *
 * The container convention, and the point is where the value does *not* end up: assigning
 * `process.env` changes what this process reads, never the environment block the kernel shows at
 * `/proc/<pid>/environ`, so a token passed this way is not readable there by a command `exec` runs
 * as the same user — the half of secret-free `exec` that `env: scrub` cannot reach. Every reader in
 * the runtime (the server's token, a model key, a channel token) then works unchanged.
 *
 * `AWS_*` is left alone: the SDK reads its own `_FILE` variables (`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`,
 * `AWS_WEB_IDENTITY_TOKEN_FILE`) and copying one into the environment would put back the value the file
 * kept out. A file that cannot be read is reported and skipped, never fatal: the variable's own reader
 * still says it is missing, and one stale `_FILE` must not stop every command.
 */

import { readFileSync, statSync } from "node:fs"

/** Larger than any token or key; a path to something else is not a secret to inline. */
const MAX_BYTES = 64 * 1024

export function loadSecretFiles(
    env: Record<string, string | undefined> = process.env,
    warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): readonly string[] {
    const loaded: string[] = []
    for (const [key, path] of Object.entries(env)) {
        if (!key.endsWith("_FILE") || key.startsWith("AWS_") || path === undefined || path === "")
            continue
        const name = key.slice(0, -"_FILE".length)
        if (name === "" || (env[name] !== undefined && env[name] !== "")) continue
        try {
            if (statSync(path).size > MAX_BYTES) continue
            env[name] = readFileSync(path, "utf8").replace(/\r?\n$/, "")
            loaded.push(name)
        } catch (cause) {
            warn(
                `${key} names ${path}, which could not be read (${cause instanceof Error ? cause.message : String(cause)}); ${name} is not set from it.`,
            )
        }
    }
    return loaded
}
