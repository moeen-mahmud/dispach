---
"@dispach/core": minor
"@dispach/cli": minor
"@dispach/server": minor
"@dispach/channel-telegram": minor
"@dispach/tools-system": minor
"@dispach/tools-composio": minor
"@dispach/tools-web": minor
---

Plugins, middleware, and a container.

**Plugins (Phase 9A).** `plugins:` in a manifest now loads. A bare specifier resolves from the
host's built-in registry and only an unknown one is imported; a relative path resolves against the
manifest's directory. Nothing is ever installed at runtime. Every first-party package — Telegram,
Composio, system, web — ships as a plugin beside its existing factory, so both ways of wiring an
agent go through one code path. `@dispach/core/testing` exports `conformance(plugin)`, and
`dispach plugins` shows what each one registered and what it declared.

**Middleware (Phase 9B).** Four wrap points — turn, context, model call, tool call — plus
`onEvent`, composed in manifest order, outermost first. `retryMiddleware` and `approvalMiddleware`
ship as real exports rather than documentation. `ModelError` now carries `status` and
`retryAfterSeconds` as fields, which is what makes a retry policy expressible at all.

**A container (Phase 11).** `docker/Dockerfile`, two stages, non-root, with a healthcheck. 83 MB,
147 ms from `docker run` to `/v1/ready`, and a real turn round-trips through it. CI rebuilds and
re-measures on every push.

**Two fixes worth naming.** `/v1/ready` was behind the bearer token, which made the readiness probe
unusable by the orchestrators it exists for — it is open now, and discloses strictly less than
`/v1/health` already did. And `tools.untrusted.onMutate: "confirm"` had been settable since the field
existed and satisfiable never: there is an approver seam now, and a warning when nothing fills it.
