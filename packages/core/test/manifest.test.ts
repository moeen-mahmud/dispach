import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BRAND } from "../src/brand.ts"
import { HarnessError } from "../src/errors.ts"
import { loadManifest } from "../src/manifest/load.ts"
import { providerIds, resolveProviders } from "../src/manifest/providers.ts"
import { buildChannels } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

/**
 * Manifest loading is where a config mistake either becomes a named field and a fix, or becomes
 * a mystery three layers away. Each case below asserts the *diagnosis*, not just the failure.
 */

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "manifest-test-"))
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content)
    }
    return dir
}

function manifestYaml(body: string): string {
    return `apiVersion: ${BRAND.apiVersion}\n${body}`
}

const VALID = manifestYaml(`id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`)

/**
 * `extra` carries what a real caller would register — `knownProviders`, `knownChannels`.
 *
 * Defaulted to nothing rather than to everything, because that is what a bare `validate` sees, and
 * the "nobody registered this" failures are the ones most worth pinning.
 */
function load(
    files: Record<string, string>,
    extra: { knownChannels?: readonly string[]; knownProviders?: readonly string[] } = {},
    env: Record<string, string | undefined> = ENV,
) {
    const dir = workspace(files)
    return loadManifest(join(dir, "agent.yaml"), { env, skipEnvFile: true, ...extra })
}

function expectFailure(
    files: Record<string, string>,
    extra: { knownChannels?: readonly string[]; knownProviders?: readonly string[] } = {},
    env: Record<string, string | undefined> = ENV,
): HarnessError {
    try {
        load(files, extra, env)
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected the load to fail")
}

/** Every detail on every failure, so assertions can look at codes, fields, and hints. */
function allDetails(error: HarnessError) {
    return error.details.length > 0 ? error.details : [error.toDetail()]
}

function codes(error: HarnessError): string[] {
    return allDetails(error).map((d) => d.code)
}

function fields(error: HarnessError): (string | undefined)[] {
    return allDetails(error).map((d) => d.field)
}

describe("a valid manifest", () => {
    test("loads, and defaults are applied", () => {
        const { manifest, window } = load({ "agent.yaml": VALID })
        expect(manifest.id).toBe("test")
        expect(manifest.tools.dialect).toBe("nlt")
        expect(manifest.limits.maxSteps).toBe(40)
        expect(manifest.limits.noProgress.identicalCalls).toBe(3)
        // The first rung is `snip`, not `trim`: observations before whole turns.
        expect(manifest.context.thresholds.snip).toBe(0.6)
        // And `trim` is the last, not the first: it destroys without leaving a pointer or a digest.
        expect(manifest.context.thresholds.trim).toBe(0.95)
        // Window comes from the capability registry when the manifest does not set it.
        expect(window).toBe(128_000)
    })

    test("the default dialect is NLT, not native", () => {
        // The single most consequential default in the runtime. If this ever silently flips, small
        // models lose double-digit accuracy and nothing in the logs says why.
        expect(load({ "agent.yaml": VALID }).manifest.tools.dialect).toBe("nlt")
    })

    test("an explicit window overrides the registry", () => {
        const { window } = load({
            "agent.yaml": manifestYaml(`id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4096
  reserveOutput: 512
`),
        })
        expect(window).toBe(4096)
    })
})

describe("rule 1 — apiVersion", () => {
    test("a wrong version names both what was found and what is expected", () => {
        const error = expectFailure({ "agent.yaml": `apiVersion: ${BRAND.slug}/v2\nid: t\n` })
        expect(error.code).toBe("manifest_api_version")
        expect(error.message).toContain(`${BRAND.slug}/v2`)
        expect(error.message).toContain(BRAND.apiVersion)
        expect(error.field).toBe("apiVersion")
    })

    test("a missing version fails as a version problem, not as a schema problem", () => {
        expect(expectFailure({ "agent.yaml": "id: t\n" }).code).toBe("manifest_api_version")
    })

    test("the version is never silently upgraded", () => {
        expect(
            expectFailure({ "agent.yaml": `apiVersion: ${BRAND.slug}/v0\nid: t\n` }).hint,
        ).toContain("never silently upgraded")
    })
})

describe("rule 2 — secrets are names, never values", () => {
    test("a literal OpenAI-style key fails, naming the field", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: sk-abcdefghijklmnopqrstuvwxyz012345
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
        expect(fields(error)).toContain("model.main.apiKeyEnv")
    })

    test("an unknown `apiKey` key is reported as a secret, not as a typo", () => {
        // The user's mistake is the credential in the file. Leading with "unknown key" would send
        // them to the spec to look up a field name instead of to their shell history to rotate a key.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKey: sk-abcdefghijklmnopqrstuvwxyz012345
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
        expect(fields(error)).toContain("model.main.apiKey")
    })

    test("a Bearer header value fails", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    headers:
      authorization: "Bearer abc123def456"
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })

    test("a 32-character hex blob fails", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: 0123456789abcdef0123456789abcdef
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })

    test("an env var *name* is fine", () => {
        expect(load({ "agent.yaml": VALID }).manifest.model.main.apiKeyEnv).toBe("MODEL_API_KEY")
    })

    test("a lowercase value in apiKeyEnv fails even without a credential shape", () => {
        // `apiKeyEnv: my-key` is almost certainly a value, not a variable name.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: my-secret-value
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })
})

