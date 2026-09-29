# 17 — Running a silo on Kubernetes

What a pod needs from the stock image to run well rather than merely run. Written for VelaCrew's team
plane (doc 16, R9: one silo per team space on EKS), and generic: nothing here is specific to EKS
except where it says so. `examples/kubernetes/silo.yaml` is a working starting point.

The image is the same one Docker Compose runs (`ghcr.io/moeen-mahmud/dispach`). It runs `serve
--host 0.0.0.0` as uid 1000, from `/home/dispach`.

---

## 1. Storage: the store on a block volume, workspaces anywhere

```
/home/dispach/                       ← block volume (EBS gp3, a local PV). Never NFS or EFS.
└── .dispach/
    ├── store.db  store.db-wal  store.db-shm     sessions, turns, usage, schedules, keys
    ├── agents/                      ← may be a shared filesystem (EFS)
    │   └── <dir>/                   one per agent, named by directory, not by manifest id
    │       ├── agent.yaml
    │       ├── .env                 0600, the agent's secrets
    │       ├── SOUL.md  AGENTS.md  USER.md  MEMORY.md …
    │       ├── skills/  knowledge/
    ├── templates/   plugins/        what provisioning and plugins read
    └── logs/
```

**The store refuses to open on a network filesystem.** SQLite's locking relies on POSIX advisory
locks, which NFS (EFS mounts as `nfs4`), SMB, CephFS and GlusterFS implement loosely. The failure is
corruption with no error when it happens, so boot fails instead:

```
store_on_network_filesystem: The session database /home/dispach/.dispach/store.db is on a nfs4
filesystem, which SQLite's locking cannot trust.
```

Detection reads `/proc/self/mountinfo` for the mount holding the store's directory (Linux only). If
it is wrong, and the filesystem really is local, `DISPACH_ALLOW_NETWORK_STORE=1` overrides it.

**A nested mount needs its parent created first.** Mounting the workspaces volume inside the home
volume makes the container runtime create the missing `~/.dispach` as root, mode 0755, which
`fsGroup` does not reach. uid 1000 then cannot create `store.db` and the pod crash-loops with
`store_open_failed`. Found by running the example on k3s. The example's `layout` init container
creates the directory first, as the same non-root user. After the first start it is a no-op.

**Workspaces may be shared.** Mount EFS at `/home/dispach/.dispach/agents` over the block volume. The
embedder can then read and write `<dir>/…` for its file browser, previews and backups while the
silo runs. Two things to know when it does:

- Workspace files and `agent.yaml` are read when the agent loads, never per turn (the prompt prefix
  is cache-stable on purpose). An edit made from outside takes effect on
  `POST /v1/agents/:id/reload`. With turns running it answers `202` and swaps once they finish;
  running turns keep the settings they started with.
- The directory name is the agent's address on disk. Its manifest `id` is the address everywhere
  else (API, store, logs). They are usually equal; keep them equal.

## 2. Security context

```yaml
securityContext:            # pod
  runAsUser: 1000
  runAsGroup: 1000
  runAsNonRoot: true
  fsGroup: 1000             # so a fresh EBS volume is writable by uid 1000
containers:
  - securityContext:
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities: { drop: [ALL] }
```

With a read-only root, two paths must be writable:

| Path | Why | Mount |
| --- | --- | --- |
| `/home/dispach` | the store, agents, caches (`~/.cache`, `~/.npm` for skills that install) | the block volume |
| `/tmp` | tool output too large for an observation, spilled to a file the model reads by path; scratch space for commands | `emptyDir` |

Verified: the image boots and runs turns under `--read-only --tmpfs /tmp` with the home on a volume.

## 3. Probes

| Probe | Path | Meaning |
| --- | --- | --- |
| liveness | `GET /v1/health` | The process answers HTTP. 200 whenever the server is up, including while draining. |
| readiness | `GET /v1/ready` | 200 once every agent has loaded. 503 `starting` before that, 503 `draining` once a stop has begun. |

Both are unauthenticated. Readiness deliberately does **not** wait for channels: a Telegram outage
must not read as an unready pod and get it restarted into the same outage. Channel state is on
`GET /v1/agents/:id`.

A cold start with nothing to warm is well under a second. A `startupProbe` is only worth adding for
an image that installs plugins at start, which the stock image does not.

## 4. Stopping: SIGTERM and the drain

