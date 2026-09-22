# Dispach in a container — a small Linux machine the agent works on.
#
# **This is not a process wrapper, and the difference is the whole design.** The agent has a shell,
# and `tools.policy` decides *whether* a command runs while containment decides *where* — so the
# container is where the work happens, not merely where a server listens. It therefore has a home
# directory that persists, a package set its own documented features require, and one place an agent
# can live.
#
# ## Two stages, and the runtime has no toolchain at all
#
# The builder has the workspace, the lockfile and every dev dependency. The runtime has **one file**:
# the compiled binary. No Bun, no Node, no `node_modules`, no lockfile, no nine `package.json`
# copies, no seven `dist/` directories. `bun build --compile` embeds the runtime beside the bundled
# program, so there is nothing left to resolve at boot — which is also why it starts *faster* than
# the npm shape (measured: 70-90 ms against 90-110 ms on `validate --json`).
#
# Deleting the runtime `bun install` has a side effect worth naming: `ink` declares
# `react-devtools-core` a **peerDependency**, so `--production` did not skip it and ~17 MB of
# developer tooling reached every shipped image. It cannot arrive now.
#
# ## Why debian and not alpine
#
# glibc, for three independent reasons, in order of what each costs.
#
# **musl deletes prebuilt Python wheels.** PyPI's C-extension wheels are `manylinux`, which is glibc;
# alpine needs `musllinux`, which far fewer projects publish, so anything without one compiles from
# source — measured elsewhere at 12.8 s from wheels against 4 m 23 s from source on scikit-learn plus
# opencv. We ship no compiler, so the real outcome is not slow, it is a **build failure inside a tool
# call**. `uv run` materialising `.venv/` in a skill directory is the documented Python path, so this
# is the same "shipped feature unusable in the only supported deployment" failure this file already
# refuses for `git`.
#
# **bun's musl `--compile` target has open correctness bugs** — oven-sh/bun #15829, where
# `bun-linux-musl-x64-modern` emits a *glibc* binary; #29681, where the prebuilt musl binary still
# wants glibc; #14292, where `--compile` is broken for musl arm64. Shipping a compiled binary onto
# alpine bets the image on bun's least-travelled target.
#
# **Size stopped being the argument.** Alpine is ~5 MB against debian-slim's ~75 MB, and the compiled
# linux binary alone is ~100 MB. Builder and runtime are both Debian 13 (trixie), glibc 2.41, so
# there is no libc gap between the machine that compiles and the machine that runs.
#
# **Distroless is disqualified twice**, which is worth writing down because it is otherwise the
# obvious modern answer: `exec` runs `sh -c`, so an image with no shell deletes the tool layer; and a
# musl-linked binary in `base-debian13` fails at load.

# ─── builder ──────────────────────────────────────────────────────────────────────────────
#
# `oven/bun:1` rather than `oven/bun:1-alpine`: the host target is then glibc and no
# cross-compilation happens at all, which is the one bun path without open bugs. Buildx runs this
# stage on the target platform, so the architecture is already right.
FROM oven/bun:1 AS builder
WORKDIR /build

# The lockfile and every workspace manifest first, so a source-only change reuses this layer.
COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/client/package.json ./packages/client/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/channel-telegram/package.json ./packages/channel-telegram/
# Copied so `bun install --frozen-lockfile` sees every workspace member — and for no other reason.
# Nothing imports this package, so none of it reaches the compiled binary, and the runtime stage
# copies only that binary. Baileys is installed in the builder and thrown away with it.
COPY packages/channel-whatsapp/package.json ./packages/channel-whatsapp/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
# `--ignore-scripts` because the root `prepare` runs husky, which installs git hooks: a devDependency
# acting on a `.git` that is not in the build context anyway. A lifecycle script has no business
# running in an image build.
RUN bun install --frozen-lockfile --ignore-scripts

# `tsconfig.base.json`, which every package's tsconfig extends — there is no root `tsconfig.json`,
# and naming one is how this failed first time. `biome.json` is deliberately not copied: it
# configures lint and format, neither of which an image build runs.
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages

# Every package the binary imports, not just core and cli — the compile bundles what the CLI
# resolves through each sibling's `dist/`, so a partial build produces a binary missing a provider.
RUN bun run build

# One compile path shared with a developer's machine: the same script, so the image cannot drift
# from what `bun run build:binary` produces locally. It also *runs* what it built — the host target
# is executable here — so a binary that cannot start fails the image build rather than the
# healthcheck. The glob resolves in the shell because the architecture is in the filename.
RUN bun run build:binary && mv dist-bin/dispach-linux-* /out-dispach

# ─── runtime ──────────────────────────────────────────────────────────────────────────────
FROM debian:trixie-slim AS runtime

# ─── What the agent's shell can reach ─────────────────────────────────────────────────────
#
# `exec` gives the agent a shell, and a shell is only as useful as what is on the PATH. Every
# package here has a reason and a failure it prevents:
#
# - **`git`** is how `skills install`, `sources search` and `sources update` fetch catalogues. Its
#   absence does not degrade the feature, it deletes it: 440+ skills across two catalogues become
#   unreachable, and the symptom is `git: not found` rather than anything self-explanatory.
# - **`bash`** is the shebang on a good fraction of third-party skill scripts. `exec` itself runs
#   `sh -c` and does not need it; a `#!/bin/bash` script does.
# - **`python3`/`python3-venv`** are what a skill shipping scripts declares, and what `uv run` needs
#   as a base interpreter.
# - **`curl`** is what a model reaches for first. `wget` is a substitute it will not think of, and is
#   deliberately absent so there is one obvious HTTP client rather than two.
# - **`ca-certificates`** so an HTTPS call from the shell verifies rather than failing oddly.
# - **`jq`** because a model pipes JSON constantly and it costs about a megabyte.
# - **`tzdata`** for **schedules**. `zone.ts` walks local calendar fields through `Intl`; with no zone
#   database a named zone cannot resolve, and a cron silently running in UTC is exactly the failure
#   the DST handling exists to prevent.
#
# Deliberately **not** installed: no pager, no editor, no `less`. `exec` hands a child a file
# descriptor and never a TTY — the reason it can background a process at all — so anything that
# pages or prompts blocks until `deadlineMs` and reads as a hung agent rather than a stuck tool.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        python3 \
        python3-venv \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

