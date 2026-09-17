#!/usr/bin/env bun
/**
 * Compiles the CLI into a standalone binary — one file, no Node, no `node_modules`.
 *
 * `bun build --compile` embeds the Bun runtime alongside the bundled program, which is why the
 * result is ~61 MB and why it starts *faster* than the published npm shape: there is no module
 * resolution left to do at boot. Measured on this machine, `validate --json`: 70–90 ms compiled
 * against 90–110 ms through `node packages/cli/dist/index.js`.
 *
 * ## Two things about this that are not obvious
 *
 * **A compiled binary is already ad-hoc signed, and macOS kills it anyway.** Bun emits a
 * *linker-signed* signature — `codesign -dv` reports `flags=0x20002(adhoc,linker-signed)` and
 * `Signature=adhoc`, so every obvious check says the binary is signed. It then dies on exec with
 * **exit 137 and no output at all**, which reads as a crash rather than as a policy refusal. An
 * explicit `codesign --force -s -` replaces it with a plain ad-hoc signature (`flags=0x2`) and the
 * binary runs. So signing is not "sign the unsigned thing", it is "replace the signature bun
 * wrote", and anyone debugging this by reading the signature will conclude it is already done.
 *
 * **`codesign` exists only on macOS**, so a darwin binary cross-compiled on Linux cannot be fixed
 * on the machine that built it. That is refused here rather than shipped: an unsigned darwin build
 * is a file that exits 137 for every user with no diagnostic. The release workflow therefore builds
 * the darwin targets on a macOS runner. Linux targets cross-compile from anywhere and need no
 * signature.
 *
 * ## Usage
 *
 *     bun scripts/build-binary.ts              # the host target only
 *     bun scripts/build-binary.ts --all        # every target this machine can produce
 *     bun scripts/build-binary.ts --targets darwin-arm64,linux-x64
 */

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULT_BRAND } from "../packages/core/src/brand.ts"

const ROOT = resolve(import.meta.dirname, "..")
const ENTRY = join(ROOT, "packages", "cli", "src", "index.ts")
const OUT_DIR = join(ROOT, "dist-bin")

interface Target {
    /** How this build is named on the command line and in the release asset. */
    readonly id: string
    /** The `--target` triple handed to `bun build`. */
    readonly triple: string
    readonly os: "darwin" | "linux"
    readonly arch: "arm64" | "x64"
}

/**
 * The four platforms. No Windows: the CLI shells out to `launchctl`/`systemctl`, resolves a POSIX
 * home, and `exec` runs `sh -c` — a Windows build would compile and then fail at the first
 * interesting thing, which is worse than not offering one.
 */
const TARGETS: readonly Target[] = [
    { id: "darwin-arm64", triple: "bun-darwin-arm64", os: "darwin", arch: "arm64" },
    { id: "darwin-x64", triple: "bun-darwin-x64", os: "darwin", arch: "x64" },
    { id: "linux-x64", triple: "bun-linux-x64", os: "linux", arch: "x64" },
    { id: "linux-arm64", triple: "bun-linux-arm64", os: "linux", arch: "arm64" },
]

const HOST_OS =
    process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : process.platform
const HOST_ARCH = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch

function hostTarget(): Target | undefined {
    return TARGETS.find((target) => target.os === HOST_OS && target.arch === HOST_ARCH)
}

function selected(): readonly Target[] {
    const argv = process.argv.slice(2)
    if (argv.includes("--all")) return TARGETS

    const flag = argv.indexOf("--targets")
    if (flag !== -1) {
        const value = argv[flag + 1]
        if (value === undefined || value.startsWith("--")) {
            fail(
                "--targets needs a value",
                `Comma-separated, from: ${TARGETS.map((t) => t.id).join(", ")}`,
            )
        }
        return value.split(",").map((id) => {
            const target = TARGETS.find((candidate) => candidate.id === id.trim())
            if (target === undefined) {
                fail(
                    `No such target: ${id.trim()}`,
                    `Known targets: ${TARGETS.map((t) => t.id).join(", ")}`,
                )
            }
            return target
        })
    }

    const host = hostTarget()
    if (host === undefined) {
        fail(
            `No target for this machine (${HOST_OS}/${HOST_ARCH})`,
            `Pass --targets explicitly, from: ${TARGETS.map((t) => t.id).join(", ")}`,
        )
    }
    return [host]
}

function fail(message: string, hint: string): never {
    process.stderr.write(`\n  ${message}\n  hint: ${hint}\n\n`)
    process.exit(1)
}

