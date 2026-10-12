# PA4 verification — October 12, 2026

Docker Compose successfully built and started mock-pricing on port 4100. TypeScript checking passed. All 17 unchanged public tests and six added edge-case tests passed. The sample runner produced all three outputs.

Additional tests cover unknown products and HTTP 500 in every source, HTTP 401 with all lines failing, connection failure, malformed API responses, and singleton XML with extra fields and a leading-zero postal code. Public tests, source fixtures, pricing service and canonical schema are unchanged.

Local verification used bundled Node.js and pnpm to execute the existing typecheck, test and start scripts. For a fresh checkout:

```powershell
cd pa4
docker compose up -d --build --wait
cd starter
npm ci
npm run typecheck
npm test
npm start
```

See docs/adr-003.md for limitations and AI-assistance disclosure. Hidden grading tests are unavailable and are not claimed to have passed.
