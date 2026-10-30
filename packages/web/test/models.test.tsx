import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { EFFORTS, ModelsPanel } from "../src/models.tsx"
import { faviconHref, Wordmark } from "../src/wordmark.tsx"

const noop = () => undefined

const render = (settings: Parameters<typeof ModelsPanel>[0]["settings"]) =>
    renderToStaticMarkup(
        createElement(ModelsPanel, {
            settings,
            secrets: [{ name: "MODEL_API_KEY", set: true }],
            onChange: noop,
            onSecret: noop,
        }),
    )

describe("the models panel", () => {
    const main = {
        path: "model.main",
        means: "",
        value: {
            id: "deepseek-v4-pro",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: "MODEL_API_KEY",
            reasoningEffort: "low",
        },
    }

    test("the main model, its provider, its key and its effort", () => {
        const html = render([main, { path: "model.<role>", means: "" }])
        expect(html).toContain("deepseek-v4-pro")
        expect(html).toContain("DeepSeek")
        expect(html).toContain("MODEL_API_KEY set")
        // Every level is offered, and the one in the file is the pressed one.
        for (const level of EFFORTS) expect(html).toContain(`>${level}<`)
        expect(html).toContain('aria-pressed="true">low<')
        // The template row is not a role.
        expect(html).toContain("No roles yet")
    })

    test("a named role is its own card and can be removed; main cannot", () => {
        const html = render([
            main,
            {
                path: "model.fast",
                means: "",
                value: { id: "deepseek-v4-flash", apiKeyEnv: "FAST_KEY" },
            },
        ])
        expect(html).toContain("deepseek-v4-flash")
        expect(html).toContain("FAST_KEY missing")
        expect(html.match(/>remove</g)?.length).toBe(1)
    })

    test("a Bedrock role shows its region, no key, and its fallbacks in order", () => {
        const html = render([
            {
                path: "model.main",
                means: "",
                value: {
                    id: "eu.anthropic.claude-sonnet-4-6",
                    api: "bedrock-converse",
                    options: { region: "eu-west-2", profile: "work" },
                    fallbacks: [
                        {
                            id: "deepseek-v4-flash",
                            baseUrl: "https://api.deepseek.com/v1",
                            apiKeyEnv: "K",
                        },
                        {
                            id: "us.amazon.nova-pro-v1:0",
                            api: "bedrock-converse",
                            options: { region: "us-east-1" },
                        },
                    ],
                },
            },
        ])
        expect(html).toContain("Bedrock · eu-west-2")
        expect(html).toContain("profile work")
        expect(html).toContain(">no key<")
        const flash = html.indexOf("deepseek-v4-flash")
        const nova = html.indexOf("us.amazon.nova-pro-v1:0")
        expect(flash).toBeGreaterThan(0)
        expect(nova).toBeGreaterThan(flash)
        // One remove per fallback; main itself has none.
        expect(html.match(/>remove</g)?.length).toBe(2)
    })
})

describe("the wordmark", () => {
    test("is pixels, not text, so the brand is drawn from the name", () => {
        const html = renderToStaticMarkup(createElement(Wordmark))
        expect(html).toContain("<svg")
        expect(html.match(/<rect /g)?.length ?? 0).toBeGreaterThan(20)
    })

    test("the favicon is an SVG data URI in the accent", () => {
        expect(decodeURIComponent(faviconHref())).toContain("#d75fd7")
    })
})

describe("capabilities", () => {
    const resolved = {
        contextWindow: 1_048_576,
        maxOutput: 393_216,
        thinking: "deepseek",
        nativeTools: true,
        promptCache: "none",
        promptStyle: { delimiters: "markdown", intensity: "neutral" },
    }
    const render = (capabilities?: Record<string, unknown>) =>
        renderToStaticMarkup(
            createElement(ModelsPanel, {
                settings: [
                    {
                        path: "model.main",
                        means: "",
                        value: {
                            id: "deepseek-v4-pro",
                            ...(capabilities === undefined ? {} : { capabilities }),
                        },
                    },
                ],
                secrets: [],
                resolved,
                onChange: () => undefined,
                onSecret: () => undefined,
            }),
        )

    test("the resolved values are shown, each marked as the registry's", () => {
        const html = render()
        expect(html).toContain("1,048,576")
        expect(html).toContain('<option value="deepseek" selected="">deepseek</option>')
        expect(html).toContain("markdown · neutral")
        expect(html).not.toContain("overridden")
    })

    test("a field the manifest overrides says so and offers the reset", () => {
        expect(render({ contextWindow: 32_768 })).toContain("overridden · reset")
    })
})
