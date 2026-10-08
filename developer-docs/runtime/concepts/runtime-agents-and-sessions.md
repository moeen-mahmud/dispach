# Runtime, agents, and sessions

Dispach has four different identifiers that an integration should keep separate.

| Concept | Lifetime | Responsibility |
| --- | --- | --- |
| Runtime | Process | Loads agents, owns stores, executes turns, and exposes transports |
| Agent | Configuration and workspace | Defines model, tools, policy, limits, identity, and memory |
| Session | Conversation | Groups messages and history under an agent |
| Turn | One accepted input | Runs the model/tool loop to a terminal result |

One runtime can host many agents. Each agent owns independent configuration and persistent data. An agent can have many sessions, and each session can contain many turns.

The API chooses `api:default` when a sender does not provide a session key. A product with its own conversations should choose stable session keys and store them with its conversation records.

Turns are detached from connections. Losing an SSE stream or closing a browser does not change turn ownership or lifetime; the caller reattaches by agent ID and turn ID.

Agent IDs and session keys are routing identifiers, not authorization. Use [scoped operator keys and deployment isolation](security-and-trust.md) for access control.
