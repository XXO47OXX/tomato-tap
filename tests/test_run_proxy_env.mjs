import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../scripts/run.sh', import.meta.url), 'utf8');
assert.match(
  script,
  /export NODE_USE_ENV_PROXY="\$\{NODE_USE_ENV_PROXY:-1\}"/,
  'supervisor must enable Node fetch support for HTTP(S)_PROXY',
);
assert.match(
  script,
  /QUOTA_PROBER_SCRIPT=.*quota-prober\.mjs/,
  'supervisor must define the independent quota prober child',
);
assert.match(
  script,
  /quota-prober\.pid/,
  'supervisor must track the quota prober in a separate pid file',
);
assert.match(
  script,
  /nohup setsid "\$0" _supervise/,
  'supervisor must detach from the invoking process group',
);

const proxySource = readFileSync(new URL('../src/app/server.mjs', import.meta.url), 'utf8');
assert.match(
  proxySource,
  /server\.close\(async \(\) => \{[\s\S]*await QUOTA_CONTROL_SERVER\.close\(\);[\s\S]*await STICKY_PROXY_RUNTIME\.stopAll\(\)/,
  'server shutdown must await sticky child termination',
);

console.log('test_run_proxy_env: ok');
