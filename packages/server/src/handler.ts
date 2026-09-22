/**
 * The wire protocol, as a `(Request) => Promise<Response>`.
 *
 * A plain function rather than a bound server, and that is the design decision worth defending: a
 * handler can be exercised in full without opening a port, so every route in `04-SPEC-WIRE.md` is
 * tested by constructing a `Request` and asserting on a `Response`. Binding is `serve.ts`'s job and
 * is four lines per runtime. Tests that need a real socket are then only the ones about sockets.
 *
 * **A turn is not bound to the connection that started it.** `POST /messages` runs the turn
 * detached and returns immediately; disconnecting an SSE stream unsubscribes a listener and nothing
 * else. The only thing that ends a turn early is `POST /stop`. This is core to the spec and it is
 * why `TurnStreams` exists — a client that comes back has to be able to find out what it missed.
 */

import { readFile } from "node:fs/promises"
import type { Capability as Cap, KeyScope } from "@dispach/core"
import {
    type Agent,
    type AgentStateRecord,
    type AnyEvent,
    type ErrorDetail,
    EVENT_TYPES,
    editManifest,
    entryPhase,
    HarnessError,
    isHarnessError,
    isPhased,
    keyFingerprint,
    keyLabelProblem,
    MAX_KEY_LABEL,
    manifestValueAt,
    nearest,
    newKeyId,
    newKeySecret,
    newRunId,
    newTurnId,
    PERSON_SETTABLE_PATHS,
    parseSettingValue,
    phasesFor,
    prepareScheduleWrite,
    type Runtime,
    type ScheduleRecord,
    SENDER_KINDS,
    SETTINGS,
    type SenderKind,
    scheduleSessionKey,
    settingByPath,
    type TurnRecord,
    type TurnSender,
    VERSION,
} from "@dispach/core"
import { type ApprovalRegistry, createApprovalRegistry } from "./approvals.ts"
import { authorise } from "./auth.ts"
import type { ClaimTicket } from "./keys.ts"
import { openapiDocument } from "./openapi.ts"
import {
    corsHeaders,
    isLoopback,
    type OriginPolicy,
    originProblem,
    preflightHeaders,
} from "./origin.ts"
import { can, isScoped, type Principal, reachesAgent, reachesSession } from "./principal.ts"
import { claimSpent, fail, forbidden } from "./respond.ts"
import { Router } from "./router.ts"
import { sseResponse } from "./sse.ts"
import { serveAsset, WEB_PATHS } from "./web.ts"
import {
    ApprovalBody,
    ChannelPatchBody,
    ConfigBody,
    KeyBody,
    MessageBody,
    PhaseBody,
    ProvisionBody,
    parseBody,
    StopBody,
} from "./wire-schemas.ts"

/** Bodies larger than this are refused before a channel plugin sees them. */
const MAX_BODY_BYTES = 1_000_000

/**
 * Caps on the sender fields and the idempotency key.
 *
 * Small, and each for a stated reason rather than for tidiness. The id is rendered into the
 * prompt's fence label, so an unbounded one spends the window the message needs. The name is
 * rendered inside the fence and is attacker-supplied in exactly the case the fence exists for, so
 * it is truncated rather than refused — a long display name is rude, not an error. The key is a
 * database key with a unique index over it.
 */
const MAX_SENDER_ID = 256
const MAX_SENDER_NAME = 128
const MAX_IDEMPOTENCY_KEY = 255

export interface HandlerOptions {
    readonly runtime: Runtime
    /**
     * Bearer token. Absent means unauthenticated, which `createServer` permits only on loopback.
     *
     * The check is here rather than only at bind time so an embedder mounting this handler behind
     * its own router cannot accidentally expose it — the handler refuses to be built without either
     * a token or an explicit `allowUnauthenticated`.
     */
    readonly token?: string
    /** Required to build a token-less handler. Names the decision rather than defaulting it. */
    readonly allowUnauthenticated?: boolean
    /** Injectable for tests. Defaults to `Date.now`. */
    readonly now?: () => number
    /**
     * In-flight turns this process can cancel, shared with every other surface that starts one.
     *
     * Passed in rather than owned, because the WebSocket bridge starts turns too and kept its own
     * map — so a turn started over HTTP could not be stopped from a socket, and one started over a
     * socket answered 409 on `POST /stop`. Two registries meant the answer to "can this be
     * stopped" depended on which door the question came through, which is not a property of the
     * turn. `serve.ts` creates one and hands it to both.
     *
     * It still does not reach a turn a channel or a schedule started: nothing in core records
     * in-flight turns, so there is no handle to share. The 409 says exactly that.
     */
    readonly running?: Map<string, AbortController>
    /**
     * Where a blocked call's question waits for an answer.
     *
     * Created **before** the runtime, because `Runtime.create({ approve })` needs the registry's
     * approver and a runtime cannot hand back the function it was constructed with. That ordering
     * is why this is passed in rather than owned here, and why the CLI creates it rather than
     * `serve` — the same reason the `running` map is shared, one layer further out.
     *
     * Absent is a coherent state, not a broken one: nothing is ever pending, so every answer gets
     * `approval_not_found` and the routes still exist and still say something true. An agent whose
     * runtime was built without an approver keeps its `confirm_without_approver` warning, which is
     * the honest signal that no question can be asked here.
     */
    readonly approvals?: ApprovalRegistry
    /**
     * The one-time bootstrap credential, when this boot printed one.
     *
     * Created by the caller that prints it, for the reason `running` and `approvals` are: a handler
     * that minted one could not hand it back to be shown, and the printing is the entire mechanism.
     *
     * Absent is the ordinary state — a server whose key table is already populated has nothing to
     * bootstrap, and printing a fresh claim at every boot would leave a standing credential in the
     * logs, which is the opposite of what a one-time ticket is for.
     */
    readonly claim?: ClaimTicket
    /**
     * What the bind is, so the origin guard can decide how strict to be.
     *
     * Optional because a great many tests build a handler with nothing but a runtime, and a guard
     * that refused those would be a guard nobody could write a test around. Absent means **no
     * origin checking at all**, which is the honest reading of "the caller did not say what it
     * bound" — `serve` always passes it, so every real server is covered, and
     * `spec.test.ts` asserts that it does.
     */
    readonly origin?: OriginPolicy
    /**
     * How to find the manifest for an agent this process is **not** hosting.
     *
     * `POST /v1/agents/:id/start` has to hand `Runtime.adopt` a source, and a stopped agent is by
     * definition absent from the runtime — so the source has to come from wherever agents live,
     * which is the sandbox layout in `cli/lib/sandbox.ts`. `packages/server` may not import the
     * CLI, so the CLI injects the lookup. The same seam 16.5's provisioning route needs, built
     * once for whichever stage lands first.
     *
     * Absent is a coherent state and answers `501` naming the reason: an embedder composing this
     * handler over its own agent store has no sandbox to search, and inventing a path convention
     * for it would be a guess about somebody else's filesystem.
     *
     * ⚠️ **Not the container**, despite what this comment said when it was written: the CLI's
     * `serve` injects this unconditionally, so the image has it — and that is correct, because the
     * container's sandbox is a real place an agent can live and `start <agent>` there should work.
     * Found while writing 16.5, which repeated the same wrong claim about its own callback.
     */
    readonly resolveAgent?: (agentId: string) => string | undefined
    /**
     * How to create an agent, injected by whoever knows how.
     *
     * `POST /v1/agents` writes a directory of files from a wizard's own question set, and that
     * wizard — its steps, its validation, its templates — lives in `packages/cli`. `packages/server`
     * may not import the CLI, so the server owns the **route, the wire shape and the gate** and the
     * CLI supplies the implementation. Three things follow, and the second is the one worth having:
     *
     * 1. No dependency edge, and no move of a large module that would need re-testing wholesale.
     * 2. An embedder over its own agent store passes none, and the route then says `501` rather
     *    than accepting a request and writing nothing.
     *
     *    ⚠️ **The container is *not* covered by this**, and the plan's claim that it would be was
     *    wrong: the CLI's `serve` injects a provisioner unconditionally, so the image has one. What
     *    actually refuses provisioning there is the **loopback gate** — the image's `CMD` binds
     *    `0.0.0.0`, so `provisioningIsLocal()` is false and the route answers `403`. Checked by
     *    reading the Dockerfile rather than assumed, and it is the better of the two mechanisms:
     *    it is a fact about what was bound rather than about what somebody remembered to omit.
     * 3. `steps` comes *from the callback*, so a browser renders the same question set the terminal
     *    asks and the two cannot drift. A hard-coded list in the page would be the "two hand-kept
     *    lists" shape that has already cost this repo several rounds.
     *
     * Absent answers `501`, which is honest: a server with no provisioner cannot create an agent
     * and should say so rather than accept a request and write nothing.
     */
    readonly provision?: Provisioner
    /**
     * What the CLI injects for the channel actions. Absent answers `501`.
     *
     * Injected for the same reason `provision` is: these write the manifest and the `.env` beside
     * it, and *how* is the CLI's — `editManifest` for one, `applySecret` at `0600` for the other,
     * both already reached by `dispach channels`. A second implementation here is how two surfaces
     * come to disagree about what "disconnect" means, which is the failure this project keeps
     * finding rather than a hypothetical.
     */
    readonly channels?: ChannelAdmin
}

/** What the CLI injects for the channel routes. See `HandlerOptions.channels`. */
export interface ChannelAdmin {
    /**
     * Switch a channel on or off in the manifest.
     *
     * Read-modify-write, so a caller sends a flag rather than the whole `channels` list. Sending the
     * list is right for a person editing YAML and wrong for a button: the browser would be
     * reconstructing an array it did not author, and two clients racing on that lose an entry rather
     * than a flag.
     */
    setEnabled(
        manifestPath: string,
        channelId: string,
        enabled: boolean,
    ): Promise<{ readonly note: string; readonly changed: boolean }>
    /**
     * Write the channel's credential into the `.env` beside the manifest.
     *
     * The **variable is resolved from the manifest**, never taken from the caller. A route that let
     * a client name the variable would let it write any variable at all, including the token this
     * server authenticates with.
     */
    setCredential(
        manifestPath: string,
        channelId: string,
        value: string,
    ): { readonly note: string; readonly variable: string }
    /** Delete a stored pairing on disk, for an agent that is not running. */
    unpair(manifestPath: string, channelId: string): { readonly note: string }
}

/** What the CLI injects for `POST /v1/agents`. See `HandlerOptions.provision`. */
export interface Provisioner {
    /** Every question, in asking order, with defaults and choices. Served as-is. */
    steps(): readonly ProvisionStepWire[]
    /**
     * Create the agent and return where it landed.
     *
     * Throws a `HarnessError` for a bad answer, an unknown step, or a collision — the route maps
     * those to `400` and passes the hint through, because the implementation knows why far better
     * than the route does.
     */
    create(answers: Readonly<Record<string, string>>): {
        readonly agentId: string
        readonly manifestPath: string
        readonly dir: string
        readonly files: readonly string[]
    }
}

/** One question as the wire carries it. Structural, so `packages/cli` needs no import from here. */
export interface ProvisionStepWire {
    readonly step: string
    readonly prompt: string
    /**
     * The default, as a value a client may send back — never a menu index.
     *
     * A client renders `choices` as a control and needs a default that is one of them. The
     * implementation resolves it through the same validator the route applies to the answer, so a
     * served default cannot be a value `POST /v1/agents` would reject.
     */
    readonly fallback: string
    readonly optional: boolean
    /** Mask it. A secret answer is written once at `0600` and never read back by any route. */
    readonly secret: boolean
    /**
     * What opens this step, absent when it is always asked.
     *
     * The wizard's walk skips a question whose opening answer was not given, and that is a
     * condition a form cannot see. Declaring it lets a client render the whole question set and
     * reveal a field when the choice that opens it is picked, instead of re-implementing the walk —
     * which is the second-hand-kept-list shape this route exists to prevent.
     *
     * **Transitive:** a step is askable when its requirement is met *and* the step it names is
     * itself askable. Only the nearest opening choice is recorded.
     */
    readonly requires?: {
        readonly step: string
        readonly value: string
    }
    readonly choices?: readonly {
        readonly value: string
        readonly label: string
        readonly hint?: string
    }[]
}

type Handler = (context: RequestContext) => Promise<Response> | Response

interface RequestContext {
    readonly request: Request
    readonly url: URL
    readonly params: Readonly<Record<string, string>>
    /**
     * Who is calling. **Required**, which is the point.
     *
     * An optional field would be one a route could forget to consult, and a route that forgets is a
     * route with no boundary — the failure mode being that a scoped credential silently reaches
     * something it was minted not to. `open` is a real member for the two honest cases: a route that
     * needs no credential, and a server that requires none.
     */
    readonly principal: Principal
}

/**
 * The reference page. Two script tags and a `noscript`, and nothing else.
 *
 * Inline rather than an asset file because it is 1 KB and because `WEB_ASSETS` is a table the spec
 * guard checks — adding an entry there for a page with no build step would be a route and a table
 * row for one string. The `noscript` is load-bearing: with no network the page is blank, and a
 * blank page with no explanation is indistinguishable from a broken server.
 */
const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispach API</title>
</head>
<body style="margin:0">
<noscript style="display:block;font:14px/1.5 system-ui;padding:2rem;max-width:40rem">
  <h1 style="font-size:1rem">This page needs JavaScript and a network</h1>
  <p>It loads the reference viewer from a CDN. The document itself is served locally and needs
  neither: <a href="/v1/openapi.json">/v1/openapi.json</a>.</p>
</noscript>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
<script>
  Scalar.createApiReference('#app', { url: '/v1/openapi.json', theme: 'default' })
