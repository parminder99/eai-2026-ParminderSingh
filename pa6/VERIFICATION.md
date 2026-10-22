# PA6 verification — October 22, 2026

The custom OpenAPI contract linted cleanly using the supplied Spectral container before implementation, in commit 9b44e0f. The bad example exited 1 with 13 errors. The contract enforces 100 items and describes 400/409/413/422/504 responses.

All 12 unchanged current public tests passed (15.959 seconds). Orchestrator TypeScript checking passed inside Docker. Extra HTTP checks verified 101-item rejection, same-key replay with reordered object properties, and continuing to refund after inventory-release failure.

A manual process-kill experiment during slow shipping left an in_progress idempotency record with payment and inventory trace entries. After restart, the same key returned 409 idempotency_conflict. No automatic continuation is claimed for PA6. Evidence was saved locally and described in ADR-005.

Run from pa6 with Docker and Node.js/npm installed:

```powershell
docker compose run --rm spectral
docker compose up -d --build --wait
npm --prefix tests/public ci
npm --prefix tests/public test
docker compose exec orchestrator npm run typecheck
```

Local tests used pnpm to execute the unchanged Jest test script. Runtime state is ignored by Git. PA6 and PA7 share ports; stop PA6 before starting PA7. See the ADR for AI-assistance disclosure and limitations.
