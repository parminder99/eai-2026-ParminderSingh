# AI assistance disclosure
## Tools used
OpenAI Codex, local PowerShell, Python, Docker Compose, Node.js and the supplied Vitest suite were used. Prettier formatted the owned service code. Bpmn-js imported and exported the BPMN model, and librsvg rendered the diagram preview. Git records the delivered changes.
## What for
Codex authored the capstone service implementation, diagrams and explanatory documents and operated local verification. The supplied kit and public tests provided the contract.
## What I changed or rejected
The generated initial container build excluded grading schemas; the Docker ignore rules were corrected. Retry traces were changed to parent the consume hop, and DLQ replay strips retry history. Provider effect keys remain distinct from HTTP request keys. Claims of exactly-once notification delivery were rejected because send and local persistence cannot commit atomically.
## What I verified, and how
Public Vitest tests exercise stack contracts, translation, pricing errors, successful sagas, compensation, retries, tracing and operations. Failure-analysis records separate observed evidence from design expectations. Test outputs are retained under verification. No hidden-test score is claimed; successful public tests do not certify all failure interleavings.
## Dependencies beyond the allow-list
No additional runtime dependency is intended: Express, amqplib, fast-xml-parser, Ajv, ajv-formats and Temporal SDK packages implement the permitted roles. Python and Docker CLI are authoring/verification tools and are absent from deployed service images. The submitter should read and be able to explain the AI-authored code before the oral defence.
