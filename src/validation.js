/**
 * Registry-enforced invariants for filings.
 *
 * - DAO name MUST end in "DAO" or "LAO" (RSA 301-B:2, III).
 * - Registered agent MUST have a physical NH street address.
 *   PO boxes are not accepted.
 * - Smart contract entries MUST be CAIP-2 chain id + EVM address.
 *
 * These are duplicated in the browser for UX, but the server-side checks
 * here are authoritative. A registry that only validates client-side is
 * a registry that doesn't validate.
 */

const NAME_RX = /(?:^|\s)(DAO|LAO)$/i;
const NH_RX = /\b(NH|N\.H\.|New\s+Hampshire)\b/i;
const PO_BOX_RX = /\b(P\.?\s*O\.?\s*Box|post\s+office\s+box)\b/i;
const CAIP2_RX = /^eip155:\d+$/i;
const EVM_ADDR_RX = /^0x[a-fA-F0-9]{40}$/;
const ZIP_RX = /\b\d{5}(?:-\d{4})?\b/;

const MIN_DAO_NAME_LEN   = 4;   // minimum to fit a non-trivial label plus "DAO"
const MIN_AGENT_NAME_LEN = 2;
const MIN_ADDRESS_LEN    = 12;
const MAX_URL_LEN        = 2048;
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

export function validateDaoName(name) {
  const v = (name || '').trim();
  if (!v) return { ok: false, error: 'DAO name is required' };
  if (v.length < MIN_DAO_NAME_LEN) return { ok: false, error: `DAO name too short (min ${MIN_DAO_NAME_LEN} chars)` };
  if (v.length > 200) return { ok: false, error: 'DAO name too long (max 200 chars)' };
  if (!NAME_RX.test(v)) return { ok: false, error: 'DAO name must end in "DAO" or "LAO" (RSA 301-B:2, III)' };
  return { ok: true, value: v };
}

export function validateAgentAddress(addr) {
  const v = (addr || '').trim();
  if (!v) return { ok: false, error: 'Agent address is required' };
  if (v.length < MIN_ADDRESS_LEN) return { ok: false, error: `Agent address too short (min ${MIN_ADDRESS_LEN} chars; include street, city, state, zip)` };
  if (PO_BOX_RX.test(v)) return { ok: false, error: 'PO boxes are not accepted; a physical NH street address is required' };
  if (!NH_RX.test(v)) return { ok: false, error: 'Address must be in New Hampshire' };
  if (!/\d/.test(v)) return { ok: false, error: 'Address should include a street number' };
  if (!ZIP_RX.test(v)) return { ok: false, error: 'Address should include a 5-digit ZIP (e.g. 03301)' };
  // Best-effort: require at least street + city + (state and/or zip).
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return { ok: false, error: 'Address should be comma-separated: street, city, state ZIP' };
  return { ok: true, value: v };
}

export function validateAgentEmail(email) {
  const v = (email || '').trim();
  if (!v) return { ok: false, error: 'Agent email is required' };
  if (v.length > 254) return { ok: false, error: 'Agent email too long (max 254 chars)' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, error: 'Invalid email' };
  return { ok: true, value: v };
}

export function validateAgentName(name) {
  const v = (name || '').trim();
  if (!v) return { ok: false, error: 'Agent name is required' };
  if (v.length < MIN_AGENT_NAME_LEN) return { ok: false, error: `Agent name too short (min ${MIN_AGENT_NAME_LEN} chars)` };
  if (v.length > 200) return { ok: false, error: 'Agent name too long (max 200 chars)' };
  return { ok: true, value: v };
}

/**
 * Validate a public-facing URL field. Rejects javascript:, data:, file:, and
 * unbounded lengths that would otherwise embed arbitrary payloads in the
 * signed DID document.
 */
export function validateUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, error: 'URL is required' };
  if (v.length > MAX_URL_LEN) return { ok: false, error: `URL too long (max ${MAX_URL_LEN} chars)` };
  let u;
  try { u = new URL(v); }
  catch { return { ok: false, error: 'Invalid URL' }; }
  if (!ALLOWED_URL_SCHEMES.has(u.protocol)) {
    return { ok: false, error: `URL scheme ${u.protocol} not allowed (use http or https)` };
  }
  return { ok: true, value: v };
}

export function validateContract(c) {
  if (!c || typeof c !== 'object') return { ok: false, error: 'Contract entry must be an object' };
  const chain = String(c.chainId || '').trim();
  const addr = String(c.address || '').trim();
  if (!CAIP2_RX.test(chain)) return { ok: false, error: `Invalid CAIP-2 chainId: ${chain}` };
  if (!EVM_ADDR_RX.test(addr)) return { ok: false, error: `Invalid EVM address: ${addr}` };
  // chainId is canonicalized to lowercase per CAIP-2; address case is preserved
  // because EIP-55 checksummed addresses encode a checksum in their case.
  return { ok: true, value: { chainId: chain.toLowerCase(), address: addr } };
}

export function validateFiling(input) {
  const errors = [];
  const out = {};

  for (const [field, fn] of [
    ['daoName',      validateDaoName],
    ['agentName',    validateAgentName],
    ['agentAddress', validateAgentAddress],
    ['agentEmail',   validateAgentEmail],
  ]) {
    const r = fn(input[field]);
    if (!r.ok) errors.push({ field, error: r.error });
    else out[field] = r.value;
  }

  out.contracts = [];
  for (const [i, c] of (input.contracts || []).entries()) {
    const r = validateContract(c);
    if (!r.ok) errors.push({ field: `contracts[${i}]`, error: r.error });
    else out.contracts.push(r.value);
  }

  // Optional URLs: trim and validate shape if provided.
  for (const field of ['govUrl', 'sourceUrl', 'guiUrl']) {
    const v = (input[field] || '').trim();
    if (v) {
      const r = validateUrl(v);
      if (!r.ok) errors.push({ field, error: r.error });
      else out[field] = r.value;
    }
  }

  return { ok: errors.length === 0, errors, value: out };
}

/** Best-effort split of "123 Main St, Concord, NH 03301" into structured parts. */
export function parseAddress(addr) {
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  const out = { streetAddress: parts[0] || addr, locality: '', region: 'NH', postalCode: '', country: 'US' };
  if (parts.length >= 2) out.locality = parts[1];
  if (parts.length >= 3) {
    const m = parts[2].match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
    if (m) { out.region = m[1].toUpperCase(); out.postalCode = m[2]; }
    else { out.region = parts[2]; }
  }
  return out;
}

export function slugify(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
