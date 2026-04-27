/**
 * Build the two DID documents (DAO + registered agent) for a filing.
 *
 * The two documents are linked bidirectionally via `alsoKnownAs`. Each
 * document contains its own verificationMethod (the controller's signing
 * key, registered to the registry's controller URL), service endpoints,
 * and a `proof` block that the caller fills in via `signDocument`.
 *
 * `did:web` resolution: did:web:host:dao:<id> resolves by HTTPS GET to
 * https://host/dao/<id>/did.json. The server in this project hosts both.
 */

import { canonicalize, canonicalBytes } from './canonicalize.js';
import { detachedJws, publicKeyJwk, sha256Hex } from './crypto.js';
import { parseAddress } from './validation.js';

const W3C_DID_CONTEXT  = 'https://www.w3.org/ns/did/v1';
const JWS_2020_CONTEXT = 'https://w3id.org/security/suites/jws-2020/v1';

/**
 * Encode a host (which may include a port) for use as the first segment of
 * a did:web identifier. Per the did:web v1 method spec, the port colon
 * MUST be percent-encoded as %3A so it does not collide with the colon
 * separator between path segments.
 */
export function encodeHost(host) {
  return host.replace(/:/g, '%3A');
}

/** Build a DAO DID from host + registryId. */
export function daoDid(host, registryId) {
  return `did:web:${encodeHost(host)}:dao:${registryId}`;
}

export function agentDid(host, registryId) {
  return `did:web:${encodeHost(host)}:agent:${registryId}`;
}

/** Build the registry's own DID (host-only, no path). */
export function registryDid(host) {
  return `did:web:${encodeHost(host)}`;
}

/** Derive the HTTPS resolution URL for a did:web identifier. */
export function didWebUrl(scheme, did) {
  if (!did.startsWith('did:web:')) throw new Error('didWebUrl: not a did:web');
  const rest = did.slice('did:web:'.length);
  const segs = rest.split(':');
  const host = decodeURIComponent(segs[0]);
  const pathSegs = segs.slice(1).map(decodeURIComponent);
  if (pathSegs.length === 0) return `${scheme}://${host}/.well-known/did.json`;
  return `${scheme}://${host}/${pathSegs.join('/')}/did.json`;
}

/* ---------- DAO document ---------- */

export function buildDaoDocument(opts) {
  const {
    host,
    registryId,
    daoName,
    agentDidStr,
    controllerUrl,
    controllerKid,
    publicKey,
    governanceEndpoints,    // ordered array, IPFS first
    governanceContentHash,  // sha256 hex string of the governance bytes
    sourceUrl,
    guiUrl,
    contracts,              // [{ chainId, address }]
    compliance,
    created,                // ISO string
    version,                // integer (1 for first)
  } = opts;

  const id = daoDid(host, registryId);

  const services = [
    { id: `${id}#agent`,      type: 'RegisteredAgent',       serviceEndpoint: agentDidStr },
    {
      id: `${id}#governance`,
      type: 'DAOGovernanceDocument',
      serviceEndpoint: governanceEndpoints,
      contentHash: `sha256:${governanceContentHash}`,
    },
  ];
  if (sourceUrl) services.push({ id: `${id}#source`, type: 'DAOSourceCode',     serviceEndpoint: sourceUrl });
  if (guiUrl)    services.push({ id: `${id}#gui`,    type: 'DAOUserInterface',  serviceEndpoint: guiUrl });

  contracts.forEach((c, i) => services.push({
    id: `${id}#contract-${i + 1}`,
    type: 'DAOSmartContract',
    chainId: c.chainId,
    address: c.address,
  }));

  if (compliance) {
    services.push({
      id: `${id}#compliance`,
      type: 'NHDAOComplianceChecklist',
      serviceEndpoint: `https://${host}/api/records/${registryId}`,
      status: compliance.status,
      legalStatus: compliance.legalStatus,
      statute: compliance.statute,
      registeredDomain: compliance.registeredDomain,
      publicAddress: compliance.publicAddress,
      lifecycleStatus: compliance.lifecycleStatus,
      evidence: compliance.evidence,
      assurance: compliance.assurance,
      attestations: compliance.attestations,
    });
  }

  services.push({
    id: `${id}#record`,
    type: 'NHDAORegistryRecord',
    serviceEndpoint: `https://${host}/dao/${registryId}`,
    status: 'active',
  });

  return {
    '@context':   [W3C_DID_CONTEXT, JWS_2020_CONTEXT],
    id,
    alsoKnownAs:  [agentDidStr],
    controller:   controllerUrl,
    name:         daoName,
    verificationMethod: [{
      id: `${id}#${controllerKid}`,
      type: 'JsonWebKey2020',
      controller: controllerUrl,
      publicKeyJwk: publicKeyJwk(publicKey),
    }],
    service: services,
    version,
    created,
    updated: created,
    // anchors and proof are added later by the caller.
  };
}

/* ---------- Agent document ---------- */

export function buildAgentDocument(opts) {
  const {
    host,
    registryId,
    daoDidStr,
    agentName,
    agentAddress,   // raw string
    agentEmail,
    controllerUrl,
    controllerKid,
    publicKey,
    created,
    version,
  } = opts;

  const id = agentDid(host, registryId);

  return {
    '@context':   [W3C_DID_CONTEXT, JWS_2020_CONTEXT],
    id,
    alsoKnownAs:  [daoDidStr],
    controller:   controllerUrl,
    name:         agentName,
    registeredAgent: {
      name: agentName,
      physicalAddress: parseAddress(agentAddress),
      email: agentEmail,
    },
    verificationMethod: [{
      id: `${id}#${controllerKid}`,
      type: 'JsonWebKey2020',
      controller: controllerUrl,
      publicKeyJwk: publicKeyJwk(publicKey),
    }],
    service: [
      { id: `${id}#agent-of`, type: 'AgentOfRecord',         serviceEndpoint: [daoDidStr] },
      { id: `${id}#record`,   type: 'NHDAORegistryRecord',
        serviceEndpoint: `https://${host}/agent/${registryId}`, status: 'active' },
    ],
    version,
    created,
    updated: created,
  };
}

/* ---------- signing & content hashing ---------- */

/**
 * Compute the canonical hash that goes on chain.
 * The document is hashed with `proof` and `anchors` REMOVED, so that adding
 * those fields after hashing doesn't change the hash.
 */
export function canonicalContentHash(document) {
  const { proof, anchors, ...rest } = document;
  return sha256Hex(canonicalize(rest));
}

/** Sign a document in-place (returns a new copy with `proof` attached). */
export function signDocument(document, privateKey, controllerKid, created) {
  const { proof: _drop, ...unsigned } = document;
  const payloadBytes = canonicalBytes(unsigned);
  const jws = detachedJws(privateKey, payloadBytes);
  return {
    ...unsigned,
    proof: {
      type: 'JsonWebSignature2020',
      created,
      verificationMethod: `${unsigned.id}#${controllerKid}`,
      proofPurpose: 'assertionMethod',
      jws,
    },
  };
}

/** Add an anchor entry to a signed document (does not re-sign; anchor is metadata). */
export function attachAnchor(document, anchor) {
  return {
    ...document,
    anchors: [...(document.anchors || []), anchor],
  };
}