# `uv` from its own image rather than a curl-pipe-sh, so the version is pinned and auditable and the
# build makes no network call of its own. It is a statically linked musl binary, which runs fine on
# glibc — that is what static linking is for.
COPY --from=ghcr.io/astral-sh/uv:0.12.15 /uv /uvx /usr/local/bin/

# The binary. This is the entire application.
COPY --from=builder /out-dispach /usr/local/bin/dispach
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/dispach /usr/local/bin/entrypoint.sh

# ─── The agent's home ─────────────────────────────────────────────────────────────────────
#
# **`DISPACH_HOME` is deliberately not set.** `lib/sandbox.ts` resolves `~/.dispach` with
# `DISPACH_HOME` as an *override*, so letting `HOME` decide gives this container byte-identical
# paths to a laptop — `~/.dispach/store.db`, `~/.dispach/agents/`, `~/.dispach/logs/` — and removes a
# variable that can disagree with the home directory sitting next to it. The override stays available
# to anyone who wants it; the image just stops needing one. The previous arrangement
# (`DISPACH_HOME=/state`) is what made `dispach init` inside the container write to a directory the
# CMD would never serve.
#
# **`USER` does not set `$HOME` in Docker** — it is inherited from the build environment. Without the
# explicit `ENV` the sandbox resolves against `/root`: writable while building, refused under
# `USER dispach`, and the failure lands on the first turn rather than at start.
RUN useradd --create-home --uid 1000 --shell /bin/bash dispach
ENV HOME=/home/dispach

# `LANG` because a missing UTF-8 default corrupts any tool that emits one, in a container where
# nobody is watching. `PAGER`/`GIT_PAGER` are belt and braces for the no-TTY rule above: `git log`
# already disables its pager when stdout is not a terminal, and one tool that does not is a tool
# call that hangs until its deadline.
ENV LANG=C.UTF-8 \
    PAGER=cat \
    GIT_PAGER=cat

# The four `git` credential controls, together. Any one left open is a hang rather than a failure:
# `git ls-remote` on a private-or-absent repository waits for a credential prompt, and it once did so
# for two minutes on a terminal nobody was watching. Never `GIT_CONFIG_NOSYSTEM` — that drops the
# credential helper, which is how a private source is meant to work.
ENV GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/true \
    SSH_ASKPASS=/bin/true \
    GIT_SSH_COMMAND="ssh -o BatchMode=yes"

# `/agent` is where a manifest is mounted, and `~/.dispach/agents/primary` is how the sandbox sees
# it — see `entrypoint.sh` for why that link is made at *start* rather than here.
RUN mkdir -p /agent /home/dispach/.dispach/agents \
    && chown -R dispach:dispach /agent /home/dispach

USER dispach
WORKDIR /home/dispach
VOLUME ["/home/dispach"]
EXPOSE 7420

# `/v1/ready` flips at `runtime.ready`, which is *before* channels connect — deliberately, because a
# Telegram outage must not read as an unhealthy container and get it restarted into the same outage.
# So this answers "can it serve a turn", which is the question an orchestrator is actually asking.
#
# `curl` rather than the old `bun -e`: there is no Bun in this stage any more, which is the point.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7420/v1/ready > /dev/null || exit 1

# `serve` rather than `run`: it is the only command that starts channels and binds the port, and a
# container with no terminal has nobody to talk to a REPL.
#
# **`--host 0.0.0.0` is not optional and is the whole reason this line is not just `serve`.** The
# default bind is loopback, which is right for a laptop and invisible in a container:
# `docker run -p 7420:7420` publishes the container's interface, and a process on 127.0.0.1 inside it
# is unreachable from the host — a container that builds, starts, reports healthy and answers
# nothing. A non-loopback bind requires an API token by design, so a published container needs
# `DISPACH_API_TOKEN` and refuses to start without it rather than binding the world unauthenticated.
#
# **No agent is named, and that is the point.** This used to be `serve primary`, which made the
# image refuse to start unless something was mounted at `/agent` — so the compose file defaulted to
# mounting the repository's own example, and `docker compose up` on a fresh clone came up hosting a
# sample agent nobody asked for. A bare `serve` hosts every *enabled agent in the sandbox*, which is
# none on a fresh volume and is the supported state: the API and the web UI exist before there is
# anything to talk to, which is what makes provisioning through them possible at all.
#
# A mounted agent still works and needs no flag: `entrypoint.sh` links `/agent` into the sandbox as
# `primary`, so the same bare `serve` finds it through `listAgents` exactly as it finds one created
# with `dispach init`. One CMD, both shapes — and the mount is what decides, rather than an argument
# here that has to agree with it.
ENTRYPOINT ["entrypoint.sh"]
CMD ["serve", "--host", "0.0.0.0"]
