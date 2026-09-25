/**
 * Two surfaces on one port.
 *
 * - **`/v1/…` is the operator's**: create, pause, wake, delete silos, mint keys inside them, sum
 *   their usage. Authenticated by the control plane's own token.
 * - **`/silos/:subject/v1/…` is the embedder's**: a reverse proxy to that silo's `/v1`, waking it
 *   first if it is paused, streaming the response through untouched (SSE included). **The caller's
 *   own credential is forwarded and nothing is added**, so the silo — not this process — decides who
 *   a key reaches. A key minted in one silo is simply unknown to every other one.
 *
 * WebSocket upgrades are not proxied in v0; the SSE routes cover the same events.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import {
    createServer,
    type IncomingMessage,
    request,
    type Server,
    type ServerResponse,
} from "node:http"
import { BRAND } from "./brand.ts"
import { type ControlPlane, checkSubject } from "./control.ts"
import { ControlError } from "./placer.ts"
import type { Silo } from "./store.ts"

/** Never forwarded: they describe one hop, not the request. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
])

const digest = (value: string) => createHash("sha256").update(value).digest()

function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
    })
    res.end(text)
}

function fail(res: ServerResponse, error: unknown): void {
    if (error instanceof ControlError) {
        send(res, error.status, {
            error: { code: error.code, message: error.message, hint: error.hint },
        })
        return
    }
    process.stderr.write(
        `internal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    send(res, 500, {
        error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
            hint: "A defect in the control plane, not in the request. The stack is on its stderr.",
        },
    })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    if (text.trim() === "") return {}
    try {
        const value: unknown = JSON.parse(text)
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            return value as Record<string, unknown>
        }
    } catch {
        // Fall through to the refusal.
    }
    throw new ControlError({
        code: "request_body_invalid",
        message: "The body is not a JSON object.",
        hint: 'Send `content-type: application/json` with an object, e.g. {"subject":"user_42"}.',
        status: 400,
    })
}

/** What an operator sees of a silo. Never the token, never the internal address. */
function view(silo: Silo) {
    return {
        subject: silo.subject,
        status: silo.status,
        createdAt: silo.createdAt,
        lastActiveAt: silo.lastActiveAt,
        ...(silo.nextWakeAt === undefined ? {} : { nextWakeAt: silo.nextWakeAt }),
    }
}

/**
 * The runtime's refusal for a bad credential, verbatim (`packages/server/src/respond.ts`), so an
 * unknown subject is indistinguishable from a known one with a wrong key. A copy, because this
 * repository imports nothing from the runtime; `e2e.test.ts` asserts it still matches the real one.
 */
export const UNAUTHORIZED = {
    error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
        hint: "Send Authorization: Bearer <token>, where the token is either the value of the variable named by server.tokenEnv or an operator key from POST /v1/keys. A revoked key, an expired one and a wrong one answer the same way on purpose.",
    },
}

export interface ServerOptions {
    readonly control: ControlPlane
    /** The operator's token for `/v1/…`. */
    readonly token: string
}

