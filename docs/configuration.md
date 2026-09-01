# Configuration

Tomato Tap uses three strict JSON documents and one secret env file. Paths can be
overridden independently:

```dotenv
TOMATO_TAP_VENDORS_PATH=/path/to/vendors.json
TOMATO_TAP_RELAYS_PATH=/path/to/relays.json
TOMATO_TAP_MODELS_PATH=/path/to/models.json
TOMATO_TAP_ENV_FILE=/path/to/tomato-tap.env
TOMATO_TAP_PRICING_OVERRIDES_PATH=/path/to/pricing-overrides.json
```

For a normal local installation, start Tomato Tap and open
`http://127.0.0.1:8888/admin/`. The console creates and maintains ignored,
mode-`0600` files under `config/local/` and writes credentials to `.env`.
Credential values are accepted by write APIs but are never returned by read
APIs. Manual JSON editing remains supported for advanced deployments.

The repository ships a public provider-price layer and an empty local override
template. Public list prices and reusable provider billing rules belong in
`pricing/provider-defaults.json`. Private aliases, contract prices, promotional
rates, and deployment-specific billing windows belong in a separate untracked
file selected with
`TOMATO_TAP_PRICING_OVERRIDES_PATH`. Do not add an operator's private model
catalog to the public `pricing/overrides.json` file.
An override may set `costMode` to `accounted` when its token tariff is the
operator's authoritative billing rule; otherwise it is reported as an estimate.
Tomato Tap includes public Mimo credit multipliers. Additional operator rules
can be prepended with a JSON object such as
`TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS={"premium-model":2}`; the longest
case-insensitive model substring wins.

The provider form uses a searchable model picker rather than requiring a
line-oriented list. It supports individual additions, case-insensitive
deduplication while preserving the first exact spelling, bulk text/JSON import,
unknown IDs, and authenticated upstream `/models` discovery. Discovery results
are a preview and are not persisted until the operator selects and saves them.

Real-model policy and logical-model policy are intentionally separate. Edit
capabilities, thinking adaptation, model concurrency, and timeouts in **Models →
Real models**. Edit candidates, strategy, request policy, attempts, and
deadlines in the logical-model editor. Provider RPM/capacity and Key egress
remain Channel policy and are not copied into logical routes.

The console uses a generic relay vendor with separate OpenAI and Anthropic
client routes. Each deployment selects its own upstream format and `bearer` or
`x-api-key` authentication. OpenAI deployments can enter logical model pools;
Anthropic-only deployments remain available through the Anthropic route.

## Vendors

`vendors.json` defines client route prefixes, protocol, authentication adapter,
credential discovery rule, vendor-wide concurrency, retry policy, and request
timeouts. It does not contain credentials.

`auth401CooldownMs` optionally overrides the default 24-hour credential
cooldown for a vendor. It must be an integer from `0` through seven days. Use
this only when the upstream explicitly treats a 401 as transient; the policy is
configuration, never a provider-specific branch in source code.

The starter `relay` vendor discovers variables named
`tomato_tap_relay_<deployment>_key` and joins them to the same deployment ID in
`relays.json`.

Pre-release installations may continue using `MIMO_TAP_*` and
`mimotap_relay_<deployment>_key` during the `0.x` series. New names take
precedence when both are defined; startup emits a deprecation warning for the
old uppercase settings.

## Relays

`relays.json` describes physical deployments. A typical entry is:

```json
{
  "provider_a": {
    "provider": "provider-a",
    "host": "api.example.com",
    "path": "/v1",
    "models": ["upstream-model"],
    "aliases": {"stable-model": "upstream-model"},
    "canonicalModels": ["stable-model"],
    "apiFormats": ["openai"],
    "auth": "bearer",
    "cap": {"initial": 1, "min": 1, "max": 4},
    "rateLimit": {"requestsPerMinute": 60, "mode": "paced"},
    "proxy": false
  }
}
```

`provider` is the non-secret label used by status and usage reports. The
upstream host is hidden from status output by default. Set
`TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS=true` only on a trusted operator instance when
host-level diagnostics are required.

The local console has three diagnostic detail levels. `safe` uses anonymous Key
slot IDs and hides hosts and response snippets. `operator` shows configured Key
names and upstream hosts. `debug` additionally shows quota-inference response
snippets. Set `TOMATO_TAP_ADMIN_DETAIL_LEVEL` to `safe`, `operator`, or `debug`;
host display also requires `TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS=true`. Full API Key
values are never returned to the browser at any level. The detail level is an
instance-wide ceiling for all console administrators. Debug snippets live only
in a 100-event in-memory ring buffer, are truncated to 120 bytes, and disappear
when the process restarts.

`models` contains exact upstream names. `aliases` maps stable client names to
those names. `canonicalModels` controls which names enter the shared scheduler.
Two deployments with the same canonical model become independent capacity
sources for that model.

The matching secret is:

```dotenv
tomato_tap_relay_provider_a_key=replace-locally
```

Optional per-key fixed HTTP egress is also secret:

```dotenv
tomato_tap_relay_provider_a_proxy_url=http://127.0.0.1:7890
```

