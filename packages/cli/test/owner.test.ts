/**
 * The sandbox owner (decisions 15.7, 15.14), asserted at the far end: what `init` and `owner adopt`
 * leave in the redirected sandbox's files and store, never what an intermediate function returned.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, isHarnessError, loadManifest, SqliteStore } from "@dispach/core"
import { initCommand } from "#init"
import { EXIT_OK } from "#lib/const"
import { claimAgent, ownerChannelIds, sandboxOwner } from "#lib/owner"
import { ownerCommand } from "#owner"

const HOME_VAR = `${BRAND.envPrefix}HOME`

/** Run `work` with the sandbox redirected, the way every init test that touches it must. */
async function inSandbox<T>(work: (home: string) => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "owner-home-"))
    const before = process.env[HOME_VAR]
    const noBootstrap = `${BRAND.envPrefix}NO_BOOTSTRAP`
    const bootstrapBefore = process.env[noBootstrap]
    process.env[HOME_VAR] = home
    process.env[noBootstrap] = "1"
    try {
        return await work(home)
    } finally {
        if (before === undefined) delete process.env[HOME_VAR]
        else process.env[HOME_VAR] = before
        if (bootstrapBefore === undefined) delete process.env[noBootstrap]
        else process.env[noBootstrap] = bootstrapBefore
    }
}

async function storeAt(home: string): Promise<SqliteStore> {
    return SqliteStore.open({ path: join(home, "store.db") })
}

describe("the sandbox owner", () => {
    test("minted once as me:<6 symbols>, then read back", () => {
        const base = mkdtempSync(join(tmpdir(), "owner-base-"))
        const first = sandboxOwner(base, () => new Uint8Array([1, 2, 3, 4, 5, 6]))
        expect(first).toBe("me:123456")
        expect(sandboxOwner(base, () => new Uint8Array([9, 9, 9, 9, 9, 9]))).toBe("me:123456")
    })

    test("allowFrom becomes channel senders; `*` never does", () => {
        expect(
            ownerChannelIds([
                { type: "telegram", allowFrom: ["@moeen", "*"] },
                { type: "whatsapp", allowFrom: ["+880 1711-223344"] },
                { type: "slack" },
            ]),
        ).toEqual(["telegram:@moeen", "whatsapp:+880 1711-223344"])
    })

    test("an agent somebody else owns is refused, not taken over; one already yours keeps its senders", async () => {
        const store = await SqliteStore.open({ path: ":memory:" })
        const at = new Date().toISOString()
        await store.conversations.upsertParticipant({
            id: "user:ada",
            kind: "human",
            role: "member",
            createdAt: at,
        })
        await store.conversations.assign({
            agentId: "ada-bot",
            participantId: "user:ada",
            assignedAt: at,
        })
        const refused = await claimAgent(store, {
            agentId: "ada-bot",
            owner: "me:abcdef",
            channelIds: [],
        }).catch((error: unknown) => (isHarnessError(error) ? error.code : "other"))
        expect(refused).toBe("owner_assigned_elsewhere")

        await claimAgent(store, {
            agentId: "milo",
            owner: "me:abcdef",
            channelIds: ["telegram:@a"],
        })
        await claimAgent(store, {
            agentId: "milo",
            owner: "me:abcdef",
            channelIds: ["telegram:@b"],
        })
        expect((await store.conversations.assignment("milo"))?.channelIds).toEqual([
            "telegram:@a",
            "telegram:@b",
        ])
        expect((await store.conversations.participant("me:abcdef"))?.role).toBe("admin")
        await store.close()
    })
})

describe("init makes you the owner of what it creates", () => {
    test("the sandbox agent is written owner-scoped and boots owned", async () => {
        await inSandbox(async (home) => {
            const code = await initCommand({
                user: "Moeen",
                name: "Milo",
                purpose: "keeps my week on track",
                preset: "deepseek",
                yes: true,
            })
            expect(code).toBe(EXIT_OK)
            const manifest = join(home, "agents", "milo", "agent.yaml")
            const loaded = await loadManifest(manifest, { env: { MODEL_API_KEY: "(pending)" } })
            expect(loaded.manifest.sessions?.scope).toBe("owner")
            expect(loaded.manifest.memory?.shared).toBe(true)
            // Peer ask on, and the purpose as the description the other agents see (decision 15.9).
            expect(loaded.manifest.delegation?.ask).toBe(true)
            expect(loaded.manifest.description).toBe("keeps my week on track")

            const owner = readFileSync(join(home, "agents", ".owner"), "utf8").trim()
            expect(owner).toMatch(/^me:[0-9a-hjkmnp-tv-z]{6}$/)
            const store = await storeAt(home)
            expect((await store.conversations.assignment("milo"))?.participantId).toBe(owner)
            await store.close()
        })
    })
})

describe("owner adopt", () => {
    test("makes a pre-0.2.2 agent yours, and running it twice changes nothing", async () => {
        await inSandbox(async (home) => {
            const dir = join(home, "agents", "scout")
            mkdirSync(dir, { recursive: true })
            const manifest = join(dir, "agent.yaml")
            writeFileSync(
                manifest,
                `apiVersion: ${BRAND.apiVersion}\nid: scout\nmodel:\n  main:\n    id: m\n    baseUrl: https://api.example.com/v1\nchannels:\n  - type: telegram\n    id: tg\n    allowFrom: ["@moeen"]\n`,
            )
            expect(
                await ownerCommand({ action: "adopt", manifestPath: manifest, json: true }),
            ).toBe(EXIT_OK)
            const once = readFileSync(manifest, "utf8")
            expect(once).toContain("sessions:\n  scope: owner")
            expect(
                await ownerCommand({ action: "adopt", manifestPath: manifest, json: true }),
            ).toBe(EXIT_OK)
            expect(readFileSync(manifest, "utf8")).toBe(once)

            const store = await storeAt(home)
            const assignment = await store.conversations.assignment("scout")
            expect(assignment?.participantId).toBe(
                readFileSync(join(home, "agents", ".owner"), "utf8").trim(),
            )
            expect(assignment?.channelIds).toEqual(["telegram:@moeen"])
            await store.close()
        })
    })

    test("without an agent it says how to name one", async () => {
        const code = await ownerCommand({ action: "adopt", json: false }).catch((error: unknown) =>
            isHarnessError(error) ? error.code : "other",
        )
        expect(code).toBe("owner_agent_required")
    })
})
