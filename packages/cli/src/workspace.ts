/**
 * The `workspace <manifest>` command — the authoring rules, checked.
 *
 * Deliberately a separate command from `validate`. That one answers "does this load?", which is a
 * question with a yes or a no; this one answers "is this written well?", which is a judgement. They
 * report differently because they are different: a budget bust stops the runtime, and a rule with no
 * stated reason is a note from a careful reader.
 *
 * So every finding here is a warning and the command exits 0 by default. `--strict` is for CI, where
 * "warnings you have decided to live with" and "warnings nobody has read" look identical and only a
 * non-zero exit tells them apart.
 */

import {
    checkAuthoring,
    type ErrorDetail,
    HarnessError,
    loadManifest,
    resolveCapabilities,
    resolveWorkspace,
    ruleBudgetFailure,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"

export interface WorkspaceOptions {
    readonly manifestPath: string
    readonly json?: boolean
    readonly strict?: boolean
}

export function workspaceCommand(options: WorkspaceOptions): number {
    try {
        const loaded = loadManifest(options.manifestPath, {
            // The same environment `run` will use, or this validates a different agent — the
            // failure that rule exists for is a validator that disagrees with the runtime.
            env: ambientEnv([options.manifestPath]),
        })
        const { manifest } = loaded
        const capabilities = resolveCapabilities(
            manifest.model.main.id,
            manifest.model.main.capabilities,
        )

        // The same resolution `run` uses, soul gate included — the file the gate selects is a file
        // someone wrote, and its writing deserves the same reading as any other identity file.
        const { workspace, warnings } = resolveWorkspace(loaded, capabilities.promptStyle)

        // The authoring checks read the *authored* text, never the rendered form. An author fixes
        // what they wrote, and telling them about a heading the renderer inserted would send them
        // looking for a line that is not in their file.
        const findings: ErrorDetail[] = [
            ...warnings,
            ...checkAuthoring(
                workspace.files.map((file) => ({
                    name: file.name,
                    authored: file.authored,
                    tier: file.tier,
                    field: file.field,
                })),
            ),
        ]
        const ruleFailure = ruleBudgetFailure(workspace, manifest.context.rules)
        if (ruleFailure !== undefined) findings.push(ruleFailure.toDetail())

        if (options.json === true) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ok: findings.length === 0,
                        path: loaded.path,
                        promptStyle: capabilities.promptStyle,
                        files: workspace.files.map((file) => ({
                            name: file.name,
                            tier: file.tier,
                            editable: file.editable,
                            tokens: file.tokens,
                            budget: file.budget,
                        })),
                        tokens: workspace.tokens,
                        findings,
                    },
                    null,
                    2,
                )}\n`,
            )
            return options.strict === true && findings.length > 0 ? EXIT_FAILURE : EXIT_OK
        }

        const style = capabilities.promptStyle
        process.stdout.write(
            `${loaded.path}\n` +
                `  rendering    delimiters=${style.delimiters} intensity=${style.intensity} examplesIn=${style.examplesIn}\n` +
                `  total        ${workspace.tokens.total} tokens (static ${workspace.tokens.static}, volatile ${workspace.tokens.volatile}, reminder ${workspace.tokens.reminder})\n`,
        )

        for (const file of workspace.files) {
            process.stdout.write(
                `  ${file.name.padEnd(14)} ${file.tier.padEnd(9)} ${String(file.tokens).padStart(5)}/${file.budget} tokens, editable=${file.editable}\n`,
            )
        }

        if (findings.length === 0) {
            process.stdout.write("\nno findings\n")
            return EXIT_OK
        }

        for (const finding of findings) {
            process.stdout.write(`\n  ${finding.code}: ${finding.message}\n`)
            process.stdout.write(`    hint: ${finding.hint}\n`)
        }
        // Counted rather than merely listed: "three findings" is the sentence someone acts on, and
        // scrolling back to count them is how a fourth one goes unnoticed.
        process.stdout.write(`\n${findings.length} finding(s)\n`)

        return options.strict === true ? EXIT_FAILURE : EXIT_OK
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            return EXIT_FAILURE
        }
        throw error
    }
}
