/**
 * The two managers, driven through a fake `Exec` and a real temporary directory.
 *
 * Thin by design — every decision is in `daemon-plan.ts` and every string in `launchd.ts` and
 * `systemd.ts`, all pure — so what is left to test here is the part that talks to the outside: which
 * commands run, in what order, and what is read from the filesystem rather than from the manager.
 *
 * **This file exists because of a defect the tests could not have caught.** `labels()` read
 * `launchctl list` alone, and a *disabled* job is simply absent from that output — which is exactly
 * the unit whose retirement matters, since its `disable` row persists across boots and no verb
 * deletes it. A bare `daemon install` on the one machine that had two of them found nothing to
 * retire and reported success. Found by listing `~/Library/LaunchAgents` during a live run; nothing
 * here or anywhere else was looking.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@dispach/core"
import type { ServicePlan } from "#lib/launchd"
import { type Exec, type ExecResult, managerCanStart, resolveServiceManager } from "#lib/service"

const homes: string[] = []
afterEach(() => {
    while (homes.length > 0) {
        const home = homes.pop()
        if (home !== undefined) rmSync(home, { recursive: true, force: true })
    }
})

/** A HOME with these LaunchAgent plists already in it. */
function home(plists: readonly string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), "service-test-"))
    homes.push(dir)
    const agents = join(dir, "Library", "LaunchAgents")
    mkdirSync(agents, { recursive: true })
    for (const name of plists) writeFileSync(join(agents, `${name}.plist`), "<plist/>")
    return dir
}

/**
 * Records every command, and models the one launchd behaviour `install` depends on.
 *
 * `print` answers **not found until a `bootstrap` has run, and found afterwards** — which is not
 * embellishment: `install` waits for a pending `bootout` by polling `print`, then verifies the job
 * really loaded by asking again. A fake that always said "found" would hang the settle loop for its
 * whole budget; one that always said "not found" makes every install throw. The second happened
 * while writing this file, which is a decent sign the real sequence is worth modelling.
 */
function recorder(listed: readonly string[] = []): { exec: Exec; calls: string[] } {
    const calls: string[] = []
    let loaded = false
    const exec: Exec = (command, args): ExecResult => {
        calls.push(`${command} ${args.join(" ")}`)
        if (command !== "launchctl") return { code: 0, stdout: "", stderr: "" }
        if (args[0] === "list") {
            return {
                code: 0,
                stdout: listed.map((label) => `-\t0\t${label}`).join("\n"),
                stderr: "",
            }
        }
        if (args[0] === "bootstrap") {
            loaded = true
            return { code: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "bootout") {
            loaded = false
            return { code: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "print") {
            return loaded
                ? { code: 0, stdout: "pid = 4711\nruns = 1\n", stderr: "" }
                : { code: 1, stdout: "", stderr: "Could not find service" }
        }
        return { code: 0, stdout: "", stderr: "" }
    }
    return { exec, calls }
}

const PLAN = (label: string, dir: string): ServicePlan => ({
    label,
    programArguments: ["/usr/bin/node", "/opt/cli/index.js", "serve"],
    workingDirectory: dir,
    stdoutPath: join(dir, "logs", "server", "out.log"),
    stderrPath: join(dir, "logs", "server", "err.log"),
    environment: { HOME: dir, PATH: "/usr/bin" },
    provenance: ["test"],
})

describe("launchd labels", () => {
    test("a disabled unit is found on disk even though launchctl list omits it", () => {
        // The defect, as a test. `launchctl list` shows only *loaded* jobs, and `disable` persists
        // across boots — so the unit most in need of retirement is the one the old implementation
        // could not see.
        const dir = home(["brand.agent.milo", "brand.agent.m1l0"])
        const { exec } = recorder([])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec,
        })
        expect(manager.labels("brand.agent.")).toEqual(["brand.agent.m1l0", "brand.agent.milo"])
    })

    test("a loaded unit with no plist on disk is found too", () => {
        // The other direction, and the reason this is a union rather than a swap: the directory is
        // authoritative for "a definition exists" and the list for "it is loaded".
        const dir = home([])
        const { exec } = recorder(["brand.server"])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec,
        })
        expect(manager.labels("brand.")).toEqual(["brand.server"])
    })

    test("labels are deduplicated when a unit is both", () => {
        const dir = home(["brand.server"])
        const { exec } = recorder(["brand.server"])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec,
        })
        expect(manager.labels("brand.")).toEqual(["brand.server"])
    })
})