</script>
</body>
</html>
`

/**
 * The HTTP handler, with the authenticator it built hung off it.
 *
 * The WebSocket upgrade has to authenticate the *same* way, and every input that decides it —
 * the configured token, the key store, the boot claim, and the latch that says whether a
 * credential is required at all — is composed in here. Handing the function back is what stops
 * `serve.ts` assembling a second copy of that rule, which is how `/v1/ws` came to have its own
 * comparison in the first place.
 *
 * A property on the function rather than a returned object, so every existing caller — and every
 * embedder mounting this in their own stack — keeps passing it straight to `Bun.serve` unchanged.
 */
export type ServerHandler = ((request: Request) => Promise<Response>) & {
    /** Resolve a credential without dispatching. `Response` is a refusal. */
    readonly authenticate: (request: Request) => Promise<Principal | Response>
}

export function createHandler(options: HandlerOptions): ServerHandler {
    const { runtime } = options
    const token = options.token
    const now = options.now ?? (() => Date.now())
    const startedAt = now()

    if (token === undefined && options.allowUnauthenticated !== true) {
        throw new HarnessError({
            code: "server_token_missing",
            message: "createHandler was called with no token and no allowUnauthenticated.",
            hint: "Pass token, or pass allowUnauthenticated: true to state that this handler is mounted somewhere already protected. Defaulting to open would make the safe configuration the one you have to remember.",
        })
    }

    /** In-flight turns, so `POST /stop` has something to cancel. Shared when one is supplied. */
    const running = options.running ?? new Map<string, AbortController>()
    /**
     * Pending approvals. An empty one is correct when nothing wired an approver.
     *
     * Defaulted rather than left optional so the routes have one code path. The alternative was a
     * branch answering `501 no_approver` — which reads as a missing feature when the truth is that
     * this deployment chose not to attach one, and the agent's own `confirm_without_approver`
     * warning already says so where somebody is looking.
     */
    const approvals = options.approvals ?? createApprovalRegistry()

    /**
     * Whether this server demands a credential — and a **latch**, not a running check.
     *
     * A configured token has always meant yes. The addition is that a live operator key means yes
     * too, and that is the subtle half: without it, minting a key on a token-less loopback server
     * would do *nothing*, so a browser could show a credential list and a key-management page on a
     * server that every process on the machine can reach unauthenticated. That is the "looks
     * protected and is not" shape, and it is worse than being plainly open.
     *
     * It latches **on** and never off. Revoking the last key on a token-less server does not reopen
     * it, and that is deliberate in the safe direction: the alternative is a `DELETE` whose real
     * effect is to remove authentication from every route, which is not what anybody revoking a
     * credential is asking for. A server meant to be open is one started with no keys.
     *
     * The latch is also what keeps this off the hot path. With a token configured it answers from
     * the first condition and never reads the database; with keys present it reads once per process.
     * Only the genuinely open case asks each time, where the query is a count over an index on a
     * table with no rows in it.
     */
    /**
     * The origin guard, closed over the bind. `undefined` policy means the caller did not say what
     * it bound, and a claim about cross-origin safety cannot be made from nothing.
     */
    /**
     * Whether this handler was bound to loopback, for the provisioning gate.
     *
     * Read from the **origin policy's host**, which is the bind `serve` actually performed — not
     * from the request's `Host` header, which an attacker controls, and not from a separate option
     * a caller could set inconsistently with what it bound. `origin` being absent means the caller
     * did not say what it bound, and the honest reading of that is *not local*: a handler mounted
     * inside somebody else's router is the case that must not get a filesystem write for free.
     */
    const provisioningIsLocal = (): boolean =>
        options.origin !== undefined && isLoopback(options.origin.host)

    /**
     * May this caller create an agent?
     *
     * **The bind alone was the wrong question, and it refused the safer of the two cases.** A
     * token-less loopback server allowed provisioning while a token-authenticated `0.0.0.0` one
     * refused it — so the gate was strictest exactly where a credential had been presented and
     * loosest where none had. The container is the second case, which made the browser onboarding
     * panel the one panel structurally impossible in the only deployment that ships with it: the
     * page opened, the claim exchanged, and the first screen was a refusal.
     *
     * So the risk is named properly. What must never be reachable from the network is provisioning
     * on a server that asked for **no** credential at all, which is `kind: "open"` — the route's
     * declared `capability: "admin"` cannot speak to that, because an open principal reaches
     * everything by definition. An authenticated caller holding `admin` is precisely the case
     * 18.2's scoped keys were built for, and precisely what this route's own refusal has been
     * promising in its hint since it was written.
     *
     * `can` is consulted rather than assumed from the route's capability: this reads as its own
     * decision at the one place it is made, and a future route sharing this predicate inherits the
     * check rather than the assumption.
     */
    const mayProvision = (who: Principal): boolean =>
        provisioningIsLocal() || (who.kind !== "open" && can(who, "admin"))

    const refuseOrigin = (request: Request): Response | undefined => {
        if (options.origin === undefined) return undefined
        const problem = originProblem(request, options.origin)
        return problem === undefined ? undefined : fail(problem, 403)
    }

    /**
     * The `Access-Control-*` headers for a response this server has decided to send.
     *
     * Applied at the **one** place every response leaves through, rather than per route: a header
     * added at 39 call sites is one the fortieth route will not have, and the symptom is a single
     * endpoint that a browser cannot read for no visible reason.
     *
     * No policy means no headers, which is correct rather than lax: a handler mounted inside
     * somebody else's framework did not tell us what it bound, and an `Access-Control-Allow-Origin`
     * we cannot justify is worse than none — theirs is the stack that should be sending it.
     */
    const withCors = (request: Request, response: Response): Response => {
        if (options.origin === undefined) return response
        const extra = corsHeaders(request, options.origin)
        if (Object.keys(extra).length === 0) return response
        const headers = new Headers(response.headers)
        for (const [name, value] of Object.entries(extra)) headers.set(name, value)
        // Rebuilt rather than mutated: a `Response` from `fetch` or from a stream has immutable
        // headers, and mutating one throws at the moment a browser is the only caller who notices.
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        })
    }

    let closed = false
    const authRequired = async (): Promise<boolean> => {
        if (token !== undefined || closed) return true
        closed = (await runtime.store.operatorKeys.liveCount()) > 0
        return closed
    }

    /**
     * Who is calling, and may they reach this route at all.
     *
     * One function for both dispatch sites — the `HEAD` branch and the ordinary one — because two
     * copies of an auth gate is how one of them gains an exemption the other does not. It was two
     * copies before this, and they agreed only because nobody had edited either.
     *
     * Three states come back and each is a different thing. A `Response` is a refusal. A
     * `Principal` is a caller. And `{ kind: "open" }` is the *absence* of a requirement — an open
     * path, or a server that requires no credential at all — which reaches everything, exactly as
     * it did before any of this existed.
     *
     * The capability check happens **here**, not in the routes, and its refusal is `403` while
     * every scope refusal downstream is `404`: a capability answer discloses nothing about what
     * exists, only about what this credential may do.
     */
    const resolve = async (
        request: Request,
        pathname: string,
        capability: Cap | "open",
    ): Promise<Principal | Response> => {
        if (isOpenPath(pathname) || !(await authRequired())) return { kind: "open" }
        const who = await authorise({
            request,
            expected: token,
            keys: runtime.store.operatorKeys,
            claim: options.claim,
            pathname,
            at: now(),
        })
        if (who instanceof Response) return who
        /**
         * A claim skips the capability check, because `authorise` has already made a **stricter**
         * decision: it opens `POST /v1/keys` and nothing else, method and path together.
         *
         * Found by running the suite. `POST /v1/keys` requires `admin`, a claim holds no
         * capabilities, so the gate answered `403` and the entire bootstrap broke — the one flow
         * that has to work on a server with no credentials at all. Layering a capability check on
         * top of a route scope is not "belt and braces" when one of them is a whitelist of exactly
         * one route.
         */
        if (who.kind === "claim") return who
        if (capability !== "open" && !can(who, capability)) {
            return forbidden(capability, `${request.method} ${pathname}`)
        }
        return who
    }

    const router = new Router<Handler>()

    // ─── Health ──────────────────────────────────────────────────────────────────────────

    router.add(
        "GET",
        "/v1/health",
        () =>
            json({
                status: "ok",
                version: VERSION,
                uptimeMs: now() - startedAt,
                agents: runtime.list().length,
            }),
        { capability: "open" },
    )

    /**
     * Readiness flips at `runtime.ready` — *before* channels connect.
     *
     * Deliberate, and spelled out in the spec: a channel that cannot connect must not make the
     * process look dead to an orchestrator, which would restart it into the same outage. Channel
     * state is on the agent resource instead.
     */
    router.add(
        "GET",
        "/v1/ready",
        () => {
            if (runtime.ready) return json({ status: "ready", agents: runtime.list().length })
            // `"starting"`, not `"stopped"`. A runtime that has not reached readiness is on its way up,
            // and "stopped" is what an orchestrator reads as "give up on this container". The
            // `pending: []` this used to carry was a promise nothing filled: agents load inside
            // `Runtime.create`, so there is no moment at which this route can be reached *and* name
            // which agent it is waiting for. An empty array that is always empty says less than
            // omitting it, because a reader cannot tell it from "nothing is pending".
            return json({ status: "starting", agents: runtime.list().length }, 503)
        },
        { capability: "open" },
    )

    // ─── Agents ──────────────────────────────────────────────────────────────────────────

    /**
     * Every agent this server knows about, hosted or not.
     *
     * **A stopped agent is listed, with `status: "disabled"`.** Hiding it would make the listing
     * answer a different question from the one a client is asking — an agent picker showing two
     * entries where the operator configured three has no way to offer "start it again", and the
     * operator's only clue is that something they set up is missing. Same reasoning as `listAgents`
     * showing a broken directory rather than skipping it.
     *
     * The rows are thin on purpose: a disabled agent is not loaded, so there is no manifest in
     * memory to report a model or a channel list from, and loading one to fill the row in would
     * make a listing depend on credentials being present — the defect `readManifestHeader` exists
     * to avoid. The id and the reason are what a client can act on.
     *
     * `GET /v1/agents/:id` still answers **404** for one of these, and the asymmetry is the point:
     * the listing answers "what exists", the resource answers "what is running". A 200 there would
     * have to invent a body for an agent with no tools, no window and no sessions in memory.
     */
    router.add(
        "GET",
        "/v1/agents",
        async (context) => {
            const hosted = runtime.list().map((agent) => summary(runtime, agent))
            const live = new Set(hosted.map((entry) => entry.id))
            const stopped = (await runtime.store.agentState.list())
                .filter((state) => !state.enabled && !live.has(state.agentId))
                .map((state) => ({
                    id: state.agentId,
                    name: state.agentId,
                    status: "disabled" as const,
                    ...(state.reason === undefined ? {} : { reason: state.reason }),
                    ...(state.disabledAt === undefined ? {} : { disabledAt: state.disabledAt }),
                }))
            /**
             * **Filtered by scope, and the stopped rows with it.**
             *
             * A listing is how a client discovers what it can reach, so a narrow key gets an honest
             * answer about *its* world rather than a 403 about somebody else's. Filtering the
             * disabled rows too is the half that is easy to miss: they are built from a different
             * source (`agentState`, not `runtime.list()`), so a filter applied only to `hosted`
             * would leak every *stopped* agent's id to a key scoped away from it — and an id is
             * exactly what this is meant not to disclose.
             */
            return json(visibleAgents(context.principal, [...hosted, ...stopped]))
        },
        { capability: "read" },
    )

    router.add(
        "GET",
        "/v1/agents/:id",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                // Both of these were the literal `0`, for every agent, whatever was configured — and
                // the spec advertises them as "tool count, skills indexed, schedule count". A number
                // that is always zero is worse than an absent field: it reads as a measurement.
                //
                // The schedule count comes from the **store**, which is the reconciled truth — what is
                // armed right now, including rows the API created and rows a disabled manifest entry
                // left behind. That is deliberately a different number from the one `agent.loaded`
                // reports, which is the manifest's declared count because that event fires before
                // reconciliation has run. Two honest numbers about two different moments; the spec
                // says which is which.
                const schedules = await agent.store.schedules.list(agent.id)
                const team = runtime.team(agent.id)
                return json({
                    ...summary(runtime, agent),
                    dialect: agent.describe().dialect,
                    window: agent.window,
                    tools: agent.tools.size,
                    // What the catalogue costs every turn, beside how many tools there are. A count
                    // says nothing about the bill: eight system tools and eight Composio ones differ
                    // by an order of magnitude, and this is the figure a person trims against.
                    catalogueTokens: agent.describe().catalogueTokens,
                    skills: agent.skills?.skills.length ?? 0,
                    schedules: schedules.length,
                    /**
                     * Who this agent delegates to.
                     *
                     * Members are excluded from `GET /v1/agents` and from every route behind
                     * `withAgent`, deliberately: an addressable member is a route around whatever
                     * policy its supervisor carries. This is how they stay *observable* without
                     * becoming reachable — the debugging value of a roster without a way to run one
                     * directly. Absent rather than `[]` for an agent with no team, matching `phases`.
                     */
                    ...(team.length === 0
                        ? {}
                        : {
                              team: team.map((member) => ({
                                  id: member.id,
                                  task: member.task,
                                  // What the supervisor gets back, not the whole schema: a UI showing
                                  // a delegation needs the field names, and the member's own
                                  // `/tools` has the full version.
                                  artifact: Object.keys(member.artifact.properties),
                              })),
                          }),
                    warnings: [...agent.warnings, ...agent.tools.warnings],
                })
            }),
        { capability: "read" },
    )

    /**
     * Re-read one agent's manifest by **replacing the agent**, never by mutating it.
     *
     * This answered 501 for four phases, and the refusal was right about the thing it was arguing
     * against: an agent's configuration is fixed for the lifetime of its *instance* — the catalogue
     * resolves once and slot 1 renders once, so a session's cached prefix stays byte-stable and
     * `config_set` cannot change behaviour underneath a conversation. A *partial* reload that
     * silently did not apply would be worse than saying no, and still would be.
     *
     * `Runtime.replace` is the version that keeps that decision intact: the agent is disposed and
     * re-created from its source, so it gets a **new instance** with its own catalogue and its own
     * frozen prefix. Nothing is mutated. What changes is only who can ask — the CLI's `/restart`
     * rebuilt the whole runtime because it owned one, and an attached view owns nothing.
     *
     * It refuses while a turn is in flight rather than aborting one, which is `dispose`'s rule and
     * not this route's: a reload that killed somebody's half-finished answer to pick up a setting
     * would be a worse trade than waiting. `agent_turn_in_flight` names the count.
     */
    router.add(
        "POST",
        "/v1/agents/:id/reload",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                try {
                    const admitted = await runtime.replace(agent.id)
                    return json({
                        id: agent.id,
                        status: "loaded",
                        // Every agent that came back, because replacing a supervisor replaces its team:
                        // they load from one manifest as one unit, so a caller holding a list needs to
                        // know the members are new instances too.
                        adopted: admitted.map((entry) => entry.id),
                    })
                } catch (error) {
                    // The runtime's own refusals carry the field and the remedy — a team member has no
                    // manifest of its own, a busy agent names its in-flight count. Paraphrasing either
                    // here would replace a precise answer with a vague one.
                    if (isHarnessError(error)) {
                        return fail(
                            {
                                code: error.code,
                                message: error.message,
                                hint: error.hint,
                                ...(error.field === undefined ? {} : { field: error.field }),
                            },
                            error.code === "agent_turn_in_flight" ? 409 : 400,
                        )
                    }
                    throw error
                }
            }),
        { capability: "admin" },
    )

    /**
     * Switch an agent off, durably, and drop it from this host now.
     *
     * Two effects, and both are necessary. The row is what makes it survive a restart — the launchd
     * lesson, where `bootout` unloads a job and only `disable` persists, so a thing stopped the
     * first way comes back at the next login. The `dispose` is what makes the command mean
     * something *today*: since one process hosts several agents, the old answer — kill the process
     * holding the lease — takes every other agent down with it.
     *
     * **Order is state first, then teardown.** A dispose that succeeded before a write that failed
     * would leave the agent down and marked running, which comes back at the next restart with
     * nobody having asked for it. This way round, a failed dispose leaves it marked stopped and
     * still hosted, which the next restart fixes and which `GET /v1/agents` reports honestly.
     *
     * Idempotent: stopping a stopped agent is `200`, not `404`, because the caller asked for a
     * state that already holds. Refused with `409` while a turn is running — `dispose` decides
     * that, and the refusal carries its hint rather than a second copy of the reasoning.
     */
    /**
     * What provisioning needs to ask, straight from the implementation that will answer it.
     *
     * Served even when there is no provisioner — an empty list plus `available: false` is more
     * useful to a client than a `501`, because it can then say "this server cannot create agents"
     * rather than having to interpret a status code. `local` is the other half of that answer: a
     * client on a public bind gets `available: true, local: false` and knows the questions are real
     * and the route will refuse it, which is what the container reports.
     *
     * `/v1/provision` rather than `/v1/agents/steps`: the router matches in registration order and
     * `/v1/agents/:id` is registered above, so a literal under that prefix would be swallowed as an
     * agent id and answered `404 agent_not_found` — a route that exists and cannot be reached.
     */
    /**
     * The generated document, and a browser reference over it.
     *
     * **Open, like `/v1/health`.** A description of which routes exist is not a secret — the spec is
     * in the repository and the client package is published — and gating it would mean a developer
     * cannot read the API of a server they have not yet obtained a credential for, which is the one
     * moment the reference is most useful. It contains no agent ids, no session keys and no
     * configuration: it is generated from the route *table*, not from what this process is hosting.
     *
     * `servers` names the URL this request arrived on, so the page's "try it" calls the server the
     * document came from rather than a hardcoded localhost that is wrong in a container.
     */
    router.add(
        "GET",
        "/v1/openapi.json",
        (context) =>
            json(
                openapiDocument({
                    routes: router.routes(),
                    serverUrl: `${context.url.protocol}//${context.url.host}`,
                }),
            ),
        { capability: "open" },
    )

    /**
     * Scalar, from its CDN, over `/v1/openapi.json`.
     *
     * **The script is remote and that is a stated trade rather than an oversight.** This surface
     * inlines its assets as *text* and ships no binary (11.200), and the browser payload has a
     * measured budget after the 1.18 MB lesson. Scalar's bundle is **3.6 MB raw / 1.0 MB gzipped**,
     * measured rather than guessed — sixteen times this project's entire UI, which is 220 KB. A
     * `.ts` file holding that as a string is not a thing to inline, and vendoring it would need its
     * own ceiling and its own argument. Offline, this page does not
     * render and `/v1/openapi.json` still does, which is the failure mode worth having: the machine-
     * readable half never depends on a network, and the pretty half says so in its own noscript.
     */
    router.add(
        "GET",
        "/docs",
        () =>
            new Response(DOCS_PAGE, {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
            }),
        { capability: "open" },
    )

    router.add(
        "GET",
        "/v1/provision",
        (context) =>
            json({
                available: options.provision !== undefined,
                // A fact about the bind, kept because it is one and because removing a field is a
                // breaking change inside `v: 1`.
                local: provisioningIsLocal(),
                /**
                 * **May *this caller* create an agent** — which is the question a page is actually
                 * asking, and not the one `local` answers.
                 *
                 * The onboarding panel was built on `local`, so in the container it rendered
                 * "allowed only on a loopback bind" to an operator who had just authenticated with
                 * an admin credential and could in fact do it. A field that describes the server
                 * where the client needs a decision about itself is how a correct refusal becomes a
                 * wrong one.
                 */
                allowed: mayProvision(context.principal),
                steps: options.provision?.steps() ?? [],
            }),
        { capability: "read" },
    )

    /**
     * Create an agent, and have this host adopt it before the response returns.
     *
     * **Provisioning ends in `Runtime.adopt`, not in a restart.** That is the whole point of it: the
     * directory is written and the agent is live — served, channels started, schedules armed —
     * without disturbing anything else this process is hosting. A restart would drop every other
     * agent's in-flight turn to add one, which is why `POST /reload` answers 501 rather than doing
     * it.
     *
     * **Loopback only, in this phase.** An unauthenticated loopback server is a legitimate
     * configuration, so a route that writes files and starts an agent must not be reachable from
     * the network on one — and the origin guard protects a *browser* caller, not a curl. 18.2's
     * scoped keys are what open this to a remote operator holding an admin-capability key; until
     * then the refusal names the two ways to do it instead, because "not supported" with no
     * alternative is where somebody starts looking for a way round the gate.
     */
    router.add(
        "POST",
        "/v1/agents",
        async (context) => {
            const provision = options.provision
            if (provision === undefined) {
                return fail(
                    {
                        code: "provisioning_not_supported",
                        message: "This server cannot create agents.",
                        hint: "Creating one writes a directory of files from a question set this process was not given — an embedder mounting this handler over its own agent store is the case that lands here. Run `init` where the sandbox is, or mount an agent directory.",
                    },
                    501,
                )
            }
            if (!mayProvision(context.principal)) {
                return fail(
                    {
                        code: "provisioning_not_local",
                        message:
                            "Creating an agent needs either a loopback bind or a credential with the admin capability.",
                        hint: "This route writes files and starts an agent. A token-less loopback server is a supported configuration, so on a non-loopback bind it asks for a credential instead — set server.tokenEnv (the container's DISPACH_API_TOKEN does this) or present an operator key minted with `can: [admin]`. What is refused is provisioning on a server that required no credential at all and is reachable from the network.",
                    },
                    403,
                )
            }

            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            /**
             * `Record<string, string>`, checked by the schema — including the per-value type.
             *
             * Every answer is text on both front doors, and a number reaching `validateAnswer` would
             * arrive as something it has no case for. The schema refuses it by path (`answers.server`),
             * which is the field a caller has to fix; *which* steps exist is `GET /v1/provision`'s
             * answer, not this schema's, because enumerating them here would be a second copy of
             * `STEP_ORDER`.
             */
            const parsed = parseBody(ProvisionBody, body.value)
            if (!parsed.ok) return fail(parsed.error, 400)
            const text = parsed.value.answers

            let created: ReturnType<Provisioner["create"]>
            try {
                created = provision.create(text)
            } catch (error) {
                // The implementation knows why far better than this route does, so its hint passes
                // through rather than being paraphrased.
                if (isHarnessError(error)) return fail(error.toDetail(), 400)
                throw error
            }

            /**
             * Adopted after the files exist, and a failure here is reported **with the directory**.
             *
             * The agent is on disk either way, so a failed adoption is not a failed creation: telling
             * somebody their request failed when a complete agent is sitting in the sandbox would send
             * them to create a second one. `201` with `adopted: false` and the reason is the honest
             * answer — the thing they asked for exists, and it is not running yet.
             */
            try {
                const admitted = await runtime.adopt(created.manifestPath)
                return json(
                    {
                        id: created.agentId,
                        dir: created.dir,
                        files: created.files,
                        adopted: admitted.map((agent) => agent.id),
                    },
                    201,
                )
            } catch (error) {
                return json(
                    {
                        id: created.agentId,
                        dir: created.dir,
                        files: created.files,
                        adopted: [],
                        error: isHarnessError(error)
                            ? error.toDetail()
                            : {
                                  code: "provision_adopt_failed",
                                  message: error instanceof Error ? error.message : String(error),
                                  hint: "The agent was written and is not running. Fix what the message names and `start` it, or restart the host.",
                              },
                    },
                    201,
                )
            }
        },
        { capability: "admin" },
    )

    router.add(
        "POST",
        "/v1/agents/:id/stop",
        async (context) => {
            const id = context.params.id ?? ""
            const hosted = runtime.list().some((agent) => agent.id === id)
            const known = await runtime.store.agentState.get(id)
            // Neither hosted nor ever recorded means there is nothing here by that name. A 200 would
            // report having stopped something that does not exist, which is the shape of answer that
            // lets a typo look like success.
            if (!hosted && known === undefined) return notFound("agent", id)

            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            const parsed = parseBody(StopBody, body.value)
            if (!parsed.ok) return fail(parsed.error, 400)
            const reason = parsed.value.reason?.trim()
            const state = await runtime.store.agentState.disable(
                id,
                new Date(options.now?.() ?? Date.now()).toISOString(),
                // An empty or whitespace-only note is no note. Kept here rather than in the schema
                // because "" is a legal string a client may genuinely send meaning "no reason".
                reason === undefined || reason === "" ? undefined : reason,
            )

            if (hosted) {
                try {
                    await runtime.dispose(id, "stopped")
                } catch (error) {
                    if (isHarnessError(error) && error.code === "agent_turn_in_flight") {
                        return fail(error.toDetail(), 409)
                    }
                    throw error
                }
            }
            return json({ id, status: "disabled", ...stateFields(state) })
        },
        { capability: "admin" },
    )

    /**
     * Switch it back on, and adopt it into this host now.
     *
     * The mirror of `stop`, and the asymmetry between them is real: `stop` acts on an agent the
     * runtime is holding, while `start` acts on one it has never seen — so it needs a manifest from
     * outside, which is `resolveAgent`. Without that injection the route says `501` and names it
     * rather than writing the row and reporting a success that hosts nothing.
     *
     * **Enabled first, then adopted**, because `adopt` refuses a stopped agent by design — that
     * refusal is what stops every other caller reversing a stop by accident, and this is the one
     * caller that means to.
     */
    router.add(
        "POST",
        "/v1/agents/:id/start",
        async (context) => {
            const id = context.params.id ?? ""
            if (runtime.list().some((agent) => agent.id === id)) {
                // Already running. Enabled anyway, because a hosted agent with a `disabled` row is a
                // state a crash between the two writes above can leave behind, and this is the command
                // that would otherwise have no way to clear it.
                const state = await runtime.store.agentState.enable(id)
                return json({ id, status: "loaded", ...stateFields(state) })
            }

            const resolve = options.resolveAgent
            if (resolve === undefined) {
                return fail(
                    {
                        code: "start_not_supported",
                        message:
                            "This server cannot look up a manifest for an agent it is not hosting.",
                        hint: "Starting a stopped agent needs its manifest, which lives wherever agents live — the sandbox for the CLI, a mounted path for a container. This process was built without that lookup, so pass the agent to `serve` and restart it instead.",
                    },
                    501,
                )
            }

            const source = resolve(id)
            if (source === undefined) return notFound("agent", id)

            const state = await runtime.store.agentState.enable(id)
            try {
                const admitted = await runtime.adopt(source)
                return json({
                    id,
                    status: "loaded",
                    ...stateFields(state),
                    adopted: admitted.map((agent) => agent.id),
                })
            } catch (error) {
                // Put back, because the agent is not running and a row saying otherwise is the
                // "looks live and is not" failure this table exists to prevent. Reported with the
                // adoption's own error, which names the real fault — a missing key, a bad manifest.
                await runtime.store.agentState.disable(
                    id,
                    new Date(options.now?.() ?? Date.now()).toISOString(),
                    "start failed",
                )
                if (isHarnessError(error)) return fail(error.toDetail(), 400)
                throw error
            }
        },
        { capability: "admin" },
    )

    // ─── Turns ───────────────────────────────────────────────────────────────────────────

    router.add(
        "POST",
        "/v1/agents/:id/messages",
        async (context) =>
            withAgent(runtime, context, async (agent) => {
                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)

                /**
                 * Shape from the schema; meaning from the two parsers below.
                 *
                 * `MessageBody` owns the types, the trim and the enum — including the trust-boundary
                 * refusal on `from.kind`, whose nearest-match suggestion moved into a custom Zod error
                 * rather than being lost. `parseDeliver` and `parseFrom` then only *build* their values.
                 * A schema that validated and a parser that re-validated would be two owners of one
                 * field, which is the drift this refactor exists to remove.
                 */
                const parsed = parseBody(MessageBody, body.value)
                if (!parsed.ok) return fail(parsed.error, 400)
                const input = parsed.value

                // Per-token frames are opt-in, and the *reader* decides — so the query parameter on the
                // stream routes is the primary control and this is the writer's way to ask on the
                // inline-stream path, where there is no second request to carry one. Strict `=== true`,
                // like `stream`: the schema rejects the string "false", so this cannot be read as
                // asking by a client that sent one.
                const wantsChunks = input.chunks === true
                const text = input.text

                const sessionKey = input.sessionKey ?? "api:default"
                // The one place a caller *names* a session they may never have seen. Without this,
                // a key scoped to `team_42:` could write into `team_7:`'s conversation simply by
                // asking — which is the difference between a filter and a boundary.
                const outside = outsideSession(context, sessionKey)
                if (outside !== undefined) return outside
                const deliver = parseDeliver(input.deliver)
                if (deliver.kind === "error") return fail(deliver.error, 400)

                const from = parseFrom(input.from)
                if (from.kind === "error") return fail(from.error, 400)

                const idempotency = parseIdempotencyKey(context.request)
                if (idempotency.kind === "error") return fail(idempotency.error, 400)

                const turnId = newTurnId()

                /**
                 * The key is claimed **here**, before `agent.send`, and awaited.
                 *
                 * This handler answers `202` and lets the turn run detached, so the turn row appears
                 * some milliseconds later — a claim that waited for the row would leave the window
                 * between two retries wide open, and that window is the only thing the feature exists
                 * to close. Claiming synchronously makes the second request deterministic rather than
                 * a race: it either wins the insert or reads the winner's turn id.
                 *
                 * A mismatch is a `409` rather than a replay. A client that recycled a key by accident
                 * would otherwise be told its second, different message succeeded — the one new failure
                 * an idempotency key introduces that not having one does not.
                 */
                if (idempotency.key !== undefined) {
                    const claim = await agent.store.turns.claimInboundKey({
                        agentId: agent.id,
                        key: idempotency.key,
                        turnId,
                        inputHash: await inputHash(sessionKey, text),
                        now: new Date(),
                    })
                    if (claim.kind === "replay") {
                        return json({ turnId: claim.turnId, sessionKey, replayed: true }, 200)
                    }
                    if (claim.kind === "mismatch") {
                        return fail(
                            {
                                code: "idempotency_key_reused",
                                message: `Idempotency-Key "${idempotency.key}" was already used for a different message.`,
                                hint: `It belongs to turn ${claim.turnId}, whose text or session differed from this request's. Nothing was run. Use a fresh key for a new message, or resend the original text byte for byte to get that turn back. A key is remembered for 24 hours.`,
                                field: "Idempotency-Key",
                            },
                            409,
                        )
                    }
                }
                const controller = new AbortController()
                running.set(turnId, controller)
                // Before `send`, and **unconditionally** — the condition was the bug.
                //
                // `Agent.send` awaits the session write before emitting anything, so a caller who POSTs
                // without `stream` and then immediately GETs the stream with the turn id it was just
                // handed arrived before `turn.start` and was told "no buffer for this turn in this
                // process" — for a turn that was about to run. Opening here makes that deterministic
                // rather than a race: the buffer exists before this handler's next statement, so it
                // exists before the caller can possibly hold the id.
                //
                // The cost is an empty buffer per turn nobody streams, evicted by the retention policy
                // that already runs on `turn.end`. `attach` still refuses to create one for an unknown
                // id, which is the decision that keeps a typo'd turn id distinguishable from a real one.
                // Chunk interest is declared here, synchronously, because the bus only builds a
                // per-token envelope while somebody is listening — and an SSE `start` callback runs
                // after this handler returns, by which point the first tokens are already gone.
                runtime.streams.open(turnId, { chunks: wantsChunks })

                // Detached on purpose. The response returns before this settles, and nothing about the
                // turn's lifetime depends on the connection that started it.
                const work = agent
                    .send(text, {
                        sessionKey,
                        turnId,
                        source: "api",
                        ...(from.from === undefined ? {} : { from: from.from }),
                        signal: controller.signal,
                    })
                    .then(async (result) => {
                        if (deliver.target === undefined || result.text.trim() === "") return
                        await runtime.channels.deliver({
                            agentId: agent.id,
                            sessionKey,
                            channelId: deliver.target.channel,
                            recipient: deliver.target.to,
                            turnId,
                            text: result.text,
                        })
                    })
                    .catch(() => {
                        // The turn's own error event already carries the cause, and the turn row records
                        // it. Swallowed here so a detached rejection does not become an unhandled one.
                    })
                    .finally(() => {
                        running.delete(turnId)
                    })
                void work

                if (input.stream !== true) return json({ turnId, sessionKey }, 202)

                // 202 with an SSE body, whose first frame is the same object the non-streaming path
                // returns. That is what "returns 202 … then streams SSE" means without inventing a
                // second response.
                return streamTurn(runtime, turnId, {
                    accepted: { turnId, sessionKey },
                    status: 202,
                    chunks: wantsChunks,
                })
            }),
        { capability: "chat" },
    )

    /**
     * Attach to a turn. `?chunks=true` — the reader decides, per connection. A reattaching client
     * that wants tokens asks for them here; one watching progress does not have to.
     *
     * **Four states, three answers.** This route used to give one: 200 with a `stream.unavailable`
     * frame, for a turn that finished an hour ago and for a turn id with a typo in it alike — so
     * the only way to tell a mistake from a completed turn was to make a second request. The states
     * are genuinely distinct and each gets what is true of it:
     *
     * | State | Answer |
     * | --- | --- |
     * | A buffer in this process | `200`, replay then tail |
     * | No buffer, turn finished | `200` + `stream.ended` carrying the final status |
     * | No buffer, turn still running | `200` + `stream.unavailable` — running, not observable here |
     * | No turn at all | `404 turn_not_found` |
     *
     * The third row is the one the plan did not anticipate and is not hypothetical: a turn row is
     * written at turn *start*, and one `store.db` is shared by every process under a sandbox root,
     * so `serve` can hold a row for a turn `run` is executing in the next terminal. Answering
     * `stream.ended` there would state that a running turn had finished — and a client would go
     * read a final text that does not exist yet. It is terminal-or-not, `status !== "running"`, so
     * a new `TurnEndReason` cannot be silently misfiled as still-running.
     *
     * The buffer is checked before the store, so the common case costs no query. The window between
     * that check and `attach` is real and benign: eviction can land in it, and `streamTurn`'s own
     * fallback frame covers it.
     */
    router.add(
        "GET",
        "/v1/agents/:id/turns/:turnId/stream",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const turnId = context.params.turnId ?? ""
                if (runtime.streams.state(turnId) === undefined) {
                    const record = await agent.store.turns.get(turnId)
                    if (record === undefined)
                        return notFound(
                            "turn",
                            turnId,
                            "No turn with this id has ever run on this agent. A turn id is the `turnId` from POST /v1/agents/:id/messages — check the agent in the path too, since a turn belongs to one.",
                        )
                    return finishedStream(record)
                }
                return streamTurn(runtime, turnId, {
                    chunks: context.url.searchParams.get("chunks") === "true",
                })
            }),
        { capability: "read", streaming: true },
    )

    router.add(
        "POST",
        "/v1/agents/:id/turns/:turnId/stop",
        (context) =>
            withAgent(runtime, context, () => {
                const turnId = context.params.turnId ?? ""
                const controller = running.get(turnId)
                if (controller === undefined) {
                    return fail(
                        {
                            code: "turn_not_running",
                            // What is actually true, which is narrower than what this used to claim.
                            // It said "not running in this process" — false of a turn a channel or a
                            // schedule started, which *is* running here and simply left no cancel
                            // handle on this surface. Nothing in core records in-flight turns, so the
                            // handle exists only for turns this API started.
                            message: `No cancel handle for turn ${turnId} on this API.`,
                            hint: "This surface can stop a turn it started. A turn that has already finished cannot be stopped at all — read its final state from GET /v1/agents/:id/turns/:turnId. A turn started by a channel, a schedule, or another process is running without a handle here.",
                        },
                        409,
                    )
                }
                controller.abort()
                // Partial content is persisted on explicit stop — this path — and never on disconnect.
                return json({ turnId, stopping: true }, 202)
            }),
        { capability: "chat" },
    )

    // ─── Approvals ───────────────────────────────────────────────────────────────────────

    /**
     * What is waiting on a person right now.
     *
     * The recovery path, and the reason approvals are usable from a browser at all: a client that
     * missed `approval.requested` — opened after the turn blocked, refreshed, a second operator —
     * otherwise sees a turn that has visibly stopped with no way to discover why. Same argument as
     * turn reattach, which the spec calls core rather than a convenience.
     *
     * **Scoped by agent, and it was not.** This discarded `:id` and returned every pending question
     * in the process — slug, matched command and reason included — which is one operator reading
     * another agent's queue. Unreachable only because a served process hosted one agent, which is
     * the same shape as the cross-agent disclosure Phase 13 found on `/v1/events`: single-tenancy
     * hides multi-tenancy bugs rather than preventing them. The old comment reasoned that the
     * registry "has no use for" an agent id otherwise; it does now, and `pending` takes it as a
     * required argument so the disclosing call is the one that does not compile.
     */
    router.add(
        "GET",
        "/v1/agents/:id/approvals",
        (context) =>
            withAgent(runtime, context, async (agent) =>
                json({ approvals: approvals.pending(agent.id) }),
            ),
        { capability: "read" },
    )

    /**
     * Answer one.
     *
     * `granted` is required and must be a real boolean. There is no default, for the reason the
     * whole mechanism exists: a missing field defaulting to `false` would deny a call on a typo,
     * and defaulting to `true` would grant one on a malformed request — so a body this route
     * cannot read is a `400` rather than a decision nobody made.
     *
     * A `404` covers every way an id can fail to be waiting: answered already, abandoned when its
     * turn ended, never existed. They are deliberately one answer — distinguishing them would mean
     * keeping a record of settled approvals, and a client that can ask "was this one denied an hour
     * ago" is a client relying on state this registry says plainly that it does not keep.
     */
    router.add(
        "POST",
        "/v1/agents/:id/approvals/:approvalId",
        (context) =>
            withAgent(runtime, context, async () => {
                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                const parsed = parseBody(ApprovalBody, body.value)
                if (!parsed.ok) return fail(parsed.error, 400)
                const input = parsed.value

                const approvalId = context.params.approvalId ?? ""
                if (!approvals.resolve(approvalId, input.granted)) {
                    return fail(
                        {
                            code: "approval_not_found",
                            message: `No approval with id ${approvalId} is waiting.`,
                            hint: 'It was answered already, or its turn ended while it waited — a stopped or timed-out turn abandons its question, and `approval.resolved` reports that as `by: "abandoned"`. GET /v1/agents/:id/approvals lists what is actually waiting. Nothing about a settled approval is kept, so this is also the answer for an id that was never real.',
                        },
                        404,
                    )
                }
                return json({ approvalId, granted: input.granted })
            }),
        { capability: "chat" },
    )

    // ─── The browser surface ─────────────────────────────────────────────────────────────

    /**
     * Three paths, named explicitly, with **no catch-all**.
     *
     * Registered in the router rather than short-circuited ahead of it, so `HEAD` and `OPTIONS`
     * answer correctly and `Allow` is derived from the same table as everything else — a second
     * dispatch path is how one surface comes to disagree with another about what a method does. The
     * `GET /v1/ws` exemption exists because an upgrade cannot be a `Response`; a file can.
     *
     * A wildcard falling back to `index.html` is the usual arrangement and is wrong here: it makes
     * every mistyped API path answer `200` with a web page, so a client calling `/v1/agentss` gets
     * HTML where it expected JSON and the failure surfaces as a parse error far from the typo. The
     * page has no client-side routes, so nothing needs the fallback.
     */
    /**
     * Three paths, as three literal registrations, and the literal is load-bearing.
     *
     * A `for (const path of WEB_PATHS)` loop is one line shorter and **invisible to the spec
     * guard**, which reads this file for registrations whose method and path are string literals —
     * so the routes would have been undocumented, unchecked, and reported as compliant. Found by
     * writing the loop first and noticing the guard stayed green. (This sentence deliberately does
     * not spell the call out: the scanner is a regex over the source, and a comment quoting the
     * shape it matches becomes a phantom route in its output — which is how it first read
     * `METHOD path` as an undocumented endpoint.) `webRoutesMatchAssets` in `spec.test.ts` is what keeps these
     * three in step with `WEB_ASSETS` now that they are written out.
     *
     * Registered in the router rather than short-circuited ahead of it, so `HEAD` and `OPTIONS`
     * answer correctly and `Allow` derives from the same table as everything else. The `GET /v1/ws`
     * exemption exists because an upgrade cannot be a `Response`; a file can.
     *
     * **No catch-all.** A wildcard falling back to `index.html` is the usual arrangement and is
     * wrong here: it makes every mistyped API path answer `200` with a web page, so a client
     * calling `/v1/agentss` gets HTML where it expected JSON and the failure surfaces as a parse
     * error far from the typo. The page has no client-side routes, so nothing needs it.
     */
    router.add("GET", "/", (context) => web("/", context), { capability: "open" })
    router.add("GET", "/assets/app.js", (context) => web("/assets/app.js", context), {
        capability: "open",
    })
    router.add("GET", "/assets/app.css", (context) => web("/assets/app.css", context), {
        capability: "open",
    })

    // ─── Operator keys ───────────────────────────────────────────────────────────────────

    /**
     * Issue a key. The secret is in this response and in no other, ever.
     *
     * Authenticated by **either** an existing credential or the boot claim, and the claim is
     * checked first for a reason that only shows up on a fresh server: with no token configured and
     * no keys yet, the ordinary auth path lets every request through, so a claim presented there
     * would be spent on a request that did not need it. Checking it first means a ticket is only
     * ever consumed by a caller that actually exchanged it.
     */
    router.add(
        "POST",
        "/v1/keys",
        async (context) => {
            /**
             * Whether the credential on this request *is* the claim — compared, never merely detected.
             *
             * The first version asked "did this request present a bearer at all", which is true of the
             * configured token and of every key, so an entirely ordinary `POST` was answered
             * `claim_spent`. Every call that mints a key went through it, so the whole route was broken
             * by a question that looked equivalent and was not.
             */
            const usedClaim =
                options.claim !== undefined &&
                presentedClaim(context.request) === options.claim.token

            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)
            // Shape here; the display rule stays in `keyLabelProblem`, which decides what a label may
            // *contain* — a wire schema has no business knowing how wide a listing row is.
            const parsed = parseBody(KeyBody, body.value)
            if (!parsed.ok) return fail(parsed.error, 400)
            const input = parsed.value
            const problem = keyLabelProblem(input.label)
            if (problem !== undefined) {
                return fail(
                    {
                        code: "key_label_invalid",
                        message: problem,
                        hint: `A label is shown in a listing and in the UI, so it is at most ${MAX_KEY_LABEL} printable characters on one line. It is a display name, not a description.`,
                        field: "label",
                    },
                    400,
                )
            }

            /**
             * Spent **after** validation and before the write.
             *
             * After, because burning a one-use bootstrap credential on a malformed label would leave an
             * operator with a spent ticket, no key, and a restart as the only way back — while the
             * request that failed is one they can simply retry. Before the write, because that ordering
             * makes a lost race a refusal rather than a second key: two claims arriving together both
             * pass the gate while the ticket is live, and only one `spend()` returns true.
             */
            if (usedClaim && options.claim?.spend() !== true) return claimSpent()

            /**
             * A scope naming an agent this server does not hold is **reported**, not stored.
             *
             * The failure it prevents is the one this repo keeps finding under a different name: a
             * credential that authenticates perfectly and reaches nothing, indistinguishable from a
             * working key until somebody tries to use it — and by then the mint is hours in the
             * past and the typo is invisible. A `400` naming the id at the moment it is typed is
             * the only cheap place to catch it, the same argument `telegramHandle` makes about a
             * username that cannot exist.
             *
             * Checked against *hosted* agents plus the durably-stopped ones, because scoping a key
             * to an agent somebody switched off for the weekend is entirely reasonable and refusing
             * it would be a refusal nobody can act on.
             */
            const scope = input.scope
            if (scope?.agents !== undefined) {
                const hosted = new Set(runtime.list().map((agent) => agent.id))
                for (const state of await runtime.store.agentState.list()) hosted.add(state.agentId)
                const unknown = scope.agents.filter((id) => !hosted.has(id))
                if (unknown.length > 0) {
                    return fail(
                        {
                            code: "key_scope_agent_unknown",
                            message: `No agent ${unknown.map((id) => JSON.stringify(id)).join(", ")} on this server.`,
                            hint: "A key scoped to an agent that does not exist authenticates and then reaches nothing, which looks exactly like a working credential until it is used. GET /v1/agents lists what this server holds, stopped agents included.",
                            field: "scope.agents",
                        },
                        400,
                    )
                }
            }

            const expiresAt =
                scope?.expiresIn === undefined
                    ? undefined
                    : new Date(now() + scope.expiresIn * 1000).toISOString()
            /**
             * `expiresIn` does **not** travel into the stored scope.
             *
             * It is a request-shaped field — seconds from a moment that has now passed — and
             * storing it beside the absolute `expiresAt` would be two answers to one question, the
             * second of which is wrong the instant it is written.
             */
            const stored: KeyScope | undefined =
                scope === undefined
                    ? undefined
                    : {
                          ...(scope.agents === undefined ? {} : { agents: scope.agents }),
                          ...(scope.sessions === undefined ? {} : { sessions: scope.sessions }),
                          ...(scope.can === undefined ? {} : { can: scope.can }),
                      }

            const secret = newKeySecret()
            const record = await runtime.store.operatorKeys.issue({
                keyId: newKeyId(now()),
                label: input.label.trim(),
                fingerprint: await keyFingerprint(secret),
                createdAt: new Date(now()).toISOString(),
                ...(stored === undefined || Object.keys(stored).length === 0
                    ? {}
                    : { scope: stored }),
                ...(expiresAt === undefined ? {} : { expiresAt }),
            })
            // `secret` is spread in beside the record rather than being part of it: `OperatorKeyRecord`
            // has no field for one, so there is no shape in which a stored or listed key carries it.
            return json({ ...record, secret }, 201)
        },
        { capability: "admin" },
    )

    /**
     * List keys — labels and metadata, never secrets.
     *
     * Revoked keys are listed with their `revokedAt`, not filtered out. A revocation somebody
     * cannot see the result of is one they will do twice, and the row is the only record that a
     * credential ever existed.
     */
    router.add(
        "GET",
        "/v1/keys",
        async () => {
            const keys = await runtime.store.operatorKeys.list()
            return json({
                keys,
                /**
                 * Said on the wire, because the plan's rule was "said in the UI, not discovered" and a
                 * UI is one consumer. Every key reaches every session; keys are authentication only.
                 */
                /**
                 * The sentence had to change with the behaviour, and that is why it is asserted.
                 *
                 * It read *"Every key authenticates every route for every agent this server holds. Keys
                 * are authentication, not authorisation."* — true until a scope could narrow one, and a
                 * client that had cached that claim would now be wrong about its own credential. What
                 * replaces it says the same thing about an **unscoped** key, states what a scope is,
                 * and says what it is not, in the one place a client is already reading.
                 */
                scope: "A key with no scope authenticates every route for every agent this server holds. A scope narrows an already-authenticated caller — it names agents, a session prefix and capabilities, and it is not an identity: there are no users, teams or roles here.",
            })
        },
        { capability: "admin" },
    )

    /**
     * Revoke one. Idempotent, and it never reports a lie about what is now true.
     *
     * Revoking an already-revoked key is a success carrying the original stamp rather than a 404:
     * the caller asked for a state that already holds, and a retried request is not a mistake. An
     * id that never existed is the 404, which is the only case where the answer "it is revoked"
     * would be a statement about nothing.
     */
    router.add(
        "DELETE",
        "/v1/keys/:keyId",
        async (context) => {
            const keyId = context.params.keyId ?? ""
            const record = await runtime.store.operatorKeys.revoke(
                keyId,
                new Date(now()).toISOString(),
            )
            if (record === undefined)
                // Its own hint, because the default one talks about session keys and channel segments —
                // true of the 404 this server returns most often and about nothing here. Found by
                // reading real output: a caller who has just been told to check for a channel segment
                // in a key id is a caller looking in the wrong place.
                return notFound(
                    "key",
                    keyId,
                    "The id is the `keyId` from POST /v1/keys, not the secret — GET /v1/keys lists them. An already-revoked key is a 200 carrying its original stamp, so this really does mean no such key exists.",
                )
            return json(record)
        },
        { capability: "admin" },
    )

    // ─── Turns, continued ────────────────────────────────────────────────────────────────

    router.add(
        "GET",
        "/v1/agents/:id/turns/:turnId",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const record = await agent.store.turns.get(context.params.turnId ?? "")
                if (record === undefined) return notFound("turn", context.params.turnId ?? "")
                return json(record)
            }),
        { capability: "read" },
    )

    // ─── Sessions ────────────────────────────────────────────────────────────────────────

    router.add(
        "GET",
        "/v1/agents/:id/sessions",
        (context) =>
            withAgent(runtime, context, async (agent) =>
                json(visibleSessions(context.principal, await agent.store.sessions.list(agent.id))),
            ),
        { capability: "read" },
    )

    router.add(
        "GET",
        "/v1/agents/:id/sessions/:key",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const key = context.params.key ?? ""
                const outside = outsideSession(context, key)
                if (outside !== undefined) return outside
                const record = await agent.store.sessions.get(agent.id, key)
                if (record === undefined) return notFound("session", key)
                return json(record)
            }),
        { capability: "read" },
    )

    router.add(
        "GET",
        "/v1/agents/:id/sessions/:key/messages",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const before = context.url.searchParams.get("before")
                const limit = context.url.searchParams.get("limit")
                const outside = outsideSession(context, context.params.key ?? "")
                if (outside !== undefined) return outside
                const page = await agent.store.messages.page(agent.id, context.params.key ?? "", {
                    ...(before === null ? {} : { before: Number.parseInt(before, 10) }),
                    ...(limit === null ? {} : { limit: Number.parseInt(limit, 10) }),
                })
                return json(page)
            }),
        { capability: "read" },
    )

    router.add(
        "DELETE",
        "/v1/agents/:id/sessions/:key",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                // History only. Memory markdown is a file artifact and is never deleted by an API call.
                const outside = outsideSession(context, context.params.key ?? "")
                if (outside !== undefined) return outside
                await agent.store.sessions.clear(agent.id, context.params.key ?? "")
                return json({ cleared: context.params.key ?? "", memoryFilesKept: true })
            }),
        { capability: "write" },
    )

    router.add(
        "POST",
        "/v1/agents/:id/sessions/:key/phase",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                const parsed = parseBody(PhaseBody, body.value)
                if (!parsed.ok) return fail(parsed.error, 400)
                // Shape here; whether the agent *declares* this phase is checked below, where the
                // manifest is — a wire schema cannot know one agent's phase names.
                const phase = parsed.value.phase
                if (typeof phase !== "string" && phase !== null) {
                    return fail(
                        {
                            code: "phase_invalid",
                            message: "phase must be a string, or null to clear it.",
                            hint: 'Send { "phase": "triage" }. Phase-scoped tool visibility arrives in Phase 7; the column is written now so a session carries the value across a restart.',
                            field: "phase",
                        },
                        400,
                    )
                }
                const outside = outsideSession(context, context.params.key ?? "")
                if (outside !== undefined) return outside
                await agent.store.sessions.setPhase(
                    agent.id,
                    context.params.key ?? "",
                    phase === null ? undefined : phase,
                )
                return json({ phase })
            }),
        { capability: "write" },
    )

    // ─── Introspection ───────────────────────────────────────────────────────────────────

    // ── Schedules ────────────────────────────────────────────────────────────────────────
    //
    // Listing includes disabled by default — decision 9.4, and the reason is that hiding a
    // switched-off schedule makes it indistinguishable from one that was never written. `?enabled=`
    // filters when somebody actually wants that.
    router.add(
        "GET",
        "/v1/agents/:id/schedules",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const enabled = context.url.searchParams.get("enabled")
                const rows = await agent.store.schedules.list(
                    agent.id,
                    enabled === null ? {} : { enabled: enabled === "true" },
                )
                return json({ schedules: rows })
            }),
        { capability: "read" },
    )

    router.add(
        "POST",
        "/v1/agents/:id/schedules",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                return writeSchedule(runtime, agent, body.value, undefined)
            }),
        { capability: "write" },
    )

    router.add(
        "GET",
        "/v1/agents/:id/schedules/:sid",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const sid = context.params.sid ?? ""
                const row = await agent.store.schedules.get(agent.id, sid)
                return row === undefined ? notFound("schedule", sid) : json(row)
            }),
        { capability: "read" },
    )

    router.add(
        "PATCH",
        "/v1/agents/:id/schedules/:sid",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const sid = context.params.sid ?? ""
                const existing = await agent.store.schedules.get(agent.id, sid)
                if (existing === undefined) return notFound("schedule", sid)
                const owned = manifestOwned(existing)
                if (owned !== undefined) return owned

                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                const patch =
                    body.value === null ||
                    typeof body.value !== "object" ||
                    Array.isArray(body.value)
                        ? {}
                        : (body.value as Record<string, unknown>)

                // The whole schedule is revalidated, never the patch alone: a change to `expr` can make
                // a previously-fine `timezone` unsatisfiable, and validating a fragment cannot see that.
                const { id: _ignoredId, ...fields } = patch
                const merged: Record<string, unknown> = {
                    kind: existing.kind,
                    expr: existing.expr,
                    task: existing.task,
                    deliver:
                        existing.deliverChannel === undefined || existing.deliverTo === undefined
                            ? "none"
                            : { channel: existing.deliverChannel, to: existing.deliverTo },
                    session: existing.sessionMode,
                    enabled: existing.enabled,
                    ...(existing.timezone === undefined ? {} : { timezone: existing.timezone }),
                    ...(existing.role === undefined ? {} : { role: existing.role }),
                    ...fields,
                    // The id is the row's identity and the key reconciliation matches on, so a patch
                    // that renamed it would create a second schedule and orphan the first. Dropped from
                    // the incoming fields above rather than overwritten after them, which TypeScript
                    // rejects as a duplicate key — and rightly: two spellings of the same intent in one
                    // literal is how the wrong one eventually wins.
                    id: existing.id,
                }
                return writeSchedule(runtime, agent, merged, existing)
            }),
        { capability: "write" },
    )

    router.add(
        "DELETE",
        "/v1/agents/:id/schedules/:sid",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const sid = context.params.sid ?? ""
                // Read before removing: the row is what says who owns it, and a delete that has
                // already happened cannot be refused.
                const existing = await agent.store.schedules.get(agent.id, sid)
                if (existing === undefined) return notFound("schedule", sid)
                const owned = manifestOwned(existing)
                if (owned !== undefined) return owned
                const removed = await agent.store.schedules.remove(agent.id, sid)
                if (!removed) return notFound("schedule", sid)
                runtime.scheduler.changed()
                return json({ removed: sid })
            }),
        { capability: "write" },
    )

    // Out of band: fires now, and does **not** move the schedule's own next run. Someone testing a
    // schedule at 15:00 must not find that its 08:00 slot has moved.
    router.add(
        "POST",
        "/v1/agents/:id/schedules/:sid/run",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const sid = context.params.sid ?? ""
                const row = await agent.store.schedules.get(agent.id, sid)
                if (row === undefined) return notFound("schedule", sid)

                const runId = newRunId()
                const sessionKey = scheduleSessionKey(row.sessionMode, row.id, runId)
                const turnId = newTurnId()
                // This route mints a turn id and hands it back at 202, so it owes the same buffer the
                // message route does — and did not open one at all, which made `GET …/stream` on a
                // manually fired schedule answer "no buffer" for a turn that was running.
                //
                // The invariant, worth stating because there are exactly three places that mint an id
                // and give it to a caller: **whoever hands out a turn id opens its buffer first.**
                runtime.streams.open(turnId)
                // Detached, like every other turn on this surface: the client gets a handle and reads
                // the stream, and a disconnect never cancels the work.
                void agent
                    .send(row.task, {
                        sessionKey,
                        turnId,
                        source: `schedule:${row.id}:manual`,
                        ...(row.role === undefined ? {} : { role: row.role }),
                    })
                    .catch(() => {
                        // Reported on the bus by the turn itself; swallowed here so an unhandled
                        // rejection cannot take the server down.
                    })
                return json({ scheduleId: row.id, turnId, sessionKey, outOfBand: true }, 202)
            }),
        { capability: "write" },
    )

    /**
     * The person's editor, over HTTP.
     *
     * ## Why this is not `config_set` with a URL in front of it
     *
     * There are two editors of `agent.yaml` and they do not have the same authority.
     * `config_set` is the **agent's**, and it is floored — an agent that could widen its own inbound
     * gate could be talked into widening it by the very message it is reading, and `config_set` sits
     * in `policy.allow` on a real manifest, so the write gate would not stop that. `dispach config`
     * is the **person's**, and *nothing in it is floored*: refusing them is what left the fields
     * decision 11.29 reserves for a person — `allowFrom`, `server.host`, `server.tokenEnv`,
     * `writeRoots` — with the worst ergonomics in the system.
     *
     * This route is the third row of that table: the person, remotely. Same unfloored set, same two
     * confirmations, because the browser is the owner — it mints itself an unscoped key for exactly
     * that reason. Not a role, not an admin: there are no users, teams or roles here at all.
     *
     * ## Why the value is read out of the file rather than off `agent.manifest`
     *
     * `agent.manifest` is loaded, expanded and validated. `${MODEL_ID}` has become a model id there,
     * so an editor showing that value and writing it back would silently **bake the expansion in** —
     * turning a manifest that follows its environment into one that does not, reported as an
     * unrelated edit. `manifestValueAt` reads the source: unexpanded, exactly as written.
     */
    router.add(
        "GET",
        "/v1/agents/:id/config",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const source = runtime.sourceOf(agent.id)
                const file = typeof source === "string" ? source : undefined
                const text = file === undefined ? undefined : await readFile(file, "utf8")
                return json({
                    // Named rather than implied: an object-form manifest has no file to edit, and a
                    // client that cannot tell will offer a form whose save can only fail.
                    ...(file === undefined ? { editable: false } : { editable: true, file }),
                    settings: SETTINGS.filter((setting) =>
                        PERSON_SETTABLE_PATHS.includes(setting.path),
                    ).map((setting) => ({
                        path: setting.path,
                        means: setting.means,
                        ...(setting.confirm === undefined ? {} : { confirm: setting.confirm }),
                        ...(text === undefined
                            ? {}
                            : { value: manifestValueAt(text, setting.path.split(".")) }),
                    })),
                })
            }),
        { capability: "admin" },
    )

    router.add(
        "PATCH",
        "/v1/agents/:id/config",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                const parsed = parseBody(ConfigBody, body.value)
                if (!parsed.ok) return fail(parsed.error, 400)

                const source = runtime.sourceOf(agent.id)
                if (typeof source !== "string") {
                    return fail(
                        {
                            code: "config_not_editable",
                            message: `"${agent.id}" was loaded from an object, not from a file, so it has no manifest to change.`,
                            hint: "An embedder holding new settings passes the new object to dispose() and adopt(). This route edits a manifest on disk.",
                        },
                        409,
                    )
                }

                const setting = settingByPath(parsed.value.path)
                // `via` and the placeholder paths are in `SETTINGS` and not in
                // `PERSON_SETTABLE_PATHS`, so the membership test is the one that decides — and the
                // refusal reads the row anyway, because `channels[].allowFrom` can name the command
                // that does set it instead of answering "no such setting" about a real field.
                if (setting === undefined || !PERSON_SETTABLE_PATHS.includes(setting.path)) {
                    return fail(
                        {
                            code: "config_path_unknown",
                            message:
                                setting?.via === undefined
                                    ? `"${parsed.value.path}" is not a field this surface sets.`
                                    : `"${parsed.value.path}" is set by \`${setting.via}\`, not by a dotted path.`,
                            hint:
                                setting?.via === undefined
                                    ? `GET /v1/agents/:id/config lists every one. Nearest: ${nearest(parsed.value.path, PERSON_SETTABLE_PATHS) ?? PERSON_SETTABLE_PATHS.join(", ")}.`
                                    : "It is a key inside a list entry, and the source editor matches a key at an indent — it cannot index a sequence. That action also validates the handle against the service that issues it.",
                            field: "path",
                        },
                        400,
                    )
                }

                // The two edits whose only purpose is to stop a check running. Refused rather than
                // logged: `confirm` absent is not consent, and the sentence is the row's own, so the
                // terminal and the browser ask the same question in the same words.
                if (setting.confirm !== undefined && parsed.value.confirm !== true) {
                    return fail(
                        {
                            code: "config_confirm_required",
                            message: setting.confirm,
                            hint: 'Send { "confirm": true } beside the value to make this change anyway. Nothing has been written.',
                            field: "confirm",
                        },
                        409,
                    )
                }

                let result: Awaited<ReturnType<typeof editManifest>>
                try {
                    result = await editManifest({
                        file: source,
                        path: setting.path.split("."),
                        // One parser for the person's two editors — see `ConfigBody`. Throws by name
                        // rather than guessing, because guessing is how `tools.pinned: "exec"`
                        // becomes a one-character tool list.
                        value: parseSettingValue(parsed.value.value),
                    })
                } catch (error) {
                    if (isHarnessError(error)) return fail(error.toDetail(), 400)
                    throw error
                }

                /**
                 * Applied by **replacing the agent**, and reported separately from the write.
                 *
                 * An agent's settings are fixed for its instance's lifetime — the catalogue resolves
                 * once and slot 1 renders once, on purpose — so a write alone changes nothing that is
                 * running. `replace` is what 16.2 built for this.
                 *
                 * It can legitimately fail: `dispose` refuses while a turn is in flight, because the
                 * alternative is closing a store under a turn recorded as `running`. The file is
                 * already written at that point and saying so is the only honest answer — the edit
                 * takes effect at the next start, which is exactly what `dispach config set` reports.
                 * Returning 409 and implying nothing happened would be rule 8 with better manners.
                 */
                let applied: ErrorDetail | undefined
                try {
                    await runtime.replace(agent.id)
                } catch (error) {
                    if (!isHarnessError(error)) throw error
                    applied = error.toDetail()
                }

                return json({
                    path: setting.path,
                    before: result.before,
                    after: result.after,
                    // A reflowed file is correct and its comments have moved, which is a surprise a
                    // person should hear from the surface that did it rather than from `git diff`.
                    reflowed: result.reflowed,
                    ...(applied === undefined
                        ? { applied: true }
                        : { applied: false, pending: applied }),
                })
            }),
        { capability: "admin" },
    )

    /**
     * Connect, disconnect, or set a channel's credential.
     *
     * One route for three things a person does to one channel, because they are one decision — "is
     * this channel working" — and splitting them would make the browser hold three call sites for
     * one panel. The implementation is the CLI's, injected, so `dispach channels` and this cannot
     * disagree about what any of them means.
     *
     * `admin`, like the config routes and for the same reason: it rewrites the file an agent boots
     * from, and it writes a credential.
     */
    router.add(
        "PATCH",
        "/v1/agents/:id/channels/:channelId",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const admin = options.channels
                if (admin === undefined) {
                    return fail(
                        {
                            code: "channels_not_supported",
                            message: "This server cannot change a channel.",
                            hint: "The host did not supply the channel actions — a library caller embedding this handler has to pass them. `dispach serve` does.",
                        },
                        501,
                    )
                }
                const source = runtime.sourceOf(agent.id)
                if (typeof source !== "string") {
                    return fail(
                        {
                            code: "config_not_editable",
                            message: `Agent "${agent.id}" was loaded from an object, so it has no manifest to edit.`,
                            hint: "Only an agent loaded from a file can be changed here.",
                        },
                        409,
                    )
                }

                const body = await readJson(context.request)
                if (body.kind === "error") return fail(body.error, 400)
                const parsed = parseBody(ChannelPatchBody, body.value)
                if (!parsed.ok) return fail(parsed.error, 400)
                const { enabled, credential } = parsed.value
                if (enabled === undefined && credential === undefined) {
                    return fail(
                        {
                            code: "channel_patch_empty",
                            message: "Nothing to change.",
                            hint: 'Send { "enabled": true | false } to connect or disconnect it, { "credential": "…" } to set its token, or both.',
                        },
                        400,
                    )
                }

                const channelId = context.params.channelId ?? ""
                const notes: string[] = []
                try {
                    // Credential first, deliberately: connecting a channel whose token is being set
                    // in the same request should find it already there, and the reverse order would
                    // start a channel that reads a variable one statement from being written.
                    if (credential !== undefined) {
                        notes.push(admin.setCredential(source, channelId, credential).note)
                    }
                    if (enabled !== undefined) {
                        notes.push((await admin.setEnabled(source, channelId, enabled)).note)
                    }
                } catch (error) {
                    if (!isHarnessError(error)) throw error
                    // The implementation knows why far better than this route does — which channel,
                    // which variable, and what to do — so its detail is passed through unchanged.
                    return fail(error.toDetail(), 400)
                }

                let applied: ErrorDetail | undefined
                try {
                    await runtime.replace(agent.id)
                } catch (error) {
                    if (!isHarnessError(error)) throw error
                    applied = error.toDetail()
                }

                return json({
                    channelId,
                    notes,
                    ...(applied === undefined
                        ? { applied: true }
                        : { applied: false, pending: applied }),
                })
            }),
        { capability: "admin" },
    )

    /**
     * Forget a channel's stored pairing.
     *
     * Separate from the PATCH because it is not a *setting* — nothing about the manifest changes,
     * and it is destructive in a way a flag is not: the session is gone and somebody has to scan a
     * code again. A POST to its own path is what makes that legible, and what stops a client
     * sending it by accident while toggling a flag.
     *
     * Tries the **live** transport first, which is what makes this work on a running agent without
     * a restart: `ChannelHub.reset` drops the session and the reconnect loop offers a new QR within
     * seconds. Falling back to the on-disk delete covers a channel that is registered but not
     * started, and an agent that is loaded but whose channels a `run`-mode host never started.
     */
    router.add(
        "POST",
        "/v1/agents/:id/channels/:channelId/unpair",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const channelId = context.params.channelId ?? ""
                const live = await runtime.channels.reset(agent.id, channelId)
                if (live === "reset") {
                    return json({
                        channelId,
                        note: "Pairing forgotten. The channel offers a new code to scan; the old device may still be listed on the phone, which is the only place it can be removed.",
                        restarted: false,
                    })
                }

                const admin = options.channels
                const source = runtime.sourceOf(agent.id)
                if (admin === undefined || typeof source !== "string") {
                    return fail(
                        {
                            code:
                                live === "unsupported"
                                    ? "channel_has_no_pairing"
                                    : "channel_unknown",
                            message:
                                live === "unsupported"
                                    ? `Channel "${channelId}" stores no pairing.`
                                    : `Agent "${agent.id}" has no channel "${channelId}" registered.`,
                            hint: "Only a channel linked by scanning a code has one to forget. A credential somebody typed is changed with PATCH on this channel, and a channel is switched off with { enabled: false }.",
                            field: "channelId",
                        },
                        live === "unsupported" ? 409 : 404,
                    )
                }

                try {
                    return json({ channelId, ...admin.unpair(source, channelId), restarted: false })
                } catch (error) {
                    if (!isHarnessError(error)) throw error
                    return fail(error.toDetail(), error.code === "channel_unknown" ? 404 : 409)
                }
            }),
        { capability: "admin" },
    )

    router.add(
        "GET",
        "/v1/agents/:id/tools",
        (context) =>
            withAgent(runtime, context, (agent) => {
                // `tags` and phase visibility are both in the spec's own description of this route and
                // neither was here. `tags` is the vocabulary `phases.*.allow` matches as `tag:<name>`,
                // so without it a reader cannot tell why a tool is in a phase it did not name.
                //
                // `phases` is **omitted** rather than `[]` on an unphased agent. An empty array reads
                // as "visible in no phase", which is the opposite of the truth — an unphased agent
                // shows every tool always — and `isPhased` is the same one-line question the runtime
                // asks before registering `phase_set` at all.
                const phases = agent.manifest.phases
                const phased = isPhased(phases)
                return json(
                    agent.tools.specs().map((spec) => ({
                        slug: spec.slug,
                        summary: spec.summary,
                        mutating: spec.mutating,
                        trust: spec.trust,
                        // Why a provider tool declares itself trusted when the default is untrusted.
                        // It exists because the boot warning fired on every start of every
                        // system-provider agent, and a warning always present for a correct
                        // configuration is one nobody reads — so the reason belongs where a person is
                        // already looking at the catalogue. Omitted here, an attached reader sees the
                        // column silently blank, which is the same failure one layer out.
                        ...(spec.trustReason === undefined
                            ? {}
                            : { trustReason: spec.trustReason }),
                        provider: spec.provider ?? "local",
                        tags: spec.tags,
                        ...(phased ? { phases: phasesFor(phases, spec) } : {}),
                    })),
                )
            }),
        { capability: "read" },
    )

    /**
     * The agent's indexed skills.
     *
     * This answered `{ skills: [], supported: false }` — correct when it was written and false
     * from the moment Phase 5 shipped, which was several phases before this line was read again.
     * `supported` becomes **`configured`**, and the distinction it draws is the one that still
     * matters: an agent with no `skills:` block and an agent whose skills directory is empty are
     * different states, and an empty array alone cannot tell them apart. What is gone is the third
     * reading it used to carry — "this build cannot do skills" — which is no longer a thing.
     *
     * The spec also promised a "last-selected time" per skill. Nothing tracks it: selection
     * happens per turn in the harness and is written nowhere, so the field would need a store
     * column. The spec drops the promise rather than this route faking it with a null.
     */
    router.add(
        "GET",
        "/v1/agents/:id/skills",
        (context) =>
            withAgent(runtime, context, (agent) => {
                const catalogue = agent.skills
                if (catalogue === undefined) return json({ skills: [], configured: false })
                return json({
                    configured: true,
                    maxActive: catalogue.maxActive,
                    threshold: catalogue.threshold,
                    // Whether every entry came off the cache, which is what the boot criterion
                    // measures — and the difference between a cold scan and a warm one is seconds.
                    cached: catalogue.cached,
                    skills: catalogue.skills.map((skill) => ({
                        name: skill.name,
                        description: skill.frontmatter.description,
                        tokens: skill.tokens,
                        // Selection is BM25 over the description, so there is no keyword list to
                        // report here — that is knowledge's gate, not skills'. `whenNotToUse` is
                        // reported because it is the half of a skill's guidance that has no other
                        // surface, and absent is a valid and warned-about state rather than an error.
                        ...(skill.frontmatter.whenNotToUse === undefined
                            ? {}
                            : { whenNotToUse: skill.frontmatter.whenNotToUse }),
                        // Runnable entries in `scripts/`, exposed as tools only while the skill is
                        // active. Named rather than counted: a skill's scripts are the part an
                        // operator has to have approved.
                        scripts: skill.scripts.map((plan) => plan.slug),
                    })),
                })
            }),
        { capability: "read" },
    )

    router.add(
        "GET",
        "/v1/agents/:id/context",
        (context) =>
            withAgent(runtime, context, async (agent) => {
                const sessionKey = context.url.searchParams.get("sessionKey")
                const input = context.url.searchParams.get("input")
                return json(
                    await agent.previewContext({
                        ...(sessionKey === null ? {} : { sessionKey }),
                        ...(input === null ? {} : { input }),
                    }),
                )
            }),
        { capability: "read" },
    )

    // ─── Channel webhooks ────────────────────────────────────────────────────────────────

    /**
     * Unauthenticated by design: the provider does not carry our bearer token.
     *
     * Verification is the transport's, because only it knows what its provider signs. Core caps the
     * body and routes by id. `handleWebhook` answers 404 for both an unknown agent and an unknown
     * channel, so probing this path cannot enumerate the runtime.
     */
    router.add(
        "POST",
        "/v1/channels/:channelId/webhook/:agentId",
        async (context) => {
            const body = await readJson(context.request)
            if (body.kind === "error") return fail(body.error, 400)

            const headers: Record<string, string> = {}
            context.request.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value
            })

            const outcome = await runtime.channels.handleWebhook(
                context.params.agentId ?? "",
                context.params.channelId ?? "",
                { body: body.value, headers },
            )
            return new Response(outcome.detail ?? "", {
                status: outcome.status,
                headers: { "content-type": "text/plain; charset=utf-8" },
            })
        },
        { capability: "open" },
    )

    // ─── Event stream ────────────────────────────────────────────────────────────────────

    /**
     * The firehose. Every event the runtime emits, optionally narrowed by agent and by type.
     *
     * This is a **wildcard** subscriber, which after the per-subscriber chunk opt-in means it
     * receives no `model.chunk` unless it asks — and that turned `?types=model.chunk` into a
     * request that streamed nothing, forever, with no error. Rule 8 wearing a query string.
     *
     * So naming `model.chunk` in `types` *is* the opt-in, alongside the explicit `?chunks=true`.
     * Asking for a type is asking for it, and refusing the obvious spelling of the request would
     * be an error nobody learns anything from. What keeps an implication honest is that it is
     * reported rather than assumed: the `stream.subscribed` preamble states the filter and the
     * resolved chunk decision, so a reader sees what it got instead of inferring it from silence.
     * `implied` names *why* it is on, which is the difference between a resolved state and a
     * surprising one.
     */
    router.add(
        "GET",
        "/v1/events",
        (context) => {
            const agentId = context.url.searchParams.get("agentId")
            // Named explicitly, so it answers like every other named agent rather than opening a
            // stream that silently matches nothing — which is the failure `unknown_event_type`
            // below was added to remove, in a different costume.
            if (agentId !== null && !reachesAgent(context.principal, agentId)) {
                return notFound("agent", agentId)
            }
            const types = context.url.searchParams.get("types")?.split(",").filter(Boolean)
            const asked = context.url.searchParams.get("chunks") === "true"
            const implied = types?.includes("model.chunk") === true
            const chunks = asked || implied

            // **An unknown type is refused rather than filtered.** This accepted any string at
            // all, so `?types=turn.ended` — the plural nobody can keep straight — opened a stream
            // that matched nothing and stayed open forever: no error, no frames, and a client with
            // every reason to believe the runtime was idle. Rule 8 with a query parameter in front
            // of it, and unfixable until `EVENT_TYPES` existed, because `EventDataMap` is a *type*
            // and nothing at runtime could enumerate it.
            const unknown = types?.filter(
                (type) => !(EVENT_TYPES as readonly string[]).includes(type),
            )
            if (unknown !== undefined && unknown.length > 0) {
                const suggestion = nearest(unknown[0] ?? "", EVENT_TYPES)
                return fail(
                    {
                        code: "unknown_event_type",
                        message: `No such event type: ${unknown.join(", ")}.`,
                        hint:
                            suggestion === undefined
                                ? "The full catalogue is the event table in docs/04-SPEC-WIRE.md. Omit ?types= to receive every event."
                                : `Did you mean "${suggestion}"? The full catalogue is the event table in docs/04-SPEC-WIRE.md.`,
                        field: "types",
                    },
                    400,
                )
            }

            return sseResponse({
                ...(context.request.signal === undefined ? {} : { signal: context.request.signal }),
                start: ({ send }) => {
                    send({
                        event: "stream.subscribed",
                        data: {
                            agentId: agentId ?? null,
                            types: types ?? null,
                            chunks,
                            ...(chunks && !asked ? { implied: "types names model.chunk" } : {}),
                        },
                    })
                    return runtime.bus.on(
                        "*",
                        (event) => {
                            if (agentId !== null && event.agentId !== agentId) return
                            /**
                             * **The scope, on the firehose.**
                             *
                             * `?agentId=` is a convenience filter a caller chooses; this is a
                             * boundary they cannot. Without it a key scoped to one agent could open
                             * `/v1/events` with no parameter at all and read every other agent's
                             * turns, prompts and tool calls — the widest disclosure on the surface,
                             * and reachable by *omitting* something rather than by asking for it.
                             *
                             * An event with no `agentId` is runtime-wide and belongs to everyone; a
                             * session-scoped one is checked too, because a key narrowed to a
                             * session prefix is narrowed for reading as much as for writing.
                             */
                            if (
                                event.agentId !== undefined &&
                                !reachesAgent(context.principal, event.agentId)
                            )
                                return
                            if (
                                event.sessionKey !== undefined &&
                                !reachesSession(context.principal, event.sessionKey)
                            )
                                return
                            if (
                                types !== undefined &&
                                types.length > 0 &&
                                !types.includes(event.type)
                            )
                                return
                            send({ event: event.type, data: event })
                        },
                        { chunks },
                    )
                },
            })
        },
        { capability: "read", streaming: true },
    )

    // ─── Dispatch ────────────────────────────────────────────────────────────────────────

    const dispatch = async (request: Request): Promise<Response> => {
        let url: URL
        try {
            url = new URL(request.url)
        } catch {
            return fail(
                {
                    code: "bad_request_url",
                    message: "The request URL could not be parsed.",
                    hint: "This usually means the server was handed a relative URL. A handler mounted inside another framework needs an absolute request.url.",
                },
                400,
            )
        }

        /**
         * `HEAD` and `OPTIONS`, answered from the route table at dispatch.
         *
         * At dispatch and not per route, because `Allow` is only correct if it is derived: a route
         * added next week would otherwise accept `GET` and advertise nothing, and the header
         * nobody looks at is the one that goes stale silently. `router.match` already computes the
         * method set for a path — a request whose method matches no route comes back as
         * `kind: "method"` carrying every method that path does accept, which is exactly the
         * `Allow` value.
         */
        const method = request.method.toUpperCase()

        if (method === "OPTIONS") {
            const paths = router.match("OPTIONS", url.pathname)
            if (paths.kind === "method") {
                // `HEAD` is advertised wherever `GET` is answered, and only there — see below for
                // the streams, where it is not.
                const head = router.match("HEAD", url.pathname)
                const streams = head.kind === "method" && streamingAt(router, url.pathname)
                const allow = [
                    ...paths.allowed,
                    ...(paths.allowed.includes("GET") && !streams ? ["HEAD"] : []),
                    "OPTIONS",
                ]
                /**
                 * A real preflight, not just an `Allow`.
                 *
                 * This answered `204` with `Allow` and no `Access-Control-*` at all, which is
                 * useless as a preflight *and* useless as a guard: a browser reads the missing
                 * headers as "not permitted", so no third-party page could call this API even with
                 * its origin explicitly allowed. The `Allow` header stays — it is the HTTP answer
                 * to `OPTIONS` and is what a non-browser caller is asking for.
                 */
                return withCors(
                    request,
                    new Response(null, {
                        status: 204,
                        headers: {
                            allow: allow.join(", "),
                            ...(options.origin === undefined
                                ? {}
                                : preflightHeaders(request, allow)),
                        },
                    }),
                )
            }
            // Falls through to the 404 below. An OPTIONS for a path that does not exist is a 404,
            // not a 204 listing nothing — the second reads as "this path exists and accepts
            // nothing", which is a different and wrong statement.
        }

        if (method === "HEAD") {
            const get = router.match("GET", url.pathname)
            if (get.kind === "found") {
                /**
                 * **A stream refuses `HEAD`, and that is deliberate rather than an oversight.**
                 *
                 * Answering it as `GET` would run the handler, which subscribes to the bus or
                 * attaches to a turn buffer — and then discard the body. Nothing ever reads that
                 * stream, so its `cancel()` never fires and the subscription is never torn down:
                 * one leaked listener per probe, and a leaked buffer listener pins its buffer
                 * against eviction (decision 11.158, found the hard way one stage ago). A
                 * monitoring system polling `HEAD /v1/events` every thirty seconds would walk the
                 * process into the ground while every endpoint kept answering correctly.
                 *
                 * So: 405 naming the reason, rather than a leak or a lie about the body.
                 */
                if (get.streaming) {
                    return fail(
                        {
                            code: "method_not_allowed",
                            message: `HEAD is not allowed on ${url.pathname}.`,
                            hint: "This path answers with an open event stream. A HEAD would have to start one and then throw the body away, leaving a subscription nothing ever closes — so it is refused rather than leaked. Use GET, or GET /v1/health to check the server is up.",
                        },
                        405,
                        { allow: "GET, OPTIONS" },
                    )
                }

                const crossOrigin = refuseOrigin(request)
                if (crossOrigin !== undefined) return crossOrigin

                const who = await resolve(request, url.pathname, get.capability)
                if (who instanceof Response) return who

                // The headers GET would return, with no body. The handler really runs — that is
                // what makes the status and the content-type true rather than guessed.
                const response = await runHandler(get.handler, {
                    request,
                    url,
                    params: get.params,
                    principal: who,
                })
                return withCors(
                    request,
                    new Response(null, { status: response.status, headers: response.headers }),
                )
            }
        }

        const match = router.match(method, url.pathname)
        if (match.kind === "method") {
            return fail(
                {
                    code: "method_not_allowed",
                    message: `${method} is not allowed on ${url.pathname}.`,
                    hint: `This path accepts ${match.allowed.join(", ")}.`,
                },
                405,
                { allow: match.allowed.join(", ") },
            )
        }
        if (match.kind === "none") {
            return fail(
                {
                    code: "not_found",
                    message: `No route for ${request.method} ${url.pathname}.`,
                    hint: "Every path is under /v1. See docs/04-SPEC-WIRE.md for the surface.",
                },
                404,
            )
        }

        // **Before the open-path check, not after.** `POST /v1/channels/…` is open by prefix and
        // changes state, so a guard sitting behind authentication would leave the one
        // state-changing unauthenticated route unprotected — which is the half of the DNS-rebinding
        // hole that a configured token does not close.
        const crossOrigin = refuseOrigin(request)
        if (crossOrigin !== undefined) return crossOrigin

        const who = await resolve(request, url.pathname, match.capability)
        if (who instanceof Response) return who

        return withCors(
            request,
            await runHandler(match.handler, {
                request,
                url,
                params: match.params,
                principal: who,
            }),
        )
    }

    /**
     * The same resolution, without dispatching — for the WebSocket handshake.
     *
     * `"/v1/ws"` is the pathname it is asked about, and the capability is `read`: a socket only
     * ever receives events, and a `stop` frame is refused by the same registry `POST /stop` uses.
     * Naming the path rather than taking one is deliberate — this is not a general-purpose
     * authenticator for any route, it is the one the socket needs.
     */
    return Object.assign(dispatch, {
        authenticate: (request: Request) => resolve(request, "/v1/ws", "read"),
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * One write path for POST and PATCH.
 *
 * The validation itself is core's `prepareScheduleWrite`, so the API and the manifest reconciler
 * accept and refuse exactly the same things — a check only one of two writers performs is a check
 * they disagree about.
 */
/**
 * Refuse a write to a schedule the **manifest** declares.
 *
 * `reconcileSchedules` loops over every schedule in the file and upserts it with `origin:
 * "manifest"` and every field from the file, so an edit through here lasts exactly until the next
 * boot: a PATCH is overwritten and a DELETE is re-created with a fresh anchor. The route reported
 * `200`, the listing agreed, and one restart later it was back — hard rule 8's exact shape, and the
 * failure `schedules --disable` already refuses at the terminal for the same reason.
 *
 * Found while putting a browser in front of these routes: the CLI had the check and the API did not,
 * which is *"a check that only one surface performs is a check the two disagree about"* one surface
 * further out. The prose differs because the audiences do — the terminal names the file and the line
 * to change, a client gets a code to branch on — but both refuse rather than write.
 *
 * Not fixed by editing `agent.yaml` from here: `manifest/edit.ts` is the one writer, and a schedule
 * lives in a sequence whose index this route has no business knowing. `PATCH /config` sets the whole
 * `schedules` list, which is the honest way to change a declared one.
 */
function manifestOwned(existing: ScheduleRecord): Response | undefined {
    if (existing.origin !== "manifest") return undefined
    return fail(
        {
            code: "schedule_manifest_owned",
            message: `Schedule "${existing.id}" is declared in this agent's manifest, so the manifest decides it.`,
            hint: "Writing it here would last until the next start — reconciliation restores every field from the file, enabled included. Change the `schedules:` entry instead, with PATCH /v1/agents/:id/config, or create a separate schedule through this route.",
        },
        409,
    )
}

async function writeSchedule(
    runtime: Runtime,
    agent: Agent,
    body: unknown,
    existing: ScheduleRecord | undefined,
): Promise<Response> {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return fail(
            {
                code: "schedule_invalid",
                message: "A schedule must be a JSON object.",
                hint: "Send { id, kind, expr, task, deliver } — see docs/02-SPEC-MANIFEST.md.",
            },
            400,
        )
    }

    try {
        const row = prepareScheduleWrite({
            agentId: agent.id,
            body: body as Record<string, unknown>,
            channelIds: agent.manifest.channels.map((channel) => channel.id),
            roleNames: Object.keys(agent.manifest.model),
            now: Date.now(),
            // Never `manifest`: a row written here must survive a reload, and marking it as the
            // manifest's would let the next reconciliation delete something no file describes.
            origin: "api",
            ...(existing === undefined ? {} : { existing }),
        })
        const saved = await agent.store.schedules.upsert(row)
        // The timer is armed to the nearest due time, so a new schedule sooner than that would
        // otherwise wait out the current horizon before being noticed.
        runtime.scheduler.changed()
        return json(saved, existing === undefined ? 201 : 200)
    } catch (error) {
        const detail = isHarnessError(error)
            ? error.toDetail()
            : {
                  code: "schedule_invalid",
                  message: error instanceof Error ? error.message : String(error),
                  hint: "See docs/02-SPEC-MANIFEST.md for the schedule fields.",
              }
        return fail(detail, 400)
    }
}

/**
 * One asset lookup for the three routes above, so the table is consulted in a single place.
 *
 * The throw is an invariant rather than a 404: every path passed here is a literal that
 * `spec.test.ts` has already matched against `WEB_ASSETS`, so a miss means the build produced
 * something other than what the source imports — which is a broken deployment, not a missing file,
 * and a 404 would read as the latter.
 */
function web(path: string, context: RequestContext): Response {
    const response = serveAsset(path, context.request)
    if (response === undefined)
        throw new HarnessError({
            code: "web_asset_missing",
            message: `No web asset for ${path}.`,
            hint: "The routes in handler.ts and the table in web.ts have diverged, which spec.test.ts asserts cannot happen — so this build is inconsistent. Rebuild with `bun run build`.",
        })
    return response
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    })
}

