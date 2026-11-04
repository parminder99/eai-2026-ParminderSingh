# Operations runbook

Run commands from the repository capstone directory in PowerShell. Start with `docker compose up -d --build --wait`. Read metrics with `Invoke-RestMethod http://localhost:8801/ops/metrics`. Lag thresholds are five ready messages: a small demonstration queue should clear a burst within a few service times; the threshold avoids firing on a single in-flight request. Reassess thresholds against measured throughput in a deployed environment.

## dlq_not_empty
A consumer exhausted its retry budget.

Likely causes: Persistent provider outage or malformed downstream response.

Diagnose: GET /dlq; inspect originQueue, lastError and attempts.

Fix: Repair the provider; replay only the selected correlationId with POST /dlq/replay.

Verify: Check count decreases and that the order outcome or notification log advances.

## invalid_not_empty
At least one malformed event is quarantined.

Likely causes: Invalid JSON/schema or missing correlation header.

Diagnose: Inspect orders.invalid with the broker management UI; preserve bytes and headers.

Fix: Correct the producer; do not replay malformed bytes blindly. Publish a corrected canonical event only after review.

Verify: Confirm no new invalid entries arrive; archive reviewed entries explicitly.

## saga_consumer_missing
saga.queue has no active consumer.

Likely causes: Orchestrator stopped or broker connectivity failed.

Diagnose: docker compose ps; docker compose logs --tail 80 orchestrator; GET :8802/health.

Fix: Start orchestrator or repair broker reachability.

Verify: Health returns 200 and metrics show a consumer; inspect interrupted work.

## notifier_consumer_missing
notifications.queue has no active consumer.

Likely causes: Notifier stopped or its AMQP session failed.

Diagnose: docker compose logs --tail 80 notifier; GET :8803/health.

Fix: Start notifier or repair AMQP connectivity.

Verify: Consumer count becomes positive and ready depth falls.

## saga_consumer_lag
More than five saga messages are ready.

Likely causes: Slow providers or insufficient consumer capacity.

Diagnose: Read /ops/metrics repeatedly; inspect provider latency and orchestrator health.

Fix: Repair slow dependencies before increasing bounded concurrency; avoid replay storms.

Verify: Ready depth falls to five or less and unrelated orders complete.

## notifier_consumer_lag
More than five notices are ready.

Likely causes: Notification provider outage or slow notice processing.

Diagnose: Inspect notifier logs, ready/unacked counts and notification provider health.

Fix: Repair provider; keep retries bounded and inspect DLQ rather than discarding failures.

Verify: Ready depth falls to five or less and notices appear in notification.log.

## stuck_sagas
One or more sagas require human attention.

Likely causes: Orchestrator restart interrupted work or compensation failed.

Diagnose: GET :8802/sagas/stuck; compare /orders/:cid, /trace/:cid and provider /admin/effects.

Fix: Resolve ambiguous in-flight effects, repair failing compensator, then POST /sagas/:cid/compensate.

Verify: Observe compensated state, no pending release/refund and no extra provider effects on a repeat operator request.

## Safe replay and recovery
GET http://localhost:8800/dlq is non-destructive. Replay one repaired item using `Invoke-RestMethod http://localhost:8800/dlq/replay -Method Post -ContentType application/json -Body '{"correlationId":"UUID"}'`. For compensation use the same command shape against http://localhost:8802/sagas/UUID/compensate. Never compensate a completed checkout. A timeout does not prove the provider made no effect; inspect its effect log first.

## State and reset
Intake stores idempotency-store.json and order status; orchestrator stores saga-store.json; notifier stores its correlation IDs and notification.log; observer stores trace-store.jsonl. All are in service-owned /data volumes. `docker compose down` preserves them. `docker compose down -v` destroys demonstration state and is only for an explicitly chosen test reset. Keep the kit, canonical contract and earlier practicals unchanged.
