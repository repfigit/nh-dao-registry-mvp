/**
 * Centralized environment-variable access. Each getter reads `process.env`
 * lazily so tests can override individual values per-case (the e2e tests
 * lean on this — see test/e2e.test.js where `MAX_GOVERNANCE_BYTES` is
 * adjusted for the bytes-cap test). Lazy reads also make the boot order
 * tolerant: any `import 'dotenv/config'` placed before the first call wins.
 *
 * Modules SHOULD import these accessors instead of reading `process.env`
 * directly, so a single grep here documents the configuration surface and
 * future schema validation has one place to live.
 *
 * Capability flags (`hasPublicPinning`, `anchorEnabled`, `filingAuthEnabled`,
 * `adminAuthEnabled`) answer "is feature X usable right now" without exposing
 * secrets.
 */

const trim = (v) => (typeof v === 'string' ? v.trim() : v);

/* ---------- server / HTTP ---------- */

export function serverConfig() {
  const port   = Number(process.env.PORT || 3000);
  const host   = process.env.REGISTRY_HOST || `localhost:${port}`;
  const scheme = process.env.REGISTRY_SCHEME || (host.startsWith('localhost') ? 'http' : 'https');
  return {
    host,
    port,
    scheme,
    bodyLimit: process.env.REQUEST_BODY_LIMIT || '5mb',
    isTest: process.env.NODE_ENV === 'test',
    controllerKeyPath: process.env.CONTROLLER_KEY_PATH || 'data/keys/controller.json',
  };
}

/* ---------- filing auth ---------- */

export function filingApiKey() {
  return trim(process.env.FILING_API_KEY) || '';
}
export function filingAuthEnabled() {
  return Boolean(filingApiKey());
}

/* ---------- admin auth ---------- */

export function adminApiKey() {
  return trim(process.env.ADMIN_API_KEY) || '';
}
export function adminAuthEnabled() {
  return Boolean(adminApiKey());
}

/* ---------- rate limits ---------- */

export function filingRate() {
  return {
    windowMs: Number(process.env.FILING_RATE_WINDOW_MS || 60_000),
    max:      Number(process.env.FILING_RATE_MAX       || 10),
  };
}
export function verifyRate() {
  return {
    windowMs: Number(process.env.VERIFY_RATE_WINDOW_MS || 60_000),
    max:      Number(process.env.VERIFY_RATE_MAX       || 60),
  };
}

/* ---------- governance / publication ---------- */

const DEFAULT_MAX_GOVERNANCE_BYTES = 5 * 1024 * 1024;
export function maxGovernanceBytes() {
  return Number(process.env.MAX_GOVERNANCE_BYTES || DEFAULT_MAX_GOVERNANCE_BYTES);
}

/* ---------- anchor ---------- */

export function anchorConfig() {
  return {
    rpc:        process.env.AMOY_RPC_URL || process.env.RPC_URL || '',
    address:    process.env.ANCHOR_CONTRACT_ADDRESS || '',
    privateKey: process.env.ANCHOR_PRIVATE_KEY || '',
    maxRetries: Number(process.env.ANCHOR_MAX_RETRIES   || 3),
    baseDelayMs: Number(process.env.ANCHOR_BASE_DELAY_MS || 500),
  };
}
export function anchorEnabled() {
  const { rpc, address, privateKey } = anchorConfig();
  return Boolean(
    rpc && address && privateKey &&
    /^0x[0-9a-fA-F]{64}$/.test(privateKey) &&
    address.length === 42
  );
}

export function hasPublicPinning() {
  return Boolean(process.env.ARWEAVE_JWK);
}

/* ---------- controller key ---------- */

export function controllerKeyEnv() {
  return trim(process.env.CONTROLLER_PRIVATE_KEY) || '';
}
