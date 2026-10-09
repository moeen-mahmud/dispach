/**
 * What the model is told about tools that exist and were not enabled for it.
 *
 * ## Why it is here and not in either dialect
 *
 * Because both have to say the same thing. NLT appends it to the catalogue block it already renders;
 * `native` has no catalogue block at all — its tools go in the request's `tools` parameter, which has
 * no field for "and here is what you were *not* given" — so it renders this as its only slot-1 block.
 * Two copies of the wording would let an eval comparing the dialects measure the wording and report it
 * as a property of the dialect. One copy, two placements.
 *
 * ## Why the wording is this specific
 *
 * Each instruction answers a failure that is otherwise invisible:
 *
 * - **Name the tool.** "I don't have permission for that" without saying which leaves the person to
 *   guess, and the guess is usually wrong because the tool's name is not the word they used.
 * - **Say it is not permitted, not that you cannot.** These are different claims and only one is true.
 *   A model that says "I can't read files" when it has not been given `file_read` has told the person
 *   something false about the runtime, and they will believe it.
 * - **Do not work around it.** An agent with `exec` and without `file_write` will cheerfully
 *   `echo … > file` its way past a decision somebody made deliberately. That is the shape that turns a
 *   narrow grant into a broad one, and it has to be said rather than assumed.
 */

import type { ContextBlock } from "../../context/blocks.ts"
import { SLOT } from "../../context/blocks.ts"
import { estimateMessageTokens } from "../../context/tokens.ts"
import type { ToolAvailability } from "../types.ts"

/** Heading and body, or empty when every offered tool was pinned. */
export function renderNotEnabledText(notEnabled: readonly ToolAvailability[] | undefined): string {
    if (notEnabled === undefined || notEnabled.length === 0) return ""
    const offered = notEnabled.filter((entry) => entry.unavailable !== true)
    const broken = notEnabled.filter((entry) => entry.unavailable === true)
    // Pinned and not loadable (pilot.16): asking for it to be pinned is advice already followed.
    const unavailable =
        broken.length === 0
            ? []
            : [
                  "## Unavailable right now",
                  "",
                  `Configured for you but could not be loaded: ${broken.map((entry) => entry.slug).join(", ")}. If a request needs one, say it is unavailable at the moment and that whoever runs this agent has been told; do not use another tool to work around it.`,
              ]
    if (offered.length === 0) return unavailable.join("\n")
    const lines = offered.map((entry) => `- ${entry.slug} — ${entry.summary}`).join("\n")
    return [
        ...(unavailable.length === 0 ? [] : [...unavailable, ""]),
        "## Not enabled for you",
        "",
        "These exist on this machine but this agent has not been given them:",
        "",
        lines,
        "",
        "If something you are asked to do needs one, say so plainly: name the tool, say what you would have done with it, and say that it has to be added to `tools.pinned` in this agent's configuration and permitted under `tools.policy`. Say you are not permitted to yet — never that you are unable to. And do not use a different tool to work around it.",
    ].join("\n")
}

/**
 * The same text as its own pinned block, for a dialect with no catalogue block to append it to.
 *
 * Pinned for the same reason the catalogue is: compaction reliably eats initial instructions, and this
 * one only matters at the moment a request turns out to need a tool the agent does not have — which
 * can be at any depth in a long conversation.
 */
export function renderNotEnabledBlock(
    notEnabled: readonly ToolAvailability[] | undefined,
): readonly ContextBlock[] {
    const content = renderNotEnabledText(notEnabled)
    if (content === "") return []
    return [
        {
            slot: SLOT.tools,
            role: "system",
            content,
            pinned: true,
            tokens: estimateMessageTokens(content),
            label: "tools",
        },
    ]
}