describe("rule 3 — compaction thresholds", () => {
    const withThresholds = (thresholds: string) =>
        manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
${thresholds}`)

    test("equal thresholds are rejected", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    trim: 0.7\n    snip: 0.7\n"),
        })
        expect(codes(error)).toContain("manifest_thresholds_not_ascending")
    })

    test("inverted thresholds are rejected, naming the offending stage", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    snip: 0.9\n    micro: 0.7\n"),
        })
        expect(fields(error)).toContain("context.thresholds.micro")
    })

    /**
     * The five numbers a manifest written before the reorder carries. Not malformed — ordered for a
     * ladder that ran `trim` first. The generic ascending error would point at `trim` and say it must
     * exceed `micro`: true, and about a line nobody typed.
     */
    test("thresholds in the old stage order are named as such, not as an inversion", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds(
                "  thresholds:\n    trim: 0.60\n    snip: 0.70\n    micro: 0.80\n    collapse: 0.88\n    reset: 0.95\n",
            ),
        })
        expect(codes(error)).toContain("manifest_thresholds_legacy_order")
        expect(codes(error)).not.toContain("manifest_thresholds_not_ascending")
        // The hint has to carry the rewrite, or it is a diagnosis with no remedy.
        expect(JSON.stringify(error)).toContain("snip 0.6")
    })

    test("a threshold outside (0,1) is rejected", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    reset: 1.5\n"),
        })
        expect(codes(error)).toContain("manifest_threshold_range")
    })

    test("zero is rejected — a stage that always fires is not a stage", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    trim: 0\n"),
        })
        expect(codes(error)).toContain("manifest_threshold_range")
    })
})

describe("rule 4 — write reservation", () => {
    test("reserveWrite equal to max is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  budget:
    max: 6
    reserveWrite: 6
`),
        })
        expect(codes(error)).toContain("manifest_reserve_write_too_large")
        expect(fields(error)).toContain("tools.budget.reserveWrite")
    })
})

