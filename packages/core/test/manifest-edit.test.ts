/**
 * The one writer, and the vocabulary both surfaces read it through.
 *
 * `prepareManifestEdit` is where the guarantee lives: place, check the schema, check the providers
 * resolve. It is pure, which is the point — the checks are the valuable half and they need nothing but
 * a string, so they can be asserted without a filesystem and a sync caller cannot skip them. Three
 * writers with three different guarantees is what this replaced.
 */

import { parse } from "yaml"
import {
    AGENT_SETTABLE_PATHS,
    BRAND,
    manifestValueAt,
    parseSettingValue,
    prepareManifestEdit,
    SETTINGS,
    setInSource,
    settingByPath,
    uncommentInSource,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

// `apiVersion` derived rather than written: it is brand-derived, so a literal here would be a string a
// rename has to find. Hard rule 3's reasoning applies to a fixture as much as to a source file.
const MANIFEST = `apiVersion: ${BRAND.apiVersion}
id: cfg
name: Cfg

model:
  main:
    # A comment that must survive every edit.
    id: deepseek-chat
    baseUrl: https://api.deepseek.com/v1
    temperature: 0.3

tools:
  dialect: nlt
  local:
    - now
  policy:
    mode: allow          # aligned, and it stays aligned
    allow: []

limits:
  maxSteps: 6

# ── channels — not configured ──────────────────────────
# Ask the agent to put itself on Telegram and it writes this.
# channels:
#   - type: telegram
#     id: tg
#     tokenEnv: TELEGRAM_BOT_TOKEN
#     allowFrom: ["@your-handle"]
# delivery:
#   default: tg
`

describe("prepareManifestEdit", () => {
    test("places a scalar and keeps every other byte", () => {
        const result = prepareManifestEdit(MANIFEST, { path: ["limits", "maxSteps"], value: 9 })
        expect(result.before).toBe(6)
        expect(result.reflowed).toBe(false)
        expect(result.next).toBe(MANIFEST.replace("maxSteps: 6", "maxSteps: 9"))
    })

    test("an aligned trailing comment keeps its column", () => {
        const result = prepareManifestEdit(MANIFEST, {
            path: ["tools", "policy", "mode"],
            value: "deny",
        })
        expect(result.next).toContain("mode: deny          # aligned, and it stays aligned")
    })

    test("a value the schema rejects throws and produces no text", () => {
        // The whole reason this is not three lines of `setInSource` plus a write: an invalid manifest is
        // not a failure that shows up now, it is one that shows up at the next boot — by which time the
        // change looks like it succeeded.
        expect(() =>
            prepareManifestEdit(MANIFEST, { path: ["limits", "maxSteps"], value: "lots" }),
        ).toThrow(/invalid/i)
    })

    test("a document the schema accepts and the runtime refuses is still refused", () => {
        // `resolveProviders` runs too. The map beside the deprecated scalar validates fine and then
        // fails to resolve — an agent that boots today and not tomorrow, reported as a success.
        const withScalar = MANIFEST.replace("  dialect: nlt", "  dialect: nlt\n  provider: system")
        expect(() =>
            prepareManifestEdit(withScalar, {
                path: ["tools", "providers"],
                value: { system: {} },
            }),
        ).toThrow()
    })

    test("a commented top-level block is uncommented in place, not appended", () => {
        // Measured before this existed: writing `channels` for the first time reflowed **98 lines** of a
        // generated manifest, indenting a section heading into the block above it.
        const result = prepareManifestEdit(MANIFEST, {
            path: ["channels"],
            value: [{ type: "telegram", id: "tg", tokenEnv: "TELEGRAM_BOT_TOKEN" }],
        })
        expect(result.reflowed).toBe(false)
        expect(result.next).toContain("\nchannels:\n  - type: telegram")
        // The commented children went with the opener; `# delivery:` is a different key and stays.
        expect(result.next).not.toContain("#     tokenEnv: TELEGRAM_BOT_TOKEN")
        expect(result.next).toContain("# delivery:")
        // And the prose above it is the author's.
        expect(result.next).toContain("# Ask the agent to put itself on Telegram")
    })

    test("an explicit fallback beats the generic uncomment", () => {
        const result = prepareManifestEdit(MANIFEST, {
            path: ["channels"],
            value: [{ type: "telegram", id: "tg" }],
            fallback: () => `${MANIFEST}\n# placed by the caller\nchannels: []\n`,
        })
        expect(result.next).toContain("# placed by the caller")
    })

    test("reflowed is reported rather than swallowed", () => {
        // A top-level key with no parent and no commented line to uncomment: the round-trip is the only
        // way to place it. The result is valid and its comments have moved, which a person should hear
        // from the command rather than find later in a diff.
        //
        // `delivery` looked like the obvious case and is not — the generated manifest ships it commented
        // *inside* the channels block, so the fallback places it in the file with no reflow at all. Which
        // is the fallback working, and is why this fixture has no comments to find.
        const bare = MANIFEST.slice(0, MANIFEST.indexOf("# ── channels"))
        const result = prepareManifestEdit(bare, { path: ["delivery"], value: { default: "tg" } })
        expect(result.reflowed).toBe(true)
        expect(manifestValueAt(result.next, ["delivery", "default"])).toBe("tg")
    })
})

describe("uncommentInSource", () => {
    test("returns undefined when there is no commented line to replace", () => {
        expect(uncommentInSource(MANIFEST, "phases", {})).toBeUndefined()
    })

    test("a phase heading directly above goes too", () => {
        // "# Phase 5 — skills" over a live block reads as a phase that has not shipped.
        const source = "id: x\n\n# Phase 5 — skills\n# skills:\n#   dir: ./skills\n"
        const next = uncommentInSource(source, "skills", { dir: "./skills" })
        expect(next).not.toContain("Phase 5")
        expect(next).toContain("skills:\n  dir: ./skills")
    })

    test("prose above the block is left alone", () => {
        const next = uncommentInSource(MANIFEST, "channels", [{ type: "telegram" }]) ?? ""
        expect(next).toContain("# ── channels — not configured ──")
    })
})

describe("parseSettingValue", () => {
    test("scalars, lists and maps", () => {
        expect(parseSettingValue("12")).toBe(12)
        expect(parseSettingValue("nlt")).toBe("nlt")
        expect(parseSettingValue("true")).toBe(true)
        expect(parseSettingValue('["a", "b"]')).toEqual(["a", "b"])
        expect(parseSettingValue("{system: {}}")).toEqual({ system: {} })
        // Quoted stays a string, which is how a version-like value avoids becoming a number.
        expect(parseSettingValue('"0.3"')).toBe("0.3")
    })

    test("something unreadable is refused rather than guessed at", () => {
        // Guessing is how `tools.pinned: "exec"` becomes a one-character tool list.
        expect(() => parseSettingValue("{unclosed: ")).toThrow(/Cannot read/)
    })
})

describe("the settings catalogue", () => {
    test("no path appears twice", () => {
        const paths = SETTINGS.map((entry) => entry.path)
        expect(new Set(paths).size).toBe(paths.length)
    })

    test("every agent-listed path is addressable by the source editor", () => {
        // A row the agent may set and the writer cannot place would fall through to the round-trip on
        // every call — correct, and reflowing somebody's manifest each time.
        for (const path of AGENT_SETTABLE_PATHS) {
            expect(path).not.toContain("[")
            expect(path).not.toContain("<")
        }
    })

    test("a person-only row is not listed to the agent, and a floored one is", () => {
        // Different reasons. `tools.policy.deny` stays listed so the agent's refusal names the real
        // cause instead of "not a setting" — an ordering bug that already happened once with
        // `onMutate`. `server.host` is not listed at all, because there is no refusal worth reaching.
        expect(settingByPath("tools.policy.deny")?.agentListed).toBe(true)
        expect(settingByPath("server.host")?.agentListed).toBe(false)
        expect(settingByPath("channels[].allowFrom")?.via).toBe("config allow")
    })

    test("only the two guard-weakening edits ask a person first", () => {
        const confirmed = SETTINGS.filter((entry) => entry.confirm !== undefined).map((e) => e.path)
        expect(confirmed).toEqual(["tools.policy.deny", "tools.untrusted.onMutate"])
    })

    test("setInSource is what places an agent-settable scalar", () => {
        // Guards the move: the editor is core's now, and the tool imports it from here.
        expect(setInSource("tools:\n  dialect: nlt\n", ["tools", "dialect"], "native")).toBe(
            "tools:\n  dialect: native\n",
        )
    })
})

describe("a rendering that would not parse", () => {
    test("a value starting with a YAML indicator is quoted, not written bare", () => {
        // `@` is a reserved indicator, so `- @moeen_m` is invalid YAML. It was in `renderScalar`'s
        // permitted set from Phase 3.6 and stayed invisible until `allowFrom` became the first field
        // whose values start with it — at which point `config allow` wrote a manifest that would not
        // load and reported success.
        const source = "channels:\n  - id: tg\n"
        const next =
            setInSource(source, ["channels"], [{ id: "tg", allowFrom: ["@moeen_m"] }]) ?? ""
        expect(next).toContain('- "@moeen_m"')
        expect(next).not.toContain("- @moeen_m")
    })

    test("the writer refuses a result that is not valid YAML at all", () => {
        // The structural half, and the more important one. `toJS()` on a broken document still returns
        // an object, so the schema check passed on a file the runtime cannot read. Any future rendering
        // defect now fails here instead of at somebody's next boot.
        expect(() =>
            // A path `setInSource` cannot place, so the caller's fallback is what runs.
            prepareManifestEdit(MANIFEST, {
                path: ["nowhere", "at", "all"],
                value: 1,
                fallback: () => "id: x\n  bad: indentation\n\tand a tab\n",
            }),
        ).toThrow(/not valid YAML/)
    })

    test("an unquoted-safe value is still written bare, so files stay readable", () => {
        // The fix must not quote everything: `./skills` and `127.0.0.1` are the common cases.
        expect(setInSource("skills:\n  dir: x\n", ["skills", "dir"], "./skills")).toContain(
            "dir: ./skills",
        )
        expect(setInSource("server:\n  host: x\n", ["server", "host"], "127.0.0.1")).toContain(
            "host: 127.0.0.1",
        )
    })

    test("a string that YAML would read back as something else is quoted", () => {
        // The character classes decide whether text can be written bare; they say nothing about what
        // it comes back **as**. `"1"` passes both and parses as the number 1 — and a Telegram chat
        // id is exactly that shape, so the first schedule delivering to one was refused with
        // `schedules.0.deliver: Invalid input`, a schema error pointing nowhere near the renderer.
        const written = (value: unknown): string =>
            setInSource(
                "delivery:\n  targets: {}\n  default: x\n",
                ["delivery", "default"],
                value,
            ) ?? ""
        expect(written("1")).toContain('default: "1"')
        expect(written("true")).toContain('default: "true"')
        expect(written("null")).toContain('default: "null"')
        expect(written("0x10")).toContain('default: "0x10"')

        // The property, rather than the four cases: whatever is written must read back identical.
        for (const value of ["1", "true", "null", "0x10", "tg", "./skills", "127.0.0.1", "no"]) {
            const source = written(value)
            expect(parse(source).delivery.default).toBe(value)
        }
    })
})