export function createControlServer(options: ServerOptions): Server {
    const { control } = options
    const expected = digest(options.token)
    const operator = (req: IncomingMessage): boolean => {
        const header = req.headers.authorization ?? ""
        const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
        return presented !== "" && timingSafeEqual(digest(presented), expected)
    }

    return createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) fail(res, error)
            else res.destroy()
        })
    })

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://control.local")
        const path = url.pathname
        const method = req.method ?? "GET"

        const proxied = /^\/silos\/([^/]+)(\/v1\/.*)$/.exec(path)
        if (proxied !== null) {
            await proxy(
                req,
                res,
                decodeURIComponent(proxied[1] ?? ""),
                `${proxied[2] ?? ""}${url.search}`,
            )
            return
        }

        if (method === "GET" && path === "/v1/health") {
            send(res, 200, { status: "ok", silos: control.store.list().length })
            return
        }

        if (!path.startsWith("/v1/")) {
            send(res, 404, {
                error: {
                    code: "route_not_found",
                    message: `${method} ${path} is not a route.`,
                    hint: "Operator routes are under /v1/silos and /v1/usage; a silo's own API is under /silos/<subject>/v1/.",
                },
            })
            return
        }
        if (!operator(req)) {
            send(res, 401, {
                error: {
                    code: "unauthorized",
                    message: "Operator routes need the control plane's token.",
                    hint: `Send "Authorization: Bearer <token>", the value of ${BRAND.envPrefix}TOKEN. A silo key is for /silos/<subject>/v1/ and is refused here.`,
                },
            })
            return
        }

        if (method === "POST" && path === "/v1/silos") {
            const body = await readJson(req)
            if (typeof body.subject !== "string") {
                throw new ControlError({
                    code: "subject_required",
                    message: "The body has no `subject`.",
                    hint: 'Send {"subject":"<your id for this user or team space>"}. It is how every later call names the silo.',
                    status: 400,
                })
            }
            const { silo, created } = await control.create(body.subject)
            send(res, created ? 201 : 200, { ...view(silo), created })
            return
        }
        if (method === "GET" && path === "/v1/silos") {
            send(res, 200, { silos: control.store.list().map(view) })
            return
        }
        if (method === "GET" && path === "/v1/usage") {
            send(res, 200, await usage(url.searchParams))
            return
        }

        const one = /^\/v1\/silos\/([^/]+)(\/[a-z]+)?$/.exec(path)
        if (one !== null) {
            const subject = decodeURIComponent(one[1] ?? "")
            const action = one[2] ?? ""
            checkSubject(subject)
            if (method === "GET" && action === "") {
                const silo = control.store.get(subject)
                if (silo === undefined) return fail(res, notFound(subject))
                return send(res, 200, view(silo))
            }
            if (method === "POST" && action === "/pause")
                return send(res, 200, view(await control.pause(subject)))
            if (method === "POST" && action === "/wake")
                return send(res, 200, view(await control.wake(subject)))
            if (method === "POST" && action === "/recreate") {
                return send(res, 200, view(await control.recreate(subject)))
            }
            if (method === "GET" && action === "/backup") {
                const tar = await control.backup(subject)
                res.writeHead(200, {
                    "content-type": "application/gzip",
                    "content-disposition": `attachment; filename="${subject}.tar.gz"`,
                })
                // A failure after the first byte cannot become a status code, so it breaks the
                // connection instead: a backup that did not finish must never end cleanly.
                tar.on("error", (error) => {
                    process.stderr.write(`backup ${subject}: ${error.message}\n`)
                    res.destroy(error)
                })
                tar.pipe(res)
                await new Promise((resolve) => res.on("close", resolve))
                return
            }
            if (method === "PUT" && action === "/backup") {
                return send(res, 200, view(await control.restore(subject, req)))
            }
            if (method === "DELETE" && action === "") {
                await control.remove(subject)
                return send(res, 200, { subject, deleted: true })
            }
            if (method === "POST" && action === "/keys") {
                // Minted by the silo itself, with the silo's token: the scope rules are the silo's.
                const body = await readJson(req)
                const silo = control.store.get(subject)
                if (silo === undefined) return fail(res, notFound(subject))
                const release = control.hold(subject)
                try {
                    const awake = await control.ensureAwake(silo)
                    const minted = await control.siloFetch(awake, "/v1/keys", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                    })
                    return send(res, minted.status, await minted.json())
                } finally {
                    release()
                }
            }
        }

        send(res, 404, {
            error: {
                code: "route_not_found",
                message: `${method} ${path} is not a route.`,
                hint: "See the README's route table.",
            },
        })
    }

    async function proxy(
        req: IncomingMessage,
        res: ServerResponse,
        subject: string,
        rest: string,
    ): Promise<void> {
        // Refused before any wake: a request with no credential cannot succeed, so it must not cost a
        // silo its sleep. And an unknown subject answers exactly as the silo would to a bad key, so the
        // proxy is not a way to learn which subjects exist.
        const silo = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(subject)
            ? control.store.get(subject)
            : undefined
        if (req.headers.authorization === undefined || silo === undefined) {
            send(res, 401, UNAUTHORIZED)
            return
        }
        const release = control.hold(subject)
        res.on("close", release)
        const awake = await control.ensureAwake(silo)
        const target = new URL(rest, awake.baseUrl)
        const headers: Record<string, string | string[]> = {}
        for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value
        }
        headers.host = target.host

        await new Promise<void>((resolve) => {
            const upstream = request(target, { method: req.method ?? "GET", headers }, (answer) => {
                const out: Record<string, string | string[]> = {}
                for (const [key, value] of Object.entries(answer.headers)) {
                    if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value
                }
                res.writeHead(answer.statusCode ?? 502, out)
                // A stream flushes each frame as it arrives; nothing here buffers.
                res.flushHeaders()
                answer.pipe(res)
                answer.on("end", resolve)
                answer.on("error", resolve)
            })
            upstream.on("error", (error) => {
                if (!res.headersSent) {
                    fail(
                        res,
                        new ControlError({
                            code: "silo_unreachable",
                            message: `Silo "${subject}" did not answer: ${error.message}.`,
                            hint: "Retry; if it persists, POST /v1/silos/<subject>/wake re-reads the silo's address.",
                            status: 502,
                        }),
                    )
                } else {
                    res.destroy()
                }
                resolve()
            })
            // A client that hangs up on a stream closes the upstream too; the *turn* is detached in
            // the silo and carries on, which is the runtime's contract.
            res.on("close", () => upstream.destroy())
            req.pipe(upstream)
        })
    }

    /**
     * Every silo's usage, side by side. A paused silo is woken to answer — its figures cannot have
     * changed while it slept, but only it can say what they are — and goes back to sleep on the next
     * idle sweep. At pilot scale that is cheap; at scale this wants a cached snapshot taken at pause.
     */
    async function usage(query: URLSearchParams) {
        const forwarded = new URLSearchParams()
        for (const key of ["by", "from", "to"]) {
            const value = query.get(key)
            if (value !== null) forwarded.set(key, value)
        }
        const suffix = forwarded.size === 0 ? "" : `?${forwarded}`
        const silos: unknown[] = []
        const failed: unknown[] = []
        for (const silo of control.store.list()) {
            const release = control.hold(silo.subject)
            try {
                const awake = await control.ensureAwake(silo)
                const response = await control.siloFetch(awake, `/v1/usage${suffix}`)
                const body = (await response.json()) as Record<string, unknown>
                if (response.ok) silos.push({ subject: silo.subject, ...body })
                else failed.push({ subject: silo.subject, ...body })
            } catch (error) {
                failed.push({
                    subject: silo.subject,
                    error:
                        error instanceof ControlError
                            ? { code: error.code, message: error.message, hint: error.hint }
                            : {
                                  code: "internal_error",
                                  message: String(error),
                                  hint: "See stderr.",
                              },
                })
            } finally {
                release()
            }
        }
        return { silos, failed }
    }
}

function notFound(subject: string): ControlError {
    return new ControlError({
        code: "silo_not_found",
        message: `No silo for "${subject}".`,
        hint: "Create it with POST /v1/silos {subject}. Subjects are case-sensitive.",
        status: 404,
    })
}
