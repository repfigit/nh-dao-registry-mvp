const { expect } = require('chai');
const { ethers } = require('hardhat');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');

describe('DAORegistryAnchor', () => {
  const REGISTRY_ID = 'granite-state-governance-dao';
  const HASH_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const HASH_B = '0x2222222222222222222222222222222222222222222222222222222222222222';
  const KIND_DAO = 0;
  const KIND_AGENT = 1;

  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory('DAORegistryAnchor');
    const c = await F.deploy(owner.address);
    await c.waitForDeployment();
    return { c, owner, other };
  }

  it('rejects deployment with zero owner', async () => {
    const F = await ethers.getContractFactory('DAORegistryAnchor');
    await expect(F.deploy(ethers.ZeroAddress))
      .to.be.revertedWith('DAORegistryAnchor: zero owner');
  });

  it('records an anchor and emits Anchored', async () => {
    const { c, owner } = await deploy();
    const tx = await c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A);
    const receipt = await tx.wait();

    const ev = receipt.logs
      .map(l => { try { return c.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean)
      .find(p => p.name === 'Anchored');

    expect(ev).to.exist;
    expect(ev.args.registryId).to.equal(REGISTRY_ID);
    expect(ev.args.version).to.equal(1n);
    expect(Number(ev.args.kind)).to.equal(KIND_DAO);
    expect(ev.args.contentHash).to.equal(HASH_A);

    const a = await c.getAnchor(REGISTRY_ID, KIND_DAO, 1);
    expect(a.contentHash).to.equal(HASH_A);
    expect(a.version).to.equal(1n);
    expect(Number(a.kind)).to.equal(KIND_DAO);
  });

  it('tracks latest version per (registryId, kind) independently', async () => {
    const { c } = await deploy();
    await c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A);
    await c.anchor(REGISTRY_ID, KIND_DAO, 2, HASH_B);
    await c.anchor(REGISTRY_ID, KIND_AGENT, 1, HASH_A);

    const idHash = ethers.keccak256(ethers.toUtf8Bytes(REGISTRY_ID));
    expect(await c.latestVersion(idHash, KIND_DAO)).to.equal(2n);
    expect(await c.latestVersion(idHash, KIND_AGENT)).to.equal(1n);

    const latestDao = await c.getLatest(REGISTRY_ID, KIND_DAO);
    expect(latestDao.contentHash).to.equal(HASH_B);
    expect(latestDao.version).to.equal(2n);

    const latestAgent = await c.getLatest(REGISTRY_ID, KIND_AGENT);
    expect(latestAgent.contentHash).to.equal(HASH_A);
    expect(latestAgent.version).to.equal(1n);
  });

  it('reverts on non-sequential version', async () => {
    const { c } = await deploy();
    await c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A);
    await expect(c.anchor(REGISTRY_ID, KIND_DAO, 3, HASH_B))
      .to.be.revertedWith('DAORegistryAnchor: non-sequential version');
  });

  it('reverts on duplicate version', async () => {
    const { c } = await deploy();
    await c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A);
    // Trying to anchor v1 again should fail (catches both duplicate and non-sequential).
    await expect(c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_B))
      .to.be.reverted;
  });

  it('reverts on zero hash, empty id, version 0', async () => {
    const { c } = await deploy();
    await expect(c.anchor('', KIND_DAO, 1, HASH_A)).to.be.revertedWith('DAORegistryAnchor: empty registryId');
    await expect(c.anchor(REGISTRY_ID, KIND_DAO, 0, HASH_A)).to.be.revertedWith('DAORegistryAnchor: version must be >= 1');
    await expect(c.anchor(REGISTRY_ID, KIND_DAO, 1, ethers.ZeroHash)).to.be.revertedWith('DAORegistryAnchor: zero hash');
  });

  it('only owner can anchor', async () => {
    const { c, other } = await deploy();
    await expect(c.connect(other).anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A))
      .to.be.revertedWith('DAORegistryAnchor: not owner');
  });

  it('transfers ownership via two-step accept', async () => {
    const { c, owner, other } = await deploy();
    await expect(c.transferOwnership(other.address))
      .to.emit(c, 'OwnershipTransferStarted')
      .withArgs(owner.address, other.address);

    // Ownership has not changed yet.
    expect(await c.owner()).to.equal(owner.address);
    expect(await c.pendingOwner()).to.equal(other.address);

    // Random caller cannot accept.
    await expect(c.acceptOwnership()).to.be.revertedWith('DAORegistryAnchor: not pending owner');

    await expect(c.connect(other).acceptOwnership())
      .to.emit(c, 'OwnershipTransferred')
      .withArgs(owner.address, other.address);

    expect(await c.owner()).to.equal(other.address);
    expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(c.connect(other).anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A)).to.not.be.reverted;
  });

  it('cancels a pending ownership transfer', async () => {
    const { c, other } = await deploy();
    await c.transferOwnership(other.address);
    expect(await c.pendingOwner()).to.equal(other.address);
    await c.cancelOwnershipTransfer();
    expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(c.connect(other).acceptOwnership()).to.be.revertedWith('DAORegistryAnchor: not pending owner');
  });

  it('hasAnchor returns true after first anchor', async () => {
    const { c } = await deploy();
    expect(await c.hasAnchor(REGISTRY_ID, KIND_DAO)).to.equal(false);
    await c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A);
    expect(await c.hasAnchor(REGISTRY_ID, KIND_DAO)).to.equal(true);
    expect(await c.hasAnchor(REGISTRY_ID, KIND_AGENT)).to.equal(false);
  });

  it('getLatest reverts when no anchor exists', async () => {
    const { c } = await deploy();
    await expect(c.getLatest(REGISTRY_ID, KIND_DAO))
      .to.be.revertedWith('DAORegistryAnchor: no anchor');
  });

  it('Anchored event indexes contentHash', async () => {
    const { c } = await deploy();
    await expect(c.anchor(REGISTRY_ID, KIND_DAO, 1, HASH_A))
      .to.emit(c, 'Anchored')
      .withArgs(
        ethers.keccak256(ethers.toUtf8Bytes(REGISTRY_ID)),
        KIND_DAO,
        HASH_A,
        1,
        anyValue,
        REGISTRY_ID,
      );
  });
});
