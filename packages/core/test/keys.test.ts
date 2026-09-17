/**
 * Operator keys: the secret, the fingerprint, and the store that holds one and not the other.
 *
 * Imports `./_harness.ts` rather than `bun:test` so it runs under `bun test` *and* `node --test`,
 * for the reason `store.test.ts` states: the `UNIQUE` constraint, the coarse-`UPDATE` predicate and
 * the soft-delete read-back are all behaviours of a SQLite binding, and a green run under one
 * binding proves nothing about the other. `crypto.subtle` and `crypto.getRandomValues` are the
 * other half — both are globals on both runtimes, and asserting that here is what makes the choice
 * of WebCrypto over `node:crypto` a checked claim rather than an assumption.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    keyFingerprint,
    keyLabelProblem,
    MAX_KEY_LABEL,
    newKeySecret,
    OPERATOR_KEY_PREFIX,
} from "../src/auth/keys.ts"
import { newKeyId } from "../src/loop/ids.ts"
import { SqliteStore } from "../src/store/sqlite/store.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const dirs: string[] = []

function tempStore(): Promise<SqliteStore> {
    const dir = mkdtempSync(join(tmpdir(), "keys-"))
    dirs.push(dir)
    return SqliteStore.open({ path: join(dir, "store.db") })
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("key secrets", () => {
    test("carry the brand prefix, so a leaked one is identifiable", () => {
        expect(newKeySecret().startsWith(OPERATOR_KEY_PREFIX)).toBe(true)
    })

    test("are drawn from the confusable-free alphabet only", () => {
        // `i`, `l`, `o` and `u` are absent on purpose: a credential gets read off a container log,
        // and a misread is indistinguishable from a wrong key.
        const body = newKeySecret().slice(OPERATOR_KEY_PREFIX.length)
        expect(/^[0123456789abcdefghjkmnpqrstvwxyz]+$/.test(body)).toBe(true)
        expect(body.length).toBe(32)
    })

    test("do not repeat", () => {
        // Not a randomness test — that is not something a unit test can assert. It is a guard
        // against the one failure that *is* reachable by mistake: a generator that seeded once, or
        // returned a constant, would pass every other assertion in this file.
        const seen = new Set<string>()
        for (let i = 0; i < 500; i += 1) seen.add(newKeySecret())
        expect(seen.size).toBe(500)
    })

    test("are unbiased across the alphabet", () => {
        /**
         * The reason this file exists rather than reusing `randomSuffix` from `loop/ids.ts`.
         *
         * That helper reduces a byte modulo 36, and 256 is not a multiple of 36 — so its first four
         * symbols come up on 8 bytes each and the rest on 7, which is fine for a collision argument
         * about ids and is entropy silently removed from a *secret*. Thirty-two symbols divides the
         * low five bits exactly. With 320,000 samples over 32 buckets the expected count is 10,000
         * and the modulo-36 bias would show as a ~14% excess on the early symbols, which this
         * tolerance catches and ordinary sampling noise does not.
         */
        const counts = new Map<string, number>()
        for (let i = 0; i < 10_000; i += 1) {
            for (const symbol of newKeySecret().slice(OPERATOR_KEY_PREFIX.length)) {
                counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
            }
        }
        expect(counts.size).toBe(32)
        for (const count of counts.values()) {
            expect(count).toBeGreaterThan(9_000)
            expect(count).toBeLessThan(11_000)
        }
    })
})

describe("fingerprints", () => {
    test("are 64 hex characters, and the same secret always gives the same one", async () => {
        const secret = newKeySecret()
        const first = await keyFingerprint(secret)
        expect(/^[0-9a-f]{64}$/.test(first)).toBe(true)
        expect(await keyFingerprint(secret)).toBe(first)
    })

    test("differ for different secrets", async () => {
        expect(await keyFingerprint("a")).not.toBe(await keyFingerprint("b"))
    })

    test("never contain the secret", async () => {
        // The property the whole scheme rests on, asserted rather than assumed: what reaches the
        // database must not be reversible to what the operator holds.
        const secret = newKeySecret()
        const fingerprint = await keyFingerprint(secret)
        expect(fingerprint.includes(secret)).toBe(false)
        expect(fingerprint.includes(secret.slice(OPERATOR_KEY_PREFIX.length))).toBe(false)
    })
})

