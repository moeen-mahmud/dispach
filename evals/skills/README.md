# Skill indexing

```bash
bun run eval:skills                          # 50 skills, 7 repeats
bun scripts/eval-skills.ts --skills 400 --repeats 3
bun scripts/eval-skills.ts --ci              # fails above the ceiling
```

No endpoint, no model, no network. One claim: a cold scan of the catalogue stays inside the phase's
latency criterion, and the cache is worth what it costs.

The criterion is **cold under 50 ms, warm under 5 ms** for fifty skills. `--ci` enforces a ceiling
ten times above each, because this runs on whatever hardware is going and a number that fails on
somebody else's build is a number people learn to ignore.

## Why this is not a unit test

It was one. `skills-index.test.ts` asserted the two figures directly, and that assertion failed **2
runs in 3** with four builds running beside it — which is what a shared 2-core CI runner is every
time. The numbers below are why widening it in place was the wrong repair:

| | median | min | max |
| --- | --- | --- | --- |
| cold, idle | 5.09 ms | 4.48 | **185.76** |
| cold, four concurrent builds | 4.23 ms | 3.81 | **34.03** |

The median barely moves. A single sample is worth nothing — one repeat in seven landed 36× over the
median on an *idle* machine, and any assertion generous enough to survive that spike (say 250 ms)
would no longer be testing the 50 ms criterion at all. Taking a median over repeats measures the
thing; widening a single sample only stops measuring it.

## Results

`--skills 50 --repeats 7`.

| runtime | cold (median) | warm (median) | saved |
| --- | --- | --- | --- |
| bun 1.3.5 · macOS arm64 | 5.09 ms | 0.60 ms | 8.5× |
| bun 1.3.5 · macOS arm64, loaded | 4.23 ms | 0.57 ms | 7.5× |
| node 24.19 · linux arm64 (container) | 10.59 ms | 1.27 ms | 8.3× |

Both figures are well inside the criterion on every runtime measured, which is the answer the phase
wanted and could not get from a flaking assertion.

The `saved` column is the point of the cache and the reason it is checked rather than assumed: a warm
load reads one JSON file and stats each skill directory, a cold one parses every `SKILL.md` and
counts its tokens. `eval-skills.ts` asserts that the cold pass reports `cached: false` and the warm
pass `cached: true` before it reports any timing, because a "warm" figure taken from a second cold
scan measures nothing and looks like a fast cache.