Kubernetes sends SIGTERM and waits `terminationGracePeriodSeconds` (default 30) before SIGKILL.
`serve` handles SIGTERM as a graceful stop: schedules stop, the outbox finishes the delivery in
flight, backgrounded `exec` children are reaped, the store closes.

**Running turns are not waited for unless you ask.** Set `DISPACH_DRAIN_MS` a few seconds under the
grace period:

```yaml
terminationGracePeriodSeconds: 30
env:
  - { name: DISPACH_DRAIN_MS, value: "25000" }
```

Then a stop with turns running first flips readiness to `draining`, waits up to that long for them,
and logs the outcome:

```
stopping
draining — waiting up to 25000 ms for running turns
drained in 4943 ms
```

A turn still running at the deadline is left as it is without a drain: the next start marks it
`turn_abandoned`. New turns are not refused while draining, since a message a channel already
received is better answered than dropped. Unset, a stop does not wait (the behaviour on a laptop and
under launchd). A malformed value refuses to start.

## 5. Credentials

Model access on EKS is Bedrock through **EKS Pod Identity**: associate an IAM role with the pod's
service account, and the AWS SDK inside `packages/model-bedrock` finds it with no configuration. The
role needs `bedrock:InvokeModelWithResponseStream` on the models or inference profiles the agents
use. Nothing about the credential goes in a manifest.

The API token is an env var named by `server.tokenEnv` (default `DISPACH_API_TOKEN`), from a Secret.
A non-loopback bind with no token refuses to start.

## 6. Egress

Everything a stock silo contacts. A default-deny NetworkPolicy allows DNS plus the rows the silo's
agents actually use:

| Host | Port | When |
| --- | --- | --- |
| `bedrock-runtime.<region>.amazonaws.com` | 443 | `api: bedrock-converse`. A cross-region profile (`eu.`, `global.`) is still called in `<region>`; AWS routes it |
| `169.254.170.23` | 80 | EKS Pod Identity agent (credentials). IMDS `169.254.169.254` only if the instance role is used instead |
| the model's `baseUrl` host | 443 | `api: chat-completions` (OpenAI, DeepSeek, an internal gateway…) |
| `backend.composio.dev` | 443 | the Composio tool provider |
| `api.telegram.org` | 443 | a Telegram channel |
| `web.whatsapp.com`, `*.whatsapp.net` | 443 | a WhatsApp channel (the socket, then media) |
| `login.botframework.com`, `login.microsoftonline.com`, `smba.trafficmanager.net` | 443 | a Teams channel: the connector's signing keys, the bot's token, replies. Teams also needs **ingress** to the webhook route |
| `slack.com`, `wss-primary.slack.com`, `files.slack.com` (`*.slack.com`) | 443 | a Slack channel: the Web API, the Socket Mode WebSocket, and voice clips and images. No ingress |
| each `peers.<name>.url` in `@dispach/channel-a2a`'s config | as configured | `a2a_send` to that peer only; the tool's `peer` is an enum of these names, so no other host is reachable through it. Inbound A2A is ingress on the runtime's own port |
| `transcribestreaming.<region>.amazonaws.com` | 443 | `media.transcription.provider: aws`. Image generation on `aws` is Bedrock, above |
| the media `baseUrl` host | 443 | `media.*.provider: openai` (`api.openai.com`, a gateway) |
| `api.tavily.com`, `api.search.brave.com`, `api.exa.ai` | 443 | `web_search`, whichever backend is configured |
| any | 443/80 | `web_fetch`, by its nature. Leave it unpinned, or accept that fetches outside the policy fail |
| `github.com` | 443 | skill catalogues (`sources update`, `skills install`) |
| the embedder's webhook receiver | 443 | `POST /v1/webhooks` subscriptions |

Nothing is contacted before `runtime.ready`. The web UI's API reference page loads a script from
`cdn.jsdelivr.net`, but in the viewer's browser, not from the pod.

## 7. One silo, one pod

A silo is a single process holding a single SQLite file, so it is a StatefulSet of **one replica**,
never scaled horizontally, on a `ReadWriteOnce` volume so a second pod cannot mount it at all. Do not
rely on leases to keep two pods apart: in a container every runtime is pid 1, and a lease naming
pid 1 from another process reads as dead (decision 14.13), which is right after a crash and wrong
for a live twin. Scale by silos (one per team space), not by replicas.
