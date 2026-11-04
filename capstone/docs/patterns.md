# Integration patterns

| Pattern | Problem | Where | Why |
|---|---|---|---|
| Normalizer | Three source formats | [intake/server.mjs:82](../intake/server.mjs#L82) | A single validated canonical contract isolates downstream consumers. |
| Content Enricher | Prices must be trusted | [intake/server.mjs:193](../intake/server.mjs#L193) | Pricing supplies unit prices; unknown items reject the whole order. |
| Idempotent Receiver | HTTP retries | [intake/server.mjs:19](../intake/server.mjs#L19) | Persist raw-body hashes and replay the same response. |
| Process Manager | Distributed checkout | [orchestrator/server.mjs:223](../orchestrator/server.mjs#L223) | Persist ordered steps and coordinate reverse compensation. |
| Compensating Transaction | Partial success | [orchestrator/server.mjs:112](../orchestrator/server.mjs#L112) | Undo only confirmed successful reservations and payments. |
| Dead Letter Channel | Bounded retries | [shared/core.mjs:225](../shared/core.mjs#L225) | Park poison/transient failures after the configured budget. |
| Invalid Message Channel | Malformed events | [shared/core.mjs:211](../shared/core.mjs#L211) | Preserve raw bytes without executing business steps. |
| Wire Tap | Cross-service diagnosis | [shared/core.mjs:139](../shared/core.mjs#L139) | Trace publishing is best effort and does not block business processing. |
| Message Deduplication | Business duplicates | [orchestrator/server.mjs:19](../orchestrator/server.mjs#L19) | A new correlation ID cannot buy the same order twice. |
| Polling Consumer | Operator replay | [intake/server.mjs:393](../intake/server.mjs#L393) | Confirm replay before acknowledging the parked message. |
