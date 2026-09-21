/**
 * The person's editor over HTTP, and the schedule write that reconciliation used to undo.
 *
 * Both halves of this file are about the same rule: **a check that only one surface performs is a
 * check the two disagree about.** The terminal had `config set` with a confirmation on two fields
 * and `schedules --disable` refusing a manifest-owned row; the API had neither. Putting a browser in
 * front of these routes is what surfaced the second one — the route answered `200` on a change the
 * next boot threw away.
 *
 * Every assertion here was revert-checked: each guard was watched going red with its fix removed,
 * because this repo has four recorded instances of a test that passed with its fix reverted.
 */

import { afterAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupWorkspaces, harness, MANIFEST } from "./harness.ts"

afterAll(cleanupWorkspaces)

/** A manifest with the two blocks the confirmation cases live in, plus a declared schedule. */
const EDITABLE = `${MANIFEST}tools:
  pinned: [now]
  policy:
    deny: ["exec"]
  untrusted:
    onMutate: refuse
limits:
  maxSteps: 6
schedules:
  - id: morning
    kind: cron
    expr: "0 8 * * *"
    task: Say good morning.
    deliver: none
`

test("the listing carries every settable field, its meaning and its current value", async () => {
    const { call } = await harness({ manifest: EDITABLE })
    const body = (await (await call("GET", "/v1/agents/assistant/config")).json()) as {
        editable: boolean
        file: string
        settings: { path: string; means: string; value?: unknown; confirm?: string }[]
    }

    expect(body.editable).toBe(true)
    expect(body.file).toContain("agent.yaml")

    const byPath = new Map(body.settings.map((setting) => [setting.path, setting]))
    // The value comes out of the file, which is the assertion that matters: a listing built from
    // `agent.manifest` would show a validated, expanded object and an editor writing it back would
    // bake the expansion in.
    expect(byPath.get("limits.maxSteps")?.value).toBe(6)
    expect(byPath.get("tools.pinned")?.value).toEqual(["now"])
    // Absent rather than null for a field the file does not set — the same distinction the store
    // draws for `origin`, and what lets a form tell "unset" from "set to nothing".
    expect(byPath.get("model.main.temperature")).not.toHaveProperty("value")
    // Every row explains itself, because the panel is generated from this and a field with no
    // sentence is one nobody can safely change.
    expect(body.settings.every((setting) => setting.means.length > 0)).toBe(true)

    // The two fields a person is asked about, and only those two.
    const confirms = body.settings.filter((s) => s.confirm !== undefined).map((s) => s.path)
    expect(confirms.sort()).toEqual(["tools.policy.deny", "tools.untrusted.onMutate"])

    // And the fields that are in `SETTINGS` but are not dotted paths stay out, or a form would
    // offer a control whose save can only fail.
    expect(byPath.has("channels[].allowFrom")).toBe(false)
    expect(byPath.has("tools.providers.<id>.writeRoots")).toBe(false)
})

test("a set writes the file, applies it, and reports both", async () => {
    const { call, dir, runtime } = await harness({ manifest: EDITABLE })
    const response = await call("PATCH", "/v1/agents/assistant/config", {
        body: { path: "limits.maxSteps", value: "40" },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({ path: "limits.maxSteps", before: 6, after: 40, applied: true })
    // Read out of the **generated file**, at the far end. This repo has needed that guard six times
    // for exactly this shape: every layer individually right and one of them not connected.
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("maxSteps: 40")
    // `applied` is a claim about the running instance, so it is asserted against the running
    // instance rather than against the reply that made it.
    expect(runtime.list().find((agent) => agent.id === "assistant")?.manifest.limits.maxSteps).toBe(
        40,
    )
})

test("the value is read exactly as a terminal reads it", async () => {
    const { call, runtime } = await harness({ manifest: EDITABLE })
    // A list as text. One parser for both surfaces is the whole point: the alternative is one
    // accepting this and the other storing eighteen characters as a tool name.
    const response = await call("PATCH", "/v1/agents/assistant/config", {
        body: { path: "tools.pinned", value: '["now", "memory_write"]' },
    })
    expect(response.status).toBe(200)
    expect(runtime.list()[0]?.manifest.tools?.pinned).toEqual(["now", "memory_write"])
})

test("a field carrying a confirm sentence is refused without one, and nothing is written", async () => {
    const { call, dir } = await harness({ manifest: EDITABLE })
    const response = await call("PATCH", "/v1/agents/assistant/config", {
        body: { path: "tools.untrusted.onMutate", value: "allow" },
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("config_confirm_required")
    // The row's own sentence, so the terminal and the browser ask in the same words.
    expect(body.error.message).toContain("now delete the backups")
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("onMutate: refuse")

    // And it goes through with one. A confirmation that cannot be given is a refusal wearing a
    // question mark.
    const confirmed = await call("PATCH", "/v1/agents/assistant/config", {
        body: { path: "tools.untrusted.onMutate", value: "allow", confirm: true },
    })
    expect(confirmed.status).toBe(200)
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("onMutate: allow")
})

test("a path this surface does not set is refused by name, with the nearest one", async () => {
    const { call } = await harness({ manifest: EDITABLE })
    const body = (await (
        await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "limits.maxStep", value: "40" },
        })
    ).json()) as { error: { code: string; hint: string } }
    expect(body.error.code).toBe("config_path_unknown")
    expect(body.error.hint).toContain("limits.maxSteps")
})

test("allowFrom names the action that sets it rather than denying it exists", async () => {
    // It is a real field in `SETTINGS` and a real thing to want to change. Answering "no such
    // setting" would send somebody looking for a typo in the one field whose absence is almost
    // always why a connected bot answers nobody.
    const { call } = await harness({ manifest: EDITABLE })
    const body = (await (
        await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "channels[].allowFrom", value: "@moeen_m" },
        })
    ).json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("config_path_unknown")
    expect(body.error.message).toContain("config allow")
})

