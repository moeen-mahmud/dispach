/**
 * Every name this repository shows the world, in one place — the same rule the runtime has: a
 * rename is one commit. The runtime's own names (`DISPACH_API_TOKEN`, the image) are *its* brand,
 * copied here because this repository calls it over `/v1` like any other client and imports nothing.
 */

export const BRAND = {
    name: "Dispach Control",
    slug: "dispach-control",
    /** Every environment variable this process reads. */
    envPrefix: "DISPACH_CONTROL_",
    /** Container and volume names: `<prefix><subject>`. */
    siloPrefix: "dispach-silo-",
    /** A Docker label, so `docker ps --filter` finds exactly what this control plane placed. */
    label: "dispach-control.subject",
    runtime: {
        image: "ghcr.io/moeen-mahmud/dispach:latest",
        apiVersion: "dispach/v1",
        tokenEnv: "DISPACH_API_TOKEN",
        port: 7420,
        home: "/home/dispach",
        templates: "/home/dispach/.dispach/templates",
    },
} as const
