# Control plane

The control plane places, routes, suspends, wakes, backs up, and removes one Dispach runtime silo per
user or team. It is a pilot component under **FSL-1.1-ALv2**, separate from the Apache-2.0 runtime
and excluded from the published `dispach` package.

Start with the [architecture](architecture.md), then follow the
[integration lifecycle](integration-lifecycle.md) from user creation through deletion. Operators
should read [deployment and operations](deployment-and-operations.md), especially the Docker socket
trust boundary.

This guide documents the contract in the `v0.2.0-pilot.*` line and the `development` branch. The
stable `v0.1.x` runtime does not include the control plane. Read [stable and pilot
releases](../runtime/releases.md) before choosing an image or source revision.
