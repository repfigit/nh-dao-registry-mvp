/**
 * End-to-end verification of a registered DAO.
 *
 * Given a DAO registryId (or full DID), the verifier:
 *
 *   1. Resolves the DAO DID document via did:web.
 *   2. Resolves the registered agent DID document via the DAO's
 *      `RegisteredAgent` service endpoint (or alsoKnownAs).
 *   3. Verifies both documents' detached JsonWebSignature2020 signatures
 *      using the public keys in their respective verificationMethod blocks.
 *   4. Confirms both documents are bidirectionally linked via alsoKnownAs.
 *   5. Recomputes the canonical content hash of each (proof + anchors
 *      stripped) and compares with the on-chain anchor on Polygon Amoy.
 *   6. Optionally fetches the IPFS-pinned governance bytes and confirms
 *      their SHA-256 matches the DAO document's `contentHash`.
 *
 * Returns a structured report; throws only on programming errors.
 */

import { canonicalize } from './canonicalize.js';
import { sha256Hex, jwkToPublicKey, verifyDetachedJws } from './crypto.js';
import { resolve as resolveDid } from './resolver.js';
import { readLatest, KIND } from './anchor.js';
import { readLocal } from './ipfs.js';
import { daoDid as buildDaoDid, registryDid as buildRegistryDid } from './didweb.js';

function check(name, ok, detail) {
  return { name, ok: !!ok, detail: detail || (ok ? 'ok' : 'failed') };
}

function findVerificationMethod(doc, vmId) {
  return (doc.verificationMethod || []).find(v => v.id === vmId);
}

function canonicalUnsigned(doc) {
  const { proof, anchors, ...rest } = doc;
  return canonicalize(rest);
}

/**
 * Parse a DAO did:web identifier and return its structured parts. The
 * canonical shape is `did:web:<host>:dao:<registryId>`; we accept the legacy
 * shape `did:web:<host>:<registryId>` (no path component) for the registry's
 * own DID but require an explicit `dao` or `agent` segment for filings.
 *
 * Throws on malformed input so callers can handle the failure rather than
 * silently picking up a bogus segment via `slice(-1)`.
 */
export function parseDaoDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:web:')) {
    throw new Error(`verifier: not a did:web identifier: ${did}`);
  }
  const segs = did.slice('did:web:'.length).split(':');
  if (segs.length < 3) throw new Error(`verifier: DID lacks dao/agent path segment: ${did}`);
  const kind = segs[segs.length - 2];
  const registryId = segs[segs.length - 1];
  if (kind !== 'dao' && kind !== 'agent') {
    throw new Error(`verifier: expected dao/agent segment, got ${kind}: ${did}`);
  }
  if (!registryId) throw new Error(`verifier: empty registryId in ${did}`);
  return { kind, registryId };
}

/**
 * Minimal DID-document shape check before we trust field accesses. We
 * deliberately do not pull in a full JSON Schema validator: the surface is
 * small and mistakes here are easier to spot inline than in an external
 * schema file.
 */
export function validateDocumentShape(doc, expectedKind) {
  if (!doc || typeof doc !== 'object') return 'document is not an object';
  if (typeof doc.id !== 'string' || !doc.id.startsWith('did:web:')) return 'doc.id is missing or not a did:web';
  if (!Array.isArray(doc['@context'])) return 'doc[@context] is not an array';
  if (!Array.isArray(doc.alsoKnownAs) || doc.alsoKnownAs.length === 0) return 'doc.alsoKnownAs is empty or missing';
  if (!Array.isArray(doc.verificationMethod) || doc.verificationMethod.length === 0) return 'doc.verificationMethod is empty or missing';
  if (!Array.isArray(doc.service)) return 'doc.service is not an array';
  if (expectedKind === 'dao') {
    const hasGov = doc.service.some(s => s && s.type === 'DAOGovernanceDocument');
    if (!hasGov) return 'DAO document missing DAOGovernanceDocument service';
  } else if (expectedKind === 'agent') {
    if (!doc.registeredAgent || typeof doc.registeredAgent !== 'object') return 'agent document missing registeredAgent block';
  }
  return null;
}

/**
 * Proof purposes the verifier is willing to accept. `assertionMethod` is
 * what `signDocument` always emits — registry filings are *assertions*
 * about a DAO/agent's identity. Other purposes (`authentication`,
 * `keyAgreement`, etc.) are not valid for filings and are rejected.
 */
const ACCEPTED_PROOF_PURPOSES = new Set(['assertionMethod']);