interface Built {
    readonly target: Target
    readonly path: string
    readonly bytes: number
    readonly signed: boolean
    /** Set only when the binary could be executed here — a cross-compiled one cannot. */
    readonly version?: string
}

function build(target: Target): Built {
    const path = join(OUT_DIR, `${DEFAULT_BRAND.slug}-${target.id}`)
    rmSync(path, { force: true })

    // No `--external` and no shebang banner, unlike the npm build: there is no `node_modules` beside
    // a standalone binary, and a `#!/usr/bin/env node` line at the head of a Mach-O file is not a
    // thing. `--compile` resolves static imports at build time while a dynamic `import()` still
    // defers *evaluation*, so the lazy Ink boundary that keeps `validate --json` off the renderer
    // survives (decision 11.202) — `boundaries.test.ts` is what keeps that true.
    const compile = Bun.spawnSync(
        ["bun", "build", ENTRY, "--compile", `--target=${target.triple}`, "--outfile", path],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    )

    if (compile.exitCode !== 0) {
        process.stderr.write(compile.stderr.toString())
        fail(
            `Compile failed for ${target.id}`,
            "Run `bun run build` first — the CLI resolves its siblings through their dist/, so a missing one fails here rather than at boot.",
        )
    }

    chmodSync(path, 0o755)
    const bytes = statSync(path).size
    const signed = target.os === "darwin" ? sign(target, path) : false
    const version = runnableHere(target) ? verify(target, path) : undefined

    return { target, path, bytes, signed, ...(version === undefined ? {} : { version }) }
}

/**
 * Replace bun's linker-signed signature with a plain ad-hoc one.
 *
 * Refuses rather than skipping when `codesign` is unavailable: the alternative is a darwin asset
 * that exits 137 for every user who downloads it, with nothing on stderr to explain why.
 */
function sign(target: Target, path: string): boolean {
    if (HOST_OS !== "darwin") {
        fail(
            `Cannot sign ${target.id} on ${HOST_OS}`,
            "codesign is macOS-only, and an unsigned darwin binary is SIGKILLed with exit 137 and no message. Build the darwin targets on a macOS runner.",
        )
    }

    const signed = Bun.spawnSync(["codesign", "--force", "-s", "-", path], {
        stdout: "pipe",
        stderr: "pipe",
    })
    if (signed.exitCode !== 0) {
        process.stderr.write(signed.stderr.toString())
        fail(
            `codesign failed for ${target.id}`,
            "The binary would exit 137 with no output. Not shipping it.",
        )
    }
    return true
}

/** A cross-compiled binary cannot be executed here, so it is built and not proven. */
function runnableHere(target: Target): boolean {
    return target.os === HOST_OS && target.arch === HOST_ARCH
}

function verify(target: Target, path: string): string {
    const ran = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) {
        const detail = ran.stderr.toString().trim()
        fail(
            `${target.id} built but does not run (exit ${ran.exitCode})`,
            detail === ""
                ? "No output at all, which on macOS means the signature was rejected. Check `codesign -dv` reports flags=0x2 and not linker-signed."
                : detail,
        )
    }
    return ran.stdout.toString().trim()
}

// ─── run ──────────────────────────────────────────────────────────────────────────────────

const targets = selected()
mkdirSync(OUT_DIR, { recursive: true })

const expected = (await Bun.file(join(ROOT, "packages", "cli", "package.json")).json()) as {
    readonly version: string
}

const results: Built[] = []
for (const target of targets) {
    process.stdout.write(`  building ${target.id} … `)
    const built = build(target)
    results.push(built)
    const mb = (built.bytes / 1_048_576).toFixed(1)
    const signedNote = built.signed ? ", signed" : ""
    const ranNote = built.version === undefined ? ", not run here" : `, ran (${built.version})`
    process.stdout.write(`${mb} MB${signedNote}${ranNote}\n`)
}

const mismatched = results.filter(
    (built) => built.version !== undefined && built.version !== expected.version,
)
if (mismatched.length > 0) {
    fail(
        `A binary reports a version the package does not: ${mismatched.map((b) => `${b.target.id} said ${b.version}`).join(", ")}`,
        `packages/cli/package.json says ${expected.version}. A stale dist/ is the usual cause — run \`bun run build\`.`,
    )
}

process.stdout.write(`\n  ${results.length} binary/binaries in ${OUT_DIR}\n`)
const unproven = results.filter((built) => built.version === undefined)
if (unproven.length > 0) {
    // Said rather than left implicit: "built" and "works" are different claims, and a cross-compiled
    // asset has only the first.
    process.stdout.write(
        `  not executed here (cross-compiled): ${unproven.map((b) => b.target.id).join(", ")}\n`,
    )
}
