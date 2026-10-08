# Releasing

Maintainers cut releases. Contributors should add user-visible changes to the `Unreleased` section of `CHANGELOG.md` when requested during review.

The release preparation script validates a clean tree, a newer version, and non-empty notes, updates the versioned files, runs the release gate, and prints the commit and tag commands:

```bash
bun run release 0.2.0
```

It does not commit, tag, push, or publish. A pushed `v*` tag triggers the release workflow, which publishes the npm package, GitHub release, container image, and stable Homebrew formula. Prereleases use the npm `next` tag and do not replace the stable formula.

Use a hyphenated version for a pilot:

```bash
bun run release 0.2.0-pilot.15
```

A pilot tag creates a GitHub pre-release, publishes npm under `next`, and pushes only the exact
container tag. It does not move npm `latest`, the container `latest` tag, or the Homebrew formula.
The control plane itself remains source-distributed from `packages/control`; the published npm
package is the runtime and CLI.

Before preparing a release:

1. Complete the checks in [Testing and evaluations](testing-and-evaluations.md).
2. Run the manual pass in [`docs/13-QA.md`](../../docs/13-QA.md).
3. Confirm the changelog describes user-visible behavior and migration needs.
4. Verify generated documentation and the package tarball.

The complete operational procedure and recovery notes are in [`RELEASING.md`](../../RELEASING.md).
