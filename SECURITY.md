# Security policy

## Supported versions

Security fixes are applied to the latest tagged release. Until `1.0`, operators
should review release notes before upgrading because configuration schemas may
change.

## Reporting

Do not open a public issue containing credentials, subscription URLs, request
samples, provider account identifiers, or private hosts. Use the repository's
private security-reporting channel. If none is configured, contact the
maintainer privately before disclosing details.

Include the affected version, route/protocol, a minimal redacted reproduction,
and the expected impact. Replace every credential with a synthetic value.

## Deployment model

Tomato Tap defaults to trusted, unauthenticated loopback access. It replaces the
incoming authorization value with an upstream credential. This is appropriate
for a single-user workstation or a protected service network; it is not an
internet-facing authentication boundary.

- Keep `TOMATO_TAP_BIND_HOST=127.0.0.1` unless a firewall or authenticated reverse
  proxy protects the listener.
- The `/admin/` console is unauthenticated on loopback. When binding beyond
  loopback, set `TOMATO_TAP_ADMIN_TOKEN`; write APIs remain disabled without it.
- Management mutations require JSON, a same-origin browser request, and the
  console marker header. Credentials are write-only and never returned.
- Run under a dedicated, unprivileged account.
- Keep `.env`, `config/local/`, and `runtime/` owner-only.
- Treat proxy subscriptions and generated proxy files as credentials.
- Leave sample logging disabled unless raw prompts and responses are required.
- Rotate any secret that appears in logs, shell history, a commit, or an issue.

The status and model endpoints redact keys but still reveal operational
metadata. Do not expose them to untrusted clients.
