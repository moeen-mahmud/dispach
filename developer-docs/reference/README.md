# Reference

Use the guides to learn workflows and the references when implementing against a contract.

- **HTTP API:** the API Reference section is rendered from
  [`openapi.json`](openapi.json), generated from the registered router and Zod request schemas.
- **Live server:** every running server exposes the same document at `/v1/openapi.json` and a Scalar
  browser at `/docs`.
- **Manifest:** the binding field reference is
  [`docs/02-SPEC-MANIFEST.md`](../../docs/02-SPEC-MANIFEST.md).
- **Plugin API:** the binding extension contract is
  [`docs/03-SPEC-PLUGIN-API.md`](../../docs/03-SPEC-PLUGIN-API.md).
- **Wire and events:** the binding protocol is
  [`docs/04-SPEC-WIRE.md`](../../docs/04-SPEC-WIRE.md).
- **Workspace:** file tiers and authoring rules are in
  [`docs/07-SPEC-WORKSPACE.md`](../../docs/07-SPEC-WORKSPACE.md).

The generated HTTP reference describes requests, status codes, and the common error shape. Success
response types live in the TypeScript client, where `tsc` checks them against actual usage.

The generated document's `info.version` comes from the source tree's package version. On
`development`, that value can remain at the latest stable version until a pilot release branch is
prepared; use the exact Git tag or `GET /v1/health` from the deployed image when matching a contract
to a running server.
