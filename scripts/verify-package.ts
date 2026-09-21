/**
 * Pack the one published package, install it somewhere clean, and use it the three documented ways.
 *
 * ## Why this is a script rather than a test
 *
 * "The tarball declares every package it imports" cannot be checked by reading the tarball: the
 * bundle is minified, so scanning it for `from "x"` matches the word *from* inside string literals —
 * the first attempt reported ten undeclared dependencies that were fragments of a help screen. The
 * only tool that answers the question correctly is Node's own resolver, in a directory that has
 * exactly the declared dependencies and nothing else. That means `npm pack` and `npm install`, which
 * is twenty seconds and a network fetch: an integration check, not a unit one.
 *
 * ## What it proves
 *
 * That `npm i -g dispach` gives a working command, that `import "dispach"` gives the library rather
 * than running the CLI, and that `dispach/client` pulls in no terminal UI. Every one of those was
 * wrong at some point while this package was being shaped.
 *
 *     bun run verify:package
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(ROOT, "packages", "cli")

function run(command: string, args: readonly string[], cwd: string): string {
    const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const out = new TextDecoder().decode(result.stdout)
    if (result.exitCode !== 0) {
        const err = new TextDecoder().decode(result.stderr)
        throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode})\n${err || out}`)
    }
    return out
}

const work = mkdtempSync(join(tmpdir(), "dispach-pack-"))
let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
    process.stdout.write(
        `  ${ok ? "ok  " : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}\n`,
    )
    if (!ok) failures += 1
}

try {
    process.stdout.write("packing\n")
    // Built first, deliberately: `files: ["dist"]` ships whatever is there, and the whole reason
    // this script exists is that nothing used to clean it.
    run("bun", ["run", "build"], ROOT)
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], CLI)) as [
        { filename: string; size: number; unpackedSize: number; entryCount: number },
    ]
    const tarball = packed[0]
    if (tarball === undefined) throw new Error("npm pack produced nothing")
    process.stdout.write(
        `  ${tarball.entryCount} files · ${(tarball.size / 1e6).toFixed(1)} MB packed · ${(tarball.unpackedSize / 1e6).toFixed(1)} MB unpacked\n`,
    )
    // A ceiling rather than a target, and it is here because the number was once 2,693 files and
    // 201 MB: `dist/` was never cleaned, so a month of stale chunks — a hundred of them importing a
    // package renamed away — would have been published. Renegotiate it with a measurement.
    check("under 1000 files", tarball.entryCount < 1000, `${tarball.entryCount}`)
    check(
        "under 25 MB unpacked",
        tarball.unpackedSize < 25e6,
        `${(tarball.unpackedSize / 1e6).toFixed(1)} MB`,
    )

    /**
     * **`npm publish --dry-run`, because `npm pack` does not normalise the manifest.**
     *
     * This is the check that was missing, and the bug it would have caught is the worst kind. `bin`
     * was `{"dispach": "./dist/index.js"}`; npm rejects a leading `./` on a bin target and strips
     * **the whole entry**, so the published package would have installed no command at all —
     * `npm i -g dispach` and then `dispach: command not found`. Every local check passed, because
     * `npm install <tarball>` tolerates the `./` that `npm publish` removes.
     *
     * So the assertion is not about any one field: it is that npm had **nothing to correct**. Any
     * "auto-corrected some errors in your package.json" is npm telling us the thing it publishes is
     * not the thing we wrote, and that difference is exactly where a defect hides.
     */
    process.stdout.write("asking npm what it would change\n")
    const dry = Bun.spawnSync(["npm", "publish", "--dry-run", "--access", "public"], {
        cwd: CLI,
        stdout: "pipe",
        stderr: "pipe",
    })
    const dryText = `${new TextDecoder().decode(dry.stdout)}${new TextDecoder().decode(dry.stderr)}`
    const corrected = dryText
        .split("\n")
        .filter((line) => /auto-corrected|errors corrected|was invalid/.test(line))
    check("npm has nothing to correct in package.json", corrected.length === 0)
    for (const line of corrected) process.stdout.write(`        ${line.trim()}\n`)

    process.stdout.write("installing into a clean directory\n")
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "consumer", type: "module" }))
    run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball.filename)], work)

    process.stdout.write("using it\n")
    const cli = run(join(work, "node_modules", ".bin", "dispach"), ["--version"], work).trim()
    check("the bin runs", /^\d+\.\d+\.\d+$/.test(cli), cli)

    /**
     * A readme, and a non-empty one.
     *
     * `files` listed `README.md` and the directory had none. npm ignores a missing entry **in
     * silence**, so the package would have gone out with a blank page on the registry — the front
     * door of the whole project, empty, with nothing anywhere reporting it. It is copied from the
     * root README at build time rather than maintained twice.
     */
    const readme = join(work, "node_modules", "dispach", "README.md")
    const readmeBytes = existsSync(readme) ? statSync(readme).size : 0
    check("it ships a readme", readmeBytes > 1000, `${readmeBytes} bytes`)

    writeFileSync(
        join(work, "probe.mjs"),
        `import { createClient } from "dispach"
import { createClient as sub, DispachError } from "dispach/client"
import { EVENT_TYPES } from "dispach/wire"
const error = new DispachError({ code: "c", message: "m", hint: "h" })
console.log(JSON.stringify({
    library: typeof createClient === "function",
    // The default import must be the library. It used to be the CLI entry, which has a shebang and
    // runs on import, so \`import "dispach"\` printed the banner and exited.
    sameModule: createClient === sub,
    events: EVENT_TYPES.length,
    // Minification renames classes, so a name derived from one prints as a single letter. Declared
    // instead, which is what this proves survived the build.
    errorName: error.name,
}))
`,
    )
    const probe = JSON.parse(run("node", ["probe.mjs"], work)) as {
        library: boolean
        sameModule: boolean
        events: number
        errorName: string
    }
    check('`import "dispach"` is the library, and prints nothing', probe.library)
    check("`dispach/client` is the same module", probe.sameModule)
    check("`dispach/wire` carries the event schema", probe.events > 20, `${probe.events} types`)
    check("an error reports its own name", probe.errorName === "DispachError", probe.errorName)
} finally {
    rmSync(work, { recursive: true, force: true })
}

process.stdout.write(
    failures === 0 ? "\nverify-package: ok\n" : `\nverify-package: ${failures} failed\n`,
)
process.exitCode = failures === 0 ? 0 : 1
