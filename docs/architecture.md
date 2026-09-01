# Architecture

## Request path

```text
client
  -> gateway admission and bounded body reader
  -> route, task, and layered request-policy resolution
  -> candidate eligibility and capacity scheduler
  -> real-model compatibility and provider request adapters
  -> egress transport
  -> response validation and metadata annotation
  -> usage ledger
```

The application composition root is `src/app/server.mjs`. Lower-level modules
do not import it. Mutable services are created there and injected into the
ordinary and logical dispatchers.

## Module ownership

- `config` parses strict files and stages immutable runtime generations.
- `gateway` owns HTTP admission, control endpoints, model inventory responses,
  and protocol-shaped errors.
- `routing` owns logical policies, candidate eligibility, scheduling, retries,
  request adaptation, and response validation.
- `providers` owns provider/relay metadata, protocol adapters, and quota probes.
- `admin` owns the loopback console and atomic operator-configuration writes;
  it does not own routing or retain plaintext credentials in responses. Its
  Provider/Key/Model/Route/Egress view is a facade over the strict v0.1 relay,
  model, and env documents; the runtime remains the source of dispatch truth.
- `egress` owns outbound HTTP agents, proxy subscriptions, sticky bindings, and
  sing-box child processes.
- `state` owns per-key AIMD capacity, cooldown, and rate-limit transitions.
- `usage` owns model prices, the append-only ledger, aggregation, and HTML/JSON
  reporting.
- `telemetry` owns opt-in raw samples and their lifecycle.

Shared modules expose constructors or pure functions. Network and filesystem
side effects are started only by executable entry points.

## Policy composition

Client input is first combined with logical-model policy and then optional task
subtype policy. Real-model adapters enforce wire compatibility, and a
deployment's request policy is the final provider-specific guardrail. Missing
task fields inherit from the logical model; explicit task booleans can override
logical booleans. The compiled policy is immutable for the lifetime of a
runtime generation.

Candidate strategy is independent of eligibility. `fair`, `ordered`, and
`adaptive` only rank deployments that already satisfy capability, quality,
quota, cooldown, rate-limit, capacity, and egress checks. This keeps routing
preference from bypassing failure isolation.

## Runtime generations

The configuration loader hashes the env file and all selected JSON documents.
A changed revision is fully parsed and cross-validated before staging. The
current generation remains active while requests are in flight. Once idle, the
new key pool, model policy, quota policy, and egress bindings activate together.
Failed revisions are reported in `/__status` and never partially apply.

## Candidate qualification

Availability is derived from one qualification registry. A deployment/model
pair can be disabled, missing a credential, expired, blocked, cooling down,
congested, probing, unhealthy, or ready. Only ready pairs are advertised as
available. Probing candidates remain dispatchable so a recovered provider can
prove itself without an operator restart.

Persisted qualifications contain an irreversible configuration fingerprint,
not the key. A changed key, host, protocol, path, or deployment ID invalidates
the old record.

`/__route/plan` uses the same policy resolver, deployment registry, eligibility
summary, and scheduler score as dispatch, but it neither acquires a slot nor
calls an upstream. Its selection is therefore a current prediction, not a
reservation. `/healthz` reports process liveness. `/readyz` defaults to
dispatchable capacity so a new installation can bootstrap unvalidated
deployments; `/readyz?mode=available` requires at least one recently validated
success. Neither endpoint promotes an unvalidated candidate to `available`.

An invalid response places only that deployment/model pair into qualification
backoff. The delay grows exponentially from 30 seconds to 15 minutes by
default. When the delay expires, the pair becomes `probing` for recovery; a
validated response returns it to `ready`. This avoids retrying the same invalid
200 on every downstream request without requiring an operator restart.

## Failure isolation

- Model-specific failures cool only the key/model pair.
- Credential failures cool the affected key.
- Sticky egress failures cool only keys bound to that node.
- Logical admission and request deadlines are bounded.
- Invalid successful responses are retried internally and never advertised as
  healthy.
- Invalid and failed logical attempts are written as separate usage events.
  Upstream-reported token usage is charged even when the response is withheld
  from the downstream client; network failures without usage are audit-only.

## Data isolation

Tracked source files must be reproducible without operator secrets. `.env`,
`config/local/`, and `runtime/` are ignored. The repository check rejects known
credential formats, private workstation paths, and proxy URIs outside fixtures.
Raw request/response samples are disabled by default and are subject to both
retention and aggregate-size cleanup when enabled.

An ordinary relay with no configured User-Agent forwards the downstream header
unchanged. A non-empty per-relay value overrides it. Adapter-required client
identities are explicit protocol exceptions. A process-level default is only a
fallback when the downstream request omitted User-Agent entirely.
