/**
 * The agent reading and changing its own configuration.
 *
 * The properties that matter here are the ones that decide whether this tool is a convenience or a
 * liability: nothing is written unless it still validates, comments survive, and the two edits whose
 * only purpose is to disable a check are refused whatever the policy says.
 */

import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setInSource, toolContext } from "@dispach/core"
import {
    CONFIG_READ_SPEC,
    CONFIG_SET_SPEC,
    configReadHandler,
    configSetHandler,
    parseValue,
} from "../src/config.ts"

const MANIFEST = `apiVersion: dispach/v1
id: cfg
name: Cfg

model:
  main:
    # The endpoint, and a comment that must survive every edit.
    id: deepseek-chat
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: MODEL_API_KEY
    temperature: 0.3

tools:
  dialect: nlt
  local:
    - now
  policy:
    mode: allow
    allow: []
    deny:
      - "exec(rm *)"
  untrusted:
    onMutate: refuse
`

function fixture(): {
    dir: string
    file: string
    read: ReturnType<typeof configReadHandler>
    set: ReturnType<typeof configSetHandler>
} {
    const dir = mkdtempSync(join(tmpdir(), "config-test-"))
    const file = join(dir, "agent.yaml")
    writeFileSync(file, MANIFEST)
    const options = { agentDir: dir, file }
    return { dir, file, read: configReadHandler(options), set: configSetHandler(options) }
}

// ─── the specs ───────────────────────────────────────────────────────────────────────────

test("reading config is not mutating and writing it is", () => {
    expect(CONFIG_READ_SPEC.mutating).toBe(false)
    expect(CONFIG_SET_SPEC.mutating).toBe(true)
})

test("both are trusted — the manifest is the runtime's own file", () => {
    // Fencing it as untrusted would put a warning about strangers around the agent's own settings.
    expect(CONFIG_READ_SPEC.trust).toBe("trusted")
    expect(CONFIG_SET_SPEC.trust).toBe("trusted")
})

test("a rule can address the setting, not just the tool", () => {
    // `deny: ["config_set(tools.policy*)"]` is expressible because the match argument is the manifest
    // path. Against `file_write` the only available rule is "may not write agent.yaml at all".
    expect(CONFIG_SET_SPEC.policyArg).toBe("path")
})

// ─── reading ─────────────────────────────────────────────────────────────────────────────

test("reading with no path returns the file and what can be changed in it", async () => {
    const { read, file } = fixture()
    const output = await read({}, toolContext({}))
    expect(output).toContain(file)
    expect(output).toContain("deepseek-chat")
    // This is the "knows its own system" half: the settable paths, each with what it means.
    expect(output).toContain("tools.pinned")
    expect(output).toContain("tools.policy.allow")
    expect(output).toContain("takes effect when the agent next starts")
})

test("reading one path returns just that value", async () => {
    const { read } = fixture()
    expect(await read({ path: "model.main.id" }, toolContext({}))).toContain("deepseek-chat")
})

test("reading an unset path says it can be set rather than failing", async () => {
    const { read } = fixture()
    const output = await read({ path: "tools.pinned" }, toolContext({}))
    expect(output).toContain("is not set")
})

// ─── writing ─────────────────────────────────────────────────────────────────────────────

test("a set applies, reports both values, and says when it takes effect", async () => {
    const { set, file } = fixture()
    const output = await set({ path: "model.main.temperature", value: "0" }, toolContext({}))
    expect(output).toContain("It was: 0.3")
    expect(output).toContain("It is now: 0")
    // The model must not then try the new setting in the same conversation.
    expect(output).toContain("next starts")
    expect(readFileSync(file, "utf8")).toContain("temperature: 0")
})

test("comments survive an edit", async () => {
    const { set, file } = fixture()
    await set({ path: "model.main.temperature", value: "0" }, toolContext({}))
    // The manifest is the file a person reads to understand their agent, and its comments are most of
    // that. A regenerated file would lose them; an edited document does not.
    expect(readFileSync(file, "utf8")).toContain("a comment that must survive every edit")
})

test("a list is written as a list", async () => {
    const { set, file } = fixture()
    await set({ path: "tools.pinned", value: '["exec", "file_read"]' }, toolContext({}))
    const written = readFileSync(file, "utf8")
    expect(written).toContain("- exec")
    expect(written).toContain("- file_read")
})

