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
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/channel-telegram/package.json ./packages/channel-telegram/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json ./
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

COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/channel-telegram/package.json ./packages/channel-telegram/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
RUN bun install --frozen-lockfile --production

COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/cli/dist ./packages/cli/dist
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/channel-telegram/dist ./packages/channel-telegram/dist
COPY --from=builder /build/packages/tools-system/dist ./packages/tools-system/dist
COPY --from=builder /build/packages/tools-composio/dist ./packages/tools-composio/dist
COPY --from=builder /build/packages/tools-web/dist ./packages/tools-web/dist

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
ENTRYPOINT ["bun", "/app/packages/cli/dist/index.js"]
CMD ["serve", "/agent/agent.yaml", "--host", "0.0.0.0"]
