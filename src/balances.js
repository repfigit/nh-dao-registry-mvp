import Arweave from 'arweave';
import { formatEther, JsonRpcProvider, Wallet } from 'ethers';
import { anchorConfig } from './config.js';

function arweaveClient() {
  return Arweave.init({
    host: process.env.ARWEAVE_HOST || 'arweave.net',
    port: Number(process.env.ARWEAVE_PORT || 443),
    protocol: process.env.ARWEAVE_PROTOCOL || 'https',
  });
}

function parseArweaveJwk() {
  if (!process.env.ARWEAVE_JWK) return null;
  const jwk = JSON.parse(process.env.ARWEAVE_JWK);
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA') {
    throw new Error('ARWEAVE_JWK must be an Arweave RSA JWK');
  }
  return jwk;
}

export async function arweaveBalance() {
  const jwk = parseArweaveJwk();
  if (!jwk) return { configured: false };
  const client = arweaveClient();
  const address = await client.wallets.jwkToAddress(jwk);
  const winston = await client.wallets.getBalance(address);
  return {
    configured: true,
    address,
    winston,
    ar: client.ar.winstonToAr(winston),
  };
}

export async function anchorSignerBalance() {
  const { rpc, privateKey, address: contractAddress } = anchorConfig();
  if (!rpc || !privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    return { configured: false };
  }
  const provider = new JsonRpcProvider(rpc);
  const signer = new Wallet(privateKey, provider);
  const balanceWei = await provider.getBalance(signer.address);
  const network = await provider.getNetwork();
  return {
    configured: true,
    address: signer.address,
    contractAddress: contractAddress || null,
    chainId: Number(network.chainId),
    wei: balanceWei.toString(),
    native: formatEther(balanceWei),
    symbol: 'MATIC',
  };
}

export async function operationalBalances() {
  const out = {};
  try {
    out.arweave = await arweaveBalance();
  } catch (err) {
    out.arweave = { configured: Boolean(process.env.ARWEAVE_JWK), error: err.message };
  }
  try {
    out.anchorSigner = await anchorSignerBalance();
  } catch (err) {
    out.anchorSigner = { configured: Boolean(anchorConfig().privateKey), error: err.message };
  }
  return out;
}