describe("rules 10 and 11 — context files and budget", () => {
    test("a missing context file fails at load, naming the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  files:
    - IDENTITY.md
`),
        })
        expect(codes(error)).toContain("manifest_context_file_missing")
        expect(fields(error)).toContain("context.files[0]")
    })

    test("a present context file loads", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  files:
    - IDENTITY.md
`),
            "IDENTITY.md": "You are helpful.",
        })
        expect(loaded.manifest.context.files).toEqual(["IDENTITY.md"])
    })

    test("reserveOutput above the window is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4096
  reserveOutput: 8192
`),
        })
        expect(codes(error)).toContain("manifest_reserve_output_too_large")
    })
})

describe("environment expansion", () => {
    test("an unset variable fails at load, naming the variable and the field", () => {
        const error = expectFailure(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${MODEL_ID}
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`),
            },
            {},
            ENV,
        )
        expect(error.code).toBe("env_var_missing")
        expect(error.message).toContain("MODEL_ID")
        expect(error.field).toBe("model.main.id")
    })

    test("the failure explains why it is not deferred", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${NOPE}
    baseUrl: https://api.example.com/v1
`),
        })
        expect(error.hint).toContain("auth error")
    })

    test("a set variable expands", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${MODEL_ID}
    baseUrl: \${MODEL_BASE_URL}
    apiKeyEnv: MODEL_API_KEY
`),
            },
            {},
            { ...ENV, MODEL_ID: "qwen3.5:9b", MODEL_BASE_URL: "http://localhost:11434/v1" },
        )
        expect(loaded.manifest.model.main.id).toBe("qwen3.5:9b")
        expect(loaded.manifest.model.main.baseUrl).toBe("http://localhost:11434/v1")
    })

    test("an apiKeyEnv naming an unset variable fails at load, not at first request", () => {
        const error = expectFailure({ "agent.yaml": VALID }, {}, {})
        expect(codes(error)).toContain("model_api_key_missing")
        expect(fields(error)).toContain("model.main.apiKeyEnv")
    })

    test("omitting apiKeyEnv is allowed, for a keyless local endpoint", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: qwen3.5:9b
    baseUrl: http://localhost:11434/v1
`),
            },
            {},
        )
        expect(loaded.manifest.model.main.apiKeyEnv).toBeUndefined()
    })
})

describe("$ref", () => {
    test("a role can reuse another role's definition", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  selector:
    id: gpt-4o-mini-small
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.selector
`),
        })
        expect(loaded.manifest.model.compactor?.id).toBe("gpt-4o-mini-small")
    })

    test("an unresolvable $ref names the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.nonexistent
`),
        })
        expect(error.code).toBe("manifest_ref_unresolved")
        expect(error.message).toContain("model.nonexistent")
    })

    test("a self-referential $ref is a cycle, not a hang", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.compactor
`),
        })
        expect(error.code).toBe("manifest_ref_cycle")
    })
})

describe("unknown keys and shapes", () => {
    test("an unknown top-level key is refused, not ignored", () => {
        const error = expectFailure({ "agent.yaml": `${VALID}unexpected: true\n` })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(allDetails(error)[0]?.hint).toContain("refused rather than ignored")
    })

    test("a misspelled nested key is refused", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    tempurature: 0.3
`),
        })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(fields(error).some((f) => f?.startsWith("model.main"))).toBe(true)
    })

    test("a missing model section is a schema failure naming the path", () => {
        const error = expectFailure({ "agent.yaml": manifestYaml("id: t\n") })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(fields(error)).toContain("model")
    })

    test("an invalid dialect names the field", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: freestyle
`),
        })
        expect(fields(error)).toContain("tools.dialect")
    })

    test("malformed YAML is reported as YAML, with the tab hint", () => {
        const error = expectFailure({ "agent.yaml": "apiVersion: x\n\tid: bad\n" })
        expect(error.code).toBe("manifest_not_yaml")
        expect(error.hint).toContain("tab")
    })

    test("a missing file names the path and the resolution rule", () => {
        let error: HarnessError | undefined
        try {
            loadManifest("/definitely/not/here/agent.yaml", { env: ENV, skipEnvFile: true })
        } catch (caught) {
            error = caught as HarnessError
        }
        expect(error?.code).toBe("manifest_unreadable")
    })
})

describe("baseUrl", () => {
    test("a baseUrl that already includes /chat/completions is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1/chat/completions
    apiKeyEnv: MODEL_API_KEY
`),
        })
        expect(codes(error)).toContain("manifest_base_url_includes_path")
    })

    test("a relative baseUrl is rejected with the version-segment hint", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: /v1
    apiKeyEnv: MODEL_API_KEY
`),
        })
        expect(codes(error)).toContain("manifest_base_url_invalid")
        expect(allDetails(error)[0]?.hint).toContain("version segment")
    })
})