/** Every error goes out in the one envelope the spec fixes. */
/**
 * Paths reachable without the token.
 *
 * The probes and the webhook, all for the same reason: the caller cannot hold our token, and a
 * load balancer probing with a bearer header it does not have would mark a healthy process
 * unhealthy.
 *
 * **`/v1/ready` belongs here and was missing**, which made the container story not work: a
 * published port needs a non-loopback bind, a non-loopback bind requires a token, and the
 * readiness probe then got 401 forever. An orchestrator's readiness probe is precisely the caller
 * this exemption describes — and `/v1/ready` discloses strictly *less* than `/v1/health`, which
 * was already open: a status and an agent count, without the version. Found by writing the
 * Dockerfile's HEALTHCHECK, not by reading this list.
 *
 * A function rather than an expression inside the dispatcher because `HEAD` has to ask the same
 * question, and two copies of an auth exemption is how one of them gains an entry the other does
 * not.
 */
function isOpenPath(pathname: string): boolean {
    return (
        pathname === "/v1/health" ||
        pathname === "/v1/ready" ||
        pathname.startsWith("/v1/channels/") ||
        /**
         * The UI shell and its two assets.
         *
         * Not a relaxation: a page load has no header to carry a bearer in, so a credential-gated
         * shell is a shell nobody can reach. **The page holds no data** — every value it displays
         * comes from `/v1` with a key, and an unauthenticated reader learns only that a Dispach
         * server is here, which `/v1/health` already tells them.
         *
         * Derived from `WEB_PATHS` rather than matched by prefix. `startsWith("/assets/")` would
         * open any future path under it, and the set of things served from a directory is exactly
         * the kind of list that grows without anybody re-reading the auth rule.
         */
        WEB_PATHS.includes(pathname) ||
        /**
         * The reference, and the document behind it.
         *
         * Open for the same reason `/v1/health` is, and for one more: a description of which routes
         * exist is not a secret — the spec is in the repository and the client package is
         * published — and gating it means a developer cannot read the API of a server they have not
         * yet obtained a credential for, which is the one moment a reference is most useful.
         *
         * It discloses nothing about *this* process: the document is generated from the route
         * table, so it carries no agent id, no session key and no configuration. Named explicitly
         * rather than matched by prefix, for the reason the asset list is.
         */
        pathname === "/docs" ||
        pathname === "/v1/openapi.json"
    )
}

