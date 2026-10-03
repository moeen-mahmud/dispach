/**
 * Ten bulk-read tasks for `eval:subagents`: each tool returns a realistically large, deterministic
 * observation, and each task's answer is a handful of facts buried in it.
 *
 * Deterministic so that a difference between arms is the arms', not the data's: the same seed-free
 * generator produces the same bytes every run. Scoring is by required strings in the reply, which a
 * reader can check by eye, rather than by a judge model that would need its own eval.
 */

/** One tool the task's agent can call. Its output is the observation the arms differ over. */
export interface FixtureTool {
    readonly slug: string
    readonly summary: string
    readonly parameters: Readonly<
        Record<string, { readonly type: "string"; readonly description: string }>
    >
    readonly output: () => string
}

export interface FixtureTask {
    readonly id: string
    readonly tool: FixtureTool
    /** Two turns in one session: the follow-up needs facts the first turn's call returned. */
    /** Every fact must appear; a fact given as a list is met by any one of its spellings. */
    readonly turns: readonly {
        readonly ask: string
        readonly expect: readonly (string | readonly string[])[]
    }[]
}

const pick = <T>(list: readonly T[], at: number): T => list[at % list.length] as T
const PEOPLE = [
    "Ada Okafor",
    "Bram Lindqvist",
    "Chen Wei",
    "Dana Price",
    "Emeka Obi",
    "Farah Haddad",
    "Goran Petrov",
    "Hana Sato",
]
const FILLER =
    "Following up on the thread from last week, with the notes from the call attached and a summary of the open points for whoever picks this up next. "

function mailbox(): string {
    const subjects = [
        "Weekly sync notes",
        "Invoice reminder",
        "Lunch on Friday?",
        "Re: roadmap draft",
        "Newsletter: product updates",
        "Build is green again",
    ]
    const messages = Array.from({ length: 30 }, (_, i) => ({
        id: `msg_${1000 + i}`,
        from: pick(PEOPLE, i * 3),
        subject: pick(subjects, i),
        receivedAt: `2026-10-02T${String(6 + (i % 12)).padStart(2, "0")}:15:00Z`,
        labels: i % 4 === 0 ? ["inbox", "updates"] : ["inbox"],
        needsReply: false,
        body: FILLER.repeat(4),
    }))
    messages[7] = {
        ...messages[7],
        from: "Farah Haddad",
        subject: "Contract renewal needs your signature by Friday",
        needsReply: true,
    } as (typeof messages)[number]
    messages[19] = {
        ...messages[19],
        from: "Goran Petrov",
        subject: "Customer escalation: data export failing for Acme",
        needsReply: true,
    } as (typeof messages)[number]
    return JSON.stringify({ messages })
}

function jira(): string {
    const states = ["To Do", "In Progress", "In Review", "Done"]
    const issues = Array.from({ length: 25 }, (_, i) => ({
        key: `OPS-${400 + i}`,
        summary: `Routine maintenance item ${i}`,
        status: pick(states, i),
        assignee: pick(PEOPLE, i),
        priority: i % 5 === 0 ? "High" : "Medium",
        description: FILLER.repeat(3),
        comments: [{ author: pick(PEOPLE, i + 2), body: FILLER }],
    }))
    issues[11] = {
        ...issues[11],
        status: "Blocked",
        assignee: "Chen Wei",
        summary: "Migrate billing database to the new cluster",
    } as (typeof issues)[number]
    issues[18] = {
        ...issues[18],
        status: "Blocked",
        assignee: "Emeka Obi",
        summary: "Rotate the payment provider API keys",
    } as (typeof issues)[number]
    return JSON.stringify({ issues })
}

function diff(): string {
    const hunks = Array.from({ length: 14 }, (_, i) => ({
        file: `src/module${i}/handler.ts`,
        added: 20 + i,
        removed: 4 + (i % 5),
        patch: `@@ -10,7 +10,${20 + i} @@\n${"+    const value = compute(input) // refactor, behaviour unchanged\n".repeat(12)}`,
    }))
    hunks[5] = {
        ...hunks[5],
        file: "src/auth/session.ts",
        patch: `@@ -40,6 +40,9 @@\n-    if (!token.verified) throw unauthorized()\n+    // TODO re-enable once the SSO provider is fixed\n+    // if (!token.verified) throw unauthorized()\n${"+    log.debug(token)\n".repeat(6)}`,
    } as (typeof hunks)[number]
    hunks[9] = {
        ...hunks[9],
        file: "src/db/migrate.ts",
        patch: `@@ -1,4 +1,6 @@\n+    await db.exec("DROP TABLE audit_log")\n${"+    // cleanup\n".repeat(8)}`,
    } as (typeof hunks)[number]
    return JSON.stringify({ pr: 42, title: "Refactor request handlers", hunks })
}

