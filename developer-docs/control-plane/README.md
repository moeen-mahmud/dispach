# Control plane

The control plane places, routes, suspends, wakes, backs up, and removes one Dispach runtime silo per
user or team. It is a pilot component under **FSL-1.1-ALv2**, separate from the Apache-2.0 runtime
and excluded from the published `dispach` package.

Start with the [architecture](architecture.md), then follow the
[integration lifecycle](integration-lifecycle.md) from user creation through deletion. Operators
should read [deployment and operations](deployment-and-operations.md), especially the Docker socket
trust boundary.

Stable runtime releases may not include this package. Use the **Next** documentation variant for the
current pilot contract.
