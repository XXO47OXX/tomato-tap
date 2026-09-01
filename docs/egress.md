# Egress management

Egress policy is opt-in per deployment. The default is a direct connection.

## Modes

- `false` or omitted: direct connection.
- `true`: use the process-wide HTTP(S) proxy.
- `{"mode":"sticky-auto"}`: assign one subscription node to each key and
  persist that assignment.
- `{"mode":"sticky","node":"<id>"}`: pin a key to an operator-selected
  redacted node ID.
- `tomato_tap_relay_<id>_proxy_url`: fixed HTTP proxy for one key; defined only in
  the secret env namespace.

The local console exposes the same choices under **Egress**. Subscription URLs,
raw nodes, and fixed HTTP proxy URLs are write-only fields; read APIs return only
configuration state and redacted node IDs. The provider editor selects a
Channel's policy. A model never changes a Key's egress directly: the selected
Channel/Key determines the egress so IP affinity remains stable.

Subscription and sticky-node changes participate in runtime hot reload. The
shared HTTP(S) transport is created at process start, so changing or clearing
its URL requires a Tomato Tap restart. When no dedicated URL is configured,
the console reports an inherited `HTTPS_PROXY`/`https_proxy` value as a
compatibility fallback instead of hiding it.

## Sticky lifecycle

Subscription text is parsed in memory. Stable node IDs are hashes of normalized
node data and do not reveal the URI. Bindings are written owner-only to
`runtime/proxy-bindings.json`. Generated sing-box files and health inventories
also remain under `runtime/`.

A binding does not silently move when its node fails. The same listener is
restarted, and only affected keys cool down. This preserves providers that bind
accounts to an egress IP. To intentionally reassign a key, change its explicit
node ID or remove only its local binding while the service is stopped.

## Secret inputs

```dotenv
TOMATO_TAP_PROXY_SUBSCRIPTION_URL=https://provider.example/private-subscription
TOMATO_TAP_PROXY_SUBSCRIPTION_URLS=https://provider.example/a,https://provider.example/b
TOMATO_TAP_PROXY_STATIC_NODES=<private-node-uri>
TOMATO_TAP_SING_BOX_BIN=sing-box
TOMATO_TAP_PROXY_PORT_START=11001
TOMATO_TAP_PROXY_PORT_END=11999
# Optional shared proxy for relays with `proxy: true`.
TOMATO_TAP_SHARED_PROXY_URL=http://127.0.0.1:7890
# Optionally force one vendor through the shared proxy.
TOMATO_TAP_SHARED_PROXY_VENDOR=relay
```

Do not place subscription URLs or raw nodes in `relays.json`. They frequently
embed credentials.

## Operator tools

```bash
node tools/egress/check-nodes.mjs --write
node tools/egress/check-http-proxies.mjs --write /path/to/proxies.txt
node tools/egress/start-pool.mjs
node tools/egress/start-pool.mjs --status
node tools/egress/start-pool.mjs --stop
```

The tools require an explicit file/env input and never scan a workstation's
Downloads directory. Local listeners bind to `127.0.0.1`.
