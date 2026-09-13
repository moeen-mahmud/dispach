# Memory

How Dispach remembers, retrieves, and injects. FTS5 + BM25, not embeddings. This is the running
account of Phase 6 through 6.5; the locked calls live in `00-DECISIONS.md` (5.29–5.53) and the
phase checklists in `05-PLAN.md`.

A performance claim without a number here is a guess. Reproduce with `bun run eval:memory`.

---

## Two tiers, one writer

```
memory_write ──▶ MEMORY.md          slot 4, carried every turn, budgeted
                     │ over budget
                     ▼
                memory/YYYY-MM.md   slot 10, retrieved only
                     │
                     ▼
                FTS5 index          per agent, no session link
                     ▲
                     │ at turn end, prose only, when includeHistory
                messages            source `session:<key>`
```

A fact said a minute ago is still *carried*, so the model does not need to retrieve it. When the
carried file passes its budget, oldest top-level list items move into the archive rather than being
deleted. Retrieval-only was the alternative and loses the near term: a note saved a minute ago is
invisible next turn unless the query happens to match it.

`memory_write` has no file argument. The runtime resolves one write target — the first writable
`volatile` file that declares `eviction: oldest`, falling back to declared order. Letting the model
name a file is a second decision on every save, and a second decision is the two-hop shape small
models fail.

---

## How a turn recalls

1. `enumerateFiles` stats the archive and the carried file. Unchanged sources are not read.
2. `syncFiles` reconciles that set. A source present in the index and absent from the set is
   **dropped** — so this is "here is the corpus", never "here is one more file".
3. `fts5Retriever` asks FTS5 for candidates, then scores them with `rank/bm25.ts` — the same
   tokeniser, idf, summation and normalisation the skill selector uses. FTS5's own `bm25()` is not
   the score: it computes statistics over the whole table, and one sandbox root has one store
   shared by every agent in it.
4. If the MATCH is empty, absent query terms are rewritten against the indexed vocabulary (5.53).
   A partial rewrite aborts.
5. `retrieveWithContext` may concatenate a bounded clean prior reply when the current query has
   ≤2 informative terms and nothing already clears the floor (5.47). Hits found only this way
   carry `because`.
6. `selectPassages` applies threshold, then `maxActive`, then budget, and **stops at the first
   passage that does not fit**.
7. `#recall` forwards `{source, at, text, because?}` into `assembleContext`. The live session is
   excluded, as is the carried file.

Conversations are a separate namespace (`syncSessions`). One shared pass would delete every
indexed conversation on the next file sync. Tool observations are never indexed: that would make
prompt injection durable. Assistant prose after untrusted output is persisted `tainted` and
excluded from both the projection and the expansion context.

The score is `lexical × coverage × recency`. Coverage keeps terms the corpus does not hold, which
is what drops "who won the 1998 world cup" matching a filler note that mentions 1998 once
(0.490 → 0.123) without refusing the genuine one-term query `frankfurt`.

---

## Where it sits in the prompt

| Slot | Content |
| --- | --- |
| 4 | Carried `MEMORY.md` / `USER.md` (volatile tier) |
| 8 | Recent history |
| 9 | Reminder (re-asserted rules) |
| 10 | Retrieved passages, one `# Remembered` block each |
| 11 | Current input |

Slot number equals prompt position. Memory used to sit in slot 7, ahead of history. A 3B model
given the correct passage there answered UNKNOWN; putting the evidence next to the question is
what recovered it (5.51). Reminder stays after history — that is a recency argument about rules,
not about evidence.

Each retrieved block is framed:

```
# Remembered

From 2026-08.md, learned 2026-08-01T10:00:00Z:
Found via the earlier reply: We were discussing the staging cluster.

The staging cluster lives in frankfurt.
```

The extra `Found via` line is present only on expansion-only hits. Conversation excerpts get a
different sentence from saved notes, because one frame for both produced an agent that held its
own transcripts and then claimed they do not carry over.

Slot 2 has a `memory` row. Without it, an agent with three excerpts in context still finished by
asserting that transcripts do not carry over.

