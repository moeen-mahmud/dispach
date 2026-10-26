# Security and trust

Dispach enforces runtime policy, but process and filesystem containment remain deployment responsibilities.

## Policy and containment

Tool policy decides whether a call is allowed, denied, or requires approval. A sandbox decides where an allowed command can act. Deploy system tools inside the isolation boundary appropriate for the data and users they serve.

The policy engine applies a hardline floor below configurable overrides. Provider tools without a reliable mutation annotation default to mutating, which prevents unsafe parallel execution and retries.

## What an agent may change about itself

An agent can edit its own settings with `config_set`: pinning a tool or adding an allow rule is what people ask it for. A separate floor refuses the edits that set its limits rather than its abilities, whatever the policy says: where it may write, which files it may read, who may message it, where its providers send credentials, and the policy's deny rules. The full list is in the manifest spec.

The floor is measured in a preprint, Hossain and Mahmud, 2026, [*What May an Agent Change About Itself? A Containment Floor for Self-Configuring Agent Runtimes*](https://arxiv.org/abs/2610.06274): with it in place, 0 of 167 protected writes were saved, though the models attempted one in 65 of those cases.

## Untrusted inputs

Tool results declare their trust level. Delimiters help a model distinguish untrusted content, but they are advisory. The write gate is the enforcement point: by default, a turn influenced by untrusted tool output cannot mutate state.

Messages declared as coming from another agent are fenced as data and run with mutating tools blocked. A caller cannot separately mark such a message trusted.

## Secrets and code

Manifests contain environment variable names, never secret values. Provisioning and configuration commands write actual values to protected environment files.

Plugins are trusted in-process code. Their permission declarations describe intent; they are not a security boundary. Review a plugin as code that can access the runtime process.

## API and channel access

Use operator keys with the narrowest useful agent scope. Do not treat an agent ID as authorization. Channel `allowFrom` rules only govern inbound messages; they do not grant permission to send outbound messages to that destination.
