#!/usr/bin/env bun
/**
 * Makes two hard rules mechanical instead of a matter of reviewer vigilance.
 *
 *   Rule 2  `packages/core` imports nothing from a sibling package, and depends on nothing
 *           beyond the standard library, a YAML parser, and a schema validator.
 *
 * And the licence boundary, which is the same shape. `packages/control` is FSL-1.1 in an Apache-2.0
 * tree (decision 14.5), and the line holds only if code never crosses it in either direction:
 *
 *   - the control plane imports nothing from the runtime, and depends on nothing — it calls `/v1`
 *     like any other client, which is what makes it replaceable and keeps the runtime's API honest;
 *   - nothing in the runtime imports the control plane, so no FSL code can reach the Apache-2.0
 *     tarball or image by being bundled.
 *
 * Both are cheap to violate accidentally and expensive to discover late: the moment core
 * imports a channel, the dependency graph inverts and every "core is lightweight" claim in
 * the docs becomes false.
 *
 * A static scan, deliberately. Importing core to inspect it would execute it, and an import
 * cycle that only appears at runtime is exactly the failure this is meant to catch.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { DEFAULT_BRAND } from "../packages/core/src/brand.ts"

const ROOT = resolve(import.meta.dirname, "..")
const CORE = join(ROOT, "packages", "core")
const CONTROL = join(ROOT, "packages", "control")

/** Rule 2, second clause: the complete allowlist of core's runtime dependencies. */
const ALLOWED_CORE_DEPS = new Set(["yaml", "zod"])

interface Violation {
    file: string
    line: number
    specifier: string
    reason: string
    hint: string
}

/** `import x from "y"`, `export … from "y"`, `import("y")`, `require("y")`. */
const SPECIFIER_PATTERNS = [
    /\b(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
]

function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            out.push(...walk(full))
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
            out.push(full)
        }
    }
    return out
}

function specifiersIn(source: string): { specifier: string; line: number }[] {
    const found: { specifier: string; line: number }[] = []
    for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0
        let match = pattern.exec(source)
        while (match !== null) {
            const specifier = match[1]
            if (specifier !== undefined) {
                const line = source.slice(0, match.index).split("\n").length
                found.push({ specifier, line })
            }
            match = pattern.exec(source)
        }
    }
    return found
}

function checkCoreImports(): Violation[] {
    const violations: Violation[] = []
    const scope = DEFAULT_BRAND.packageScope
    const own = `${scope}/core`

    for (const file of walk(join(CORE, "src")).concat(walk(join(CORE, "test")))) {
        const source = readFileSync(file, "utf8")
        const rel = relative(ROOT, file)

        for (const { specifier, line } of specifiersIn(source)) {
            if (
                specifier.startsWith(`${scope}/`) &&
                specifier !== own &&
                !specifier.startsWith(`${own}/`)
            ) {
                violations.push({
                    file: rel,
                    line,
                    specifier,
                    reason: `core imports the sibling package ${specifier}`,
                    hint:
                        "Core depends on nothing in this monorepo. If core needs this capability, it belongs " +
                        "in core or behind a plugin extension point — see docs/03-SPEC-PLUGIN-API.md.",
                })
                continue
            }

            // A relative path that climbs out of packages/core reaches a sibling the long way round.
            if (specifier.startsWith(".")) {
                const target = resolve(file, "..", specifier)
                if (!target.startsWith(`${CORE}/`)) {
                    violations.push({
                        file: rel,
                        line,
                        specifier,
                        reason: `relative import escapes packages/core to ${relative(ROOT, target)}`,
                        hint: "Keep core self-contained. Reaching across package boundaries by path is the same violation as importing the package.",
                    })
                }
            }
        }
    }
    return violations
}

function checkCoreDependencies(): Violation[] {
    const manifestPath = join(CORE, "package.json")
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    const deps = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {}

    return Object.keys(deps)
        .filter((name) => !ALLOWED_CORE_DEPS.has(name))
        .map((name) => ({
            file: relative(ROOT, manifestPath),
            line: 1,
            specifier: name,
            reason: `core declares the dependency ${name}`,
            hint:
                `Core's allowlist is {${[...ALLOWED_CORE_DEPS].join(", ")}} — the standard library, a YAML ` +
                "parser, and a schema validator. Anything else belongs in a package that depends on core.",
        }))
}

function sources(dir: string): string[] {
    return ["src", "test"].flatMap((sub) => {
        const path = join(dir, sub)
        try {
            return statSync(path).isDirectory() ? walk(path) : []
        } catch {
            return []
        }
    })
}

function checkControlIsolated(): Violation[] {
    const violations: Violation[] = []
    const scope = DEFAULT_BRAND.packageScope
    for (const file of sources(CONTROL)) {
        const rel = relative(ROOT, file)
        for (const { specifier, line } of specifiersIn(readFileSync(file, "utf8"))) {
            const escapes =
                specifier.startsWith(".") &&
                !resolve(file, "..", specifier).startsWith(`${CONTROL}/`)
            if (specifier.startsWith(`${scope}/`) || escapes) {
                violations.push({
                    file: rel,
                    line,
                    specifier,
                    reason: "the control plane imports from the runtime",
                    hint: "packages/control calls a silo over /v1 and imports nothing from this tree. It is FSL-licensed and the runtime is Apache-2.0, so an import here moves code across the licence line. If the control plane needs something, the runtime's API should expose it.",
                })
            }
        }
    }
    const manifest = JSON.parse(readFileSync(join(CONTROL, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
        violations.push({
            file: relative(ROOT, join(CONTROL, "package.json")),
            line: 1,
            specifier: name,
            reason: `the control plane declares the dependency ${name}`,
            hint: "It has none: Node's standard library, run as TypeScript. A dependency here is one more thing between an operator and the silos they hold.",
        })
    }
    return violations
}

function checkNothingImportsControl(): Violation[] {
    const violations: Violation[] = []
    const name = `${DEFAULT_BRAND.packageScope}/control`
    const packages = readdirSync(join(ROOT, "packages"))
        .map((entry) => join(ROOT, "packages", entry))
        .filter((dir) => dir !== CONTROL && statSync(dir).isDirectory())
    const files = [...packages.flatMap(sources), ...walk(join(ROOT, "scripts"))]
    for (const file of files) {
        for (const { specifier, line } of specifiersIn(readFileSync(file, "utf8"))) {
            const into =
                specifier.startsWith(".") &&
                resolve(file, "..", specifier).startsWith(`${CONTROL}/`)
            if (specifier === name || specifier.startsWith(`${name}/`) || into) {
                violations.push({
                    file: relative(ROOT, file),
                    line,
                    specifier,
                    reason: "the runtime imports the control plane",
                    hint: "packages/control is FSL-1.1 and everything else here is Apache-2.0. An import would bundle FSL code into the runtime's tarball or image. Talk to the control plane over HTTP, or move what is shared into the runtime.",
                })
            }
        }
    }
    return violations
}

const violations = [
    ...checkCoreImports(),
    ...checkCoreDependencies(),
    ...checkControlIsolated(),
    ...checkNothingImportsControl(),
]

if (violations.length === 0) {
    console.log(
        "check-deps: ok — packages/core is self-contained, and nothing crosses packages/control's licence line",
    )
    process.exit(0)
}

console.error(`check-deps: ${violations.length} violation(s)\n`)
for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.reason}`)
    console.error(`    specifier: ${v.specifier}`)
    console.error(`    hint: ${v.hint}\n`)
}
process.exit(1)
