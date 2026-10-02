# Security policy

## Supported versions

Security fixes go into the **latest release on npm** (`npm view dispach version`) and the matching
container image (`ghcr.io/moeen-mahmud/dispach:latest`). Older releases are not patched: upgrade.

Pre-releases (`0.2.0-pilot.N`, npm `next`) are not patched in place. A fix ships in the next
pre-release.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/moeen-mahmud/dispach/security/advisories/new).

Include what you can of:

- the version (`dispach --version`) and how it runs (npm, the container, `serve` or a service);
- the component (core runtime, HTTP API, a channel, a tool provider, the web UI, the control plane);
- steps to reproduce: a manifest, a request or a model reply that triggers it;
- what an attacker gains, and what they need first (network reach, an API key, a channel sender,
  the ability to put text in front of the model).

## What happens next

| | Within |
| --- | --- |
| Acknowledgement | 3 business days |
| Initial assessment: confirmed or not, and severity | 7 days |
| A fix, or a plan with a date, for a critical or high issue | 30 days |

A confirmed issue is fixed in a private fork, released, and then disclosed in a GitHub security
advisory, with a CVE where one applies. Disclosure is coordinated with you, within 90 days of the
report at most. Reporters are credited in the advisory unless they would rather not be.

## Scope

In scope: everything in this repository, including the control plane (`packages/control`), which
is under a different licence (FSL-1.1) but this same policy. That covers the npm package, the
container image and the web UI it serves.

In particular, these are vulnerabilities:

- reaching the HTTP API, WebSocket or a channel webhook without the credential it requires, or
  beyond a key's scope (another agent, another participant's conversations, a capability the key
  does not carry);
- getting a mutating tool to run in a turn that read untrusted content, past
  `tools.untrusted.onMutate`, without a `policy.allow` rule or an approval;
- bypassing a `tools.policy` deny rule, the hardline command floor, protected paths, the write
  root, or (from 0.2.0) the file tools' refusal to read secrets;
- an agent widening its own containment through `config_set` (`allowFrom`, write roots, `deny`
  rules, `onMutate: allow`);
- `web_fetch` reaching a private or metadata address;
- a secret written to a log, an event, a response or the model's context;
- a crafted model reply, page or message that stalls the runtime (catastrophic regex backtracking
  and similar).

## Not vulnerabilities

These follow from documented design decisions:

- **`exec` runs shell commands.** A policy decides *whether* a command runs; a sandbox decides
  *where*, and containment is the deployment's job. The file tools' protections do not bind `exec`.
- **Plugins are trusted, in-process code.** A plugin can do anything the runtime can.
- **The fences around untrusted content are advisory.** A model can be talked past them; the write
  gate is the control that holds. A model saying something it was told to by a page is not a
  vulnerability; a mutating call that ran because of it is.
- **A server bound to loopback without a token is open to local processes.** That is the
  documented default, and a public bind refuses to start without one.
- **DNS rebinding against `web_fetch`** is a known, documented limit: the address check and the
  connection resolve separately.
- Findings that need an attacker who already has an admin key, shell access to the host, or
  write access to the agent's directory.
