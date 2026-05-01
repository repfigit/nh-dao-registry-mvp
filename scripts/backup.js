#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const RECORDS_DIR = path.join(DATA_DIR, 'records');
const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
const AUDIT_FILE = path.join(DATA_DIR, 'admin-audit.log');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readBase64(file) {
  return fs.readFileSync(file).toString('base64');
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).isDirectory());
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).isFile());
}

function exportRecord(dir) {
  const registryId = path.basename(dir);
  const record = { registryId };
  for (const name of ['dao.json', 'agent.json', 'meta.json']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) record[name.replace('.json', '')] = readJson(file);
  }
  const governance = path.join(dir, 'governance.bin');
  if (fs.existsSync(governance)) record.governanceBytesBase64 = readBase64(governance);
  return record;
}

function exportAudit() {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs.readFileSync(AUDIT_FILE, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return { parseError: true, raw: line }; }
    });
}

const outFile = process.argv[2] || path.join(DATA_DIR, 'backups', `registry-backup-${timestamp()}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });

const snapshot = {
  exportedAt: new Date().toISOString(),
  format: 'nh-dao-registry-backup/v1',
  records: listDirs(RECORDS_DIR).map(exportRecord),
  blobs: listFiles(BLOBS_DIR).map(file => ({
    name: path.basename(file),
    bytesBase64: readBase64(file),
  })),
  adminAudit: exportAudit(),
};

fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify({
  output: outFile,
  records: snapshot.records.length,
  blobs: snapshot.blobs.length,
  auditEvents: snapshot.adminAudit.length,
}, null, 2));
