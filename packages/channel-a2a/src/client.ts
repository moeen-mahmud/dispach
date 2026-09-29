/**
 * The outbound half: `a2a_send(peer, text)`, a pinned tool that sends one message to a peer and returns
 * its answer.
 *
 * `peer` is an enum of the manifest's names, never a URL, so the model cannot be talked into calling
 * somewhere new — the same reason `web_fetch` has no setting for private addresses. It is `mutating`
 * (it causes a remote agent to act) and `untrusted` (the answer is a stranger's text), so the write gate
 * applies to it and to anything after it in the turn. `policyArg: "peer"` makes a rule such as
 * `deny: ["a2a_send(partner)"]` expressible.
 */

import { randomUUID } from "node:crypto"
import { HarnessError, type Tool, type ToolProviderFactory } from "@dispach/core"
import type { A2AConfig } from "./config.ts"
import { type A2ATask, isTerminal, PROTOCOL_VERSION } from "./server.ts"

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** A peer's answer, as text. A task still running says so rather than pretending to be an answer. */
function answerOf(result: unknown): string {
    const record = (typeof result === "object" && result !== null ? result : {}) as {
        message?: { parts?: { text?: string }[] }
        task?: A2ATask
    }
    const words = (parts: readonly { text?: string }[] | undefined) =>
        (parts ?? [])
            .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
            .join("\n")
    if (record.message !== undefined) return words(record.message.parts)
    const task = record.task
    if (task === undefined) return "The peer answered with nothing readable."
    if (!isTerminal(task.status.state)) {
        return `The peer is still working on it (task ${task.id}, ${task.status.state}). It has not answered yet.`
    }
    const text =
        words(task.status.message?.parts) ||
        task.artifacts.map((artifact) => words(artifact.parts)).join("\n")
    if (task.status.state !== "TASK_STATE_COMPLETED") {
        return `The peer's task ended ${task.status.state}${text === "" ? "" : `: ${text}`}.`
    }
    return text === "" ? "The peer finished without saying anything." : text
}

export function a2aTools(config: A2AConfig, fetchImpl: FetchLike = fetch): ToolProviderFactory {
    const outbound = config.peers.filter((peer) => peer.url !== undefined)
    // One context per conversation and peer, so a follow-up reaches the same conversation over there.
    const contexts = new Map<string, string>()
    return (context) => {
        const tool: Tool = {
            spec: {
                slug: "a2a_send",
                provider: "a2a",
                summary: "Sends a message to another agent and returns its answer.",
                whenToUse: `a task needs another agent's help and that agent is one of: ${outbound.map((peer) => peer.name).join(", ") || "(none configured)"}`,
                whenNotToUse:
                    "for anything you can answer yourself, or to reach anyone not in the peer list",
                mutating: true,
                trust: "untrusted",
                policyArg: "peer",
                tags: ["a2a", "agent"],
                parameters: {
                    type: "object",
                    properties: {
                        peer: {
                            type: "string",
                            enum: outbound.map((peer) => peer.name),
                            description: "Which agent to ask, by the name the manifest gives it.",
                        },
                        text: {
                            type: "string",
                            description: "The message, as you would write it to a colleague.",
                        },
                    },
                    required: ["peer", "text"],
                },
            },
            async handler(args, call) {
                const peer = outbound.find((candidate) => candidate.name === args.peer)
                if (peer?.url === undefined) {
                    throw new HarnessError({
                        code: "a2a_peer_unknown",
                        message: `No peer "${String(args.peer)}" to send to.`,
                        hint: `The peers this agent may call are: ${outbound.map((p) => p.name).join(", ") || "none"}. Another needs a url in the plugin's peers.`,
                    })
                }
                const token = peer.tokenEnv === undefined ? undefined : context.env[peer.tokenEnv]
                if (peer.tokenEnv !== undefined && (token === undefined || token === "")) {
                    throw new HarnessError({
                        code: "a2a_peer_token_missing",
                        message: `Peer ${peer.name} needs ${peer.tokenEnv}, which is not set.`,
                        hint: `Put the key ${peer.name} issued to this agent in ${peer.tokenEnv}, in the .env beside the manifest.`,
                    })
                }
                const key = `${call.sessionKey}\u001f${peer.name}`
                const timeout = AbortSignal.timeout(
                    Math.max(1_000, Math.min(60_000, call.deadlineMs - 5_000)),
                )
                let response: Response
                try {
                    response = await fetchImpl(peer.url, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "a2a-version": PROTOCOL_VERSION,
                            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                        },
                        body: JSON.stringify({
                            jsonrpc: "2.0",
                            id: randomUUID(),
                            method: "SendMessage",
                            params: {
                                message: {
                                    messageId: randomUUID(),
                                    role: "ROLE_USER",
                                    parts: [{ text: String(args.text ?? "") }],
                                    ...(contexts.has(key) ? { contextId: contexts.get(key) } : {}),
                                },
                            },
                        }),
                        signal: AbortSignal.any([call.signal, timeout]),
                    })
                } catch (error) {
                    throw new HarnessError({
                        code: "a2a_peer_unreachable",
                        message: `Peer ${peer.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
                        hint: `Check ${peer.url} is reachable from this runtime; a timeout is 60 seconds at most.`,
                    })
                }
                const body = (await response.json().catch(() => ({}))) as {
                    result?: unknown
                    error?: { code?: number; message?: string }
                }
                if (body.error !== undefined || !response.ok) {
                    throw new HarnessError({
                        code: "a2a_peer_refused",
                        message: `Peer ${peer.name} refused: ${body.error?.message ?? `HTTP ${response.status}`}`,
                        hint: "A 401 or 403 means the token in the peer's tokenEnv is wrong; anything else is the peer's own error, quoted.",
                    })
                }
                const contextId =
                    (
                        body.result as {
                            task?: { contextId?: string }
                            message?: { contextId?: string }
                        }
                    )?.task?.contextId ??
                    (body.result as { message?: { contextId?: string } })?.message?.contextId
                if (typeof contextId === "string") contexts.set(key, contextId)
                return answerOf(body.result)
            },
        }
        return {
            id: "a2a",
            resolve: async (slugs) => (slugs.includes("a2a_send") ? [tool] : []),
        }
    }
}
