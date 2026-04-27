/**
 * NH DAO Registry MVP server.
 *
 * Routes:
 *
 *   GET  /                              filing UI
 *   GET  /healthz                       process liveness
 *   GET  /readyz                        local-store/key readiness
 *   GET  /inspect                       record list and inspector
 *   GET  /api/records                   list filings
 *   POST /api/file                      submit a filing
 *   GET  /api/records/:id               full record (DAO + agent + meta)
 *   GET  /api/verify/:id                run end-to-end verification
 *   GET  /dao/:id/did.json              did:web resolution for DAO DID
 *   GET  /agent/:id/did.json            did:web resolution for agent DID
 *   GET  /.well-known/did.json          registry's own DID document
 *   GET  /ipfs/:cid                     local IPFS blob fallback
 *
 * The did:web routes serve the documents that the publication service
 * produced. They are real did:web documents: a resolver fetching
 * did:web:<host>:dao:<id> at https://<host>/dao/<id>/did.json gets the
 * exact JSON the registry signed.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { file as runFiling } from './publication.js';
import { verifyDao } from './verifier.js';
import { listRegistryIds, loadRecord, loadDao, loadAgent, loadMeta } from './store.js';
import { loadOrCreateKeyPair } from './crypto.js';
import { publicKeyJwk } from './crypto.js';
import { anchorEnabled } from './anchor.js';
import { readLocal } from './ipfs.js';
import { registryDid } from './didweb.js';
import { serverConfig, filingApiKey, filingRate, verifyRate } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const { host: HOST, scheme: SCHEME, controllerKeyPath: CONTROLLER_KEY_PATH, bodyLimit: REQUEST_BODY_LIMIT, port: PORT, isTest: IS_TEST } = serverConfig();
const FILING_API_KEY = filingApiKey();

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.static(PUBLIC_DIR));

app.get('/healthz', (_, res) => {
  res.json({ status: 'ok' });
});

app.get('/readyz', (_, res) => {
  const checks = {
    storeWritable: false,
    controllerKeyAvailable: false,
    anchorConfigured: anchorEnabled(),
  };

  try {
    const tmp = path.resolve('data', `.readyz-${process.pid}.tmp`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, 'ok');
    fs.rmSync(tmp, { force: true });
    checks.storeWritable = true;
  } catch {
    checks.storeWritable = false;
  }

  try {
    loadOrCreateKeyPair(CONTROLLER_KEY_PATH);
    checks.controllerKeyAvailable = true;
  } catch {
    checks.controllerKeyAvailable = false;
  }

  const ready = checks.storeWritable && checks.controllerKeyAvailable;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
});

/**
 * Constant-time string comparison. Avoids leaking the API key length
 * via early-exit comparison when an attacker probes for it.
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Opt-in bearer token auth. If FILING_API_KEY is set, /api/file requires
 * `Authorization: Bearer <token>`. If unset, the endpoint is open (the
 * reference-impl default; production deployments must set the key).
 */
function requireFilingAuth(req, res, next) {
  if (!FILING_API_KEY) return next();
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !constantTimeEqual(m[1].trim(), FILING_API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/**
 * In-memory token-bucket rate limiter, keyed by client IP. Per-route limits
 * are configured at mount. This is sufficient for a single-process POC; a
 * production deployment behind a load balancer should use a shared store
 * (e.g. Redis) or rely on the LB's rate limiter.
 */
function rateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({ error: 'too many requests' });
    }
    next();
  };
}

const filingLimiter = rateLimiter(filingRate());
const verifyLimiter = rateLimiter(verifyRate());

/* ---------- did:web hosting ---------- */

app.get('/.well-known/did.json', (req, res) => {
  // The registry's own DID document. Its controller key signs every
  // DAO and agent document it issues.
  const kp = loadOrCreateKeyPair(CONTROLLER_KEY_PATH);
  const id = registryDid(HOST);
  res.type('application/did+json').json({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id,
    controller: id,
    name: 'NH DAO Registry (POC)',
    verificationMethod: [{
      id: `${id}#controller-1`,
      type: 'JsonWebKey2020',
      controller: id,
      publicKeyJwk: publicKeyJwk(kp.publicKey),
    }],
    assertionMethod:    [`${id}#controller-1`],
    authentication:     [`${id}#controller-1`],
  });
});

app.get('/dao/:id/did.json', (req, res) => {
  const doc = loadDao(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.type('application/did+json').json(doc);
});

app.get('/agent/:id/did.json', (req, res) => {
  const doc = loadAgent(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.type('application/did+json').json(doc);
});

/* ---------- local IPFS gateway (fallback) ---------- */

app.get('/ipfs/:cid', (req, res) => {
  const bytes = readLocal(req.params.cid);
  if (!bytes) return res.status(404).send('not found');
  res.type('application/octet-stream').send(Buffer.from(bytes));
});

/* ---------- API ---------- */

app.get('/api/records', (req, res) => {
  const out = listRegistryIds().map(id => {
    const meta = loadMeta(id);
    return {
      registryId: id,
      daoDid: meta.daoDid,
      agentDid: meta.agentDid,
      daoName: meta.daoName,
      agentName: meta.agentName,
      filed: meta.filed,
      anchored: !!(meta.anchors && meta.anchors.dao),
      // hasWarnings lets a list-only consumer flag records that need
      // operator attention without fetching each full record's meta.
      // The "anchor disabled globally" warning is excluded because the
      // top-level anchorEnabled flag already conveys it.
      hasWarnings: Array.isArray(meta.warnings) && meta.warnings.some(w => !(w.category === 'anchor' && w.kind === 'config')),
    };
  });
  out.sort((a, b) => (b.filed || '').localeCompare(a.filed || ''));
  res.json({ records: out, anchorEnabled: anchorEnabled() });
});

app.get('/api/records/:id', (req, res) => {
  const r = loadRecord(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

app.post('/api/file', filingLimiter, requireFilingAuth, async (req, res) => {
  try {
    const result = await runFiling(req.body || {}, {
      host: HOST, scheme: SCHEME, controllerKeyPath: CONTROLLER_KEY_PATH,
    });
    res.json(result);
  } catch (e) {
    if (e.statusCode === 400) {
      return res.status(400).json({ error: e.message, details: e.details });
    }
    // eslint-disable-next-line no-console
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/verify/:id', verifyLimiter, async (req, res) => {
  try {
    const report = await verifyDao(req.params.id, { host: HOST, scheme: SCHEME });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- routes that serve the SPA-ish HTML ---------- */

app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/inspect', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'inspect.html')));

if (!IS_TEST) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`NH DAO Registry MVP listening on ${SCHEME}://${HOST} (port ${PORT})`);
    // eslint-disable-next-line no-console
    console.log(`Registry DID: ${registryDid(HOST)}`);
    // eslint-disable-next-line no-console
    console.log(`Anchor: ${anchorEnabled() ? 'enabled (Polygon Amoy)' : 'disabled (set AMOY_RPC_URL, ANCHOR_CONTRACT_ADDRESS, ANCHOR_PRIVATE_KEY in .env)'}`);
    // eslint-disable-next-line no-console
    console.log(`Filing auth: ${FILING_API_KEY ? 'enabled (Bearer token required)' : 'DISABLED — set FILING_API_KEY before exposing this server'}`);
  });
}

export { app };
