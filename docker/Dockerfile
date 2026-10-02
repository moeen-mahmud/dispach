# Dispach in a container — a small Linux machine the agent works on.
#
# **This is not a process wrapper, and the difference is the whole design.** The agent has a shell,
# and `tools.policy` decides *whether* a command runs while containment decides *where* — so the
# container is where the work happens, not merely where a server listens. It therefore has a home
# directory that persists, a package set its own documented features require, and one place an agent
# can live.
#
# ## Two stages: Bun builds, Node runs
#
# The builder has the workspace, the lockfile and every dev dependency, and produces **the npm
# tarball** — the same `dispach-<version>.tgz` that `npm publish` ships. The runtime installs that
# tarball with `npm i -g` and nothing else, so the container runs byte-for-byte what
# `npm i -g dispach` runs on a laptop: one installed package, `ink` and `react` resolved by npm,
# everything else bundled into `dist/`.
#
# **Node, not a Bun-compiled binary, and it was measured.** Until 0.1.3 the runtime stage held one
# `bun build --compile` file. Bun cannot complete the WhatsApp Noise handshake — the socket opens and
# no QR or code ever arrives, reproduced at three levels against the same bundle that pairs under
# Node in two seconds — so the image carried a channel it could not finish pairing. Node is what the
# npm install already ran under; the image now runs under it too, and there is one runtime to reason
# about instead of two.
#
# No `bun install` in the runtime stage, still: `ink` declares `react-devtools-core` a
# **peerDependency**, so a `--production` install of the workspace pulled ~17 MB of developer tooling
# into every image. Installing the *tarball* cannot — its dependency list is the two packages the
# published `package.json` names.
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
# **Size stopped being the argument.** Alpine is ~5 MB against debian-slim's ~75 MB, and the
# apt layer this image needs is ~180 MB either way. Builder and runtime are both Debian 13 (trixie),
# glibc 2.41, so there is no libc gap between the machine that builds and the machine that runs.
#
# **Distroless is disqualified**, which is worth writing down because it is otherwise the obvious
# modern answer: `exec` runs `sh -c`, so an image with no shell deletes the tool layer.

# ─── builder ──────────────────────────────────────────────────────────────────────────────
#
# Bun is the dev toolchain — install, bundle, pack — and appears in this stage only. The tarball it
# writes is architecture-independent, so buildx runs this stage once per platform and produces the
# same bytes on both.
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
COPY packages/channel-whatsapp/package.json ./packages/channel-whatsapp/
COPY packages/tools-system/package.json ./packages/tools-system/
COPY packages/tools-composio/package.json ./packages/tools-composio/
COPY packages/tools-web/package.json ./packages/tools-web/
# The control plane is a workspace too, so the lockfile names it. Only its manifest matters here:
# the runtime stage installs the CLI tarball and nothing else, so no FSL code reaches the image.
COPY packages/control/package.json ./packages/control/
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
# The npm page's readme, which `prepack` copies beside the package. Copied by hand here because
# `bun pm pack` runs with `--ignore-scripts` below — the same reason the install did.
COPY README.md ./packages/cli/README.md

# Every package the CLI imports, not just core and cli — the bundle resolves each sibling through its
# `dist/`, so a partial build produces a package missing a provider.
RUN bun run build

# The tarball `npm publish` would ship, from the one package this repository publishes. `bun pm pack`
# honours `files` exactly as `npm pack` does, and there is no npm in this stage — the `node` on
# `oven/bun`'s PATH is a shim that runs bun.
RUN mkdir /out && cd packages/cli && bun pm pack --destination /out --ignore-scripts

# ─── runtime ──────────────────────────────────────────────────────────────────────────────
#
# The official Node image on the same Debian release as before, so the apt layer below is unchanged
# and glibc is the one the builder has. `-slim` carries `node`, `npm` and `corepack` and nothing else.
FROM node:24-trixie-slim AS runtime

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

# The application: the published package, installed the way a laptop installs it. `npm i -g` puts
# `dispach` on `/usr/local/bin` and the package under `/usr/local/lib/node_modules`. `--omit=dev`
# is belt and braces — a tarball's `package.json` carries no devDependencies — and `--ignore-scripts`
# because nothing this package or its two dependencies need runs at install. The cache is deleted
# because it is a build artefact that would otherwise ship in the layer.
COPY --from=builder /out/*.tgz /tmp/dispach.tgz
RUN npm install -g --omit=dev --ignore-scripts /tmp/dispach.tgz \
    && rm /tmp/dispach.tgz \
    && npm cache clean --force \
    && dispach --version
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

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
# The node image ships a `node` user at uid 1000. Removed rather than renamed, so the account, its
# group and its home carry this project's name and the compose file's `chown 1000:1000` advice
# stays true.
RUN userdel -r node \
    && useradd --create-home --uid 1000 --shell /bin/bash dispach
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