function crm(): string {
    const stages = ["Prospecting", "Proposal", "Negotiation", "Closed Won"]
    const deals = Array.from({ length: 24 }, (_, i) => ({
        id: `deal_${200 + i}`,
        account: `Account ${String.fromCharCode(65 + i)}`,
        owner: pick(PEOPLE, i + 1),
        amount: 8_000 + (i % 6) * 3_500,
        stage: pick(stages, i),
        closeDate: `2026-${String(11 + (i % 2)).padStart(2, "0")}-15`,
        notes: FILLER.repeat(3),
    }))
    deals[4] = {
        ...deals[4],
        account: "Northwind Traders",
        amount: 84_000,
        closeDate: "2026-10-24",
        owner: "Dana Price",
    } as (typeof deals)[number]
    deals[16] = {
        ...deals[16],
        account: "Globex Corporation",
        amount: 61_500,
        closeDate: "2026-10-30",
        owner: "Bram Lindqvist",
    } as (typeof deals)[number]
    return JSON.stringify({ deals })
}

function incidents(): string {
    const items = Array.from({ length: 20 }, (_, i) => ({
        id: `INC-${700 + i}`,
        service: pick(["api", "web", "worker", "search"], i),
        severity: "SEV3",
        openedAt: `2026-09-${String(10 + i).padStart(2, "0")}T09:00:00Z`,
        resolved: true,
        timeline: Array.from({ length: 5 }, () => FILLER),
    }))
    items[13] = {
        ...items[13],
        severity: "SEV1",
        resolved: false,
        service: "payments",
    } as (typeof items)[number]
    return JSON.stringify({ incidents: items })
}

function calendar(): string {
    const events = Array.from({ length: 22 }, (_, i) => ({
        id: `evt_${i}`,
        title: pick(["1:1", "Standup", "Design review", "Focus time"], i),
        start: `2026-10-0${3 + (i % 5)}T${String(9 + (i % 8)).padStart(2, "0")}:00:00`,
        attendees: [pick(PEOPLE, i), pick(PEOPLE, i + 3)],
        description: FILLER.repeat(2),
    }))
    events[9] = {
        ...events[9],
        title: "Board prep with the CFO",
        start: "2026-10-06T14:00:00",
        attendees: ["Hana Sato", "Ada Okafor"],
    } as (typeof events)[number]
    return JSON.stringify({ events })
}

function invoices(): string {
    const rows = Array.from({ length: 26 }, (_, i) => ({
        number: `INV-${3100 + i}`,
        customer: `Customer ${i}`,
        total: 1_200 + i * 75,
        status: "paid",
        lines: Array.from({ length: 4 }, (_, n) => ({ sku: `SKU-${n}`, description: FILLER })),
    }))
    rows[3] = {
        ...rows[3],
        customer: "Initech",
        status: "overdue",
        total: 18_400,
    } as (typeof rows)[number]
    rows[21] = {
        ...rows[21],
        customer: "Umbrella Ltd",
        status: "overdue",
        total: 9_950,
    } as (typeof rows)[number]
    return JSON.stringify({ invoices: rows })
}

function logs(): string {
    const lines = Array.from(
        { length: 160 },
        (_, i) =>
            `2026-10-02T10:${String(i % 60).padStart(2, "0")}:00Z INFO request served path=/v1/items/${i} status=200 latency=${20 + (i % 9)}ms`,
    )
    lines[88] =
        "2026-10-02T10:28:00Z ERROR worker crashed: out of memory in image-resizer (pid 4412)"
    lines[131] = "2026-10-02T10:11:00Z ERROR upstream timeout calling geocoder after 30000ms"
    return lines.join("\n")
}

function reviews(): string {
    const items = Array.from({ length: 28 }, (_, i) => ({
        id: `rev_${i}`,
        rating: 4 + (i % 2),
        product: pick(["Desk lamp", "Chair", "Monitor arm", "Keyboard tray"], i),
        text: `Works as described. ${FILLER}`,
    }))
    items[6] = {
        ...items[6],
        rating: 1,
        product: "Monitor arm",
        text: "The clamp snapped after two weeks and the arm fell onto my desk.",
    } as (typeof items)[number]
    items[23] = {
        ...items[23],
        rating: 1,
        product: "Monitor arm",
        text: "Clamp cracked under a 6 kg monitor; returned it.",
    } as (typeof items)[number]
    return JSON.stringify({ reviews: items })
}