describe("retiring a unit clears its disable row", () => {
    test("uninstall is bootout, then enable, then remove — in that order", () => {
        const dir = home(["brand.agent.milo"])
        const { exec, calls } = recorder([])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec,
        })
        manager.uninstall("brand.agent.milo")

        // The `enable` is the whole point and is easy to drop as redundant: no launchctl verb
        // deletes a disable row, so a label left disabled makes any future job with that name
        // install cleanly, report success and silently never start.
        const verbs = calls.filter((call) => call.startsWith("launchctl"))
        expect(verbs[0]).toContain("bootout")
        expect(verbs[1]).toContain("enable")
    })

    test("install enables before it bootstraps, for the same reason", () => {
        const dir = home([])
        const { exec, calls } = recorder([])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec,
        })
        manager.install(PLAN("brand.server", dir))

        const order = calls.join("\n")
        expect(order.indexOf("enable")).toBeLessThan(order.indexOf("bootstrap"))
    })
})

describe("install reports a job that did not load", () => {
    test("a bootstrap that succeeds and loads nothing is a failure, not a success", () => {
        /**
         * The live failure, as a test.
         *
         * Reinstalling over a **running** server: `bootout` returned 0, the immediate `bootstrap`
         * also returned 0, and afterwards `launchctl print` could not find the service at all —
         * while the command printed "service installed" and four tidy rows. launchd's own word for
         * this is code 37, which it does not always bother to produce.
         *
         * The fake below is that exact liar: every verb succeeds and nothing is ever loaded. It
         * needs no `bootout` race to reproduce, which is the point of asserting the *check* rather
         * than the timing.
         */
        const dir = home([])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            /**
             * The liar: every verb reports success and `print` never finds the job.
             *
             * An all-failing fake does not reproduce this — `bootstrap` would throw on its own exit
             * code, which is the case that already worked. What had to be caught is the one where
             * launchd says yes and means no.
             */
            exec: (_command, args) =>
                args[0] === "print"
                    ? { code: 1, stdout: "", stderr: "Could not find service" }
                    : { code: 0, stdout: "", stderr: "" },
        })
        expect(() => manager.install(PLAN("brand.server", dir))).toThrow(/did not load it/)
    })
})

describe("systemd writes a unit and refuses to drive it", () => {
    const options = (dir: string) => ({
        home: dir,
        uid: 1000,
        envPrefix: BRAND.envPrefix,
        exec: recorder().exec,
        env: { USER: "ada", XDG_CONFIG_HOME: join(dir, ".config") },
    })

    test("install writes the file and state reports no liveness", () => {
        const dir = home([])
        const manager = resolveServiceManager("linux", options(dir))
        manager.install(PLAN("brand.server", dir))

        const state = manager.state("brand.server")
        expect(state.installed).toBe(true)
        // The load-bearing field. Without it a caller reads `installed` as "running" and reports a
        // written file as a live server.
        expect(state.liveness).toBe(false)
        expect(manager.state("brand.other").installed).toBe(false)
    })

    test("every lifecycle verb refuses with the command to run", () => {
        const dir = home([])
        const manager = resolveServiceManager("linux", options(dir))
        for (const verb of ["start", "stop", "restart"] as const) {
            expect(() => manager[verb]("brand.server")).toThrow(/systemctl --user/)
        }
    })

    test("the follow-up and the caution are both present", () => {
        const dir = home([])
        const manager = resolveServiceManager("linux", options(dir))
        expect(manager.followUp("brand.server")[1]).toContain("enable --now")
        // `loginctl` answered 0 with no `Linger=yes`, so the warning stands — and the direction
        // matters: a failing or missing `loginctl` must not silently reassure somebody that their
        // service survives a logout.
        expect(manager.caution()).toContain("enable-linger ada")
    })

    test("lingering already enabled says nothing", () => {
        const dir = home([])
        const manager = resolveServiceManager("linux", {
            ...options(dir),
            exec: () => ({ code: 0, stdout: "Linger=yes\n", stderr: "" }),
        })
        expect(manager.caution()).toBeUndefined()
    })

    test("launchd has no follow-up and no caution", () => {
        const dir = home([])
        const manager = resolveServiceManager("darwin", {
            home: dir,
            uid: 501,
            envPrefix: BRAND.envPrefix,
            exec: recorder().exec,
        })
        // `install` bootstraps the job itself, so there is nothing left for anybody to run — and a
        // LaunchAgent's survival across a login is `RunAtLoad`, which the plist carries.
        expect(manager.followUp("brand.server")).toEqual([])
        expect(manager.caution()).toBeUndefined()
    })
})

describe("which platforms can start what they install", () => {
    test("only darwin, and the bootstrap reads this rather than testing the platform", () => {
        expect(managerCanStart("darwin")).toBe(true)
        // Linux writes a unit it does not enable, so a bootstrap there must print the command
        // instead of reporting a running server.
        expect(managerCanStart("linux")).toBe(false)
        expect(managerCanStart("win32")).toBe(false)
    })

    test("a platform with no manager refuses, naming the gap", () => {
        expect(() =>
            resolveServiceManager("win32", { home: "/h", uid: 0, envPrefix: BRAND.envPrefix }),
        ).toThrow(/win32/)
    })
})