describe("labels", () => {
    test("must be non-empty", () => {
        expect(keyLabelProblem("")).toBeDefined()
        expect(keyLabelProblem("   ")).toBeDefined()
        expect(keyLabelProblem("my browser")).toBeUndefined()
    })

    test("are bounded", () => {
        expect(keyLabelProblem("x".repeat(MAX_KEY_LABEL))).toBeUndefined()
        expect(keyLabelProblem("x".repeat(MAX_KEY_LABEL + 1))).toBeDefined()
    })

    test("refuse control characters, including a newline", () => {
        // A label reaches a terminal and a listing row. An escape sequence in one renders as a
        // different label than the one stored, and a newline breaks every row it appears in.
        expect(keyLabelProblem("two\nlines")).toBeDefined()
        expect(keyLabelProblem("tab\there")).toBeDefined()
        expect(keyLabelProblem("esc\u001b[2Khidden")).toBeDefined()
    })
})

describe("the key store", () => {
    test("issues a record with no secret field on it", async () => {
        const store = await tempStore()
        const secret = newKeySecret()
        const record = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "my browser",
            fingerprint: await keyFingerprint(secret),
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        // Read as JSON rather than by naming fields: a `secret` arriving through a conditional
        // spread would type-check and be invisible to a field-by-field assertion, which is the
        // shape this repo has been caught by six times.
        expect(JSON.stringify(record).includes(secret)).toBe(false)
        expect(record.label).toBe("my browser")
        expect(record.revokedAt).toBeUndefined()
        expect(record.lastUsedAt).toBeUndefined()
        await store.close()
    })

    test("finds a live key by fingerprint and not by secret", async () => {
        const store = await tempStore()
        const secret = newKeySecret()
        const fingerprint = await keyFingerprint(secret)
        const issued = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint,
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        expect((await store.operatorKeys.findLive(fingerprint))?.keyId).toBe(issued.keyId)
        expect(await store.operatorKeys.findLive(secret)).toBeUndefined()
        await store.close()
    })

    test("a revoked key stops being findable, and that is the revocation", async () => {
        const store = await tempStore()
        const fingerprint = await keyFingerprint(newKeySecret())
        const issued = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint,
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        await store.operatorKeys.revoke(issued.keyId, "2026-09-17T11:00:00.000Z")
        // The filter is in the statement, not in the caller. A revocation that depends on every
        // reader remembering `revoked_at IS NULL` is one that silently does nothing the first time
        // somebody forgets.
        expect(await store.operatorKeys.findLive(fingerprint)).toBeUndefined()
        await store.close()
    })

    test("revoking is idempotent and keeps the first stamp", async () => {
        const store = await tempStore()
        const issued = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint: await keyFingerprint(newKeySecret()),
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        const first = await store.operatorKeys.revoke(issued.keyId, "2026-09-17T11:00:00.000Z")
        const second = await store.operatorKeys.revoke(issued.keyId, "2026-09-17T12:00:00.000Z")
        expect(first?.revokedAt).toBe("2026-09-17T11:00:00.000Z")
        // A retried DELETE is not a mistake, so it is a success — and it must not rewrite history.
        expect(second?.revokedAt).toBe("2026-09-17T11:00:00.000Z")
        await store.close()
    })

    test("revoking an unknown id answers undefined rather than pretending", async () => {
        const store = await tempStore()
        expect(
            await store.operatorKeys.revoke("k_nope", "2026-09-17T11:00:00.000Z"),
        ).toBeUndefined()
        await store.close()
    })

    test("lists revoked keys rather than hiding them", async () => {
        const store = await tempStore()
        for (const label of ["first", "second"]) {
            await store.operatorKeys.issue({
                keyId: newKeyId(),
                label,
                fingerprint: await keyFingerprint(newKeySecret()),
                createdAt: `2026-09-17T1${label === "first" ? 0 : 1}:00:00.000Z`,
            })
        }
        const all = await store.operatorKeys.list()
        const second = all.find((key) => key.label === "second")
        await store.operatorKeys.revoke(second?.keyId ?? "", "2026-09-17T12:00:00.000Z")
        const after = await store.operatorKeys.list()
        // A revocation whose result cannot be seen is one somebody will perform twice, and the row
        // is the only record that the credential ever existed.
        expect(after.length).toBe(2)
        expect(after.filter((key) => key.revokedAt !== undefined).length).toBe(1)
        // Newest first.
        expect(after[0]?.label).toBe("second")
        await store.close()
    })

    test("liveCount ignores revoked keys", async () => {
        const store = await tempStore()
        const issued = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint: await keyFingerprint(newKeySecret()),
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        expect(await store.operatorKeys.liveCount()).toBe(1)
        await store.operatorKeys.revoke(issued.keyId, "2026-09-17T11:00:00.000Z")
        // What `serve` reads to decide whether a claim is needed. Counting a revoked key here would
        // withhold the bootstrap from a server that has no working credential at all.
        expect(await store.operatorKeys.liveCount()).toBe(0)
        await store.close()
    })

    test("two keys cannot share a fingerprint", async () => {
        const store = await tempStore()
        const fingerprint = await keyFingerprint(newKeySecret())
        await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint,
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        let failed = false
        try {
            await store.operatorKeys.issue({
                keyId: newKeyId(),
                label: "two",
                fingerprint,
                createdAt: "2026-09-17T10:00:01.000Z",
            })
        } catch {
            failed = true
        }
        // The UNIQUE index, and it is load-bearing rather than hygienic: `findLive` returns *one*
        // row, so two rows with one fingerprint would make which key authenticated a request — and
        // therefore which one revoking it kills — a matter of row order.
        expect(failed).toBe(true)
        await store.close()
    })

    test("touch writes once and then not again inside the window", async () => {
        const store = await tempStore()
        const fingerprint = await keyFingerprint(newKeySecret())
        const issued = await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint,
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        await store.operatorKeys.touch(issued.keyId, "2026-09-17T10:00:00.000Z")
        expect((await store.operatorKeys.findLive(fingerprint))?.lastUsedAt).toBe(
            "2026-09-17T10:00:00.000Z",
        )
        // Thirty seconds later, inside the 60 s window: the write is skipped, so the column does
        // not move. This is the whole reason the threshold lives in the store — a per-caller
        // decision about how often to write is how one route keeps a column fresh and another
        // leaves it null.
        await store.operatorKeys.touch(issued.keyId, "2026-09-17T10:00:30.000Z")
        expect((await store.operatorKeys.findLive(fingerprint))?.lastUsedAt).toBe(
            "2026-09-17T10:00:00.000Z",
        )
        // Past it: written.
        await store.operatorKeys.touch(issued.keyId, "2026-09-17T10:02:00.000Z")
        expect((await store.operatorKeys.findLive(fingerprint))?.lastUsedAt).toBe(
            "2026-09-17T10:02:00.000Z",
        )
        await store.close()
    })

    test("purging an agent leaves the keys alone", async () => {
        const store = await tempStore()
        await store.sessions.ensure("milo", "api:someone")
        await store.operatorKeys.issue({
            keyId: newKeyId(),
            label: "one",
            fingerprint: await keyFingerprint(newKeySecret()),
            createdAt: "2026-09-17T10:00:00.000Z",
        })
        await store.purgeAgent("milo")
        /**
         * The one deliberate exception to "every table is keyed by `agent_id`", and it has to be
         * asserted because the honest-looking mistake is the other direction. One `store.db` is
         * shared by every agent in a sandbox root, so deleting one agent taking the operator's
         * credential with it would log them out of the server for the rest — which is a `DELETE`
         * whose real effect nobody asked for.
         */
        expect(await store.operatorKeys.liveCount()).toBe(1)
        await store.close()
    })
})
