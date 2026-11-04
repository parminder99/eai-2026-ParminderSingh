# Clean-clone verification

The uploaded repository was cloned from GitHub into a separate directory at implementation commit `b7147bdac1422aa127c65a306cb1cca6ac8308f9`. The working stack was stopped and its capstone volumes reset before this check. Earlier practical stacks were not changed.

| Check | Observed result |
|---|---|
| Hand-rolled build and healthy startup, cached base images | 74.23 seconds; limit 300 seconds |
| Public tests from the clean clone | 30 passed, 0 failed; 7 test files |
| Temporal build and healthy startup, cached base images | 31.44 seconds; limit 420 seconds |
| Advanced scenario checks against the clean clone | All passed; see clean-clone-advanced.txt |
| Web and B2B workflows | completed; step traces emitted by worker |
| Shipping timeout | three calls, then compensated with timeout |
| Refund failure | compensation_failed |
| Worker killed during delayed shipping, then restarted | completed with one charge and one reservation |
| Two transient payment failures | completed with one charge and no DLQ entry |
| New HTTP key for same business order | duplicate; one workflow and charge |
| Same-correlation canonical event redelivery | terminal outcome republished; no second charge |
| Temporal operator endpoints | empty stuck list; compensation returns 409 saga_not_stuck |

Later documentation/evidence changes improve diagram labels, state the closed assistant input schemas and retain these results; they do not change the verified service implementation. The final document checks were repeated after those edits. The advanced suite is not supplied publicly: these are checks of its published scenarios, not a claimed official hidden-test grade.
