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

## Stable and Next

GitBook's Stable variant tracks `main`. Next tracks `development`. Keep public pages accurate for the branch they ship from; describe planned behavior only when it is clearly marked as planned.

The repository stages this tree independently from the current site mapping. Maintainers switch the public site only after the staged navigation and links have been reviewed.
