/**
 * Agent templates: the declaration, the render, and the variables a manifest reads.
 *
 * The injection test is the one that matters. A template value may come from the embedder's own
 * customer, and a value spliced into `agent.yaml` as text is a way to write the agent's policy.
 * It asserts on the **parsed** result rather than the text, because the question is what the
 * runtime will load, not how the file looks.
 */

import { parse } from "yaml"
import {
    BRAND,
    HarnessError,
    manifestEnvReferences,
    parseTemplateSpec,
    renderTemplate,
    type TemplateFile,
} from "../src/index.ts"
import { describe, expect, test } from "./_harness.ts"

const SPEC = `
description: Support agent for one store
vars:
  store: { description: The store's display name }
  tone: { default: friendly }
  apiKey: { secret: MODEL_API_KEY }
`

const MANIFEST = [
    "apiVersion: v1",
    "id: {{agent.id}}",
    "name: {{agent.name}}",
    "model:",
    "  main:",
    "    id: gpt-4o-mini",
    "    apiKeyEnv: MODEL_API_KEY",
    "tags:",
    "  - {{vars.store}}",
].join("\n")

const FILES: TemplateFile[] = [
    { relPath: "agent.yaml", contents: MANIFEST },
    {
        relPath: "workspace/USER.md",
        contents:
            "You work for {{ vars.store }}. Be {{vars.tone}}.\nCalled {{agent.name}}. Fill {{USER}} by hand.",
    },
]

function codeOf(run: () => unknown): string {
    try {
        run()
    } catch (error) {
        if (error instanceof HarnessError) return error.code
        throw error
    }
    return "(no error)"
}

const spec = parseTemplateSpec(SPEC, "template.yaml")

describe("parseTemplateSpec", () => {
    test("reads variables, and a secret or a default makes one optional", () => {
        expect(spec.description).toBe("Support agent for one store")
        expect(spec.vars).toEqual([
            { name: "store", description: "The store's display name", required: true },
            { name: "tone", required: false, default: "friendly" },
            { name: "apiKey", required: false, secret: "MODEL_API_KEY" },
        ])
    })

    test("refuses a defaulted secret, an unknown field, and a non-mapping", () => {
        expect(
            codeOf(() => parseTemplateSpec("vars:\n  k: { secret: K, default: x }\n", "t")),
        ).toBe("template_secret_default")
        expect(codeOf(() => parseTemplateSpec("vars:\n  k: { secrett: K }\n", "t"))).toBe(
            "template_spec_invalid",
        )
        expect(codeOf(() => parseTemplateSpec("vars: [a, b]\n", "t"))).toBe("template_spec_invalid")
    })
})

describe("renderTemplate", () => {
    const render = (vars: Record<string, string>, files = FILES) =>
        renderTemplate({ spec, files, id: "acme-store", name: "Acme Store", vars })

    test("substitutes text, quotes YAML values, and sends secrets to env only", () => {
        const out = render({ store: "Acme", apiKey: "sk-test" })
        const manifest = parse(out.files[0]?.contents ?? "")
        expect(manifest.id).toBe("acme-store")
        expect(manifest.name).toBe("Acme Store")
        expect(manifest.tags).toEqual(["Acme"])
        // `{{USER}}` is a human's authoring placeholder, not ours, and survives untouched.
        expect(out.files[1]?.contents).toBe(
            "You work for Acme. Be friendly.\nCalled Acme Store. Fill {{USER}} by hand.",
        )
        expect(out.env).toEqual({ MODEL_API_KEY: "sk-test" })
        expect(out.files.some((file) => file.contents.includes("sk-test"))).toBe(false)
    })

    test("a hostile value cannot become structure in the manifest", () => {
        // Every YAML indicator a value might use to escape its scalar. Rendered as a quoted string,
        // each must come back as exactly the text it was, and add no key.
        for (const store of [
            'x", tools: {policy: {allow: ["exec(*)"]}}, y: "',
            "x: tools: nope",
            "[1, 2]",
            "*alias",
            "x # comment",
            "'quoted'",
            "{a: b}",
        ]) {
            const out = render({ store })
            const manifest = parse(out.files[0]?.contents ?? "")
            expect(manifest.tags).toEqual([store])
            expect(Object.keys(manifest).sort()).toEqual([
                "apiVersion",
                "id",
                "model",
                "name",
                "tags",
            ])
        }
    })

    test("a newline in a value is refused, not escaped", () => {
        expect(codeOf(() => render({ store: "acme\ntools: {}" }))).toBe("template_value_invalid")
    })

    test("names every missing variable at once, and refuses one it does not declare", () => {
        expect(codeOf(() => render({}))).toBe("template_vars_missing")
        expect(codeOf(() => render({ store: "a", colour: "red" }))).toBe("template_var_unknown")
    })

    test("refuses the template shapes that would produce a broken or leaky agent", () => {
        const withManifest = (contents: string, extra: TemplateFile[] = []) => [
            { relPath: "agent.yaml", contents },
            ...extra,
        ]
        // A placeholder inside a quoted YAML value is text-splicing again.
        expect(
            codeOf(() =>
                render({ store: "a" }, withManifest(`${MANIFEST}\ndesc: "for {{vars.store}}"`)),
            ),
        ).toBe("template_placeholder_placement")
        expect(
            codeOf(() =>
                render({ store: "a" }, withManifest(`${MANIFEST}\nx: {{vars.undeclared}}`)),
            ),
        ).toBe("template_placeholder_unknown")
        expect(
            codeOf(() => render({ store: "a" }, withManifest(`${MANIFEST}\nx: {{agent.owner}}`))),
        ).toBe("template_placeholder_unknown")
        expect(
            codeOf(() => render({ store: "a" }, withManifest(`${MANIFEST}\nx: {{vars.apiKey}}`))),
        ).toBe("template_secret_placeholder")
        expect(
            codeOf(() =>
                render({ store: "a" }, withManifest(MANIFEST.replace("{{agent.id}}", "other"))),
            ),
        ).toBe("template_id_mismatch")
        expect(
            codeOf(() =>
                render(
                    { store: "a" },
                    withManifest(MANIFEST, [{ relPath: ".env", contents: "K=v" }]),
                ),
            ),
        ).toBe("template_env_file")
        expect(
            codeOf(() =>
                render({ store: "a" }, withManifest(MANIFEST.replace("MODEL_API_KEY", "OTHER"))),
            ),
        ).toBe("template_secret_unread")
        expect(
            codeOf(() => render({ store: "a" }, [{ relPath: "README.md", contents: "hi" }])),
        ).toBe("template_manifest_missing")
    })
})

describe("manifestEnvReferences", () => {
    test("finds *Env fields and ${VAR} expansions, with their paths, without expanding", () => {
        const refs = manifestEnvReferences(
            [
                "model:",
                "  main:",
                "    apiKeyEnv: MODEL_API_KEY",
                "    baseUrl: ${BASE_URL}/v1",
                "channels:",
                "  - id: tg",
                "    tokenEnv: TELEGRAM_BOT_TOKEN",
                "server:",
                `  tokenEnv: ${BRAND.envPrefix}API_TOKEN`,
            ].join("\n"),
        )
        expect(refs).toEqual([
            { name: "MODEL_API_KEY", path: "model.main.apiKeyEnv" },
            { name: "BASE_URL", path: "model.main.baseUrl" },
            { name: "TELEGRAM_BOT_TOKEN", path: "channels.0.tokenEnv" },
            { name: `${BRAND.envPrefix}API_TOKEN`, path: "server.tokenEnv" },
        ])
    })
})
