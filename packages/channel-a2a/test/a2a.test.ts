/**
 * The A2A plugin's two halves against each other, with a fake channel host standing in for the
 * runtime: what reaches the agent, what a peer gets back, and what a peer is refused.
 */

import { describe, expect, test } from "bun:test"
import type {
    AnyEvent,
    ChannelHost,
    OutboundMessage,
    PluginCaller,
    PluginRouteRequest,
    RawInbound,
    ToolContext,
} from "@dispach/core"
import { toolContext } from "@dispach/core"
import { A2AServer, type A2ATask, a2aTools, RPC, readConfig } from "../src/index.ts"

const CONFIG = readConfig({
    card: { name: "Crew", description: "Triage.", skills: [{ id: "triage", name: "Triage" }] },
    peers: {
        acme: { key: "a2a-acme", ratePerMinute: 3, maxChars: 50 },
        partner: { url: "http://partner.test/a2a", tokenEnv: "PARTNER_TOKEN" },
    },
    waitMs: 500,
})

/** A server whose "agent" answers every message with `reply(text)`, through the channel's own send. */
function serve(reply: (text: string) => string | undefined = (text) => `re: ${text}`) {
    const server = new A2AServer(CONFIG, "crew")
    const transport = server.transport("a2a")
    const received: RawInbound[] = []
    const host = {
        receive(message: RawInbound) {
            received.push(message)
            const text = reply(message.text)
            queueMicrotask(() => {
                if (text === undefined) {
                    server.observe({
                        type: "turn.end",
                        agentId: "crew",
                        sessionKey: `a2a:${message.peerId}`,
                        data: { reason: "error" },
                    } as unknown as AnyEvent)
                    return
                }
                void transport.send({
                    recipient: message.peerId,
                    text,
                    chunkIndex: 0,
                    chunkTotal: 1,
                } as OutboundMessage)
            })
        },
        status() {},
    } as unknown as ChannelHost
    void transport.start(host)
    const call = (
        body: unknown,
        caller: PluginCaller = { kind: "key", keyId: "k1", label: "a2a-acme" },
        headers: Record<string, string> = { "a2a-version": "1.0" },
    ) => {
        const request = new Request("http://silo.test/v1/agents/crew/plugins/a2a/", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
        })
        const routed: PluginRouteRequest = { request, url: new URL(request.url), path: "/", caller }
        return server.rpc(routed)
    }
    return { server, received, call }
}

const send = (text: string, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id: 7,
    method: "SendMessage",
    params: { message: { messageId: `m-${text}`, role: "ROLE_USER", parts: [{ text }], ...extra } },
})

const result = async (response: Response) =>
    (await response.json()) as {
        result?: { task: A2ATask }
        error?: { code: number; message: string }
    }