/** Whether the `GET` route at this path answers with an open stream. */
function streamingAt(router: Router<Handler>, pathname: string): boolean {
    const get = router.match("GET", pathname)
    return get.kind === "found" && get.streaming
}

/** Run a matched handler, turning a throw into a response. Shared with the `HEAD` path. */
async function runHandler(handler: Handler, context: RequestContext): Promise<Response> {
    try {
        return await handler(context)
    } catch (error) {
        if (isHarnessError(error)) return fail(error.toDetail(), 400)
        return fail(
            {
                code: "internal_error",
                message: error instanceof Error ? error.message : String(error),
                hint: "An unexpected failure in the server. The runtime's event stream carries what happened around it.",
            },
            500,
        )
    }
}

/**
 * `hint` is overridable because the generic sentence talks about session keys, and it became the
 * answer to a common client mistake the moment attaching to an unknown turn started returning 404
 * — advice about channel segments is noise on a turn id, and noise in a hint is what teaches people
 * to stop reading them.
 */
function notFound(kind: string, id: string, hint?: string): Response {
    return fail(
        {
            code: `${kind}_not_found`,
            message: `No ${kind} "${id}".`,
            hint:
                hint ??
                // No indefinite article: `A ${kind}` printed "A agent id is case-sensitive" on the
                // most common 404 this server returns, which is the kind of blemish that only ever
                // shows up in real output and makes the rest of the sentence read as unproofed.
                `Check the id — it is case-sensitive, and a session key includes its channel segment.`,
        },
        404,
    )
}

