/**
 * Pairing WhatsApp during `init`, between writing the files and finishing.
 *
 * ## Why here rather than "run these two commands afterwards"
 *
 * Somebody who has just typed their WhatsApp number has said what they want; sending them away to
 * start a server and run a second command to collect a code is answering a question with homework.
 * The catalogue interlude set the precedent — an answer that costs time gets its own screen inside
 * the flow, not a paragraph of instructions after it.
 *
 * It sits **after the files are written** for the same reason the skills install does: the channel
 * is constructed from the manifest that was just validated, so there is exactly one description of
 * this channel rather than a second one assembled from the answers.
 *
 * ## What it must not do
 *
 * **It must never fail the init and must never hang.** The agent is already written and valid by the
 * time this runs; a pairing that does not happen is a thing to do later, not a reason to have no
 * agent. Every path here reports and returns, and the wait is bounded — which matters more than
 * usual because the transport **does not pair under Bun**, where no code ever arrives and an
 * unbounded wait would turn the last step of onboarding into a hang.
 *
 * **It is skipped without a terminal.** A scripted `--yes` run has nobody to read a code or hold a
 * phone, and opening a socket to WhatsApp in CI is the expensive default the wizard's own fallback
 * rule exists to prevent. The commands that do it later are named instead.
 */

import { BRAND, type ChannelHost, type ChannelInput, type ChannelTransport } from "@dispach/core"
import { CHANNELS } from "#lib/providers"

/** How long to wait for a code before saying where to get one later. */
const CODE_WAIT_MS = 25_000

/**
 * How long to keep waiting for the phone after the code is on screen.
 *
 * Generous, because the clock a person is working against is finding their phone and typing eight
 * characters. Bounded anyway: an `init` that never returns is worse than one that says "carry on
 * when you are ready" and names the command that shows the state.
 */
const PAIR_WAIT_MS = 120_000

export interface PairRequest {
    readonly manifestPath: string
    readonly dir: string
    readonly number: string
    readonly channelId: string
    /** Where the manifest keeps the session. Defaults to the channel's own default. */
    readonly authDir?: string
    /** Injected by tests, which never reach WhatsApp. */
    readonly factory?: typeof CHANNELS.whatsapp
    readonly codeWaitMs?: number
    readonly pairWaitMs?: number
    readonly out?: (text: string) => void
}

export type PairOutcome = "paired" | "code-shown" | "no-code" | "unavailable"

/**
 * Offer a pairing code and wait for the phone. Never throws.
 *
 * Returns what happened so the caller's closing message can be honest about it — a "next steps"
 * block that says "scan the code" after no code appeared is the kind of true-sounding wrong this
 * project keeps finding.
 */
export async function pairWhatsApp(request: PairRequest): Promise<PairOutcome> {
    const write = request.out ?? ((text: string) => process.stdout.write(text))
    const factory = request.factory ?? CHANNELS.whatsapp
    if (factory === undefined) return "unavailable"

    let transport: ChannelTransport
    try {
        transport = factory({
            id: request.channelId,
            agentId: "",
            dir: request.dir,
            env: {},
            config: { authDir: request.authDir ?? "./.whatsapp", pairWith: request.number },
        })
    } catch {
        // A number the channel refuses was already refused by the wizard, so this is a build that
        // cannot supply the channel at all. Nothing to say that the caller cannot say better.
        return "unavailable"
    }

    let code: string | undefined
    let paired = false
    let failure: string | undefined
    let wake: (() => void) | undefined
    const bump = (): void => {
        wake?.()
        wake = undefined
    }

    const host: ChannelHost = {
        receive: () => {},
        status: (status: string, detail?: string, input?: ChannelInput) => {
            if (status === "needs_input" && input !== undefined && code === undefined) {
                code = input.payload
                bump()
            }
            if (status === "connected") {
                paired = true
                bump()
            }
            void detail
        },
        // Reported rather than swallowed: the Bun limitation arrives here, and it is the one
        // sentence that explains an empty wait.
        error: (detail: unknown) => {
            const message = (detail as { message?: string } | undefined)?.message
            if (message !== undefined && failure === undefined) failure = message
        },
    } as unknown as ChannelHost

    const until = async (deadline: number, done: () => boolean): Promise<void> => {
        const end = Date.now() + deadline
        while (!done() && Date.now() < end) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(500, end - Date.now()))
                wake = () => {
                    clearTimeout(timer)
                    resolve()
                }
            })
        }
    }

    try {
        await transport.start(host)
        write("\nConnecting to WhatsApp…\n")
        await until(request.codeWaitMs ?? CODE_WAIT_MS, () => code !== undefined || paired)

        if (code === undefined && !paired) {
            write(`\nNo pairing code arrived${failure === undefined ? "" : ` — ${failure}`}\n`)
            return "no-code"
        }
        if (code !== undefined && !paired) {
            write(
                `\nOn the phone: WhatsApp › Settings › Linked devices › Link with phone number.\n` +
                    `Enter this code for +${request.number}:\n\n    ${grouped(code)}\n\n` +
                    `Waiting — this finishes on its own, or press ctrl-c and pair later.\n`,
            )
            await until(request.pairWaitMs ?? PAIR_WAIT_MS, () => paired)
        }
        if (paired) {
            write(`\nPaired. WhatsApp is linked to +${request.number}.\n`)
            return "paired"
        }
        return "code-shown"
    } catch {
        return "no-code"
    } finally {
        // Always, including on the paired path: the credentials are on disk and the agent's own
        // run is what should hold the socket. Leaving this one open would put two linked devices
        // on one session.
        await transport.stop().catch(() => {})
    }
}

/** WhatsApp shows its code as two groups of four. Display only — the value is never rewritten. */
function grouped(code: string): string {
    return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

/** What to tell somebody who did not finish pairing here. One sentence per route. */
export function pairLater(agentRef: string): string {
    return `  Pair WhatsApp later: \`${BRAND.slug} channels pair ${agentRef} wa\` — or from the web UI.\n`
}
