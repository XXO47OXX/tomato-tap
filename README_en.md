# Tomato Tap

<div align="left">
  <a href="README.md">中文</a> | <a href="README_en.md">English</a>
</div>

Tomato Tap is a local LLM gateway for operators who bring their own API keys. It combines multiple providers, models, and credentials behind stable logical model names while managing concurrency, rate limits, quota recovery, cooldowns, retries, egress, response validation, and usage accounting.

It supports OpenAI Chat Completions and Anthropic Messages clients, requires no database or hosted control plane, and has no third-party runtime dependencies. Node.js 20 or newer is required.

> Tomato Tap is **source-available**, not OSI open source. Noncommercial use is licensed under PolyForm Noncommercial 1.0.0; commercial use requires a separate license.

## Why Tomato Tap?

A normal reverse proxy is enough for one stable upstream. Tomato Tap becomes useful when:

- several providers or keys expose the same model with different quotas and capacity;
- downstream clients should request `balanced` instead of knowing every physical route;
- a 429, 401, exhausted quota, or temporary network failure must not disable the whole pool;
- some keys need a stable egress IP while others can connect directly or share a proxy;
- an HTTP 200 may still contain an invalid model response that must not reach the client;
- usage and cost need to be attributed by provider, real model, logical route, and currency;
- credentials and routing policy must remain local and reload without downtime.

## Where should I start?

| Your situation | Recommended first step |
|---|---|
| One provider and one key | Add one upstream and call its real model directly |
| Several keys for one provider | Use **Append Key** so every key has independent limits and cooldowns |
| Similar models from several providers | Normalize their real-model name, then create a logical model |
| Downstream clients cannot track route changes | Let them request one stable logical name such as `balanced` |
| Every key needs a different IP | Use sticky-auto or a pinned node in Egress |
| Quota recovery time is uncertain | Configure quota probing and recovery policy for that upstream |
| Local, single-user installation | Keep the default loopback binding and trusted-client mode |
| Shared or downstream distribution | Put it behind a firewall or authenticating reverse proxy and read [SECURITY.md](SECURITY.md) |

## Three-minute quick start

```bash
git clone https://github.com/XXO47OXX/tomato-tap.git
cd tomato-tap
npm test
npm start
```

Open <http://127.0.0.1:8888/admin/>. The first-run guide asks for:

- provider name and Base URL;
- OpenAI or Anthropic protocol;
- API key and authentication method;
- optional User-Agent; an empty value preserves the downstream User-Agent;
- upstream and canonical model names, RPM, and concurrency limits;
- direct, shared, or pinned egress policy.

The console can search and bulk-import model IDs or inspect a compatible upstream `/models` response. Discovery is only a preview until you select and save entries. API keys, proxy subscriptions, and raw nodes are write-only; after saving, the UI only reports whether each secret is configured.

The committed example upstream is disabled and cannot send real traffic. On the first saved change, Tomato Tap creates mode-`0600` `config/local/relays.json`, `config/local/models.json`, and a local `.env`. Git ignores all of them.

Check the gateway and send a first request:

```bash
curl http://127.0.0.1:8888/healthz
curl 'http://127.0.0.1:8888/readyz?model=balanced'
curl http://127.0.0.1:8888/oa/v1/models

curl http://127.0.0.1:8888/oa/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"balanced","messages":[{"role":"user","content":"Hello"}]}'
```

The example `balanced` route becomes ready only after you assign at least one usable candidate.

## Five core concepts

| Concept | What it manages | What it does not own |
|---|---|---|
| Provider / Channel | Endpoint, protocol, authentication, RPM, and capacity | Plaintext keys in public configuration |
| Key | Credential, live capacity, cooldown, quota state, and egress binding | Logical-model capability |
| Real model | Canonical name, capabilities, quality, reasoning adapter, and timeouts | A single provider identity |
| Logical model | Stable client name, candidates, selection policy, and retry budget | Credentials |
| Egress | Direct, shared, sticky-auto, pinned-node, or fixed HTTP transport | Nothing is enabled implicitly |

**Append Key** copies non-secret protocol and model mapping but deliberately leaves the new credential and fixed HTTP proxy blank. When the source key uses a subscription node, the new key receives an independent sticky-auto binding rather than silently sharing the same IP.

## Common workflows

### Pool models with equivalent capability

1. Add each provider and key;
2. map provider-specific IDs to one canonical real-model name;
3. describe capability, quality, and reasoning behavior under **Real models**;
4. create a logical model and select its candidates;
5. inspect the current decision with `GET /__route/plan?model=<logical>`;
6. configure downstream clients to request only the logical name.

Two deployments declaring the same canonical model become independent capacity sources. The scheduler still tracks provider, key, concurrency, latency, quota, and cooldown separately.

### Choose a logical selection strategy

- `fair` rotates candidates by retry round and is useful for quota sharing and diversity;
- `ordered` follows configured order and is useful for an explicit primary/fallback chain;
- `adaptive` selects from the best current qualification class using health, free capacity, success rate, and latency.

Candidates are filtered by capability, quality, quota, cooldown, concurrency, and qualification before selection. A logical model can also define total concurrency, attempt count, deadline, and request overrides.

### Control reasoning and structured requests

Request policy supports `reasoningEffort`, `temperature`, `stream`, `maxOutputTokens`, and `maxInputTokens`. Precedence is:

```text
downstream request
  < logical-model policy
  < task-subtype policy
  < physical-model compatibility adapter
  < provider / Key final policy
```

A later layer overrides only fields it explicitly owns; other request content is preserved.

## Configuration and data boundary

