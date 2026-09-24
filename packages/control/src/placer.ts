/**
 * Where silos run. The control plane is cloud-agnostic, and this interface is the whole of the
 * agnosticism: everything above it knows a silo by its subject and its base URL, nothing more.
 *
 * v0 has one driver, Docker, and it is also the AWS path: many silos on an EC2 host, `docker pause`
 * as suspend (decision 14.12 in the runtime's repo). A paused container keeps its memory and fires a
 * due schedule once on unpause, measured; a driver that *stops* instead would need the runtime to
 * start it before `nextWakeAt`, because a started process skips an occurrence it slept through.
 */

import { execFile } from "node:child_process"
import { BRAND } from "./brand.ts"

export interface PlacedSilo {
    readonly name: string
    readonly baseUrl: string
}

export interface Placer {
    /** Start a silo whose runtime authenticates `token`. Returns once the container exists. */
    create(subject: string, token: string): Promise<PlacedSilo>
    pause(name: string): Promise<void>
    wake(name: string): Promise<void>
    /** Remove the silo **and its data**. Irreversible: the volume holds the silo's only store. */
    remove(name: string): Promise<void>
    /** Where it answers now. A daemon restart can move a published port. */
    address(name: string): Promise<string>
}

/** A thrown refusal that says what to do about it — the runtime's rule, kept here too. */
export class ControlError extends Error {
    readonly code: string
    readonly hint: string
    readonly status: number

    constructor(init: { code: string; message: string; hint: string; status?: number }) {
        super(init.message)
        this.code = init.code
        this.hint = init.hint
        this.status = init.status ?? 500
    }
}

export interface DockerOptions {
    readonly image?: string
    /**
     * A Docker network to attach silos to. Set when the control plane itself runs in a container on
     * that network: silos are then reached by container name and publish no port. Unset, each silo
     * publishes its port on 127.0.0.1 only — never on a public interface.
     */
    readonly network?: string
    /** A host directory of agent templates, mounted read-only into every silo. */
    readonly templatesDir?: string
    readonly docker?: string
}

export class DockerPlacer implements Placer {
    readonly #image: string
    readonly #network: string | undefined
    readonly #templates: string | undefined
    readonly #docker: string

    constructor(options: DockerOptions = {}) {
        this.#image = options.image ?? BRAND.runtime.image
        this.#network = options.network
        this.#templates = options.templatesDir
        this.#docker = options.docker ?? "docker"
    }

    async create(subject: string, token: string): Promise<PlacedSilo> {
        const name = `${BRAND.siloPrefix}${subject}`
        const args = [
            "run",
            "--detach",
            "--name",
            name,
            "--label",
            `${BRAND.label}=${subject}`,
            // A host reboot brings silos back; the control plane re-pauses the idle ones.
            "--restart",
            "unless-stopped",
            // The token is visible to whoever can run `docker inspect` on this host — the operator,
            // who already holds every silo's volume. Not a secret *from* them.
            "--env",
            `${BRAND.runtime.tokenEnv}=${token}`,
            "--volume",
            `${name}:${BRAND.runtime.home}`,
            ...(this.#templates === undefined
                ? []
                : ["--volume", `${this.#templates}:${BRAND.runtime.templates}:ro`]),
            ...(this.#network === undefined
                ? ["--publish", `127.0.0.1::${BRAND.runtime.port}`]
                : ["--network", this.#network]),
            this.#image,
        ]
        await this.#run(args, "silo_create_failed", `Could not start a silo for "${subject}".`)
        return { name, baseUrl: await this.address(name) }
    }

    async pause(name: string): Promise<void> {
        await this.#run(["pause", name], "silo_pause_failed", `Could not pause ${name}.`)
    }

    async wake(name: string): Promise<void> {
        const state = await this.#state(name)
        if (state === "paused") {
            await this.#run(["unpause", name], "silo_wake_failed", `Could not unpause ${name}.`)
        } else if (state !== "running") {
            // Exited: a crash or a host reboot with the restart policy overridden. Start it again.
            await this.#run(["start", name], "silo_wake_failed", `Could not start ${name}.`)
        }
    }

    async remove(name: string): Promise<void> {
        await this.#run(["rm", "--force", name], "silo_remove_failed", `Could not remove ${name}.`)
        await this.#run(
            ["volume", "rm", name],
            "silo_remove_failed",
            `Removed ${name} but not its volume.`,
        )
    }

    async address(name: string): Promise<string> {
        if (this.#network !== undefined) return `http://${name}:${BRAND.runtime.port}`
        const out = await this.#run(
            ["port", name, String(BRAND.runtime.port)],
            "silo_address_unknown",
            `${name} has no published port.`,
        )
        // "127.0.0.1:55001", one line per binding; only loopback is ever published.
        const binding = out.split("\n").find((line) => line.startsWith("127.0.0.1:"))
        if (binding === undefined) {
            throw new ControlError({
                code: "silo_address_unknown",
                message: `${name} publishes no loopback port: ${out.trim() || "(nothing)"}.`,
                hint: "The container was changed outside this control plane. Delete the silo and create it again, or re-publish 7420 on 127.0.0.1.",
            })
        }
        return `http://${binding.trim()}`
    }

    async #state(name: string): Promise<string> {
        const out = await this.#run(
            ["inspect", "--format", "{{.State.Status}}", name],
            "silo_missing",
            `No container ${name}.`,
        )
        return out.trim()
    }

    #run(args: readonly string[], code: string, message: string): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(this.#docker, args, { timeout: 60_000 }, (error, stdout, stderr) => {
                if (error === null) {
                    resolve(stdout)
                    return
                }
                reject(
                    new ControlError({
                        code,
                        message: `${message} docker said: ${(stderr || error.message).trim()}`,
                        hint: "Check that the Docker daemon is running and this process may use it (the docker group, or the socket mounted into this container), and that the image is pullable.",
                    }),
                )
            })
        })
    }
}
