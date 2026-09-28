/**
 * Whether the store's directory is on a network filesystem, which SQLite must not be.
 *
 * SQLite's locking relies on POSIX advisory locks, and NFS (EFS included, which mounts as `nfs4`),
 * SMB and the rest implement them loosely or not at all. The failure is corruption with no error at
 * the time it happens — the silent-degradation shape this runtime refuses everywhere else — so a
 * store on one refuses to open. Workspaces may live on a shared filesystem; only the database may
 * not.
 *
 * Linux only, read from `/proc/self/mountinfo`: that is where a pod runs, and elsewhere there is no
 * stdlib way to ask. Detection can be wrong in both directions (a FUSE mount that is really local,
 * a network mount under an unfamiliar type), so the refusal has an override naming the risk.
 */

import { readFileSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { BRAND } from "../brand.ts"
import { HarnessError } from "../errors.ts"

/** Filesystem types SQLite's locking cannot trust. `nfs4` is what EFS mounts as. */
const NETWORK_FILESYSTEMS = new Set([
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "smbfs",
    "ceph",
    "glusterfs",
    "fuse.glusterfs",
    "fuse.sshfs",
    "lustre",
])

interface Mount {
    readonly point: string
    readonly type: string
}

/** `mountinfo` escapes a space as `\040`; a mount point is compared after unescaping. */
function unescapeOctal(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
    )
}

/**
 * `36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw` — the mount point is the
 * fifth field and the type is the first after the ` - ` separator, since the optional fields
 * between them vary in number.
 */
export function parseMountinfo(text: string): Mount[] {
    const mounts: Mount[] = []
    for (const line of text.split("\n")) {
        const [left, right] = line.split(" - ")
        const point = left?.split(" ")[4]
        const type = right?.split(" ")[0]
        if (point !== undefined && type !== undefined)
            mounts.push({ point: unescapeOctal(point), type })
    }
    return mounts
}

/** The type of the filesystem holding `path`: the longest mount point containing it, the later line on a tie, since that one is mounted over the other. */
export function filesystemOf(path: string, mounts: readonly Mount[]): string | undefined {
    let best: Mount | undefined
    for (const mount of mounts) {
        const contains =
            mount.point === "/" || path === mount.point || path.startsWith(`${mount.point}/`)
        if (contains && (best === undefined || mount.point.length >= best.point.length)) {
            best = mount
        }
    }
    return best?.type
}

/**
 * The network filesystem type `dir` sits on, or undefined when it is local or cannot be told.
 * `readMounts` is the seam a test replaces; the default returns undefined off Linux.
 */
export function networkFilesystemOf(
    dir: string,
    readMounts: () => string | undefined = () => {
        try {
            return readFileSync("/proc/self/mountinfo", "utf8")
        } catch {
            return undefined
        }
    },
): string | undefined {
    const text = readMounts()
    if (text === undefined) return undefined
    let real = dir
    try {
        // A symlinked state directory (the container links it onto the volume) must be
        // judged by where it points.
        real = realpathSync(dir)
    } catch {
        // Unresolvable means not yet created; the lexical path is the best evidence left.
    }
    const type = filesystemOf(real, parseMountinfo(text))
    return type !== undefined && NETWORK_FILESYSTEMS.has(type) ? type : undefined
}

/**
 * The refusal for a store at `path`, or undefined when it may open. One function so the check and
 * its override are asserted together; `openStore` only throws what this returns.
 */
export function networkStoreRefusal(
    path: string,
    env: Record<string, string | undefined>,
    readMounts?: () => string | undefined,
): HarnessError | undefined {
    const network = networkFilesystemOf(dirname(path), readMounts)
    const override = `${BRAND.envPrefix}ALLOW_NETWORK_STORE`
    if (network === undefined || env[override] === "1") return undefined
    return new HarnessError({
        code: "store_on_network_filesystem",
        message: `The session database ${path} is on a ${network} filesystem, which SQLite's locking cannot trust.`,
        hint: `Put the store on a local block volume (EBS, a hostPath, a local PV) and keep only workspaces on the shared filesystem. EFS mounts as nfs4 and corrupts SQLite silently under concurrent access. If detection is wrong and this filesystem is really local, set ${override}=1.`,
        field: "store",
    })
}
