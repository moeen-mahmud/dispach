# Stable and pilot releases

Dispach publishes stable runtime releases and a separate pilot line. Pin an exact version whenever
you deploy a server or silo.

| Release line | Intended use | Distribution |
| --- | --- | --- |
| `v0.1.x` stable | The current stable standalone runtime | npm `latest`, GitHub Release, versioned and `latest` container tags, Homebrew |
| `v0.2.0-pilot.N` | Evaluation of the multiplayer runtime and control plane | npm `next`, GitHub pre-release, exact-version container tag |

The latest releases verified while this page was updated on 8 October 2026 were `v0.1.3` and
`v0.2.0-pilot.14`. Check [GitHub Releases](https://github.com/moeen-mahmud/dispach/releases) before
installing because pilot revisions are frequent.

## Install the line you intend to test

Install the stable CLI through the default npm tag:

```bash
npm install --global dispach@latest
```

Install a pilot by exact version:

```bash
npm install --global dispach@0.2.0-pilot.14
docker pull ghcr.io/moeen-mahmud/dispach:0.2.0-pilot.14
```

A pilot does not update the npm `latest` tag, the `latest` container tag, or the stable Homebrew
formula. Do not use `next` as a production pin: it moves whenever a new pilot is published.

## What the pilot includes

The pilot line exercises one isolated runtime silo per product user or team, managed through the
[control plane](../control-plane/README.md). It covers placement, proxy routing, key minting,
suspension, backup, restore, recreation, aggregate usage, and pilot monitoring.

`packages/control` remains a private, source-distributed package under FSL-1.1-ALv2. It is not
included in the published `dispach` npm package. Run it from a matching repository checkout and pin
the silo image to the same pilot version.

Pilot APIs can change between revisions. Review the notes for every pilot release and the
[`Unreleased` changelog](../../CHANGELOG.md) before upgrading. The stable `v0.1.x` line does not
include the control plane.