/** Verify a single DID document's detached JWS proof. */
export function verifyDocumentSignature(doc) {
  if (!doc.proof) return check('proof present', false, 'no proof block');
  if (!ACCEPTED_PROOF_PURPOSES.has(doc.proof.proofPurpose)) {
    return check('proof purpose acceptable', false,
      `proof.proofPurpose=${JSON.stringify(doc.proof.proofPurpose)} not in accepted set [${[...ACCEPTED_PROOF_PURPOSES].join(', ')}]`);
  }
  const vm = findVerificationMethod(doc, doc.proof.verificationMethod);
  if (!vm) return check('verificationMethod resolved', false, `vm ${doc.proof.verificationMethod} not found`);
  let publicKey;
  try { publicKey = jwkToPublicKey(vm.publicKeyJwk); }
  catch (e) { return check('publicKey decoded', false, e.message); }
  const payload = new TextEncoder().encode(canonicalUnsigned(doc));
  let ok;
  try { ok = verifyDetachedJws(doc.proof.jws, publicKey, payload); }
  catch (e) { return check('signature valid', false, e.message); }
  return check('signature valid', ok, ok ? 'JsonWebSignature2020 verified' : 'signature mismatch');
}

/**
 * Confirm the document was signed by a key registered in the registry's
 * own well-known DID document. Without this binding, an attacker who
 * controls the HTTPS host (DNS hijack, MITM, server compromise) could
 * substitute a self-signed document with their own embedded pubkey and
 * the per-document signature check above would still succeed. Comparing
 * to the registry's published `verificationMethod` set prevents that.
 */
export function verifyRegistryControllerKey(doc, registryDoc) {
  const vm = findVerificationMethod(doc, doc.proof && doc.proof.verificationMethod);
  if (!vm || !vm.publicKeyJwk) {
    return check('controller key registered', false, 'document has no usable verificationMethod');
  }
  const docKey = vm.publicKeyJwk;
  const registryKeys = (registryDoc.verificationMethod || []).map(v => v.publicKeyJwk).filter(Boolean);
  const matches = registryKeys.some(k =>
    k && k.kty === docKey.kty && k.crv === docKey.crv && k.x === docKey.x
  );
  return check('controller key registered', matches,
    matches ? 'document signed by a key in the registry well-known DID'
            : 'document pubkey not found in registry well-known DID');
}

/** Verify the alsoKnownAs link is bidirectional between two documents. */
export function verifyBidirectionalLink(daoDoc, agentDoc) {
  const daoAka = (daoDoc.alsoKnownAs || []).includes(agentDoc.id);
  const agentAka = (agentDoc.alsoKnownAs || []).includes(daoDoc.id);
  return check('alsoKnownAs bidirectional', daoAka && agentAka,
    daoAka && agentAka ? 'both directions' : `dao→agent ${daoAka}, agent→dao ${agentAka}`);
}

/** Verify the on-chain anchor matches the canonical hash of the document. */
export async function verifyChainAnchor(doc, registryId, kind) {
  const expected = sha256Hex(canonicalUnsigned(doc));
  const a = await readLatest(registryId, kind);
  if (!a) return check('chain anchor present', false, 'no anchor on chain');
  const ok = a.contentHash.toLowerCase() === expected.toLowerCase();
  return check('chain anchor matches', ok,
    ok ? `Polygon Amoy anchor v${a.version} matches sha256:${expected}`
       : `chain has sha256:${a.contentHash}, document hashes to sha256:${expected}`);
}

/** Verify the governance document on IPFS matches the DAO document's contentHash. */
export async function verifyGovernanceIpfs(daoDoc) {
  const govSvc = (daoDoc.service || []).find(s => s.type === 'DAOGovernanceDocument');
  if (!govSvc) return check('governance IPFS hash', false, 'no DAOGovernanceDocument service');
  const declared = (govSvc.contentHash || '').replace(/^sha256:/, '');
  if (!declared) return check('governance IPFS hash', false, 'no contentHash declared');
  const endpoints = Array.isArray(govSvc.serviceEndpoint) ? govSvc.serviceEndpoint : [govSvc.serviceEndpoint];
  const ipfs = endpoints.find(e => typeof e === 'string' && e.startsWith('ipfs://'));
  if (!ipfs) return check('governance IPFS hash', false, 'no ipfs:// endpoint');
  const cid = ipfs.slice('ipfs://'.length);
  const bytes = readLocal(cid);
  if (!bytes) return check('governance IPFS hash', false, `local pin missing for ${cid} (try a public gateway)`);
  const actual = sha256Hex(bytes);
  const ok = actual.toLowerCase() === declared.toLowerCase();
  return check('governance IPFS hash', ok,
    ok ? `bytes at ${ipfs} hash to declared sha256:${declared}`
       : `bytes hash to ${actual}, expected ${declared}`);
}

