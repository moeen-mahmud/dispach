# Memory retrieval

```bash
bun run eval:memory                      # 5,000 passages, 5 repeats
bun scripts/eval-memory.ts --passages 200
```

No endpoint, no model, no network. The script writes `results.json` locally; do not commit it.

Both claims are local: that retrieval stays inside its latency budget over a corpus far larger
than any real one, and that the shipped `memory.threshold` admits the answers a person would call
correct while refusing the ones they would not.

The fixture is `evals/fixtures/memory.ts`. The running design account is `docs/08-MEMORY.md`.

## What is *not* measured here

- **Whether a model uses a retrieved passage.** That needs an endpoint and a judgement about the
  reply. Recall here is "did the runtime inject it".
- **The recency weight and half-life** (`0.25`, 30 days). Documented guess until a fixture exists
  whose right answer changed over time (decision 5.34).
- **Anything about a real agent's corpus size.** 5,000 is a ceiling chosen to outrun reality, not a
  prediction.
