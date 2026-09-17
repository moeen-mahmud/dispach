# Dispach in a container.
#
# Two stages. The builder has the workspace, the lockfile and every dev dependency; the runtime has
# `dist/`, production dependencies and nothing else — no source, no tests, no toolchain. That split
# is most of why the image is small, and all of why a `bun build` bug cannot ship a compiler into
# production.
#
# ## Why `oven/bun` and not `node`
#
# Bun is the primary runtime (decision 2.1) and `bun:sqlite` is the store driver it uses. Node works
# — the suite runs under it in CI — but the adapter exists so an *embedder* can use Node, not so this
# image can. One runtime in the image means one SQLite implementation to reason about.
#
# ## Non-root, and what that costs
#
# The `bun` user already exists in the base image with uid 1000. The state directory is created and
# chowned at build time because a volume mounted over it inherits the *host* ownership, and a
# container that cannot write its own store fails at the first turn with a permission error rather
# than at start — which is the worse moment to find out. `docker run -v` with a host path still needs
# that path writable by uid 1000; the README says so rather than leaving it to be discovered.

# ─── builder ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder
WORKDIR /build

# The lockfile and every workspace manifest first, so a source-only change reuses this layer.
# Copying the whole tree here instead would make `bun install` run on every edit.
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/client/package.json ./packages/client/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/channel-telegram/package.json ./packages/channel-telegram/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
# `--ignore-scripts` because the root `prepare` runs husky, which installs git hooks: it is a
# devDependency the production stage does not have (`husky: not found`, exit 127) and there is no
# `.git` in the build context for it to act on anyway. A lifecycle script has no business running
# in an image build.
RUN bun install --frozen-lockfile --ignore-scripts

# `tsconfig.base.json`, which every package's tsconfig extends — there is no root `tsconfig.json`,
# and naming one is how this failed first time. `biome.json` is deliberately not copied: it
# configures lint and format, neither of which an image build runs.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages

# Every package the binary imports, not just core and cli. The CLI resolves its siblings through
# their `dist/`, so a partial build produces an image that starts and then fails on the first tool
# call with a stack trace pointing into a directory that does not exist.
RUN bun run build

# ─── runtime ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Where the store, logs and sandbox agents live. A volume mounts here.
ENV DISPACH_HOME=/state

# ─── What the agent's shell can reach ─────────────────────────────────────────────────────
#
# `exec` gives the agent a shell, and a shell is only as useful as what is on the PATH. The base
# image ships busybox `sh`, `wget` and node — and **nothing else**, which is a bigger hole than it
# reads as:
#
# - **`git`** is how `skills install`, `sources search` and `sources update` fetch catalogues. Its
#   absence does not degrade the feature, it deletes it: 440+ skills across two catalogues are
#   unreachable, and the symptom is `git: not found` rather than anything that explains itself.
# - **`python3`** is what a skill shipping scripts declares. The documented `uv run` path — which
#   materialises `.venv/` inside the skill directory on first call — cannot start without it.
# - **`bash`** is the shebang on a good fraction of third-party skill scripts. `exec` itself runs
#   `sh -c` and does not need it; a `#!/bin/bash` script does.
# - **`curl`** is what a model reaches for first. `wget` is a substitute it will not think of.
# - **`ca-certificates`** so an HTTPS call from the shell verifies rather than failing oddly.
#
# Measured: 21 MB, taking the image from 47 MB to 68 MB against the 150 MB CI ceiling. The
# alternative considered and rejected was a second `dispach:dev` image — which makes the
# production one the variant nobody tests, and leaves a shipped feature unusable in the only
# supported deployment.
RUN apk add --no-cache git python3 bash curl ca-certificates

COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/client/package.json ./packages/client/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/channel-telegram/package.json ./packages/channel-telegram/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/cli/dist ./packages/cli/dist
COPY --from=builder /build/packages/server/dist ./packages/server/dist
# No `packages/web/dist` here, deliberately. The browser assets are **inlined as text** into the
# server's bundle at build time (decision 11.200), so they ride inside `cli/dist/index.js` and there
# is nothing to copy. Adding a line for them would be harmless and misleading — it would suggest the
# runtime reads them from disk, which is exactly the arrangement that was measured and rejected:
# a bundled build hands back a *relative* asset path that resolves against the process cwd, and this
# container runs with cwd `/agent`.
COPY --from=builder /build/packages/channel-telegram/dist ./packages/channel-telegram/dist
COPY --from=builder /build/packages/tools-system/dist ./packages/tools-system/dist
COPY --from=builder /build/packages/tools-composio/dist ./packages/tools-composio/dist
COPY --from=builder /build/packages/tools-web/dist ./packages/tools-web/dist

# A `dispach` on the PATH, so the command is the command everywhere.
#
# The entrypoint already runs the CLI, but `docker exec` bypasses an entrypoint — so inspecting a
# running agent meant `bun /app/packages/cli/dist/index.js validate /agent/agent.yaml`, which is
# both a mouthful and a path a person has to know. With this, `docker compose exec agent dispach
# sessions /agent/agent.yaml` is the same command as on a laptop.
#
# `exec` in the shim rather than a plain call, so signals reach bun instead of stopping at a shell
# that would then have nothing to forward them to. Written before `USER bun`, because
# `/usr/local/bin` is root's.
RUN printf '#!/bin/sh\nexec bun /app/packages/cli/dist/index.js "$@"\n' > /usr/local/bin/dispach \
    && chmod 0755 /usr/local/bin/dispach

RUN mkdir -p /state /agent && chown -R bun:bun /state /agent
USER bun

# Where a manifest is mounted. `docker run -v ./my-agent:/agent` and nothing else to configure.
WORKDIR /agent
VOLUME ["/state"]
EXPOSE 7420

# `/v1/ready` flips at `runtime.ready`, which is *before* channels connect — deliberately, because a
# Telegram outage must not read as an unhealthy container and get it restarted into the same outage.
# So this answers "can it serve a turn", which is the question an orchestrator is actually asking.
#
# `start-period` is generous against the measured boot: readiness is tens of milliseconds in-process,
# and the slack is for a cold page cache and a slow volume rather than for the runtime.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:7420/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `serve` rather than `run`: it is the only command that starts channels and binds the port, and a
# container with no terminal has nobody to talk to a REPL.
#
# **`--host 0.0.0.0` is not optional here and is the whole reason this line is not just `serve`.**
# The default bind is loopback, which is the right default for a laptop and is invisible in a
# container: `docker run -p 7420:7420` publishes the container's interface, and a process listening
# on 127.0.0.1 inside it is unreachable from the host — a container that looks healthy, answers
# nothing, and gives no clue why.
#
# A non-loopback bind requires an API token, deliberately (decision 11.29's neighbour). So a
# published container needs `<ENVPREFIX>API_TOKEN` set, and refuses to start without it rather than
# binding the world unauthenticated. The refusal names the variable.
# The shim, not the long form — so `docker inspect` and a `ps` line both read `dispach serve …`,
# and there is one spelling of how this image is entered rather than two.
ENTRYPOINT ["dispach"]
CMD ["serve", "/agent/agent.yaml", "--host", "0.0.0.0"]
