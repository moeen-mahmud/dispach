/**
 * Which IP addresses are off the public internet: re-exported from core, where it now lives.
 *
 * Moved so outbound webhooks (core) can share it, since core may import nothing from a sibling
 * package. Re-exported here so every import of this file, `web_fetch`'s guard and its tests
 * included, is unchanged.
 */

export {
    type AddressKind,
    type AddressVerdict,
    classifyAddress,
    classifyIPv4,
    classifyIPv6,
    parseIPv4,
    parseIPv6,
} from "@dispach/core"
