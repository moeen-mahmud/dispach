# Architecture

The control plane gives each product subject an isolated Dispach runtime called a silo.

```text
product backend -- operator token --> control API -- Docker --> one silo per subject
product backend -- silo key -------> proxy ------------------> silo /v1 API
silo -------- signed webhook ------> product or monitor
```

The control plane owns placement, lifecycle, routing, key minting, backup, and aggregate usage. Each silo owns agents, conversations, policy, schedules, and authorization within that silo.

## Boundary from the runtime

`packages/control` imports no runtime package, and the runtime imports nothing from it. They communicate over the public `/v1` API. CI enforces the boundary in both directions and excludes control-plane code from the published runtime package.

The package has its own FSL-1.1-ALv2 license. The rest of the repository, including the runtime, remains Apache-2.0.

## Placement

The current `Placer` implementation uses Docker. Each subject receives a container and persistent volume. On the bundled Compose network, silos publish no host port; the control plane proxies requests to them by container name.

Always-on is the default because paused containers cannot hold Telegram or WhatsApp connections. Optional suspension saves CPU and wakes a silo before a known schedule or an authenticated proxied request.

## Isolation properties

A silo key is created by and verified inside one silo. The proxy forwards the caller's authorization header and does not replace it with an operator credential. A key from one silo is therefore unknown to another. Unknown subjects and bad credentials deliberately produce the same unauthorized response on the proxy path.
