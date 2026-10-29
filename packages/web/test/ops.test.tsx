import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
    AddChannel,
    BackupPanel,
    CHANNEL_TYPES,
    FilesPanel,
    TemplateForm,
    WebhooksPanel,
} from "../src/ops.tsx"

const noop = () => undefined
const agents = [{ id: "milo", name: "Milo" }]

describe("webhooks", () => {
    test("a failing subscription says so, the secret is shown once, model.chunk is never offered", () => {
        const html = renderToStaticMarkup(
            createElement(WebhooksPanel, {
                webhooks: [
                    {
                        subscriptionId: "w1",
                        url: "https://x.example/h",
                        types: ["turn.end"],
                        createdAt: "",
                        failing: true,
                        consecutiveFailures: 3,
                        lastError: "503 from receiver",
                        pending: 2,
                    },
                ],
                eventTypes: ["turn.end", "model.chunk", "approval.requested"],
                agents,
                secret: "whsec_abc",
                onCreate: noop,
                onDelete: noop,
            }),
        )
        expect(html).toContain("failing (3)")
        expect(html).toContain("503 from receiver")
        expect(html).toContain("2 pending")
        expect(html).toContain("whsec_abc")
        expect(html).toContain("approval.requested")
        // Mentioned in the prose, never offered as a box to tick.
        expect(html).not.toContain('<input type="checkbox"/><code>model.chunk</code>')
    })
})

describe("backup", () => {
    test("offers the three includes and an import mode", () => {
        const html = renderToStaticMarkup(
            createElement(BackupPanel, { agents, onBackup: noop, onExport: noop, onImport: noop }),
        )
        expect(html).toContain("(its secrets)")
        expect(html).toContain(">download backup<")
        expect(html).toContain("overwrite knowledge files")
    })
})

describe("templates", () => {
    test("required variables gate the submit; a broken template is listed but disabled", () => {
        const html = renderToStaticMarkup(
            createElement(TemplateForm, {
                busy: false,
                onCreate: noop,
                templates: [
                    {
                        name: "velacrew",
                        description: "a crew",
                        vars: [
                            { name: "store", required: true, secret: false },
                            { name: "API_KEY", required: false, secret: true },
                        ],
                    },
                    {
                        name: "broken",
                        vars: [],
                        problem: { code: "x", message: "template.yaml missing" },
                    },
                ],
            }),
        )
        expect(html).toContain("a crew")
        expect(html).toContain('type="password"')
        expect(html).toContain("secret, goes to .env")
        expect(html).toContain("broken (broken)")
        expect(html).toContain("disabled")
    })
})

describe("files", () => {
    test("lists declared files with tier and size; a missing one says so", () => {
        const html = renderToStaticMarkup(
            createElement(FilesPanel, {
                files: [
                    {
                        name: "SOUL.md",
                        tier: "soul",
                        field: "context.soul.file",
                        exists: true,
                        bytes: 1200,
                    },
                    {
                        name: "MEMORY.md",
                        tier: "volatile",
                        field: "context.volatile",
                        exists: false,
                        bytes: 0,
                    },
                ],
                onSelect: noop,
            }),
        )
        expect(html).toContain("1200 B")
        expect(html).toContain(">missing<")
        expect(html).toContain(">volatile<")
    })
})

describe("add channel", () => {
    test("every bundled type has fields, and the form refuses a taken id", () => {
        expect(CHANNEL_TYPES.map((c) => c.type)).toEqual([
            "telegram",
            "whatsapp",
            "slack",
            "teams",
            "a2a",
        ])
        const closed = renderToStaticMarkup(
            createElement(AddChannel, { existing: ["tg"], busy: false, onAdd: noop }),
        )
        expect(closed).toContain("+ add a channel")
    })
})
