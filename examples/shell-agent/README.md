# shell-agent — an agent with a shell, meant for a container

`init --system full`: `exec`, the file tools, and `config_set`. This is the example to mount when
the thing being exercised is **the shell**, and it exists because the other examples deliberately
cannot run a command — `minimal` pins no tools at all, so it proves the wire and nothing about
`tools-system`.

```bash
cp .env.example .env            # then the key for whatever model agent.yaml names
cd ../..                        # repo root
AGENT_DIR=./examples/shell-agent docker compose up -d --wait
```

## Read this before running it outside a container

`--system full` means the agent can run shell commands and write files. The manifest's
`tools.policy` decides *whether* a command runs; it does not decide *where*. Those are different
mechanisms and only the first ships with the runtime:

- **`writeRoots` does not bind `exec`.** Verified: an agent with `file_write` refused outside its
  root did the same write with `echo … >`. All a write root can decide is where a shell *starts*.
- **The policy's `deny` list is a deny list.** `exec(rm *)` and `exec(sudo *)` are generated
  because they are the two everybody wants, and a deny list fails open on the case nobody
  anticipated. The `writeRoots`-style allow root is the mechanism that fails closed, and it does
  not reach a shell.
- **Untrusted output can argue.** `exec` is `mutating` and `untrusted`, so it taints its own turn
  and is once-per-turn unless a `policy.allow` rule names it — which this manifest does, because
  an agent that can run one command and then nothing is not useful. The delimiters around
  untrusted text are advisory; the write gate is the part that holds.

Which is why the intended deployment is the container, where `docker-compose.yml` supplies what
the policy cannot: every capability dropped, no privilege escalation, a bounded pid count, a memory
ceiling, and a read-only root filesystem with writable scratch only where something genuinely
writes. **Run this on a laptop and the only boundary is the policy.**

## What the shell can actually reach in the image

`sh`, `bash`, `git`, `python3`, `curl`, `wget`, `node`. `git` is there because the skills catalogue
is fetched with it and its absence deletes that feature rather than degrading it; `python3` because
a skill shipping scripts needs it. Measured cost: 21 MB.

Worth knowing: `/tmp` and `$HOME` are tmpfs and are **wiped on restart**, so `uv` rebuilds its
cache the first time a Python skill runs after each boot. `/agent` and `/state` persist.
