/**
 * The typed client, reachable as the `/client` subpath of the one published package.
 *
 * ## Why this file exists at all
 *
 * The runtime is eight workspace packages and **one** npm name. That name is what a person installs
 * to get the CLI, and it is also what an application installs to talk to a running server — so the
 * client needs a subpath rather than a scope of its own. That keeps the registry surface to a single
 * name, which is the whole point: one thing to own, one thing to transfer, and no scoped
 * packages that exist only because a monorepo has directories.
 *
 * ## Why it is a separate build entry
 *
 * The CLI's own bundle is split so that `import("ink")` stays off the startup path. An application
 * importing this must not pull any of that in — Ink and React cost ~170-210 ms under Node, more than
 * the entire runtime of `validate --json`, and an HTTP client has no business paying it. So this is
 * compiled as its own entry with no code splitting, and `boundaries.test.ts` asserts the built file
 * imports neither.
 *
 * What it re-exports is `packages/client` unchanged. There is no wrapper, no re-declaration and no
 * second set of types: a shim that restated the surface would be a second definition of the API, and
 * this repo has paid for that shape often enough to know how it ends.
 */

export * from "@dispach/client"
