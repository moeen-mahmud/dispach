#!/usr/bin/env bun
/** Export the handler's generated OpenAPI document for GitBook. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Runtime } from "../packages/core/src/index.ts"
import { createHandler } from "../packages/server/src/handler.ts"

const ROOT = resolve(import.meta.dirname, "..")
const OUTPUT = join(ROOT, "developer-docs", "reference", "openapi.json")
const check = process.argv.includes("--check")

const runtime = await Runtime.create({
    agents: [
        {
            apiVersion: "dispach/v1",
            id: "docs",
            name: "Documentation",
            model: {
                main: {
                    id: "gpt-4o-mini",
                    baseUrl: "https://api.example.com/v1",
                    apiKeyEnv: "MODEL_API_KEY",
                },
            },
        },
    ],
    env: { MODEL_API_KEY: "docs-not-a-real-key" },
})

try {
    const handler = createHandler({ runtime, allowUnauthenticated: true })
    const response = await handler(new Request("http://localhost:7420/v1/openapi.json"))
    if (!response.ok) {
        throw new Error(`GET /v1/openapi.json returned ${response.status}`)
    }

    const document = (await response.json()) as Record<string, unknown>
    document.servers = [
        {
            url: "http://localhost:7420",
            description: "Local server. Replace this with the URL of your deployment.",
        },
    ]
    const rendered = `${JSON.stringify(document, null, 4)}\n`

    if (check) {
        let current = ""
        try {
            current = readFileSync(OUTPUT, "utf8")
        } catch {
            // The mismatch below explains how to create the missing file.
        }
        if (current !== rendered) {
            process.stderr.write(
                "developer-docs/reference/openapi.json is stale.\n" +
                    "  hint: run `bun run docs:generate` and review the generated API diff.\n",
            )
            process.exitCode = 1
        } else {
            process.stdout.write("OpenAPI reference: current\n")
        }
    } else {
        mkdirSync(dirname(OUTPUT), { recursive: true })
        writeFileSync(OUTPUT, rendered)
        process.stdout.write(`${OUTPUT}: written\n`)
    }
} finally {
    await runtime.stop()
}
