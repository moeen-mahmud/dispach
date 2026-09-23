/**
 * How this process re-invokes its own binary.
 *
 * ## The defect this exists for
 *
 * Two places spawn this CLI again — a session pane running a command as a child, and the generated
 * service definition — and both assembled the argv as `[execPath, argv[1], ...args]`. That is right
 * for the npm install, where the entry point is a script and `execPath` is `node`. It is **wrong for
 * the compiled binary**, where `execPath` is already the whole command and `argv[1]` is a path inside
 * the embedded filesystem:
 *
 * ```
 * npm install       execPath /usr/local/bin/node   argv[1] /…/<pkg>/dist/index.js
 * compiled binary   execPath /usr/local/bin/<bin>   argv[1] /$bunfs/root/<bin>-linux-arm64
 * ```
 *
 * So the binary was invoked with its own virtual path as the first positional, and every pane command
 * in the container answered `Unknown command "/$bunfs/root/<bin>-linux-arm64"`. Reported from the
 * TUI on `/channels`, and it was never about `/channels` — `/skills`, `/config`, `/status` and the
 * rest were equally broken, in the one environment this project ships as a product.
 *
 * The service definition has the same shape and the same bug, unfired only because launchd is macOS
 * and nobody had installed a service from a compiled binary. A plist naming a `$bunfs` path exits 1
 * forever, into a log nobody has been told about — which is this project's founding complaint.
 *
 * ## The detection
 *
 * `/$bunfs/` is bun's marker for the embedded module filesystem, and a real script path can never be
 * inside it. Measured directly rather than assumed:
 *
 * ```
 * $ bun build --compile probe.ts && ./probe
 * {"execPath":"/private/tmp/probe","argv1":"/$bunfs/root/probe"}
 * ```
 *
 * Nothing is inferred from `process.isBun`: running *under* bun and being *compiled into* a binary
 * are different states, and `bun run src/index.ts` is the first with a perfectly good script path.
 */

/** Bun's embedded-filesystem prefix. A path inside it is not a file any process can execute. */
const EMBEDDED_PREFIX = "/$bunfs/"

/**
 * True when this process is a `bun build --compile` binary rather than a script under a runtime.
 *
 * Takes `argv` so it can be tested without a compiled binary to hand — which is the only way this
 * gets a guard at all, since the suite runs under bun-the-runtime and never as a compiled artefact.
 */
export function isCompiledBinary(argv: readonly string[] = process.argv): boolean {
    const script = argv[1]
    // No `argv[1]` at all is also a self-contained command: there is no script to pass on.
    return script === undefined || script === "" || script.startsWith(EMBEDDED_PREFIX)
}

/**
 * The command and leading arguments that re-run this CLI.
 *
 * One function because the two callers must not disagree: a pane that works and a service definition
 * that does not is the worse of the two failures, since the service one is only observable across a
 * reboot.
 */
export function selfInvocation(
    argv: readonly string[] = process.argv,
    execPath: string = process.execPath,
): { readonly command: string; readonly args: readonly string[] } {
    return isCompiledBinary(argv)
        ? { command: execPath, args: [] }
        : { command: execPath, args: [argv[1] ?? ""] }
}
