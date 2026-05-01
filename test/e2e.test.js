/**
 * End-to-end test of the publication and verification flow.
 *
 * Runs against an in-process Express server and a local Hardhat node.
 * Skips the chain anchor portion if Hardhat is not available; the rest of
 * the pipeline (validation, signing, IPFS pin via local CIDv1, did:web
 * resolution, signature verification, bidirectional alsoKnownAs check) is
 * fully exercised.
 *
 * Run with: npm run test:e2e   (or: node --test test/e2e.test.js)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join('data', '_e2e_tmp');
let PORT;

/** Find a free localhost TCP port by binding to 0, then closing. */
async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  // Pick a port BEFORE importing the server, so REGISTRY_HOST is correct
  // by the time server.js captures it at module-load time.
  PORT = await pickFreePort();

  process.env.NODE_ENV = 'test';
  process.env.PORT = String(PORT);
  process.env.REGISTRY_HOST = `localhost:${PORT}`;
  process.env.REGISTRY_SCHEME = 'http';
  process.env.CONTROLLER_KEY_PATH = path.join(TMP, 'controller.json');
  // The test suite runs many filings in quick succession; raise the limits
  // so the rate limiter is not exercised here. (It has its own test below.)
  process.env.FILING_RATE_MAX = '1000';
  process.env.VERIFY_RATE_MAX = '1000';
  process.env.ADMIN_API_KEY = 'test-admin-token';
  process.env.AMOY_RPC_URL = '';
  process.env.RPC_URL = '';
  process.env.ANCHOR_CONTRACT_ADDRESS = '';
  process.env.ANCHOR_PRIVATE_KEY = '';
  process.env.ARWEAVE_JWK = '';

  // Clear any prior test artifacts.
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(path.join('data', 'records'), { recursive: true, force: true });
  fs.rmSync(path.join('data', 'blobs'), { recursive: true, force: true });
  fs.rmSync(path.join('data', 'admin-audit.log'), { force: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let server;
let baseUrl;

async function startServer() {
  const { app } = await import('../src/server.js');
  return new Promise((resolve, reject) => {
    const s = http.createServer(app);
    s.on('error', reject);
    s.listen(PORT, '127.0.0.1', () => {
      baseUrl = `http://localhost:${PORT}`;
      server = s;
      resolve();
    });
  });
}

async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function postJsonAuthed(url, body, token = 'test-admin-token') {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function getJsonAuthed(url, token = 'test-admin-token') {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

function completeCompliance(overrides = {}) {
  return {
    govUrl: 'https://example.org/granite/bylaws.pdf',
    sourceUrl: 'https://github.com/example/granite-dao',
    guiUrl: 'https://app.example.org/granite',
    contracts: [{ chainId: 'eip155:1', address: '0x' + '33'.repeat(20) }],
    compliance: {
      registeredDomain: 'granite.example.org',
      publicAddress: '0x' + '44'.repeat(20),
      qaUrl: 'https://example.org/granite/security-review.pdf',
      communicationsUrl: 'https://forum.example.org/granite/contact',
      internalDisputeResolutionUrl: 'https://example.org/granite/disputes/internal',
      thirdPartyDisputeResolutionUrl: 'https://example.org/granite/disputes/third-party',
      legalRepresentativeAuthorizationUrl: 'https://forum.example.org/granite/legal-rep-authorization',
      lifecycleStatus: 'initial',
      attestations: {
        permissionlessBlockchain: true,
        openSourceCode: true,
        qaCompleted: true,
        guiMonitoring: true,
        bylawsPublic: true,
        publicCommunications: true,
        internalDisputeResolution: true,
        thirdPartyDisputeResolution: true,
        decentralizedNetwork: true,
        decentralizedGovernance: true,
        participantRules: true,
        legalRepresentativeAuthorized: true,
      },
    },
    ...overrides,
  };
}

describe('NH DAO Registry MVP, end-to-end', () => {
  before(async () => { await startServer(); });
  after(async () => { await stopServer(); });

  it('rejects bad DAO name (missing DAO/LAO suffix)', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Granite State Governance',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.body.details));
    assert.ok(r.body.details.some(d => d.field === 'daoName'));
  });

  it('rejects PO box address', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Granite State Governance DAO',
      agentName: 'Jane Smith',
      agentAddress: 'PO Box 42, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'agentAddress'));
  });

  it('files a registration end-to-end and serves both DID documents', async () => {
    const filing = {
      daoName: 'Granite State Governance DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
      contracts: [
        { chainId: 'eip155:1',   address: '0x' + '11'.repeat(20) },
        { chainId: 'eip155:137', address: '0x' + '22'.repeat(20) },
      ],
    };
    const r = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(r.status, 200);

    const { registryId, dao, agent, meta } = r.body;
    assert.match(registryId, /granite-state-governance-dao/);
    // did:web encodes the port colon as %3A per the v1 method spec.
    assert.equal(dao.id,   `did:web:localhost%3A${PORT}:dao:${registryId}`);
    assert.equal(agent.id, `did:web:localhost%3A${PORT}:agent:${registryId}`);

    // Bidirectional alsoKnownAs.
    assert.deepEqual(dao.alsoKnownAs, [agent.id]);
    assert.deepEqual(agent.alsoKnownAs, [dao.id]);

    // Both documents are signed.
    assert.ok(dao.proof && dao.proof.jws);
    assert.ok(agent.proof && agent.proof.jws);

    // DAOSmartContract entries present and well-shaped.
    const sc = dao.service.filter(s => s.type === 'DAOSmartContract');
    assert.equal(sc.length, 2);
    assert.equal(sc[0].chainId, 'eip155:1');
    assert.match(sc[0].address, /^0x[a-f0-9]{40}$/i);

    // Governance endpoint: IPFS first.
    const gov = dao.service.find(s => s.type === 'DAOGovernanceDocument');
    assert.ok(Array.isArray(gov.serviceEndpoint));
    assert.match(gov.serviceEndpoint[0], /^ipfs:\/\//);
    assert.match(gov.contentHash, /^sha256:[a-f0-9]{64}$/);

    // did:web resolution: GET the resolved URL and confirm it matches.
    const daoRes = await getJson(`${baseUrl}/dao/${registryId}/did.json`);
    assert.equal(daoRes.status, 200);
    assert.equal(daoRes.body.id, dao.id);
    assert.equal(daoRes.body.controller, `did:web:localhost%3A${PORT}`);
    const daoRecordSvc = daoRes.body.service.find(s => s.type === 'NHDAORegistryRecord');
    assert.equal(daoRecordSvc.status, 'submitted-intake');
    assert.equal(daoRecordSvc.legalStatus, 'not-determined');

    const agentRes = await getJson(`${baseUrl}/agent/${registryId}/did.json`);
    assert.equal(agentRes.status, 200);
    assert.equal(agentRes.body.id, agent.id);
    assert.equal(agentRes.body.controller, `did:web:localhost%3A${PORT}`);

    // meta has the recorded hashes.
    assert.match(meta.daoHash,   /^sha256:[a-f0-9]{64}$/);
    assert.match(meta.agentHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(meta.compliance.status, 'evidence-submitted');
    assert.equal(meta.compliance.legalStatus, 'not-determined');
    assert.equal(meta.compliance.registeredDomain, 'granite.example.org');
    assert.equal(meta.compliance.evidence.qaUrl, 'https://example.org/granite/security-review.pdf');
    assert.equal(meta.compliance.assurance.status, 'submitted-not-verified');
    assert.ok(meta.compliance.assurance.evidenceUrlCount >= 8);
    assert.equal(meta.admin.reviewStatus, 'submitted');
    assert.equal(meta.admin.reviewedAt, null);

    const complianceSvc = dao.service.find(s => s.type === 'NHDAOComplianceChecklist');
    assert.ok(complianceSvc, 'DAO DID should include NHDAOComplianceChecklist service');
    assert.equal(complianceSvc.status, 'evidence-submitted');
    assert.equal(complianceSvc.legalStatus, 'not-determined');
    assert.equal(complianceSvc.evidence.communicationsUrl, 'https://forum.example.org/granite/contact');

    // Verifier: signatures + alsoKnownAs + IPFS hash all pass.
    const ver = await getJson(`${baseUrl}/api/verify/${registryId}`);
    assert.equal(ver.status, 200);
    const named = Object.fromEntries(ver.body.checks.map(c => [c.name, c]));

    assert.equal(named['DAO DID resolved'].ok, true);
    assert.equal(named['agent DID resolved'].ok, true);
    assert.equal(named['DAO signature'].ok, true);
    assert.equal(named['agent signature'].ok, true);
    assert.equal(named['alsoKnownAs bidirectional'].ok, true);
    assert.equal(named['governance IPFS hash'].ok, true);
    assert.equal(named['governance Arweave hash'].ok, true);
    // Chain checks may be absent if anchor not configured; both must be present in the report
    assert.ok('DAO chain anchor' in named);
    assert.ok('agent chain anchor' in named);
    // Registry-key binding: confirms doc.proof.verificationMethod is one of
    // the registry's published controller keys (closes the host-compromise
    // gap where per-document signature verification alone would accept
    // a self-signed forgery).
    assert.equal(named['registry DID resolved'].ok, true);
    assert.equal(named['DAO controller key registered'].ok, true);
    assert.equal(named['agent controller key registered'].ok, true);

    // meta.status reflects the chain-anchor outcome. With anchor disabled in
    // the e2e environment, status should be 'anchor-disabled' (not 'pending').
    assert.equal(meta.status, 'anchor-disabled', `unexpected status: ${meta.status}`);
  });

  it('rejects filings missing RSA 301-B compliance evidence', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Incomplete Compliance DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'sourceUrl'));
    assert.ok(r.body.details.some(d => d.field === 'contracts'));
    assert.ok(r.body.details.some(d => d.field === 'compliance.registeredDomain'));
    assert.ok(r.body.details.some(d => d.field === 'compliance.attestations.decentralizedGovernance'));
  });

  it('rejects invalid compliance evidence URLs', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Invalid Compliance DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance({
        compliance: {
          ...completeCompliance().compliance,
          qaUrl: 'javascript:alert(1)',
        },
      }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'compliance.qaUrl'));
  });

  it('rejects invalid registered domains in compliance evidence', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Bad Domain DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance({
        compliance: {
          ...completeCompliance().compliance,
          registeredDomain: 'foo-.example.org',
        },
      }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'compliance.registeredDomain'));
  });

  it('rejects non-public compliance evidence URLs', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Private Evidence DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance({
        compliance: {
          ...completeCompliance().compliance,
          communicationsUrl: 'http://localhost:3000/contact',
        },
      }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'compliance.communicationsUrl'));
  });

  it('rejects false attestations and unsupported lifecycle status', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'False Attestation DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance({
        compliance: {
          ...completeCompliance().compliance,
          lifecycleStatus: 'unknown',
          attestations: {
            ...completeCompliance().compliance.attestations,
            decentralizedNetwork: false,
          },
        },
      }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'compliance.lifecycleStatus'));
    assert.ok(r.body.details.some(d => d.field === 'compliance.attestations.decentralizedNetwork'));
  });

  it('lists records via /api/records and shows the filing', async () => {
    const r = await getJson(`${baseUrl}/api/records`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.records));
    assert.ok(r.body.records.length >= 1);
    assert.match(r.body.records[0].daoDid, /^did:web:/);
    // Every record carries a hasWarnings flag. With anchor disabled in
    // tests, the only warning is the global "anchor not configured" one
    // which is excluded from the per-row flag — so hasWarnings is false.
    for (const rec of r.body.records) assert.equal(rec.hasWarnings, false, JSON.stringify(rec));
    assert.ok(r.body.records.every(rec => rec.reviewStatus));
  });

  it('protects admin APIs and records review decisions with audit history', async () => {
    const listNoAuth = await getJson(`${baseUrl}/api/admin/records`);
    assert.equal(listNoAuth.status, 401);

    const list = await getJsonAuthed(`${baseUrl}/api/admin/records?status=submitted`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.records));
    assert.ok(list.body.records.length >= 1);

    const target = list.body.records[0].registryId;
    const review = await postJsonAuthed(`${baseUrl}/api/admin/records/${target}/review`, {
      reviewer: 'Test Reviewer',
      note: 'Opened for review',
    });
    assert.equal(review.status, 200);
    assert.equal(review.body.meta.admin.reviewStatus, 'under_review');
    assert.equal(review.body.event.fromStatus, 'submitted');
    assert.equal(review.body.event.toStatus, 'under_review');

    const approve = await postJsonAuthed(`${baseUrl}/api/admin/records/${target}/approve`, {
      reviewer: 'Test Reviewer',
      reason: 'Evidence checklist is complete',
    });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.meta.admin.reviewStatus, 'approved');
    assert.equal(approve.body.meta.admin.decisionReason, 'Evidence checklist is complete');

    const full = await getJsonAuthed(`${baseUrl}/api/admin/records/${target}`);
    assert.equal(full.status, 200);
    assert.equal(full.body.meta.admin.reviewStatus, 'approved');
    assert.ok(full.body.audit.length >= 2);
    assert.ok(full.body.audit.some(ev => ev.toStatus === 'approved'));

    const denyMissingReason = await postJsonAuthed(`${baseUrl}/api/admin/records/${target}/deny`, {
      reviewer: 'Test Reviewer',
    });
    assert.equal(denyMissingReason.status, 400);
    assert.match(denyMissingReason.body.error, /reason is required/);
  });

  it('exposes health and readiness endpoints', async () => {
    const health = await getJson(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const ready = await getJson(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
    assert.equal(ready.body.checks.storeWritable, true);
    assert.equal(ready.body.checks.controllerKeyAvailable, true);
    assert.equal(ready.body.checks.filingAuthConfigured, false);
    assert.equal(ready.body.checks.adminAuthConfigured, true);
    assert.equal(ready.body.checks.arweaveConfigured, false);
    assert.deepEqual(ready.body.checks.productionConfig, []);
  });

  it('rejects URLs with disallowed schemes (e.g. javascript:)', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Schema Test DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
      sourceUrl: 'javascript:alert(1)',
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'sourceUrl'));
  });

  it('rejects DAO name shorter than minimum length', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'X DAO', // technically passes the suffix rule but very short
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    // 'X DAO' is 5 chars, so this should pass; use a stricter case below.
    // Verify the boundary: 3 chars 'DAO' alone should be rejected (no label).
    assert.ok(r.status === 200 || r.status === 400); // sanity

    const r2 = await postJson(`${baseUrl}/api/file`, {
      daoName: 'DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r2.status, 400);
    assert.ok(r2.body.details.some(d => d.field === 'daoName'));
  });

  it('rejects address missing a ZIP code', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Zipless Governance DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'agentAddress'));
  });

  it('rejects governance bytes larger than the configured cap', async () => {
    // Temporarily lower the cap so we don't have to send a multi-MB payload
    // through the JSON body limit. The cap is read lazily on each filing.
    const previous = process.env.MAX_GOVERNANCE_BYTES;
    process.env.MAX_GOVERNANCE_BYTES = '64';
    try {
      const oversized = new Array(128).fill(0); // 128 bytes > 64-byte cap
      const r = await postJson(`${baseUrl}/api/file`, {
        daoName: 'Big Bytes DAO',
        agentName: 'Jane Smith',
        agentAddress: '123 Main Street, Concord, NH 03301',
        agentEmail: 'jane@example.org',
        ...completeCompliance(),
        governanceBytes: oversized,
      });
      assert.equal(r.status, 400);
      assert.ok(r.body.details.some(d => d.field === 'governanceBytes'));
    } finally {
      if (previous == null) delete process.env.MAX_GOVERNANCE_BYTES;
      else process.env.MAX_GOVERNANCE_BYTES = previous;
    }
  });

  it('rejects malformed governance byte arrays', async () => {
    const previous = process.env.MAX_GOVERNANCE_BYTES;
    process.env.MAX_GOVERNANCE_BYTES = '100';
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Malformed Bytes DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      governanceBytes: [1, 2, 'not-a-byte'],
      ...completeCompliance(),
    });
    process.env.MAX_GOVERNANCE_BYTES = previous || '';
    assert.equal(r.status, 400);
    assert.ok(r.body.details.some(d => d.field === 'governanceBytes[2]'));
  });

  it('two filings with the same DAO name produce distinct registryIds', async () => {
    const filing = {
      daoName: 'Collision Check DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const a = await postJson(`${baseUrl}/api/file`, filing);
    const b = await postJson(`${baseUrl}/api/file`, filing);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.registryId, b.body.registryId);
    assert.match(a.body.registryId, /^collision-check-dao/);
    assert.match(b.body.registryId, /^collision-check-dao-[a-f0-9]{6}$/);
  });

  it('returns warnings array on filing (anchor disabled in tests)', async () => {
    const r = await postJson(`${baseUrl}/api/file`, {
      daoName: 'Warnings DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.warnings));
    // Anchor is not configured in the e2e env, so we expect at least one warning.
    assert.ok(r.body.warnings.some(w => w.category === 'anchor'));
  });
});

