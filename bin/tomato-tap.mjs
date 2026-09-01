#!/usr/bin/env node

import { applyLegacyEnvAliases } from '../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env, { warn: true });
await import('../src/app/server.mjs');