The compaction notice in slot 2 tells the model the window is managed. It must not demand
verbosity: "do not shorten your work / write as much as the task needs" made llama3.2:3b answer
UNKNOWN while the correct value was already in the prompt (5.50).

---

## Phase 6.4 — deterministic foundation (2026-08-27)

Decisions 5.45–5.49. Eval at 5,000 passages, threshold 0.2, maxActive 3, budget 600, 21 questions.

| Metric | Baseline | Retained |
| --- | ---: | ---: |
| Recall | 76.5% (13/17) | **88.2% (15/17)** |
| Restraint | 75.0% (3/4) | **100% (4/4)** |
| F1 | 83.9% | **93.8%** |
| Slowest query | 0.89 ms | 0.98 ms |

What moved: original-query coverage, heading/tag weight ×2 (`TOKENISER_VERSION = 2`), bounded
prior-reply expansion, tainted assistant prose, session clear/delete dropping `session:<key>`
rows in the same transaction.

What stayed red, on purpose: one paraphrase, one typo. Always-on prior expansion was rejected
(changed-topic leak). An independent metadata score was rejected (uncalibrated second scale).

---

## Phase 6.5 — utilization (2026-08-28)

The 6.4 retriever was injecting the right note and a small model was not using it. Off-tree probe
on llama3.2:3b, 11 answer cases: 5 correct, 4 retrieved-but-UNKNOWN, 2 not retrieved (paraphrase,
typo). Three causes, all in the prompt rather than the index:

1. Slot 2 told the model not to shorten its work. That conflicted with "return the shortest exact
   value". Removing the sentence recovered the ignored replica id.
2. Memory sat in slot 7, before history. Evidence adjacent to the question recovered 3 of 4
   ignored values.
3. Expansion found the staging-cluster note from the prior reply, then dropped the subject before
   generation.

Fixes: notice wording (5.50), memory after history (5.51), `because` on expansion-only hits
(5.52), miss-only vocabulary correction (5.53).

Typo recovery is fail-closed. `stagng cluser` and `frankfrut` rewrite against the indexed
vocabulary and retrieve. `parking cluser` does not: a unique neighbour for `cluser` and none for
`parking` would otherwise MATCH `cluster` alone and surface the staging note. Semantic paraphrase
(`analytical database traffic`) stays red — coverage keeps the unmatched terms, and fixing that
honestly needs a synonym source or embeddings.

Numbers for this phase, 5,000 passages, threshold 0.2, maxActive 3, budget 600, 23 questions:

| Metric | 6.4 | 6.5 |
| --- | ---: | ---: |
| Recall | 88.2% (15/17) | **94.4% (17/18)** |
| Restraint | 100% (4/4) | **100% (5/5)** |
| F1 | 93.8% | **97.1%** |
| Slowest query | 0.98 ms | 3.52 ms |

Typo 0/1 → 2/2. Paraphrase stays 0/1. The empty-MATCH path loads the vocabulary, which is why the
slowest query moved; it is still five times inside the 20 ms ceiling.

---

## What was refused

- **Embeddings / a second persistent index.** Decision 5.32: prove lexical insufficient first.
  Paraphrase is still insufficient. One red fixture does not buy vectors.
- **Always-on prior-reply expansion.** Leaks yesterday's subject into a changed-topic turn.
- **Independent heading/tag score.** Uncalibrated against BM25. Weight the fields before
  saturation instead.
- **Answer planners, learned rerankers.** A second model in the retrieval path.
- **A model-backed eval in this repo.** Deleted on request. Utilization was probed off-tree;
  the harness eval remains lexical: did we inject the passage, not did the model quote it.
- **Rewriting an authored sentence in the injected block.** Decision 4.19. Structure and
  provenance only.

---

## Still open

- True semantic paraphrase. The stemmer does not map `analytical` onto `analytic` at a distance
  coverage will accept, and it should not: loosening coverage reopens 1998.
- Remaining stem gaps (`extraction` / `extract` is accepted in `rank/bm25.ts`).
- Recency weight `0.25` and half-life 30 days. Documented guess until a fixture exists whose
  right answer *changed over time*.
- Whether a frontier model uses a retrieved passage as reliably as the 3B probe failed to. That
  is a model measurement, not a harness one.
