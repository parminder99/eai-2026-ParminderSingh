# Verification evidence

Recorded on 4 November 2026 using the supplied capstone kit.

- `public-runtime.txt`: all 28 runtime public checks passed in hand-rolled mode.
- `public-documents.txt`: both public document checks passed.
- `01-…` through `10-…`: real hand-rolled scenario captures, including provider effects, order state, trace hops, metrics and recovery responses. These are synthetic kit fixture customers.
- `T2-…` through `T6-…`: advanced Temporal scenario captures. Worker restart recovered with one payment and one reservation; a shipping timeout made three calls before compensation; the payment transient failure was absorbed without DLQ parking.
- `advanced-scenarios.txt`: scenario runner results. Temporal mode built and became healthy in 39.47 seconds on the working copy with cached base images. This is an observation, not a claim about every machine.
- `temporal-workflows.json`: engine-reported workflow identities and terminal statuses.
- `store-validation.txt`: persisted JSON/JSONL validated against the kit schemas.
- `memory-snapshot.txt`: running containers stayed within the assignment limits at this snapshot; this is not a lifetime peak measurement.

The linked [failure analysis](../docs/failure-analysis.md) explains the ten required cases and their operator actions. Public results do not certify hidden tests or untested crash interleavings. Evidence is retained for review, not loaded by runtime services.
