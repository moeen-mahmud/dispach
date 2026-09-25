/**
 * Where silos run. The control plane is cloud-agnostic, and this interface is the whole of the
 * agnosticism: everything above it knows a silo by its subject and its base URL, nothing more.
 *
 * v0 has one driver, Docker, and it is also the AWS path: many silos on an EC2 host, `docker pause`
 * as suspend (decision 14.12). A paused container keeps its memory and fires a due schedule once on
 * unpause, measured; a driver that *stops* instead would need the runtime to start it before
 * `nextWakeAt`, because a started process skips an occurrence it slept through.
 */

import { execFile, spawn } from "node:child_process"
import type { Readable } from "node:stream"
import { BRAND } from "./brand.ts"

export interface PlacedSilo {
    readonly name: string
    readonly baseUrl: string
}

export interface Placer {
    /** Start a silo whose runtime authenticates `token`. Returns once the container exists. */
    create(subject: string, token: string): Promise<PlacedSilo>
    /**
     * Replace the container and keep the volume: the current image, the current environment. How an
     * image upgrade or a changed `SILO_ENV` reaches a silo that already exists.
     */
    recreate(subject: string, token: string): Promise<PlacedSilo>
    pause(name: string): Promise<void>
    wake(name: string): Promise<void>
    /** Remove the silo **and its data**. Irreversible: the volume holds the silo's only store. */
    remove(name: string): Promise<void>
    /** Where it answers now. A daemon restart can move a published port. */
    address(name: string): Promise<string>
    /** The silo's data as a tar.gz stream, templates excluded. Call on a paused silo. */
    exportData(name: string): Promise<Readable>
    /** Replace the silo's data with a tar.gz from `exportData`. Leaves it stopped. */
    importData(name: string, archive: Readable): Promise<void>
    /** Start a stopped silo. */
    start(name: string): Promise<void>
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

/**
 * `SILO_ENV`: the names of variables every silo gets, read from this process's environment.
 *
 * Names, never values, in configuration — the runtime's rule for secrets, kept here. Refused at boot
 * rather than at the first create: a named variable that is unset would place silos missing it, and
 * each would fail later in a way that points at the silo rather than at this setting.
 */
export function resolveSiloEnv(
    list: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    setting: string,
): Record<string, string> {
    const names = (list ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    const out: Record<string, string> = {}
    for (const name of names) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new ControlError({
                code: "silo_env_invalid",
                message: `${setting} names "${name}", which is not a variable name.`,
                hint: `List names only, comma-separated: ${setting}=${BRAND.runtime.webhookAllowEnv},MODEL_BASE_URL. Values come from this process's own environment.`,
            })
        }
        if (name === BRAND.runtime.tokenEnv) {
            throw new ControlError({
                code: "silo_env_invalid",
                message: `${setting} names ${name}, which the control plane sets itself.`,
                hint: "Each silo gets its own random token; a shared one would let any silo's operator credential open every other silo. Remove it from the list.",
            })
        }
        const value = env[name]
        if (value === undefined || value === "") {
            throw new ControlError({
                code: "silo_env_unset",
                message: `${setting} names ${name}, and it is not set in this process's environment.`,
                hint: `Export ${name} here, or remove it from ${setting}. Silos are not placed without it, so none starts missing it.`,
            })
        }
        out[name] = value
    }
    return out
}

export interface DockerOptions {
    readonly image?: string
    /**
     * A Docker network to attach silos to. Set when the control plane itself runs in a container on
     * that network: silos are then reached by container name and publish no port. Unset, each silo
     * publishes its port on 127.0.0.1 only — never on a public interface.
     */
    readonly network?: string
    /**
     * A directory of agent templates, mounted read-only into every silo. A path **on the Docker
     * host**: the daemon resolves bind mounts, so this holds even when the control plane runs in a
     * container of its own.
     */
    readonly templatesDir?: string
    /** Variables every silo gets, by value. Handed to `docker run` through its environment. */
    readonly siloEnv?: Readonly<Record<string, string>>
    readonly docker?: string
}

export class DockerPlacer implements Placer {
    readonly #image: string
    readonly #network: string | undefined
    readonly #templates: string | undefined
    readonly #siloEnv: Readonly<Record<string, string>>
    readonly #docker: string

    constructor(options: DockerOptions = {}) {
        this.#image = options.image ?? BRAND.runtime.image
        this.#network = options.network
        this.#templates = options.templatesDir
        this.#siloEnv = options.siloEnv ?? {}
        this.#docker = options.docker ?? "docker"
    }

    async create(subject: string, token: string): Promise<PlacedSilo> {
        const name = `${BRAND.siloPrefix}${subject}`
        await this.#runSilo(name, subject, token)
        return { name, baseUrl: await this.address(name) }
    }

