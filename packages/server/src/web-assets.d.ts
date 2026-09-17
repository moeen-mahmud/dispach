/**
 * Types for the three built assets imported as text.
 *
 * Needed because Bun's own ambient types model an HTML import as an `HTMLBundle` — its full-stack
 * HTML entry point — and give `.css` and `.js` no declaration at all. The `with { type: "text" }`
 * attribute changes what the *bundler* produces and not what TypeScript infers, so without this
 * file the two disagree: `HTMLBundle` where a string arrives, and an implicit `any` for the other
 * two, which hard rule 6 forbids outright.
 *
 * ## Why these are wildcard patterns, and why they are narrow ones
 *
 * A `declare module` with a *relative* specifier is not an ambient declaration — TypeScript reads it
 * as a module augmentation and refuses. So a pattern is the only form available, and the temptation
 * is a bare extension wildcard, which would type every future mistyped import as a string and lose
 * the property these lines exist for: a missing asset should be a compile error rather than
 * `undefined` reaching an HTTP response.
 *
 * The patterns below are as narrow as a pattern can be while still matching. TypeScript resolves the
 * candidate with the longest matching prefix, which is also what makes these win over Bun's own
 * HTML declaration — deliberately, since `HTMLBundle` is the wrong type for a text import.
 *
 * (The patterns are not quoted in this comment: a star followed by a slash ends a block comment, and
 * writing one here is how this file first failed to parse.)
 */

declare module "*/web/dist/index.html" {
    const contents: string
    export default contents
}

declare module "*/web/dist/assets/app.css" {
    const contents: string
    export default contents
}

declare module "*/web/dist/assets/app.js" {
    const contents: string
    export default contents
}
