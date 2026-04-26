/**
 * IPFS pinning.
 *
 * Two modes:
 *
 * 1. Local-only (default if web3.storage is not configured):
 *    Compute a real CIDv1 from the bytes (using the same multihash + raw
 *    codec that IPFS uses). Save the bytes to data/blobs/<cid>.bin so the
 *    server can serve them at /ipfs/<cid> as a local "fake gateway." This
 *    is enough for verification: the CID is a real content-addressed
 *    identifier; verification recomputes the hash and compares.
 *
 * 2. web3.storage public pinning (when W3UP_AGENT_KEY and W3UP_DELEGATION
 *    _PROOF are set):
 *    Upload to web3.storage. Returns the same CIDv1 (web3.storage uses the
 *    same hashing). The bytes are now retrievable from any public IPFS
 *    gateway in addition to the local store.
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
 * @param {string}     filename - hint passed through to web3.storage if used
 * @returns {Promise<{cid:string, ipfsUri:string, gatewayUrl:string, public:boolean, publicPinStatus:object}>}
 */
export async function pin(bytes, filename = 'governance.bin') {
  const cid = await computeCid(bytes);
  saveLocal(cid, bytes);

  let publicPin = false;
  // Status describes the public-pin attempt. State is one of:
  //   'not-configured' | 'pinned' | 'cid-mismatch' | 'failed'
  let publicPinStatus = { state: 'not-configured', detail: 'set W3UP_AGENT_KEY and W3UP_DELEGATION_PROOF for public pinning' };
  if (process.env.W3UP_AGENT_KEY && process.env.W3UP_DELEGATION_PROOF) {
    try {
      const remoteCid = await pinViaW3Up(bytes, filename);
      // web3.storage may return a different multihash if it chunks the file.
      // For small documents (< ~1MB) it is identical. For larger files we
      // would need to use a unixfs CAR; out of scope for the POC.
      if (remoteCid.toString() !== cid.toString()) {
        publicPinStatus = {
          state: 'cid-mismatch',
          detail: `web3.storage returned ${remoteCid} but local CID is ${cid}; public gateway URL will not resolve the same bytes`,
          remoteCid: remoteCid.toString(),
        };
        // eslint-disable-next-line no-console
        console.warn(`ipfs: ${publicPinStatus.detail}`);
        // Treat this as a non-public pin: the local CID is what's recorded
        // in the DID document, and a public gateway lookup of that CID will
        // miss because web3.storage stored a different one.
      } else {
        publicPin = true;
        publicPinStatus = { state: 'pinned', detail: `pinned to web3.storage as ${cid}` };
      }
    } catch (err) {
      publicPinStatus = { state: 'failed', detail: `web3.storage pin failed: ${err.message}` };
      // eslint-disable-next-line no-console
      console.warn(`ipfs: ${publicPinStatus.detail}; local pin still active`);
    }
  }

  const cidStr = cid.toString();
  return {
    cid: cidStr,
    ipfsUri: `ipfs://${cidStr}`,
    gatewayUrl: publicPin ? `https://${cidStr}.ipfs.w3s.link` : `/ipfs/${cidStr}`,
    public: publicPin,
    publicPinStatus,
  };
}

/* ---------- web3.storage soft import ---------- */

async function pinViaW3Up(bytes, filename) {
  const mod = await import('@web3-storage/w3up-client').catch(() => null);
  if (!mod) throw new Error('@web3-storage/w3up-client not installed');
  const Signer = await import('@web3-storage/w3up-client/principal/ed25519').catch(() => null);
  const Proof  = await import('@web3-storage/w3up-client/proof').catch(() => null);
  if (!Signer || !Proof) throw new Error('w3up-client subpaths missing');

  const principal = Signer.parse(process.env.W3UP_AGENT_KEY);
  const client = await mod.create({ principal });
  const proof = await Proof.parse(process.env.W3UP_DELEGATION_PROOF);
  const space = await client.addSpace(proof);
  await client.setCurrentSpace(space.did());

  const file = new File([bytes], filename, { type: 'application/octet-stream' });
  const cid = await client.uploadFile(file);
  return cid;
}
