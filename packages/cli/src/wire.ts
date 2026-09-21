/**
 * The event schema and nothing else, reachable as the `/wire` subpath of the published package.
 *
 * The browser-safe subset (decision 11.199): event types, `EVENT_TYPES`, and the SSE parser, with no
 * Zod, no YAML parser and no store. It exists so a front end can type an event stream without
 * importing a runtime it will never run — and it is a subpath of the one published package for the
 * same reason `./client` is.
 */

export * from "@dispach/core/wire"
