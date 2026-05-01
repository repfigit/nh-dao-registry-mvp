/**
 * Cryptography for the NH DAO Registry POC.
 *
 * - Ed25519 keypair generation, persistence, and JWK encoding.
 * - SHA-256 content hashing.
 * - JsonWebSignature2020 detached JWS, per the W3C VC Data Integrity spec
 *   (https://www.w3.org/TR/vc-jws-2020/) using EdDSA over Ed25519.
 *
 * Detached JWS format: `<protected_header_b64url>..<signature_b64url>`
 * The payload is omitted (the empty middle segment) because the actual
 * payload is the canonicalized DID document, which is recomputed by the
 * verifier from the document itself.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import fs from 'node:fs';
import path from 'node:path';

/* ---------- base64url ---------- */

export function b64uEncode(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function b64uDecode(str) {
  const pad = '==='.slice((str.length + 3) % 4);
  return new Uint8Array(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64'));
}

/* ---------- hashing ---------- */

export function sha256Bytes(input) {
  if (typeof input === 'string') input = utf8ToBytes(input);
  return sha256(input);
}

export function sha256Hex(input) {
  return bytesToHex(sha256Bytes(input));
}

/* ---------- keypair ---------- */

export function generateKeyPair() {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function publicKeyJwk(publicKey) {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: b64uEncode(publicKey),
  };
}

export function jwkToPublicKey(jwk) {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`crypto: unsupported JWK ${jwk.kty}/${jwk.crv}`);
  }
  return b64uDecode(jwk.x);
}

/** Persist a keypair as JSON. Hex-encoded for human inspection. */
export function saveKeyPair(filePath, kp) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = {
    type: 'Ed25519',
    privateKey: bytesToHex(kp.privateKey),
    publicKey:  bytesToHex(kp.publicKey),
    publicKeyJwk: publicKeyJwk(kp.publicKey),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  return data;
}

export function loadKeyPair(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    privateKey: hexToBytes(raw.privateKey),
    publicKey:  hexToBytes(raw.publicKey),
  };
}

/**
 * Load a keypair from the CONTROLLER_PRIVATE_KEY env var (hex-encoded
 * 32-byte Ed25519 seed). Returns null if not set. Production deployments
 * should populate this from a secrets manager / KMS rather than putting
 * the key on disk.
 */
export function loadKeyPairFromEnv() {
  const hex = (process.env.CONTROLLER_PRIVATE_KEY || '').trim();
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('crypto: CONTROLLER_PRIVATE_KEY must be 64 hex chars (32 bytes)');
  }
  const privateKey = hexToBytes(hex);
  const publicKey  = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Resolve the controller keypair. Order of precedence:
 *   1. CONTROLLER_PRIVATE_KEY env var (preferred for production).
 *   2. Existing keyfile at filePath.
 *   3. Generate fresh and persist to filePath (dev convenience).
 */
export function loadOrCreateKeyPair(filePath) {
  const fromEnv = loadKeyPairFromEnv();
  if (fromEnv) return fromEnv;
  const existing = loadKeyPair(filePath);
  if (existing) return existing;
  const kp = generateKeyPair();
  saveKeyPair(filePath, kp);
  return kp;
}

/* ---------- detached JsonWebSignature2020 ---------- */

/**
 * Domain separation: every NH DAO Registry signature carries this string in
 * its protected header. Verification refuses any other domain. This binds a
 * signature to a specific application context, so a legitimate signature
 * over arbitrary canonical-JSON bytes cannot be replayed against a different
 * verifier that happens to use the same Ed25519 key + same header shape.
 *
 * The constant must be bumped whenever the document shape or signing input
 * changes in a way that should invalidate prior signatures.
 */
export const JWS_DOMAIN = 'NHDAO-REGISTRY-v1';

const PROTECTED_HEADER = { alg: 'EdDSA', b64: false, crit: ['b64'], domain: JWS_DOMAIN };
const ENCODED_HEADER = b64uEncode(utf8ToBytes(JSON.stringify(PROTECTED_HEADER)));

/**
 * Build a detached JWS over the canonicalized payload bytes.
 * Returns a string of the form `<header>..<signature>`.
 */
export function detachedJws(privateKey, payloadBytes) {
  const signingInput = utf8ToBytes(ENCODED_HEADER + '.');
  const buf = new Uint8Array(signingInput.length + payloadBytes.length);
  buf.set(signingInput, 0);
  buf.set(payloadBytes, signingInput.length);
  const sig = ed25519.sign(buf, privateKey);
  return `${ENCODED_HEADER}..${b64uEncode(sig)}`;
}

/**
 * Header parameters this verifier is willing to recognize when listed in
 * `crit`. Per RFC 7515 §4.1.11, a JWS that lists a parameter in `crit`
 * MUST be rejected by recipients that do not understand that parameter.
 * `b64` (RFC 7797) tells us the payload bytes are passed alongside rather
 * than embedded; that is the whole point of the detached construction.
 */
const UNDERSTOOD_CRIT_HEADERS = new Set(['b64']);

/** Verify a detached JWS produced by `detachedJws`. */
export function verifyDetachedJws(jws, publicKey, payloadBytes) {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts[1] !== '') {
    throw new Error('crypto: malformed detached JWS');
  }
  const headerJson = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
  if (headerJson.alg !== 'EdDSA') {
    throw new Error(`crypto: unsupported alg ${headerJson.alg}`);
  }
  if (headerJson.domain !== JWS_DOMAIN) {
    throw new Error(`crypto: signature domain mismatch (got ${JSON.stringify(headerJson.domain)}, want ${JSON.stringify(JWS_DOMAIN)})`);
  }
  if (Array.isArray(headerJson.crit)) {
    for (const name of headerJson.crit) {
      if (!UNDERSTOOD_CRIT_HEADERS.has(name)) {
        throw new Error(`crypto: protected header lists unknown critical extension "${name}"`);
      }
    }
  } else if (headerJson.crit !== undefined) {
    throw new Error('crypto: malformed crit (must be an array)');
  }
  const sig = b64uDecode(parts[2]);
  const signingInput = utf8ToBytes(parts[0] + '.');
  const buf = new Uint8Array(signingInput.length + payloadBytes.length);
  buf.set(signingInput, 0);
  buf.set(payloadBytes, signingInput.length);
  return ed25519.verify(sig, buf, publicKey);
}

export { randomBytes, bytesToHex, hexToBytes, utf8ToBytes };