test("enabling a tool and permitting it is exactly what this is for", async () => {
    const { set, file } = fixture()
    await set({ path: "tools.providers", value: '{"system": {}}' }, toolContext({}))
    await set({ path: "tools.pinned", value: '["exec"]' }, toolContext({}))
    await set({ path: "tools.policy.allow", value: '["exec"]' }, toolContext({}))
    const written = readFileSync(file, "utf8")
    expect(written).toContain("system")
    // Written as plain YAML rather than quoted, which is the same value and the form a person would
    // have typed.
    expect(written).toContain("- exec")
})

test("a second provider is added beside the first, not instead of it", async () => {
    // The whole point of the map: an agent that runs commands and reads the web is one agent, and
    // the scalar this replaced made asking for both impossible.
    const { set, file } = fixture()
    await set({ path: "tools.providers", value: '{"system": {}}' }, toolContext({}))
    await set(
        {
            path: "tools.providers",
            value: '{"system": {}, "web": {"backend": "tavily", "apiKeyEnv": "TAVILY_API_KEY"}}',
        },
        toolContext({}),
    )
    const written = readFileSync(file, "utf8")
    expect(written).toContain("system")
    expect(written).toContain("tavily")
})

test("a writeRoots hidden inside a providers value is refused", async () => {
    // The floor moved with the field. `writeRoots` used to live under tools.providerConfig, which
    // was a path floor; it now lives inside a value the agent is allowed to write, so the floor has
    // to look inside the value or it is a floor with a new way round it.
    const { set, file } = fixture()
    const before = readFileSync(file, "utf8")
    await expect(
        set(
            { path: "tools.providers", value: '{"system": {"writeRoots": ["~"]}}' },
            toolContext({}),
        ),
    ).rejects.toThrow(/widening where you may write is not yours to do/)
    await expect(
        set({ path: "tools.providers.system.writeRoots", value: '["~"]' }, toolContext({})),
    ).rejects.toThrow(/widening where you may write is not yours to do/)
    expect(readFileSync(file, "utf8")).toBe(before)
})

