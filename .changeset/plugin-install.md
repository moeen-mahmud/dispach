---
"dispach": patch
---

**`dispach plugins add | list | remove`** — a plugin can be installed, which until now it could not.

`PluginContext.defineChannel` started working in 0.1.1 and there was nothing to load with it: a
plugin spec resolved in two places, this binary's built-in registry and an ordinary module import,
so a third-party plugin had to already be in a `node_modules` — which the compiled binary and the
container do not have. Documented public API, conformance-tested, and unreachable in the two
environments this ships as.

```bash
dispach plugins add <agent> moeen-mahmud/some-plugin --ref v1.0.0
dispach plugins list <agent>
dispach plugins remove <agent> some-plugin
```

**A plugin is one self-contained bundle.** Nothing is installed while this runtime runs, so
`plugins add` refuses a tree that declares runtime dependencies and ships no `node_modules` —
by name, before anything is written — rather than letting it half-load at the next boot. That rule
is what makes the same `plugins:` entry resolve identically in a checkout, in the compiled binary
and in the container.

**Three lookups now, and `plugins list` says which answered.** Registry → `~/.dispach/plugins/` →
module import, with the resolved commit printed for an installed one. The registry stays first so a
vendored directory cannot shadow a package already inside the binary; the import stays last because
it is the only lookup that can reach a `node_modules` you installed yourself.

**`add` verifies before it writes.** A manifest naming a plugin that will not load *does not load*,
so writing the entry first would brick the agent and report success. It fetches to a partial
directory, runs `conformance()` from `@dispach/core/testing` — the same suite the plugin's own
author runs — and only then renames it into place and writes the entry. It then discloses the
version, the commit, the host range, everything the plugin registered and every permission it
declares, with the reminder that `permissions` is advisory in v1 and enforced by nothing.

What git costs is stated rather than discovered: no version resolution and no integrity check.
`--ref` pins a tag or a commit and the commit is recorded beside the code; the `dispachApi` gate
checks **compatibility, not authenticity**. A local repository is accepted too, which is how an
author tests a bundle before publishing it.

**Breaking, in one command:** `plugins` takes an action first. `dispach plugins <agent>` is now
`dispach plugins list <agent>`, matching `config` and `memory` — a bare positional cannot stay the
agent once `add` and `remove` exist, because an agent may legitimately be named `add`.

### Also fixed, found by running a third-party channel for the first time

A channel factory that returned a transport with no `type` put the literal text `echo (undefined)`
on the `serve` banner and left `type` — a documented field of `GET /v1/agents/:id` — absent from the
wire. A transport whose `id` or `type` disagrees with the manifest entry that asked for it is now
refused at load. TypeScript makes this unreachable for a first-party channel and says nothing about
a plugin; `id` is the sharper of the two, since it is the channel segment of every session key.

`docs/03-SPEC-PLUGIN-API.md`'s Channel section described an interface that does not exist — a
`ChannelSpec`/`Channel` pair with `capabilities.maxMessageLength`, for as long as the page has
existed. Rewritten against the real `ChannelTransport`.
