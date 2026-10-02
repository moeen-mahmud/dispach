/**
 * What running in a pod needs: a store that refuses a network filesystem, and a stop that can wait
 * for running turns inside the orchestrator's grace period.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, type ChatChunk, type ModelTransport, Runtime } from "../src/index.ts"
import { filesystemOf, networkStoreRefusal, parseMountinfo } from "../src/store/filesystem.ts"
import { describe, expect, test } from "./_harness.ts"

// Shapes from a real EKS node: the root overlay, an EBS volume, and EFS (which mounts as nfs4).
const MOUNTINFO = [
    "22 1 0:21 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/l,upperdir=/u",
    "30 22 259:3 / /home/app rw,relatime - ext4 /dev/nvme1n1 rw",
    "31 22 0:50 / /home/app/agents rw,relatime shared:9 - nfs4 fs-1.efs.eu-west-1.amazonaws.com:/ rw,vers=4.1",
    "32 22 0:51 / /mnt/with\\040space rw - nfs4 fs-2:/ rw",
].join("\n")

describe("the store refuses a network filesystem", () => {
    const mounts = parseMountinfo(MOUNTINFO)

    test("the longest containing mount decides, and an escaped space is unescaped", () => {
        expect(filesystemOf("/home/app/store", mounts)).toBe("ext4")
        expect(filesystemOf("/home/app/agents/milo", mounts)).toBe("nfs4")
        // A sibling that merely shares a prefix is not inside the mount.
        expect(filesystemOf("/home/app/agents-backup", mounts)).toBe("ext4")
        expect(filesystemOf("/mnt/with space/db", mounts)).toBe("nfs4")
        expect(filesystemOf("/etc", mounts)).toBe("overlay")
    })

    test("a later line over the same mount point wins", () => {
        const over = parseMountinfo(`${MOUNTINFO}\n40 30 0:60 / /home/app rw - nfs4 fs-3:/ rw`)
        expect(filesystemOf("/home/app/store", over)).toBe("nfs4")
    })

    test("EFS is refused with a hint naming the fix and the override; the override opens it", () => {
        const read = () => MOUNTINFO
        const refusal = networkStoreRefusal("/home/app/agents/store.db", {}, read)
        expect(refusal?.code).toBe("store_on_network_filesystem")
        expect(refusal?.hint).toContain("EBS")
        expect(refusal?.hint).toContain(`${BRAND.envPrefix}ALLOW_NETWORK_STORE=1`)
        const allowed = { [`${BRAND.envPrefix}ALLOW_NETWORK_STORE`]: "1" }
        expect(networkStoreRefusal("/home/app/agents/store.db", allowed, read)).toBeUndefined()
        expect(networkStoreRefusal("/home/app/store/store.db", {}, read)).toBeUndefined()
        // Off Linux there is no mount table, and nothing is refused.
        expect(
            networkStoreRefusal("/home/app/agents/store.db", {}, () => undefined),
        ).toBeUndefined()
    })
})

describe("drain", () => {
    /** A model that answers only when released, so a turn is running for as long as a test wants. */
    function held(): { transport: ModelTransport; release: () => void } {
        let release = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        return {
            release: () => release(),
            transport: {
                create: (context) => ({
                    id: context.id,
                    async *chat(): AsyncIterable<ChatChunk> {
                        await gate
                        yield { type: "text", delta: "done" }
                        yield { type: "finish", reason: "stop" }
                    },
                }),
            },
        }
    }

    async function boot(transport: ModelTransport): Promise<Runtime> {
        const dir = mkdtempSync(join(tmpdir(), "drain-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}\nid: drained\nmodel:\n  main:\n    id: held\n    api: held\n`,
        )
        return Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: {},
            store: ":memory:",
            modelTransports: { held: transport },
        })
    }

    test("waits for a running turn, and readiness is false while it does", async () => {
        const { transport, release } = held()
        const runtime = await boot(transport)
        const reply = runtime.agent("drained").send("hi")
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(runtime.agent("drained").inFlight).toBe(1)

        const drained = runtime.drain(5000)
        expect(runtime.ready).toBe(false)
        expect(runtime.draining).toBe(true)
        setTimeout(release, 50)
        expect(await drained).toBe(0)
        expect((await reply).text).toBe("done")
        await runtime.stop()
    })

    test("gives up at the deadline and reports what is still running", async () => {
        const { transport, release } = held()
        const runtime = await boot(transport)
        const reply = runtime.agent("drained").send("hi")
        await new Promise((resolve) => setTimeout(resolve, 20))
        const started = Date.now()
        expect(await runtime.drain(150)).toBe(1)
        expect(Date.now() - started).toBeLessThan(1000)
        release()
        await reply
        await runtime.stop()
    })
})
