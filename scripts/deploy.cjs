/* Hardhat deploy script for DAORegistryAnchor.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.cjs --network amoy
 *   npx hardhat run scripts/deploy.cjs --network localhost
 *
 * Optional ownership transfer (recommended for production):
 *   OWNER=0xMultisigAddress npx hardhat run scripts/deploy.cjs --network amoy
 *
 * If OWNER is set and differs from the deployer, the script calls
 * `transferOwnership(OWNER)` after deploy. Ownership is two-step: the
 * multisig (or whoever controls OWNER) must subsequently call
 * `acceptOwnership()` from that address. Until then the deployer remains
 * the active owner — by design, so a typo'd OWNER address can't lock the
 * contract.
 */
const hre = require('hardhat');
const fs  = require('fs');
const path = require('path');

const EVM_ADDR_RX = /^0x[a-fA-F0-9]{40}$/;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  const ownerArg = (process.env.OWNER || '').trim();
  if (ownerArg && !EVM_ADDR_RX.test(ownerArg)) {
    throw new Error(`OWNER must be a 0x-prefixed 20-byte EVM address, got: ${ownerArg}`);
  }

  console.log(`Network:  ${network} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  if (ownerArg) console.log(`Owner:    ${ownerArg} (will be set as pendingOwner after deploy)`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} ${network === 'amoy' ? 'MATIC' : 'ETH'}`);
  if (balance === 0n && network !== 'hardhat') {
    throw new Error(`Deployer has no balance on ${network}. Fund it before deploying.`);
  }

  const F = await hre.ethers.getContractFactory('DAORegistryAnchor');
  const c = await F.deploy(deployer.address);
  await c.waitForDeployment();
  const addr = await c.getAddress();

  console.log(`\nDeployed DAORegistryAnchor at: ${addr}`);

  let pendingOwner = null;
  if (ownerArg && ownerArg.toLowerCase() !== deployer.address.toLowerCase()) {
    const tx = await c.transferOwnership(ownerArg);
    const receipt = await tx.wait();
    pendingOwner = ownerArg;
    console.log(`transferOwnership(${ownerArg}) tx: ${receipt.hash}`);
    console.log(`pendingOwner = ${ownerArg}; current owner is still ${deployer.address}.`);
    console.log('To complete the handover, the new owner must call acceptOwnership() from that address.');
  } else if (ownerArg) {
    console.log('OWNER matches deployer; skipping transferOwnership.');
  }

  // Persist for the server.
  const out = {
    network,
    chainId: Number(chainId),
    address: addr,
    deployer: deployer.address,
    pendingOwner,
    deployedAt: new Date().toISOString(),
  };
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `deployment-${network}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);

  console.log('\nNext step: copy the address into your .env as ANCHOR_CONTRACT_ADDRESS.');
  if (pendingOwner) {
    console.log(`Then have ${pendingOwner} call acceptOwnership() to finish the handover.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
