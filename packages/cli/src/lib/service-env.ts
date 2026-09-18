/**
 * What a service definition may carry in its environment, and the throw that enforces it.
 *
 * **One list, two renderers.** `launchctl print` echoes a loaded job's `EnvironmentVariables` in
 * plaintext to any process running as this user, and `systemctl show` does exactly the same for
 * `Environment=` — so a credential in either is a credential published, with nothing about the
 * running agent looking wrong. The list lived in `launchd.ts` while launchd was the only manager;
 * a second copy beside the systemd renderer is how one of them comes to allow a variable the other
 * refuses, and the dangerous direction is the one that silently allows more.
 *
 * An allowlist rather than a denylist, and enforced by a throw rather than by review, because the
 * failure is silent and permanent.
 */

/**
 * The five that are not credentials.
 *
 * `HOME` because a service manager hands a job almost nothing — measured on macOS 26: `PATH` and
 * `SSH_AUTH_SOCK`, and that is all — and `HOME` is what decides the sandbox root. `PATH` because
 * `exec` runs shell commands and a service manager's default has no node, bun, git or brew in it.
 * `TMPDIR` because `exec` writes a child's output there. The two brand variables are a label and a
 * sandbox root, neither of which is a secret.
 */
export function serviceEnvAllowed(envPrefix: string): readonly string[] {
    return ["HOME", "PATH", "TMPDIR", `${envPrefix}SERVICE`, `${envPrefix}HOME`]
}

/**
 * Thrown by either renderer, with the same sentence.
 *
 * Not a `HarnessError`: this is a programming mistake in the CLI rather than a configuration
 * mistake by a person, and it has a `code` and a `hint` so whichever command was running can report
 * it the way it reports everything else.
 */
export class ServiceSecretError extends Error {
    readonly code = "daemon_secret_in_service"
    readonly hint: string
    constructor(key: string, allowed: readonly string[], manager: string) {
        super(`The service definition would carry an environment variable named ${key}.`)
        this.hint = `A ${manager} unit is readable and its manager echoes every environment value in plaintext to any process running as this user — so a credential here is a credential published. The agent reads its own secrets from the .env beside its manifest, which is what the service is pointed at. Only these may appear: ${allowed.join(", ")}.`
    }
}

/** Refuse anything outside the allowlist. Called before a byte is written. */
export function assertNoSecrets(
    environment: Readonly<Record<string, string>>,
    envPrefix: string,
    manager: string,
): void {
    const allowed = serviceEnvAllowed(envPrefix)
    for (const key of Object.keys(environment)) {
        if (!allowed.includes(key)) throw new ServiceSecretError(key, allowed, manager)
    }
}
