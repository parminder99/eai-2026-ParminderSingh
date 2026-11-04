# Checkout integration capstone

Event-driven checkout for web JSON, mobile JSON and Windows-1257 B2B XML, with canonical validation, pricing enrichment, a durable saga journal, compensation, dead-letter replay and causal tracing.

## Run in PowerShell

Install/start Docker Desktop in Linux container mode. Docker Compose 2.20+ is required. Run these commands from this repository's `capstone` directory:

```powershell
docker compose up -d --build --wait
Invoke-RestMethod http://localhost:8800/health
Invoke-RestMethod http://localhost:8801/ops/metrics
```

The default is `SAGA_ENGINE=handrolled`. The kit supplies RabbitMQ, pricing and provider mocks. First build needs internet access for images and npm packages. Give Docker at least 4 GB RAM. No local Node installation is required to run the stack.

Submit a fresh order (use a new orderId for each new purchase):

```powershell
$order = Get-Content tests/fixtures/web-order.json -Raw | ConvertFrom-Json
$order.orderId = 'WEB-' + [guid]::NewGuid().ToString('N')
$reply = Invoke-RestMethod http://localhost:8800/orders -Method Post -ContentType application/json -Headers @{'Idempotency-Key'=[guid]::NewGuid().ToString()} -Body ($order | ConvertTo-Json -Depth 12)
Invoke-RestMethod ("http://localhost:8800/orders/" + $reply.correlationId)
Invoke-RestMethod ("http://localhost:8801/trace/" + $reply.correlationId)
```

Ports: intake 8800, observer 8801, orchestrator 8802, notifier 8803; RabbitMQ AMQP 5680 / management 15680 (kit credentials eai/eai-capstone); pricing 4110; payment/inventory/shipping/notification 4801–4804. Temporal is 7240 with UI 8240.

## Verification

With Node 20+ and the stack running, `cd tests`, `npm ci`, then `npm test` runs the supplied 30 public checks in stages. The repository's public tests are unchanged. On this Windows host, App Control blocked the native test dependency, so tests were executed in a separate Linux verification container; deployed services do not mount the Docker socket. See [verification](verification/) and the [failure analysis](docs/failure-analysis.md) for real evidence. Public tests do not establish a hidden-test score.

## Advanced component
Implemented.

Temporal mode starts the `checkout` workflow on task queue `checkout` with workflowId equal to source:orderId. Activities perform all external I/O. Switch modes with the existing stack stopped:

```powershell
docker compose --profile temporal down
$env:SAGA_ENGINE = 'temporal'
docker compose --profile temporal up -d --build --wait
```

Use fresh orderIds when switching modes; persisted terminal order records remain terminal. For the default mode:

```powershell
docker compose --profile temporal down
Remove-Item Env:SAGA_ENGINE -ErrorAction SilentlyContinue
docker compose up -d --build --wait
```

Temporal compensates failed workflows durably. Its operator compensation endpoint intentionally returns 409; GET /sagas/stuck returns an empty list. [ADR-011](docs/adr/adr-011.md) describes engine responsibilities.

## Documentation

- [Architecture](docs/architecture.md), [BPMN model](docs/orchestration.bpmn) and [diagram](docs/orchestration.svg).
- [Pattern/code links](docs/patterns.md), [failure analysis](docs/failure-analysis.md), [operations runbook](docs/runbook.md).
- [ADR index](docs/adr/README.md), [agent boundary](docs/agent-readiness.md), [AI disclosure](docs/ai-usage.md).

## State and limitations

Each core service writes only its own /data named volume. `docker compose down` preserves these records; `docker compose down -v` deletes demonstration state, including broker history. Do not reset a running assignment accidentally.

There is no cross-system transaction between provider calls, local journal and RabbitMQ. Payment/inventory effect keys protect at-least-once calls. Notification and shipping have no equivalent contract: notices can duplicate after send-before-save crashes, and a timed-out shipment can still be created. Hand-rolled mode marks interrupted processing needs_attention and requires review; compensation only reverses confirmed steps. Tracing is best effort and may lose hops during broker failure. Local endpoints, including worker mirror endpoints, are unauthenticated demonstration interfaces and require an authenticated gateway before external exposure. JSON journals and trace scans suit this bounded exercise, not an unbounded production workload.

The student must understand and defend the AI-assisted implementation; AI use is explicitly disclosed. The kit, canonical contract and PA1–PA7 history are retained.
