# GitBook staging and cutover

This file is the maintainer runbook for publishing `developer-docs/`. It is intentionally outside the public navigation.

## Stage without changing the current site

1. Create a separate staged GitBook site in the existing organization.
2. Connect Git Sync to `moeen-mahmud/dispach` and set the content root to `/developer-docs`.
3. Use `gitbook-docs.yaml` from that directory as the site configuration.
4. Sync `development` first and confirm the four sections and their default spaces.
5. In the externally managed `HTTP API` space, import `reference/openapi.json` and enable automatic refresh from the synced file.

The existing root `/gitbook-docs.yaml` remains the active site's mapping during review. Do not replace or edit it as part of staging.

## Variants

Create two site variants:

| Variant | Git branch | Purpose |
| --- | --- | --- |
| Stable | `main` | Released behavior and default public URL |
| Next | `development` | Current integration and pilot documentation |

Keep Stable as the default. The control-plane guide can appear in Next before the same pages reach Stable, but a page must describe only behavior present on its branch.

## Review gate

Before switching the public site:

- `bun run docs:check` passes on the synced commit.
- All four section landing pages open from the header navigation.
- The Docker quickstart reaches readiness and creates an agent from a clean checkout.
- The HTTP API space renders endpoints from the generated OpenAPI file.
- Stable resolves from `main`; Next resolves from `development`.
- Search returns the public guide before internal specifications for setup questions.
- The existing site URL and custom domain still point to the old site.

## Cut over and roll back

Move the public domain to the staged site only after the gate passes. Keep the previous site unpublished but intact until the new site has served correctly through a full review window.

If navigation, search, or the generated reference is wrong, move the domain back to the previous site. Repository content and the old root mapping remain available, so rollback does not require reverting documentation commits.