describe("sections this build does not implement", () => {
    test("a channel type nobody registered is refused, naming the field", () => {
        // Phase 4 replaced the blanket refusal with a registration check, for the same reason
        // `tools.provider` has one: a channel that constructs nothing never receives, and the only
        // symptom is a bot that does not answer — indistinguishable from a wrong token.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
`),
        })
        expect(codes(error)).toContain("channel_type_unknown")
        expect(allDetails(error)[0]?.field).toBe("channels[0].type")
    })

    test("a registered channel type loads, keeping its type-specific fields", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
    mode: longpoll
    allowFrom: ["@moeen"]
`),
            },
            { knownChannels: ["telegram"] },
        )
        const channel = loaded.manifest.channels[0]
        expect(channel?.id).toBe("tg")
        // `ChannelSchema` is passthrough: stripping the type-specific fields here would delete the
        // channel's entire configuration before its factory ever sees it.
        expect((channel as Record<string, unknown>).mode).toBe("longpoll")
        expect(channel?.allowFrom).toEqual(["@moeen"])
    })

    test("two channels sharing an id are refused", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
  - type: telegram
    id: tg
`),
        })
        expect(codes(error)).toContain("channel_id_duplicate")
    })

    test("a disabled channel is not constructed, so its factory never refuses", () => {
        // `enabled: false` is the one thing that must work on a *broken* channel. A factory that
        // ran anyway — and refused because its tokenEnv is unset — would make switching one off
        // impossible. The `type` is still checked, because a typo there is a typo either way.
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    enabled: false
`),
            },
            { knownChannels: ["telegram"] },
        )
        const built = buildChannels(loaded, {
            channels: {
                telegram: () => {
                    throw new Error("a disabled channel must not be constructed")
                },
            },
        })
        expect(built.length).toBe(0)
    })

    test("buildChannels hands the factory the type-specific fields and the channel id", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    mode: webhook
    allowFrom: ["@moeen"]
`),
            },
            { knownChannels: ["telegram"] },
        )
        let seen: Record<string, unknown> = {}
        let seenId = ""
        const built = buildChannels(loaded, {
            channels: {
                telegram: (context) => {
                    seen = { ...context.config }
                    seenId = context.id
                    return {
                        id: context.id,
                        type: "telegram",
                        limits: { maxMessageChars: 4096, idempotentSend: false },
                        start: async () => {},
                        stop: async () => {},
                        send: async () => ({ ok: true }) as const,
                    }
                },
            },
        })
        expect(seenId).toBe("tg")
        // The four fields core owns are stripped; everything else reaches the plugin's own schema.
        expect(seen).toEqual({ mode: "webhook" })
        expect(built[0]?.allowFrom).toEqual(["@moeen"])
    })

    test("a delivery target naming a channel that does not exist is refused at load", () => {
        // Rule 9 in 02-SPEC-MANIFEST.md. Otherwise it surfaces at the first scheduled run.
        const error = expectFailure(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
delivery:
  default: telegram
`),
            },
            { knownChannels: ["telegram"] },
        )
        expect(codes(error)).toContain("delivery_channel_unknown")
        // The most likely mistake is naming the *type* where an *id* belongs, so the message says so.
        expect(allDetails(error)[0]?.hint).toContain("names a channel's id, not its type")
    })

    test("naming a provider nobody registered is refused, naming the field", () => {
        // Not "not implemented" any more — providers work. What fails is naming one this runtime was
        // never given, and failing here beats failing at resolution, where the report would blame every
        // pinned slug for one missing registration.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  provider: composio
`),
        })
        expect(codes(error)).toContain("tool_provider_unknown")
        expect(allDetails(error)[0]?.field).toBe("tools.provider")
    })

    test("a registered provider loads, and the refusal names the ones that are available", () => {
        const yaml = manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  provider: composio
`)
        const dir = workspace({ "agent.yaml": yaml })
        const loaded = loadManifest(join(dir, "agent.yaml"), {
            env: ENV,
            skipEnvFile: true,
            knownProviders: ["composio"],
        })
        expect(loaded.manifest.tools.provider).toBe("composio")

        // A typo against a registered set names what is available rather than only what is wrong.
        let hint = ""
        try {
            loadManifest(join(workspace({ "agent.yaml": yaml }), "agent.yaml"), {
                env: ENV,
                skipEnvFile: true,
                knownProviders: ["mcp"],
            })
        } catch (error) {
            hint = error instanceof HarnessError ? (error.details[0]?.message ?? "") : ""
        }
        expect(hint.includes("Available: mcp")).toBe(true)
    })

    test("enabling runtime tool search is refused, and says why it is off by design", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  search:
    enabled: true
`),
        })
        expect(codes(error)).toContain("not_implemented_yet")
        expect(allDetails(error)[0]?.hint).toContain("two-hop")
    })

    test("the native dialect loads on a model known to support it", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: native
`),
        })
        expect(loaded.manifest.tools.dialect).toBe("native")
    })

    test("the native dialect is refused on a model with no native tool calling", () => {
        // The alternative is a 400 on the first turn — or, on an endpoint that accepts an unknown
        // `tools` key and ignores it, an agent that simply never calls a tool and never says why.
        // Capability resolution already knows the answer, so the refusal happens here.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: some-unknown-local-model
    baseUrl: http://localhost:11434/v1
tools:
  dialect: native
`),
        })
        expect(codes(error)).toContain("native_tools_unsupported")
        expect(allDetails(error)[0]?.field).toBe("tools.dialect")
    })

    test("an author can declare native support the capability table does not know about", () => {
        // Not a fight with the table: an unlisted model that genuinely does support tool calling is a
        // supported configuration, and overriding the capability is how it is stated.
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: some-unknown-local-model
    baseUrl: http://localhost:11434/v1
    capabilities:
      nativeTools: true
tools:
  dialect: native
`),
        })
        expect(loaded.manifest.tools.dialect).toBe("native")
    })

    test("pinning and the nlt dialect load — slugs are resolved at agent load, not here", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: nlt
  local:
    - now
`),
        })
        expect(loaded.manifest.tools.dialect).toBe("nlt")
        expect(loaded.manifest.tools.local).toEqual(["now"])
    })
})

describe("extends", () => {
    test("a child manifest overrides its base, shallowly", () => {
        const loaded = load({
            "base.yaml": manifestYaml(`id: base
model:
  main:
    id: base-model
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
limits:
  maxSteps: 3
`),
            "agent.yaml": manifestYaml(`id: child
extends: ./base.yaml
`),
        })
        expect(loaded.manifest.id).toBe("child")
        expect(loaded.manifest.model.main.id).toBe("base-model")
        expect(loaded.manifest.limits.maxSteps).toBe(3)
    })

    test("a missing base names the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: child
extends: ./nope.yaml
`),
        })
        expect(error.code).toBe("manifest_extends_unresolved")
    })
})

