#!/usr/bin/env node
/**
 * Reconciliation sweep for unanchored or partially-anchored records.
 *
 * Walks `data/records/<id>/meta.json`, finds entries whose `status` is
 * `pending`, `partial`, or `unanchored`, and re-attempts the missing chain
 * anchor(s) for each. Updates `meta.json` and the corresponding `dao.json` /
 * `agent.json` in place once the anchor confirms.
 *
 * Idempotent: an already-anchored record (or one whose anchor for that kind
 * already exists on chain) is skipped. The contract enforces strict version
 * monotonicity so a duplicate retry surfaces a `version already anchored`
 * permanent error which is detected and treated as success here (the chain
 * already has what we wanted).
 *
 * Usage:
 *   node scripts/reanchor.js               # sweep all records
 *   node scripts/reanchor.js <registryId>  # one specific record
 *   node scripts/reanchor.js --dry-run     # report only, no chain calls
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { listRegistryIds, loadMeta, loadDao, loadAgent } from '../src/store.js';
import { recordAnchor, anchorEnabled, isPermanentAnchorError, KIND } from '../src/anchor.js';
import { attachAnchor } from '../src/didweb.js';

const ROOT = path.join('data', 'records');

function deriveStatus({ anchors, anchorErrors }, enabled) {
  if (!enabled) return 'anchor-disabled';
  if (anchors.dao && anchors.agent) return 'anchored';
  if (anchors.dao || anchors.agent) return 'partial';
  if (anchorErrors.dao || anchorErrors.agent) return 'unanchored';
  return 'pending';
}

function rebuildWarnings(meta, enabled) {
  const out = [];
  const pps = meta.governance && meta.governance.publicPinStatus;
  if (pps && pps.state !== 'pinned' && pps.state !== 'not-configured') {
    out.push({ category: 'ipfs', ...pps });
  }
  if (enabled) {
    if (meta.anchorErrors.dao)   out.push({ category: 'anchor', kind: 'dao',   detail: meta.anchorErrors.dao.message });
    if (meta.anchorErrors.agent) out.push({ category: 'anchor', kind: 'agent', detail: meta.anchorErrors.agent.message });
  } else {
    out.push({ category: 'anchor', kind: 'config', detail: 'chain anchor disabled (AMOY_RPC_URL/ANCHOR_CONTRACT_ADDRESS/ANCHOR_PRIVATE_KEY not set)' });
  }
  return out;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function reanchorOne(registryId, { dryRun }) {
  const meta = loadMeta(registryId);
  if (!meta) return { registryId, skipped: 'no meta' };

  const enabled = anchorEnabled();
  if (!enabled) return { registryId, skipped: 'anchor disabled (env not set)' };

  const needsDao   = !meta.anchors.dao;
  const needsAgent = !meta.anchors.agent;
  if (!needsDao && !needsAgent) return { registryId, skipped: 'already anchored' };

  if (dryRun) {
    return { registryId, dryRun: true, needsDao, needsAgent, status: meta.status };
  }

  const dir = path.join(ROOT, registryId);
  let dao   = loadDao(registryId);
  let agent = loadAgent(registryId);
  const daoHashHex   = meta.daoHash.replace(/^sha256:/, '');
  const agentHashHex = meta.agentHash.replace(/^sha256:/, '');
  const filed = meta.filed;

  if (needsDao) {
    try {
      meta.anchors.dao = await recordAnchor(registryId, KIND.DAO, meta.version, daoHashHex);
      meta.anchorErrors.dao = null;
      dao = attachAnchor(dao, {
        chainId: meta.anchors.dao.chainIdCaip2,
        txHash:  meta.anchors.dao.txHash,
        anchoredAt: filed,
        version: meta.version,
        contentHash: `sha256:${daoHashHex}`,
      });
      writeJson(path.join(dir, 'dao.json'), dao);
    } catch (e) {
      // "version already anchored" means the chain already has it; treat as benign.
      if (isPermanentAnchorError(e) && /already anchored/i.test(e.shortMessage || e.message)) {
        meta.anchorErrors.dao = { message: 'already anchored on chain (skipping local update)' };
      } else {
        meta.anchorErrors.dao = { message: e.shortMessage || e.message };
      }
    }
  }

  if (needsAgent) {
    try {
      meta.anchors.agent = await recordAnchor(registryId, KIND.AGENT, meta.version, agentHashHex);
      meta.anchorErrors.agent = null;
      agent = attachAnchor(agent, {
        chainId: meta.anchors.agent.chainIdCaip2,
        txHash:  meta.anchors.agent.txHash,
        anchoredAt: filed,
        version: meta.version,
        contentHash: `sha256:${agentHashHex}`,
      });
      writeJson(path.join(dir, 'agent.json'), agent);
    } catch (e) {
      if (isPermanentAnchorError(e) && /already anchored/i.test(e.shortMessage || e.message)) {
        meta.anchorErrors.agent = { message: 'already anchored on chain (skipping local update)' };
      } else {
        meta.anchorErrors.agent = { message: e.shortMessage || e.message };
      }
    }
  }

  meta.status   = deriveStatus(meta, enabled);
  meta.warnings = rebuildWarnings(meta, enabled);
  writeJson(path.join(dir, 'meta.json'), meta);

  return {
    registryId,
    status: meta.status,
    daoOk:   !!meta.anchors.dao,
    agentOk: !!meta.anchors.agent,
    daoErr:   meta.anchorErrors.dao   && meta.anchorErrors.dao.message,
    agentErr: meta.anchorErrors.agent && meta.anchorErrors.agent.message,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicit = args.filter(a => !a.startsWith('--'));

  const targets = explicit.length > 0 ? explicit : listRegistryIds();
  if (targets.length === 0) {
    console.log('reanchor: no records under data/records/');
    return;
  }

  const results = [];
  for (const id of targets) {
    const r = await reanchorOne(id, { dryRun });
    results.push(r);
    if (r.skipped) {
      console.log(`  - ${id.padEnd(40)} skipped: ${r.skipped}`);
    } else if (r.dryRun) {
      console.log(`  ? ${id.padEnd(40)} would re-anchor (dao=${r.needsDao}, agent=${r.needsAgent}, status=${r.status})`);
    } else {
      const tick = r.status === 'anchored' ? '✔' : (r.status === 'partial' ? '~' : '✘');
      console.log(`  ${tick} ${id.padEnd(40)} status=${r.status} dao=${r.daoOk}, agent=${r.agentOk}${r.daoErr ? ` daoErr="${r.daoErr}"` : ''}${r.agentErr ? ` agentErr="${r.agentErr}"` : ''}`);
    }
  }

  const fixed   = results.filter(r => r.status === 'anchored').length;
  const partial = results.filter(r => r.status === 'partial').length;
  const failed  = results.filter(r => r.status === 'unanchored').length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`\nSummary: ${fixed} anchored, ${partial} partial, ${failed} still unanchored, ${skipped} skipped (of ${results.length} scanned)`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
