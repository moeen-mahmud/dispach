/**
 * `@dispach/core/testing` — the plugin conformance suite.
 *
 * A separate entry point so a plugin's *runtime* dependency stays `@dispach/core` alone: nothing
 * here belongs in a published agent, and folding it into the root export would ship a test harness
 * to every embedder.
 */

export {
    type ConformanceOptions,
    type ConformanceResult,
    conformance,
    type Finding,
    formatFindings,
} from "./conformance.ts"