describe("inbound", () => {
    test("a blocking SendMessage reaches the agent as an agent sender and returns the completed task", async () => {
        const { received, call } = await serve()
        const body = await result(await call(send("hello", { contextId: "ctx1" })))
        expect(received[0]).toMatchObject({
            peerId: "acme:ctx1",
            senderKind: "agent",
            senderHandle: "acme",
            text: "hello",
        })
        expect(body.result?.task.contextId).toBe("ctx1")
        expect(body.result?.task.status.state).toBe("TASK_STATE_COMPLETED")
        expect(body.result?.task.status.message?.parts).toEqual([{ text: "re: hello" }])
    })

    test("the same message sent twice is one task and one turn", async () => {
        const { received, call } = await serve()
        const first = await result(await call(send("once")))
        const again = await result(await call(send("once")))
        expect(again.result?.task.id).toBe(first.result?.task.id ?? "")
        expect(received.length).toBe(1)
    })

    test("a turn that fails fails its task", async () => {
        const { call } = await serve(() => undefined)
        const body = await result(await call(send("break")))
        expect(body.result?.task.status.state).toBe("TASK_STATE_FAILED")
    })

    test("GetTask reaches only the peer's own tasks; CancelTask is refused", async () => {
        const { server, call } = await serve()
        const task = (await result(await call(send("look")))).result?.task
        const get = { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: task?.id } }
        // GetTask answers the Task itself, not SendMessage's `{task}` wrapper.
        const fetched = (await (await call(get)).json()) as { result?: A2ATask }
        expect(fetched.result?.id).toBe(task?.id ?? "")
        const cancel = await result(await call({ ...get, method: "CancelTask" }))
        expect(cancel.error?.code).toBe(RPC.taskNotCancelable)
        void server
    })

    test("refusals: a key that is no peer, a stranger's version, a file part, an oversized or too-frequent message", async () => {
        const { call } = await serve()
        const stranger = await call(send("x"), { kind: "key", keyId: "k9", label: "nobody" })
        expect(stranger.status).toBe(403)
        expect(
            (await result(await call(send("x"), undefined, { "a2a-version": "0.3" }))).error?.code,
        ).toBe(RPC.versionNotSupported)
        expect(
            (await result(await call({ jsonrpc: "2.0", id: 1, method: "Nope" }))).error?.code,
        ).toBe(RPC.methodNotFound)
        const file = {
            ...send("x"),
            params: {
                message: { messageId: "f", role: "ROLE_USER", parts: [{ url: "http://x" }] },
            },
        }
        expect((await result(await call(file))).error?.code).toBe(RPC.contentTypeNotSupported)
        expect((await result(await call(send("y".repeat(60))))).error?.code).toBe(RPC.invalidParams)
        await call(send("third of three"))
        const limited = await call(send("over the limit"))
        expect(limited.status).toBe(429)
    })

    test("the Agent Card names the endpoint and the skills", async () => {
        const server = new A2AServer(CONFIG, "crew")
        const request = new Request("http://silo.test/.well-known/agent-card.json")
        const card = (await server
            .card({ request, url: new URL(request.url), path: "/", caller: { kind: "anonymous" } })
            .json()) as {
            supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[]
            skills: { id: string }[]
        }
        expect(card.supportedInterfaces[0]).toEqual({
            url: "http://silo.test/v1/agents/crew/plugins/a2a/",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
        })
        expect(card.skills.map((s) => s.id)).toEqual(["triage"])
    })
})

describe("outbound: a2a_send", () => {
    test("asks the peer over JSON-RPC and returns its answer; a follow-up continues the same context", async () => {
        const { call } = await serve()
        const sent: {
            url: string
            headers: Record<string, string>
            body: Record<string, unknown>
        }[] = []
        const fetchImpl = async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            sent.push({ url, headers: init.headers as Record<string, string>, body })
            // The partner is the server above, reached as peer "acme".
            return call(body)
        }
        const provider = a2aTools(
            CONFIG,
            fetchImpl,
        )({
            dir: "/tmp",
            env: { PARTNER_TOKEN: "tok" },
            config: {},
            agentId: "local",
        })
        const [tool] = await provider.resolve(["a2a_send"])
        expect(tool?.spec.mutating).toBe(true)
        expect(tool?.spec.trust).toBe("untrusted")
        expect(tool?.spec.parameters.properties.peer?.enum).toEqual(["partner"])
        const context: ToolContext = toolContext({ sessionKey: "local:s1" })
        expect(await tool?.handler({ peer: "partner", text: "status?" }, context)).toBe(
            "re: status?",
        )
        expect(await tool?.handler({ peer: "partner", text: "and now?" }, context)).toBe(
            "re: and now?",
        )
        expect(sent[0]?.url).toBe("http://partner.test/a2a")
        expect(sent[0]?.headers).toMatchObject({
            "a2a-version": "1.0",
            authorization: "Bearer tok",
        })
        const contexts = sent.map(
            (entry) => (entry.body.params as { message: { contextId?: string } }).message.contextId,
        )
        expect(contexts[0]).toBeUndefined()
        expect(typeof contexts[1]).toBe("string")
    })

    test("a peer the manifest does not name is refused, and a missing token is named", async () => {
        const provider = a2aTools(
            CONFIG,
            async () => new Response("{}"),
        )({ dir: "/tmp", env: {}, config: {}, agentId: "local" })
        const [tool] = await provider.resolve(["a2a_send"])
        await expect(tool?.handler({ peer: "evil", text: "x" }, toolContext())).rejects.toThrow(
            "No peer",
        )
        await expect(tool?.handler({ peer: "partner", text: "x" }, toolContext())).rejects.toThrow(
            "PARTNER_TOKEN",
        )
    })
})

describe("config", () => {
    test("two peers on one key, and a relative url, are refused", () => {
        expect(() => readConfig({ peers: { a: { key: "k" }, b: { key: "k" } } })).toThrow(
            "same key",
        )
        expect(() => readConfig({ peers: { a: { url: "/relative" } } })).toThrow("absolute")
    })
})
