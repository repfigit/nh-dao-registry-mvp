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
 * 2. Pinata public pinning (when PINATA_JWT is set):
 *    Upload to Pinata's public IPFS endpoint. The bytes are then
 *    retrievable from public IPFS gateways in addition to the local store.
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
 * The `publicPin` field describes the public-IPFS state in detail so the
 * caller can decide whether to surface the warning to the user or persist
 * it for an operator dashboard. The local pin always succeeds (or throws);
 * a remote-pin failure does NOT abort the filing, but it is reported.
 *
 * @param {Uint8Array} bytes
 * @param {string}     filename - hint passed through to the public pinning provider if used
 * @returns {Promise<{cid:string, ipfsUri:string, gatewayUrl:string, public:boolean, publicPinStatus:object}>}
 */
export async function pin(bytes, filename = 'governance.bin') {
  const cid = await computeCid(bytes);
  saveLocal(cid, bytes);

  let publicPin = false;
  // Status describes the public-pin attempt. State is one of:
  //   'not-configured' | 'pinned' | 'cid-mismatch' | 'failed'
  let publicPinStatus = { state: 'not-configured', detail: 'set PINATA_JWT for public IPFS pinning' };
  if (process.env.PINATA_JWT) {
    try {
      const remoteCid = await pinViaPinata(bytes, filename);
      // Pinata may return a different multihash if it chunks the file.
      // For small documents (< ~1MB) it is identical. For larger files we
      // would need to use a unixfs CAR; out of scope for the POC.
      if (remoteCid.toString() !== cid.toString()) {
        publicPinStatus = {
          state: 'cid-mismatch',
          detail: `Pinata returned ${remoteCid} but local CID is ${cid}; public gateway URL will not resolve the same bytes`,
          remoteCid: remoteCid.toString(),
        };
        // eslint-disable-next-line no-console
        console.warn(`ipfs: ${publicPinStatus.detail}`);
        // Treat this as a non-public pin: the local CID is what's recorded
        // in the DID document, and a public gateway lookup of that CID will
        // miss because Pinata stored a different one.
      } else {
        publicPin = true;
        publicPinStatus = { state: 'pinned', detail: `pinned to Pinata as ${cid}` };
      }
    } catch (err) {
      publicPinStatus = { state: 'failed', detail: `Pinata pin failed: ${err.message}` };
      // eslint-disable-next-line no-console
      console.warn(`ipfs: ${publicPinStatus.detail}; local pin still active`);
    }
  }

  const cidStr = cid.toString();
  return {
    cid: cidStr,
    ipfsUri: `ipfs://${cidStr}`,
    gatewayUrl: publicPin ? `https://gateway.pinata.cloud/ipfs/${cidStr}` : `/ipfs/${cidStr}`,
    public: publicPin,
    publicPinStatus,
  };
}

/* ---------- Pinata public pinning ---------- */

async function pinViaPinata(bytes, filename) {
  const file = new File([bytes], filename, { type: 'application/octet-stream' });
  const form = new FormData();
  form.set('file', file);
  form.set('pinataMetadata', JSON.stringify({ name: filename }));
  form.set('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error || body.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  if (!body.IpfsHash) throw new Error('Pinata response did not include IpfsHash');
  return CID.parse(body.IpfsHash);
}
