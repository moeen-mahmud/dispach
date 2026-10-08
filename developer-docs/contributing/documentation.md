# Writing documentation

Public documentation lives in `developer-docs/` and is published through GitBook Git Sync. Internal design history and binding contracts stay in `docs/`.

## Choose the right home

- Add task-oriented setup and integration guidance to `developer-docs/runtime`.
- Add contribution workflow to `developer-docs/contributing`.
- Add silo lifecycle material to `developer-docs/control-plane`.
- Update a binding specification in `docs/` when code changes the contract.
- Link to an internal specification when readers need exact fields; do not copy the entire document into a guide.

Each GitBook space has its own `README.md` and `SUMMARY.md`. Add every new page to that space's summary.

## API reference

The server generates OpenAPI from the same router and Zod schemas used at runtime. Refresh the committed snapshot after an API change:

```bash
bun run docs:generate
bun run docs:check
```

Do not edit `developer-docs/reference/openapi.json` by hand.

## Published branch

The current GitBook site tracks `development`; it does not have separate Stable and Next variants.
Pages may therefore describe pilot behavior, but must label it with the release line that provides
it. Describe planned behavior only when it is clearly marked as planned.

If a stable variant is added later, map it to `main` and review both branches independently before
making it the default.