/**
 * What a request presented as its bearer token, or `""` when it presented nothing.
 *
 * `""` rather than `undefined` so the constant-time comparison below always has something to
 * compare: an early return on "no header" would make the absent-token case measurably faster than
 * the wrong-token one.
 */
/**
 * The presented bearer, when there is one. Used only to decide whether a claim is being exchanged.
 *
 * Separate from `presentedToken` because the two answer different questions and want different
 * empty values: authentication needs a string to compare in constant time, while "is this a claim
 * attempt" needs to tell an absent header from an empty one.
 */
function presentedClaim(request: Request): string | undefined {
    const header = request.headers.get("authorization") ?? ""
    if (!header.startsWith("Bearer ")) return undefined
    const value = header.slice(7)
    return value === "" ? undefined : value
}

function withAgent(
    runtime: Runtime,
    context: RequestContext,
    work: (agent: Agent) => Promise<Response> | Response,
): Promise<Response> | Response {
    const id = context.params.id ?? ""
    const agent = runtime.list().find((candidate) => candidate.id === id)
    if (agent === undefined) return notFound("agent", id)
    /**
     * **Out of scope answers 404, and it is the same 404.**
     *
     * Byte-identical to the answer for an agent that does not exist, deliberately: a `403` here
     * would confirm the agent is real, which turns a key scoped to one agent into a way to
     * enumerate every other one on the server. The same reasoning `unauthorized()` gives for not
     * distinguishing a revoked key from a wrong one, one layer up.
     *
     * This is the **single** choke point for agent scope, which is why it is here rather than in
     * each route: 24 of the 39 routes reach an agent through this function, and a check written at
     * each of them is a check the twenty-fifth will not have.
     */
    if (!reachesAgent(context.principal, id)) return notFound("agent", id)
    return work(agent)
}

