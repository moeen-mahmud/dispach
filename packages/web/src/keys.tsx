/**
 * Operator keys: mint, list, revoke.
 *
 * The one panel that has to *say* something rather than only show it. Keys are authentication and
 * not authorisation — every key reaches every route for every agent this server holds — and the
 * plan's rule for that was "said in the UI, not discovered". `GET /v1/keys` returns the sentence in
 * its own `scope` field precisely so this page does not compose its own version, which is how one
 * client comes to describe a security property differently from another.
 */

import type { DispachClient } from "@dispach/client"
import { useCallback, useEffect, useState } from "react"
import { forgetKey, rememberKey, storedKey } from "./lib/auth.ts"

interface KeyRow {
    readonly keyId: string
    readonly label: string
    readonly createdAt: string
    readonly lastUsedAt?: string
    readonly revokedAt?: string
}

export function Keys(props: {
    readonly client: DispachClient
    readonly baseUrl: string
    readonly token: string | undefined
}): React.ReactElement {
    const [rows, setRows] = useState<readonly KeyRow[]>([])
    const [scope, setScope] = useState<string>()
    const [label, setLabel] = useState("")
    const [minted, setMinted] = useState<string>()
    const [error, setError] = useState<string>()

    const headers = useCallback(
        (extra: Record<string, string> = {}) => ({
            ...extra,
            ...(props.token === undefined ? {} : { authorization: `Bearer ${props.token}` }),
        }),
        [props.token],
    )

    const load = useCallback(async () => {
        try {
            const response = await fetch(`${props.baseUrl}/v1/keys`, { headers: headers() })
            const body = (await response.json()) as {
                keys?: KeyRow[]
                scope?: string
                error?: { message?: string }
            }
            if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
            setRows(body.keys ?? [])
            setScope(body.scope)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    }, [props.baseUrl, headers])

    useEffect(() => {
        void load()
    }, [load])

    const mint = async () => {
        setError(undefined)
        try {
            const response = await fetch(`${props.baseUrl}/v1/keys`, {
                method: "POST",
                headers: headers({ "content-type": "application/json" }),
                body: JSON.stringify({ label: label.trim() }),
            })
            const body = (await response.json()) as {
                secret?: string
                error?: { message?: string }
            }
            if (!response.ok || body.secret === undefined)
                throw new Error(body.error?.message ?? `HTTP ${response.status}`)
            setMinted(body.secret)
            setLabel("")
            await load()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    }

    const revoke = async (row: KeyRow) => {
        setError(undefined)
        /**
         * Every revocation is confirmed, because **which row is this browser's key is genuinely
         * unknowable from here.**
         *
         * `GET /v1/keys` returns no secrets and no fingerprints, deliberately, so there is nothing
         * to match the held secret against. A warning shown once too often is a nuisance; one
         * missed on the row that signs you out is a session that ends with no explanation. Do not
         * "fix" this by having the server echo a fingerprint — that puts a verifier for the
         * credential into a listing whose whole property is being secret-free.
         */
        if (
            !window.confirm(
                `Revoke "${row.label}"? If it is the key this browser is using, you will be signed out of this page. There is no way to tell from here — the listing carries no secrets.`,
            )
        )
            return
        const held = storedKey()
        try {
            const response = await fetch(`${props.baseUrl}/v1/keys/${row.keyId}`, {
                method: "DELETE",
                headers: headers(),
            })
            if (!response.ok) {
                const body = (await response.json()) as { error?: { message?: string } }
                throw new Error(body.error?.message ?? `HTTP ${response.status}`)
            }
            // Whether *that* was this browser's key is discovered rather than predicted: reload
            // the listing, and if the credential we hold has stopped working, say so by clearing it
            // and starting over. Leaving a dead key in storage would make every later request a
            // mystery 401.
            if (held !== undefined && !(await stillWorks(props.baseUrl, held))) {
                forgetKey()
                window.location.reload()
                return
            }
            await load()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    }

    return (
        <>
            <div className="card">
                <h2>Issue a key</h2>
                <p>
                    A key is shown once and never again — the server stores a hash of it, so there
                    is no way to recover one. Label it for the browser or machine that will hold it.
                </p>
                {minted === undefined ? null : (
                    <>
                        <div className="secret">{minted}</div>
                        <p className="hint" style={{ margin: "0 0 12px" }}>
                            Copy it now. This is the only time it is readable.{" "}
                            <button
                                type="button"
                                style={{ padding: "2px 8px", fontSize: 11 }}
                                onClick={() => {
                                    rememberKey(minted)
                                    window.location.reload()
                                }}
                            >
                                use it in this browser
                            </button>
                        </p>
                    </>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                    <input
                        value={label}
                        placeholder="my laptop"
                        onChange={(event) => setLabel(event.target.value)}
                    />
                    <button
                        type="button"
                        className="primary"
                        disabled={label.trim() === ""}
                        onClick={() => void mint()}
                    >
                        Issue
                    </button>
                </div>
            </div>

            <div className="card">
                <h2>Keys</h2>
                {/* The server's own sentence, not this page's paraphrase of it. */}
                <p>{scope ?? "…"}</p>
                {error === undefined ? null : <p className="note bad">{error}</p>}
                <table>
                    <thead>
                        <tr>
                            <th>Label</th>
                            <th>Created</th>
                            <th>Last used</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.keyId}>
                                <td className={row.revokedAt === undefined ? "" : "revoked"}>
                                    {row.label}
                                </td>
                                <td>{day(row.createdAt)}</td>
                                <td>
                                    {row.revokedAt !== undefined
                                        ? `revoked ${day(row.revokedAt)}`
                                        : row.lastUsedAt === undefined
                                          ? "never"
                                          : day(row.lastUsedAt)}
                                </td>
                                <td>
                                    {row.revokedAt === undefined ? (
                                        <button
                                            type="button"
                                            className="bad"
                                            style={{ padding: "2px 9px", fontSize: 11 }}
                                            onClick={() => void revoke(row)}
                                        >
                                            revoke
                                        </button>
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {rows.length === 0 ? (
                    <p className="hint" style={{ marginTop: 10 }}>
                        No keys. This server is open to anyone who can reach the port — issuing the
                        first key is what closes it.
                    </p>
                ) : null}
            </div>
        </>
    )
}

/**
 * Whether the credential this browser holds still authenticates.
 *
 * The answer to "did I just revoke my own key", asked *after* the fact rather than predicted before
 * it — which is the only way to know, and is also the more reliable question: it is equally true
 * when another operator revokes this browser's key from their own page.
 */
async function stillWorks(baseUrl: string, secret: string): Promise<boolean> {
    try {
        const response = await fetch(`${baseUrl}/v1/agents`, {
            headers: { authorization: `Bearer ${secret}` },
        })
        return response.ok
    } catch {
        // A transport failure is not a revocation. Keeping the key is the safe direction: the worst
        // case is one more 401 when the server comes back, against signing somebody out over a
        // dropped connection.
        return true
    }
}

function day(iso: string): string {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10)
}