test("writing the map into a manifest that still has the scalar is refused before the write", async () => {
    // The schema accepts both fields; the runtime refuses the pair. Without this check config_set
    // would report success on an edit that stops the agent booting — which is the one failure this
    // tool's validation exists to prevent.
    const { set, file } = fixture()
    await set({ path: "tools.providers", value: '{"web": {}}' }, toolContext({}))
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`, "utf8")
    const doc = readFileSync(file, "utf8").replace("tools:", "tools:\n  provider: system")
    writeFileSync(file, doc, "utf8")
    const before = readFileSync(file, "utf8")
    await expect(
        set({ path: "tools.providers", value: '{"system": {}}' }, toolContext({})),
    ).rejects.toThrow(/does not load/)
    expect(readFileSync(file, "utf8")).toBe(before)
})

test("a value that would not validate is refused and nothing is written", async () => {
    const { set, file } = fixture()
    const before = readFileSync(file, "utf8")
    await expect(
        set({ path: "model.main.temperature", value: "hot" }, toolContext({})),
    ).rejects.toThrow(/does not load/)
    // An invalid manifest is not a failure that shows up now — it shows up at the next boot, by which
    // time the change looks like it succeeded.
    expect(readFileSync(file, "utf8")).toBe(before)
})

test("a path outside the settable list is refused, naming the list", async () => {
    const { set } = fixture()
    await expect(set({ path: "id", value: "hijacked" }, toolContext({}))).rejects.toThrow(
        /is not a setting config_set will change/,
    )
})

test("an unreadable value is refused rather than guessed at", async () => {
    const { set } = fixture()
    // Guessing is how `tools.pinned: "exec"` becomes a list of single characters.
    await expect(
        set({ path: "tools.pinned", value: "[unclosed" }, toolContext({})),
    ).rejects.toThrow(/could not be read/)
})

// ─── the floor ───────────────────────────────────────────────────────────────────────────

test("the deny rules cannot be replaced from inside a conversation", async () => {
    const { set, file } = fixture()
    await expect(set({ path: "tools.policy.deny", value: "[]" }, toolContext({}))).rejects.toThrow(
        /cannot be changed from inside a conversation/,
    )
    // A guard the agent can switch off on request is not a guard.
    expect(readFileSync(file, "utf8")).toContain('- "exec(rm *)"')
})

test("the write gate cannot be turned off, but the field is still settable", async () => {
    const { set, file } = fixture()

    // The floor is on the *value*, not the field. It was briefly on the field by accident — the
    // settable check ran first, so `confirm` was refused as unsettable and `allow` was refused for
    // the wrong reason. A guard that fires for the wrong reason is a guard nobody can predict.
    await expect(
        set({ path: "tools.untrusted.onMutate", value: "allow" }, toolContext({})),
    ).rejects.toThrow(/cannot be changed from inside a conversation/)
    expect(readFileSync(file, "utf8")).toContain("onMutate: refuse")

    // `confirm` asks a person instead of refusing outright — stricter in the sense that matters, and
    // a reasonable thing to be asked for.
    await set({ path: "tools.untrusted.onMutate", value: "confirm" }, toolContext({}))
    expect(readFileSync(file, "utf8")).toContain("onMutate: confirm")
})

test("everything in the direction of granting still works", async () => {
    const { set } = fixture()
    // The floor is two edits, both "stop checking". Adding powers is what a person asks for.
    await set({ path: "tools.policy.allow", value: '["exec"]' }, toolContext({}))
    await set({ path: "tools.policy.mode", value: "allow" }, toolContext({}))
    await set({ path: "limits.maxSteps", value: "12" }, toolContext({}))
})

// ─── value parsing ───────────────────────────────────────────────────────────────────────

test("scalars, lists and quoted strings all read as themselves", () => {
    expect(parseValue("12")).toBe(12)
    expect(parseValue("system")).toBe("system")
    expect(parseValue("true")).toBe(true)
    expect(parseValue('["a", "b"]')).toEqual(["a", "b"])
    expect(parseValue('"0.3"')).toBe("0.3")
})

// ─── editing the source text rather than round-tripping the document ──────────────────────

test("an edit changes only the lines it means to", () => {
    // The measurement that produced this module: `parseDocument` → `setIn` → `String(doc)` keeps every
    // comment and moves half of them, because a comment block between two top-level keys belongs to
    // the *end of the first* as far as the parser is concerned. One change, a thirty-line diff.
    const source = [
        "# ── model ──",
        "model:",
        "  main:",
        "    id: deepseek-chat",
        "    temperature: 0.3",
        "",
        "# ── tools ──",
        "tools:",
        "  local:",
        "    - now           # aligned on purpose",
        "",
        "# ── limits ──",
        "limits:",
        "  maxSteps: 6",
        "",
    ].join("\n")

    const next = setInSource(source, ["limits", "maxSteps"], 12)
    expect(next).toBeDefined()
    const changed = source
        .split("\n")
        .map((line, i) => [line, (next ?? "").split("\n")[i]])
        .filter(([before, after]) => before !== after)
    expect(changed).toEqual([["  maxSteps: 6", "  maxSteps: 12"]])
})

test("a trailing comment survives the value it annotates", () => {
    const source = "tools:\n  dialect: nlt   # never auto-detected\n"
    expect(setInSource(source, ["tools", "dialect"], "native")).toBe(
        "tools:\n  dialect: native   # never auto-detected\n",
    )
})

test("a missing intermediate is created, in the right block", () => {
    // The first call anyone makes: `providerConfig` is commented out in every generated manifest, so
    // `tools.providerConfig.writeRoots` has a missing middle level. Giving up here is what sent the
    // whole file through the reflowing fallback.
    const source = [
        "tools:",
        "  dialect: nlt",
        "",
        "# ── limits ──",
        "limits:",
        "  maxSteps: 6",
        "",
    ].join("\n")
    const next = setInSource(source, ["tools", "providerConfig", "writeRoots"], ["/tmp/x"])
    expect(next).toBe(
        [
            "tools:",
            "  dialect: nlt",
            "  providerConfig:",
            "    writeRoots:",
            "      - /tmp/x",
            "",
            "# ── limits ──",
            "limits:",
            "  maxSteps: 6",
            "",
        ].join("\n"),
    )
})

test("a new key lands inside its parent, not at the end of the file", () => {
    const source = ["tools:", "  dialect: nlt", "", "limits:", "  maxSteps: 6", ""].join("\n")
    const next = setInSource(source, ["tools", "pinned"], ["exec"]) ?? ""
    // Appended after `dialect`, before the blank line and `limits:` — anywhere else and `pinned` would
    // belong to a different section or to nothing.
    expect(next.indexOf("pinned")).toBeLessThan(next.indexOf("limits:"))
})

test("a list replaces the whole block, not just its first line", () => {
    const source = "tools:\n  pinned:\n    - a\n    - b\n    - c\n"
    expect(setInSource(source, ["tools", "pinned"], ["x"])).toBe("tools:\n  pinned:\n    - x\n")
})

test("a four-space file keeps four-space indentation", () => {
    // The child indent is read from the file rather than assumed, or an edit would mix the two.
    const source = "tools:\n    dialect: nlt\n"
    expect(setInSource(source, ["tools", "dialect"], "native")).toBe(
        "tools:\n    dialect: native\n",
    )
})

test("a path whose top level is absent gives up rather than guessing", () => {
    // `undefined` is not a failure — it says this editor is too simple for the file in front of it, and
    // the caller falls back to the correct-but-reflowing round-trip.
    expect(setInSource("tools:\n  dialect: nlt\n", ["nowhere", "at", "all"], 1)).toBeUndefined()
})

test("a hash inside a quoted value is not mistaken for a comment", () => {
    // `deny: ["exec(rm #)"]` is a rule, not an annotation. Truncating it there would silently change
    // what the rule matches.
    const source = 'tools:\n  dialect: "a # b"\n'
    expect(setInSource(source, ["tools", "dialect"], "native")).toBe("tools:\n  dialect: native\n")
})

test("the summary fits the observation budget, which the whole file did not", async () => {
    const { read } = fixture()
    const output = await read({}, toolContext({}))
    // Returning the manifest measured 2,766 tokens against a 2,000-token budget, so every call was
    // middle-cut and a real model read it three times in one turn hunting for what the cut removed —
    // eight thousand output tokens to change one line.
    expect(output.length).toBeLessThan(4_000)
    // What it needs is what can change and what it is now.
    expect(output).toContain("tools.policy.allow = []")
    expect(output).toContain("tools.local = [now]")
    expect(output).toContain("model.main.temperature = 0.3")
})

test("the agent cannot widen where it may write", async () => {
    const { set } = fixture()
    // From a real transcript: asked to create a file, the agent enabled `file_write`, granted itself
    // `/Users/moeen` as a write root, and wrote there — announcing it afterwards as "that last part is
    // broad". Enabling a tool answers "what may I do"; a write root answers "where", and that one is
    // the person's by definition.
    await expect(
        set(
            { path: "tools.providerConfig.writeRoots", value: '["/Users/moeen"]' },
            toolContext({}),
        ),
    ).rejects.toThrow(/cannot be changed from inside a conversation/)
})

test("a floored path is refused with its reason, not as an unknown setting", async () => {
    const { set } = fixture()
    // The floor is checked before the settable list. Reversed, a floored path — which is deliberately
    // absent from that list — comes back as "not a setting" and the reason that matters never prints.
    // That ordering bug already happened once, with onMutate.
    const failure = await Promise.resolve(
        set({ path: "tools.providerConfig.writeRoots", value: "[]" }, toolContext({})),
    ).catch((error: unknown) => error)
    expect(String(failure)).toContain("not yours to do")
})

// ─── channels and the server: what the agent may set up for itself ───────────────────────

test("the agent can put itself on Telegram, and the YAML is a real sequence of maps", async () => {
    // An array of objects is the third shape this renderer met. The first two — a scalar and a map
    // — each shipped writing the literal text `[object Object]` before being handled, and the
    // schema then rejected the result with a message pointing nowhere near the cause.
    const { set, file } = fixture()
    await set(
        {
            path: "channels",
            value: '[{"type":"telegram","id":"tg","tokenEnv":"TELEGRAM_BOT_TOKEN","mode":"longpoll"}]',
        },
        toolContext({}),
    )
    const written = readFileSync(file, "utf8")
    expect(written).toContain("channels:\n  - type: telegram\n    id: tg\n")
    expect(written).not.toContain("[object Object]")
})

test("writing a channel names the variable only a person can fill in", async () => {
    // Otherwise the flow has a trap: the agent reports success, asks for a restart, and the restart
    // fails to load because the factory reads that variable at boot. `.env` is a protected path, so
    // the agent cannot fix it either.
    const { set } = fixture()
    const observation = String(
        await set(
            { path: "channels", value: '[{"type":"telegram","id":"tg","tokenEnv":"TG_TOKEN"}]' },
            toolContext({}),
        ),
    )
    expect(observation).toContain("TG_TOKEN")
    expect(observation).toContain("will NOT start")
})

test("a change that cannot introduce a secret carries no note about one", async () => {
    const { set } = fixture()
    const observation = String(await set({ path: "limits.maxSteps", value: "8" }, toolContext({})))
    expect(observation).not.toContain("will NOT start")
})

test("allowFrom is refused — the inbound gate is not the agent's to widen", async () => {
    // The escalation this closes is direct: an agent that could widen its own allowlist could be
    // talked into widening it by the very message it is reading.
    const { set } = fixture()
    await expect(
        set({ path: "channels[0].allowFrom", value: '["@attacker"]' }, toolContext({})),
    ).rejects.toThrow(/not yours to decide/)
})

test("allowFrom hidden inside a channels write is refused too", async () => {
    // Same two shapes as writeRoots: the path itself, and the key riding along in a value.
    const { set } = fixture()
    await expect(
        set(
            {
                path: "channels",
                value: '[{"type":"telegram","id":"tg","allowFrom":["@attacker"]}]',
            },
            toolContext({}),
        ),
    ).rejects.toThrow(/not yours to decide/)
})

test("the agent may enable the API on loopback but not move it", async () => {
    const { set, file } = fixture()
    await set({ path: "server.enabled", value: "true" }, toolContext({}))
    await set({ path: "server.port", value: "7500" }, toolContext({}))
    expect(readFileSync(file, "utf8")).toContain("enabled: true")

    // Where it listens and what authenticates it stay the person's — the same rule as writeRoots.
    await expect(set({ path: "server.host", value: "0.0.0.0" }, toolContext({}))).rejects.toThrow(
        /not yours to decide/,
    )
    await expect(set({ path: "server.tokenEnv", value: "NOPE" }, toolContext({}))).rejects.toThrow(
        /not yours to decide/,
    )
})

test("config_read lists the new settings and renders a channel list readably", async () => {
    const { set, read } = fixture()
    await set(
        { path: "channels", value: '[{"type":"telegram","id":"tg","tokenEnv":"TG_TOKEN"}]' },
        toolContext({}),
    )
    const summary = String(await read({}, toolContext({})))
    expect(summary).toContain("channels =")
    expect(summary).toContain("server.enabled")
    // Not `[object Object]`, which is what String() on an entry produces.
    expect(summary).toContain("telegram")
    expect(summary).not.toContain("[object Object]")
})

test("config_set writes a schedule, and config_read renders it readably", async () => {
    const { set, read } = fixture()
    await set(
        { path: "channels", value: '[{"type":"telegram","id":"tg","tokenEnv":"TG_TOKEN"}]' },
        toolContext({}),
    )
    // The request that could not be answered before this row existed: asked to send something on a
    // timer, the agent reported `schedules` was "not one of the settings I can change from a
    // conversation" and stopped there.
    await set(
        {
            path: "schedules",
            value: '[{"id":"hi","kind":"every","expr":"5m","task":"Say hi.","deliver":{"channel":"tg","to":"123456789"}}]',
        },
        toolContext({}),
    )
    const summary = String(await read({}, toolContext({})))
    expect(summary).toContain("schedules =")
    expect(summary).toContain("hi")
    // Fourth appearance of one bug: a value shape the renderer has not seen writes `[object Object]`
    // and the schema then refuses it with a message pointing nowhere near the cause.
    expect(summary).not.toContain("[object Object]")
})

test("a schedule the runtime would refuse is refused at the edit, not at the next boot", async () => {
    const { set } = fixture()
    // The schema takes `expr` as any non-empty string, so without the shared check this writes
    // cleanly and the agent fails to start — an edit reported as a success that bricks the next boot.
    await expect(
        set(
            {
                path: "schedules",
                value: '[{"id":"x","kind":"cron","expr":"not a cron","task":"t","deliver":"none"}]',
            },
            toolContext({}),
        ),
    ).rejects.toThrow(/not a valid cron expression/)

    // And a delivery target naming a channel this agent does not declare.
    await expect(
        set(
            {
                path: "schedules",
                value: '[{"id":"x","kind":"every","expr":"5m","task":"t","deliver":{"channel":"nope","to":"1"}}]',
            },
            toolContext({}),
        ),
    ).rejects.toThrow(/not a channel id on this agent/)
})
