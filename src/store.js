/**
 * Filesystem-backed record store.
 *
 * Each filing produces:
 *   data/records/<registryId>/dao.json     (latest DAO DID document)
 *   data/records/<registryId>/agent.json   (latest agent DID document)
 *   data/records/<registryId>/meta.json    (filing metadata, anchor info)
 *   data/records/<registryId>/governance.bin (raw bytes pinned to IPFS)
 *
 * The Express server reads these to serve did:web URLs and the inspector.
 *
 * For production the same shape would land in Postgres (and the contract
 * is the source of truth for hash-versus-version correspondence). For the
 * POC, files on disk are easier to inspect by hand.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join('data', 'records');
const ADMIN_AUDIT = path.join('data', 'admin-audit.log');

function dir(registryId) {
  return path.join(ROOT, registryId);
}

export function exists(registryId) {
  return fs.existsSync(path.join(dir(registryId), 'meta.json'));
}

export function listRegistryIds() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT).filter(n => fs.existsSync(path.join(ROOT, n, 'meta.json')));
}

/**
 * Atomically reserve a registry directory. Uses `mkdir` with `recursive:false`
 * so that two concurrent filings cannot both succeed for the same id: the
 * second mkdir throws EEXIST. Returns true on reservation, false if taken.
 *
 * The parent ROOT directory is created up front (recursive:true is fine for
 * that — we only need the leaf to be a uniqueness gate).
 */
export function reserveRegistryId(registryId) {
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    fs.mkdirSync(dir(registryId), { recursive: false });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/** Remove a reserved-but-unused directory (call on rollback). */
export function releaseRegistryId(registryId) {
  const d = dir(registryId);
  // Only remove if the meta file was never written (i.e. nothing of value here).
  if (fs.existsSync(d) && !fs.existsSync(path.join(d, 'meta.json'))) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

export function saveRecord(registryId, { dao, agent, meta, governanceBytes }) {
  const d = dir(registryId);
  fs.mkdirSync(d, { recursive: true });
  writeJsonAtomic(path.join(d, 'dao.json'), dao);
  writeJsonAtomic(path.join(d, 'agent.json'), agent);
  writeJsonAtomic(path.join(d, 'meta.json'), meta);
  if (governanceBytes) writeFileAtomic(path.join(d, 'governance.bin'), Buffer.from(governanceBytes));
}

export function saveMeta(registryId, meta) {
  if (!exists(registryId)) return false;
  writeJsonAtomic(path.join(dir(registryId), 'meta.json'), meta);
  return true;
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function loadRecord(registryId) {
  if (!exists(registryId)) return null;
  const d = dir(registryId);
  return {
    dao:   JSON.parse(fs.readFileSync(path.join(d, 'dao.json'),   'utf8')),
    agent: JSON.parse(fs.readFileSync(path.join(d, 'agent.json'), 'utf8')),
    meta:  JSON.parse(fs.readFileSync(path.join(d, 'meta.json'),  'utf8')),
  };
}

export function loadDao(registryId) {
  if (!exists(registryId)) return null;
  return JSON.parse(fs.readFileSync(path.join(dir(registryId), 'dao.json'), 'utf8'));
}

export function loadAgent(registryId) {
  if (!exists(registryId)) return null;
  return JSON.parse(fs.readFileSync(path.join(dir(registryId), 'agent.json'), 'utf8'));
}

export function loadMeta(registryId) {
  if (!exists(registryId)) return null;
  return JSON.parse(fs.readFileSync(path.join(dir(registryId), 'meta.json'), 'utf8'));
}

export function appendAdminAudit(event) {
  fs.mkdirSync(path.dirname(ADMIN_AUDIT), { recursive: true });
  fs.appendFileSync(ADMIN_AUDIT, `${JSON.stringify(event)}\n`);
}

export function listAdminAudit(registryId) {
  if (!fs.existsSync(ADMIN_AUDIT)) return [];
  return fs.readFileSync(ADMIN_AUDIT, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(event => event && (!registryId || event.registryId === registryId));
}
