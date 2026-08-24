import { beforeEach, describe, expect, test } from "bun:test"
import { LEAVE_ALT_SCREEN, RESET_STYLE } from "#lib/const"
import {
    finish,
    flushOutput,
    markAltScreen,
    markMouse,
    markTerminalDirty,
    onExit,
    resetForTests,
    restoreTerminal,
} from "#lib/exit"
import { DISABLE_MOUSE } from "#lib/mouse"
import type { TerminalHandles } from "#lib/schema"

interface Fake extends TerminalHandles {
    readonly written: string[]
    readonly rawModeCalls: boolean[]
}

function fakeTerminal(options: { outIsTTY: boolean; inIsTTY: boolean }): Fake {
    const written: string[] = []
    const rawModeCalls: boolean[] = []
    return {
        written,
        rawModeCalls,
        out: {
            isTTY: options.outIsTTY,
            write(chunk: string) {
                written.push(chunk)
                return true
            },
        },
        in: {
            isTTY: options.inIsTTY,
            setRawMode(mode: boolean) {
                rawModeCalls.push(mode)
            },
        },
    }
}

beforeEach(() => {
    resetForTests()
})

describe("restoreTerminal", () => {
    test("shows the cursor and resets styling at a terminal", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain("[?25h")
        expect(terminal.written.join("")).toContain("[0m")
    })

    test("takes stdin out of raw mode — the state that breaks the shell", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.rawModeCalls).toEqual([false])
    })

    test("writes no escape sequences when stdout is not a terminal", () => {
        // Emitting a cursor sequence into a pipe would corrupt the very output the plain mode
        // exists to keep clean.
        const terminal = fakeTerminal({ outIsTTY: false, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written).toEqual([])
    })

    test("leaves raw mode alone when stdin is not a terminal", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: false })
        restoreTerminal(terminal)
        expect(terminal.rawModeCalls).toEqual([])
    })

    test("does nothing when the terminal was never touched", () => {
        // The plain path never hides the cursor or sets raw mode, so there is nothing to undo — and
        // emitting a reset anyway would put escape sequences at the end of output that is otherwise
        // pure text, breaking the property plain mode exists for.
        resetForTests({ dirty: false })
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written).toEqual([])
        expect(terminal.rawModeCalls).toEqual([])
    })

    test("runs once the rich path has declared the terminal dirty", () => {
        resetForTests({ dirty: false })
        markTerminalDirty()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain("[?25h")
    })

    test("is idempotent — it runs explicitly and again from the exit hook", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        restoreTerminal(terminal)
        restoreTerminal(terminal)
        expect(terminal.written).toHaveLength(1)
        expect(terminal.rawModeCalls).toEqual([false])
    })
})

describe("the alternate screen", () => {
    test("is swapped back out when it was entered", () => {
        resetForTests({ dirty: false })
        markAltScreen()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain(LEAVE_ALT_SCREEN)
    })

    test("is left alone when it was never entered", () => {
        // A `1049l` sent to a terminal that never swapped in *clears the screen the output was just
        // written to*. So a wizard or a chat session — dirty, but never full-screen — must not emit it.
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        markTerminalDirty()
        restoreTerminal(terminal)
        expect(terminal.written.join("")).not.toContain(LEAVE_ALT_SCREEN)
    })

    test("the style reset lands before the swap, not after", () => {
        // A reset applies to whichever buffer is current when it arrives. After the swap it would
        // reset the buffer being discarded and leave the app's last colour on the shell's screen.
        resetForTests({ dirty: false })
        markAltScreen()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        const output = terminal.written.join("")
        expect(output.indexOf(RESET_STYLE)).toBeLessThan(output.indexOf(LEAVE_ALT_SCREEN))
    })

    test("a pipe gets neither — plain output stays byte-identical", () => {
        resetForTests({ dirty: false })
        markAltScreen()
        const piped = fakeTerminal({ outIsTTY: false, inIsTTY: false })
        restoreTerminal(piped)
        expect(piped.written).toEqual([])
    })
})

