import Link from "next/link"
import { Replay } from "@/components/replay"
import { benchmark, evidence } from "@/lib/evidence"
import { capturedAt, capturedModel, replay } from "@/lib/replay"
import { brand, repoUrl } from "@/lib/shared"
import { pixels } from "@/lib/wordmark"

const QUICKSTART = "/docs/runtime/quickstart/run-with-docker"
/** The preprint that measures the settings floor. A preprint, not peer-reviewed: say so wherever it is cited. */
const PAPER = "https://arxiv.org/abs/2610.06274"

/** The job, before the proofs: what a product team no longer has to build around a model. */
const BUILT_IN = [
    ["Sessions", "Every conversation persisted and resumable, keyed however your product keys it."],
    [
        "Memory",
        "Notes and past conversations recalled across sessions, ranked lexically, no vector store.",
    ],
    [
        "Tools under a policy",
        <>
            Shell, files, web, MCP and Composio. A policy decides what runs;{" "}
            <a href={PAPER} className="underline">
                a floor no rule can lift
            </a>
            .
        </>,
    ],
    [
        "Schedules",
        "Cron, interval and one-shot, DST-correct, delivered through the same outbox as replies.",
    ],
    ["Channels", "Telegram and WhatsApp. Slack, Teams and A2A ship experimental."],
    [
        "Approvals and keys",
        "A human gate on writes over the wire, and keys scoped to one agent or one tenant.",
    ],
] as const

const BENCHMARK = "/docs/runtime/benchmarks"
const { hermes, openclaw } = benchmark.rivals

const PROOFS = [
    {
        figure: `${benchmark.perfect} of ${benchmark.rows.length}`,
        title: `Models at ${benchmark.runs}/${benchmark.runs}, head-to-head`,
        body: `On ${benchmark.tasks} multi-turn tool tasks run ${benchmark.repeats} times each, ${brand.name} matches or beats ${hermes.name} on ${benchmark.atLeastHermes} of ${benchmark.rows.length} models and costs the least of three harnesses on ${benchmark.cheapest}.`,
        caveat: `One benchmark of our own design, each harness on its own defaults. ${hermes.name} leads on ${new Intl.ListFormat("en").format(benchmark.hermesAhead)}.`,
        href: BENCHMARK,
        link: "Benchmarks",
    },
    {
        figure: "202",
        title: "Turns outlive the client",
        body: "A turn is detached from the request that started it. Drop the connection, reattach from any client, and its events replay from the start, token by token when the send asked for chunks.",
        caveat: "The recording above is that, unedited apart from shortened request bodies.",
        href: "/docs/runtime/concepts/turn-lifecycle",
        link: "Turn lifecycle",
    },
    {
        figure: `${evidence.bootMs} ms`,
        title: "Process start to ready",
        body: "No network I/O before readiness, by rule. Channels and remote catalogues connect afterwards and report status as events.",
        caveat: `Median of 7 boots, ${evidence.bootMachine}. Boot, not response latency. CI fails above 1,200 ms.`,
        href: "/evals",
        link: "Evidence",
    },
    {
        figure: `${evidence.idleMiB} MiB`,
        title: `${evidence.agents} agents, one process`,
        body: "One runtime hosts many agents, and scoped keys fence each off. Adopt and remove agents live, with no restart.",
        caveat: "Idle resident memory, linux/arm64 image, one machine.",
        href: "/evals",
        link: "Evidence",
    },
]

type Cell = (typeof benchmark.rows)[number]["dispach"]

/** One harness's result: tasks passed as a bar measured from zero, and what the runs cost. */
function Score({ cell, best, accent }: { cell: Cell; best: boolean; accent?: boolean }) {
    return (
        <td className="px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3 font-mono text-sm">
                <span className={best ? "font-semibold" : "text-fd-muted-foreground"}>
                    {cell.pass}
                </span>
                <span className="text-xs text-fd-muted-foreground">${cell.cost.toFixed(2)}</span>
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-fd-border">
                <div
                    className={`h-1 rounded-full ${accent ? "bg-term-accent" : "bg-fd-muted-foreground/50"}`}
                    style={{ width: `${(cell.pass / cell.n) * 100}%` }}
                />
            </div>
        </td>
    )
}