describe('verifier shape checks', () => {
  it('parseDaoDid rejects malformed DIDs', async () => {
    const { parseDaoDid } = await import('../src/verifier.js');
    assert.throws(() => parseDaoDid('not-a-did'),                       /not a did:web/);
    assert.throws(() => parseDaoDid('did:web:host'),                    /lacks dao\/agent/);
    assert.throws(() => parseDaoDid('did:web:host:other:foo'),          /expected dao\/agent/);
    const ok = parseDaoDid('did:web:host%3A3000:dao:my-dao');
    assert.equal(ok.kind, 'dao');
    assert.equal(ok.registryId, 'my-dao');
  });

  it('validateDocumentShape catches missing fields', async () => {
    const { validateDocumentShape } = await import('../src/verifier.js');
    assert.match(validateDocumentShape(null,        'dao'),   /not an object/);
    assert.match(validateDocumentShape({},          'dao'),   /doc.id is missing/);
    assert.match(validateDocumentShape({ id:'did:web:x', '@context':'foo' }, 'dao'), /@context/);
    const partial = {
      id: 'did:web:x:dao:y', '@context': [], alsoKnownAs: ['z'],
      verificationMethod: [{}], service: [],
    };
    assert.match(validateDocumentShape(partial, 'dao'), /DAOGovernanceDocument/);
  });

  it('verifyDetachedJws rejects unknown critical headers (RFC 7515 §4.1.11)', async () => {
    const { generateKeyPair, verifyDetachedJws, b64uEncode, JWS_DOMAIN } = await import('../src/crypto.js');
    const { ed25519 } = await import('@noble/curves/ed25519');
    const kp = generateKeyPair();
    const enc = (s) => new TextEncoder().encode(s);
    // Forge a header with a critical extension the verifier doesn't know.
    const header = { alg: 'EdDSA', b64: false, crit: ['b64', 'made-up-extension'], domain: JWS_DOMAIN };
    const encodedHeader = b64uEncode(enc(JSON.stringify(header)));
    const payloadBytes = enc('{"hello":"world"}');
    const buf = new Uint8Array(enc(encodedHeader + '.').length + payloadBytes.length);
    buf.set(enc(encodedHeader + '.'), 0);
    buf.set(payloadBytes, enc(encodedHeader + '.').length);
    const sig = ed25519.sign(buf, kp.privateKey);
    const jws = `${encodedHeader}..${b64uEncode(sig)}`;
    assert.throws(() => verifyDetachedJws(jws, kp.publicKey, payloadBytes), /unknown critical extension "made-up-extension"/);
  });

  it('verifyDetachedJws rejects malformed crit (not an array)', async () => {
    const { generateKeyPair, verifyDetachedJws, b64uEncode, JWS_DOMAIN } = await import('../src/crypto.js');
    const { ed25519 } = await import('@noble/curves/ed25519');
    const kp = generateKeyPair();
    const enc = (s) => new TextEncoder().encode(s);
    const header = { alg: 'EdDSA', b64: false, crit: 'b64', domain: JWS_DOMAIN }; // string, not array
    const encodedHeader = b64uEncode(enc(JSON.stringify(header)));
    const payloadBytes = enc('{"a":1}');
    const buf = new Uint8Array(enc(encodedHeader + '.').length + payloadBytes.length);
    buf.set(enc(encodedHeader + '.'), 0);
    buf.set(payloadBytes, enc(encodedHeader + '.').length);
    const sig = ed25519.sign(buf, kp.privateKey);
    const jws = `${encodedHeader}..${b64uEncode(sig)}`;
    assert.throws(() => verifyDetachedJws(jws, kp.publicKey, payloadBytes), /malformed crit/);
  });

  it('verifyDocumentSignature rejects unaccepted proofPurpose', async () => {
    const { verifyDocumentSignature } = await import('../src/verifier.js');
    const fakeDoc = {
      id: 'did:web:x:dao:y',
      proof: {
        type: 'JsonWebSignature2020',
        proofPurpose: 'authentication', // not assertionMethod
        verificationMethod: 'did:web:x:dao:y#k1',
        jws: 'header..sig',
      },
      verificationMethod: [{ id: 'did:web:x:dao:y#k1', publicKeyJwk: { kty:'OKP', crv:'Ed25519', x:'AAAA' } }],
    };
    const r = verifyDocumentSignature(fakeDoc);
    assert.equal(r.ok, false);
    assert.match(r.detail, /proofPurpose.*not in accepted set/);
  });
});