/**
 * Run the full verification flow for a DAO registryId.
 * Pass a custom resolver options object to override scheme (e.g. for tests).
 */
export async function verifyDao(daoIdOrDid, { scheme, host } = {}) {
  const did = daoIdOrDid.startsWith('did:web:')
    ? daoIdOrDid
    : buildDaoDid(host, daoIdOrDid);

  const checks = [];

  let daoRes;
  try {
    daoRes = await resolveDid(did, { scheme });
    checks.push(check('DAO DID resolved', true, daoRes.url));
  } catch (e) {
    checks.push(check('DAO DID resolved', false, e.message));
    return { did, checks, ok: false };
  }
  const daoDoc = daoRes.document;

  let parsed;
  try { parsed = parseDaoDid(did); }
  catch (e) {
    checks.push(check('DAO DID structurally valid', false, e.message));
    return { did, checks, ok: false };
  }
  const registryId = parsed.registryId;

  const daoShapeError = validateDocumentShape(daoDoc, 'dao');
  if (daoShapeError) {
    checks.push(check('DAO document shape', false, daoShapeError));
    return { did, checks, ok: false };
  }

  // Resolve agent. The DAO document carries the agent DID in two places:
  //   - alsoKnownAs[0]
  //   - service[type=RegisteredAgent].serviceEndpoint
  // These MUST agree. A mismatch implies tampered or malformed shape; we
  // reject rather than picking one and silently dropping the other.
  const agentDidStr = (daoDoc.alsoKnownAs || [])[0];
  if (!agentDidStr) {
    checks.push(check('agent DID present in alsoKnownAs', false));
    return { did, checks, ok: false };
  }
  const raSvc = (daoDoc.service || []).find(s => s && s.type === 'RegisteredAgent');
  const raEndpoint = raSvc && (Array.isArray(raSvc.serviceEndpoint) ? raSvc.serviceEndpoint[0] : raSvc.serviceEndpoint);
  if (!raEndpoint) {
    checks.push(check('RegisteredAgent service present', false, 'DAO document missing RegisteredAgent service endpoint'));
    return { did, checks, ok: false };
  }
  if (raEndpoint !== agentDidStr) {
    checks.push(check('alsoKnownAs / RegisteredAgent agree', false,
      `alsoKnownAs[0]=${agentDidStr} does not match RegisteredAgent.serviceEndpoint=${raEndpoint}`));
    return { did, checks, ok: false };
  }
  checks.push(check('alsoKnownAs / RegisteredAgent agree', true, agentDidStr));
  let agentDoc;
  try {
    const agentRes = await resolveDid(agentDidStr, { scheme });
    agentDoc = agentRes.document;
    checks.push(check('agent DID resolved', true, agentRes.url));
  } catch (e) {
    checks.push(check('agent DID resolved', false, e.message));
    return { did, checks, ok: false };
  }

  const agentShapeError = validateDocumentShape(agentDoc, 'agent');
  if (agentShapeError) {
    checks.push(check('agent document shape', false, agentShapeError));
    return { did, checks, ok: false };
  }

  // Signature checks
  checks.push({ ...verifyDocumentSignature(daoDoc),   name: 'DAO signature' });
  checks.push({ ...verifyDocumentSignature(agentDoc), name: 'agent signature' });

  // Registry-key binding: confirm both documents were signed with a key
  // that the registry's well-known DID actually publishes. Closes the
  // host-compromise gap where the per-document signature check alone
  // would accept any self-signed forgery served from the resolved URL.
  let registryDoc = null;
  try {
    const r = await resolveDid(buildRegistryDid(host), { scheme });
    registryDoc = r.document;
    checks.push(check('registry DID resolved', true, r.url));
  } catch (e) {
    checks.push(check('registry DID resolved', false, e.message));
  }
  if (registryDoc) {
    checks.push({ ...verifyRegistryControllerKey(daoDoc,   registryDoc), name: 'DAO controller key registered' });
    checks.push({ ...verifyRegistryControllerKey(agentDoc, registryDoc), name: 'agent controller key registered' });
  }

  // Bidirectional link
  checks.push(verifyBidirectionalLink(daoDoc, agentDoc));

  // Chain anchors
  checks.push({ ...(await verifyChainAnchor(daoDoc,   registryId, KIND.DAO)),   name: 'DAO chain anchor' });
  checks.push({ ...(await verifyChainAnchor(agentDoc, registryId, KIND.AGENT)), name: 'agent chain anchor' });

  // Governance bytes
  checks.push(await verifyGovernanceIpfs(daoDoc));

  return {
    did,
    agentDid: agentDidStr,
    checks,
    ok: checks.every(c => c.ok),
  };
}
