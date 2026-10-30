/**
 * Build the standalone tarballs: one per platform, each an official Node 24 plus the npm package.
 *
 * ## Why Node is bundled rather than compiled in
 *
 * `bun build --compile` would make one file, and it is what 0.1.3 removed: the WhatsApp transport
 * cannot complete its Noise handshake under Bun, and everything shipped runs on Node since. So a
 * "binary" here is a directory: `node/bin/node`, the **same tarball npm and brew install**, installed
 * into `lib/`, and a `bin/<slug>` launcher. Nothing is rebuilt per platform; only Node differs.
 *
 * That only holds while the package has no native code, because `npm install` runs once, on the
 * build machine, for all four targets. A `.node` file or a dependency declaring `os`/`cpu` would be
 * right for the builder and wrong for three of the four tarballs, with nothing failing until somebody
 * ran it — so either one stops the build, by name.
 *
 * Node is checked against nodejs.org's `SHASUMS256.txt` before it is unpacked.
 *
 *     bun scripts/build-standalone.ts                        # packs the tree, builds all four
 *     bun scripts/build-standalone.ts --tarball dispach.tgz  # the bytes the registry serves (CI)
 *     bun scripts/build-standalone.ts --targets darwin-arm64 --out /tmp/standalone
 *
 * Writes `<slug>-<os>-<arch>.tar.gz` and `SHA256SUMS` into `--out` (default `dist-standalone/`).
 * Asset names carry no version, so `releases/latest/download/<name>` resolves; the version is in a
 * `VERSION` file at each archive's root, which is what `install.sh` reads.
 */

