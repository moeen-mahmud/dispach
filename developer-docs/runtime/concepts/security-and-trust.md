# Security and trust

Dispach enforces runtime policy, but process and filesystem containment remain deployment responsibilities.

## Policy and containment

Tool policy decides whether a call is allowed, denied, or requires approval. A sandbox decides where an allowed command can act. Deploy system tools inside the isolation boundary appropriate for the data and users they serve.

The policy engine applies a hardline floor below configurable overrides. Provider tools without a reliable mutation annotation default to mutating, which prevents unsafe parallel execution and retries.

## Untrusted inputs

Tool results declare their trust level. Delimiters help a model distinguish untrusted content, but they are advisory. The write gate is the enforcement point: by default, a turn influenced by untrusted tool output cannot mutate state.

Messages declared as coming from another agent are fenced as data and run with mutating tools blocked. A caller cannot separately mark such a message trusted.

## Secrets and code

Manifests contain environment variable names, never secret values. Provisioning and configuration commands write actual values to protected environment files.

Plugins are trusted in-process code. Their permission declarations describe intent; they are not a security boundary. Review a plugin as code that can access the runtime process.

## API and channel access

Use operator keys with the narrowest useful agent scope. Do not treat an agent ID as authorization. Channel `allowFrom` rules only govern inbound messages; they do not grant permission to send outbound messages to that destination.
