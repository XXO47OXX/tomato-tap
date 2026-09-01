#!/usr/bin/env node
import { applyLegacyEnvAliases } from '../src/config/env-compat.mjs';
import { runQuotaProber } from '../src/providers/quota/quota-prober.mjs';

applyLegacyEnvAliases(process.env, { warn: true });
await runQuotaProber();
