# PA3 verification

On October 6, 2026, Docker Desktop's Linux engine was started successfully and `run-tests.ps1` built the Compose stack and ran the unchanged public tests using the bundled Node.js and pnpm runtime.

Result: **5 test files passed; 10 tests passed**, in 37.02 seconds.

Verified: splitter message counts, physical/digital routing, correlation and item indexes, full aggregation, isolation between concurrent orders, partial completion with a stopped worker, subscription routing, and required ADR headings.

Earlier local checks additionally passed duplicate handling, concurrent 50-item orders, idle reset, late results, and publication retry using a mocked broker. Those checks are not the unpublished grading tests.

The Compose stack was left running. To repeat the build and tests on this machine, execute `run-tests.ps1` in PowerShell. No repository push or portal submission has been made.
