#!/usr/bin/env node
/**
 * Node compatibility smoke test, run unbundled against `packages/core/src`.
 *
 * Decision 2.2 makes Node a soft goal — reach without a second toolchain; 13.5 puts the floor at
 * 24. The thing that
 * actually breaks it is import syntax: Node's native type-stripping refuses extensionless
 * relative specifiers and non-erasable TS syntax. This file proves the source tree satisfies
 * both, today, so Phase 2's "same suite under `bun test` and `node --test`" criterion is a
 * matter of picking a test adapter rather than rewriting every import in core.
 *
 *   node scripts/smoke-node.ts
 */

import assert from "node:assert/strict"
import { BRAND, DEFAULT_BRAND, VERSION } from "../packages/core/src/index.ts"

assert.equal(BRAND.slug, DEFAULT_BRAND.slug, "brand resolves identically under Node")
assert.equal(BRAND.apiVersion, `${BRAND.slug}/v1`, "apiVersion derives from the slug")
assert.equal(BRAND.envPrefix, `${BRAND.slug.toUpperCase()}_`, "env prefix derives from the slug")
assert.match(VERSION, /^\d+\.\d+\.\d+/, "version is semver-shaped")

console.log(`smoke-node: ok — ${process.version}, brand "${BRAND.slug}", core ${VERSION}`)
