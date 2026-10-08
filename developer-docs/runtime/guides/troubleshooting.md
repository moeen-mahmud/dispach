# Troubleshooting

Dispach errors include a `hint`. Preserve it in logs and user-facing diagnostics; it usually names the corrective action.

## A source change has no effect

The CLI and sibling packages run from `dist/`. Rebuild the full workspace:

```bash
bun run build
```

Building only one package can leave provider or core output stale while source tests appear correct.

## The model endpoint returns 404

Set `baseUrl` to the version root, such as `https://api.openai.com/v1`. Do not include `/chat/completions`; the runtime appends that path.

## A secret is missing

The manifest holds an environment variable name. Set its value with `dispach config env <agent> <NAME>` or in the deployment's protected environment file. Do not replace the name with a literal key.

## A configured tool is absent

Unknown tool slugs fail boot. If a remote provider reports an empty cold cache, warm or refresh that provider and retry. A phase may also intentionally narrow tool visibility; inspect the active phase before editing the global tool list.

## A reasoning model returns empty text

Some compatible endpoints bill reasoning tokens against the output ceiling. A constrained prompt can consume the whole allowance before visible content. Verify that the endpoint actually honors its reasoning control, then raise the appropriate limit or configure `reasoningEffort: none` for that role.

## A stream disconnects

The turn continues. Reattach with the saved turn ID, inspect the replay preamble, and fetch the stored turn if the live buffer is unavailable or truncated.

## Container commands cannot write

The image runs as UID 1000. Ensure mounted directories are writable by that user. Keep the runtime non-root and correct the volume ownership instead of broadening container privilege.