/**
 * The agents this caller may see, in listing order.
 *
 * Filtered rather than refused: a listing is how a client discovers what it can reach, and a scoped
 * key asking "what is there" should get an honest answer about *its* world rather than a 403 about
 * somebody else's. The unscoped path returns the array untouched, so the common case costs nothing.
 */
function visibleAgents<T extends { readonly id: string }>(
    principal: Principal,
    agents: readonly T[],
): readonly T[] {
    if (!isScoped(principal)) return agents
    return agents.filter((agent) => reachesAgent(principal, agent.id))
}

/**
 * The sessions this caller may see.
 *
 * Same argument as `visibleAgents`, and the same reason it is a function rather than a filter
 * written at each call site: `GET /sessions` is not the only place a session key is listed.
 */
function visibleSessions<T extends { readonly sessionKey: string }>(
    principal: Principal,
    sessions: readonly T[],
): readonly T[] {
    if (!isScoped(principal)) return sessions
    return sessions.filter((session) => reachesSession(principal, session.sessionKey))
}

/**
 * A named session this caller may not reach, as a 404 — or `undefined` when they may.
 *
 * Every route taking `:key`, plus `POST /messages` where the key arrives in the **body**. That one
 * is the reason this is a helper: a caller may name any session they like there, so without a check
 * a key scoped to `team_42:` could write into `team_7:`'s conversation, which is the boundary being
 * bought here rather than a filter.
 */
