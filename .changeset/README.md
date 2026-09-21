# Changesets

One npm package ships from this repo — **`dispach`**, whose manifest is `packages/cli/package.json`.
The other eight workspace packages are `"private": true` and are *bundled into* that tarball, so a
changeset names `dispach` and nothing else.

```bash
bun changeset          # write one, as a patch against `dispach`
bun run version:packages && bun install   # bump + changelog + lockfile, in one commit
```

Two things about this setup are deliberate and easy to undo by accident.

**`ignore: ["@dispach/*"]` rather than `fixed`.** Both would keep the siblings from versioning
independently. `fixed` versions all nine in lockstep and Changesets writes `CHANGELOG.md` **per
package** — nine changelogs, eight of them meaningless. Ignoring them writes one. The cost is that
the sibling manifests stay at `0.1.0` forever, which is honest for code that is never published on
its own.

**The tag is a person's, not `changeset publish`'s.** Releasing is tag-driven here and produces four
ad-hoc-signed binaries, a multi-arch image and the Homebrew formula as well as the tarball — and **a
tag pushed by `GITHUB_TOKEN` triggers no other workflow**, so letting `changeset publish` create it
would silently stop producing every one of those, with a green run. So:

| | Owns |
| --- | --- |
| Changesets | the version number and `CHANGELOG.md` |
| the `v*` tag | binaries, the image, the formula, and the npm publish |

**`@changesets/changelog-github` was removed rather than wired up**, which is the opposite of what
it looks like it wants. It was a declared devDependency with the config pointing at
`@changesets/cli/changelog` — an installed dependency with no consumer, the pattern this repo has
paid for repeatedly — so the obvious fix was to point the config at it and get PR links. Reading it
first is what stopped that shipping: `getReleaseLine` does

```js
const commitToFetchFrom = commitFromSummary || changeset.commit
if (commitToFetchFrom) { await getInfo({ repo, commit: commitToFetchFrom }) }
```

and `getInfo` **throws** without `GITHUB_TOKEN`. `changeset.commit` is set once the changeset file
is committed, which is exactly this workflow — write the changeset, commit, then version — so
`bun run version:packages` would have failed partway through a release on a machine with no token
exported. It read as working when first configured only because the changesets were still
uncommitted, so the lookup never ran and the output was byte-identical to the default formatter's.

PR links are worth having and not at that price: `version:packages` is run by a person, by hand, at
the one moment a hard failure is most expensive. The curated root `CHANGELOG.md` is the release
notes anyway; `packages/cli/CHANGELOG.md` is the generated record beneath it.

Which also means `changesets/action` in "publish on merge" mode is the wrong shape for this repo,
however standard it is elsewhere. It would be fine with `publish:` omitted — opening the version PR
and leaving the tag to a person — and that is the only form worth adopting later.
