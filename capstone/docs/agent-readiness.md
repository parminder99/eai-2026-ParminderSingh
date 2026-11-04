# Operator assistant boundary
## Tools
All tools use one of these closed input schemas. Read and write permissions are distinct even when their input shapes match.

```json
{"CidInput":{"type":"object","properties":{"correlationId":{"type":"string","format":"uuid"}},"required":["correlationId"],"additionalProperties":false},"EmptyInput":{"type":"object","properties":{},"additionalProperties":false}}
```

order_status, trace, replay and compensate use CidInput; operations uses EmptyInput.
Read tools:
- order_status: JSON schema {type: object, properties: {correlationId: {type: string, format: uuid}}, required: [correlationId], additionalProperties: false}; maps to GET /orders/:cid.
- trace: same input schema; maps to GET /trace/:cid.
- operations: empty object with additionalProperties false; maps to GET /ops/metrics and /sagas/stuck.
Write tools, requiring a named operator decision:
- replay: correlationId UUID, required; maps to POST /dlq/replay. Do not expose an unbounded replay-all shortcut.
- compensate: correlationId UUID, required; maps to POST /sagas/:cid/compensate. Show confirmed steps and provider effects before approval.
## Injection paths
Customer names, XML descriptions, order identifiers, trace detail and provider error bodies can contain attacker-controlled text. A prompt embedded there cannot grant permission to replay, compensate, read secrets or issue shell commands.
## Controls
Separate read-only credentials from write authorization, validate input against closed schemas, retain an audit trail with operator identity and correlation ID, and require explicit approval for each business mutation. The local demo endpoints have no authentication and must be placed behind an authenticated gateway before exposing an assistant. Treat displayed content as quoted data; never interpolate it into commands.
## Not exposed
RabbitMQ credentials, Docker socket, arbitrary URLs, raw publish, queue deletion, internal progress/outcome endpoints, provider admin configuration and filesystem access are not assistant tools. An assistant cannot decide that a provider's ambiguous effect has been undone.
