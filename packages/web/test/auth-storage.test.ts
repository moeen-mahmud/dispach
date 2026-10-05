/** The operator key lives in sessionStorage; one an earlier version left on disk is moved once (code scanning). */

import { beforeEach, describe, expect, test } from "bun:test"
import { forgetKey, rememberKey, storedKey } from "../src/lib/auth.ts"

function storage() {
    const map = new Map<string, string>()
    return {
        map,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
    }
}

let local = storage()
let session = storage()
beforeEach(() => {
    local = storage()
    session = storage()
    ;(globalThis as { window?: unknown }).window = { localStorage: local, sessionStorage: session }
})

describe("where the key is kept", () => {
    test("a remembered key goes to sessionStorage and never to localStorage", () => {
        rememberKey("dk_new")
        expect(storedKey()).toBe("dk_new")
        expect(local.map.size).toBe(0)
        forgetKey()
        expect(storedKey()).toBeUndefined()
    })

    test("a key an earlier version left in localStorage moves into the tab, once", () => {
        local.setItem("dispach.key", "dk_old")
        expect(storedKey()).toBe("dk_old")
        expect(local.map.size).toBe(0)
        expect(session.getItem("dispach.key")).toBe("dk_old")
    })
})
