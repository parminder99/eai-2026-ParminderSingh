# Checkout integration
## System context
Web, mobile and B2B callers submit orders; an operator inspects failures and authorizes compensation. Provider mocks represent independent external systems. Acceptance is asynchronous, not proof of fulfilment.
```mermaid
flowchart LR
 Web --> Intake
 Mobile --> Intake
 B2B --> Intake
 Intake --> Pricing
 Intake --> Broker
 Broker --> Orchestrator
 Orchestrator --> Providers[Payment, inventory, shipping, notification]
 Broker --> Notifier
 Broker --> Observer
 Operator --> Intake
 Operator --> Observer
 Operator --> Orchestrator
 Orchestrator -. Temporal mode .-> Temporal
 Temporal --> Worker
 Worker --> Providers
```
## Integration architecture
The kit owns declarations. Confirm publishing precedes acceptance and acknowledgements. Rejected messages cross the TTL retry queue and return through their origin routing key. The extra intake.lifecycle queue follows outcomes independently of notification delivery.
```mermaid
flowchart LR
 I[Intake] --> OE[orders.exchange]
 OE --> SQ[saga.queue]
 SQ --> O[Orchestrator]
 SQ --> RE[orders.retry.exchange]
 RE --> SR[saga.retry.queue]
 SR --> RET[orders.return.exchange]
 RET --> SQ
 O --> OUT[orders.outcome]
 OUT --> NQ[notifications.queue]
 OUT --> LC[intake.lifecycle]
 LC --> I
 NQ --> N[Notifier]
 NQ --> RE
 RE --> NR[notifications.retry.queue]
 NR --> RET
 RET --> NQ
 O --> DLX[orders.dlq.exchange]
 N --> DLX
 DLX --> DLQ[orders.dlq]
 DLQ --> I
 I --> RET
 O --> IX[orders.invalid.exchange]
 N --> IX
 IX --> IQ[orders.invalid]
 I -. wire tap .-> TE[trace.events]
 O -. wire tap .-> TE
 N -. wire tap .-> TE
 TE --> TS[trace.store]
 TS --> OBS[Observer]
```
Each service owns its named /data volume; no shared database is used. Hand-rolled mode persists intent and completed steps, but deliberately stops interrupted work for operator review. Temporal mode gives durable scheduling to the engine and executes provider I/O in activities. Neither mode promises exactly-once HTTP delivery; payment/inventory effects depend on provider idempotency keys.
