/**
 * `validate` — load a manifest through exactly the same path `run` uses, then report.
 *
 * Sharing the load path is the point. A validator that approves a manifest the runtime then refuses
 * is worse than no validator, so this calls `loadManifest` rather than reimplementing any part of it.
 *
 * Synchronous, and it imports neither Ink nor React. That is what keeps it at ~70 ms: the rich
 * renderer costs ~170-210 ms to import under Node, which would be most of this command's runtime.
 */

import { isAbsolute, resolve } from "node:path"
import {
    buildChannels,
    describeWindowSource,
    HarnessError,
    loadKnowledge,
    loadManifest,
    resolveCapabilities,
    resolveWorkspace,
    ruleBudgetFailure,
    windowReport,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { CHANNEL_IDS, CHANNELS, PROVIDER_IDS } from "#lib/providers"
import type { ValidateOptions } from "#lib/schema"

export function validateCommand(options: ValidateOptions): number {
    try {
        const loaded = loadManifest(options.manifestPath, {
            knownProviders: PROVIDER_IDS,
            knownChannels: CHANNEL_IDS,
            // The same environment `run` will use, or this validates a different agent — the
            // failure that rule exists for is a validator that disagrees with the runtime.
            env: ambientEnv([options.manifestPath]),
        })
        const { manifest } = loaded
        const capabilities = resolveCapabilities(
            manifest.model.main.id,
            manifest.model.main.capabilities,
        )

        // Loaded rather than counted, because the interesting failures are all in the loading:
        // a budget bust, a tier the frontmatter disagrees with, an unreadable file, a soul gate
        // resolving to a file disk does not have. `resolveWorkspace` is the same function `run`
        // calls, with the same resolved style — budgets are measured on the rendered text, so a
        // validator rendering differently would pass files the runtime refuses.
        const { workspace, warnings: workspaceWarnings } = resolveWorkspace(
            loaded,
            capabilities.promptStyle,
        )
        // Constructed, not merely name-checked. A channel factory reads its own config — a
        // `tokenEnv` naming an unset variable, an invalid `mode`, a `secretTokenEnv` left empty —
        // and those are configuration mistakes knowable without a packet. Skipping this reported
        // ok on a manifest `serve` refused at boot. Constructing a transport opens no socket, so
        // this is the same function `Runtime.create` calls and costs nothing.
        buildChannels(loaded, { channels: CHANNELS })

        // The same check `run` applies, applied here for the same reason it exists at all: a
        // validator that accepts a manifest the runtime refuses is worse than no validator.
        const ruleFailure = ruleBudgetFailure(workspace, manifest.context.rules)
        if (ruleFailure !== undefined && manifest.context.rules.onExceed === "fail")
            throw ruleFailure

        // Tier 3 loads exactly as `run` loads it, so a bad entry — no keywords, over the
        // activation budget — is a validation failure rather than a first-turn surprise.
        const knowledge =
            manifest.knowledge === undefined
                ? undefined
                : loadKnowledge({
                      dir: isAbsolute(manifest.knowledge.dir)
                          ? manifest.knowledge.dir
                          : resolve(loaded.dir, manifest.knowledge.dir),
                      maxActive: manifest.knowledge.maxActive,
                      budget: manifest.knowledge.budget,
                      style: capabilities.promptStyle,
                  })

        const tiers = (["static", "volatile", "reminder"] as const)
            .map((tier) => {
                const names = workspace.files
                    .filter((file) => file.tier === tier)
                    .map((file) => file.name)
                if (names.length === 0) return undefined
                return `${tier}=${names.join(",")} (${workspace.tokens[tier]}/${manifest.context.budgets[tier]})`
            })
            .filter((entry) => entry !== undefined)
            .join(" ")

        if (options.json === true) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ok: true,
                        path: loaded.path,
                        id: manifest.id,
                        model: manifest.model.main.id,
                        window: loaded.window,
                        capabilities,
                        workspace: {
                            files: workspace.files.map((file) => ({
                                name: file.name,
                                tier: file.tier,
                                editable: file.editable,
                                tokens: file.tokens,
                                budget: file.budget,
                            })),
                            tokens: workspace.tokens,
                        },
                        knowledge:
                            knowledge === undefined
                                ? []
                                : knowledge.entries.map((entry) => ({
                                      name: entry.name,
                                      keywords: entry.keywords,
                                      tokens: entry.tokens,
                                  })),
                        warnings: [
                            ...workspaceWarnings,
                            ...(ruleFailure === undefined ? [] : [ruleFailure.toDetail()]),
                        ],
                    },
                    null,
                    2,
                )}\n`,
            )
            return EXIT_OK
        }

        // One derivation with `Agent.create`'s boot warning, so a window this command calls a fact
        // cannot be one the runtime calls a guess.
        const windows = windowReport(manifest)
        const roles = windows
            .map((entry) =>
                entry.role === entry.configuredAs
                    ? `${entry.role}=${entry.modelId}`
                    : `${entry.role}=→main`,
            )
            .join(" ")
        // Only the roles that carry their own configuration. A fallback role's number is main's,
        // already on the line above, and repeating it says a second model was checked.
        const perRole = windows.filter((entry) => entry.role === entry.configuredAs)

        process.stdout.write(
            `ok  ${loaded.path}\n` +
                `  id           ${manifest.id}${manifest.name === undefined ? "" : ` (${manifest.name})`}\n` +
                `  models       ${roles}\n` +
                `  window       ${loaded.window} ${describeWindowSource(windows[0]?.window)} (reserveOutput ${manifest.context.reserveOutput}, maxOutput ${capabilities.maxOutput})\n` +
                (perRole.length < 2
                    ? ""
                    : `${perRole
                          .slice(1)
                          .map(
                              (entry) =>
                                  `  ${entry.role.padEnd(12)} ${entry.modelId} · window ${entry.window.contextWindow} ${describeWindowSource(entry.window)}\n`,
                          )
                          .join("")}`) +
                `  capabilities thinking=${capabilities.thinking} promptCache=${capabilities.promptCache} nativeTools=${capabilities.nativeTools} strictSchema=${capabilities.strictSchema}\n` +
                `  dialect      ${manifest.tools.dialect}\n` +
                `  workspace    ${tiers === "" ? "(none)" : tiers}\n` +
                (knowledge === undefined
                    ? ""
                    : `  knowledge    ${knowledge.entries.length} entries, maxActive=${knowledge.maxActive}, budget=${knowledge.budget}\n`) +
                // Printed whether or not it is configured, unlike `knowledge` above it. Memory is the one
                // tier whose absence is indistinguishable from "remembers nothing yet" — the reported
                // failure this row exists for was an agent with the block commented out, which read as
                // memory being broken rather than off. `none` is the informative answer here.
                `  memory       ${
                    manifest.memory === undefined
                        ? "none — nothing is retrieved across sessions"
                        : `${manifest.memory.retriever} at ${manifest.memory.dir}, maxActive=${manifest.memory.maxActive}, threshold=${manifest.memory.threshold}, budget=${manifest.memory.budget}, history=${manifest.memory.includeHistory}`
                }\n` +
                `  limits       maxSteps=${manifest.limits.maxSteps} turnTimeoutMs=${manifest.limits.turnTimeoutMs}\n` +
                [
                    ...workspaceWarnings,
                    ...(ruleFailure === undefined ? [] : [ruleFailure.toDetail()]),
                ]
                    .map((warning) => `  warning      ${warning.message}\n`)
                    .join(""),
        )
        return EXIT_OK
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            // A returned code rather than `process.exit`: exiting here would discard buffered stdout
            // when this is piped, which is exactly how `--json` output gets read.
            return EXIT_FAILURE
        }
        throw error
    }
}