`headers.User-Agent` sets a deployment-specific User-Agent. When it is omitted
or blank, Tomato Tap forwards the downstream request's User-Agent unchanged.
`TOMATO_TAP_DEFAULT_USER_AGENT` is only an optional fallback when the downstream
request has no User-Agent at all. Protocol adapters that require a fixed client
identity override both and are identified explicitly in the operator console.
User-Agent metadata is not a credential, but private provider inventories should
still remain under `config/local/`.

## Model policy

`models.json` has three sections:

- `realModels`: capabilities, quality tier, thinking adapter, concurrency, and
  timeouts for canonical models.
- `taskSubtypes`: optional candidate/requirement overrides selected through a
  task header.
- `logicalModels`: stable client-facing pools and their required capabilities.

Every logical candidate must exist in `realModels` and satisfy all required
capabilities. A `standaloneOnly` real model cannot be placed in a logical pool.
Configuration errors fail closed.

### Logical strategies

`candidateStrategy` controls selection across candidate model names after
capability, quality, cooldown, quota, capacity, and qualification filters have
been applied:

- `fair` balances attempts across candidate models, then uses runtime health,
  free capacity, success rate, and latency inside the current round;
- `ordered` gives candidates a turn in configured order before starting the
  next retry round;
- `adaptive` always chooses the highest-scoring candidate in the best current
  qualification class. It may keep preferring one healthy model, so use `fair`
  when diversity or quota sharing matters more than latency.

Runtime scores are in-memory observations. After a restart, configured initial
latency is used until new outcomes are recorded. Strategy changes do not alter
per-Key RPM, quota, cooldown, proxy affinity, or provider limits.

### Layered request policy

Both a logical model and a task subtype may define a `request` object:

```json
{
  "taskSubtypes": {
    "short_classification": {
      "requiredCapabilities": ["structured_output", "classification"],
      "qualityTier": "strong",
      "candidates": ["model-a"],
      "maxAttempts": 2,
      "deadlineMs": 30000,
      "request": {
        "reasoningEffort": "low",
        "temperature": 0,
        "stream": false,
        "maxOutputTokens": 1024
      }
    }
  },
  "logicalModels": {
    "classifier": {
      "requiredCapabilities": ["structured_output"],
      "candidates": ["model-a", "model-b"],
      "allowedTaskSubtypes": ["short_classification"],
      "candidateStrategy": "adaptive",
      "maxInflight": 8,
      "maxAttempts": 4,
      "deadlineMs": 90000,
      "request": {
        "temperature": 0,
        "maxInputTokens": 32000
      }
    }
  }
}
```

Supported fields are `reasoningEffort` (`none`, `minimal`, `low`, `medium`,
`high`, or `max`), `temperature` (`0`–`2`), `stream`, `maxOutputTokens`, and
`maxInputTokens`. The input-token limit uses a local text-size heuristic,
including structured message content; it is not provider billing telemetry.

Policy precedence is:

```text
downstream body
  < logical model request
  < task subtype request
  < real-model compatibility adapter
  < provider/Key request policy
```

The later layer is authoritative when two layers set the same wire field. A
task subtype inherits logical settings it does not specify, including session
affinity, weak fallback, protected capacity, and request policy. Select a task
with the `x-tomato-tap-task` request header; the legacy `x-mimo-task` spelling
is accepted during the `0.x` compatibility period.

A relay may use the same `request` fields as a final provider-specific
guardrail. This is appropriate for a provider that rejects streaming, enforces
a token ceiling, or only supports one reasoning mode. Do not duplicate RPM,
concurrency, or egress policy in a logical route.

### Inspecting a route

The route-plan endpoint resolves policy and reads current eligibility without
calling an upstream or reserving capacity:

```bash
curl 'http://127.0.0.1:8888/__route/plan?model=classifier&task=short_classification'
curl 'http://127.0.0.1:8888/readyz?model=classifier&task=short_classification'
curl 'http://127.0.0.1:8888/readyz?model=classifier&mode=available'
```

The plan includes the merged request policy, candidate state counts, recovery
time, current preferred deployment, and its decision basis. It is an
instantaneous explanation rather than a reservation: a concurrent request may
change capacity before dispatch. `exclude_vendor` accepts a comma-separated
list for diagnostics. These operator endpoints follow the gateway bind and
authentication boundary; keep them on loopback or protect the instance when
binding remotely.

Readiness defaults to `mode=dispatchable`, which includes unvalidated probing
deployments so a new installation can bootstrap. `mode=available` is the
strict traffic-gate view and returns 200 only after a deployment/model pair has
produced a validated response. Invalid responses trigger per-pair exponential
qualification backoff. Defaults are 30 seconds initially and 15 minutes
maximum; operators can change them with
`TOMATO_TAP_QUALIFICATION_BACKOFF_BASE` and
`TOMATO_TAP_QUALIFICATION_BACKOFF_MAX`.

## Secret handling

The env parser reads assignments as data; it never evaluates shell syntax.
Environment variables inherited by the process take precedence over the env
file. Credentials are redacted from status payloads, logs, and persisted state.

Keep private inventories under `config/local/`, which is ignored by Git. Do not
store keys in JSON metadata, command history, issue reports, or test fixtures.
