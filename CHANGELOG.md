# Changelog

All notable changes are documented here. The format follows Keep a Changelog;
versions follow Semantic Versioning.

## [0.3.0] - 2026-09-01

### Added

- Layered logical-model and task-subtype request policy for reasoning,
  temperature, streaming, and input/output token bounds.
- Adaptive logical candidate selection alongside the existing fair and ordered
  strategies.
- Side-effect-free logical route plans plus process liveness and logical-model
  readiness endpoints.
- Console controls for advanced logical policy and a link to the live route
  explanation.
- A filterable relationship view from logical models through real models,
  providers, anonymous Key slots, and egress.
- Validated readiness mode (`/readyz?mode=available`) alongside the
  bootstrap-friendly dispatchable view.
- Exponential deployment/model qualification backoff with automatic recovery
  probing after invalid responses.
- Per-attempt logical usage accounting for internally retried billable
  responses.
- Separate public provider prices and untracked operator pricing overrides.
- A public-release isolation check for credentials, private task policy,
  workstation paths, runtime files, and unsafe starter configuration.

### Changed

- Simplified the operator console copy: one Chinese term per concept, no
  decorative bilingual labels, and shorter status/action text while retaining
  credential, default-value, and activation warnings.
- Removed decorative navigation and form step numbers; operational slot IDs
  remain visible because they identify real runtime slots.
- Capability labels are deployment-defined identifiers instead of a built-in
  business vocabulary.

### Fixed

- Removed a deployment-specific logical-model alias from the generic gateway;
  route selection now follows the configured logical model exactly.
- Task subtypes now inherit unspecified affinity, fallback, protected-capacity,
  admission-wait, and request settings instead of replacing them with defaults.
- Provider edits preserve advanced logical-model fields.
- Concurrent startup/manual usage-ledger cleanup now coalesces into one pass.

## [0.2.0] - 2026-08-30

### Added

- Provider-aware OpenAI and Anthropic gateway.
- Physical and capability-qualified logical model routing.
- Per-key AIMD capacity, rate limits, cooldowns, retries, and quota probes.
- Atomic configuration reload and credential-free qualification persistence.
- Optional sticky per-key sing-box egress.
- Usage ledger, pricing aggregation, and local dashboard.
- Opt-in sample logging with retention and size policy.
- Unified dependency-free operator console with a first-run provider wizard.
- Write-only credential management and mode-`0600` private local configuration.
- Searchable model picker with bulk text/JSON import and upstream `/models`
  discovery.
- Real-model policy editor and live logical-route resolution preview.
- Egress console for write-only subscriptions, static nodes, shared proxies,
  sticky Channel bindings, and per-Key fixed HTTP proxies.

### Changed

- The project is now distributed under a source-available and commercial
  dual-license model.
- An empty provider User-Agent preserves the downstream User-Agent; an
  explicitly configured value still overrides it, and adapter-required profiles
  remain authoritative.