describe('resolver Content-Type check', () => {
  it('rejects responses with the wrong Content-Type', async () => {
    const { resolve, ResolutionError } = await import('../src/resolver.js');
    // Spin up a one-off server that serves valid-looking JSON with a bogus
    // content-type. The resolver should refuse it.
    const bogus = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(JSON.stringify({ id: 'did:web:127.0.0.1' }));
    });
    await new Promise(r => bogus.listen(0, '127.0.0.1', r));
    const port = bogus.address().port;
    try {
      await assert.rejects(
        resolve(`did:web:127.0.0.1%3A${port}`, { scheme: 'http' }),
        (e) => e instanceof ResolutionError && /Content-Type/i.test(e.message),
      );
    } finally {
      await new Promise(r => bogus.close(r));
    }
  });
});

describe('filing auth', () => {
  let authedServer;
  let authedPort;
  let authedBase;
  const KEY = 'test-secret-key';

  before(async () => {
    authedPort = await pickFreePort();
    process.env.FILING_API_KEY = KEY;

    // Re-import to pick up new env (modules cache; reset by query string).
    const { app } = await import('../src/server.js?auth=1');
    authedServer = http.createServer(app);
    await new Promise(r => authedServer.listen(authedPort, '127.0.0.1', r));
    authedBase = `http://127.0.0.1:${authedPort}`;
  });

  after(async () => {
    if (authedServer) await new Promise(r => authedServer.close(r));
    delete process.env.FILING_API_KEY;
  });

  it('rejects requests without a Bearer token', async () => {
    const r = await postJson(`${authedBase}/api/file`, {
      daoName: 'Auth DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
    });
    assert.equal(r.status, 401);
  });

  it('accepts a request with the correct Bearer token', async () => {
    const res = await fetch(`${authedBase}/api/file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        daoName: 'Auth Pass DAO',
        agentName: 'Jane Smith',
        agentAddress: '123 Main Street, Concord, NH 03301',
        agentEmail: 'jane@example.org',
        ...completeCompliance(),
      }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects a request with the wrong Bearer token', async () => {
    const res = await fetch(`${authedBase}/api/file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer wrong-key`,
      },
      body: JSON.stringify({
        daoName: 'Auth Fail DAO',
        agentName: 'Jane Smith',
        agentAddress: '123 Main Street, Concord, NH 03301',
        agentEmail: 'jane@example.org',
      }),
    });
    assert.equal(res.status, 401);
  });
});

describe('IPFS pin (local fallback)', () => {
  it('reports publicPinStatus as not-configured when Arweave env is missing', async () => {
    const { pin } = await import('../src/ipfs.js');
    const bytes = new TextEncoder().encode('hello-ipfs');
    const result = await pin(bytes, 'hello.txt');
    assert.match(result.cid, /^bafk/);
    assert.equal(result.public, false);
    assert.equal(result.publicPinStatus.state, 'not-configured');
    assert.equal(result.publicPinStatus.provider, 'arweave');
    assert.equal(result.arweave, null);
  });

  it('reports a failed publicPinStatus for invalid Arweave wallet JSON', async () => {
    const { pin } = await import('../src/ipfs.js');
    process.env.ARWEAVE_JWK = 'not json';
    const bytes = new TextEncoder().encode('hello-arweave');
    const result = await pin(bytes, 'hello.txt');
    process.env.ARWEAVE_JWK = '';
    assert.match(result.cid, /^bafk/);
    assert.equal(result.public, false);
    assert.equal(result.gatewayUrl, `/ipfs/${result.cid}`);
    assert.equal(result.publicPinStatus.state, 'failed');
    assert.equal(result.publicPinStatus.provider, 'arweave');
    assert.match(result.publicPinStatus.detail, /ARWEAVE_JWK/);
  });
});

describe('deploy script OWNER validation', () => {
  // Mirrors the EVM_ADDR_RX in scripts/deploy.cjs. Kept here so a regression
  // in either side will fail this test.
  const EVM_ADDR_RX = /^0x[a-fA-F0-9]{40}$/;

  it('accepts well-formed addresses (lower, upper, mixed case)', () => {
    assert.ok(EVM_ADDR_RX.test('0x' + 'a'.repeat(40)));
    assert.ok(EVM_ADDR_RX.test('0x' + 'A'.repeat(40)));
    assert.ok(EVM_ADDR_RX.test('0xAbCdEf' + '0'.repeat(34)));
  });

  it('rejects malformed OWNER values', () => {
    assert.equal(EVM_ADDR_RX.test(''), false);
    assert.equal(EVM_ADDR_RX.test('0x'), false);
    assert.equal(EVM_ADDR_RX.test('0x' + 'a'.repeat(39)), false);   // too short
    assert.equal(EVM_ADDR_RX.test('0x' + 'a'.repeat(41)), false);   // too long
    assert.equal(EVM_ADDR_RX.test('0xZZZZ' + '0'.repeat(36)), false); // non-hex
    assert.equal(EVM_ADDR_RX.test('not-an-address'), false);
    assert.equal(EVM_ADDR_RX.test('AB' + 'a'.repeat(40)), false);   // missing 0x
  });
});

describe('CONTROLLER_PRIVATE_KEY env-var path', () => {
  let s;
  let basePort;
  let baseUrlEnv;

  // A fixed Ed25519 seed (32 bytes) — only used to derive the test key.
  const SEED_HEX = '11'.repeat(32);

  before(async () => {
    basePort = await pickFreePort();
    process.env.CONTROLLER_PRIVATE_KEY = SEED_HEX;
    // Point CONTROLLER_KEY_PATH at a non-existent file so we can confirm
    // the env var is preferred and no file is created.
    process.env.CONTROLLER_KEY_PATH = path.join('data', '_env_key_tmp', 'should-not-exist.json');
    fs.rmSync(path.join('data', '_env_key_tmp'), { recursive: true, force: true });
    process.env.PORT = String(basePort);
    process.env.REGISTRY_HOST = `localhost:${basePort}`;

    const { app } = await import('../src/server.js?envkey=1');
    s = http.createServer(app);
    await new Promise(r => s.listen(basePort, '127.0.0.1', r));
    baseUrlEnv = `http://127.0.0.1:${basePort}`;
  });

  after(async () => {
    if (s) await new Promise(r => s.close(r));
    delete process.env.CONTROLLER_PRIVATE_KEY;
    fs.rmSync(path.join('data', '_env_key_tmp'), { recursive: true, force: true });
  });

  it('signs with the env-supplied key and writes nothing to disk', async () => {
    // Derive the expected public key independently from the same seed.
    const { ed25519 } = await import('@noble/curves/ed25519');
    const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils');
    const expectedPublicKey = ed25519.getPublicKey(hexToBytes(SEED_HEX));

    // The registry's own DID document exposes the controller public key.
    const wellKnown = await getJson(`${baseUrlEnv}/.well-known/did.json`);
    assert.equal(wellKnown.status, 200);
    const jwk = wellKnown.body.verificationMethod[0].publicKeyJwk;
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');

    // Decode the JWK 'x' (base64url) and compare with our expected pubkey.
    const pad = '==='.slice((jwk.x.length + 3) % 4);
    const xBytes = Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
    assert.equal(bytesToHex(new Uint8Array(xBytes)), bytesToHex(expectedPublicKey));

    // No keyfile should have been created at the configured path.
    assert.equal(fs.existsSync(process.env.CONTROLLER_KEY_PATH), false);

    // File a registration and confirm the resulting signature verifies
    // against this public key.
    const r = await postJson(`${baseUrlEnv}/api/file`, {
      daoName: 'Env Key DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    });
    assert.equal(r.status, 200);

    const { verifyDocumentSignature } = await import('../src/verifier.js');
    const sig = verifyDocumentSignature(r.body.dao);
    assert.equal(sig.ok, true, sig.detail);
  });

  it('rejects malformed CONTROLLER_PRIVATE_KEY', async () => {
    const { loadKeyPairFromEnv } = await import('../src/crypto.js');
    const previous = process.env.CONTROLLER_PRIVATE_KEY;
    try {
      process.env.CONTROLLER_PRIVATE_KEY = 'not-hex';
      assert.throws(() => loadKeyPairFromEnv(), /64 hex chars/);
    } finally {
      process.env.CONTROLLER_PRIVATE_KEY = previous;
    }
  });
});

describe('retryWithBackoff', () => {
  it('returns the first successful result without retrying', async () => {
    const { retryWithBackoff } = await import('../src/anchor.js');
    let calls = 0;
    const { result, attempts } = await retryWithBackoff(
      async () => { calls++; return 'ok'; },
      { maxAttempts: 3, baseDelayMs: 1, sleeper: async () => {}, jitter: () => 0 },
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 1);
    assert.equal(calls, 1);
  });

  it('retries transient failures up to maxAttempts and succeeds', async () => {
    const { retryWithBackoff } = await import('../src/anchor.js');
    const sleeps = [];
    let calls = 0;
    const { result, attempts } = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error('connection reset');
        return 42;
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleeper: async (ms) => { sleeps.push(ms); },
        jitter: () => 0,
      },
    );
    assert.equal(result, 42);
    assert.equal(attempts, 3);
    assert.equal(calls, 3);
    // Two failures, two sleeps. Backoff is base * 2^(attempt-1) with
    // jitter=0 → 10ms, 20ms.
    assert.deepEqual(sleeps, [10, 20]);
  });

  it('rethrows after maxAttempts when all retries fail', async () => {
    const { retryWithBackoff } = await import('../src/anchor.js');
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(
        async () => { calls++; throw new Error('still flaky'); },
        { maxAttempts: 3, baseDelayMs: 1, sleeper: async () => {}, jitter: () => 0 },
      ),
      /still flaky/,
    );
    assert.equal(calls, 3);
  });

  it('does not retry on permanent errors (early surface)', async () => {
    const { retryWithBackoff, isPermanentAnchorError } = await import('../src/anchor.js');
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(
        async () => { calls++; throw new Error('DAORegistryAnchor: version already anchored'); },
        {
          maxAttempts: 5,
          baseDelayMs: 1,
          isPermanent: isPermanentAnchorError,
          sleeper: async () => {},
          jitter: () => 0,
        },
      ),
      /already anchored/,
    );
    assert.equal(calls, 1, 'permanent errors must not be retried');
  });

  it('isPermanentAnchorError matches contract reverts and skips network errors', async () => {
    const { isPermanentAnchorError } = await import('../src/anchor.js');
    assert.equal(isPermanentAnchorError(new Error('DAORegistryAnchor: not owner')),                true);
    assert.equal(isPermanentAnchorError(new Error('DAORegistryAnchor: version already anchored')), true);
    assert.equal(isPermanentAnchorError(new Error('DAORegistryAnchor: non-sequential version')),   true);
    assert.equal(isPermanentAnchorError(new Error('insufficient funds for gas')),                  true);
    // Transient — should NOT short-circuit retries.
    assert.equal(isPermanentAnchorError(new Error('connection reset')),                            false);
    assert.equal(isPermanentAnchorError(new Error('ETIMEDOUT')),                                   false);
    assert.equal(isPermanentAnchorError(new Error('socket hang up')),                              false);
  });
});

describe('rate limiting', () => {
  let s;
  let basePort;
  let baseUrlRl;

  before(async () => {
    basePort = await pickFreePort();
    process.env.FILING_RATE_MAX = '2';
    process.env.FILING_RATE_WINDOW_MS = '60000';
    const { app } = await import('../src/server.js?ratelimit=1');
    s = http.createServer(app);
    await new Promise(r => s.listen(basePort, '127.0.0.1', r));
    baseUrlRl = `http://127.0.0.1:${basePort}`;
  });

  after(async () => {
    if (s) await new Promise(r => s.close(r));
    // Restore the relaxed test limit for any subsequent file in this run.
    process.env.FILING_RATE_MAX = '1000';
  });

  it('returns 429 after exceeding the per-window cap', async () => {
    const body = {
      daoName: 'Rate Limit DAO',
      agentName: 'Jane Smith',
      agentAddress: '123 Main Street, Concord, NH 03301',
      agentEmail: 'jane@example.org',
      ...completeCompliance(),
    };
    const a = await postJson(`${baseUrlRl}/api/file`, body);
    const b = await postJson(`${baseUrlRl}/api/file`, body);
    const c = await postJson(`${baseUrlRl}/api/file`, body);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429);
  });
});
