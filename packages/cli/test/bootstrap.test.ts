/**
 * When the first run installs a background service, and — mostly — when it does not.
 *
 * This is the most invasive thing the product does, so the interesting assertions are the negative
 * ones. Every skip reason below is a case where installing a service would be wrong, and each was
 * chosen rather than discovered: a container is already supervised, a CI runner would be left with
 * a service the next job inherits, and a command that answers from files must not install anything
 * as a side effect of being asked a question.
 *
 * The other half is that it **never fails the command it was asked for**. A LaunchAgent needs a GUI
 * session, so over SSH the install returns 125 or 112 — and a listing that died because a
 * background service could not be installed would be a far worse product than one with no
 * bootstrap at all.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, SqliteStore } from "@dispach/core"
import {
    announce,
    type BootstrapOptions,
    type BootstrapResult,
    ensureServer,
    skipReason,
} from "#lib/bootstrap"

const dirs: string[] = []
afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

/** A store nothing has ever leased, so "is a server up" is honestly no. */
function emptyStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-test-"))
    dirs.push(dir)
    return join(dir, "store.db")
}

const BASE: BootstrapOptions = {
    needsServer: true,
    platform: "darwin",
    // Every real environment variable this reads, explicitly absent. Inheriting `process.env` would
    // make these tests pass or fail depending on whether the suite happens to run under CI.
    env: {},
}

describe("when nothing should happen", () => {
    test("a command that wants no host is the first check", () => {
        expect(skipReason({ ...BASE, needsServer: false })).toBe("command-needs-no-server")
    })

    test("the flag and the env var are both escapes", () => {
        expect(skipReason({ ...BASE, disabled: true })).toBe("disabled-by-flag")
        expect(skipReason({ ...BASE, env: { [`${BRAND.envPrefix}NO_BOOTSTRAP`]: "1" } })).toBe(
            "disabled-by-env",
        )
    })

    test("the service does not bootstrap itself", () => {
        // Checked before the container test on purpose: this is the one case where being wrong
        // would be recursive, so the reason is worth reporting accurately.
        expect(skipReason({ ...BASE, env: { [`${BRAND.envPrefix}SERVICE`]: "1" } })).toBe(
            "is-the-service",
        )
    })

    test("a container is already supervised by whatever started it", () => {
        expect(skipReason({ ...BASE, env: { container: "podman" } })).toBe("in-container")
    })

    test("CI would leave a service behind for the next job", () => {
        expect(skipReason({ ...BASE, env: { CI: "true" } })).toBe("in-ci")
    })

    test("an ordinary interactive run is not skipped", () => {
        expect(skipReason(BASE)).toBeUndefined()
    })
})

describe("whether a server is already up", () => {
    /**
     * The witness is the lease table plus **pid liveness**, which is what every other surface uses.
     *
     * So a row left behind by a boot that died after claiming does not read as a running server,
     * and a `run` REPL holding one *is* a reason not to install a host underneath somebody. The two
     * halves are asserted as a pair, because either alone passes for the wrong reason: an empty
     * store proves the installer is reachable, and a leased store proves it is skipped.
     */
    test("an empty store installs; a live lease does not", async () => {
        let installs = 0
        const install = async (): Promise<BootstrapResult> => {
            installs += 1
            return { kind: "started", label: "x" }
        }

        const store = emptyStore()
        expect((await ensureServer({ ...BASE, store, install })).kind).toBe("started")
        expect(installs).toBe(1)

        // A lease held by a live pid that is not us. `process.ppid` is the shell that launched the
        // test runner: alive by construction, and excluded from `liveHosts`'s own-pid filter.
        const db = await SqliteStore.open({ path: store })
        await db.leases.claim({
            agentId: "milo",
            runtimeId: "rt_other",
            pid: process.ppid,
            mode: "daemon",
            now: new Date().toISOString(),
        })
        await db.close()

        expect((await ensureServer({ ...BASE, store, install })).kind).toBe("already")
        expect(installs).toBe(1)
    })

    test("a lease whose process is gone is not a running server", async () => {
        const store = emptyStore()
        const db = await SqliteStore.open({ path: store })
        await db.leases.claim({
            agentId: "milo",
            runtimeId: "rt_dead",
            // Never a live pid, and not reusable: a boot that fails *after* claiming leaves a row
            // seconds old with no process under it, and reading the heartbeat rather than probing
            // is how that comes to block every retry for ninety seconds.
            pid: 0x7fffffff,
            mode: "daemon",
            now: new Date().toISOString(),
        })
        await db.close()

        let installs = 0
        await ensureServer({
            ...BASE,
            store,
            install: async () => {
                installs += 1
                return { kind: "started", label: "x" }
            },
        })
        expect(installs).toBe(1)
    })
})

describe("when it cannot start what it would install", () => {
    test("Linux writes nothing and prints the command", async () => {
        let installs = 0
        const outcome = await ensureServer({
            ...BASE,
            platform: "linux",
            store: emptyStore(),
            install: async () => {
                installs += 1
                return { kind: "started", label: "x" } as BootstrapResult
            },
        })
        // Writing a unit and reporting a running server is the exact failure this phase exists to
        // remove, and `systemctl --user` is not driven from here — so on a platform whose manager
        // cannot start what it installs, the bootstrap prints and does nothing.
        expect(outcome).toEqual({ kind: "manual", lines: [`${BRAND.slug} daemon install`] })
        expect(installs).toBe(0)
    })
})

describe("when the install fails", () => {
    test("the failure is reported and never thrown", async () => {
        const outcome = await ensureServer({
            ...BASE,
            store: emptyStore(),
            install: () => {
                throw new Error("Bootstrap failed: 125: Domain does not support specified action")
            },
        })
        expect(outcome.kind).toBe("failed")
        if (outcome.kind === "failed") {
            expect(outcome.message).toContain("125")
            // The hint names the usual cause, because over SSH this is the ordinary outcome rather
            // than a fault: a LaunchAgent needs a logged-in desktop session.
            expect(outcome.hint).toContain("SSH")
        }
    })
})

describe("the one line", () => {
    test("every branch that did something names what to type next", () => {
        expect(announce({ kind: "started", label: "x" })).toContain("daemon uninstall")
        expect(announce({ kind: "manual", lines: ["a", "b"] })).toContain("a, then b")
        expect(announce({ kind: "failed", message: "m", hint: "h" })).toContain("hint: h")
    })

    test("the ordinary states say nothing at all", () => {
        // A line on every invocation is a line nobody reads, which is how the one that matters
        // gets missed.
        expect(announce({ kind: "already" })).toBeUndefined()
        expect(announce({ kind: "skipped", reason: "in-ci" })).toBeUndefined()
    })
})
