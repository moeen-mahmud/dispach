# Testing and evaluations

Use tests for correctness and evaluations for behavioral or performance claims.

## Tests

```bash
bun test path/to/file.test.ts
bun test
bun run test:node
```

Core changes require tests. The Node leg covers core's alternate SQLite adapter and catches assumptions hidden by Bun's runtime.

HTTP route and OpenAPI drift are checked together. If you add or change a route, update its Zod wire schema and generated description, then run the server specification tests and `bun run docs:generate`.

## Static gates

```bash
bun run lint
bun run build
bun run typecheck
bun run check:deps
bun run docs:check
```

`docs:check` verifies that the committed OpenAPI snapshot is current, each GitBook space has navigation, and local Markdown links and anchors resolve.

## Benchmarks and evaluations

```bash
bun run bench:boot
bun run eval:tools
bun run eval:memory
bun run eval:skills
```

Run `bench:boot` for every phase; CI fails at its configured ceiling. A claim about small-model accuracy, latency, caching, or security behavior needs a committed fixture or result under `evals/` and a script that reproduces it.

Real endpoint verification uses independent OpenAI-compatible implementations. Record the model, endpoint class, relevant limits, and empty or failed runs so the result can be interpreted later.
