# @dispach/model-bedrock

AWS Bedrock's Converse API as a model transport.

```yaml
model:
  main:
    id: eu.anthropic.claude-sonnet-4-6-v1:0   # a model id, a cross-region profile, or an ARN
    api: bedrock-converse
    options:
      region: eu-west-1
      # profile: velacrew                     # a named AWS profile, optionally
    fallbacks:
      - id: eu.anthropic.claude-haiku-4-5-v1:0
        api: bedrock-converse
        options: { region: eu-west-1 }
```

The CLI and the container image supply this transport to every agent, so no `plugins:` entry is
needed. An embedder calling the runtime directly passes `bedrockTransport()` in
`RuntimeOptions.modelTransports`.

## Credentials

The AWS default chain, and nothing in the manifest:

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` in the process environment;
- a container-credentials endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI` with
  `AWS_CONTAINER_AUTHORIZATION_TOKEN` or `…_TOKEN_FILE`), which is how an embedder vends
  per-silo credentials;
- EKS Pod Identity;
- the instance role (IMDS).

The SDK refreshes them, so a rotated credential needs no restart. A refused credential
(`AccessDeniedException`) ends the turn with `model_access_denied`, status 403. It is never retried
and never falls back, so revoking a credential works as a budget stop.

## What it does with the prompt

- The leading system messages become Converse's `system[]`. A later system message (the reminder,
  retrieved memory) is sent as user text.
- A `cachePoint` goes after each cache breakpoint the runtime marks, for Claude and Nova models.
  `capabilities.promptCache: none` turns it off.
- Signed thinking is replayed as `reasoningContent` with tool results. `reasoningEffort` becomes an
  extended-thinking budget (minimal 1,024 to high 16,384 tokens). Temperature is dropped beside it,
  and `maxTokens` is lifted above it.
- Usage reports the whole prompt (input + cache read + cache write), with cache reads as
  `cachedPromptTokens` and writes as `cacheWriteTokens`.

## Retries

Throttling, service-unavailable, internal and model-not-ready errors are retried with the runtime's
policy, before any output, and each retry is a `model.retry` event. The SDK's own retries are off.

## Weight

`@aws-sdk/client-bedrock-runtime` is imported on an agent's first model call, never at boot.
`packages/cli/test/bundle.test.ts` fails if it reaches the CLI's startup graph. It adds about
2.2 MB to the unpacked package.
