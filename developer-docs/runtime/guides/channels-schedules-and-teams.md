# Channels, schedules, and teams

Channels and schedules are inbound transports into the same turn lifecycle used by HTTP.

## Channels

Telegram is a first-party channel package. Other channels can ship as plugins. Channel connections start after runtime readiness so an unavailable network cannot block local boot.

Use `allowFrom` to restrict inbound senders. It has no effect on outbound permission: a bot still needs a valid destination and provider permission to deliver there.

```bash
dispach config allow milo @ada
dispach channels list milo
```

## Schedules

Schedules support cron, interval, and one-shot triggers. Named time zones and daylight-saving transitions are handled by the scheduler. Manifest schedules are declarative; reconciliation restores their configured state after restart.

Validate a schedule through the CLI or configuration API before relying on it. The same parser runs for validation and execution, so an invalid cron expression cannot pass one path and fail the other.

## Teams and handoffs

Supervisor agents can delegate to other agents through typed handoffs. Treat the receiving agent as another trust boundary: peer input is fenced as data and mutating tools are blocked for that turn. Persist handoff and turn identifiers when a product needs to show work across agents.

For an embeddable product, prefer HTTP and the typed client as the ownership boundary. A channel adapter should remain a transport, not the place where agent state or business authorization lives.