import { createHash } from "node:crypto"
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { arch, platform, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "packages", "cli")
const SLUG = (JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")) as { name: string }).name
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const
const NODE_DIST = "https://nodejs.org/dist/latest-v24.x"

function flag(name: string): string | undefined {
    const at = process.argv.indexOf(`--${name}`)
    return at === -1 ? undefined : process.argv[at + 1]
}

function run(command: string, args: readonly string[], cwd: string): string {
    const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const out = new TextDecoder().decode(result.stdout)
    if (result.exitCode !== 0) {
        const err = new TextDecoder().decode(result.stderr)
        throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode})\n${err || out}`)
    }
    return out
}

async function download(url: string): Promise<Uint8Array> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? walk(path) : [path]
    })
}

/**
 * The launcher. POSIX sh, and it follows symlinks itself because `install.sh` links
 * `~/.<slug>/bin/<slug>` at it and macOS before 12.3 has no `readlink -f`.
 */
const LAUNCHER = `#!/bin/sh
self=$0
while [ -L "$self" ]; do
    link=$(readlink "$self")
    case $link in
        /*) self=$link ;;
        *) self=$(dirname "$self")/$link ;;
    esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/node/bin/node" "$root/lib/node_modules/${SLUG}/dist/index.js" "$@"
`

const out = resolve(flag("out") ?? join(ROOT, "dist-standalone"))
const targets = (flag("targets")?.split(",") ?? [...TARGETS]).map((target) => {
    if (!(TARGETS as readonly string[]).includes(target))
        throw new Error(`unknown target ${target}; known: ${TARGETS.join(", ")}`)
    return target
})
const work = mkdtempSync(join(tmpdir(), `${SLUG}-standalone-`))

try {
    // ── the package, installed once ─────────────────────────────────────────────────────────
    let tarball = flag("tarball")
    if (tarball === undefined) {
        process.stdout.write("packing\n")
        run("bun", ["run", "build"], ROOT)
        const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], CLI))
        tarball = join(work, (packed as [{ filename: string }])[0].filename)
    }
    tarball = resolve(tarball)
    const lib = join(work, "lib")
    mkdirSync(lib)
    // `--ignore-scripts`: nothing here may need an install step, and one that ran on the builder
    // would have produced output for the builder's platform only.
    run(
        "npm",
        [
            "install",
            "--prefix",
            lib,
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            tarball,
        ],
        work,
    )
    rmSync(join(lib, "package.json"), { force: true })
    const installed = join(lib, "node_modules")
    const version = (
        JSON.parse(readFileSync(join(installed, SLUG, "package.json"), "utf8")) as {
            version: string
        }
    ).version

    const native = walk(installed).filter((path) => path.endsWith(".node"))
    const pinned = walk(installed)
        .filter((path) => path.endsWith("/package.json") && !path.includes("/test/"))
        .filter((path) => {
            try {
                const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
                return manifest.os !== undefined || manifest.cpu !== undefined
            } catch {
                return false
            }
        })
    if (native.length > 0 || pinned.length > 0) {
        throw new Error(
            `the package is no longer platform-neutral, so one install cannot serve four targets:\n${[...native, ...pinned].map((path) => `  ${path.slice(installed.length + 1)}`).join("\n")}\nhint: install per target with npm's --os/--cpu flags, or drop the dependency.`,
        )
    }
    process.stdout.write(`${SLUG} ${version}: ${walk(installed).length} files, no native code\n`)

    // ── Node, per target ────────────────────────────────────────────────────────────────────
    const sums = new TextDecoder().decode(await download(`${NODE_DIST}/SHASUMS256.txt`))
    mkdirSync(out, { recursive: true })
    const written: string[] = []
    for (const target of targets) {
        const line = sums
            .split("\n")
            .find((row) => new RegExp(`node-v24\\.[0-9.]+-${target}\\.tar\\.gz$`).test(row))
        const [expected, file] = line?.split(/\s+/) ?? []
        if (expected === undefined || file === undefined)
            throw new Error(`SHASUMS256.txt names no Node 24 build for ${target}`)
        const bytes = await download(`${NODE_DIST}/${file}`)
        const actual = sha256(bytes)
        if (actual !== expected)
            throw new Error(`${file}: sha256 ${actual}, SHASUMS256.txt says ${expected}`)
        writeFileSync(join(work, file), bytes)
        run("tar", ["-xzf", file], work)

        const name = `${SLUG}-${target}`
        const stage = join(work, name)
        rmSync(stage, { recursive: true, force: true })
        mkdirSync(join(stage, "node", "bin"), { recursive: true })
        mkdirSync(join(stage, "bin"))
        const nodeDir = join(work, file.replace(/\.tar\.gz$/, ""))
        // Only the interpreter and its licence: npm, corepack and the headers are 60 MB of tooling
        // nothing in a runtime install calls.
        renameSync(join(nodeDir, "bin", "node"), join(stage, "node", "bin", "node"))
        renameSync(join(nodeDir, "LICENSE"), join(stage, "node", "LICENSE"))
        rmSync(nodeDir, { recursive: true })
        run("cp", ["-R", lib, join(stage, "lib")], work)
        writeFileSync(join(stage, "bin", SLUG), LAUNCHER)
        chmodSync(join(stage, "bin", SLUG), 0o755)
        writeFileSync(join(stage, "VERSION"), `${version}\n`)

        // The one target this machine can run is run, through the launcher, the way a person would.
        const host = `${platform()}-${arch()}`
        if (target === host) {
            const said = run(join(stage, "bin", SLUG), ["--version"], work).trim()
            if (!said.includes(version))
                throw new Error(`${name}: --version printed "${said}", expected ${version}`)
            process.stdout.write(`  ${name}: ran it, ${said}\n`)
        }

        const archive = `${name}.tar.gz`
        // bsdtar on macOS records xattrs (`com.apple.provenance`), and GNU tar warns about each one
        // on every file it unpacks. Linux builders have nothing to drop.
        const macOnly = platform() === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []
        run("tar", [...macOnly, "-czf", join(out, archive), name], work)
        rmSync(stage, { recursive: true })
        written.push(archive)
        const size = statSync(join(out, archive)).size
        process.stdout.write(
            `  ${archive} · node ${file.split("-")[1]} · ${(size / 1e6).toFixed(1)} MB\n`,
        )
    }

    // `sha256sum -c` format, so `install.sh` and a person checking by hand read the same file.
    const listing = written
        .map((archive) => `${sha256(readFileSync(join(out, archive)))}  ${archive}`)
        .join("\n")
    writeFileSync(join(out, "SHA256SUMS"), `${listing}\n`)
    process.stdout.write(`wrote ${written.length} archive(s) and SHA256SUMS to ${out}\n`)
} finally {
    rmSync(work, { recursive: true, force: true })
}
