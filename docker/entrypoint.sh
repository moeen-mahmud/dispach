#!/bin/sh
#
# Makes the mounted agent visible to the sandbox, then gets out of the way.
#
# ## Why this exists at all
#
# There are two ways an agent reaches this container and there must be **one place it lives**.
# Mounted at `/agent` is the hosted shape — a provisioner writes `agent.yaml` and mounts the
# directory. Created with `dispach init` is the local shape. Before this, those were two disjoint
# agents directories: `DISPACH_HOME=/state` put `init`'s output in `/state/agents` while the CMD
# served `/agent/agent.yaml`, so an agent created inside the container was invisible to
# `dispach agents`, to `run` with no ref and to the picker, and nothing would ever serve it.
#
# A symlink at `<sandbox>/agents/primary` fixes that with no code change, because `listAgents` stats
# the directory and `stat` follows symlinks.
#
# ## Why at start rather than at build
#
# **A volume mounted at `$HOME` replaces whatever the image put there.** A *named* volume is seeded
# from the image on first use, so a build-time link would survive that one case — and would be absent
# for a bind mount, and absent for a named volume created by an older image. Three shapes, one of
# which works, and the two that do not fail as `no agent called primary` at start.
#
# Making it here is idempotent and true of every shape. `exec` at the end so signals reach the
# runtime rather than stopping at a shell with nothing to forward them to, and so `ps` inside the
# container reads `dispach serve …` rather than naming this script.
set -e

# `.dispach` is derived from the brand slug exactly as the package scope is, so this file is in
# `scripts/rename-brand.ts`'s `inScope` list. A rename that left it behind would be a rename that
# silently stopped linking the mounted agent.
AGENTS="$HOME/.dispach/agents"
mkdir -p "$AGENTS"

# Only when there is something to point at. A dangling symlink is skipped by `listAgents` — it stats
# the target and treats a failure as "not an agent directory" — so a broken one would be harmless
# and also completely silent, which is the wrong kind of harmless.
if [ -f /agent/agent.yaml ] && [ ! -e "$AGENTS/primary" ]; then
    ln -s /agent "$AGENTS/primary"
fi

exec dispach "$@"