function outsideSession(context: RequestContext, sessionKey: string): Response | undefined {
    return reachesSession(context.principal, sessionKey)
        ? undefined
        : notFound("session", sessionKey)
}

/**
 * The shared shape of an agent in the listing and at the head of its detail.
 *
 * **There is no current phase here, and the field is named to say so.** It was `phase: null` for
 * every agent — the spec's own listing promises `phase` — and filling that in with the phase the
 * agent is "in" would be decision 5.19's failure on an HTTP surface: a phase is per *session*, and
 * an agent hosting three conversations is in three phases at once. The agent-level facts are the
 * phase a new session **starts** in and the names that exist, so those are what it reports, under
 * a name a reader cannot mistake for the other thing.
 *
 * `phases` is present only when the manifest declares more than one, matching the question the
 * runtime itself asks before registering `phase_set`. An unphased agent has no entry phase to
 * name, so `entryPhase` is `null` there rather than inventing a name for the single implicit one.
 */
function summary(runtime: Runtime, agent: Agent) {
    const phases = agent.manifest.phases
    const phased = isPhased(phases)
    return {
        id: agent.id,
        name: agent.manifest.name ?? agent.id,
        status: "loaded",
        model: agent.manifest.model.main.id,
        // Runtime status **layered over the manifest**, because a panel that offers "connect" needs
        // both halves and neither alone is the answer. `statusOf` knows what is running and nothing
        // about a channel that is switched off — a disabled channel is never constructed, so it has
        // no status at all, and a listing built from it would omit exactly the channel somebody
        // opened the page to switch back on.
        channels: agent.manifest.channels.map((channel) => {
            const running = runtime.channels
                .statusOf(agent.id)
                .find((entry) => entry.id === channel.id)
            const variable =
                typeof (channel as Record<string, unknown>).tokenEnv === "string"
                    ? ((channel as Record<string, unknown>).tokenEnv as string)
                    : undefined
            return {
                ...(running ?? {}),
                // After the spread, so the manifest's own id and type win. They are equal to the
                // transport's by construction since 0.1.3, and the manifest is what was asked about.
                id: channel.id,
                type: channel.type,
                enabled: channel.enabled,
                ...(variable === undefined
                    ? {}
                    : {
                          credentialEnv: variable,
                          // The **name and whether it has a value**, never the value. A surface that
                          // could read a credential back is one a leaked operator key turns into a
                          // credential dump, and nothing needs it.
                          credentialSet: agent.hasEnv(variable),
                      }),
            }
        }),
        entryPhase: phased ? (entryPhase(phases) ?? null) : null,
        ...(phased ? { phases: Object.keys(phases) } : {}),
    }
}

