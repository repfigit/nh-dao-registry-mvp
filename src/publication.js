/**
 * Publication service.
 *
 * Orchestrates the full filing flow:
 *
 *   1. Validate the filing (naming rule, NH address, contracts).
 *   2. Pin the governance bytes to IPFS (mandatory; spec §V.5 v0.6).
 *   3. Build the DAO DID document with the IPFS CID first in the
 *      DAOGovernanceDocument service endpoint array.
 *   4. Build the registered-agent DID document, linked back via
 *      bidirectional alsoKnownAs.
 *   5. Sign both documents with the registry's controller Ed25519 key
 *      (detached JsonWebSignature2020).
 *   6. Compute canonical content hashes (proof + anchors stripped) and
 *      record them on the Polygon Amoy DAORegistryAnchor contract, one
 *      transaction per document. Either both anchors land or neither
 *      does (best-effort: we record what we got).
 *   7. Persist DAO, agent, and metadata to the filesystem store.
 *
 * If chain anchoring is not configured, the function still produces fully
 * signed documents and logs a warning. Verification will then flag the
 * missing anchor.
 */

import { canonicalize, canonicalBytes } from './canonicalize.js';
import { sha256Hex, loadOrCreateKeyPair } from './crypto.js';
import {
  buildDaoDocument, buildAgentDocument,
  signDocument, attachAnchor,
  daoDid, agentDid,
  canonicalContentHash,
} from './didweb.js';
import { validateFiling, slugify } from './validation.js';
import { pin } from './ipfs.js';
import { recordAnchor, anchorEnabled, KIND } from './anchor.js';
import { saveRecord, reserveRegistryId, releaseRegistryId } from './store.js';
import { maxGovernanceBytes } from './config.js';

const CONTROLLER_KID = 'controller-1';
/**
 * Path on the registry host that resolves to the SoS-controlled controller
 * URL. Embedded in the DID document's `controller` field. Kept as a named
 * constant so a spec change has a single point of edit.
 */
const CONTROLLER_PATH = '/sos';
/**
 * NOTE: Update workflows are out of scope for v0.6 (see SPEC.md). Every
 * filing anchors version 1; the contract supports sequential versions but
 * the publication service does not yet expose a re-filing path.
 */
const INITIAL_VERSION = 1;

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

function deriveRegistryId(daoName, salt) {
  const base = slugify(daoName);
  if (!base) return `dao-${salt.slice(0, 8)}`;
  return base;
}

/**
 * Reserve a unique registry directory atomically. Walks the salt space until
 * `mkdir` succeeds (creates the directory) — guarantees no two concurrent
 * filings can both claim the same id.
 */
function reserveUniqueId(daoName) {
  const base = deriveRegistryId(daoName, sha256Hex(daoName + '|' + nowIso()));
  if (reserveRegistryId(base)) return base;
  for (let i = 0; i < 8; i++) {
    const salt = sha256Hex(daoName + '|' + Date.now() + '|' + i).slice(0, 6);
    const candidate = `${base}-${salt}`;
    if (reserveRegistryId(candidate)) return candidate;
  }
  throw new Error('publication: could not reserve a unique registryId after 8 attempts');
}

/**
 * Run a full filing.
 * @param {object} input - { daoName, agentName, agentAddress, agentEmail, govUrl?, sourceUrl?, guiUrl?, contracts?, governanceBytes? }
 * @param {object} ctx - { host, scheme, controllerKeyPath }
 */
