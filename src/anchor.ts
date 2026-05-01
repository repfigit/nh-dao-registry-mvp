/**
 * Polygon Amoy chain anchor (DAORegistryAnchor contract).
 *
 * The publication service calls `recordAnchor` after building+signing each
 * DID document. The contract emits an `Anchored` event and persists the
 * tuple (registryId, kind, version, contentHash). Verification later reads
 * the latest anchor for (registryId, kind), recomputes the canonical hash
 * of the resolved DID document, and compares.
 *
 * Falls back gracefully if AMOY_RPC_URL or ANCHOR_CONTRACT_ADDRESS are
 * unset: skips the anchor and returns null. The server logs a warning.
 * For production (and for tests) the env vars must be set.
 */

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import fs from 'node:fs';
import { anchorConfig, anchorEnabled as cfgAnchorEnabled } from './config.js';

const ABI = [
  'function anchor(string registryId, uint8 kind, uint32 version, bytes32 contentHash) external returns (bytes32)',
  'function getAnchor(string registryId, uint8 kind, uint32 version) external view returns (tuple(bytes32 registryIdHash, uint32 version, uint8 kind, bytes32 contentHash, uint64 anchoredAt))',
  'function getLatest(string registryId, uint8 kind) external view returns (tuple(bytes32 registryIdHash, uint32 version, uint8 kind, bytes32 contentHash, uint64 anchoredAt))',
  'function hasAnchor(string registryId, uint8 kind) external view returns (bool)',
  'event Anchored(bytes32 indexed registryIdHash, uint8 indexed kind, bytes32 indexed contentHash, uint32 version, uint64 anchoredAt, string registryId)',
];

export const KIND = { DAO: 0, AGENT: 1 };

export function anchorEnabled() {
  return cfgAnchorEnabled();
}

function getContract({ readonly = false } = {}) {
  const { rpc, address: addr, privateKey: pk } = anchorConfig();
  if (!rpc || !addr) throw new Error('anchor: AMOY_RPC_URL and ANCHOR_CONTRACT_ADDRESS required');
  const provider = new JsonRpcProvider(rpc);
  if (readonly) return new Contract(addr, ABI, provider);
  if (!pk) throw new Error('anchor: ANCHOR_PRIVATE_KEY required for writes');
  const signer = new Wallet(pk, provider);
  return new Contract(addr, ABI, signer);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Errors that are NOT worth retrying. If the contract reverts (duplicate
 * version, non-sequential, not-owner), retrying with the same args will
 * always fail; surface immediately.
 */
export function isPermanentAnchorError(err) {
  const msg = String(err && (err.shortMessage || err.message) || '');
  return /already anchored|non-sequential|not owner|empty registryId|version must be|zero hash|insufficient funds|nonce too low/i.test(msg);
}

/**
 * Run an async operation with exponential-backoff retries. Permanent
 * errors (per `isPermanent`) skip retry and rethrow immediately. Exposed
 * for tests so the retry loop is exercisable without an RPC.
 *
 * @param {() => Promise<T>} fn  - the operation to run
 * @param {object} opts
 * @param {number} opts.maxAttempts
 * @param {number} opts.baseDelayMs
 * @param {(err: any) => boolean} [opts.isPermanent]
 * @param {(ms: number) => Promise<void>} [opts.sleeper] - injectable for tests
 * @param {() => number} [opts.jitter] - returns 0..1, injectable for tests
 * @returns {Promise<{ result: T, attempts: number }>}
 */
export async function retryWithBackoff(fn, opts) {
  const { maxAttempts, baseDelayMs } = opts;
  const isPermanent = opts.isPermanent || (() => false);
  const sleeper = opts.sleeper || sleep;
  const jitter  = opts.jitter  || Math.random;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (isPermanent(e) || attempt === maxAttempts) break;
      const delay = baseDelayMs * (2 ** (attempt - 1)) + Math.floor(jitter() * 250);
      // eslint-disable-next-line no-console
      console.warn(`anchor: attempt ${attempt} failed (${e.shortMessage || e.message}); retrying in ${delay}ms`);
      await sleeper(delay);
    }
  }
  throw lastErr;
}

/**
 * Submit an anchor transaction with exponential-backoff retry on transient
 * RPC failures. Permanent contract reverts are not retried.
 *
 * @param {string} registryId
 * @param {0|1}    kind          KIND.DAO or KIND.AGENT
 * @param {number} version
 * @param {string} contentHashHex - 64-char hex string, no 0x prefix
 * @returns {Promise<{txHash:string, blockNumber:number, chainId:number, contractAddress:string, kind:number, version:number, chainIdCaip2:string, attempts:number}>}
 */
export async function recordAnchor(registryId, kind, version, contentHashHex) {
  if (!anchorEnabled()) {
    return null;
  }
  const c = getContract();
  const provider = c.runner.provider;
  const { chainId } = await provider.getNetwork();

  const { maxRetries, baseDelayMs } = anchorConfig();
  const { result: receipt, attempts } = await retryWithBackoff(
    async () => {
      const tx = await c.anchor(registryId, kind, version, '0x' + contentHashHex);
      return tx.wait();
    },
    {
      maxAttempts: maxRetries,
      baseDelayMs,
      isPermanent: isPermanentAnchorError,
    },
  );
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    chainId: Number(chainId),
    contractAddress: await c.getAddress(),
    kind,
    version,
    chainIdCaip2: `eip155:${chainId}`,
    attempts,
  };
}

/**
 * Read the latest anchor for (registryId, kind).
 * Returns null if there is no anchor for the pair (rather than throwing).
 */
export async function readLatest(registryId, kind) {
  if (!anchorConfig().address) return null;
  const c = getContract({ readonly: true });
  const present = await c.hasAnchor(registryId, kind);
  if (!present) return null;
  const a = await c.getLatest(registryId, kind);
  return {
    registryIdHash: a.registryIdHash,
    version: Number(a.version),
    kind: Number(a.kind),
    contentHash: a.contentHash.slice(2), // strip 0x
    anchoredAt: Number(a.anchoredAt),
  };
}

/** Convenience: load the deployed contract address from data/deployment-<network>.json. */
export function loadDeployedAddress(network) {
  const file = `data/deployment-${network}.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).address;
}
