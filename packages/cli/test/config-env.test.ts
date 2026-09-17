/**
 * Whether a variable is set, from the agent's point of view.
 *
 * Every variable here is a probe name that cannot exist in the ambient environment. `bun test`
 * auto-loads the repo's own `.env`, so a test naming `MODEL_API_KEY` asserts against whatever this
 * machine happens to export — which is the contamination this repo has recorded as a test hazard and
 * then hit again as a *runtime* one. Two of these tests failed that way before the rename.
 *
 * The bug this covers: `ambientEnv` never adds the `.env` beside the manifest — it only *demotes* a
 * colliding cwd variable — so a token sitting next to the manifest read as unset. It showed up as an
 * editor row that still said `(not set)` immediately after somebody set it, and as `config list`
 * reporting a variable missing that plainly was not.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentEnv, describeOrigin, isSet, sourceOf } from "#lib/config-env"

function agent(envFile?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "config-env-"))
    writeFileSync(join(dir, "agent.yaml"), "id: x\n")
    if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile)
    return join(dir, "agent.yaml")
}

describe("agentEnv", () => {
    test("a variable in the .env beside the manifest counts as set", () => {
        const env = agentEnv(agent("CFG_ENV_PROBE=sk-live\n"))
        expect(isSet(env, "CFG_ENV_PROBE")).toBe(true)
        expect(env.CFG_ENV_PROBE).toBe("sk-live")
    })

    test("no .env at all is simply nothing set", () => {
        expect(isSet(agentEnv(agent()), "CFG_ENV_PROBE")).toBe(false)
    })

    test("an empty value counts as unset, because a load fails on it exactly as on absent", () => {
        expect(isSet(agentEnv(agent("CFG_ENV_PROBE=\n")), "CFG_ENV_PROBE")).toBe(false)
    })

    test("a comment is not a value", () => {
        expect(isSet(agentEnv(agent("# CFG_ENV_PROBE=disabled\n")), "CFG_ENV_PROBE")).toBe(false)
    })

    test("the real environment wins over the file", () => {
        // Core's precedence, unchanged: an operator's export has to beat a file, or a container cannot
        // configure the agent it runs.
        const path = agent("PATH_PROBE=from-file\n")
        const before = process.env.PATH_PROBE
        process.env.PATH_PROBE = "from-export"
        try {
            expect(agentEnv(path).PATH_PROBE).toBe("from-export")
        } finally {
            if (before === undefined) delete process.env.PATH_PROBE
            else process.env.PATH_PROBE = before
        }
    })

    test("an unreadable .env means nothing is known to be set, not that it is", () => {
        // Claiming a variable is present when the file cannot be read is the worse answer: the caller
        // would then not report the thing that is about to fail the load.
        const dir = mkdtempSync(join(tmpdir(), "config-env-"))
        writeFileSync(join(dir, "agent.yaml"), "id: x\n")
        // A directory where the file should be: readFileSync throws EISDIR.
        writeFileSync(join(dir, ".env"), "")
        expect(isSet(agentEnv(join(dir, "agent.yaml")), "ANYTHING")).toBe(false)
    })
})

/**
 * *Where* a value came from, which is a different question from whether it is set.
 *
 * Every layer is injected. Reading the real environment here would be the contamination this file's
 * header is about, and it would be worse for these tests than for the `isSet` ones above: the thing
 * under test is precedence between three sources, so a fourth arriving from the machine makes the
 * result meaningless rather than merely flaky.
 */
describe("sourceOf", () => {
    const AGENT = "/tmp/sourceof/agent"
    const CWD = "/tmp/sourceof/project"
    const manifest = join(AGENT, "agent.yaml")

    /** One `readDir` over a fixed two-directory world. */
    function layers(input: {
        readonly beside?: Record<string, string>
        readonly cwd?: Record<string, string>
    }) {
        return (dir: string): Record<string, string> =>
            dir === AGENT ? (input.beside ?? {}) : dir === CWD ? (input.cwd ?? {}) : {}
    }

    test("the .env beside the manifest is the unsurprising case, and says nothing", () => {
        const origin = sourceOf(manifest, "SRC_PROBE", {
            env: {},
            cwd: CWD,
            readDir: layers({ beside: { SRC_PROBE: "from-agent" } }),
        })
        expect(origin.kind).toBe("agent")
        expect(describeOrigin(origin)).toBeUndefined()
    })

    test("a real export with no file anywhere is the environment", () => {
        const origin = sourceOf(manifest, "SRC_PROBE", {
            env: { SRC_PROBE: "exported" },
            cwd: CWD,
            readDir: layers({}),
        })
        expect(origin.kind).toBe("export")
        expect(describeOrigin(origin)).toContain("not a .env")
    })

    test("an export beats the agent's own file, and the note is what makes that visible", () => {
        // The container case exactly: compose passes MODEL_ID as process environment, `init` wrote a
        // .env, and the file loses. Correct by decision, and previously silent.
        const origin = sourceOf(manifest, "SRC_PROBE", {
            env: { SRC_PROBE: "from-compose" },
            cwd: CWD,
            readDir: layers({ beside: { SRC_PROBE: "from-init" } }),
        })
        expect(origin.kind).toBe("export")
    })

    test("a cwd .env the agent also sets is demoted, so the agent's file wins", () => {
        // `ambientEnv` demotes only when both set it *and* the values match — which is what a
        // Bun-autoloaded cwd file looks like from inside the process.
        const origin = sourceOf(manifest, "SRC_PROBE", {
            env: { SRC_PROBE: "from-cwd" },
            cwd: CWD,
            readDir: layers({
                beside: { SRC_PROBE: "from-agent" },
                cwd: { SRC_PROBE: "from-cwd" },
            }),
        })
        expect(origin.kind).toBe("agent")
    })

    test("a cwd .env the agent does not set is indistinguishable from an export", () => {
        // Nothing is demoted, because the agent owns no such variable — so the value stays in
        // process.env and there is no evidence left saying which of the two put it there.
        const origin = sourceOf(manifest, "SRC_PROBE", {
            env: { SRC_PROBE: "from-cwd" },
            cwd: CWD,
            readDir: layers({ cwd: { SRC_PROBE: "from-cwd" } }),
        })
        expect(origin.kind).toBe("ambiguous")
        expect(describeOrigin(origin)).toContain("indistinguishable")
    })

    test("when the cwd *is* the agent's directory, that file is the agent's own", () => {
        // Not a special case for tidiness: `ambientEnv` skips the demotion entirely here, so
        // reporting "or ./.env" would be naming the same file twice as if it were two sources.
        const origin = sourceOf(join(CWD, "agent.yaml"), "SRC_PROBE", {
            env: { SRC_PROBE: "same-dir" },
            cwd: CWD,
            readDir: layers({ cwd: { SRC_PROBE: "same-dir" } }),
        })
        expect(origin.kind).toBe("export")
    })

    test("nothing anywhere is unset, and an empty value counts as nothing", () => {
        expect(
            sourceOf(manifest, "SRC_PROBE", { env: {}, cwd: CWD, readDir: layers({}) }).kind,
        ).toBe("unset")
        expect(
            sourceOf(manifest, "SRC_PROBE", {
                env: { SRC_PROBE: "" },
                cwd: CWD,
                readDir: layers({ beside: { SRC_PROBE: "" } }),
            }).kind,
        ).toBe("unset")
    })
})
