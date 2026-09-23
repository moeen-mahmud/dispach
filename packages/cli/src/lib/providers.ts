/**
 * Which tool providers this binary can supply.
 *
 * One table, consumed by every command that boots a runtime, because the alternative is each command
 * registering its own set — and then `validate` accepts a manifest that `run` refuses, or the reverse.
 * A provider missing from one call site is exactly the class of drift the command table exists to stop.
 *
 * `packages/core` cannot import a provider (hard rule 2), so the binary is where the wiring lives.
 * Phase 9 moves this to the plugin loader and reads it from `plugins` in the manifest; the shape is
 * already the shape a loader would produce.
 *
 * No Ink and no React here — this sits on the shared path that `validate --json` runs through, where
 * a rendering import costs more than the whole command.
 */

import telegramPlugin, { telegramChannel } from "@dispach/channel-telegram"
import whatsappPlugin, { whatsappChannel } from "@dispach/channel-whatsapp"
import type {
    BuiltInPlugins,
    ChannelFactory,
    ScriptRunner,
    ToolProviderFactory,
} from "@dispach/core"
import composioPlugin, { composioFromConfig } from "@dispach/tools-composio"
import systemPlugin, { SystemScriptRunner, systemFromConfig } from "@dispach/tools-system"
import webPlugin, { webFromConfig } from "@dispach/tools-web"

export const TOOL_PROVIDERS: Readonly<Record<string, ToolProviderFactory>> = {
    composio: composioFromConfig,
    // Registered, not implied. Naming `system` here means the binary *can* supply shell access; a
    // manifest still has to select the provider and pin `exec` before an agent has any. Availability
    // and grant are separate on purpose — the same separation that keeps `tools.local` opt-in.
    system: systemFromConfig,
    // Two read-only tools whose entire risk surface is which address they can be pointed at. Listed
    // beside the others rather than folded into `system`: an agent that reads the web and an agent
    // that runs commands are different grants, and a manifest should be able to make one and not the
    // other.
    web: webFromConfig,
}

/**
 * How a skill's script runs, from the one package allowed to start a process.
 *
 * Supplied by every command that builds a runtime, and unconditionally — unlike a tool provider, which a
 * manifest has to select. There is no grant here to be careful with: a script only becomes callable once
 * a skill ships one *and* that skill activates, and both of those are the workspace's decision. Omitting
 * it would mean a skill's `scripts/` is silently never discovered, which reads to whoever wrote the skill
 * as the runtime being broken.
 *
 * `env` is `process.env` rather than the manifest's, because this is constructed before any manifest is
 * loaded. It is used for the `PATH` walk in `has()`; the *run* inherits the process environment the same
 * way `exec` does.
 */
export function scriptRunner(): ScriptRunner {
    return new SystemScriptRunner({ env: process.env })
}

/** For an error that has to say what *is* available. */
export const PROVIDER_IDS: readonly string[] = Object.keys(TOOL_PROVIDERS)

/**
 * Which channel types this binary can supply, keyed by the `type` a manifest names.
 *
 * Registered by every command that loads a manifest, not only by `serve`. A `channels:` entry has to
 * validate the same way everywhere or `validate` would refuse a manifest `serve` runs happily —
 * the asymmetry the tool-provider table already exists to prevent.
 */
export const CHANNELS: Readonly<Record<string, ChannelFactory>> = {
    telegram: telegramChannel,
    /**
     * **Bundled, and the two things that costs are stated rather than left to a README.**
     *
     * It was deliberately outside the bundle until now, so that running WhatsApp was a thing an
     * operator opted into by name. Bundling it makes `channels: [{type: whatsapp}]` work with no
     * install step, which is what a person expects of a channel the wizard offers — and moves the
     * opt-in from *obtaining the code* to *configuring the channel*, which is where every other
     * capability's opt-in already lives.
     *
     * **Baileys reverse-engineers WhatsApp Web.** WhatsApp's terms do not permit it and a banned
     * number has no appeal path. Nothing here connects until a manifest names the channel, so a
     * binary that never mentions WhatsApp never opens a socket to it — but the code now ships to
     * everybody, which is a change in what this project distributes rather than in what it does.
     *
     * **It does not pair under Bun**, which means the compiled binaries and the container image
     * carry a channel they cannot finish pairing. The transport says so at start with the remedy,
     * which is the only honest arrangement: a bundled channel that silently did nothing would be
     * worse than one that is absent.
     */
    whatsapp: whatsappChannel,
}

export const CHANNEL_IDS: readonly string[] = Object.keys(CHANNELS)

/**
 * Plugins this binary can resolve by name, keyed by the specifier a manifest writes.
 *
 * The three tables above are what this binary supplies *by default* — every command passes them, so
 * an agent that names no plugins behaves exactly as it did before Phase 9A. This table is what lets a
 * manifest ask for the same capabilities by name, and it layers **over** the defaults so a future
 * third-party plugin can replace one.
 *
 * **Built in rather than imported at runtime, for a structural reason.** A module imported both
 * statically and dynamically makes `bun build --splitting` emit its exports twice and the bundle stops
 * parsing — `SyntaxError: Duplicate export`, which `bun test` walks straight past because tests import
 * source. The imports above are static, so the loader must never `import()` these same packages by
 * name. Registering them here keeps each module imported exactly one way, and `boundaries.test.ts`
 * enforces the rule generally.
 *
 * Keyed by package name because a manifest should name the package it means. The short name
 * (`telegram`, `system`) is what the plugin registers its channel or provider under, and that is a
 * different namespace on purpose: one plugin can register several.
 */
export const BUILT_IN_PLUGINS: BuiltInPlugins = {
    "@dispach/channel-telegram": telegramPlugin,
    "@dispach/channel-whatsapp": whatsappPlugin,
    "@dispach/tools-composio": composioPlugin,
    "@dispach/tools-system": systemPlugin,
    "@dispach/tools-web": webPlugin,
}

export const BUILT_IN_PLUGIN_SPECS: readonly string[] = Object.keys(BUILT_IN_PLUGINS)
