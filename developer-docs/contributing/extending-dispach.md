# Extending Dispach

Choose the narrowest public extension point that owns the behavior.

| Need | Extension point |
| --- | --- |
| Receive and deliver messages | Channel plugin |
| Expose a catalogue of executable capabilities | Tool provider |
| Wrap model, tool, context, or event behavior | Plugin middleware |
| Package reusable instructions and resources | Skill |
| Add shell or filesystem capabilities | System tool package, outside core |

## Plugin contract

A plugin exports metadata, an optional Zod config schema, and `setup(ctx)`. Setup registers factories and middleware; it must not perform network I/O. Connections start after runtime readiness.

Plugins are trusted in-process code. Permission metadata is advisory in version 1, so authors should declare it accurately and operators should review the implementation.

## Distribution

Runtime installation is forbidden. A plugin must already be bundled, present in the host plugin root, or resolvable beside the manifest. An installed plugin is self-contained: publish its runnable entry and bundle or vendor any runtime dependencies.

## Contract discipline

First-party packages use the public API too. If your extension needs private core state, treat that as evidence that the public contract is incomplete and discuss the smallest contract change. Do not add a one-off escape hatch.

Read the binding Plugin API specification at `docs/03-SPEC-PLUGIN-API.md`, then use existing channel
and tool packages as implementation examples.
