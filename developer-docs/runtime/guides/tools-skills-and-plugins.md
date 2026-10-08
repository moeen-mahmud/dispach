# Tools, skills, and plugins

Dispach resolves capabilities at startup so each turn sees a known, validated tool set.

## Tools

Tools are pinned by slug in the manifest. Unknown slugs fail resolution instead of disappearing from the prompt. Phase configuration can narrow the visible set during a turn, which reduces tool-choice errors without changing the installed catalogue.

Provider catalogues may refresh after readiness. Warm a remote provider before latency-sensitive use rather than moving network work into boot.

The system provider supplies shell and file access outside core. Its policy evaluates the command string, while deployment isolation controls the filesystem and process boundary. Web search and provider catalogue search are separate tools.

## Skills

Skills package instructions and supporting resources. The harness selects relevant skills and injects them under a budget; it does not depend on a model deciding to browse a directory. Validate third-party skills before placing them in a catalogue available to agents.

## Plugins

Plugins extend channels, tools, lifecycle hooks, and middleware through the public plugin API. They run as trusted code in the runtime process. Install them at boot through the manifest; runtime package installation is deliberately unsupported.

First-party plugins use the same public contracts as external plugins. If an integration cannot be expressed through those contracts, improve the contract instead of reaching into core internals.

See the [plugin API specification](../../../docs/03-SPEC-PLUGIN-API.md) and contributor guide to [extending Dispach](../../contributing/extending-dispach.md).
