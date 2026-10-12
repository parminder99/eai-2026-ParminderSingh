# PA5 verification — October 12, 2026

- All eight unchanged public tests passed: seven messaging checks plus the ADR check (110.23 seconds).
- All four service typechecks passed inside their Node 20 Docker images.
- `verification/restart-check.mjs` passed: canonical body unchanged on retrieval, duplicate skipped after notification restart, invalid extra canonical field rejected, and missing lookup returns 404.
- An isolated Docker check with a shared folder containing no node_modules successfully loaded the helper. A header containing rejected count 2 and expired count 2 returned retry count 2.

Public tests, canonical types, RabbitMQ topology and Compose configuration are unchanged. The shared retry counter was corrected because expiry and rejection describe the same retry cycle. The payment retry/DLQ catch block remains unchanged.

For a fresh checkout with Docker and Node.js/npm:

```powershell
cd pa5
docker compose up -d --build --wait
npm --prefix tests ci
npm --prefix tests test
node verification/restart-check.mjs
```

Local public tests used pnpm to run the unchanged test script. The additional script requires docker on PATH. Service typechecks: `docker compose exec order-service npm run typecheck` (repeat for payment-service, inventory-service, notification-service).

Local notification state is ignored by Git and is not uploaded. See docs/adr-004.md for acknowledged crash, replica and transaction limitations and AI-assistance disclosure.