describe("failure reporting", () => {
    test("several independent problems are reported together", () => {
        // Three edit-run cycles for three mistakes in one file is a bad trade for the user.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1/chat/completions
    apiKeyEnv: MODEL_API_KEY
context:
  window: 2048
  reserveOutput: 4096
  files:
    - MISSING.md
`),
        })
        expect(error.details.length).toBeGreaterThanOrEqual(3)
        expect(codes(error)).toContain("manifest_context_file_missing")
        expect(codes(error)).toContain("manifest_reserve_output_too_large")
        expect(codes(error)).toContain("manifest_base_url_includes_path")
    })

    test("every failure carries a non-empty hint", () => {
        const error = expectFailure({ "agent.yaml": `${VALID}unexpected: true\n` })
        for (const detail of allDetails(error)) {
            expect(detail.hint.length).toBeGreaterThan(0)
        }
    })

    test("format() prints the field and hint for a terminal", () => {
        const error = expectFailure({ "agent.yaml": "apiVersion: wrong\nid: t\n" })
        const printed = error.format()
        expect(printed).toContain("field:")
        expect(printed).toContain("hint:")
    })
})

describe("the HTTP server section", () => {
    test("enabling it loads, now that something consumes it", () => {
        // Refused for three phases, because nothing read `manifest.server` and a manifest asking
        // for port 9999 would have loaded, started nothing, and said nothing. `serve` reads it now.
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
server:
  enabled: true
  port: 9999
`),
        })
        expect(loaded.manifest.server.enabled).toBe(true)
        expect(loaded.manifest.server.port).toBe(9999)
    })

    test("declaring it disabled is not an error — that asks for nothing", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
server:
  enabled: false
  port: 9999
`),
        })
        expect(loaded.manifest.server.enabled).toBe(false)
    })
})

describe("resolveProviders", () => {
    test("the map is read in order and each block reaches its own provider", () => {
        const plan = resolveProviders({
            providers: { system: { writeRoots: ["./notes"] }, web: { backend: "brave" } },
        })
        expect(plan.selections.map((entry) => entry.id)).toEqual(["system", "web"])
        expect(plan.selections[1]?.config).toEqual({ backend: "brave" })
        expect(plan.warnings).toEqual([])
    })

    test("no providers at all is not a warning", () => {
        expect(resolveProviders({}).selections).toEqual([])
        expect(resolveProviders({}).warnings).toEqual([])
    })

    test("a providerConfig with no provider to apply it to is reported, not ignored", () => {
        // Settings that look applied and are not. The half-finished state of a migration where the
        // provider line was deleted and its block was left behind.
        const plan = resolveProviders({ providerConfig: { apiKeyEnv: "TAVILY_API_KEY" } })
        expect(plan.selections).toEqual([])
        expect(plan.warnings[0]?.code).toBe("tools_provider_config_orphaned")
    })

    test("a providerConfig beside the map is a conflict, since it belongs to the other spelling", () => {
        expect(() =>
            resolveProviders({ providers: { web: {} }, providerConfig: { backend: "brave" } }),
        ).toThrow(/tools_provider_alias_conflict|deprecated/)
        // Empty is the schema default and means nothing at all.
        expect(resolveProviders({ providers: { web: {} }, providerConfig: {} }).warnings).toEqual(
            [],
        )
    })

    test("providerIds lists both spellings for a message that has to name them", () => {
        expect(providerIds({ providers: { a: {}, b: {} } })).toEqual(["a", "b"])
        expect(providerIds({ provider: "c" })).toEqual(["c"])
    })
})

describe("the shipped example manifests load", () => {
    /**
     * This test exists because they did not.
     *
     * `examples/reference/agent.yaml` is documented as holding every field, and it had been failing
     * validation since Phase 5 removed `skills.budget` — the one file a reader opens to see what good
     * looks like, refused by the runtime it demonstrates. Nothing caught it because nothing loaded it,
     * which is the defect; the stale key was only the symptom.
     */
    test.each([["examples/minimal/agent.yaml"], ["examples/reference/agent.yaml"]] as [string][])(
        "%s loads and validates",
        (path) => {
            const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
            // A stub key, because loading checks that named env vars are *set* — the same overlay
            // `init` uses for the manifest it has just written and cannot have credentials for yet.
            // `loadManifest` validates and throws, so reaching the assertion *is* the assertion. The
            // known lists are what `Runtime.create` passes: an example naming a provider or channel
            // this build does not register must fail, and that is the check, not a nuisance.
            const loaded = loadManifest(join(root, path), {
                // A real model id, not a placeholder. `examples/minimal` keeps `${MODEL_ID}`
                // deliberately — demonstrating one manifest against four endpoints is its purpose —
                // and an unknown id resolves to the default 8k window, which makes its own
                // `reserveOutput` invalid. The example is correct; a stub id is not a fair test of it.
                env: {
                    ...process.env,
                    MODEL_API_KEY: "stub",
                    MODEL_ID: "deepseek-v4-pro",
                    MODEL_BASE_URL: "https://api.deepseek.com/v1",
                },
                knownProviders: ["system", "web", "composio"],
                knownChannels: ["telegram", "whatsapp"],
            })
            expect(loaded.manifest.apiVersion).toBe(`${BRAND.slug}/v1`)
        },
    )
})
