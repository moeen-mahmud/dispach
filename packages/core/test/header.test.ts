/**
 * The shallow header read: a listing must never require credentials.
 *
 * The property under test is the negative one — no env expansion, no validation — because that
 * is what makes a picker work on a machine where the key is not exported yet.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessError } from "../src/errors.ts"
import { readManifestHeader } from "../src/manifest/header.ts"
import { describe, expect, test } from "./_harness.ts"

function manifest(content: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "header-test-")), "agent.yaml")
    writeFileSync(path, content, "utf8")
    return path
}

describe("readManifestHeader", () => {
    test("reads id, name and model with env references unexpanded and no env at all", () => {
        const path = manifest(
            [
                "apiVersion: whatever/v1",
                "id: milo",
                "name: Milo",
                "model:",
                "  main:",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest env expansion syntax, not interpolation
                "    id: ${MODEL_ID}",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest env expansion syntax, not interpolation
                "    baseUrl: ${MODEL_BASE_URL}",
                "    apiKeyEnv: SOME_KEY_NOBODY_EXPORTED",
            ].join("\n"),
        )
        const header = readManifestHeader(path)
        expect(header.id).toBe("milo")
        expect(header.name).toBe("Milo")
        // Raw, verbatim: expansion is the loader's business, not a listing's.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest env expansion syntax, not interpolation
        expect(header.modelId).toBe("${MODEL_ID}")
    })

    test("missing fields are absent, not invented", () => {
        const header = readManifestHeader(manifest("id: bare\n"))
        expect(header.id).toBe("bare")
        expect(header.name).toBe(undefined)
        expect(header.modelId).toBe(undefined)
    })

    test("an unreadable file throws the loader's own unreadable error", () => {
        let error: HarnessError | undefined
        try {
            readManifestHeader("/nonexistent/agent.yaml")
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("manifest_unreadable")
    })

    test("garbage YAML throws the loader's own not-yaml error", () => {
        let error: HarnessError | undefined
        try {
            readManifestHeader(manifest("id: [unclosed"))
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("manifest_not_yaml")
    })

    test("a non-mapping document is refused, not coerced", () => {
        let error: HarnessError | undefined
        try {
            readManifestHeader(manifest("- just\n- a\n- list\n"))
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("manifest_not_yaml")
    })
})
