# evals/nlt-heredoc — multi-line values through the NLT parser

Reproduce: `bun scripts/eval-nlt-heredoc.ts --model deepseek-chat --repeats 2`

## Why this exists

The carried backlog recorded a silent failure: a model writes a multi-line shell script as an `exec`
argument without NLT's `<<<` / `>>>`, a blank line clears the open field, the rest of the script
becomes the **reply**, and the truncated command runs. It was found by hand and deliberately left
unfixed, because this repo's rule is that the set of malformations is not enumerable — a tolerance
written for the one shape somebody happened to reproduce invites the belief the class is handled.

So the shapes were collected instead.

## What the first run found (2026-09-13, deepseek-chat, 8 tasks × 2 passes)

| Shape | Count | Reported before the backstop? |
| --- | --- | --- |
| `split` — blank line cuts the value, remainder becomes the reply | 2/16 | **no** |
| `indent_lost` — value survives, every leading space stripped | 2/16 | **no** |
| `field_error` — a bare `word:` line became a field | 4/16 | yes, `coerceArgs` |
| `single_line` | 4/16 | n/a |
| `wrapped` (`<<<` / `>>>`) | 2/16 | n/a |
| `unknown_tool` — model reached for a tool not in the catalogue | 2/16 | n/a, routing |

**25% of attempts produced a damaged `exec` argument, and half of those were silent.** Outcomes were
identical across both passes.

`indent_lost` was not in the backlog and is the more interesting half. The model wrote a *correct*
command:

```
command: python3 -c "
def primes(n):
    out, c = [], 2
    while len(out) < n:
```

and `consumeLine`'s continuation branch pushes each line **trimmed**, so it arrives at column zero —
an `IndentationError` rather than a script. It executes. Python fails loudly; a shell `if … then …
fi` would simply run differently.

## What the backstop does

`damage()` in `tools/dialect/nlt.ts` asks about **protocol conformance, not intent**. The backlog
proposed detecting "prose that reads as a continuation of the value it abandoned", which is a
judgement about meaning and therefore the unenumerable-set problem again. Every damaged value in this
corpus shared a checkable property instead:

- **unwrapped and multi-line** — it went through the continuation branch, so its indentation is
  already gone, whatever else happened to it;
- **an unterminated shell heredoc** — catches the case the first signal cannot see, where the blank
  line falls right after the opener and what survives is a single line. A shell heredoc names its own
  terminator, so the evidence that the value was cut is *inside the value*. Exact, not heuristic.

Both set `ParsedOutput.malformed` while carrying the intents. `loop/turn.ts` makes a step
all-or-nothing on `malformed`, so nothing runs and one repair is requested — the repair the parser
already grants for the XML-shaped near miss.

## The cost, stated

The `unwrapped` signal fires on multi-line values that would have run correctly. Two concrete
instances in this corpus and the test suite:

- `sql-multiline` — `sqlite3 ./store.db <<'SQL' … SQL`, a properly terminated shell heredoc whose
  stripped indentation SQL does not care about;
- the `lsof` case in `nlt.test.ts` — three flat shell lines with nothing to lose.

So roughly **4 genuinely damaged of 6 flagged**: a one-in-three false-repair rate on unwrapped
multi-line values. Accepted deliberately (Moeen, 2026-09-13) because the parser cannot know whether a
shell string is whitespace-sensitive — that is a fact about the content, not about the protocol — and
because the repair teaches the wrapped form, which is byte-exact and always correct.

The alternative considered and not taken: **preserve indentation on continuation lines**, which would
have made both false positives run and left only the split to catch. It changes the value every
existing multi-line call produces, so it is a behavioural change to weigh on its own rather than a
rider on a bug fix. Recorded here so it is not rediscovered as a new idea.

## Not measured

One endpoint. `gpt-4o-mini` and the open-weight slot are wired into the script and were not run — no
key for the first, nothing configured for the second. A small model may wrap far *less* often, which
would raise the damage rate rather than lower it, so the figure above is a floor on the problem
rather than a ceiling. Run them before quoting a rate as a property of the dialect rather than of
deepseek-chat.
