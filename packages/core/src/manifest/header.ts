/**
 * A shallow read of a manifest's identity — for listings, never for loading.
 *
 * `loadManifest` is deliberately unusable here: it expands env references and checks that the
 * named key variables are set, so a *picker* built on it would fail exactly when it is needed
 * most — on a machine where the key is not exported yet. Listing an agent must never require its
 * credentials. This reads only `id`, `name`, and `model.main.id`, with no env expansion, no
 * schema validation, no `extends` resolution, and returns raw strings: `${MODEL_ID}` comes back
 * verbatim, and the caller decides how to display it.
 *
 * It also reads `plugins`, which is not identity and belongs here anyway. The plugin loader has to
 * know what to load *before* `loadManifest` runs, because that function validates `tools.provider`
 * and a channel `type` against the ids this host can supply — and half of those ids come from the
 * plugins themselves. Reading them here is what breaks that circle without parsing the file twice
 * or making `loadManifest` async. Every property that makes this reader safe applies: a plugin spec
 * is a package name or a path, never a secret, and needs no expansion to be actionable.
 *
 * Lives in core because core owns the YAML dependency — the CLI's runtime dependencies are
 * capped at the renderer pair by decision 11.10.
 */

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { manifestNotYaml, manifestUnreadable } from "../errors.ts"

export interface ManifestHeader {
    readonly id?: string
    readonly name?: string
    /**
     * Raw, and deliberately unexpanded — reading a header must never need credentials.
     *
     * Which is why a generated manifest carries the id **literally**: with `${MODEL_ID}` here, every
     * agent in the sandbox listed as the string `${MODEL_ID}` and the picker could not tell two of
     * them apart. A hand-written manifest may still use a variable, and then this is what it says.
     */
    readonly modelId?: string
    /**
     * Raw `plugins:` entries, unvalidated.
     *
     * Shapes are checked by the schema at load; this only needs enough to resolve modules, so a
     * malformed entry is passed through and refused later where the error can name the field. Both
     * spellings survive — the bare string and the `{ spec, config }` form.
     */
    readonly plugins?: readonly (string | { spec: string; config?: Record<string, unknown> })[]
    /**
     * Raw `channels:` entries, unvalidated, and here for the same reason `plugins` is.
     *
     * A channel is not identity either, and reading one **must not need credentials** — which is
     * exactly why a full load will not do: `loadManifest` checks that named variables are set, so a
     * surface built on it fails on the one agent somebody is trying to fix. Listing a channel whose
     * token is missing, and offering to fill it in, is the case this exists for.
     *
     * Shapes are checked by the schema at load; a malformed entry is passed through and refused
     * later, where the error can name the field.
     */
    readonly channels?: readonly {
        readonly id: string
        readonly type: string
        readonly enabled?: boolean
        readonly allowFrom?: readonly string[]
        readonly [field: string]: unknown
    }[]
}

export function readManifestHeader(
    path: string,
    readFile: (path: string) => string = (target) => readFileSync(target, "utf8"),
): ManifestHeader {
    let text: string
    try {
        text = readFile(path)
    } catch (cause) {
        throw manifestUnreadable(path, cause)
    }

    let parsed: unknown
    try {
        parsed = parseYaml(text)
    } catch (cause) {
        throw manifestNotYaml(path, cause)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        // The same shape failure loadManifest reports, reused so a broken file reads the same
        // in a listing's `problem` column as it would at load.
        throw manifestNotYaml(path, new Error("did not parse to a mapping"))
    }

    const record = parsed as Record<string, unknown>
    const model = record.model
    const main =
        model !== null && typeof model === "object" && !Array.isArray(model)
            ? (model as Record<string, unknown>).main
            : undefined
    const mainId =
        main !== null && typeof main === "object" && !Array.isArray(main)
            ? (main as Record<string, unknown>).id
            : undefined

    return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof mainId === "string" ? { modelId: mainId } : {}),
        ...(Array.isArray(record.plugins)
            ? { plugins: record.plugins as NonNullable<ManifestHeader["plugins"]> }
            : {}),
        // Filtered to entries that at least have the two fields everything keys on. A half-written
        // entry is the schema's to refuse at load; what would be wrong here is handing a surface a
        // channel with no id, which it would then render as a row nothing can act on.
        ...(Array.isArray(record.channels)
            ? {
                  channels: (record.channels as Record<string, unknown>[]).filter(
                      (entry) =>
                          entry !== null &&
                          typeof entry === "object" &&
                          typeof entry.id === "string" &&
                          typeof entry.type === "string",
                  ) as unknown as NonNullable<ManifestHeader["channels"]>,
              }
            : {}),
    }
}
