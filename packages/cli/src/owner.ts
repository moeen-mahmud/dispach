/**
 * `owner show` and `owner adopt <agent>` (decisions 15.7, 15.14).
 *
 * `init` makes the person running it the owner of what it creates. An agent made before that, or
 * outside the sandbox, has nobody, so `sessions.scope: owner` would do nothing for it: this is the
 * one step that makes it yours — registered, assigned with your channel senders from `allowFrom`,
 * and the scope written. Idempotent, so running it twice changes nothing the second time.
 */

import { readFileSync } from "node:fs"
import { BRAND, editManifest, HarnessError, readManifestHeader, SqliteStore } from "@dispach/core"
import { EXIT_OK } from "#lib/const"
import { reloadOnHost } from "#lib/host-actions"
import { claimManifest, ownerPath } from "#lib/owner"
import { agentsDir, storePath } from "#lib/sandbox"

export interface OwnerCommandOptions {
    readonly action: string
    readonly manifestPath?: string
    readonly store?: string
    readonly json: boolean
}

export async function ownerCommand(options: OwnerCommandOptions): Promise<number> {
    const agentsBase = agentsDir()
    if (options.action === "show") {
        let id: string | undefined
        try {
            id = readFileSync(ownerPath(agentsBase), "utf8").trim() || undefined
        } catch {
            id = undefined
        }
        if (options.json) process.stdout.write(`${JSON.stringify({ owner: id ?? null })}\n`)
        else
            process.stdout.write(
                id === undefined
                    ? `No owner yet. \`${BRAND.slug} init\` or \`${BRAND.slug} owner adopt <agent>\` makes you one.\n`
                    : `${id}\n`,
            )
        return EXIT_OK
    }

    const manifestPath = options.manifestPath
    if (manifestPath === undefined || manifestPath === "") {
        throw new HarnessError({
            code: "owner_agent_required",
            message: "owner adopt needs an agent.",
            hint: `Name one: \`${BRAND.slug} owner adopt milo\`, or a path to its agent.yaml.`,
        })
    }
    const agentId = readManifestHeader(manifestPath).id ?? ""

    const store = await SqliteStore.open({ path: options.store ?? storePath() })
    let claimed: Awaited<ReturnType<typeof claimManifest>>
    try {
        claimed = await claimManifest(store, manifestPath, agentsBase)
    } finally {
        await store.close()
    }

    // `sessions:` is a top-level block a manifest written before 0.2.2 does not have, and the source
    // editor appends only under a parent that exists — so it goes at the end, where a reader finds it.
    const edit = await editManifest({
        file: manifestPath,
        path: ["sessions", "scope"],
        value: "owner",
        fallback: (source) =>
            /^sessions:/m.test(source)
                ? undefined
                : `${source.replace(/\n*$/, "\n")}\n# One conversation with you across the web, the terminal and every channel.\nsessions:\n  scope: owner\n`,
    })
    const reload = await reloadOnHost(manifestPath, options.store)
    const host =
        reload.kind === "reloaded" || reload.kind === "pending"
            ? `reloaded by pid ${reload.pid}`
            : reload.kind === "no-host"
              ? "not running here; takes effect when it next starts"
              : `pid ${reload.pid} did not reload it (${reload.kind}); restart it to take effect`

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify({ agent: agentId, owner: claimed.owner, channelIds: claimed.channelIds, scopeChanged: edit.changed, reload: reload.kind })}\n`,
        )
        return EXIT_OK
    }
    process.stdout.write(
        [
            `owner     ${claimed.owner}`,
            `agent     ${agentId}  sessions.scope: owner${edit.changed ? "" : " (already)"}`,
            // Every entry, because each one is now somebody the agent treats as you.
            `you on    ${claimed.channelIds.length === 0 ? "the web and the terminal only — no allowFrom entries to recognise you by on a channel" : claimed.channelIds.join(", ")}`,
            `host      ${host}`,
            "",
        ].join("\n"),
    )
    return EXIT_OK
}
