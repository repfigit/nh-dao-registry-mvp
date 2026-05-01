/**
 * MVP evidence checks for RSA 301-B eligibility.
 *
 * This does not certify legal compliance. It makes the registry intake
 * evidence-backed: every statutory listing claim has a required public
 * artifact or explicit attestation before the registry publishes a DID record.
 */

const MAX_URL_LEN = 2048;
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);
const EVM_ADDR_RX = /^0x[a-fA-F0-9]{40}$/;
const DOMAIN_LABEL_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const TLD_RX = /^[a-z]{2,63}$/i;
const LIFECYCLE_STATUSES = new Set(['initial', 'active', 'amended', 'restructured', 'deregistered', 'failure-event']);

const EVIDENCE_URL_FIELDS = [
  ['qaUrl', 'quality assurance testing evidence URL'],
  ['communicationsUrl', 'public communications mechanism URL'],
  ['internalDisputeResolutionUrl', 'internal dispute resolution mechanism URL'],
  ['thirdPartyDisputeResolutionUrl', 'third-party dispute resolution mechanism URL'],
  ['legalRepresentativeAuthorizationUrl', 'legal representative authorization URL'],
];

const ATTESTATION_FIELDS = [
  ['permissionlessBlockchain', 'DAO is deployed on a permissionless blockchain'],
  ['openSourceCode', 'DAO software code is open source in a public forum'],
  ['qaCompleted', 'DAO software code has undergone quality assurance testing'],
  ['guiMonitoring', 'public GUI exposes key smart-contract variables and transactions'],
  ['bylawsPublic', 'bylaws are publicly accessible and tied to the governance artifact'],
  ['publicCommunications', 'public communications mechanism is accessible to laypersons'],
  ['internalDisputeResolution', 'internal dispute resolution mechanism is available'],
  ['thirdPartyDisputeResolution', 'third-party dispute resolution mechanism is available'],
  ['decentralizedNetwork', 'DAO satisfies the decentralized-network requirement'],
  ['decentralizedGovernance', 'DAO satisfies the decentralized-governance requirement'],
  ['participantRules', 'bylaws specify participant and governance rights'],
  ['legalRepresentativeAuthorized', 'legal representative authority is publicly evidenced'],
];

function validateUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, error: 'URL is required' };
  if (v.length > MAX_URL_LEN) return { ok: false, error: `URL too long (max ${MAX_URL_LEN} chars)` };
  let u;
  try { u = new URL(v); }
  catch { return { ok: false, error: 'Invalid URL' }; }
  if (!ALLOWED_URL_SCHEMES.has(u.protocol)) {
    return { ok: false, error: `URL scheme ${u.protocol} not allowed (use http or https)` };
  }
  if (!isPublicHostname(u.hostname)) {
    return { ok: false, error: 'URL host must be public, not localhost or a private network address' };
  }
  return { ok: true, value: v };
}

function validateDomain(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return { ok: false, error: 'Registered domain is required' };
  if (v.includes('://') || v.includes('/')) return { ok: false, error: 'Registered domain should be a host name, not a URL' };
  const labels = v.split('.');
  if (labels.length < 2 || labels.some(label => !DOMAIN_LABEL_RX.test(label)) || !TLD_RX.test(labels[labels.length - 1])) {
    return { ok: false, error: 'Registered domain must be a valid public domain name' };
  }
  return { ok: true, value: v };
}

function isPublicHostname(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
  if (h === '::1') return false;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;
  const octets = v4.slice(1).map(Number);
  if (octets.some(n => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return !(
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function validateCompliance(input) {
  const errors = [];
  const c = input && typeof input === 'object' ? input : {};

  const domain = validateDomain(c.registeredDomain);
  if (!domain.ok) errors.push({ field: 'compliance.registeredDomain', error: domain.error });

  const publicAddress = String(c.publicAddress || '').trim();
  if (!publicAddress) errors.push({ field: 'compliance.publicAddress', error: 'Public address is required' });
  else if (!EVM_ADDR_RX.test(publicAddress)) errors.push({ field: 'compliance.publicAddress', error: `Invalid EVM public address: ${publicAddress}` });

  const lifecycleStatus = String(c.lifecycleStatus || '').trim() || 'initial';
  if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) {
    errors.push({ field: 'compliance.lifecycleStatus', error: `Lifecycle status must be one of: ${[...LIFECYCLE_STATUSES].join(', ')}` });
  }

  const evidence = {};
  for (const [field, label] of EVIDENCE_URL_FIELDS) {
    const r = validateUrl(c[field]);
    if (!r.ok) errors.push({ field: `compliance.${field}`, error: `${label}: ${r.error}` });
    else evidence[field] = r.value;
  }

  const attestations = {};
  const rawAttestations = c.attestations && typeof c.attestations === 'object' ? c.attestations : {};
  for (const [field, label] of ATTESTATION_FIELDS) {
    if (rawAttestations[field] !== true) {
      errors.push({ field: `compliance.attestations.${field}`, error: `${label} must be attested true` });
    } else {
      attestations[field] = true;
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      status: 'evidence-submitted',
      legalStatus: 'not-determined',
      statute: 'RSA 301-B MVP evidence checklist',
      registeredDomain: domain.value,
      publicAddress,
      lifecycleStatus,
      evidence,
      assurance: {
        status: 'submitted-not-verified',
        evidenceUrlCount: Object.keys(evidence).length,
        note: 'Evidence URLs and attestations were supplied and syntax-checked; contents have not been independently reviewed or certified.',
      },
      attestations,
    },
  };
}

export { ATTESTATION_FIELDS, EVIDENCE_URL_FIELDS };
