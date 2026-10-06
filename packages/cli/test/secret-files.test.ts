/**
 * `X_FILE` fills `X` at startup (pilot.9): the secret's value never sits in the environment the kernel
 * shows a child process, and every reader in the runtime still finds it under its own name.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSecretFiles } from "../src/lib/secret-files.ts"

describe("secret files", () => {
    test("fill an unset variable from its file, trailing newline dropped; never override, never AWS_*", () => {
        const dir = mkdtempSync(join(tmpdir(), "secrets-"))
        const token = join(dir, "token")
        writeFileSync(token, "s3cret\n")
        const env: Record<string, string | undefined> = {
            DISPACH_API_TOKEN_FILE: token,
            RELAY_TOKEN_FILE: token,
            RELAY_TOKEN: "already",
            AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: token,
        }
        expect(loadSecretFiles(env, () => {})).toEqual(["DISPACH_API_TOKEN"])
        expect(env.DISPACH_API_TOKEN).toBe("s3cret")
        expect(env.RELAY_TOKEN).toBe("already")
        expect(env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined()
    })

    test("an unreadable file is reported and skipped, not fatal", () => {
        const warnings: string[] = []
        const env: Record<string, string | undefined> = { MODEL_API_KEY_FILE: "/nowhere/key" }
        expect(loadSecretFiles(env, (line) => warnings.push(line))).toEqual([])
        expect(env.MODEL_API_KEY).toBeUndefined()
        expect(warnings[0]).toContain("MODEL_API_KEY_FILE names /nowhere/key")
    })
})
