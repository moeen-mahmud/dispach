# GitBook publishing runbook

This file records the current GitBook setup and review gate. It is intentionally outside public
navigation.

## Current setup

- Site: **Dispach Developer Documentation** (`site_kpc34`)
- Git Sync: `moeen-mahmud/dispach`, branch `development`, directory `/developer-docs`
- Sections: Guides, Contributing, Control Plane, and API Reference
- External HTTP API space: generated from `reference/openapi.json`
- Variants: none; the site currently documents `development`
- Publication: keep unpublished until the review gate below passes

The root `/gitbook-docs.yaml` belongs to the previous site mapping. Do not replace or edit it as part
of this site.

## Refresh the API reference

The repository snapshot is generated from the server router and schemas:

```bash
bun run docs:generate
bun run docs:check
```

GitBook imports
`https://raw.githubusercontent.com/moeen-mahmud/dispach/development/developer-docs/reference/openapi.json`
and checks it for updates every six hours. After an API change, confirm the Git-synced commit is
visible and refresh the generated HTTP API space if GitBook has not picked it up yet.

## Review gate

Before publishing:

- `bun run docs:check` passes on the synced commit.
- All four header sections and every page in their sidebars open on desktop and mobile previews.
- Tables, code blocks, callouts, headings, and previous/next links render without clipping or empty pages.
- The Docker quickstart reaches readiness and creates an agent from a clean checkout.
- The HTTP API space lists the generated operations, models, authentication, responses, examples, and source download.
- Search returns public guides for setup questions and does not present internal design documents as the user path.
- Release wording distinguishes stable `v0.1.x` from `v0.2.0-pilot.*` and identifies this site as `development` documentation.
- The intended public URL and custom domain are checked before pressing Publish.

Publishing makes the site public. Keep that as a separate, explicit maintainer action after the final
preview review.

## Rollback

If navigation, search, or the generated reference is wrong after publication, unpublish this site or
move the custom domain back to the previous site. The previous site and root mapping remain intact.
