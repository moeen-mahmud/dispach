/**
 * The mount. Deliberately three lines of work and no logic.
 *
 * `baseUrl` is the page's own origin, which is the whole point of same-origin serving (decision
 * 13's UI hosting entry): no CORS anywhere in this repo, no configuration for the operator, and no
 * way for a deployed page to be pointed at somebody else's agent. Under `vite dev` the origin is
 * the dev server and `vite.config.ts` proxies `/v1` through, so this line is correct there too.
 */

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"
import { applyTheme, savedTheme } from "./overview.tsx"
import "./styles.css"

import { faviconHref } from "./wordmark.tsx"

// Before the first render, so a saved light theme never flashes dark.
applyTheme(savedTheme())
// The pixel initial, drawn from the brand name — `index.html` carries only a neutral placeholder.
document.querySelector<HTMLLinkElement>("link[rel=icon]")?.setAttribute("href", faviconHref())

const root = document.getElementById("root")
if (root === null) throw new Error("no #root in the document")

createRoot(root).render(
    <StrictMode>
        <App baseUrl={window.location.origin} />
    </StrictMode>,
)
