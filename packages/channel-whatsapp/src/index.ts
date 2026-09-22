/**
 * `@dispach/channel-whatsapp` — WhatsApp through Baileys, as an **opt-in plugin**.
 *
 * ```yaml
 * plugins:
 *   - "dispach-whatsapp"       # installed with `dispach plugins add <agent> <repo>`
 * channels:
 *   - type: whatsapp
 *     id: wa
 *     authDir: ./.whatsapp     # the paired session. 0600, and gitignore it.
 *     allowFrom: ["8801711223344"]   # digits, no +. Inbound only, closed by default.
 * ```
 *
 * ## Why this package is not in the binary
 *
 * **Baileys reverse-engineers WhatsApp Web, which WhatsApp's terms do not permit, and there is no
 * appeal path when a number is banned** — including during development. That is a risk an operator
 * takes deliberately for an account they chose; it is not one a runtime should take on behalf of
 * everybody who installs it. So the tarball, the compiled binaries and the container image carry
 * none of this: it is built, typechecked, linted and tested here, imported by nothing, and reaches
 * an agent only through `plugins add`.
 *
 * **Pair a spare number.** Not advice — the recorded position (decision 8.4), and the reason this
 * sentence is in the package README as well as here.
 *
 * ## What it is
 *
 * One self-contained ES module. Baileys is bundled in — no runtime install, hard rule 5 — which is
 * what makes the same directory work in a checkout, in the compiled binary and in the container.
 * Three of Baileys' optional media dependencies stay external (`sharp`, `jimp`,
 * `link-preview-js`); it loads each inside a `catch` and this channel is text, so their absence
 * costs image thumbnails and link previews and nothing else.
 */

import { isAbsolute, resolve } from "node:path"
// **Types only, and that is a rule rather than a preference.** A runtime import from `@dispach/core`
// would be *bundled into this plugin* — a second copy of core inside the host that already has one,
// which is decision 11.238's `instanceof` failure waiting to happen and 1.6 MB of duplicate code
// measured. A plugin needs none of it: `setup` is handed everything it can use.
import type { ChannelFactory, Plugin } from "@dispach/core"
import { type BaileysApi, numberOf, WhatsAppTransport } from "./transport.ts"

export type {
    BaileysApi,
    ConnectionUpdate,
    MessagesUpsert,
    WhatsAppMessage,
    WhatsAppSocket,
    WhatsAppTransportOptions,
} from "./transport.ts"
export { jidOf, numberOf, toInbound, WhatsAppTransport } from "./transport.ts"

/** Where the paired session lives when the manifest does not say. Relative to the agent. */
export const DEFAULT_AUTH_DIR = "./.whatsapp"

/**
 * Construct a WhatsApp transport from a manifest entry.
 *
 * **Nothing is read from the environment and nothing can fail for want of a credential**, which is
 * what makes this channel different from Telegram's: there is no token, only a pairing that has or
 * has not happened yet. A fresh agent is *correctly* configured and unpaired, and says so through
 * `needs_input` rather than through a load failure.
 *
 * What it does check is the shape of `allowFrom`. WhatsApp identifies a person by the digits of
 * their number, and `allowFrom` is matched after folding case and dropping one leading `@` — so
 * `+8801711223344` matches nothing at all, silently. That is the recorded Telegram trap (`@handle`
 * against a numeric chat id) in another provider's clothes, and it earns the same treatment: a
 * refusal at the moment it is typed, because unlike Telegram's there is exactly one correct
 * spelling and no legitimate reason to write the other.
 */
export const whatsappChannel: ChannelFactory = (context) => {
    const configured = stringField(context.config, "authDir") ?? DEFAULT_AUTH_DIR
    const authDir = isAbsolute(configured) ? configured : resolve(context.dir, configured)

    const api = context.config.api as BaileysApi | undefined

    return new WhatsAppTransport({
        id: context.id,
        authDir,
        ...(api === undefined ? {} : { api }),
    })
}

/**
 * An `allowFrom` entry that WhatsApp could never match, or `undefined`.
 *
 * Pure and exported so it can be checked where the value is **written** — the `init` question asks
 * for a number and this is what tells somebody they typed `+880…` — rather than at load. It is
 * deliberately *not* a load-time refusal: `Inbox` already names the refused sender and prints the
 * exact line to paste, in the digits-only spelling this transport reports, so the mistake is caught
 * at the moment it matters by a mechanism that already exists. Adding a second one would mean a
 * runtime import from core, which this package must not have.
 */
export function allowFromProblem(entry: string): string | undefined {
    if (entry === "*") return undefined
    if (entry.includes("@")) return undefined
    const digits = numberOf(entry)
    if (/^[0-9]{6,20}$/.test(digits) && digits === entry) return undefined
    // The "did you mean" branch only when there *are* digits to mean. Checked in this order because
    // `not-a-number` contains a hyphen and would otherwise be told to write itself as the empty
    // string — a suggestion worse than no suggestion.
    const stripped = entry.replace(/[^0-9]/g, "")
    if (/^[0-9]{6,20}$/.test(stripped)) {
        return `write it as digits only — ${stripped} — because WhatsApp identifies a person by the digits of their number and an allowFrom entry is compared literally`
    }
    return `"${entry}" is not a WhatsApp number: use the digits including the country code, with no + and no spaces`
}

/**
 * Package version, declared to the host and kept in step with `package.json` by a test.
 *
 * A constant rather than a `package.json` import, for the reason the Telegram package records: the
 * bundle targets Node and a JSON import resolves differently under Bun, Node and a bundler.
 */
export const VERSION = "0.1.0"

/**
 * This package as a plugin.
 *
 * `setup` registers and does nothing else — no directory is created, no socket is opened, nothing
 * is read. Baileys itself is not even imported until a transport actually starts, which is what
 * keeps the setup budget nowhere near the 200 ms ceiling and keeps 6.8 MB of protocol code off the
 * path of every command that is not `serve`.
 */
export default {
    name: "whatsapp",
    version: VERSION,
    dispachApi: "^0.1",
    permissions: [
        // Baileys talks to WhatsApp's own infrastructure. The hosts are the ones it dials; they are
        // recorded because `permissions` is the vocabulary decision 7.5 promised, and advisory
        // because nothing enforces it in v1 — which `plugins add` says out loud at install time.
        { kind: "network", hosts: ["web.whatsapp.com", "*.whatsapp.net"] },
        // The paired session: credentials equal to being the linked device. Written 0600.
        { kind: "fs", paths: ["<agent>/.whatsapp"], mode: "write" },
    ],
    setup(context) {
        context.defineChannel("whatsapp", whatsappChannel)
    },
} satisfies Plugin

function stringField(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = config[key]
    return typeof value === "string" && value !== "" ? value : undefined
}
