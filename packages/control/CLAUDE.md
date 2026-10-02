# CLAUDE.md — packages/control

The control plane for Dispach silos. **FSL-1.1-ALv2, unlike everything else in this repository.**
The root `CLAUDE.md` applies in full; these are the additions for this package. Read `README.md`.

1. **The licence line is a code line.** This package imports nothing from `@dispach/*` or by a
   relative path out of `packages/control`, and nothing outside imports it. `bun run check:deps`
   enforces both directions; `verify:package` checks the runtime's tarball. A control-plane need that
   seems to require a runtime import means the runtime's `/v1` should expose it: report it.
2. **Never a second copy of a decision the silo makes** (decision 14.6): who a key reaches, what an
   agent may do, whether a turn is allowed. The proxy forwards; it does not authorise.
3. **The proxy adds no credential**, not the silo's token and not the operator's. That is the entire
   isolation argument, and `test/e2e.test.ts` asserts it against the real image.
4. **Brand strings live in `src/brand.ts`**, this package's own copy, because it may not import
   core's. `scripts/rename-brand.ts` rewrites contents tree-wide, so a rename still reaches it.
5. **Everything cloud-specific lives behind `Placer`.** No provider SDK anywhere else.
6. **No dependencies.** Node's standard library, run as TypeScript by Node 24; SQLite through a
   four-call adapter over `bun:sqlite` (tests) and `node:sqlite` (shipped).
