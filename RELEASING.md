# Releasing

One package, one number, one tag. Semver. Short bullets in `CHANGELOG.md`; the reasoning lives in
`docs/00-DECISIONS.md`.

1. **Draft the notes**: `bun run changelog:draft` writes the `feat`, `fix` and `perf` commits since
   the last release under `## Unreleased` in `CHANGELOG.md` (git-cliff, `cliff.toml`). Edit them into
   short bullets for someone installing the release: what changed, one line each, **Breaking**
   marked. No reasons — those go in `docs/00-DECISIONS.md`.
2. **Cut it** from a clean `main`:

   ```bash
   bun run release 0.1.3
   ```

   Writes the version into `packages/cli/package.json`, `packages/core/src/version.ts` and the
   lockfile, dates the changelog section, runs the gate (`build`, `test`, `typecheck`, `lint`,
   `verify:package`), and prints the two git commands. It commits nothing.
3. **Review the diff, commit, tag, push the tag.** The tag is what publishes.
4. **Watch the workflow.** `release.yml` publishes to npm, creates the GitHub Release with the
   changelog section as its body, commits the formula to `moeen-mahmud/homebrew-tap`, and pushes
   the image to GHCR. It needs two secrets: `NPM_TOKEN` and `TAP_TOKEN` (a fine-grained PAT with
   contents:write on the tap). Either missing **fails the job by name** rather than skipping.
5. **Check the three installs**:

   ```bash
   npm view dispach version
   brew update && brew info moeen-mahmud/tap/dispach
   docker pull ghcr.io/moeen-mahmud/dispach:0.1.3
   ```

A release that failed part-way: fix, cut the *next* patch number. npm versions are immutable, and
the workflow refuses a tag whose version the registry already serves.