| Data | Default location | Commit? |
|---|---|---:|
| Code and safe starter policy | `src/`, `config/*.json` | Yes |
| Public provider list prices | `pricing/provider-defaults.json` | Yes |
| API keys and subscription URLs | `.env` or `TOMATO_TAP_ENV_FILE` | Never |
| Private provider and model inventory | `config/local/` | Never |
| Private aliases and negotiated prices | `pricing/local/` or an external override | Never |
| Cooldowns, bindings, usage, and samples | `runtime/` | Never |

Advanced installations may maintain the files manually:

```dotenv
TOMATO_TAP_VENDORS_PATH=/path/to/vendors.json
TOMATO_TAP_RELAYS_PATH=/path/to/relays.json
TOMATO_TAP_MODELS_PATH=/path/to/models.json
TOMATO_TAP_ENV_FILE=/path/to/tomato-tap.env
TOMATO_TAP_PRICING_OVERRIDES_PATH=/path/to/pricing-overrides.json
```

A credential matching deployment ID `provider_a` is written as:

```dotenv
tomato_tap_relay_provider_a_key=replace-locally
```

Changes are fully validated, written atomically, and hot-reloaded. An invalid update never replaces the currently healthy configuration generation.

If you maintain both a public distribution and a private deployment, keep them in separate Git repositories. Port generic source changes from public to private, never the reverse. Do not copy `.env`, `config/local/`, private pricing, or `runtime/` into the public checkout. Before every public push, run:

```bash
npm run check:public
```

The isolation check rejects credentials, workstation paths, private runtime files, non-example starter hosts, and populated private pricing overrides.

## Egress management

Proxy behavior is isolated under `src/egress/`:

- subscriptions are parsed in memory;
- keys bind only to redacted node IDs;
- bindings survive restarts in `runtime/proxy-bindings.json`;
- sing-box listeners bind only to loopback;
- a failed pinned node cools only its key and never silently changes IP.

Every upstream connects directly by default. Configure subscriptions and key bindings under **Console → Connections**, or use disabled, shared, sticky-auto, pinned-node, or fixed HTTP proxy policy in local configuration. Raw subscription URLs, VLESS URIs, and authenticated proxy URLs belong only in `.env`. See [docs/egress.md](docs/egress.md).

## Health, quota, and usage

Tomato Tap distinguishes configured, dispatchable, probing, recently validated, and cooling capacity. A model is not advertised as available merely because its name exists in configuration.

- every key has independent AIMD concurrency, RPM, cooldown, and quota state;
- 401, 403, 429, network failures, and invalid responses can use different recovery scopes;
- a quota prober can test low-frequency recovery when the exact reset time is unknown;
- an invalid HTTP 200 is never returned downstream as a successful model result;
- usage can be grouped by date, provider, real model, logical route, and currency;
- public list prices and private contract prices are separate, and currencies are not forcibly converted;
- request/response sample logging is off by default and supports retention and size limits when enabled.

## Operations

Foreground mode:

```bash
npm start
```

Optional supervisor:

```bash
./scripts/run.sh start
./scripts/run.sh status
./scripts/run.sh restart
./scripts/run.sh stop
```

Useful endpoints:

- `GET /admin/` — unified local administration console;
- `GET /__status` — redacted runtime, key-pool, quota, and egress state;
- `GET /healthz` — process liveness without upstream traffic;
- `GET /readyz` — whether at least one logical model is dispatchable;
- `GET /readyz?mode=available` — requires a recently validated deployment;
- `GET /readyz?model=<logical>` — readiness for one logical model;
- `GET /__route/plan?model=<logical>` — dry route decision without upstream traffic;
- `GET /models` — cross-route model inventory;
- `GET /<route>/models` — route-scoped model inventory;
- `GET /__usage` — usage UI, price catalog, and JSON API.

The server binds to `127.0.0.1` and trusts local clients by default. This release does not provide secondary client API-key authentication. Never expose trusted mode directly to an untrusted network; shared access must sit behind a firewall, protected network, or authenticating reverse proxy. Read [SECURITY.md](SECURITY.md) before deployment.

## Repository layout

```text
bin/                 command-line entry points
config/              safe committed starter configuration
src/app/             process composition and lifecycle
src/admin/           local console and safe config transactions
src/config/          parsing, generations, and hot reload
src/gateway/         HTTP admission, control plane, and request reading
src/routing/         logical/physical scheduling and response validation
src/providers/       provider metadata, protocol adapters, and quota probes
src/egress/          proxy transport and sticky bindings
src/state/           key capacity, rate limits, and cooldowns
src/usage/           pricing, ledger, aggregation, and usage UI
src/telemetry/       optional sample logging
tools/               operator and repository checks
tests/               unit and loopback integration tests
```

Further reading:

- [Architecture and state model](docs/architecture.md)
- [Complete configuration reference](docs/configuration.md)
- [Egress guide](docs/egress.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

## Pre-release name compatibility

New installations should use `tomato-tap`, `TOMATO_TAP_*`, `tomato_tap_relay_*`, and `x-tomato-tap-*`. During the `0.x` series, pre-release `mimo-tap` commands, environment names, and response metadata remain accepted; canonical names always win. Legacy wire identifiers will not be removed without a documented major-version migration.

## Development

```bash
npm test
npm run check
bash -n scripts/*.sh
```

## Licensing

Tomato Tap uses a source-available / commercial dual-license model:

- noncommercial use is available under the [PolyForm Noncommercial License 1.0.0](LICENSE);
- commercial use requires a separate written license from the copyright holder, as described in [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md).

For-profit internal use, paid or customer-facing services, resale, managed hosting, and commercial product integration normally require a commercial license. License terms attach to each released copy; rights granted for an earlier release are not retroactively withdrawn.
