/**
 * IPFS pinning.
 *
 * Two modes:
 *
 * 1. Local-only (default if public pinning is not configured):
 *    Compute a real CIDv1 from the bytes (using the same multihash + raw
 *    codec that IPFS uses). Save the bytes to data/blobs/<cid>.bin so the
 *    server can serve them at /ipfs/<cid> as a local "fake gateway." This
 *    is enough for verification: the CID is a real content-addressed
 *    identifier; verification recomputes the hash and compares.
 *
 * 2. Arweave public persistence (when ARWEAVE_JWK is set):
 *    Upload the same bytes to Arweave through Turbo. The CID remains the
 *    canonical content identifier inside the DID document, while the
 *    Arweave receipt gives operators a permanent public mirror.
 *
 * The mandatory-pinning rule from the spec is enforced here: every filing
 * gets pinned. If the public mode fails, we still have the local pin (the
 * document is reproducible from the local blob store).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

const BLOB_DIR = path.join('data', 'blobs');

/** Compute a real CIDv1 (raw codec, sha2-256 multihash) for the given bytes. */
export async function computeCid(bytes) {
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash);
}

/** Save bytes to the local blob store, keyed by CID. */
function saveLocal(cid, bytes) {
  fs.mkdirSync(BLOB_DIR, { recursive: true });
  const file = path.join(BLOB_DIR, `${cid.toString()}.bin`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return file;
}

/** Read bytes back from local blob store (or null if not present). */
export function readLocal(cidStr) {
  const file = path.join(BLOB_DIR, `${cidStr}.bin`);
  if (!fs.existsSync(file)) return null;
  return new Uint8Array(fs.readFileSync(file));
}

/**
 * Pin bytes to IPFS.
 *
 * The `publicPin` field describes the public persistence state in detail so the
 * caller can decide whether to surface the warning to the user or persist
 * it for an operator dashboard. The local pin always succeeds (or throws);
 * a remote persistence failure does NOT abort the filing, but it is reported.
 *
 * @param {Uint8Array} bytes
 * @param {string}     filename - hint passed through to the public pinning provider if used
 * @returns {Promise<{cid:string, ipfsUri:string, gatewayUrl:string, public:boolean, publicPinStatus:object, arweave:object|null}>}
 */
export async function pin(bytes, filename = 'governance.bin') {
  const cid = await computeCid(bytes);
  saveLocal(cid, bytes);
  const cidStr = cid.toString();

  let publicPin = false;
  let arweave = null;
  // Status describes the public-pin attempt. State is one of:
  //   'not-configured' | 'pinned' | 'failed'
  let publicPinStatus = { state: 'not-configured', provider: 'arweave-turbo', detail: 'set ARWEAVE_JWK for Arweave Turbo public persistence' };
  if (process.env.ARWEAVE_JWK) {
    try {
      arweave = await uploadViaArweaveTurbo(bytes, filename, cidStr);
      publicPin = true;
      publicPinStatus = {
        state: 'pinned',
        provider: 'arweave-turbo',
        detail: `persisted to Arweave via Turbo as ${arweave.txId}`,
        txId: arweave.txId,
        uri: arweave.uri,
        gatewayUrl: arweave.gatewayUrl,
        winc: arweave.winc,
        owner: arweave.owner,
      };
    } catch (err) {
      arweave = null;
      publicPinStatus = { state: 'failed', provider: 'arweave-turbo', detail: `Arweave Turbo upload failed: ${err.message}` };
      // eslint-disable-next-line no-console
      console.warn(`ipfs: ${publicPinStatus.detail}; local pin still active`);
    }
  }

  return {
    cid: cidStr,
    ipfsUri: `ipfs://${cidStr}`,
    gatewayUrl: publicPin && arweave ? arweave.gatewayUrl : `/ipfs/${cidStr}`,
    public: publicPin,
    publicPinStatus,
    arweave,
  };
}

/* ---------- Arweave public persistence ---------- */

function arweaveJwk() {
  try {
    const jwk = JSON.parse(process.env.ARWEAVE_JWK);
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA') {
      throw new Error('expected an RSA JWK object');
    }
    return jwk;
  } catch (err) {
    throw new Error(`ARWEAVE_JWK must be a valid Arweave wallet JSON JWK (${err.message})`);
  }
}

async function uploadViaArweaveTurbo(bytes, filename, cidStr) {
  const { TurboFactory } = await import('@ardrive/turbo-sdk');
  const turbo = TurboFactory.authenticated({
    privateKey: arweaveJwk(),
    token: process.env.ARWEAVE_TURBO_TOKEN || 'arweave',
  });
  const response = await turbo.upload({
    data: Buffer.from(bytes),
    dataItemOpts: {
      tags: [
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'App-Name', value: 'NH-DAO-Registry-MVP' },
        { name: 'File-Name', value: filename },
        { name: 'IPFS-CID', value: cidStr },
      ],
    },
  });
  if (!response || !response.id) throw new Error('Turbo response did not include an Arweave transaction id');
  return {
    txId: response.id,
    uri: `ar://${response.id}`,
    gatewayUrl: `https://arweave.net/${response.id}`,
    winc: response.winc ? String(response.winc) : null,
    owner: response.owner || null,
  };
}