/**
 * The state fields both lifecycle routes return, so the two cannot describe one row differently.
 *
 * `disabledAt` and `reason` survive an enable — they are the record of what happened — so a started
 * agent legitimately carries both, and a client reading them has to look at `status` rather than at
 * their presence.
 */
function stateFields(state: AgentStateRecord): Record<string, string> {
    return {
        ...(state.disabledAt === undefined ? {} : { disabledAt: state.disabledAt }),
        ...(state.reason === undefined ? {} : { reason: state.reason }),
    }
}

async function readJson(
    request: Request,
): Promise<{ kind: "ok"; value: unknown } | { kind: "error"; error: ErrorDetail }> {
    // Checked before reading, so a declared 500 MB body is refused rather than buffered. A body
    // with no content-length is still bounded by the read below.
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return {
            kind: "error",
            error: {
                code: "body_too_large",
                message: `The request body declares ${declared} bytes; the limit is ${MAX_BODY_BYTES}.`,
                hint: "This cap is enforced before a channel plugin sees anything, so a plugin never has to defend against a large POST.",
            },
        }
    }

    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
        return {
            kind: "error",
            error: {
                code: "body_too_large",
                message: `The request body is ${raw.length} bytes; the limit is ${MAX_BODY_BYTES}.`,
                hint: "Send less. A message longer than this is not a message.",
            },
        }
    }
    if (raw === "") return { kind: "ok", value: {} }

    try {
        return { kind: "ok", value: JSON.parse(raw) }
    } catch (cause) {
        return {
            kind: "error",
            error: {
                code: "body_not_json",
                message: `The request body is not valid JSON: ${
                    cause instanceof Error ? cause.message : String(cause)
                }`,
                hint: "Send application/json. A shell quoting mistake is the usual cause — check for unescaped quotes inside the payload.",
            },
        }
    }
}

/** `"none"` | a channel id | `{ channel, to }`. Absent means none. */
/**
 * The `from` field on `POST /messages`.
 *
 * Validated strictly rather than coerced, and the strictness is the point on this one field: `kind`
 * decides whether the turn is gated, so an unrecognised value must **refuse** rather than fall to a
 * default. Both defaults are wrong — `"user"` silently un-gates a peer message somebody tried to
 * declare, and `"agent"` gates an operator's own turn for a typo — so there is no default at all.
 *
 * The id is capped because it is carried onto a row, an event and a fence label, and a megabyte of
 * "identity" in a prompt is a cheap way to push everything else out of the window.
 */
function parseFrom(
    value: unknown,
): { kind: "ok"; from: TurnSender | undefined } | { kind: "error"; error: ErrorDetail } {
    if (value === undefined || value === null) return { kind: "ok", from: undefined }

    const invalid = (
        message: string,
        hint: string,
        field = "from",
    ): { kind: "error"; error: ErrorDetail } => ({
        kind: "error",
        error: { code: "sender_invalid", message, hint, field },
    })

    if (typeof value !== "object") {
        return invalid(
            "from must be an object.",
            'Send { "from": { "id": "agent:ops-bot", "kind": "agent" } }, or omit it entirely for a turn the token-holder is sending itself.',
        )
    }

    const raw = value as { id?: unknown; name?: unknown; kind?: unknown }
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
        return invalid(
            "from.id is required and must be a non-empty string.",
            "Use a stable identity in your own namespace — `agent:ops-bot`, `user:018f…`, an email address. It is opaque to this runtime and is recorded on the turn so an audit can answer who asked.",
            "from.id",
        )
    }
    if (raw.id.length > MAX_SENDER_ID) {
        return invalid(
            `from.id is ${raw.id.length} characters, over the ${MAX_SENDER_ID} limit.`,
            "A sender id is an identifier, not a payload. It is rendered into the prompt's fence label, so an unbounded one spends the context window the message needs.",
            "from.id",
        )
    }
    if (typeof raw.kind !== "string" || !(SENDER_KINDS as readonly string[]).includes(raw.kind)) {
        const suggestion =
            typeof raw.kind === "string" ? nearest(raw.kind, SENDER_KINDS) : undefined
        return invalid(
            `from.kind must be one of: ${SENDER_KINDS.join(", ")}.`,
            `${suggestion === undefined ? "" : `Did you mean "${suggestion}"? `}This field decides the trust boundary — "agent" fences the message and blocks mutating tools for the turn, "user" does not — so there is no default and an unknown value is refused rather than guessed at. A turn the token-holder is sending itself omits "from".`,
            "from.kind",
        )
    }
    if (raw.name !== undefined && typeof raw.name !== "string") {
        return invalid(
            "from.name must be a string when present.",
            "It is a display name only and is rendered inside the fence, never above it. Omit it if you have none.",
            "from.name",
        )
    }

    return {
        kind: "ok",
        from: {
            id: raw.id,
            kind: raw.kind as SenderKind,
            ...(raw.name === undefined ? {} : { name: raw.name.slice(0, MAX_SENDER_NAME) }),
        },
    }
}

/**
 * The `Idempotency-Key` header.
 *
 * A **header** rather than a body field, because it is a fact about the request rather than about
 * the message — the same reason it is a header everywhere else this convention appears — and
 * because that makes it uniform for any later POST without each one growing its own field.
 *
 * Refused when present and unusable rather than ignored. A client that sends a malformed key
 * believes its retries are safe; silently dropping it is the one outcome that leaves them wrong
 * about exactly the guarantee they asked for.
 */
function parseIdempotencyKey(
    request: Request,
): { kind: "ok"; key: string | undefined } | { kind: "error"; error: ErrorDetail } {
    const raw = request.headers.get("idempotency-key")
    if (raw === null) return { kind: "ok", key: undefined }
    const key = raw.trim()
    const bad = (message: string): { kind: "error"; error: ErrorDetail } => ({
        kind: "error",
        error: {
            code: "idempotency_key_invalid",
            message,
            hint: `Send 1-${MAX_IDEMPOTENCY_KEY} printable ASCII characters that are unique per logical request — a UUID is the usual choice. Omit the header entirely to accept that a retry runs the turn again. Printable ASCII because the key is a database key, and node:sqlite truncates a bound string at a NUL byte where bun:sqlite stores it whole.`,
            field: "Idempotency-Key",
        },
    })
    if (key === "") return bad("Idempotency-Key is present but empty.")
    if (key.length > MAX_IDEMPOTENCY_KEY) {
        return bad(
            `Idempotency-Key is ${key.length} characters, over the ${MAX_IDEMPOTENCY_KEY} limit.`,
        )
    }
    if (!/^[\x20-\x7e]+$/.test(key)) {
        return bad("Idempotency-Key contains characters that are not printable ASCII.")
    }
    return { kind: "ok", key }
}

/**
 * What the key is matched against, so a reused key with different text can be refused.
 *
 * SHA-256 of the session key and the text together: the *same* text in two different sessions is
 * two different logical requests, and treating them as one replay would silently drop the second
 * conversation's message. Hashed rather than stored so the table does not hold a second copy of
 * every message for a day.
 */
async function inputHash(sessionKey: string, text: string): Promise<string> {
    const bytes = new TextEncoder().encode(`${sessionKey}\u0000${text}`)
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
}

function parseDeliver(
    value: unknown,
):
    | { kind: "ok"; target: { channel: string; to: string } | undefined }
    | { kind: "error"; error: ErrorDetail } {
    if (value === undefined || value === null || value === "none") {
        return { kind: "ok", target: undefined }
    }
    if (typeof value === "object") {
        const target = value as { channel?: unknown; to?: unknown }
        if (typeof target.channel === "string" && typeof target.to === "string") {
            return { kind: "ok", target: { channel: target.channel, to: target.to } }
        }
    }
    return {
        kind: "error",
        error: {
            code: "deliver_invalid",
            message: 'deliver must be "none" or { channel, to }.',
            hint: 'A bare channel id is not enough on an API turn: the request has no originating conversation, so there is no recipient to infer. Send { "channel": "tg", "to": "12345" }, or "none" to read the reply from the event stream.',
            field: "deliver",
        },
    }
}

/**
 * A turn with no buffer, answered from its stored row rather than from memory.
 *
 * One frame and a close, so a client written as "open the stream and loop over it" needs no special
 * case — it sees a terminal frame and the loop ends, exactly as it would for a turn it watched to
 * completion. The alternative was a 404 for an evicted turn, which is wrong in the direction that
 * matters: the turn happened, the answer exists, and the client is one GET away from it.
 *
 * `stream.ended` for a finished turn; `stream.unavailable` for one still running somewhere this
 * process cannot see. Both carry the row's own `status`, never a status this function decided.
 */
function finishedStream(record: TurnRecord): Response {
    const running = record.status === "running"
    return sseResponse({
        start: ({ send, close }) => {
            send({
                event: running ? "stream.unavailable" : "stream.ended",
                data: {
                    turnId: record.turnId,
                    status: record.status,
                    sessionKey: record.sessionKey,
                    ...(running
                        ? {
                              reason: "no buffer for this turn in this process",
                              hint: "The turn is recorded as running but is not observable here — its events are buffered in whichever process is executing it, and buffers are in-memory and per-process. Poll GET /v1/agents/:id/turns/:turnId for the outcome.",
                          }
                        : {
                              steps: record.steps,
                              ...(record.errorCode === undefined
                                  ? {}
                                  : { errorCode: record.errorCode }),
                              hint: "This turn finished before you attached and its buffer has been evicted. Its full text is in GET /v1/agents/:id/turns/:turnId.",
                          }),
                },
            })
            close()
            return undefined
        },
    })
}

/**
 * Attach to a turn: replay what it has emitted, then tail.
 *
 * `TurnStreams.attach` does both in one synchronous block — a snapshot and a subscription with no
 * `await` between them — which is what makes the handover gapless *and* duplicate-free. Neither
 * failure shows up attaching to an idle turn; both show up under load.
 */
function streamTurn(
    runtime: Runtime,
    turnId: string,
    extra?: { accepted?: unknown; status?: number; chunks?: boolean },
): Response {
    return sseResponse({
        ...(extra?.status === undefined ? {} : { status: extra.status }),
        start: ({ send, close }) => {
            if (extra?.accepted !== undefined)
                send({ event: "turn.accepted", data: extra.accepted })

            // Interest is per *attachment*, so two clients can watch one turn with only one of
            // them paying for tokens — and a client that did not ask never receives them even
            // while another does. That per-listener filter is not a nicety: chunk interest taken
            // by `open` outlives its turn by the retention window, so without it a later
            // non-asking client was served tokens from the buffer's fan-out.
            const attachment = runtime.streams.attach(
                turnId,
                (event: AnyEvent) => {
                    send({ event: event.type, data: event })
                    if (event.type === "turn.end") close()
                },
                { chunks: extra?.chunks === true },
            )

            if (attachment === undefined) {
                // Never buffered here, or ended and evicted. Either way there is nothing to tail;
                // the final state is in the store and the client is told where to look.
                send({
                    event: "stream.unavailable",
                    data: {
                        turnId,
                        reason: "no buffer for this turn in this process",
                        hint: "Read the final state from GET /v1/agents/:id/turns/:turnId. Buffers are in-memory and are evicted after a turn ends.",
                    },
                })
                close()
                return undefined
            }

            // **Before** the replay frames, not after. A client reconstructing text has to learn
            // that a hole exists before it starts concatenating, or it silently builds a shorter
            // reply and believes it. The cap discards the *oldest* events, so the hole is at the
            // front — which is precisely where a client is not looking.
            //
            // One frame carries all three honesty facts rather than three frame types: how much
            // was dropped, whether token history is complete, and what state the turn is in.
            send({
                event: "stream.replay",
                data: {
                    turnId,
                    state: attachment.state,
                    events: attachment.replay.length,
                    truncated: attachment.truncated,
                    dropped: attachment.dropped,
                    chunks: attachment.chunks,
                    ...(attachment.truncated
                        ? {
                              hint: `The oldest ${attachment.dropped} event(s) of this turn were discarded to stay under the buffer cap, so this replay starts mid-turn. The turn's final text is complete in GET /v1/agents/:id/turns/:turnId.`,
                          }
                        : {}),
                },
            })

            for (const event of attachment.replay) {
                send({ event: event.type, data: event })
            }
            if (attachment.state === "ended") close()

            return () => attachment.unsubscribe()
        },
    })
}
