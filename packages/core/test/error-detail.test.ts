/**
 * A provider's own words travel beside the message, not in it (pilot.14, VelaCrew): AWS's access
 * refusal names the assumed-role ARN. Asserted at the far end, the stored turn, because a field
 * dropped by one conditional spread on the way is the shape this repo keeps finding.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { ModelError } from "../src/errors.ts"
import type { ModelTransport } from "../src/model/transport.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const ARN = "User: arn:aws:sts::123456789012:assumed-role/silo/s is not authorized"

describe("error detail", () => {
    test("reaches the turn row and the error event, and stays out of the message", async () => {
        const dir = mkdtempSync(join(tmpdir(), "error-detail-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: denied
model:
  main:
    id: some.model
    api: refusing
limits:
  turnTimeoutMs: 5000
`,
        )
        const transport: ModelTransport = {
            create: (context) => ({
                id: context.id,
                // biome-ignore lint/correctness/useYield: a transport that refuses before any output
                async *chat() {
                    throw new ModelError({
                        code: "model_access_denied",
                        message: "Bedrock refused some.model: these credentials may not invoke it.",
                        hint: "Check the role.",
                        detail: ARN,
                        status: 403,
                    })
                },
            }),
        }
        const runtime = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            store: ":memory:",
            env: {},
            modelTransports: { refusing: transport },
        })
        const errors: unknown[] = []
        runtime.bus.on("error", (event) => errors.push(event.data))
        const result = await runtime.agent("denied").send("hi")
        const row = await runtime.store.turns.get(result.turnId)
        await runtime.stop()

        expect(result.error?.detail).toBe(ARN)
        expect(result.error?.message).not.toContain("arn:aws")
        expect(row?.errorDetail).toBe(ARN)
        expect(row?.errorMessage).not.toContain("arn:aws")
        expect(JSON.stringify(errors)).toContain("123456789012")
    })
})
