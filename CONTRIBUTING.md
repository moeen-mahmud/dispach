# Contributing to Dispach

Dispach accepts focused bug fixes, documentation improvements, tests, and small refinements through
pull requests. Start a discussion before implementing a new dependency, public API, manifest field,
event type, architecture change, or product behavior; those choices affect contracts beyond one
file.

The contributor guide covers the complete workflow:

- [Set up a checkout](developer-docs/contributing/development-setup.md)
- [Understand the repository](developer-docs/contributing/repository-map.md)
- [Make and verify a change](developer-docs/contributing/making-a-change.md)
- [Add a channel, tool provider, or plugin](developer-docs/contributing/extending-dispach.md)
- [Run tests, benchmarks, and evaluations](developer-docs/contributing/testing-and-evaluations.md)

Please report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
not through an issue or pull request.

The short version: keep a change focused, preserve the package boundaries, update a binding spec
when its contract changes, add a test for non-trivial core behavior, and report exactly what you
verified. Maintainers cut releases.