export async function file(input, ctx) {
  const v = validateFiling(input);
  if (!v.ok) {
    const err = new Error('validation failed');
    err.statusCode = 400;
    err.details = v.errors;
    throw err;
  }
  const filing = v.value;

  const { host, scheme = 'https', controllerKeyPath = 'data/keys/controller.json' } = ctx;
  const controllerUrl = `${scheme}://${host}${CONTROLLER_PATH}`;
  const kp = loadOrCreateKeyPair(controllerKeyPath);

  // Atomically reserve a unique registry directory. Two concurrent filings
  // for the same DAO name cannot both claim the same id.
  const registryId = reserveUniqueId(filing.daoName);

  let pinned;
  let governanceBytes;
  try {
    // 1. Build governance bytes (mandatory pin in step 2).
    governanceBytes = input.governanceBytes
      ? new Uint8Array(input.governanceBytes)
      : new Uint8Array(canonicalBytes({                        // fallback: a JSON stub for the demo
          type: 'NHDAORegistryGovernance',
          daoName: filing.daoName,
          filed: nowIso(),
          sourceUrl: filing.sourceUrl || null,
          guiUrl:    filing.guiUrl    || null,
          compliance: filing.compliance,
          note: 'Demo placeholder for the governance document. In production this is the bylaws PDF.',
        }));
    const cap = maxGovernanceBytes();
    if (governanceBytes.length > cap) {
      const err = new Error(`governance bytes too large: ${governanceBytes.length} > ${cap} (set MAX_GOVERNANCE_BYTES to override)`);
      err.statusCode = 400;
      err.details = [{ field: 'governanceBytes', error: err.message }];
      throw err;
    }
    pinned = await pin(governanceBytes, `${registryId}-governance.bin`);
  } catch (e) {
    releaseRegistryId(registryId);
    throw e;
  }
  const governanceContentHash = sha256Hex(governanceBytes);

  // Governance endpoints: IPFS first, then the optional URL the filer supplied.
  const governanceEndpoints = [pinned.ipfsUri];
  if (filing.govUrl) governanceEndpoints.push(filing.govUrl);

  const created = nowIso();
  const daoDidStr   = daoDid(host, registryId);
  const agentDidStr = agentDid(host, registryId);

  // 2. Build documents.
  let daoDoc = buildDaoDocument({
    host, registryId,
    daoName: filing.daoName,
    agentDidStr,
    controllerUrl,
    controllerKid: CONTROLLER_KID,
    publicKey: kp.publicKey,
    governanceEndpoints,
    governanceContentHash,
    sourceUrl: filing.sourceUrl,
    guiUrl: filing.guiUrl,
    contracts: filing.contracts,
    compliance: filing.compliance,
    created,
    version: INITIAL_VERSION,
  });

  let agentDoc = buildAgentDocument({
    host, registryId,
    daoDidStr,
    agentName: filing.agentName,
    agentAddress: filing.agentAddress,
    agentEmail: filing.agentEmail,
    controllerUrl,
    controllerKid: CONTROLLER_KID,
    publicKey: kp.publicKey,
    created,
    version: INITIAL_VERSION,
  });

  // 3. Sign both.
  daoDoc   = signDocument(daoDoc,   kp.privateKey, CONTROLLER_KID, created);
  agentDoc = signDocument(agentDoc, kp.privateKey, CONTROLLER_KID, created);

  // 4. Compute canonical hashes (these go on chain).
  const daoHash   = canonicalContentHash(daoDoc);
  const agentHash = canonicalContentHash(agentDoc);

  // 5. Persist the signed-but-not-yet-anchored record FIRST. This closes the
  //    ghost-anchor window: if a chain anchor lands but the server then
  //    crashes before persisting, the on-chain anchor would point at a
  //    document the registry doesn't know about. Saving first means the
  //    record is always discoverable, with `meta.anchors` filled in lazily
  //    as anchors confirm. Reconciliation (scripts/reanchor.js) walks records
  //    where status !== 'anchored' and finishes the job.
  const anchors      = { dao: null, agent: null };
  const anchorErrors = { dao: null, agent: null };
  const initialStatus = anchorEnabled() ? 'pending' : 'anchor-disabled';
  const admin = {
    reviewStatus: 'submitted',
    submittedAt: created,
    reviewedAt: null,
    reviewedBy: null,
    decisionReason: null,
    correctionRequestedAt: null,
    notesCount: 0,
  };
  const buildMeta = () => ({
    registryId,
    daoDid: daoDidStr,
    agentDid: agentDidStr,
    filed: created,
    daoName: filing.daoName,
    agentName: filing.agentName,
    agentEmail: filing.agentEmail,
    agentAddress: filing.agentAddress,
    governance: {
      cid: pinned.cid,
      ipfsUri: pinned.ipfsUri,
      gatewayUrl: pinned.gatewayUrl,
      contentHash: `sha256:${governanceContentHash}`,
      publicPin: pinned.public,
      publicPinStatus: pinned.publicPinStatus,
      arweave: pinned.arweave || null,
    },
    contracts: filing.contracts,
    compliance: filing.compliance,
    anchors,
    anchorErrors,
    daoHash:   `sha256:${daoHash}`,
    agentHash: `sha256:${agentHash}`,
    version: INITIAL_VERSION,
    status: deriveStatus(),
    admin,
    warnings: buildWarnings(),
  });

  function buildWarnings() {
    const out = [];
    if (pinned.publicPinStatus && pinned.publicPinStatus.state !== 'pinned' && pinned.publicPinStatus.state !== 'not-configured') {
      out.push({ category: 'ipfs', ...pinned.publicPinStatus });
    }
    if (anchorEnabled()) {
      if (anchorErrors.dao)   out.push({ category: 'anchor', kind: 'dao',   detail: anchorErrors.dao.message });
      if (anchorErrors.agent) out.push({ category: 'anchor', kind: 'agent', detail: anchorErrors.agent.message });
    } else {
      out.push({ category: 'anchor', kind: 'config', detail: 'chain anchor disabled (AMOY_RPC_URL/ANCHOR_CONTRACT_ADDRESS/ANCHOR_PRIVATE_KEY not set)' });
    }
    return out;
  }

  function deriveStatus() {
    if (!anchorEnabled()) return 'anchor-disabled';
    if (anchors.dao && anchors.agent) return 'anchored';
    if (anchors.dao || anchors.agent) return 'partial';
    if (anchorErrors.dao || anchorErrors.agent) return 'unanchored';
    return 'pending';
  }

  saveRecord(registryId, { dao: daoDoc, agent: agentDoc, meta: { ...buildMeta(), status: initialStatus }, governanceBytes });

  // 6. Anchor both on Polygon Amoy if configured. Re-save after each leg so
  //    a crash mid-flight leaves a partially-anchored but consistent record
  //    rather than a chain-only ghost.
  if (anchorEnabled()) {
    try {
      anchors.dao = await recordAnchor(registryId, KIND.DAO, INITIAL_VERSION, daoHash);
    } catch (e) {
      anchorErrors.dao = { message: e.shortMessage || e.message };
      // eslint-disable-next-line no-console
      console.error(`anchor (dao): ${anchorErrors.dao.message}`);
    }
    if (anchors.dao) {
      daoDoc = attachAnchor(daoDoc, {
        chainId: anchors.dao.chainIdCaip2,
        txHash: anchors.dao.txHash,
        anchoredAt: created,
        version: INITIAL_VERSION,
        contentHash: `sha256:${daoHash}`,
      });
      saveRecord(registryId, { dao: daoDoc, agent: agentDoc, meta: buildMeta() });
    }

    try {
      anchors.agent = await recordAnchor(registryId, KIND.AGENT, INITIAL_VERSION, agentHash);
    } catch (e) {
      anchorErrors.agent = { message: e.shortMessage || e.message };
      // eslint-disable-next-line no-console
      console.error(`anchor (agent): ${anchorErrors.agent.message}`);
    }
    if (anchors.agent) {
      agentDoc = attachAnchor(agentDoc, {
        chainId: anchors.agent.chainIdCaip2,
        txHash: anchors.agent.txHash,
        anchoredAt: created,
        version: INITIAL_VERSION,
        contentHash: `sha256:${agentHash}`,
      });
    }
  }

  // 7. Final save with the latest status, anchors, and warnings.
  const meta = buildMeta();
  saveRecord(registryId, { dao: daoDoc, agent: agentDoc, meta });

  return { registryId, dao: daoDoc, agent: agentDoc, meta, warnings: meta.warnings };
}
