/**
 * The terminal UI's two packages, when an install left them out.
 *
 * `ink` and `react` are optional dependencies since 0.2.0-pilot.5, so an application embedding the
 * client can install the package with `--omit=optional` and go without them (VelaCrew #26). npm installs them by
 * default, so the CLI is whole for everybody else; this names the case that is not, instead of a
 * module-resolution stack trace pointing into a chunk.
 */
export function missingInterface(error: unknown): "ink" | "react" | undefined {
    if (!(error instanceof Error)) return undefined
    const code = (error as { code?: unknown }).code
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return undefined
    const match = /['"](ink|react)(?:\/[^'"]*)?['"]/.exec(error.message)
    return match?.[1] === "ink" || match?.[1] === "react" ? match[1] : undefined
}
