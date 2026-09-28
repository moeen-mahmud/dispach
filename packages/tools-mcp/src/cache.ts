/**
 * The tools each MCP server listed, on disk beside the agent, so boot resolves pinned tools with no
 * network call. Keyed by server name **and URL**: pointing a server entry at a different URL makes
 * its cached tools unknown rather than silently serving the old server's schemas.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { BRAND } from "@dispach/core"
import type { McpTool } from "./client.ts"

const CACHE_VERSION = 1

export interface CachedServer {
    readonly url: string
    readonly fetchedAt: string
    readonly tools: readonly McpTool[]
}

export type McpCache = Readonly<Record<string, CachedServer>>

export function cachePath(dir: string): string {
    return join(resolve(dir), BRAND.stateDir, "mcp.cache.json")
}

/** An unreadable or older-format cache reads as empty: the next warm rewrites it. */
export function readCache(dir: string): McpCache {
    try {
        const parsed = JSON.parse(readFileSync(cachePath(dir), "utf8")) as {
            version?: number
            servers?: Record<string, CachedServer>
        }
        if (parsed.version !== CACHE_VERSION || typeof parsed.servers !== "object") return {}
        const out: Record<string, CachedServer> = {}
        for (const [name, entry] of Object.entries(parsed.servers ?? {})) {
            if (typeof entry?.url === "string" && Array.isArray(entry.tools)) out[name] = entry
        }
        return out
    } catch {
        return {}
    }
}

/** Written to a temporary file and renamed, so a crash mid-write leaves the previous cache. */
export function writeCache(dir: string, servers: McpCache): string {
    const path = cachePath(dir)
    mkdirSync(dirname(path), { recursive: true })
    const partial = `${path}.partial`
    writeFileSync(partial, `${JSON.stringify({ version: CACHE_VERSION, servers }, null, 2)}\n`)
    renameSync(partial, path)
    return path
}
