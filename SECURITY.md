# Security

Thank you for helping keep sf-omp and its users safe.

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/alexander-vyh/sf-omp/security/advisories/new).
sf-omp is an unofficial fork; vulnerabilities that also affect upstream SF Pi
should additionally be reported through Salesforce's path:
<https://www.sfdc.co/SubmitVuln>.

Do not open a public GitHub issue for suspected vulnerabilities, leaked secrets,
credential exposure, or bugs that could enable unintended high-value mutations.

If a credential may have been committed, report it immediately and rotate it
through the owning system. Removing it from the current branch is not sufficient.

## Supported versions

Security fixes are made on `main`. Use the latest `main` with the pinned local
OMP and Bun versions from `package.json`.

## Security model

SF Pi is a pro-code developer tool and supports mutation. It does not claim to
sandbox every workstation action. SF Guardrail provides known-surface mediation
for risky first-party operations that SF Pi can classify.

Read [Security model](./docs/security-model.md) for trust surfaces, high-value
durable mutations, Safety Envelopes, session and unattended approvals,
prompt-injection impact controls, and residual risks.

## Contributor security

- [Secure development](./docs/secure-development.md) covers review, validation,
  dependency, scanning, and high-value mutation requirements.
- [Public sanitization](./docs/public-sanitization.md) covers source, docs,
  examples, fixtures, screenshots, and diagnostic artifacts.

Never commit credentials, real org/workspace identifiers, customer or employee
details, private endpoints, or copied private-source material. Credentials
belong in Pi's auth store, restrictive user-owned configuration, or documented
environment variables—not source or examples.