function HeadToHead() {
    return (
        <section className="mx-auto w-full max-w-6xl px-4 py-16">
            <h2 className="font-mono text-sm text-term-accent">head-to-head, by the numbers</h2>
            <p className="mt-4 max-w-3xl text-2xl font-semibold tracking-tight text-balance">
                {brand.name} matches or beats {hermes.name} on {benchmark.atLeastHermes} of{" "}
                {benchmark.rows.length} models, and costs the least on {benchmark.cheapest}.
                {benchmark.openclawLast ? ` ${openclaw.name} scores lowest on every one.` : ""}
            </p>
            <p className="mt-3 max-w-3xl text-sm text-fd-muted-foreground">
                Tasks passed out of {benchmark.runs}: {benchmark.tasks} multi-turn tool tasks, run{" "}
                {benchmark.repeats} times each, graded on what the tools were left holding. Every
                harness runs in its own container against the same tools and pinned model providers.
                Cost is the OpenRouter bill for all {benchmark.runs} runs.
            </p>
            <div className="mt-8 overflow-x-auto rounded-2xl border border-fd-border">
                <table className="w-full min-w-[560px] text-left">
                    <thead className="border-b border-fd-border text-xs text-fd-muted-foreground">
                        <tr>
                            <th className="px-3 py-2.5 font-medium">Model</th>
                            <th className="px-3 py-2.5 font-medium text-term-accent">
                                {brand.name} <span className="font-mono">{benchmark.commit}</span>
                            </th>
                            <th className="px-3 py-2.5 font-medium">
                                {hermes.name} {hermes.version}
                            </th>
                            <th className="px-3 py-2.5 font-medium">
                                {openclaw.name} {openclaw.version}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-fd-border">
                        {benchmark.rows.map((r) => {
                            const top = Math.max(r.dispach.pass, r.hermes.pass, r.openclaw.pass)
                            return (
                                <tr key={r.name}>
                                    <td className="px-3 py-2.5 text-sm">{r.name}</td>
                                    <Score cell={r.dispach} best={r.dispach.pass === top} accent />
                                    <Score cell={r.hermes} best={r.hermes.pass === top} />
                                    <Score cell={r.openclaw} best={r.openclaw.pass === top} />
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            <p className="mt-4 text-xs text-fd-muted-foreground">
                One benchmark of our own design, each harness on its own documented defaults. With{" "}
                {benchmark.runs} runs an arm a gap of a few runs is noise.{" "}
                <Link href={BENCHMARK} className="underline">
                    Method, intervals and where {brand.name} loses
                </Link>
                .
            </p>
        </section>
    )
}

export default function HomePage() {
    return (
        <main className="flex flex-1 flex-col">
            <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-16 pb-20 lg:grid-cols-[1fr_1.1fr] lg:pt-24">
                <div>
                    <svg
                        role="img"
                        aria-label={brand.name}
                        viewBox={`0 0 ${pixels.width} ${pixels.height}`}
                        className="mb-8 h-10 w-auto text-term-accent sm:h-12"
                        shapeRendering="crispEdges"
                    >
                        {pixels.cells.map(({ x, y }) => (
                            <rect
                                key={`${x}:${y}`}
                                x={x}
                                y={y}
                                width={1}
                                height={1}
                                fill="currentColor"
                            />
                        ))}
                    </svg>
                    <p className="font-mono text-xs text-fd-muted-foreground">
                        v{evidence.version} · Apache-2.0 · self-hosted
                    </p>
                    <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                        The agent backend your product calls over HTTP.
                    </h1>
                    <p className="mt-5 max-w-xl text-lg text-fd-muted-foreground">
                        Your backend sends a message and {brand.name} runs the agent: memory, tools,
                        schedules, channels and approvals, on any OpenAI-compatible model, on
                        infrastructure you control.
                    </p>
                    <div className="mt-8 flex flex-wrap gap-3">
                        <Link
                            href={QUICKSTART}
                            className="rounded-lg bg-term-accent px-4 py-2.5 text-sm font-medium text-neutral-950 hover:brightness-110"
                        >
                            Run it in five minutes
                        </Link>
                        <a
                            href={repoUrl}
                            className="rounded-lg border border-fd-border px-4 py-2.5 text-sm font-medium hover:bg-fd-accent"
                        >
                            GitHub
                        </a>
                    </div>
                    <p className="mt-6 font-mono text-xs text-fd-muted-foreground">
                        <span className="text-term-accent">›</span> npm install --global{" "}
                        {brand.slug}
                    </p>
                </div>
                <Replay
                    lines={replay}
                    caption={`recorded run · ${capturedAt} · ${capturedModel}`}
                />
            </section>

            <HeadToHead />

            <section className="border-y border-fd-border bg-fd-card/40">
                <div className="mx-auto w-full max-w-6xl px-4 py-16">
                    <h2 className="font-mono text-sm text-term-accent">what you don't build</h2>
                    <dl className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                        {BUILT_IN.map(([term, detail]) => (
                            <div key={term}>
                                <dt className="font-medium">{term}</dt>
                                <dd className="mt-1 text-sm text-fd-muted-foreground">{detail}</dd>
                            </div>
                        ))}
                    </dl>
                    <p className="mt-8 text-sm text-fd-muted-foreground">
                        Research:{" "}
                        <a href={PAPER} className="underline">
                            What May an Agent Change About Itself?
                        </a>{" "}
                        (Hossain and Mahmud, 2026, preprint). With the settings floor in place, 0 of
                        167 protected writes were saved, though the models attempted one in 65 of
                        those cases.
                    </p>
                </div>
            </section>

            <section className="mx-auto w-full max-w-6xl px-4 py-16">
                <h2 className="font-mono text-sm text-term-accent">proof, with the caveats</h2>
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    {PROOFS.map((p) => (
                        <article
                            key={p.title}
                            className="flex flex-col rounded-2xl border border-fd-border p-6 hover:border-term-accent/60"
                        >
                            <p className="font-mono text-3xl font-semibold">{p.figure}</p>
                            <h3 className="mt-2 font-medium">{p.title}</h3>
                            <p className="mt-2 text-sm text-fd-muted-foreground">{p.body}</p>
                            <p className="mt-3 text-xs text-fd-muted-foreground/80">{p.caveat}</p>
                            <Link
                                href={p.href}
                                className="mt-auto pt-4 font-mono text-xs text-term-accent hover:underline"
                            >
                                {p.link} →
                            </Link>
                        </article>
                    ))}
                </div>
                <p className="mt-6 text-sm text-fd-muted-foreground">
                    Every number on this site has a row in the{" "}
                    <Link href="/evals" className="underline">
                        claim register
                    </Link>
                    , negative results included.
                </p>
            </section>

            <section className="mx-auto w-full max-w-6xl px-4 pb-16">
                <div className="rounded-xl border border-dashed border-term-warning/50 p-6">
                    <p className="font-mono text-xs text-term-warning">
                        experimental · where it's going
                    </p>
                    <p className="mt-2 max-w-3xl">
                        The multiplayer agent runtime: an isolated runtime for every user and team
                        in your product, with agents that share rooms and memory with the people
                        they work for, and stand in for them, openly, when they are away.
                    </p>
                    <p className="mt-2 text-sm text-fd-muted-foreground">
                        In {evidence.version} it is on the HTTP API only, with no screens yet, and
                        it may change within 0.2.x. Everything above is stable.
                    </p>
                </div>
            </section>

            <footer className="border-t border-fd-border">
                <div className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-4 px-4 py-8 text-xs text-fd-muted-foreground">
                    <p>
                        The runtime is Apache-2.0. The control plane (<code>packages/control</code>)
                        is source-available under FSL-1.1-ALv2.
                    </p>
                    <p className="flex gap-4">
                        <Link href="/docs">Docs</Link>
                        <Link href="/evals">Evals</Link>
                        <a href={repoUrl}>GitHub</a>
                    </p>
                </div>
            </footer>
        </main>
    )
}
