# examples/team — a supervisor and two members

Delegation, at the smallest size that shows the whole mechanism.

```bash
cp examples/team/.env.example examples/team/.env      # then a model key
cp examples/team/.env examples/team/team/.env         # members load their own
dispach validate ./examples/team
dispach run ./examples/team --input "Write a short blurb about SQLite's WAL mode."
```

## What is here

| | |
| --- | --- |
| `agent.yaml` | The supervisor, `editor`. Its `team:` block declares two members — which is what registers the `handoff` tool. |
| `team/researcher.yaml` | A member. An ordinary agent that happens to be delegated to. |
| `team/writer.yaml` | The same, for prose. |

Each member is a **full agent with its own manifest**, so you can debug one directly:

```bash
dispach validate ./examples/team/team/researcher.yaml
dispach run ./examples/team/team/researcher.yaml --input "Find three facts about WAL mode."
```

Run on its own it has no `submit_artifact` tool and no team — it is just an agent. The return
channel is layered on for the duration of one handoff, with the **supervisor's** declared schema,
which is why the member's manifest mentions neither.

## Three things worth knowing before you copy this

**Members run one at a time.** `handoff` is mutating, because a member can write files and run
shell commands, and a mutating call runs alone in its execution group. Three handoffs in one step
take three times as long as one. Stated here because a latency property nobody wrote down is one
somebody reports as a hang.

**The member cannot ask a follow-up question.** It starts with no history and its reply goes to the
supervisor as an artifact. So a task has to carry everything the member needs — which is the
constraint that makes delegation cheap, not an omission.

**The supervisor never sees the transcript.** Only the artifact reaches its prompt, which is the
whole point: its context grows by the size of the answer rather than the size of the work. When a
delegation fails, the failure names the member's session so you can go and read what it said:

```bash
dispach sessions ./examples/team           # handoff:r_… rows are members' runs
```

## The `artifact` schema is a real gate

It becomes the parameter schema of the member's `submit_artifact` tool, so a missing required field
is a coercion error the member reads and gets one repair for — the same path every tool call takes.
If it still cannot submit, the supervisor is told so, along with the member's own explanation of
why, which is usually that the task was missing something.

Try it: ask for something the researcher cannot know, and watch the supervisor get
`handoff_no_artifact` with the member's sentence attached rather than an empty object.
