/**
 * The browser build.
 *
 * ## Stable filenames, deliberately
 *
 * Vite hashes asset names by default, which is right when a CDN serves them and wrong here: the
 * server *embeds* them (decision 11.200), and an embedded asset list has to be written as import
 * statements — which cannot name a file whose hash changes every build. So the names are fixed and
 * the freshness problem moves to the server, which answers with an ETag derived from the bytes it
 * already holds. That is a better trade than it sounds: a hash in a filename only helps a cache
 * that keeps the old file, and there is no old file inside a binary.
 *
 * ## One chunk
 *
 * `manualChunks: undefined` and no dynamic imports in the app, so the output is one JS file and one
 * CSS file. Code splitting would multiply the import list the server has to embed for a page that
 * is a single screen, and a split chunk fetched over a loopback socket saves nothing worth the
 * second round trip.
 *
 * ## The dev proxy
 *
 * `vite dev` serves the UI on its own port and forwards `/v1` to a `dispach serve` on 7420, so UI
 * work needs no rebuild. It is **dev only** — in production the server serves both from one origin,
 * which is why there is no CORS anywhere in this repo.
 */

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/** Where `dispach serve` listens by default. Overridable, because a second agent moves the port. */
const API = process.env.DISPACH_DEV_API ?? "http://127.0.0.1:7420"

export default defineConfig({
    plugins: [react()],
    // Relative, so the page works at `/` without the server having to rewrite anything.
    base: "./",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // No sourcemap in the shipped bundle: it would double the embedded payload for a page
        // whose source is public anyway, and `vite dev` has real sourcemaps where they are used.
        sourcemap: false,
        rollupOptions: {
            output: {
                entryFileNames: "assets/app.js",
                chunkFileNames: "assets/app.js",
                assetFileNames: "assets/app.[ext]",
                manualChunks: undefined,
            },
        },
    },
    server: {
        proxy: {
            // `ws: true` matters even though `/v1/ws` answers 501 under Node — under Bun it
            // upgrades, and a proxy that dropped the upgrade would make the dev server the one
            // place WebSocket silently does not work.
            "/v1": { target: API, changeOrigin: true, ws: true },
        },
    },
})
