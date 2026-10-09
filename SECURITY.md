# Security policy

docsluice reads files from strangers. We treat every parser bug that can crash, hang, exhaust memory, read local files, make a network call or change JavaScript objects as a security bug.

## Report a vulnerability

Use GitHub private vulnerability reporting: **Security → Report a vulnerability** on this repository. Do not open a public issue.

Include the smallest file that shows the problem, the docsluice version, the runtime and the options you used. Do not send private documents.

## Response targets

| Step | Target |
|------|--------|
| First reply | 3 working days |
| Triage and severity | 7 days |
| Fix for high or critical | 30 days |

## Supported versions

Before 1.0, only the latest release gets fixes.

## Threat model

See [PRD section 14](docs/prd.md#14-security) for the threats and defences, and the default limits.
