/**
 * The plugin loader: resolution, the version gate, config validation, and the setup budget.
 *
 * Every refusal here is asserted on its *code and its wording*, not merely on throwing. These are
 * the errors somebody meets at boot with an agent that will not start, and the whole design premise
 * of decision 7.6 is that the message names all three numbers — a gate that refuses without saying
 * what to change is the debugging nightmare it was built to replace.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus } from "../src/events/bus.ts"
import type { AnyEvent } from "../src/events/types.ts"
import { loadPlugins } from "../src/plugins/loader.ts"
import type { Plugin, PluginContext } from "../src/plugins/plugin.ts"
import { VERSION } from "../src/version.ts"
import { describe, expect, test } from "./_harness.ts"

const PATHS = { workspace: "/tmp/ws", state: "/tmp/state", manifest: "/tmp/ws/agent.yaml" }

function harness(): { bus: EventBus; events: AnyEvent[] } {
    const bus = new EventBus({ runtimeId: "test" })
    const events: AnyEvent[] = []
    bus.on("*", (event) => events.push(event))
    return { bus, events }
}

function plugin(overrides: Partial<Plugin> = {}): Plugin {
    return {
        name: "fixture",
        version: "1.0.0",
        dispachApi: "^0.1",
        setup: () => {},
        ...overrides,
    }
}

async function load(
    refs: readonly (string | { spec: string; config: Record<string, unknown> })[],
    options: {
        builtIn?: Record<string, Plugin>
        importModule?: (specifier: string) => Promise<unknown>
        bus?: EventBus
        pluginRoot?: string
    } = {},
) {
    return loadPlugins({
        refs,
        agentId: "test",
        paths: PATHS,
        env: {},
        bus: options.bus ?? new EventBus({ runtimeId: "test" }),
        ...(options.builtIn === undefined ? {} : { builtIn: options.builtIn }),
        ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
        ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
    })
}

async function refusal(
    promise: Promise<unknown>,
): Promise<{ code: string; message: string; hint: string }> {
    try {
        await promise
    } catch (error) {
        const failure = error as { code?: string; message?: string; hint?: string }
        expect(failure.code).toBeDefined()
        return {
            code: String(failure.code),
            message: String(failure.message),
            hint: String(failure.hint),
        }
    }
    throw new Error("expected a refusal, and the call resolved")
}

describe("resolution", () => {
    test("a bare specifier resolves from the built-in registry without importing", async () => {
        // The registry is not a convenience: the CLI statically imports the first-party packages, and
        // a module imported both statically and dynamically makes `bun build --splitting` emit its
        // exports twice, producing a bundle that does not parse. So this path must never import.
        let imported = false
        const result = await load(["@dispach/channel-telegram"], {
            builtIn: { "@dispach/channel-telegram": plugin({ name: "telegram" }) },
            importModule: async () => {
                imported = true
                return {}
            },
        })
        expect(imported).toBe(false)
        expect(result.loaded[0]?.name).toBe("telegram")
    })

    test("a relative path is resolved against the manifest's directory, not the cwd", async () => {
        const seen: string[] = []
        await load(["./plugins/metrics.ts"], {
            importModule: async (specifier) => {
                seen.push(specifier)
                return { default: plugin({ name: "metrics" }) }
            },
        })
        expect(seen[0]).toBe("/tmp/ws/plugins/metrics.ts")
    })

    test("a specifier in neither place is refused, never fetched", async () => {
        const failure = await refusal(
            load(["@someone/nope"], { builtIn: { "@dispach/tools-web": plugin() } }),
        )
        expect(failure.code).toBe("plugin_not_found")
        // Names what *is* available, and says plainly that nothing is installed at runtime.
        expect(failure.hint).toContain("@dispach/tools-web")
        expect(failure.hint).toContain("installed while the process runs")
    })
})

describe("the version gate", () => {
    test("a mismatch names the plugin, the range, and the host", async () => {
        const failure = await refusal(
            load(["p"], { builtIn: { p: plugin({ name: "old", dispachApi: "^2" }) } }),
        )
        expect(failure.code).toBe("plugin_api_mismatch")
        expect(failure.message).toContain("old")
        expect(failure.message).toContain("^2")
        // Against the constant, not the literal it used to be. The claim is *"the message names the
        // host's version"*, and a hardcoded one turns that into a chore the next bump pays — this
        // test is what went red on 0.1.1 rather than anything about the gate.
        expect(failure.message).toContain(VERSION)
    })

    test("a range that cannot be checked is its own failure, not a mismatch", async () => {
        // The distinction is the point: a mismatch sends you to the host version, and this sends you
        // to the string the plugin author wrote. Collapsing the two would point at the wrong number.
        const failure = await refusal(
            load(["p"], { builtIn: { p: plugin({ name: "odd", dispachApi: "1.x" }) } }),
        )
        expect(failure.code).toBe("plugin_api_range_unreadable")
        expect(failure.hint).toContain("^1")
    })

    test("a satisfied range loads", async () => {
        const result = await load(["p"], { builtIn: { p: plugin({ dispachApi: "^0.1" }) } })
        expect(result.loaded.length).toBe(1)
    })
})

describe("what a plugin has to be", () => {
    test("the default export, not a named one", async () => {
        const failure = await refusal(
            load(["./p.ts"], { importModule: async () => ({ telegramPlugin: plugin() }) }),
        )
        expect(failure.code).toBe("plugin_malformed")
        expect(failure.hint).toContain("default export")
    })

    test("a missing required field names which one", async () => {
        const failure = await refusal(
            load(["./p.ts"], {
                importModule: async () => ({ default: { name: "half", version: "1.0.0" } }),
            }),
        )
        expect(failure.code).toBe("plugin_malformed")
        expect(failure.message).toContain("dispachApi")
    })

    test("two plugins with one name name both specs", async () => {
        const failure = await refusal(
            load(["a", "b"], {
                builtIn: { a: plugin({ name: "same" }), b: plugin({ name: "same" }) },
            }),
        )
        expect(failure.code).toBe("plugin_name_collision")
        expect(failure.message).toContain("a")
        expect(failure.message).toContain("b")
    })
})

describe("config", () => {
    test("is validated against the plugin's own schema before setup runs", async () => {
        let ranSetup = false
        const failure = await refusal(
            load([{ spec: "p", config: { port: "not a number" } }], {
                builtIn: {
                    p: plugin({
                        name: "metrics",
                        configSchema: {
                            safeParse: () => ({
                                success: false as const,
                                error: { issues: [{ message: "port must be a number" }] },
                            }),
                        },
                        setup: () => {
                            ranSetup = true
                        },
                    }),
                },
            }),
        )
        expect(failure.code).toBe("plugin_config_invalid")
        expect(failure.message).toContain("port must be a number")
        // The whole reason validation happens here rather than inside the plugin.
        expect(ranSetup).toBe(false)
    })

    test("the parsed value reaches setup, not the raw entry", async () => {
        let seen: unknown
        await load([{ spec: "p", config: { port: "7420" } }], {
            builtIn: {
                p: plugin({
                    configSchema: {
                        safeParse: () => ({ success: true as const, data: { port: 7420 } }),
                    },
                    setup: (context: PluginContext) => {
                        seen = context.config
                    },
                }),
            },
        })
        expect(seen).toEqual({ port: 7420 })
    })

    test("no schema means the entry is passed through", async () => {
        let seen: unknown
        await load([{ spec: "p", config: { anything: true } }], {
            builtIn: {
                p: plugin({
                    setup: (ctx) => {
                        seen = ctx.config
                    },
                }),
            },
        })
        expect(seen).toEqual({ anything: true })
    })
})

describe("setup", () => {
    test("a throw fails the load with the plugin named", async () => {
        const failure = await refusal(
            load(["p"], {
                builtIn: {
                    p: plugin({
                        name: "telegram",
                        setup: () => {
                            throw new Error("TELEGRAM_BOT_TOKEN is not set")
                        },
                    }),
                },
            }),
        )
        expect(failure.code).toBe("plugin_setup_failed")
        expect(failure.message).toContain("telegram")
        expect(failure.message).toContain("TELEGRAM_BOT_TOKEN")
        // Says where a *transient* failure belongs instead, which is the mistake this invites.
        expect(failure.hint).toContain("start()")
    })

    test("registrations land in the maps RuntimeOptions already takes", async () => {
        const result = await load(["p"], {
            builtIn: {
                p: plugin({
                    setup: (context) => {
                        context.defineChannel("telegram", (() => {
                            throw new Error("not constructed here")
                        }) as never)
                        context.defineToolProvider("web", (() => {
                            throw new Error("not constructed here")
                        }) as never)
                    },
                }),
            },
        })
        expect(Object.keys(result.channels)).toEqual(["telegram"])
        expect(Object.keys(result.toolProviders)).toEqual(["web"])
        expect(result.loaded[0]?.registered).toEqual(["channel:telegram", "toolProvider:web"])
    })

    test("manifest order decides who wins a key", async () => {
        const first = (() => "first") as never
        const second = (() => "second") as never
        const result = await load(["a", "b"], {
            builtIn: {
                a: plugin({ name: "a", setup: (ctx) => ctx.defineToolProvider("web", first) }),
                b: plugin({ name: "b", setup: (ctx) => ctx.defineToolProvider("web", second) }),
            },
        })
        expect(result.toolProviders.web).toBe(second)
        expect(result.loaded.map((entry) => entry.name)).toEqual(["a", "b"])
    })
})

describe("what the bus is told", () => {
    test("plugin.loaded carries the version and the permission kinds", async () => {
        const { bus, events } = harness()
        await load(["p"], {
            bus,
            builtIn: {
                p: plugin({
                    name: "telegram",
                    version: "0.3.1",
                    permissions: [
                        { kind: "network", hosts: ["api.telegram.org"] },
                        { kind: "env", vars: ["TELEGRAM_BOT_TOKEN"] },
                    ],
                }),
            },
        })
        const loaded = events.find((event) => event.type === "plugin.loaded")
        expect(loaded).toBeDefined()
        const data = loaded?.data as { name: string; version: string; permissions: string[] }
        expect(data.name).toBe("telegram")
        expect(data.version).toBe("0.3.1")
        expect(data.permissions).toEqual(["network", "env"])
    })

    test("a slow setup is reported and still loads", async () => {
        const { bus, events } = harness()
        const result = await load(["p"], {
            bus,
            builtIn: {
                p: plugin({
                    name: "sluggish",
                    setup: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 220))
                    },
                }),
            },
        })
        expect(events.some((event) => event.type === "plugin.slow")).toBe(true)
        // Reported, never refused: a refusal would turn a performance smell into a dead agent.
        expect(result.loaded[0]?.name).toBe("sluggish")
    })

    test("a fast setup says nothing", async () => {
        const { bus, events } = harness()
        await load(["p"], { bus, builtIn: { p: plugin() } })
        expect(events.some((event) => event.type === "plugin.slow")).toBe(false)
    })
})

describe("the plugin root — the middle of the three lookups", () => {
    /**
     * `plugins add` vendors a self-contained bundle into `<pluginRoot>/<name>/`, and this is the lookup
     * that finds it. Three things have to hold and each is a different failure:
     *
     * - the registry still wins, or a vendored directory could shadow a package already bundled into
     *   the binary and load a second copy of it — the `instanceof` failure's shape, one layer over;
     * - a directory that exists and cannot be entered is a **refusal**, because falling through to
     *   `import()` reports "cannot find module <name>", which sends a reader to a package registry
     *   when the problem is a half-fetched directory;
     * - `main` cannot leave the directory, for the reason `root.ts` records: resolve before comparing.
     */
    const root = join(tmpdir(), `plugin-root-${process.pid}-${Math.random().toString(36).slice(2)}`)

    function install(name: string, files: Readonly<Record<string, string>>): string {
        const dir = join(root, name)
        mkdirSync(dir, { recursive: true })
        for (const [file, text] of Object.entries(files)) {
            writeFileSync(join(dir, file), text)
        }
        return dir
    }

    test("a bare name resolves to the directory's entry, and says which lookup answered", async () => {
        install("vendored", {
            "package.json": JSON.stringify({ main: "entry.js" }),
            "entry.js": "",
        })
        const seen: string[] = []
        const result = await load(["vendored"], {
            pluginRoot: root,
            importModule: async (specifier) => {
                seen.push(specifier)
                return { default: plugin({ name: "vendored" }) }
            },
        })
        expect(seen).toEqual([join(root, "vendored", "entry.js")])
        expect(result.loaded[0]?.lookup).toBe("installed")
    })

    test("no package.json means index.js, which is the distribution shape", async () => {
        install("plain", { "index.js": "" })
        const seen: string[] = []
        await load(["plain"], {
            pluginRoot: root,
            importModule: async (specifier) => {
                seen.push(specifier)
                return { default: plugin({ name: "plain" }) }
            },
        })
        expect(seen).toEqual([join(root, "plain", "index.js")])
    })

    test("the built-in registry still wins over a directory of the same name", async () => {
        install("shadow", { "index.js": "" })
        let imported = false
        const result = await load(["shadow"], {
            pluginRoot: root,
            builtIn: { shadow: plugin({ name: "built-in" }) },
            importModule: async () => {
                imported = true
                return {}
            },
        })
        expect(result.loaded[0]?.name).toBe("built-in")
        expect(result.loaded[0]?.lookup).toBe("registry")
        expect(imported).toBe(false)
    })

    test("a name with no directory falls through to the import, and reports it", async () => {
        const result = await load(["absent"], {
            pluginRoot: root,
            importModule: async () => ({ default: plugin({ name: "absent" }) }),
        })
        expect(result.loaded[0]?.lookup).toBe("import")
    })

    test("a directory whose entry is missing is refused by name, not left to the import", async () => {
        install("gutted", { "package.json": JSON.stringify({ main: "dist/index.js" }) })
        const found = await refusal(
            load(["gutted"], { pluginRoot: root, importModule: async () => ({}) }),
        )
        expect(found.code).toBe("plugin_entry_missing")
        expect(found.message).toContain("dist/index.js is not there")
        expect(found.message).toContain(join(root, "gutted"))
    })

    test("a corrupt package.json is refused where it is, not at the next import", async () => {
        install("broken", { "package.json": "{not json" })
        const found = await refusal(
            load(["broken"], { pluginRoot: root, importModule: async () => ({}) }),
        )
        expect(found.code).toBe("plugin_entry_missing")
        expect(found.message).toContain("package.json is not valid JSON")
    })

    test("a main that points outside the plugin directory is refused", async () => {
        install("escape", { "package.json": JSON.stringify({ main: "../../../etc/passwd" }) })
        const found = await refusal(
            load(["escape"], { pluginRoot: root, importModule: async () => ({}) }),
        )
        expect(found.code).toBe("plugin_entry_missing")
        expect(found.message).toContain("outside the plugin directory")
    })

    test("a relative spec is still a path, never a name in the root", async () => {
        install(".", {})
        const seen: string[] = []
        await load(["./local-plugin.js"], {
            pluginRoot: root,
            importModule: async (specifier) => {
                seen.push(specifier)
                return { default: plugin() }
            },
        })
        // Resolved against the manifest's own directory, which is the rule every path here follows.
        expect(seen[0]).toBe("/tmp/ws/local-plugin.js")
    })

    test("a spec with a separator is never joined onto the root", async () => {
        const seen: string[] = []
        for (const spec of ["../../escape", "sneaky/../../escape", "@scope/package"]) {
            await load([spec], {
                pluginRoot: root,
                importModule: async (specifier) => {
                    seen.push(specifier)
                    return { default: plugin() }
                },
            })
        }
        // Each reached the import by the route it already had — a leading dot is a path relative to
        // the manifest, anything else is handed over verbatim. What none of them is, is a directory
        // name: `join(root, "../../escape")` would land outside the sandbox with nothing saying so.
        expect(seen).toEqual(["/escape", "sneaky/../../escape", "@scope/package"])
        expect(seen.some((specifier) => specifier.startsWith(root))).toBe(false)
    })

    test("with no root configured the lookup does not happen at all", async () => {
        install("ignored", { "index.js": "" })
        const seen: string[] = []
        await load(["ignored"], {
            importModule: async (specifier) => {
                seen.push(specifier)
                return { default: plugin({ name: "ignored" }) }
            },
        })
        expect(seen).toEqual(["ignored"])
    })

    test("the refusal for an unknown name names the root, so there is somewhere to look", async () => {
        const found = await refusal(
            load(["nowhere"], {
                pluginRoot: root,
                importModule: async () => {
                    throw new Error("Cannot find module 'nowhere'")
                },
            }),
        )
        expect(found.code).toBe("plugin_not_found")
        expect(found.hint).toContain(root)
    })
})
