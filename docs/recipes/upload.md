# Handling uploads

A web service that accepts files from anyone should lower the limits, set a deadline, and treat every failure as an answer, not a crash. docsluice errors carry a `code` and never document content, so the code can go back to the client.

<!-- include: examples/upload.mjs -->

For hard isolation (a parser bug cannot take the process down, memory is capped), run the same call through [`docsluice/worker`](../worker.md).