test("an edit that would not validate is refused and the file is untouched", async () => {
    const { call, dir } = await harness({ manifest: EDITABLE })
    const before = readFileSync(join(dir, "agent.yaml"), "utf8")
    const body = (await (
        await call("PATCH", "/v1/agents/assistant/config", {
            body: { path: "limits.maxSteps", value: "not a number" },
        })
    ).json()) as { error: { code: string } }
    expect(body.error.code).toBe("manifest_edit_invalid")
    // "Nothing was written" is the hint's claim, so it is the thing asserted.
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before)
})

test("a schedule the manifest declares refuses a write rather than losing it at the next boot", async () => {
    /**
     * The defect this file was written for. `reconcileSchedules` upserts every declared schedule
     * with `origin: "manifest"` and every field from the file, so a PATCH here was overwritten and a
     * DELETE re-created — `200` from the route, agreement from the listing, and one restart later it
     * was back. The terminal already refused this; the API did not.
     */
    const { call } = await harness({ manifest: EDITABLE })
    const listed = (await (await call("GET", "/v1/agents/assistant/schedules")).json()) as {
        schedules: { id: string; origin: string }[]
    }
    expect(listed.schedules.find((row) => row.id === "morning")?.origin).toBe("manifest")

    const patched = await call("PATCH", "/v1/agents/assistant/schedules/morning", {
        body: { task: "Say good evening." },
    })
    expect(patched.status).toBe(409)
    expect(((await patched.json()) as { error: { code: string } }).error.code).toBe(
        "schedule_manifest_owned",
    )

    const deleted = await call("DELETE", "/v1/agents/assistant/schedules/morning")
    expect(deleted.status).toBe(409)
    expect(((await deleted.json()) as { error: { code: string } }).error.code).toBe(
        "schedule_manifest_owned",
    )

    // Still there, and still the manifest's — the refusal is only worth anything if the row survived
    // it, and a DELETE that removed the row before reading it could not have refused at all.
    const after = (await (await call("GET", "/v1/agents/assistant/schedules")).json()) as {
        schedules: { id: string; task: string }[]
    }
    expect(after.schedules.find((row) => row.id === "morning")?.task).toBe("Say good morning.")
})

test("a schedule the API created is still fully editable", async () => {
    // The other direction, and the reason the guard reads the row's origin rather than refusing
    // every write: a schedule nobody declared in a file is exactly what this surface is for.
    const { call } = await harness({ manifest: EDITABLE })
    const created = await call("POST", "/v1/agents/assistant/schedules", {
        body: {
            id: "hourly",
            kind: "every",
            expr: "1h",
            task: "Check the queue.",
            deliver: "none",
        },
    })
    expect(created.status).toBe(201)

    const patched = await call("PATCH", "/v1/agents/assistant/schedules/hourly", {
        body: { task: "Check the queue twice." },
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { task: string }).task).toBe("Check the queue twice.")

    expect((await call("DELETE", "/v1/agents/assistant/schedules/hourly")).status).toBe(200)
})
