# Security Policy

If you believe you have found a security issue in `clawpatch`, report it privately first.

Do not open a public issue or pull request that discloses an unpatched vulnerability, exploit path, secret, or security-sensitive proof of concept.

## Reporting

For `clawpatch`, submit a private GitHub Security Advisory for this repository when available. If the issue does not fit this repository or you are unsure where it belongs, email [security@openclaw.ai](mailto:security@openclaw.ai) and we will route it.

Useful reports include:

- affected version or commit SHA,
- impacted component or file path,
- reproduction steps or a proof of concept against latest `main`,
- actual impact and the trust boundary crossed,
- suggested remediation when practical.

## Scope

Security-relevant surfaces include provider command execution, prompt construction, repository feature mapping, patch workflow state, package integrity, GitHub Actions, dependency automation, and any path that may expose secrets or send repository content to a provider.

Scanner-only reports, dependency-only reports without reachable impact, and issues that require a trusted operator to intentionally run unsafe local commands are usually treated as hardening requests rather than vulnerabilities.