    async recreate(subject: string, token: string): Promise<PlacedSilo> {
        const name = `${BRAND.siloPrefix}${subject}`
        // The container only; the volume, and everything in the silo, stays. Stopped first so the
        // runtime exits on SIGTERM: it releases its leases and flushes the delivery in flight, where
        // `rm --force` alone is a SIGKILL that does neither.
        await this.#stop(name)
        await this.#run(
            ["rm", "--force", name],
            "silo_recreate_failed",
            `Could not replace ${name}.`,
        )
        await this.#runSilo(name, subject, token)
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
            // Exited: a crash, or left stopped by a restore. Start it again.
            await this.start(name)
        }
    }

    async start(name: string): Promise<void> {
        await this.#run(["start", name], "silo_wake_failed", `Could not start ${name}.`)
    }

    async remove(name: string): Promise<void> {
        await this.#stop(name)
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
                hint: "The container was changed outside this control plane. POST /v1/silos/<subject>/recreate puts it back, keeping its data.",
            })
        }
        return `http://${binding.trim()}`
    }

    async exportData(name: string): Promise<Readable> {
        // A helper container over the volume alone, so the templates bind mount — the operator's
        // files, not the user's — is not in the archive. Taken while the silo is paused: the freezer
        // holds every write, so the copy is crash-consistent, which SQLite recovers from by design.
        const child = spawn(
            this.#docker,
            [
                "run",
                "--rm",
                "--volume",
                `${name}:${BRAND.runtime.home}:ro`,
                "--entrypoint",
                "tar",
                this.#image,
                "--create",
                "--gzip",
                "--file",
                "-",
                "--directory",
                this.#homeParent(),
                `--exclude=${this.#homeName()}/${this.#templatesRelative()}`,
                this.#homeName(),
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        )
        let stderr = ""
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on("close", (code) => {
            if (code !== 0) {
                child.stdout.destroy(
                    new ControlError({
                        code: "silo_backup_failed",
                        message: `Archiving ${name}'s data failed: ${stderr.trim()}`,
                        hint: "The archive is incomplete; do not keep it. Check the volume exists and the daemon is healthy, then retry.",
                    }),
                )
            }
        })
        return child.stdout
    }

    async importData(name: string, archive: Readable): Promise<void> {
        await this.#stop(name)
        const home = BRAND.runtime.home
        const user = BRAND.runtime.user
        // Emptied first, so the result is the archive and nothing else: a restore that merged into
        // what was there would keep agents the backup never had. Extracted as root, which keeps the
        // owners the archive recorded, then handed back to the runtime's user regardless.
        const script = `find ${home} -mindepth 1 -delete && tar --extract --gzip --file - --directory ${this.#homeParent()} && chown -R ${user}:${user} ${home}`
        await new Promise<void>((resolve, reject) => {
            const child = spawn(
                this.#docker,
                [
                    "run",
                    "--rm",
                    "--interactive",
                    "--user",
                    "root",
                    "--volume",
                    `${name}:${home}`,
                    "--entrypoint",
                    "sh",
                    this.#image,
                    "-c",
                    script,
                ],
                { stdio: ["pipe", "ignore", "pipe"] },
            )
            let stderr = ""
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString()
            })
            archive.on("error", (error) => {
                child.kill()
                reject(
                    new ControlError({
                        code: "silo_restore_failed",
                        message: `The uploaded archive could not be read: ${error.message}.`,
                        hint: "Send the tar.gz exactly as GET /v1/silos/<subject>/backup produced it. The silo was left stopped; restore again or delete it.",
                        status: 400,
                    }),
                )
            })
            child.on("close", (code) => {
                if (code === 0) resolve()
                else
                    reject(
                        new ControlError({
                            code: "silo_restore_failed",
                            message: `Extracting the archive failed: ${stderr.trim()}`,
                            hint: "The archive is not one this control plane produced, or it is truncated. The silo was left stopped and empty; restore again or delete it.",
                            status: 400,
                        }),
                    )
            })
            archive.pipe(child.stdin)
        })
    }

    #homeParent(): string {
        return BRAND.runtime.home.slice(0, BRAND.runtime.home.lastIndexOf("/")) || "/"
    }

    #homeName(): string {
        return BRAND.runtime.home.slice(BRAND.runtime.home.lastIndexOf("/") + 1)
    }

    #templatesRelative(): string {
        return BRAND.runtime.templates.slice(BRAND.runtime.home.length + 1)
    }

    async #runSilo(name: string, subject: string, token: string): Promise<void> {
        // Every value goes through the child's environment and `--env NAME`, never argv: a
        // `docker run` command line is readable in `ps` by every local user while it runs.
        const env = { ...this.#siloEnv, [BRAND.runtime.tokenEnv]: token }
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
            ...Object.keys(env).flatMap((key) => ["--env", key]),
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
        await this.#run(args, "silo_create_failed", `Could not start a silo for "${subject}".`, env)
    }

    /** SIGTERM, then SIGKILL after 30 s. A paused container is unpaused first: it cannot take a signal. */
    async #stop(name: string): Promise<void> {
        if ((await this.#state(name).catch(() => "missing")) === "paused") {
            await this.#run(["unpause", name], "silo_stop_failed", `Could not unpause ${name}.`)
        }
        await this.#run(
            ["stop", "--time", "30", name],
            "silo_stop_failed",
            `Could not stop ${name}.`,
        )
    }

    async #state(name: string): Promise<string> {
        const out = await this.#run(
            ["inspect", "--format", "{{.State.Status}}", name],
            "silo_missing",
            `No container ${name}.`,
        )
        return out.trim()
    }

    #run(
        args: readonly string[],
        code: string,
        message: string,
        env: Readonly<Record<string, string>> = {},
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                this.#docker,
                args,
                { timeout: 120_000, env: { ...process.env, ...env } },
                (error, stdout, stderr) => {
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
                },
            )
        })
    }
}
