# PA7 verification — October 22, 2026

All 13 unchanged current public tests passed in 33.96 seconds, including the test that kills and starts pa7-worker mid-saga. Worker TypeScript checking passed in its provided Node 20 Debian image. The given API, worker startup/types, schemas and PA6 mocks are unchanged from the course copies.

Windows Application Control blocked the host Vitest runner's native Rollup dependency. The unchanged tests were therefore run in an ephemeral Node 20 Alpine container, with npm ci, the Docker CLI/socket for the required worker-restart test, and API/mock URL overrides pointing through host.docker.internal. Dependencies were isolated in a Docker volume. No Windows security setting was disabled.

The separate manual worker-kill experiment also passed. It returned HTTP 200/completed with these calls for the tested order: payment 1, inventory 1, shipping 2, notification 1. This illustrates activity at-least-once delivery. Extra HTTP checks verified notification refusal compensation, refund continuation after failed release, exact replay of a failed saga without another payment, and the 0.70 decimal amount derived from 3 x 0.10 + 2 x 0.20.

PA6 was killed separately for comparison: it retained in_progress after payment/inventory and returned 409 on replay after restart. See both ADRs for the observed contrast, limitations and AI-assistance disclosure.

For a fresh checkout with Docker and Node.js/npm installed:

```powershell
# Stop PA6 first: it shares ports with PA7.
cd pa7
docker compose up -d --build --wait
npm --prefix tests ci
npm --prefix tests test
docker compose exec worker npm run typecheck
```

The Temporal UI is at http://localhost:8233. Runtime files and dependency folders are not submitted. The portal currently displays PA6's self-assessment rubric under PA7; submission notes identify this discrepancy rather than claiming the given PA7 API enforces PA6-only bounds.
