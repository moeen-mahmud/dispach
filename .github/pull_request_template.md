## What this changes

<!-- One or two sentences, and the issue it closes: "Closes #123". -->

## How it was verified

<!-- The commands you ran and what they printed. For behaviour, the test that fails without the change. -->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test` (or the files you touched: `bun test path/to/file.test.ts`)
- [ ] `bun run docs:check`, if docs, the OpenAPI document or `evals/` changed
- [ ] A test for new behaviour in `packages/core`, which fails with the change reverted

## Contracts

- [ ] No manifest field, event, route or error code changed, or the spec in `docs/` is updated in this PR
- [ ] Every new error carries a `hint`
