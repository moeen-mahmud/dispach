/**
 * The model providers `init` offers, as plain data with no imports.
 *
 * Its own module so the web UI's model picker reads the same table the terminal wizard does:
 * `init-flow.ts` imports all of core, which the browser bundle may not carry (`payload.test.ts`).
 */

export type PresetId =
    | "openai"
    | "anthropic"
    | "deepseek"
    | "openrouter"
    | "groq"
    | "nvidia"
    | "ollama"
    | "ollama-cloud"
    | "bedrock"
    | "custom"

export interface Preset {
    readonly id: PresetId
    readonly label: string
    /** Empty for `custom`, which has no defaults to offer. */
    readonly modelId: string
    readonly baseUrl: string
    /** Absent means the manifest omits `apiKeyEnv` entirely — a keyless local endpoint. */
    readonly apiKeyEnv?: string
    /**
     * The transport, when it is not `chat-completions`. `bedrock-converse` takes no `baseUrl` and no
     * key variable: the AWS SDK's default credential chain supplies credentials, and `options.region`
     * says where. The wizard asks for the region instead of a URL.
     */
    readonly api?: "bedrock-converse"
    readonly region?: string
}

/**
 * The same presets the examples' `.env.example` documents, plus the aggregators and Ollama.
 * `custom` exists so an unlisted endpoint is a first-class answer rather than a fight with the
 * nearest preset.
 *
 * **Every one of these is the same transport.** There is no provider branch in
 * `chat-completions.ts` — one POST, one body builder — so a preset is nothing but three strings,
 * and adding one is cheap precisely because it buys no special-casing. What a preset *is* for is
 * that a base URL has to end at the version segment (the runtime appends `/chat/completions`
 * itself, and a URL pasted from a provider's docs with the full path is refused three times over),
 * and that is the sort of thing nobody should have to get right from memory.
 *
 * **`ollama` and `ollama-cloud` are two rows on purpose.** Local Ollama needs no key, and the
 * absent `apiKeyEnv` is what makes the manifest omit the field and the provider send no
 * `authorization` header. Ollama Cloud needs one. With a single row, choosing `ollama` and then
 * editing the base URL to the hosted endpoint produced a **keyless manifest with no route to a
 * key** short of hand-editing `apiKeyEnv` back in — a dead end reached by the obvious move.
 */
export const PRESETS: readonly Preset[] = [
    {
        id: "openai",
        label: "OpenAI",
        modelId: "gpt-5-6-sol",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "anthropic",
        label: "Anthropic (OpenAI-compatible endpoint)",
        modelId: "claude-sonnet-5",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        modelId: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "openrouter",
        label: "OpenRouter (many providers, one key)",
        modelId: "deepseek/deepseek-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "groq",
        label: "Groq",
        modelId: "llama-3.3-70b-versatile",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "nvidia",
        label: "NVIDIA NIM",
        modelId: "meta/llama-3.3-70b-instruct",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        id: "ollama",
        label: "Ollama (local, no key)",
        modelId: "qwen3.5:9b",
        baseUrl: "http://localhost:11434/v1",
    },
    {
        // Two rows rather than one — see the block comment above. The hosted endpoint takes a key
        // and the local one must not, and a single row made the second reachable only by hand.
        id: "ollama-cloud",
        label: "Ollama Cloud (hosted, needs a key)",
        modelId: "gpt-oss:120b",
        baseUrl: "https://ollama.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
    },
    {
        // Not an OpenAI-compatible endpoint, and the one row that is not three strings: Bedrock
        // Converse has no URL and no key variable, so the wizard asks for a region instead and the
        // manifest carries `api` and `options`. Credentials come from the AWS default chain
        // (environment, a profile, the container or instance role), never from the manifest.
        id: "bedrock",
        label: "AWS Bedrock (Converse; credentials from the AWS chain)",
        modelId: "eu.anthropic.claude-sonnet-4-6",
        baseUrl: "",
        api: "bedrock-converse",
        region: "eu-west-1",
    },
    {
        id: "custom",
        label: "any other OpenAI-compatible endpoint",
        modelId: "",
        baseUrl: "",
        apiKeyEnv: "MODEL_API_KEY",
    },
] as const

export function presetById(id: string): Preset | undefined {
    return PRESETS.find((preset) => preset.id === id)
}
