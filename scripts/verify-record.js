#!/usr/bin/env node
/**
 * CLI verifier. Resolves a DAO DID via the configured registry host, runs
 * the full verification flow, and prints the result.
 *
 * Usage:
 *   node scripts/verify-record.js <registryId>
 *   node scripts/verify-record.js did:web:nhdaoregistry.example:dao:<id>
 */

import 'dotenv/config';
import { verifyDao } from '../src/verifier.js';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/verify-record.js <registryId | did:web:...>');
    process.exit(2);
  }
  const host = process.env.REGISTRY_HOST || 'localhost:3000';
  const scheme = process.env.REGISTRY_SCHEME || 'http';
  const report = await verifyDao(arg, { host, scheme });

  const tick = (b) => b ? '✔' : '✘';
  console.log(`\nDID:    ${report.did}`);
  if (report.agentDid) console.log(`Agent:  ${report.agentDid}`);
  console.log(`Result: ${report.ok ? 'verified' : 'verification failed'}\n`);
  for (const c of report.checks) {
    console.log(`  ${tick(c.ok)} ${c.name.padEnd(34)} ${c.detail}`);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
