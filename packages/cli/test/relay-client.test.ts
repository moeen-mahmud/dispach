/**
 * The runtime's relay client (`docs/24-SPEC-PEER-ASK.md`): the cached peer list survives a restart,
 * a refusal keeps the old list and says why, and an ask sends what the control plane expects.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { relayClient } from "../src/lib/relay-client.ts"

const PEERS = [{ silo: "team", agent: "crm", shared: true }]

function fakeControl(answer: (url: string, body: unknown) => Response) {
    const seen: { url: string; auth: string; body: unknown }[] = []
    const fetch = (async (url: string, init: RequestInit = {}) => {
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
        seen.push({
            url,
            auth: new Headers(init.headers).get("authorization") ?? "",
            body,
        })
        return answer(url, body)
    }) as unknown as typeof globalThis.fetch
    return { fetch, seen }
}

describe("relayClient", () => {
    test("a refreshed list is saved and is what the next process boots with", async () => {
        const cacheFile = join(mkdtempSync(join(tmpdir(), "relay-")), "relay-peers.json")
        const control = fakeControl(() => Response.json({ peers: PEERS }))
        const first = relayClient({
            url: "http://c/",
            token: "rt",
            cacheFile,
            fetch: control.fetch,
        })
        expect(first.cachedPeers("milo")).toEqual([])
        await first.refreshPeers("milo", "me:ada001")
        expect(control.seen[0]).toMatchObject({
            url: "http://c/v1/relay/peers?participant=me%3Aada001",
            auth: "Bearer rt",
        })
        // A new process, no network: the saved list.
        const next = relayClient({ url: "http://c", token: "rt", cacheFile, fetch: control.fetch })
        expect(next.cachedPeers("milo")).toEqual(PEERS)
    })

    test("a refusal keeps the saved list and carries the control plane's sentence", async () => {
        const cacheFile = join(mkdtempSync(join(tmpdir(), "relay-")), "relay-peers.json")
        writeFileSync(cacheFile, JSON.stringify({ milo: PEERS }))
        const control = fakeControl(() =>
            Response.json(
                { error: { code: "relay_token_invalid", message: "No.", hint: "Recreate it." } },
                { status: 401 },
            ),
        )
        const client = relayClient({
            url: "http://c",
            token: "rt",
            cacheFile,
            fetch: control.fetch,
        })
        await expect(client.refreshPeers("milo", "me:ada001")).rejects.toThrow("No. Recreate it.")
        expect(client.cachedPeers("milo")).toEqual(PEERS)
    })

    test("an ask names the person, the target and the asking agent; a refusal becomes the turn's error", async () => {
        const cacheFile = join(mkdtempSync(join(tmpdir(), "relay-")), "relay-peers.json")
        const control = fakeControl((_url, body) =>
            (body as { toAgent: string }).toAgent === "crm"
                ? Response.json({
                      text: "4 open deals",
                      reason: "final",
                      steps: 1,
                      tokens: { prompt: 1, output: 1 },
                      sessionKey: "ask:r_1",
                  })
                : Response.json(
                      {
                          error: {
                              code: "relay_peer_unknown",
                              message: "No such peer.",
                              hint: "h",
                          },
                      },
                      { status: 404 },
                  ),
        )
        const client = relayClient({
            url: "http://c",
            token: "rt",
            cacheFile,
            fetch: control.fetch,
        })
        const request = {
            fromAgent: "milo",
            participantId: "me:ada001",
            silo: "team",
            question: "how many deals?",
            sessionKey: "ask:r_1",
        }
        expect((await client.ask({ ...request, agent: "crm" })).text).toBe("4 open deals")
        expect(control.seen[0]?.body).toEqual({
            participant: "me:ada001",
            toSilo: "team",
            toAgent: "crm",
            question: "how many deals?",
            askedBy: "milo",
            sessionKey: "ask:r_1",
        })
        expect((await client.ask({ ...request, agent: "gone" })).error?.code).toBe(
            "relay_peer_unknown",
        )
    })
})
