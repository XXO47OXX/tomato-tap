# Contributing

## Contribution licensing

Tomato Tap uses a source-available and commercial dual-license model. External
code cannot be included safely in both editions without an explicit contributor
agreement. Until a contributor license agreement is published, unsolicited
code pull requests are not accepted.

Bug reports, reproducible test cases, design discussion, and documentation
suggestions are welcome through GitHub Issues. Do not include third-party code,
credentials, private endpoint details, or confidential data in an issue.

## Development setup

Use Node.js 20 or newer. The runtime has no third-party package dependency.

```bash
cp .env.example .env
npm test
npm run check
bash -n scripts/*.sh
```

## Change rules

- Keep the dependency direction described in `docs/architecture.md`.
- Put protocol-specific behavior in `src/providers`, routing policy in
  `src/routing`, network egress in `src/egress`, and local management UI/API
  code in `src/admin`.
- Add a focused regression test for behavior changes.
- Keep request deadlines and retries bounded.
- Preserve response metadata that identifies the selected physical model.
- Reject invalid configuration instead of partially applying it.
- Do not add API keys, OAuth files, subscription URLs, private IPs, workstation
  paths, usage ledgers, or request samples.
- Use `example.com`, loopback, or local ephemeral servers in tests.

Maintainer-requested changes must run both checks and explain the
operator-visible behavior, compatibility impact, and validation performed.