function hiring(): string {
    const candidates = Array.from({ length: 18 }, (_, i) => ({
        id: `cand_${i}`,
        name: `Candidate ${i}`,
        role: pick(["Backend Engineer", "Designer", "Data Analyst"], i),
        stage: pick(["Applied", "Screen", "Onsite"], i),
        notes: FILLER.repeat(3),
    }))
    candidates[10] = {
        ...candidates[10],
        name: "Ines Moreau",
        role: "Backend Engineer",
        stage: "Offer",
    } as (typeof candidates)[number]
    return JSON.stringify({ candidates })
}

const tool = (
    slug: string,
    summary: string,
    output: () => string,
    parameter = "query",
): FixtureTool => ({
    slug,
    summary,
    parameters: { [parameter]: { type: "string", description: "What to look for; may be empty." } },
    output,
})

export const TASKS: readonly FixtureTask[] = [
    {
        id: "mail-triage",
        tool: tool("mail_list", "Lists the recent messages in the inbox, with bodies.", mailbox),
        turns: [
            {
                ask: "Check my inbox. Which messages need a reply from me?",
                expect: ["Farah", "Goran"],
            },
            { ask: "Which of those has a deadline, and when is it?", expect: ["Friday"] },
        ],
    },
    {
        id: "jira-sweep",
        tool: tool("jira_search", "Searches the OPS project's issues.", jira),
        turns: [
            {
                ask: "Sweep the OPS project. Which issues are blocked?",
                expect: ["OPS-411", "OPS-418"],
            },
            { ask: "Who owns each of those?", expect: ["Chen", "Emeka"] },
        ],
    },
    {
        id: "pr-review",
        tool: tool("pr_diff", "Returns the diff of a pull request.", diff, "pr"),
        turns: [
            { ask: "Review PR 42. Is anything in it risky?", expect: ["session.ts", "audit_log"] },
            {
                ask: "What exactly does the change to the session file do?",
                expect: [["verif", "disable", "comment"]],
            },
        ],
    },
    {
        id: "crm-board",
        tool: tool("crm_deals", "Lists the open deals on the sales board.", crm),
        turns: [
            {
                ask: "Which deals over $50,000 close this month (October 2026)?",
                expect: ["Northwind", "Globex"],
            },
            { ask: "Who owns them?", expect: ["Dana", "Bram"] },
        ],
    },
    {
        id: "incidents",
        tool: tool("incident_list", "Lists recent incidents.", incidents),
        turns: [
            {
                ask: "Is any incident still open, and how severe is it?",
                expect: ["INC-713", "SEV1"],
            },
            { ask: "Which service is it on?", expect: ["payments"] },
        ],
    },
    {
        id: "calendar",
        tool: tool("calendar_events", "Lists calendar events for the coming week.", calendar),
        turns: [
            {
                ask: "When is the board prep meeting next week?",
                expect: [["14:00", "2 pm", "2:00 pm", "2pm"]],
            },
            { ask: "Who is attending it?", expect: ["Hana", "Ada"] },
        ],
    },
    {
        id: "invoices",
        tool: tool("invoice_list", "Lists invoices with their line items.", invoices),
        turns: [
            { ask: "Which invoices are overdue?", expect: ["INV-3103", "INV-3121"] },
            { ask: "What is the total amount overdue?", expect: [["28,350", "28350", "28 350"]] },
        ],
    },
    {
        id: "logs",
        tool: tool("log_tail", "Returns the last application log lines.", logs),
        turns: [
            { ask: "Any errors in the latest logs?", expect: ["out of memory", "geocoder"] },
            { ask: "Which process crashed?", expect: ["4412"] },
        ],
    },
    {
        id: "reviews",
        tool: tool("review_list", "Lists recent product reviews.", reviews),
        turns: [
            { ask: "Summarise the negative reviews.", expect: ["Monitor arm", "clamp"] },
            { ask: "How many one-star reviews were there?", expect: [["two", " 2 "]] },
        ],
    },
    {
        id: "hiring",
        tool: tool("candidate_list", "Lists candidates in the hiring pipeline.", hiring),
        turns: [
            { ask: "Has anyone reached the offer stage?", expect: ["Ines"] },
            { ask: "For which role?", expect: ["Backend"] },
        ],
    },
]

/** A turn passes when its reply contains every required fact, case-insensitively. */
export function passes(task: FixtureTask, turn: number, reply: string): boolean {
    const text = reply.toLowerCase()
    return (task.turns[turn]?.expect ?? []).every((fact) =>
        (typeof fact === "string" ? [fact] : fact).some((spelling) =>
            text.includes(spelling.toLowerCase()),
        ),
    )
}
