# PA5 verification — October 12, 2026

All 11 current public tests passed unchanged: ten messaging checks and the ADR check, in 138.90 seconds. They cover HTTP order creation/retrieval, fanout topology, three-attempt DLQ handling, correlation, duplicate handling, consumer-declared error channels, permanent malformed-message classification and origin-only replay.

All four service typechecks passed in their Node 20 Docker images. The additional restart-check.mjs script passed after the final service rebuild: a duplicate after notification-service restart creates no second log line; GET retains the unchanged body; invalid extra canonical fields return 400; unknown lookup returns 404.

An isolated Docker check with no shared/node_modules successfully loaded the current shared helper. Rejected count 2 plus expired count 2 gives retry count 2. withoutRetryHistory reset the count to zero while retaining correlationId and originQueue.

The repository was synchronized with the latest course scaffold, including examples/order.json, the updated unchanged public tests, README and RabbitMQ definitions. The canonical model is unchanged. Notification data files are ignored by Git. See the ADR for AI assistance and crash/transaction/replica limitations.

For a fresh checkout with Docker and Node.js/npm:

```powershell
cd pa5
docker compose up -d --build --wait
npm --prefix tests ci
npm --prefix tests test
node verification/restart-check.mjs
```

Local public tests used pnpm to execute the existing test script. Service typechecks: `docker compose exec order-service npm run typecheck` (repeat for payment-service, inventory-service and notification-service). The shared helper needs no host dependency installation at runtime.
