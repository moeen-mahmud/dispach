# Releasing

One package, one number, one tag. Semver. Short bullets in `CHANGELOG.md`; the reasoning lives in
`docs/00-DECISIONS.md`.

1. **Draft the notes**: `bun run changelog:draft` writes the `feat`, `fix` and `perf` commits since
   the last release under `## Unreleased` in `CHANGELOG.md` (git-cliff, `cliff.toml`). Edit them into
   short bullets for someone installing the release: what changed, one line each, **Breaking**
   marked. No reasons — those go in `docs/00-DECISIONS.md`.
2. **Cut it** from a clean `main`:

   ```bash
   bun run release 0.2.0
   ```

   Writes the version into `packages/cli/package.json`, `packages/core/src/version.ts`, the
   lockfile and the generated API reference, dates the changelog section, runs the gate (`build`,
   `test`, `typecheck`, `lint`, `docs:check`, `verify:package`), and prints the two git commands. It commits nothing.
3. **Review the diff, commit, tag, push the tag.** The tag is what publishes.
4. **Watch the workflow.** `release.yml` publishes to npm, creates the GitHub Release with the
   changelog section as its body, commits the formula to `moeen-mahmud/homebrew-tap`, builds the
   four standalone archives from the published tarball, installs them on Linux and macOS, attaches
   them with `SHA256SUMS` and `install.sh` to the release, and pushes the image to GHCR. It needs two secrets: `NPM_TOKEN` and `TAP_TOKEN` (a fine-grained PAT with
   contents:write on the tap). Either missing **fails the job by name** rather than skipping.
5. **Check the four installs**:

   ```bash
   npm view dispach version
   brew update && brew info moeen-mahmud/tap/dispach
   docker pull ghcr.io/moeen-mahmud/dispach:0.2.0
   curl -fsSL https://github.com/moeen-mahmud/dispach/releases/latest/download/install.sh | sh
   ```

   `bun scripts/build-standalone.ts --targets darwin-arm64` builds one archive locally (packing the
   tree) and runs it; a manual run of `release.yml` builds all four and tests both installs without
   publishing anything.

A release that failed part-way: fix, cut the *next* patch number. npm versions are immutable, and
the workflow refuses a tag whose version the registry already serves.