describe("teardowns", () => {
    test("run in reverse registration order", () => {
        const order: string[] = []
        onExit(() => void order.push("runtime"))
        onExit(() => void order.push("ink"))
        restoreTerminal(fakeTerminal({ outIsTTY: false, inIsTTY: false }))
        return finish(0).then(() => {
            // Ink unmounts before the runtime it was rendering closes.
            expect(order).toEqual(["ink", "runtime"])
        })
    })

    test("an async teardown is awaited", async () => {
        const order: string[] = []
        onExit(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push("slow")
        })
        onExit(() => void order.push("fast"))
        await finish(0)
        expect(order).toEqual(["fast", "slow"])
    })

    test("a throwing teardown does not stop the rest", async () => {
        const order: string[] = []
        onExit(() => void order.push("first"))
        onExit(() => {
            throw new Error("cleanup blew up")
        })
        onExit(() => void order.push("third"))
        await finish(0)
        // The terminal restore is itself a teardown-adjacent step; one bad hook must not strand it.
        expect(order).toEqual(["third", "first"])
    })

    test("each teardown runs once, even if finish is reached twice", async () => {
        let count = 0
        onExit(() => {
            count += 1
        })
        await finish(0)
        await finish(0)
        expect(count).toBe(1)
    })
})

describe("exit codes", () => {
    test("finish sets the code rather than exiting, so piped output can drain", async () => {
        const previous = process.exitCode
        try {
            await finish(0)
            expect(process.exitCode).toBe(0)
        } finally {
            process.exitCode = previous
        }
    })

    test("a non-zero code survives the trip through finish", async () => {
        const previous = process.exitCode
        try {
            await finish(3)
            expect(process.exitCode).toBe(3)
        } finally {
            // Restore, or this test would fail the suite it belongs to.
            process.exitCode = previous
        }
    })
})

describe("mouse tracking", () => {
    test("is switched off when the session asked for it", () => {
        // Left on, the shell that gets the terminal back emits a report on every click and scroll into a
        // prompt that has no idea what they are. That failure outlives the process, which is why the
        // teardown runs from the exit hook rather than only from a clean unmount.
        resetForTests({ dirty: false })
        markMouse()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain(DISABLE_MOUSE)
    })

    test("is left alone by a surface that never asked", () => {
        // Only the chat claims mouse reports. A surface that disabled tracking it never enabled would be
        // sending a sequence about a state it knows nothing about.
        resetForTests({ dirty: false })
        markAltScreen()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).not.toContain(DISABLE_MOUSE)
    })

    test("switches off before the buffer swap", () => {
        // Same reason as the style reset: the request was made against this buffer.
        resetForTests({ dirty: false })
        markAltScreen()
        markMouse()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        const output = terminal.written.join("")
        expect(output.indexOf(DISABLE_MOUSE)).toBeLessThan(output.indexOf(LEAVE_ALT_SCREEN))
    })

    test("a pipe gets nothing — plain output stays byte-identical", () => {
        resetForTests({ dirty: false })
        markMouse()
        const terminal = fakeTerminal({ outIsTTY: false, inIsTTY: false })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toBe("")
    })
})

describe("draining the output before the process leaves", () => {
    /**
     * A stream that queues its write callbacks, so a test can decide when the bytes have "gone out".
     *
     * `writableNeedDrain` is deliberately absent, which is what makes this a guard rather than a
     * restatement: the old implementation looked only at that flag, so against this stream it returned
     * immediately with a write still pending. Revert the fix and `settled` is true before `release()`.
     */
    function pendingStream() {
        const callbacks: (() => void)[] = []
        return {
            stream: {
                write(_chunk: string, callback: () => void) {
                    callbacks.push(callback)
                    return false
                },
            } as unknown as Parameters<typeof flushOutput>[0],
            pending: () => callbacks.length,
            release: () => {
                for (const callback of callbacks.splice(0)) callback()
            },
        }
    }

    test("the wait ends when the stream reports the write through, and not before", async () => {
        // Measured against a real pipe with a sleeping reader: 10 MB survives this way, where an
        // immediate `process.exit` delivered 65,536 bytes — one pipe buffer. This is that property in
        // a form a unit test can hold: the promise is the stream's callback and nothing else.
        const fake = pendingStream()
        let settled = false
        const waiting = flushOutput(fake.stream).then(() => {
            settled = true
        })
        // A turn of the microtask queue is all a wrongly-implemented drain needs to resolve on.
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(fake.pending()).toBe(1)
        fake.release()
        await waiting
        expect(settled).toBe(true)
    })

    test("an ended stream is not waited on, and is not written to either", async () => {
        // The check is up front rather than in a catch: a throw here lands inside the one function whose
        // whole job is to run when the process is already ending.
        let writes = 0
        const ended = {
            writableEnded: true,
            write: () => {
                writes += 1
                return true
            },
        } as unknown as Parameters<typeof flushOutput>[0]
        await flushOutput(ended)
        expect(writes).toBe(0)
    })
})
